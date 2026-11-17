// The check deadline and red `main` for both lanes of the sync.
//
// The sync never reruns a check: a failed check counts at once, and one a
// person or the repository's own CI reruns on the same head counts by its
// latest result. A head whose checks are still pending a given time after the
// sync pushed it is treated as failed. The push time is noted in the pull
// request's description, so the deadline needs no store of its own.
//
// Before a failure suspends a batch or rewrites a suspended batch's comments,
// the checks of the tracked branch's tip are read: a check that also failed
// there under the same name is not the batch's fault, and the lane is held.

import { CommitNotFoundError } from '../pull-request/merge.ts';
import { type MovedJobSource, type WorkflowIdentity, workflowRevision } from '../pull-request/actions.ts';
import { type CheckExpectation, type CheckFailure, type CheckPublisher, type CheckState, type CommitChecks, type ExpectedCheck, type GitHubRepository, checkState, readCommitChecks } from '../pull-request/index.ts';
import { type Git, type Oid } from '../state/index.ts';

export const DEFAULT_CHECK_DEADLINE_MINUTES = 60;
export const MIN_CHECK_DEADLINE_MINUTES = 10;
export const MAX_CHECK_DEADLINE_MINUTES = 1440;

const HEAD_NOTE = /^<!-- head: sha=([0-9a-f]{40,64}) since=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)(?: checks=([^\s]*))? -->\r?$/m;
const RED_MAIN_NOTE = /^<!-- red main: head=([0-9a-f]{40,64}) main=([0-9a-f]{40,64}) checks=([^\s]*) -->\r?$/m;

/** A noted check: its URI-encoded name and, after `@`, its publisher (`run:<app id>` or `status:<account id>`). */
const NOTED_CHECK = /^([^@]*)(?:@(run|status):(0|[1-9][0-9]{0,14}))?(?:~(.*))?$/;

/**
 * The hidden note that says since when the head has waited for its checks,
 * and which checks it must pass beyond those registered on it, each with
 * the publisher it must come from.
 */
export function headNote(head: Oid, since: Date, checks: readonly ExpectedCheck[] = []): string {
  const expected = checks.length === 0 ? '' : ` checks=${checks.map(notedCheck).join(',')}`;
  return `<!-- head: sha=${head} since=${since.toISOString()}${expected} -->`;
}

function notedCheck(check: ExpectedCheck): string {
  const name = encodeURIComponent(check.name);
  const from = check.publisher === undefined ? name : `${name}@${check.publisher.kind}:${check.publisher.id}`;
  return check.workflow === undefined ? from : `${from}~${encodeURIComponent(JSON.stringify(check.workflow))}`;
}

/**
 * A check named in `required-checks`, with the publisher it must come from:
 * a job of a workflow file in `.github/workflows/`, a check run of a GitHub
 * App, or a commit status from an account. Anyone who may write commit
 * statuses can post one under any name, so a name alone is never enough.
 */
export type RequiredCheck = { name: string; publisher: CheckPublisher } | { name: string; workflow: string };

const REQUIRED_CHECK = /^(.+?)\s*@\s*(?:(app|status):([1-9][0-9]{0,14})|actions:(\.github\/workflows\/[^/\\\x00-\x1f]+\.ya?ml))$/;

/** One line of `required-checks` (`<name> @ actions:<workflow file>`, `@ app:<App id>` or `@ status:<account id>`); undefined for anything else. */
export function requiredCheck(line: string): RequiredCheck | undefined {
  const match = REQUIRED_CHECK.exec(line.trim());
  if (match === null) return undefined;
  const name = (match[1] as string).trim();
  if (match[4] !== undefined) return { name, workflow: match[4] };
  const id = Number(match[3]);
  return Number.isSafeInteger(id) ? { name, publisher: { kind: match[2] === 'app' ? 'run' : 'status', id } } : undefined;
}

/** The checks a pull request's head must pass beyond those registered on it. */
export interface ExpectedChecks {
  /** Every check the head must pass: those observed and the configured ones; sorted, each once. */
  checks: ExpectedCheck[];
  /**
   * The checks registered on earlier heads, with their publishers, which the
   * description notes. Never the configured ones: a check removed from
   * `required-checks` stops counting.
   */
  observed: ExpectedCheck[];
  /**
   * False when the branch's history below the head does not reach, within the search bound, the head the sync's own
   * state records it last pushed: the earlier checks are not known, and the head does not merge.
   */
  complete: boolean;
}

