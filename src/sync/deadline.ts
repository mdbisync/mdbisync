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

import { type CheckExpectation, type CheckFailure, type CheckState, type GitHubRepository, PullRequestError, readChecks } from '../pull-request/index.ts';
import { type Git, type Oid } from '../state/index.ts';

export const DEFAULT_CHECK_DEADLINE_MINUTES = 60;
export const MIN_CHECK_DEADLINE_MINUTES = 10;
export const MAX_CHECK_DEADLINE_MINUTES = 1440;

const HEAD_NOTE = /^<!-- head: sha=([0-9a-f]{40,64}) since=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)(?: checks=([^\s]*))? -->\r?$/m;
const RED_MAIN_NOTE = /^<!-- red main: head=([0-9a-f]{40,64}) main=([0-9a-f]{40,64}) checks=([^\s]*) -->\r?$/m;

/**
 * The hidden note that says since when the head has waited for its checks,
 * and which checks it must pass beyond those registered on it.
 */
export function headNote(head: Oid, since: Date, checks: readonly string[] = []): string {
  const expected = checks.length === 0 ? '' : ` checks=${checks.map(encodeURIComponent).join(',')}`;
  return `<!-- head: sha=${head} since=${since.toISOString()}${expected} -->`;
}

/** The checks a pull request's head must pass beyond those registered on it. */
export interface ExpectedChecks {
  /** Every name the head must pass: those observed and the configured ones; sorted, each once. */
  names: string[];
  /**
   * The names registered on earlier heads, which the description notes. Never
   * the configured ones: a name removed from `required-checks` stops counting.
   */
  observed: string[];
  /**
   * False when the branch's history below the head runs past the search bound before it reaches a commit the sync
   * made: the earlier checks are not known, and the head does not merge.
   */
  complete: boolean;
}

/**
 * Where a head's earlier checks are read: the description's note together with the branch's own history above `base`
 * (the tracked branch) down to the nearest commit the sync made (one `linear`, Linear's state, holds, or a merge of the
 * tracked branch or of Linear's state into the branch, or `pushed`, the head the sync's own state records it pushed on
 * this branch); or the commits the sync pushed it on this run.
 */
export type EarlierHeads = { body: string | undefined; git: Git; base: Oid; linear: Oid; pushed?: Oid | undefined } | { pushedFrom: readonly Oid[] };

/** How many commits below a head are searched for a commit the sync made. */
const EARLIER_HEAD_DEPTH = 50;

/**
 * The check names `head` must pass beyond those registered on it. A commit
 * pushed with a workflow's own token starts no other workflow, so a check
 * that ran on an earlier head and is absent on this one never ran on it.
 *
 * - From the description: the names its note carries, and, when the branch
 *   moved since the noted head (someone else pushed), every check registered
 *   on that head. They add up while others push. The description is text a
 *   person can edit, so it can only add: whatever it says, every check
 *   registered on the branch's own commits below `head`, down to and with
 *   the nearest commit the sync made, counts (see `earlierHeadNames`).
 * - For a head the sync pushed this run: every check registered on the
 *   commits it pushed on, one step back only. Its push starts the
 *   repository's whole CI, so a check that no longer runs (a renamed job)
 *   stays expected for one more push of the sync at most, never for good.
 */
export async function expectedChecks(github: GitHubRepository, head: Oid, required: readonly string[], earlier: EarlierHeads): Promise<ExpectedChecks> {
  const observed = new Set<string>();
  let complete = true;
  if ('pushedFrom' in earlier) {
    for (const parent of earlier.pushedFrom) for (const name of await registeredNames(github, parent)) observed.add(name);
  } else {
    const history = await earlierHeadNames(earlier.git, github, head, earlier);
    complete = history !== null;
    for (const name of history ?? []) observed.add(name);
    const note = HEAD_NOTE.exec(earlier.body ?? '');
    if (note !== null) {
      for (const name of (note[3] ?? '').split(',').filter(Boolean)) {
        try {
          observed.add(decodeURIComponent(name));
        } catch {
          // A note a person broke names nothing; the checks registered on the noted head still count below.
        }
      }
      const noted = note[1] as Oid;
      if (noted !== head) for (const name of await registeredNames(github, noted)) observed.add(name);
    }
  }
  // A note for unlisted checks ("3 more check runs") is no check name: such a head was never read as passed.
  const listed = [...observed].filter((name) => !/^[0-9]+ more (check runs|commit statuses)$/.test(name)).sort();
  return { names: [...new Set([...listed, ...required])].sort(), observed: listed, complete };
}

