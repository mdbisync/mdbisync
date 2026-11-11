// Step 2 of a sync run: Linear's changes towards the tracked branch, through
// the one sync pull request.
//
// The sync branch follows `linear` by fast-forwards and merge commits, never
// by a force push. An ordinary unmerged branch keeps its pending edits even
// when its pull request is closed. A merged branch or an abandoned initial
// snapshot starts again from Linear. Pending edits that change the same lines
// as a later Linear capture or tracked-branch edit are merged with the sync's
// conflict markers, both versions kept, so the pull request still merges and
// the conflict travels like any text. It moves only when `linear` brings the tracked branch
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

import { INITIAL_RECORD_SUBJECTS } from '../initial-sync/index.ts';
import {
  type CheckFailure,
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
  type IdMap,
  INITIAL_SYNC_FROM_LINEAR_RECORD,
  initialRecordChangesParent,
  type Oid,
  type StateConfig,
  type StateSnapshot,
  branchRef,
  pushAtomic,
  readIds,
  commitTree,
} from '../state/index.ts';
import { HOLD_MARK_LIMIT, type HoldMarksResult, linkTarget } from './hold.ts';
import { DEFAULT_CHECK_DEADLINE_MINUTES, codeNames, headNote, headSince, pastDeadline, readMainVerdict, readRedMainNote, redMainNote, type RedMainHold } from './deadline.ts';
import { LaneMoved, LaneConflict, maintainSuspended, suspendBatch, suspendedPaths, type SuspendedResult } from './suspended.ts';
import { knownIdLookup, mergeWithMarkers, takePaths, treeCommit } from './merge.ts';
import { message } from '../messages.ts';
import { type PullRequestCode } from '../codes.ts';

export const DEFAULT_MERGE_GRACE_SECONDS = 60;

export const SYNC_PULL_REQUEST_TITLE = 'Changes from Linear';
/** The message of a merge of `linear` into the sync branch. */
export const SYNC_BRANCH_MERGE_MESSAGE = "Merge Linear's latest changes";
/** The message of a merge of the tracked branch into the sync branch, made when pending edits there conflict with it. */
export const TRACKED_MERGE_MESSAGE = 'Merge the tracked branch into the sync branch';
/** Paths listed in the pull request's description; the rest are counted. */
const LISTED_PATHS = 200;

export interface PullRequestOptions {
  config: StateConfig;
  /** The state refs after capture. */
  state: StateSnapshot;
  github: GitHubRepository;
  identity?: CommitIdentity;
  mergeGraceSeconds?: number | undefined;
  /** Minutes a head's checks may stay pending before its batch is suspended; `DEFAULT_CHECK_DEADLINE_MINUTES` when absent. */
  checkDeadlineMinutes?: number | undefined;
}