/**
 * Where a head's earlier checks are read: the description's note together with the branch's own history above `base`
 * (the tracked branch) down to `pushed`, the head the sync's own state records it last pushed on this branch; or the
 * commits the sync pushed it on this run. `base` is also where a configured Actions check's workflow file is read.
 */
export type EarlierHeads = { body: string | undefined; git: Git; base: Oid; pushed: Oid | undefined } | { pushedFrom: readonly Oid[]; base: Oid };

/** How many commits below a head are searched for a commit the sync made. */
const EARLIER_HEAD_DEPTH = 50;

/**
 * The checks `head` must pass beyond those registered on it. A commit
 * pushed with a workflow's own token starts no other workflow, so a check
 * that ran on an earlier head and is absent on this one never ran on it.
 *
 * - From the description: the names its note carries, and, when the branch
 *   moved since the noted head (someone else pushed), every check registered
 *   on that head. They add up while others push. The description is text a
 *   person can edit, so it can only add: whatever it says, every check
 *   registered on the branch's own commits below `head`, down to and with
 *   the last head the sync recorded pushing, counts (see `earlierHeadChecks`).
 * - For a head the sync pushed this run: every check registered on the
 *   commits it pushed on, one step back only. Its push starts the
 *   repository's whole CI, so a check that no longer runs (a renamed job)
 *   stays expected for one more push of the sync at most, never for good.
 */
export async function expectedChecks(github: GitHubRepository, head: Oid, required: readonly RequiredCheck[], earlier: EarlierHeads): Promise<ExpectedChecks> {
  const observed: ExpectedCheck[] = [];
  let complete = true;
  if ('pushedFrom' in earlier) {
    for (const parent of earlier.pushedFrom) observed.push(...await registeredChecks(github, parent));
  } else {
    const history = await earlierHeadChecks(earlier.git, github, head, earlier);
    complete = history !== null;
    observed.push(...history ?? []);
    const note = HEAD_NOTE.exec(earlier.body ?? '');
    if (note !== null) {
      for (const token of (note[3] ?? '').split(',').filter(Boolean)) {
        const noted = NOTED_CHECK.exec(token);
        try {
          // A token a person broke names nothing; the checks registered on the noted head still count below.
          if (noted === null) continue;
          const check: ExpectedCheck = { name: decodeURIComponent(noted[1] as string) };
          if (noted[2] !== undefined) check.publisher = { kind: noted[2] as 'run' | 'status', id: Number(noted[3]) };
          if (noted[4] !== undefined) {
            const workflow = JSON.parse(decodeURIComponent(noted[4])) as Partial<WorkflowIdentity> | null;
            check.workflow = workflow && typeof workflow.path === 'string' && typeof workflow.revision === 'string' &&
              ['push', 'pull_request', 'workflow_dispatch', 'dynamic'].includes(String(workflow.event)) ? workflow as WorkflowIdentity : null;
          }
          observed.push(check);
        } catch {
          // A name a person broke names nothing, as above.
        }
      }
      const noted = note[1] as Oid;
      if (noted !== head) observed.push(...await registeredChecks(github, noted));
    }
  }
  // A head the sync itself authenticated may incorporate a trusted workflow
  // update from the tracked branch. Child heads never rebind this evidence.
  // Such a head expects its own revision whatever the earlier one was, so a
  // job whose pull request moved on from its head binds by its file alone.
  const own = 'pushedFrom' in earlier || (complete && earlier.pushed === head);
  if (own) {
    const revisions = new Map<string, string | undefined>();
    // Only verified identities of the head: a stand-in is no evidence of what ran.
    const current = (await registeredChecks(github, head)).filter((entry) => entry.moved === undefined);
    for (const check of observed) {
      const ran = check.moved ?? check.workflow;
      if (!ran || ran.event === 'dynamic') continue;
      const path = ran.path;
      if (!revisions.has(path)) {
        const verified = current.find((entry) => entry.name === check.name && entry.workflow?.path === path &&
          entry.publisher?.kind === check.publisher?.kind && entry.publisher?.id === check.publisher?.id)?.workflow;
        revisions.set(path, verified?.revision ?? await workflowRevision(github, head, path));
      }
      const revision = revisions.get(path);
      check.workflow = revision === undefined ? null : { path, event: ran.event, revision };
    }
  }
  // A note for unlisted checks ("3 more check runs") is no check name: such a head was never read as passed.
  const listed = distinct(observed.filter(({ name }) => !/^[0-9]+ more (check runs|commit statuses)$/.test(name)).map(({ moved: _moved, ...check }) => check));
  // A configured Actions check binds to its workflow file as the tracked branch holds it: a file changed on the sync
  // branch alone (by anyone who may push there) never vouches for its own jobs. A pull request job runs the file as
  // the merge with the tracked branch holds it, which is the tracked branch's own blob unless the branch changed it.
  const configured: ExpectedCheck[] = [];
  const blobs = new Map<string, string | undefined>();
  for (const check of required) {
    if ('publisher' in check) {
      configured.push({ name: check.name, publisher: check.publisher });
      continue;
    }
    if (!blobs.has(check.workflow)) blobs.set(check.workflow, await workflowRevision(github, earlier.base, check.workflow));
    const revision = blobs.get(check.workflow);
    configured.push({ name: check.name, workflow: revision === undefined ? null : { path: check.workflow, event: 'push', revision } });
  }
  return { checks: distinct([...listed, ...configured]), observed: listed, complete };
}

