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

import { type CheckFailure, type CheckState, type GitHubRepository, readChecks } from '../pull-request/index.ts';
import { type Oid } from '../state/index.ts';

export const DEFAULT_CHECK_DEADLINE_MINUTES = 60;
export const MIN_CHECK_DEADLINE_MINUTES = 10;
export const MAX_CHECK_DEADLINE_MINUTES = 1440;

const HEAD_NOTE = /^<!-- head: sha=([0-9a-f]{40,64}) since=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z) -->\r?$/m;
const RED_MAIN_NOTE = /^<!-- red main: head=([0-9a-f]{40,64}) main=([0-9a-f]{40,64}) checks=([^\s]*) -->\r?$/m;

/** The hidden note that says since when the head has waited for its checks. */
export function headNote(head: Oid, since: Date): string {
  return `<!-- head: sha=${head} since=${since.toISOString()} -->`;
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
  let known = tipChecks.get(github);
  if (known === undefined) tipChecks.set(github, (known = new Map()));
  let checks = known.get(main);
  if (checks === undefined) {
    checks = readChecks(github, main);
    known.set(main, checks);
    // A failed read is not kept: the next question asks GitHub again.
    checks.catch(() => known.delete(main));
  }
  return mainVerdict(await checks, names);
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
