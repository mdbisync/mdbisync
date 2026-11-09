// Step 2 of a sync run: Linear's changes towards the tracked branch, through
// the one sync pull request.
//
// The sync branch follows `linear` by fast-forwards and merge commits, never
// by a force push. When no pull request is open, the new head holds exactly
// the tracked branch with `linear` merged in, so nothing a closed pull request
// left on the branch is carried on. It moves only when `linear` brings the tracked branch
// something the branch does not bring yet: `linear` gains a merge of the
// tracked branch on every run that writes to Linear (step 5), and moving the
// branch for those would restart the checks on every run. A new head or pull
// request gets a bounded grace period for checks; if they pass, this run
// merges with a merge commit. Otherwise a later run reads them again.
//
// A merge GitHub refuses is noted in the pull request's description, with
// the head, the tracked branch and GitHub's reason. A later run that meets
// the same refusal on the same head and tracked branch reads the note back
// and reports a setup error: nothing will change until a person does.

import { SYNC_IDENTITY } from '../initial-sync/index.ts';
import {
  type CheckState,
  type GitHubRepository,
  PullRequestError,
  ensurePullRequest,
  findOpenPullRequest,
  mergePullRequest,
  readChecks,
  waitForChecks,
  updatePullRequest,
} from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import {
  type CommitIdentity,
  type Git,
  INITIAL_SYNC_FROM_LINEAR_RECORD,
  type Oid,
  type StateConfig,
  type StateSnapshot,
  branchRef,
  pushAtomic,
} from '../state/index.ts';

export const SYNC_PULL_REQUEST_TITLE = 'Changes from Linear';
/** The message of a merge of `linear` into the sync branch. */
export const SYNC_BRANCH_MERGE_MESSAGE = "Merge Linear's latest changes";
/** Paths listed in the pull request's description; the rest are counted. */
const LISTED_PATHS = 200;

export interface PullRequestOptions {
  config: StateConfig;
  /** The state refs after capture. */
  state: StateSnapshot;
  github: GitHubRepository;
  identity?: CommitIdentity;
  mergeGraceSeconds?: number | undefined;
}

export interface PullRequestResult {
  /** Merging `linear` would change the tracked branch. */
  needed: boolean;
  /** The open sync pull request after this step; null when there is none. */
  pullRequest: { number: number; url: string; opened: boolean } | null;
  /** This run moved the sync branch. */
  branchMoved: boolean;
  /** The checks on the head; null when this run did not read them. */
  checks: CheckState | null;
  /** The merge commit on the tracked branch when this run merged the pull request. */
  merged: Oid | null;
  /** Files the pull request changes on the tracked branch. */
  paths: string[];
  /**
   * Why the step did not do all it could this run. Waiting for checks is not
   * one: a later run merges.
   * - `check-failed`: a check on the head failed; a setup error, the repository's checks must pass Linear's form. The tracked-to-Linear write step is paused until they pass.
   * - `conflict`: `linear` and the tracked branch, or `linear` and the sync branch, change the same lines; steps 3 to 5 merge them, and a later run takes the result.
   * - `merge-refused`: GitHub would not merge (the head moved, or the pull request cannot be merged now); a later run tries again.
   * - `merge-blocked`: GitHub refused the merge for the same reason as an earlier run, on the same head and tracked branch; a setup error, a person must change what blocks it.
   * - `initial-pull-request-pending`: the sync branch holds the record of an initial sync from Linear that a person has not merged.
   * - `state-moved`: the sync branch moved while this run worked.
   * - `github-failed`: GitHub refused or failed a request, or no answer came; `status` is its HTTP status, absent when no answer came.
   */
  code?: 'check-failed' | 'conflict' | 'merge-refused' | 'merge-blocked' | 'initial-pull-request-pending' | 'state-moved' | 'github-failed';
  /** GitHub's HTTP status for `merge-refused`, `merge-blocked` and `github-failed`. */
  status?: number;
  /** GitHub's reason for `merge-refused` and `merge-blocked`, on one line; empty when it gave none. */
  reason?: string;
}

/** A merge GitHub refused, as noted in the pull request's description. */
interface MergeRefusal {
  head: Oid;
  /** The tracked branch's head at the time. */
  base: Oid;
  status: number;
  reason: string;
}

/** How a run ends because of step 2; null when step 2 leaves the run successful (waiting for checks, a conflict, a refused merge). */
export interface PullRequestFailure {
  /** `setup`: a failed check, the deployer fixes the configuration; `no-state`: an initial sync from Linear waits for a person; `incomplete`: run again. */
  kind: 'setup' | 'no-state' | 'incomplete';
  code: NonNullable<PullRequestResult['code']>;
  message: string;
}