/**
 * The checks registered on the branch's first-parent history below `head`, above `base`, down to and with the nearest
 * commit the sync made. Every push the sync makes starts the repository's whole CI; a push with a workflow's own token
 * (a formatter's fix, one or several in a row) starts none, so the checks of every such commit since count. A head the
 * sync made itself expects, as when it pushed it, only what the commit below it registered. Null when that commit is
 * not found within the bound.
 */
async function earlierHeadNames(git: Git, github: GitHubRepository, head: Oid, { base, linear, pushed }: { base: Oid; linear: Oid; pushed?: Oid | undefined }): Promise<string[] | null> {
  // Each line: a commit, then its parents.
  const lines = (await git.text(['rev-list', '--first-parent', '--parents', '-n', String(EARLIER_HEAD_DEPTH + 2), head, '--not', base])).split('\n').filter(Boolean).map((line) => line.split(' ') as Oid[]);
  // The sync's own commits: the head its state records it pushed, Linear's state, or a merge of the tracked branch or
  // Linear's state into the branch. A merge of anything else (a commit made up for the purpose) is not one of them.
  const known = async (commit: Oid) => await isAncestorOf(git, commit, linear) || await isAncestorOf(git, commit, base);
  const synced = async ([commit, , ...merged]: Oid[]) => commit === pushed || await isAncestorOf(git, commit as Oid, linear)
    || (await Promise.all(merged.map(known))).some(Boolean);
  const names = new Set<string>();
  const own = lines[0] !== undefined && await synced(lines[0]);
  for (const [index, commit] of lines.slice(1).entries()) {
    if (index === EARLIER_HEAD_DEPTH) return null;
    for (const name of await registeredNames(github, commit[0] as Oid)) names.add(name);
    if (own || await synced(commit)) break;
  }
  return [...names];
}

async function isAncestorOf(git: Git, commit: Oid, of: Oid): Promise<boolean> {
  return (await git.run(['merge-base', '--is-ancestor', commit, of], { okCodes: [0, 1] })).code === 0;
}

/** The names of the checks registered on a commit, whatever their state; none for a commit GitHub does not know. */
async function registeredNames(github: GitHubRepository, sha: Oid): Promise<string[]> {
  try {
    const checks = await commitChecks(github, sha);
    return [...checks.failed, ...checks.pending, ...(checks.succeeded ?? [])];
  } catch (error) {
    // A noted commit GitHub does not know (a note a person changed) has no checks to carry over.
    if (error instanceof PullRequestError && (error.status === 404 || error.status === 422)) return [];
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
export function checkExpectation(options: { mergeWithoutChecks?: boolean | undefined }, names: readonly string[]): CheckExpectation {
  return { names, allowNone: options.mergeWithoutChecks === true };
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
const tipChecks = new WeakMap<GitHubRepository, Map<Oid, Promise<CheckState>>>();

export async function readMainVerdict(github: GitHubRepository, main: Oid, names: readonly string[]): Promise<MainVerdict> {
  return mainVerdict(await commitChecks(github, main), names);
}

/** A commit's checks, read once per GitHub client: the tip and an earlier head are asked about more than once in a run. */
function commitChecks(github: GitHubRepository, sha: Oid): Promise<CheckState> {
  let known = tipChecks.get(github);
  if (known === undefined) tipChecks.set(github, (known = new Map()));
  let checks = known.get(sha);
  if (checks === undefined) {
    const read = readChecks(github, sha);
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
