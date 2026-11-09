// A quiet run: what a sync that has nothing to carry may and may not do.
//
// A sync's `changed` flag is true whenever it wrote anything, including
// its own state refs. Right after a sync pull request merged, the next sync
// records that merge in the `linear` state ref (a metadata-only merge
// record) and reports `changed: true`, while it writes no document, opens
// or updates no pull request and leaves the tracked content alone. That
// internal catch-up is quiet. A scenario asserts `quiet.<n|last>` equal to
// `[]` instead of `runs.<n>.changed` equal to false.
//
// Quiet means, for that one run, all of:
//
// - it ended successfully and completely (an unfinished run proves nothing);
// - zero document writes: none through the Linear proxy (when the run went
//   through it) and none in its own report;
// - nothing captured from Linear into git;
// - no new pull request and no change to an existing one (head, state,
//   merge, title or body), and the sync branch did not move;
// - the tracked branch tip and its tree did not change;
// - when it reports `changed: true`, a state ref moved: the only write a
//   quiet run may make. A `changed` flag that no state ref write explains
//   is not quiet.
//
// The harness snapshots the world (`RunWorld`) right before and right after
// each run of a scenario that asserts quiet, so every fact comes from the
// world, not from the engine's own account alone.

import type { RunContext } from './context.ts';
import { fetchRef } from './checks.ts';
import type { ProxyRequestRecord } from './fault-proxy.ts';

export const QUIET_SUBJECT = /^quiet\.(\d+|last)$/;

export const STATE_STORES = ['linear', 'ids', 'uploads'] as const;

export interface PullRequestFacts {
  number: number;
  state: string;
  headSha: string;
  mergedAt: string | null;
  title: string;
  body: string;
}

/** The facts a quiet run must leave alone, plus the state refs it may move. */
export interface RunWorld {
  trackedTip: string | null;
  trackedTree: string | null;
  syncTip: string | null;
  stateTips: Record<(typeof STATE_STORES)[number], string | null>;
  pullRequests: PullRequestFacts[];
  /** Linear requests the proxy had seen; null when the run does not go through it. */
  proxyIndex: number | null;
}

export interface QuietInput {
  exitCode: number | null;
  report: Record<string, unknown> | null;
  before: RunWorld;
  after: RunWorld;
  /** Document writes the proxy saw during the run; null when it did not see the run. */
  documentWrites: number | null;
}

/** A document write as the proxy records it. */
export function isDocumentWrite(record: ProxyRequestRecord): boolean {
  return !record.injected && record.status === 200 && record.kind === 'mutation' && /document(Create|Update|Delete|Unarchive)|(Create|Update|Trash|Restore)Document/i.test(record.operation);
}

function field(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function nonEmpty(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Why a run was not quiet; empty when it was. */
export function quietFailures(input: QuietInput): string[] {
  const { report, before, after } = input;
  const failures: string[] = [];
  if (input.exitCode !== 0) failures.push(`the run exited with ${String(input.exitCode)}`);
  if (report === null) return [...failures, 'the run wrote no report'];
  if (report['ok'] !== true || report['complete'] !== true) failures.push('the run did not finish a complete sync');

  if (input.documentWrites !== null && input.documentWrites > 0) failures.push(`${input.documentWrites} document writes reached Linear`);
  for (const key of ['writtenCount', 'writtenDocuments']) {
    const count = report[key];
    if (typeof count !== 'number') failures.push(`the report gives no ${key}`);
    else if (count > 0) failures.push(`the report counts ${count} ${key}`);
  }
  for (const list of ['created', 'updated', 'relocated', 'adopted', 'restored', 'trashed']) {
    if (nonEmpty(field(report, ['sync', list]))) failures.push(`the run ${list} documents`);
  }
  for (const list of ['changed', 'removed']) {
    if (nonEmpty(field(report, ['capture', list]))) failures.push(`the run captured ${list === 'changed' ? 'changed' : 'removed'} documents into git`);
  }

  const earlier = new Map(before.pullRequests.map((pr) => [pr.number, pr]));
  for (const pr of after.pullRequests) {
    const was = earlier.get(pr.number);
    if (was === undefined) failures.push(`pull request #${pr.number} was opened`);
    else if (JSON.stringify(was) !== JSON.stringify(pr)) failures.push(`pull request #${pr.number} was updated`);
  }
  for (const pr of before.pullRequests) if (!after.pullRequests.some((other) => other.number === pr.number)) failures.push(`pull request #${pr.number} disappeared`);
  if (field(report, ['pullRequest', 'pullRequest', 'opened']) === true) failures.push('the report says it opened a pull request');
  if (field(report, ['pullRequest', 'branchMoved']) === true || before.syncTip !== after.syncTip) failures.push('the sync branch moved');
  const merged = field(report, ['pullRequest', 'merged']);
  if (merged !== null && merged !== undefined) failures.push('the run merged a pull request');

  if (before.trackedTree !== after.trackedTree) failures.push('the tracked content changed');
  if (before.trackedTip !== after.trackedTip) failures.push('the tracked branch moved');

  const stateMoved = STATE_STORES.some((store) => before.stateTips[store] !== after.stateTips[store]);
  if (report['changed'] === true && !stateMoved) failures.push('the run reports changed=true, but no state ref moved');
  return failures;
}

// --- snapshots of the live world -----------------------------------------------------------

/** The scenario asserts quiet on some run, so its runs are snapshotted. */
export function watchesQuiet(ctx: RunContext): boolean {
  return ctx.live !== null && ctx.scenario.checks.assertions.some((assertion) => QUIET_SUBJECT.test(assertion.subject));
}

export async function snapshotWorld(ctx: RunContext): Promise<RunWorld> {
  if (ctx.live === null) throw new Error('a quiet run needs the live world');
  const git = await ctx.person();
  // The person's clone has the tracked branch checked out, so read its tip through FETCH_HEAD.
  await git.run(['fetch', '--quiet', 'origin', ctx.names.trackedBranch]);
  const trackedTip = (await git.text(['rev-parse', 'FETCH_HEAD'])).trim();
  const trackedTree = (await git.text(['rev-parse', 'FETCH_HEAD^{tree}'])).trim();
  const stateTips = Object.fromEntries(await Promise.all(STATE_STORES.map(async (store) => [store, await fetchRef(git, `${ctx.names.refPrefix}/${store}`)]))) as RunWorld['stateTips'];
  const pullRequests = (await ctx.live.rest.pullRequests(ctx.names.syncBranch))
    .filter((pr) => pr.head.ref === ctx.names.syncBranch)
    .map((pr) => ({ number: pr.number, state: pr.state, headSha: pr.head.sha, mergedAt: pr.merged_at, title: pr.title, body: pr.body ?? '' }))
    .sort((a, b) => a.number - b.number);
  return {
    trackedTip,
    trackedTree,
    syncTip: await fetchRef(git, `refs/heads/${ctx.names.syncBranch}`),
    stateTips,
    pullRequests,
    proxyIndex: ctx.proxy === null ? null : ctx.proxy.requests.length,
  };
}

/** Document writes the proxy saw between two snapshots. */
export function writesBetween(ctx: RunContext, before: RunWorld, after: RunWorld): number | null {
  if (ctx.proxy === null || before.proxyIndex === null || after.proxyIndex === null) return null;
  return ctx.proxy.requests.slice(before.proxyIndex, after.proxyIndex).filter(isDocumentWrite).length;
}