export interface PullRequestResult {
  suspended?: SuspendedResult;
  /** The suspended marks the run set, edited and cleared in Linear after the lane's push. */
  holdMarks?: HoldMarksResult;
  /** Merging `linear` would change the tracked branch. */
  needed: boolean;
  /** The open sync pull request after this step; null when there is none. */
  pullRequest: { number: number; url: string; opened: boolean } | null;
  /** This run moved the sync branch. */
  branchMoved: boolean;
  /** The checks on the head; null when this run did not read them. */
  checks: CheckState | null;
  /**
   * Red tracked branch: checks that failed (or did not finish in time) on the
   * head and also failed on the tracked branch's tip, with their runs there.
   * The pull request is held: nothing is suspended or marked.
   */
  redMain?: CheckFailure[];
  /** Checks that failed on the head and still run on the tracked branch's tip: the decision waits for them. */
  mainPending?: string[];
  /** The head's checks passed, but it merges only after the suspended pull request, whose checks still run. */
  waitsForSuspended?: boolean;
  /** The merge commit on the tracked branch when this run merged the pull request. */
  merged: Oid | null;
  /** Files the pull request changes on the tracked branch. */
  paths: string[];
  /**
   * Documents whose pending sync-branch edits changed the same lines as a
   * later Linear or tracked-branch edit: this run's merge into the sync
   * branch, pushed by this run, keeps both versions between conflict markers.
   */
  marked: string[];
  /**
   * Documents whose pending delete or rename met a later edit or rename on the
   * other side: this run's merge into the sync branch decided them by the
   * structural conflict rules (an edit keeps the document).
   */
  decided: string[];
  /**
   * Why the step did not do all it could this run. Waiting for checks is not
   * one: a later run merges.
   * - `conflict`: `linear` and the tracked branch change the same lines, which the write step merges with markers for the next run; or a conflicting file on the sync branch is no document, so it cannot hold markers and a person merges it.
   * - `merge-refused`: GitHub would not merge (the head moved, or the pull request cannot be merged now); a later run tries again.
   * - `merge-blocked`: GitHub refused the merge for the same reason as an earlier run, on the same head and tracked branch; a setup error, a person must change what blocks it.
   * - `initial-pull-request-pending`: the sync branch holds the record of an initial sync from Linear that a person has not merged.
   * - `state-moved`: the sync branch moved while this run worked.
   * - `github-failed`: GitHub refused or failed a request, or no answer came; `status` is its HTTP status, absent when no answer came.
   */
  code?: PullRequestCode;
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
  /** `setup`: a repeatedly refused merge; `no-state`: an initial sync from Linear waits for a person; `incomplete`: run again. */
  kind: 'setup' | 'no-state' | 'incomplete';
  code: NonNullable<PullRequestResult['code']>;
  message: string;
}

export function pullRequestFailure(result: PullRequestResult | undefined): PullRequestFailure | null {
  if (result?.suspended?.code === 'merge-blocked') return {kind:'setup', code:'merge-blocked', message:message('pull-request.merge-blocked', {code:'merge-blocked', refusal:refusalText(result.suspended)})};
  switch (result?.code) {
    case 'merge-blocked':
      return { kind: 'setup', code: result.code, message: message('pull-request.merge-blocked', { code: result.code, refusal: refusalText(result) }) };
    case 'initial-pull-request-pending':
      return { kind: 'no-state', code: result.code, message: message('pull-request.initial-pending', { code: result.code }) };
    case 'state-moved':
    case 'github-failed':
      return { kind: 'incomplete', code: result.code, message: message('pull-request.not-finished', { code: result.code }) };
    default:
      return null;
  }
}