export function pullRequestFailure(result: PullRequestResult | undefined): PullRequestFailure | null {
  switch (result?.code) {
    case 'check-failed':
      return { kind: 'setup', code: result.code, message: `setup error (${result.code}): a check failed on the sync pull request` };
    case 'merge-blocked':
      return { kind: 'setup', code: result.code, message: `setup error (${result.code}): GitHub refuses again to merge the sync pull request (${refusalText(result)})` };
    case 'initial-pull-request-pending':
      return { kind: 'no-state', code: result.code, message: `stopped short (${result.code}): an initial sync from Linear waits for a person to merge it` };
    case 'state-moved':
    case 'github-failed':
      return { kind: 'incomplete', code: result.code, message: `not finished (${result.code}); run it again` };
    default:
      return null;
  }
}

export async function syncPullRequest(context: RunContext, options: PullRequestOptions): Promise<PullRequestResult> {
  const { git, fetched } = context;
  const { config, github } = options;
  const tracked = fetched.tracked;
  const sync = fetched.sync;
  const linear = options.state.linear;
  const result: PullRequestResult = { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [] };
  if (linear === null) return result;

  const trackedTree = await git.text(['rev-parse', `${tracked}^{tree}`]);
  const wanted = await mergedTree(git, tracked, linear);
  if (wanted === null) return { ...result, needed: true, code: 'conflict' };
  result.needed = wanted !== trackedTree;

  // A sync branch the tracked branch has not merged is the open pull request's head, or will be.
  const pending = sync !== null && !(await isAncestor(git, sync, tracked));
  if (!result.needed && !pending) return result;

  try {
    const open = sync === null ? null : await findOpenPullRequest(github, config.syncBranch, config.trackedBranch);
    // That record can remove files from the tracked branch: a person merges its pull request, and nothing else may ride along.
    if (open !== null && pending && (await holdsInitialRecord(git, sync as Oid))) return { ...result, code: 'initial-pull-request-pending' };

    const identity = options.identity ?? SYNC_IDENTITY;
    let head: Oid | null = sync;
    if (open === null) {
      // No pull request carries the branch, so what it holds beyond the tracked
      // branch (a pull request closed unmerged, an initial sync's abandoned
      // record) is not carried on: the new head holds exactly the tracked
      // branch with Linear's state merged in.
      if (!result.needed) return result;
      head = await restart(git, sync, linear, wanted, identity);
    } else {
      const candidate = await advance(git, sync as Oid, linear, identity);
      if (candidate === null) return { ...result, code: 'conflict' };
      if (candidate !== sync) {
        const now = await mergedTree(git, tracked, sync as Oid);
        const next = await mergedTree(git, tracked, candidate);
        if (next === null) return { ...result, code: 'conflict' };
        if (next !== now) head = candidate;
      }
    }
    if (head === null) return { ...result, code: 'conflict' };

    if (head !== sync) {
      const pushed = await pushAtomic(git, config, [{ ref: branchRef(config.syncBranch), expected: sync, next: head }]);
      if (!pushed.ok) return { ...result, code: 'state-moved' };
      result.branchMoved = true;
    }
    const headTree = await mergedTree(git, tracked, head);
    if (headTree !== null) result.paths = (await git.text(['diff', '--name-only', '--no-renames', trackedTree, headTree])).split('\n').filter(Boolean);

    // An earlier refusal stays noted while it still applies: the same head on the same tracked branch.
    const noted = open === null ? null : readRefusal(open.body);
    const earlier = noted !== null && noted.head === head && noted.base === tracked ? noted : null;
    const { pullRequest, opened } = await ensurePullRequest(github, {
      head: config.syncBranch,
      base: config.trackedBranch,
      title: SYNC_PULL_REQUEST_TITLE,
      body: pullRequestBody(result.paths, earlier),
    });
    result.pullRequest = { number: pullRequest.number, url: pullRequest.url, opened };
    const fresh = result.branchMoved || opened;
    const grace = options.mergeGraceSeconds ?? 60;
    if (fresh && grace === 0) return result;
    result.checks = fresh ? await waitForChecks(github, head, grace) : await readChecks(github, head);
    if (result.checks.state === 'failed') return { ...result, code: 'check-failed' };
    if (result.checks.state === 'pending') return result;
    const merge = await mergePullRequest(github, pullRequest.number, head);
    if (!merge.merged) {
      const refusal: MergeRefusal = { head, base: tracked, status: merge.status, reason: merge.reason };
      const refused = { ...result, status: merge.status, reason: merge.reason };
      if (earlier !== null && earlier.status === refusal.status && earlier.reason === refusal.reason) return { ...refused, code: 'merge-blocked' };
      try {
        await updatePullRequest(github, pullRequest.number, { title: SYNC_PULL_REQUEST_TITLE, body: pullRequestBody(result.paths, refusal) });
      } catch (error) {
        // The refusal is what this run reports; an unrecorded note only means a later run notes it again.
        if (!(error instanceof PullRequestError)) throw error;
      }
      return { ...refused, code: 'merge-refused' };
    }
    result.merged = merge.sha;
    result.pullRequest = null;
    return result;
  } catch (error) {
    if (error instanceof PullRequestError) return { ...result, code: 'github-failed', ...(error.status === undefined ? {} : { status: error.status }) };
    throw error;
  }
}