/**
 * The checks registered on the branch's first-parent history below `head`, above `base`, down to and with `pushed`,
 * the last head the sync's own state records it pushed. Every push the sync makes starts the repository's whole CI; a
 * push with a workflow's own token (a formatter's fix, one or several in a row) starts none, so the checks of every
 * such commit since count. A head the sync pushed itself expects, as when it pushed it, only what the commit below it
 * registered. Only that recorded head ends the history: a commit's parents are whatever its author chose, so a merge
 * that looks like one of the sync's own (of the tracked branch or of Linear's state) does not. Null when `pushed` is
 * not known or not found within the bound.
 */
async function earlierHeadChecks(git: Git, github: GitHubRepository, head: Oid, { base, pushed }: { base: Oid; pushed: Oid | undefined }): Promise<ExpectedCheck[] | null> {
  if (pushed === undefined) return null;
  const commits = (await git.text(['rev-list', '--first-parent', '-n', String(EARLIER_HEAD_DEPTH + 2), head, '--not', base])).split('\n').filter(Boolean) as Oid[];
  const own = commits[0] === pushed;
  const checks: ExpectedCheck[] = [];
  for (const [index, commit] of commits.slice(1).entries()) {
    if (index === EARLIER_HEAD_DEPTH) return null;
    checks.push(...await registeredChecks(github, commit));
    if (own || commit === pushed) return checks;
  }
  // The head the sync pushed is not below this one (the branch was rewritten): what ran before is not known.
  return own ? checks : null;
}