export async function syncPullRequest(context: RunContext, options: PullRequestOptions): Promise<PullRequestResult> {
  const { git, fetched } = context;
  const { config, github } = options;
  let suspended: SuspendedResult | undefined;
  try { suspended = await maintainSuspended(context, options); }
  catch (error) {
    const code = error instanceof LaneMoved ? 'state-moved' : error instanceof LaneConflict ? 'conflict' : error instanceof PullRequestError ? 'github-failed' : undefined;
    if (error instanceof PullRequestError) suspended = { paths: [...suspendedPaths(await readIds(git, options.state.ids))].sort(), checks: [], code: 'github-failed', ...(error.status === undefined ? {} : {status:error.status}) };
    else if (error instanceof LaneConflict) suspended = { paths: [...suspendedPaths(await readIds(git, options.state.ids))].sort(), checks: [], conflicts: error.paths };
    else if (code === undefined) throw error;
    else return { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [], marked: [], decided: [], code, ...(error instanceof LaneConflict ? { paths: error.paths } : {}) };
  }
  const tracked = fetched.tracked;
  const sync = fetched.sync;
  const linear = options.state.linear;
  const result: PullRequestResult = { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [], marked: [], decided: [] };
  if (suspended !== undefined) result.suspended = suspended;
  if (suspended?.code !== undefined) result.code = suspended.code;
  if (suspended?.status !== undefined) result.status = suspended.status;
  if (suspended?.reason !== undefined) result.reason = suspended.reason;
  if (linear === null) return result;

  const frozen = suspendedPaths(await readIds(git, options.state.ids));
  // Mask before merging, so frozen paths cannot conflict or restart normal checks.
  const laneLinear = frozen.size === 0 ? linear : await treeCommit(git, await takePaths(git, linear, sync ?? tracked, frozen), linear);
  const trackedTree = await git.text(['rev-parse', `${tracked}^{tree}`]);
  const wanted = await mergedTree(git, tracked, laneLinear);
  if (wanted === null) return { ...result, needed: true, code: 'conflict' };
  result.needed = wanted !== trackedTree;

  // A sync branch the tracked branch has not merged is the open pull request's head, or will be.
  const pending = sync !== null && !(await isAncestor(git, sync, tracked));
  if (!result.needed && !pending) {
    // A sync branch is made by the first sync pull request and stays. Once `linear` holds more than initial sync's
    // record and the tracked branch, a missing branch was deleted by a person: it comes back at `linear`.
    if (sync !== null || (await isAncestor(git, linear, tracked)) || (await isInitialRecord(git, linear))) return result;
    const pushed = await pushAtomic(git, config, [{ ref: branchRef(config.syncBranch), expected: null, next: frozen.size === 0 ? linear : await commitTree(git, {base: wanted, changes: new Map(), parents: [linear], message: SYNC_BRANCH_MERGE_MESSAGE, identity: options.identity ?? context.identity}) }]);
    if (pushed.ok) return { ...result, branchMoved: true };
    // A refusal that is not a lease (a rule on branch names, missing rights) leaves the branch to the run that needs it.
    return pushed.reason === 'stale' ? { ...result, code: 'state-moved' } : result;
  }

  try {
    const open = sync === null ? null : await findOpenPullRequest(github, config.syncBranch, config.trackedBranch);
    // That record can remove files from the tracked branch: a person merges its pull request, and nothing else may ride along.
    if (open !== null && pending && (await holdsInitialRecord(git, sync as Oid, tracked))) return { ...result, code: 'initial-pull-request-pending' };

    const identity = options.identity ?? context.identity;
    /** A hold on a red tracked branch that this pull request's description notes. */
    const held = open === null ? null : readRedMainNote(open.body);
    // The id map is read only when a merge has documents to resolve.
    const merger = markedMerger(git, options.state.ids, identity, frozen);
    /** What this run's merges into the sync branch resolved; reported only once the branch has moved to them. */
    const resolved: Resolution = { marked: [], decided: [] };
    let head: Oid | null = sync;
    if (open === null && (!pending || (await holdsInitialRecord(git, sync as Oid, tracked)))) {
      // A merged branch can start again from Linear. An older initial
      // sync record left on this branch is also left out: its destructive
      // snapshot needs a person's approval. Ordinary unmerged changes stay on the branch,
      // including a person's edits and CI fixes after a pull request closes.
      if (!result.needed) return result;
      head = await restart(git, sync, linear, wanted, identity, frozen.size > 0);
    } else {
      const advanced = await advance(git, merger, sync as Oid, linear, frozen.size > 0);
      if (advanced === null) return { ...result, code: 'conflict' };
      if (advanced.head !== sync) {
        const now = await mergedTree(git, tracked, sync as Oid);
        const next = await mergedTree(git, tracked, advanced.head);
        if (next === null || next !== now) {
          head = advanced.head;
          addResolution(resolved, advanced);
        }
      }
    }
    if (head === null) return { ...result, code: 'conflict' };

    let headTree = await mergedTree(git, tracked, head);
    if (headTree === null) {
      // Pending edits on the sync branch and a later tracked-branch edit change
      // the same lines: the tracked branch is merged into the sync branch, both
      // versions between conflict markers, so the pull request can merge.
      const merged = await merger(head, tracked, [head, tracked], TRACKED_MERGE_MESSAGE);
      // A conflicting file that cannot hold markers (it is no document) waits for a person.
      if (merged === null) return { ...result, code: 'conflict' };
      head = merged.head;
      addResolution(resolved, merged);
      headTree = await git.text(['rev-parse', `${head}^{tree}`]);
    }
    // The hold covers the branch as it came into this run, also when Linear's changes joined it above: the new head
    // still lacks the tracked branch's fix until it is merged in.
    let hold = held !== null && held.head === sync ? held : null;
    // A held branch: once the tracked branch's tip no longer fails those checks (a fix, or a person's rerun there),
    // the sync branch merges it, so the checks run again on a head that holds that tip.
    if (hold !== null && !(await isAncestor(git, tracked, head))) {
      const verdict = await readMainVerdict(github, tracked, hold.checks);
      // Only a tip that ran those checks and passed them: one whose CI has not registered them yet proves nothing.
      if (verdict.state === 'clear' && verdict.passed) {
        const merged = await merger(head, tracked, [head, tracked], TRACKED_MERGE_MESSAGE);
        if (merged === null) return { ...result, code: 'conflict' };
        head = merged.head;
        addResolution(resolved, merged);
        headTree = await git.text(['rev-parse', `${head}^{tree}`]);
        hold = null;
      }
    }
    if (open === null && !result.needed && headTree === trackedTree) return result;

    if (head !== sync) {
      const pushed = await pushAtomic(git, config, [{ ref: branchRef(config.syncBranch), expected: sync, next: head }]);
      if (!pushed.ok) return { ...result, code: 'state-moved' };
      result.branchMoved = true;
      result.marked = [...new Set(resolved.marked)].sort();
      result.decided = [...new Set(resolved.decided)].sort();
    }
    result.paths = (await git.text(['diff', '--name-only', '--no-renames', trackedTree, headTree])).split('\n').filter(Boolean);

    // An earlier refusal stays noted while it still applies: the same head on the same tracked branch.
    const noted = open === null ? null : readRefusal(open.body);
    const earlier = noted !== null && noted.head === head && noted.base === tracked ? noted : null;
    // The deadline runs from the push of this head, noted in the description; a new head starts it now.
    const since = headSince(open?.body, head, new Date());
    const stillHeld = hold === null ? null : { ...hold, head };
    const { pullRequest, opened } = await ensurePullRequest(github, {
      head: config.syncBranch,
      base: config.trackedBranch,
      title: SYNC_PULL_REQUEST_TITLE,
      body: pullRequestBody(result.paths, earlier, { head, since, held: stillHeld }),
    });
    result.pullRequest = { number: pullRequest.number, url: pullRequest.url, opened };
    const fresh = result.branchMoved || opened || suspended?.released !== undefined;
    const grace = options.mergeGraceSeconds ?? DEFAULT_MERGE_GRACE_SECONDS;
    if (fresh && grace === 0) return result;
    result.checks = fresh ? await waitForChecks(github, head, grace) : await readChecks(github, head);
    const expired = pastDeadline(since, options.checkDeadlineMinutes ?? DEFAULT_CHECK_DEADLINE_MINUTES, new Date());
    // A check still pending, queued or never started at the deadline counts as failed.
    const timedOut = result.checks.state === 'pending' && expired ? result.checks.pending : [];
    if (result.checks.state === 'failed' || timedOut.length > 0) {
      const failures = result.checks.state === 'failed' ? result.checks.failures ?? result.checks.failed.map((name) => ({ name })) : [];
      // The same check failing on the tracked branch's tip is not this batch's fault: the pull request is held.
      const verdict = await readMainVerdict(github, tracked, [...failures.map(({ name }) => name), ...timedOut]);
      if (verdict.state === 'red') {
        result.redMain = verdict.checks;
        const hold: RedMainHold = { head, main: tracked, checks: verdict.checks.map(({ name }) => name) };
        const body = pullRequestBody(result.paths, earlier, { head, since, held: hold });
        try {
          if (body !== pullRequest.body) await updatePullRequest(github, pullRequest.number, { title: SYNC_PULL_REQUEST_TITLE, body });
        } catch (error) {
          // The hold is what this run reports; an unrecorded note is written again by the next run.
          if (!(error instanceof PullRequestError)) throw error;
        }
        return result;
      }
      // While such a check still runs there, the decision waits, up to the deadline; a held head waits for it.
      if (verdict.state === 'pending' && (!expired || stillHeld !== null)) {
        result.mainPending = verdict.checks;
        return result;
      }
      // A held head waits for a tip that has not run those checks yet (its CI has not registered them): no result there
      // proves the documents are to blame.
      if (verdict.state === 'clear' && !verdict.passed && stillHeld !== null) {
        result.mainPending = stillHeld.checks;
        return result;
      }
      const lane = result.suspended;
      result.suspended = await suspendBatch(context, options, head, pullRequest.number, failures, timedOut);
      if (lane !== undefined) {
        // The suspended head's own failure still describes the documents suspended before this batch; the report names
        // both heads' checks.
        const joined = result.suspended;
        if (lane.failure !== undefined) joined.failure = lane.failure;
        if (lane.redMain !== undefined) joined.redMain = lane.redMain;
        if (lane.mainPending !== undefined) joined.mainPending = lane.mainPending;
        joined.checks = [...new Set([...lane.checks, ...joined.checks])].sort();
        const late = [...new Set([...(lane.timedOut ?? []), ...(joined.timedOut ?? [])])].sort();
        if (late.length > 0) joined.timedOut = late;
      }
      result.pullRequest = null;
      result.branchMoved = true;
      return result;
    }
    if (result.checks.state === 'pending') return result;
    // The suspended lane goes first: while its head's checks run, a normal merge would move the tracked branch under it.
    if (suspended?.waiting === true) {
      result.waitsForSuspended = true;
      return result;
    }
    const merge = await mergePullRequest(github, pullRequest.number, head);
    if (!merge.merged) {
      const refusal: MergeRefusal = { head, base: tracked, status: merge.status, reason: merge.reason };
      const refused = { ...result, status: merge.status, reason: merge.reason };
      if (earlier !== null && earlier.status === refusal.status && earlier.reason === refusal.reason) return { ...refused, code: 'merge-blocked' };
      try {
        await updatePullRequest(github, pullRequest.number, { title: SYNC_PULL_REQUEST_TITLE, body: pullRequestBody(result.paths, refusal, { head, since, held: stillHeld }) });
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
    if (error instanceof LaneMoved) return { ...result, code: 'state-moved' };
    if (error instanceof LaneConflict) return { ...result, code: 'conflict' };
    if (error instanceof PullRequestError) return { ...result, code: 'github-failed', ...(error.status === undefined ? {} : { status: error.status }) };
    throw error;
  }
}

/** Whether `commit` is an initial sync's record, in either direction. */
async function isInitialRecord(git: Git, commit: Oid): Promise<boolean> {
  const [subject] = (await git.text(['show', '-s', '--format=%s', commit])).split('\n');
  return INITIAL_RECORD_SUBJECTS.has(subject ?? '');
}

/**
 * Whether pending history still carries an initial snapshot that changes
 * tracked files. Review commits do not approve it; a sync merge ends the
 * search because `restart` has already selected a replacement tree.
 */
async function holdsInitialRecord(git: Git, sync: Oid, tracked: Oid): Promise<boolean> {
  // Review commits on an initial snapshot do not approve it. Follow the
  // first-parent history until a sync merge, which already chose its tree.
  const commits = (await git.text(['log', '--first-parent', '--format=%H %s', `${tracked}..${sync}`])).split('\n');
  let record: Oid | undefined;
  for (const line of commits) {
    const separator = line.indexOf(' ');
    const subject = line.slice(separator + 1);
    if (subject === SYNC_BRANCH_MERGE_MESSAGE) break;
    if (subject === INITIAL_SYNC_FROM_LINEAR_RECORD) {
      record = line.slice(0, separator);
      break;
    }
  }
  if (record === undefined) return false;
  return initialRecordChangesParent(git, record);
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
 * Restart a merged branch or an abandoned initial snapshot: `linear` when the
 * branch is new or `linear` descends from it; otherwise a merge commit of the
 * branch and `linear` whose tree is `wanted`, the tracked branch with
 * `linear` merged in, so nothing else the branch held is carried on.
 */
async function restart(git: Git, sync: Oid | null, linear: Oid, wanted: string, identity: CommitIdentity, masked = false): Promise<Oid> {
  if (masked) return commitTree(git, {base: wanted, changes: new Map(), parents: sync === null ? [linear] : [sync, linear], message: SYNC_BRANCH_MERGE_MESSAGE, identity});
  if (sync === null || (await isAncestor(git, sync, linear))) return linear;
  return commitMerge(git, wanted, [sync, linear], SYNC_BRANCH_MERGE_MESSAGE, identity);
}

/** Documents a merge into the sync branch resolved: with conflict markers, or by the structural rules (a delete or rename against an edit). */
interface Resolution {
  marked: string[];
  decided: string[];
}

/** A new head and what its merge resolved. */
interface Advanced extends Resolution {
  head: Oid;
}

function addResolution(into: Resolution, from: Resolution): void {
  into.marked.push(...from.marked);
  into.decided.push(...from.decided);
}

/**
 * A merge commit of `parents` whose tree merges `gitSide` into `linearSide`
 * as step 3 does: documents both change on the same lines hold both texts
 * between the conflict marker paragraphs, so neither version is lost and
 * the pull request carries the conflict to the tracked branch like any
 * text; deletes and renames against edits follow the structural rules.
 * Only the sync branch gets this commit; Linear's state ref keeps only what
 * Linear returned. Null when a conflicting file is no mapped document,
 * which cannot hold markers.
 */
type Merger = (linearSide: Oid, gitSide: Oid, parents: [Oid, Oid], message: string) => Promise<Advanced | null>;

function markedMerger(git: Git, idsCommit: Oid | null, identity: CommitIdentity, frozen: ReadonlySet<string>): Merger {
  let lookup: Promise<{ ids: IdMap; knownId: (path: string) => Promise<string | undefined> }> | undefined;
  const idsOnce = () => (lookup ??= readIds(git, idsCommit).then((ids) => ({ ids, knownId: knownIdLookup(git, idsCommit, ids) })));
  return async (linearSide, gitSide, parents, message) => {
    if (frozen.size > 0) linearSide = await treeCommit(git, await takePaths(git, linearSide, gitSide, frozen), linearSide);
    const clean = await mergedTree(git, linearSide, gitSide);
    if (clean !== null) return { head: await commitMerge(git, clean, parents, message, identity), marked: [], decided: [] };
    const { ids, knownId } = await idsOnce();
    const { resolved } = await mergeWithMarkers(git, linearSide, gitSide, ids, knownId);
    if (resolved.unresolved.length > 0) return null;
    return { head: await commitMerge(git, resolved.tree, parents, message, identity), marked: resolved.marked, decided: resolved.decided.map((entry) => entry.path) };
  };
}

/**
 * The pending branch moved forward to hold `linear`: `linear` itself, the
 * branch as it is, or a merge of both. Edits on the branch that change the
 * same lines as `linear` are kept as the git version between conflict
 * markers, `linear`'s text as the Linear version. Null when a conflicting
 * file cannot hold markers.
 */
async function advance(git: Git, merge: Merger, sync: Oid, linear: Oid, masked = false): Promise<Advanced | null> {
  if (masked) return merge(linear, sync, [sync, linear], SYNC_BRANCH_MERGE_MESSAGE);
  if (await isAncestor(git, sync, linear)) return { head: linear, marked: [], decided: [] };
  if (await isAncestor(git, linear, sync)) return { head: sync, marked: [], decided: [] };
  return merge(linear, sync, [sync, linear], SYNC_BRANCH_MERGE_MESSAGE);
}

function commitMerge(git: Git, tree: string, parents: [Oid, Oid], message: string, identity: CommitIdentity): Promise<Oid> {
  return git.text(['commit-tree', '--no-gpg-sign', tree, '-p', parents[0], '-p', parents[1], '-m', message], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
  });
}

/** Names, counts and GitHub's reason for a refused merge, and the notes on its head; never document content. */
function pullRequestBody(paths: readonly string[], refusal: MergeRefusal | null, notes: { head: Oid; since: Date; held: RedMainHold | null }): string {
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
  if (notes.held !== null) {
    lines.push('', `Waiting: ${codeNames(notes.held.checks)} also failed on the tracked branch's tip, so this change is not to blame. The sync merges the tracked branch in once it passes there.`, redMainNote(notes.held));
  }
  lines.push('', headNote(notes.head, notes.since));
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
  if (result.suspended !== undefined) {
    const hold = result.suspended;
    const link = hold.pullRequest === undefined ? '' : ` [#${hold.pullRequest.number}](${hold.pullRequest.url})`;
    lines.push(hold.released ? 'Released the suspended batch.' : `Suspended changes${link}: ${hold.paths.map((path) => `\`${path}\``).join(', ')}.`, '');
    if (hold.code === 'merge-refused' || hold.code === 'merge-blocked') lines.push(`GitHub refused the suspended merge (${refusalText(hold)}).`, '');
    if (hold.code === 'github-failed') lines.push('A GitHub request for the suspended lane failed; the normal lane still runs.', '');
    if (hold.conflicts !== undefined) lines.push(`Suspended files waiting for a manual merge: ${hold.conflicts.map((path) => `\`${path}\``).join(', ')}.`, '');
    if (hold.checks.length > 0) lines.push(`Failed checks: ${codeNames(hold.checks)}.`, '');
    if (hold.timedOut !== undefined && hold.timedOut.length > 0) lines.push(`Checks that did not finish in time: ${codeNames(hold.timedOut)}.`, '');
    if (hold.redMain !== undefined) lines.push(`The suspended documents' comments in Linear stay as they are: ${checkRuns(hold.redMain)} also failed on the tracked branch's tip.`, '');
    if (hold.mainPending !== undefined) lines.push(`The suspended documents' comments in Linear wait: ${codeNames(hold.mainPending)} failed on the suspended pull request and still runs on the tracked branch's tip.`, '');
  }
  const marks = result.holdMarks;
  if (marks !== undefined) {
    const counts = [[marks.set.length, 'marked'], [marks.updated.length, 'comments updated'], [marks.cleared.length, 'cleared']].filter(([count]) => (count as number) > 0).map(([count, what]) => `${count} ${what}`);
    if (counts.length > 0) lines.push(`Suspended documents in Linear: ${counts.join(', ')}.`, '');
    if (marks.deferred > 0) lines.push(`${marks.deferred} more suspended documents get their mark or comment in a later run (at most ${HOLD_MARK_LIMIT} per run).`, '');
    if (marks.removed.length > 0) lines.push(`Suspended documents in Linear's trash or archived, without a mark: ${marks.removed.map((path) => `\`${path}\``).join(', ')}.`, '');
    if (marks.unresolved !== undefined) lines.push(`Linear refused to resolve the comment of released documents in its trash or archived: ${marks.unresolved.map(({ path, error }) => `\`${path}\` (${error})`).join(', ')}. The comment stays on the document, and no later run tries again.`, '');
    if (marks.unreadAnnotations !== undefined) lines.push(`GitHub did not give the annotations of ${marks.unreadAnnotations.map((name) => `\`${name}\``).join(', ')}; the comments name those checks without them.`, '');
    if (marks.code !== undefined) lines.push(`The suspended marks did not finish (\`${marks.code}\`${marks.failure === undefined ? '' : `, ${marks.failure.operation}`}); a later run goes on.`, '');
  }
  const pr = result.pullRequest;
  const link = pr === null ? '' : `[#${pr.number}](${pr.url})`;
  const names = (list: readonly string[] | undefined) => codeNames(list ?? []);
  if (result.redMain !== undefined) {
    lines.push(`The sync pull request ${link} is held: ${checkRuns(result.redMain)} also failed on the tracked branch's tip, so the change is not to blame. Nothing is suspended and nothing is written to Linear about it; once the check passes on the tracked branch, the sync merges it into the sync branch and the checks run again.`);
  } else if (result.mainPending !== undefined) {
    lines.push(`${codeNames(result.mainPending)} failed on the sync pull request ${link} and still runs on the tracked branch's tip; the sync waits for that result before it suspends anything.`);
  } else if (result.waitsForSuspended === true) {
    lines.push(`Every check on the sync pull request ${link} passed; it merges after the suspended pull request, whose checks still run.`);
  }
  const explained = result.redMain !== undefined || result.mainPending !== undefined || result.waitsForSuspended === true;
  switch (result.code) {
    case 'conflict':
      lines.push("Linear's latest changes and the tracked branch, or the sync pull request's branch, change the same lines. The sync branch is left as it is this run. When the conflicting files are documents, the sync merges them with conflict markers: this run into Linear's state, a later run into the sync branch. A conflicting file that is not a document waits: merge the tracked branch and Linear's state ref into the sync branch and resolve it there; the sync keeps those commits.");
      break;
    case 'merge-refused':
      lines.push(`GitHub did not merge the sync pull request ${link} (${refusalText(result)}); a later run tries again.`);
      break;
    case 'merge-blocked':
      lines.push(
        `Setup error: GitHub refused again to merge the sync pull request ${link}, on the same head and for the same reason as an earlier run (${refusalText(result)}).`,
        "Nothing changes until a person does: when GitHub names a required check that is expected, make that check run on the sync pull request (check workflow filters and the required check's name); otherwise let the sync's GitHub App merge into the tracked branch (for example, adjust the branch's rules). A later run merges.",
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
      if (explained) break;
      if (result.merged !== null) lines.push('Merged the sync pull request with a merge commit: every check on its head passed.');
      else if (pr === null) lines.push('The tracked branch already holds every change from Linear: no pull request is needed.');
      else if (pr.opened) lines.push(`Opened the sync pull request ${link}. ${result.checks?.pending.length ? `Waiting for ${names(result.checks.pending)}; a later run merges it.` : 'A later run merges it when every check on its head has passed.'}`);
      else if (result.branchMoved) lines.push(`Added new Linear changes to the sync pull request ${link}. ${result.checks?.pending.length ? `Waiting for ${names(result.checks.pending)}; a later run merges it.` : 'A later run merges it when every check on its head has passed.'}`);
      else lines.push(`The sync pull request ${link} waits for ${names(result.checks?.pending) || 'its checks'}; a later run merges it.`);
  }
  if (result.paths.length > 0) lines.push('', `Files it changes on the tracked branch: ${result.paths.length}.`);
  if (result.marked.length > 0) {
    lines.push(
      '',
      `Pending edits on the sync branch and later edits change the same lines in ${result.marked.length === 1 ? '1 document' : `${result.marked.length} documents`}: ${names(result.marked)}. Both versions are kept between conflict markers; edit the text on either side to resolve it.`,
    );
  }
  if (result.decided.length > 0) {
    lines.push(
      '',
      `Pending deletes or renames on the sync branch met later edits or renames in ${result.decided.length === 1 ? '1 document' : `${result.decided.length} documents`}: ${names(result.decided)}. The sync decided them by its structural conflict rules, as for any other conflict: an edited document is kept.`,
    );
  }
  lines.push('');
  return lines;
}

/** Check names with links to their runs: `name` ([run](url)). */
function checkRuns(checks: readonly CheckFailure[]): string {
  return checks.map((check) => `${codeNames([check.name])}${check.url === undefined ? '' : ` ([run](${linkTarget(check.url)}))`}`).join(', ');
}