/**
 * Whether the sync branch's head is an initial sync's record from Linear that
 * changes the tracked branch: the head of the pull request a person merges.
 * A record that changed nothing needed no pull request. Once no pull request
 * carries the record, a later head leaves it behind (see `restart`).
 */
async function holdsInitialRecord(git: Git, sync: Oid): Promise<boolean> {
  const [subject] = (await git.text(['show', '-s', '--format=%s', sync])).split('\n');
  if (subject !== INITIAL_SYNC_FROM_LINEAR_RECORD) return false;
  const parent = await git.run(['rev-parse', '--verify', '--quiet', `${sync}^1`], { okCodes: [0, 1] });
  if (parent.code !== 0) return true;
  return (await git.run(['diff', '--quiet', parent.stdout.toString('utf8').trim(), sync], { okCodes: [0, 1] })).code === 1;
}

/** The tree of `into` with `from` merged in; null on a conflict. */
async function mergedTree(git: Git, into: Oid, from: Oid): Promise<string | null> {
  const merged = await git.run(['merge-tree', '--write-tree', '--no-messages', into, from], { okCodes: [0, 1] });
  if (merged.code !== 0) return null;
  return merged.stdout.toString('utf8').split('\n')[0] as string;
}

async function isAncestor(git: Git, ancestor: Oid, descendant: Oid): Promise<boolean> {
  return (await git.run(['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [0, 1] })).code === 0;
}

/**
 * A new head for a sync branch no pull request carries: `linear` when the
 * branch is new or `linear` descends from it; otherwise a merge commit of the
 * branch and `linear` whose tree is `wanted`, the tracked branch with
 * `linear` merged in, so nothing else the branch held is carried on.
 */
async function restart(git: Git, sync: Oid | null, linear: Oid, wanted: string, identity: CommitIdentity): Promise<Oid> {
  if (sync === null || (await isAncestor(git, sync, linear))) return linear;
  return commitMerge(git, wanted, sync, linear, identity);
}

/** The open pull request's branch moved forward to hold `linear`: `linear` itself, a merge of both, or the branch as it is; null on a conflict. */
async function advance(git: Git, sync: Oid, linear: Oid, identity: CommitIdentity): Promise<Oid | null> {
  if (await isAncestor(git, sync, linear)) return linear;
  if (await isAncestor(git, linear, sync)) return sync;
  const tree = await mergedTree(git, sync, linear);
  if (tree === null) return null;
  return commitMerge(git, tree, sync, linear, identity);
}

function commitMerge(git: Git, tree: string, sync: Oid, linear: Oid, identity: CommitIdentity): Promise<Oid> {
  return git.text(['commit-tree', '--no-gpg-sign', tree, '-p', sync, '-p', linear, '-m', SYNC_BRANCH_MERGE_MESSAGE], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
  });
}

/** Names, counts and GitHub's reason for a refused merge; never document content. */
function pullRequestBody(paths: readonly string[], refusal: MergeRefusal | null): string {
  const lines = [
    'Changes made in Linear, on their way to this branch.',
    '',
    'The sync merges this pull request with a merge commit once every check on its head has finished and passed, and adds later Linear changes to it until then.',
    '',
    `Files changed: ${paths.length}.`,
  ];
  if (paths.length > 0) lines.push('', ...paths.slice(0, LISTED_PATHS).map((path) => `- ${path}`));
  if (paths.length > LISTED_PATHS) lines.push(`- and ${paths.length - LISTED_PATHS} more`);
  if (refusal !== null) {
    lines.push(
      '',
      `GitHub refused to merge head \`${refusal.head.slice(0, 12)}\` (${refusalText(refusal)}). If it refuses this head again for the same reason, the sync reports a setup error.`,
      `<!-- merge refused: head=${refusal.head} base=${refusal.base} status=${refusal.status} reason=${encodeURIComponent(refusal.reason)} -->`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The hidden note a refused merge leaves; the reason is URI-encoded, so it cannot end the comment. */
const REFUSAL_NOTE = /^<!-- merge refused: head=([0-9a-f]+) base=([0-9a-f]+) status=(\d+) reason=([^\s]*) -->\r?$/m;

/** The refusal noted in a pull request's description, or null. */
function readRefusal(body: string): MergeRefusal | null {
  const note = REFUSAL_NOTE.exec(body);
  if (note === null) return null;
  let reason: string;
  try {
    reason = decodeURIComponent(note[4] as string);
  } catch {
    return null;
  }
  return { head: note[1] as Oid, base: note[2] as Oid, status: Number(note[3]), reason };
}

/**
 * `HTTP 405: reason`, or the status alone when GitHub gave no reason. The
 * reason is quoted as code, so Markdown, HTML and mentions in it do not render.
 */
function refusalText(refusal: { status?: number | undefined; reason?: string | undefined }): string {
  const reason = refusal.reason?.replace(/[`\r\n]/g, ' ');
  return `HTTP ${refusal.status ?? 0}${reason ? `: \`${reason}\`` : ''}`;
}

/** The job summary's section for step 2: names, numbers and states, no content. */
export function renderPullRequest(result: PullRequestResult): string[] {
  const lines = ['### Linear to the tracked branch', ''];
  const pr = result.pullRequest;
  const link = pr === null ? '' : `[#${pr.number}](${pr.url})`;
  const names = (list: readonly string[] | undefined) => (list ?? []).map((name) => `\`${name}\``).join(', ');
  switch (result.code) {
    case 'check-failed':
      lines.push(
        `Setup error: ${result.checks?.failed.length === 1 ? 'a check' : 'checks'} failed on the sync pull request ${link}: ${names(result.checks?.failed)}.`,
        "The sync does not merge it and writes no tracked-branch changes to Linear until the checks pass. Checks on the sync pull request must pass Linear's form: fix the repository's configuration or rerun the failed check, and a later run merges once they pass.",
      );
      break;
    case 'conflict':
      lines.push("Linear's latest changes and the tracked branch, or the sync pull request's branch, change the same lines. The sync branch is left as it is; this run merges the tracked branch into Linear's state, and a later run takes the result to the sync pull request.");
      break;
    case 'merge-refused':
      lines.push(`GitHub did not merge the sync pull request ${link} (${refusalText(result)}); a later run tries again.`);
      break;
    case 'merge-blocked':
      lines.push(
        `Setup error: GitHub refused again to merge the sync pull request ${link}, on the same head and for the same reason as an earlier run (${refusalText(result)}).`,
        "Nothing changes until a person does: let the sync's GitHub App merge into the tracked branch (for example, adjust the branch's rules), and a later run merges.",
      );
      break;
    case 'initial-pull-request-pending':
      lines.push('The sync branch holds an initial sync from Linear that a person has not merged yet. The sync adds nothing to it and writes nothing to Linear until it is merged.');
      break;
    case 'state-moved':
      lines.push('The sync branch moved while this run worked; the next run updates the sync pull request.');
      break;
    case 'github-failed':
      lines.push(
        result.status === undefined
          ? 'A request to GitHub for the sync pull request got no answer (the connection broke or timed out); the next run tries again.'
          : `GitHub refused or failed a request for the sync pull request (HTTP ${result.status}); the next run tries again.`,
      );
      break;
    default:
      if (result.merged !== null) lines.push('Merged the sync pull request with a merge commit: every check on its head passed.');
      else if (pr === null) lines.push('The tracked branch already holds every change from Linear: no pull request is needed.');
      else if (pr.opened) lines.push(`Opened the sync pull request ${link}. A later run merges it when every check on its head has passed.`);
      else if (result.branchMoved) lines.push(`Added new Linear changes to the sync pull request ${link}. A later run merges it when every check on its head has passed.`);
      else lines.push(`The sync pull request ${link} waits for ${names(result.checks?.pending) || 'its checks'}; a later run merges it.`);
  }
  if (result.paths.length > 0) lines.push('', `Files it changes on the tracked branch: ${result.paths.length}.`);
  lines.push('');
  return lines;
}
