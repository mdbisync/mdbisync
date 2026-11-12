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
import type { ProxyRequestRecord } from './fault-proxy.ts';

export const QUIET_SUBJECT = /^quiet\.(\d+|last)$/;

/** What one run changed in the world, empty when it changed nothing (`untouchedFailures`). */
export const UNTOUCHED_SUBJECT = /^untouched\.(\d+|last)$/;

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
  /** Every ref of the run on the sandbox, by name: branches and state refs alike. */
  refs: Record<string, string>;
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

/** The sync pull requests opened, updated or gone between two snapshots. */
function pullRequestChanges(before: RunWorld, after: RunWorld): string[] {
  const changes: string[] = [];
  const earlier = new Map(before.pullRequests.map((pr) => [pr.number, pr]));
  for (const pr of after.pullRequests) {
    const was = earlier.get(pr.number);
    if (was === undefined) changes.push(`pull request #${pr.number} was opened`);
    else if (JSON.stringify(was) !== JSON.stringify(pr)) changes.push(`pull request #${pr.number} was updated`);
  }
  for (const pr of before.pullRequests) if (!after.pullRequests.some((other) => other.number === pr.number)) changes.push(`pull request #${pr.number} disappeared`);
  return changes;
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
    if (nonEmpty(field(report, ['capture', list]))) failures.push(`the run captured ${list} documents into git`);
  }

  failures.push(...pullRequestChanges(before, after));
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

/**
 * What one run changed in the world, empty when it changed nothing: the
 * check for a run that must refuse and write nothing at all, where even
 * the state ref move a quiet run may make is a change.
 *
 * - `linearMutations`: Linear mutations the run sent through the proxy,
 *   whatever their answer; null when the proxy did not see the run, which
 *   proves nothing.
 * - every ref of the run: none created, moved or deleted (the tracked
 *   branch, the sync branch, the state refs and any other);
 * - pull requests: none opened, updated or gone.
 */
export function untouchedFailures(input: { before: RunWorld; after: RunWorld; linearMutations: number | null }): string[] {
  const { before, after } = input;
  const failures: string[] = [];
  if (input.linearMutations === null) failures.push('the proxy did not see the run, so its Linear writes are unknown');
  else if (input.linearMutations > 0) failures.push(`${input.linearMutations} Linear mutations were sent`);
  for (const ref of [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].sort()) {
    const was = before.refs[ref];
    const now = after.refs[ref];
    if (was === undefined) failures.push(`ref ${ref} was created`);
    else if (now === undefined) failures.push(`ref ${ref} was deleted`);
    else if (was !== now) failures.push(`ref ${ref} moved`);
  }
  failures.push(...pullRequestChanges(before, after));
  return failures;
}

// --- snapshots of the live world -----------------------------------------------------------

/** The scenario asserts quiet or untouched on some run, so the world around each of its runs is snapshotted. */
export function watchesRunWorld(ctx: RunContext): boolean {
  return ctx.live !== null && ctx.scenario.checks.assertions.some((assertion) => QUIET_SUBJECT.test(assertion.subject) || UNTOUCHED_SUBJECT.test(assertion.subject));
}

/**
 * The world now. One listing of the run's refs gives every tip at the same
 * moment; only the tracked tree needs a fetch. `throughProxy` is false for
 * a run the Linear proxy cannot see (an Actions run talks to Linear
 * directly), so its document writes are left to its report.
 */
export async function snapshotWorld(ctx: RunContext, options: { throughProxy: boolean }): Promise<RunWorld> {
  if (ctx.live === null) throw new Error('a quiet run needs the live world');
  const refs = new Map((await ctx.live.sandbox.runRefs()).filter((entry) => entry.runId === ctx.names.runId).map((entry) => [entry.ref, entry.oid]));
  const tip = (ref: string) => refs.get(ref) ?? null;
  const trackedTip = tip(`refs/heads/${ctx.names.trackedBranch}`);
  let trackedTree: string | null = null;
  if (trackedTip !== null) {
    const git = await ctx.person();
    await git.run(['fetch', '--quiet', 'origin', trackedTip]);
    trackedTree = (await git.text(['rev-parse', `${trackedTip}^{tree}`])).trim();
  }
  const stateTips = Object.fromEntries(STATE_STORES.map((store) => [store, tip(`${ctx.names.refPrefix}/${store}`)])) as RunWorld['stateTips'];
  const pullRequests = (await ctx.live.rest.pullRequests(ctx.names.syncBranch))
    .filter((pr) => pr.head.ref === ctx.names.syncBranch)
    .map((pr) => ({ number: pr.number, state: pr.state, headSha: pr.head.sha, mergedAt: pr.merged_at, title: pr.title, body: pr.body ?? '' }))
    .sort((a, b) => a.number - b.number);
  return {
    trackedTip,
    trackedTree,
    syncTip: tip(`refs/heads/${ctx.names.syncBranch}`),
    stateTips,
    pullRequests,
    refs: Object.fromEntries([...refs].sort(([a], [b]) => a.localeCompare(b))),
    proxyIndex: !options.throughProxy || ctx.proxy === null ? null : ctx.proxy.requests.length,
  };
}

/** Document writes the proxy saw between two snapshots. */
export function writesBetween(ctx: RunContext, before: RunWorld, after: RunWorld): number | null {
  if (ctx.proxy === null || before.proxyIndex === null || after.proxyIndex === null) return null;
  return ctx.proxy.requests.slice(before.proxyIndex, after.proxyIndex).filter(isDocumentWrite).length;
}

/**
 * Linear requests between two snapshots that may have written, whatever
 * their answer: every request but a recognized GraphQL query, so one the
 * proxy could not classify and any other HTTP call (an upload) count too.
 * OAuth calls (minting and revoking the run's token) and injected answers,
 * which never reached Linear, do not.
 */
export function mutationsBetween(ctx: RunContext, before: RunWorld, after: RunWorld): number | null {
  if (ctx.proxy === null || before.proxyIndex === null || after.proxyIndex === null) return null;
  return ctx.proxy.requests.slice(before.proxyIndex, after.proxyIndex).filter((record) => !record.injected && record.kind !== 'query' && !record.operation.startsWith('http /oauth/')).length;
}