/** Each check once, sorted by name, then by publisher. */
function distinct(checks: readonly ExpectedCheck[]): ExpectedCheck[] {
  const byKey = new Map(checks.map((check) => [notedCheck(check), check]));
  return [...byKey.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((key) => byKey.get(key) as ExpectedCheck);
}

/**
 * The checks registered on a commit, whatever their state, each bound to its
 * publisher; none for a commit GitHub does not know. A check whose publisher
 * GitHub did not name stays expected from that unknown publisher, which no
 * check satisfies: a person makes it run again, or the sync's next push ends it.
 */
async function registeredChecks(github: GitHubRepository, sha: Oid): Promise<ExpectedCheck[]> {
  try {
    return (await commitChecks(github, sha)).checks.map(({ name, publisher, workflow, moved }) => {
      if (workflow !== null || moved === undefined) return { name, publisher, ...(workflow === undefined ? {} : { workflow }) };
      // A job whose pull request moved on from this head: expected at its stand-in blob when it has one (see
      // `MovedJobSource`), else unverifiable; a head the sync pushed itself binds it by its file alone.
      const { standIn, ...source } = moved;
      return { name, publisher, workflow: standIn === undefined ? null : { ...source, revision: standIn }, moved: source };
    });
  } catch (error) {
    // A noted commit GitHub does not know (a note a person changed) has no checks to carry over.
    if (error instanceof CommitNotFoundError) return [];
    throw error;
  }
}

/**
 * Since when `head` has waited for its checks: the time noted in `body` for
 * this same head, or `now` for a new head or a description without a note.
 */
export function headSince(body: string | undefined, head: Oid, now: Date): Date {
  const note = HEAD_NOTE.exec(body ?? '');
  if (note === null || note[1] !== head) return now;
  const since = new Date(note[2] as string);
  // A note from the future (a clock that jumped back) starts the clock again rather than never ending it.
  return Number.isNaN(since.getTime()) || since.getTime() > now.getTime() ? now : since;
}

/** What a head of either lane must show before it merges: the expected checks, and some check unless merging without any is allowed. */
export function checkExpectation(options: { mergeWithoutChecks?: boolean | undefined }, checks: readonly ExpectedCheck[]): CheckExpectation {
  return { checks, allowNone: options.mergeWithoutChecks === true };
}

/** Whether a pending head waits only for checks that never registered on it. */
export function checksMissing(checks: CheckState, expectation: CheckExpectation): boolean {
  return checks.pending.length === 0 && ((checks.missing?.length ?? 0) > 0 || (!checks.hasChecks && expectation.allowNone !== true));
}

/** The missing checks as Markdown code, or what is missing when no check ran at all. */
export function missingText(missing: readonly string[]): string {
  return missing.length === 0 ? 'no check ran on its head' : `missing ${codeNames(missing)}`;
}

/** What a person does about `checks-missing`, in either lane. */
export const CHECKS_MISSING_ADVICE = 'Nothing merges until a person acts: make every expected check run on the pull request, also on commits a workflow pushes with its own token (see the pre-commit example); remove a check that no longer exists from `required-checks`; or, for a repository without CI, set `merge-without-checks: true`. A check that ran on an earlier head and no longer runs stays expected for at most one more push of the sync to the branch (a Linear change, or the tracked branch merged in). A later run merges.';

/** Whether a head waiting since `since` is past the deadline at `now`. */
export function pastDeadline(since: Date, minutes: number, now: Date): boolean {
  return now.getTime() - since.getTime() >= minutes * 60_000;
}

/** A normal head held because its failed checks also fail on the tracked branch's tip. */
export interface RedMainHold {
  head: Oid;
  /** The tracked branch's tip the hold was decided on. */
  main: Oid;
  checks: string[];
}

export function redMainNote(hold: RedMainHold): string {
  return `<!-- red main: head=${hold.head} main=${hold.main} checks=${hold.checks.map(encodeURIComponent).join(',')} -->`;
}

export function readRedMainNote(body: string | undefined): RedMainHold | null {
  const note = RED_MAIN_NOTE.exec(body ?? '');
  if (note === null) return null;
  try {
    const checks = (note[3] as string).split(',').filter(Boolean).map(decodeURIComponent);
    return { head: note[1] as Oid, main: note[2] as Oid, checks };
  } catch {
    return null;
  }
}

/**
 * What the tracked branch's tip says about checks that did not pass on a head:
 * - `red`: one of them finished and failed there under the same name; `checks` are its failures there, with their runs;
 * - `pending`: none failed there, but one of them still runs there;
 * - `clear`: none of them failed or runs there: the failure is the head's own. `passed` says whether every one of
 *   them finished and passed there; it is false when the tip has no such check (its CI does not run it, or has not
 *   registered it yet).
 */
export type MainVerdict =
  | { state: 'red'; checks: CheckFailure[] }
  | { state: 'pending'; checks: string[] }
  | { state: 'clear'; passed: boolean };

/** The tip's checks, read once per GitHub client and commit: both lanes ask about the same tip in one run. */
const tipChecks = new WeakMap<GitHubRepository, Map<Oid, Promise<CommitChecks>>>();

export async function readMainVerdict(github: GitHubRepository, main: Oid, names: readonly string[]): Promise<MainVerdict> {
  return mainVerdict(checkState(await commitChecks(github, main)), names);
}

/**
 * A commit's checks with their publishers, read once per GitHub client: the
 * tip and an earlier head are asked about more than once in a run.
 */
function commitChecks(github: GitHubRepository, sha: Oid): Promise<CommitChecks> {
  let known = tipChecks.get(github);
  if (known === undefined) tipChecks.set(github, (known = new Map()));
  let checks = known.get(sha);
  if (checks === undefined) {
    const read = readCommitChecks(github, sha, { creators: true });
    checks = read;
    known.set(sha, read);
    // A failed read is not kept: the next question asks GitHub again.
    read.catch(() => known.delete(sha));
  }
  return checks;
}

export function mainVerdict(checks: CheckState, names: readonly string[]): MainVerdict {
  const wanted = new Set(names);
  const red = (checks.failures ?? checks.failed.map((name) => ({ name }))).filter((failure) => wanted.has(failure.name));
  if (red.length > 0) return { state: 'red', checks: red };
  const pending = checks.pending.filter((name) => wanted.has(name));
  if (pending.length > 0) return { state: 'pending', checks: pending };
  const succeeded = new Set(checks.succeeded ?? []);
  return { state: 'clear', passed: names.length > 0 && names.every((name) => succeeded.has(name)) };
}

/** Check names as Markdown code on one line each: a backtick or line break in a name cannot end the code span. */
export function codeNames(names: readonly string[]): string {
  return names.map((name) => `\`${name.replace(/[`\r\n]/g, ' ')}\``).join(', ');
}
