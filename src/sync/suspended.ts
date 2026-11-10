// The suspended lane keeps its own merge bases: normal merges carry the
// failed batch's history with its tree set aside, so topology is insufficient.
import { randomUUID } from 'node:crypto';
import { splitFile } from '../format/index.ts';
import { findFileLinks } from '../initial-sync/uploads.ts';
import { MARKDOWN_EXTENSION, isRegularFile } from '../mapping/index.ts';
import { closePullRequest, ensurePullRequest, findOpenPullRequest, mergePullRequest, readChecks, waitForChecks, updatePullRequest, type GitHubRepository } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { branchRef, commitIds, commitTree, isAncestor, listTree, pushAtomic, readBlobs, readIds, readReservedIds, readSupersededIds, readWrittenHashes, stateRef, suspendedBranch, type CommitIdentity, type Git, type IdMap, type Oid, type StateConfig, type StateSnapshot } from '../state/index.ts';
import { knownIdLookup, mergeWithMarkers, takePaths, treeCommit } from './merge.ts';
import type { HoldFailure } from './hold.ts';
import type { CheckFailure } from '../pull-request/index.ts';
import { DEFAULT_CHECK_DEADLINE_MINUTES, codeNames, headNote, headSince, pastDeadline, readMainVerdict } from './deadline.ts';

export const SUSPENDED_TITLE = 'Suspended changes from Linear';
export const SET_ASIDE_MESSAGE = 'Set aside suspended changes';
export const LINEAR_INTAKE_MESSAGE = "Take Linear's changes to suspended documents";

export interface SuspendedResult {
  paths: string[];
  checks: string[];
  /** Checks still pending at the deadline: on the suspended head, or on the normal batch this run suspended. */
  timedOut?: string[];
  /**
   * Checks that failed on the suspended head and also on the tracked
   * branch's tip, with their runs there: the documents are not to blame, so
   * their comments are not rewritten for it.
   */
  redMain?: CheckFailure[];
  /** Checks that failed on the suspended head and still run on the tracked branch's tip: the comments wait for that result. */
  mainPending?: string[];
  /** The suspended head's failure this run read, with its check runs: what the suspended documents' comments describe. */
  failure?: HoldFailure;
  /** The failure of the normal batch this run suspended: it describes only that batch's documents. */
  batchFailure?: HoldFailure;

  pullRequest?: { number: number; url: string };
  released?: Oid;
  waiting?: boolean;
  changed?: boolean;
  conflicts?: string[];
  code?: 'github-failed' | 'merge-refused' | 'merge-blocked';
  status?: number;
  reason?: string;
}

export interface LaneOptions {
  config: StateConfig;
  identity?: CommitIdentity;
  state: StateSnapshot;
  github: GitHubRepository;
  mergeGraceSeconds?: number | undefined;
  checkDeadlineMinutes?: number | undefined;
}

export class LaneMoved extends Error {}
export class LaneConflict extends Error {
  readonly paths: string[];
  constructor(message: string, paths: string[] = []) { super(message); this.paths = paths; }
}

export function suspendedPaths(ids: IdMap): Set<string> {
  return new Set([...ids].flatMap(([path, entry]) => entry.suspended === undefined ? [] : [path, ...entry.suspended.paths]));
}

const commit = (context: RunContext, options: LaneOptions, tree: Oid, parents: Oid[], message: string) => commitTree(context.git, {
  base: tree, changes: new Map(), parents, message, identity: options.identity ?? context.identity, skipIfUnchanged: false,
});
const note = (tracked: Oid, linear: Oid) => `\n\nTracked-base: ${tracked}\nLinear-base: ${linear}\n`;

async function recordedBases(git: Git, head: Oid): Promise<{ tracked: Oid; linear: Oid }> {
  // First-parent history ignores the batches joined as second parents and
  // also permits a person's ordinary commit at the tip of this branch.
  const log = await git.text(['log', '--first-parent', '-1', '--all-match', '--grep=^Tracked-base:', '--grep=^Linear-base:', '--format=%B', head]);
  const tracked = /^Tracked-base: ([0-9a-f]{40,64})$/m.exec(log)?.[1];
  const linear = /^Linear-base: ([0-9a-f]{40,64})$/m.exec(log)?.[1];
  if (tracked === undefined || linear === undefined) throw new LaneConflict('The suspended branch has no recorded bases');
  return { tracked, linear };
}

async function mergeTree(git: Git, linear: Oid, other: Oid, base: Oid | undefined, ids: IdMap, idsTip: Oid | null): Promise<Oid> {
  const merged = await mergeWithMarkers(git, linear, other, ids, knownIdLookup(git, idsTip, ids), base);
  if (merged.resolved.unresolved.length > 0) throw new LaneConflict('A suspended file needs a manual merge', merged.resolved.unresolved);
  return merged.resolved.tree;
}

async function changedPaths(git: Git, before: Oid, after: Oid): Promise<string[]> {
  return (await git.text(['diff', '--name-only', '--no-renames', '-z', before, after])).split('\0').filter(Boolean);
}

async function includeCapturedAssets(git: Git, linear: Oid, ids: IdMap, paths: Set<string>): Promise<void> {
  const entries = new Map((await listTree(git, linear)).map((entry) => [entry.path, entry]));
  const documents = [...ids].filter(([, entry]) => entry.suspended !== undefined)
    .map(([path]) => entries.get(path)).filter((entry) => entry !== undefined).filter(isRegularFile);
  const texts = await readBlobs(git, documents.map((entry) => entry.oid));
  for (const document of documents) {
    const body = splitFile((texts.get(document.oid) as Buffer).toString('utf8')).body;
    for (const link of findFileLinks(document.path, body, (path) => {
      const entry = entries.get(path);
      return entry !== undefined && isRegularFile(entry);
    })) if (!link.target.endsWith(MARKDOWN_EXTENSION)) paths.add(link.target);
  }
}

async function persistIds(context: RunContext, options: LaneOptions, ids: IdMap): Promise<Oid> {
  return commitLaneIds(context, options.state.ids, ids, 'Sync: suspended document ids', options.identity);
}

/** Commits the id map on `parent`, keeping its other state files (reserved ids and the like). */
export async function commitLaneIds(context: RunContext, parent: Oid | null, ids: IdMap, message: string, identity?: CommitIdentity): Promise<Oid> {
  const {git} = context;
  return commitIds(git, parent, ids, identity ?? context.identity, { message, reserved: await readReservedIds(git, parent), superseded: await readSupersededIds(git, parent), written: await readWrittenHashes(git, parent) });
}

async function push(context: RunContext, options: LaneOptions, ids: IdMap, head: Oid, expected: Oid | null, normal?: { expected: Oid | null; next: Oid }, updateLane = true): Promise<boolean> {
  // Keep one copy of the complete lane path set, rather than N copies in a batch of N documents.
  const paths = suspendedPaths(ids);
  let first = true;
  for (const [path, entry] of ids) if (entry.suspended !== undefined) {
    entry.suspended.paths = first ? [...paths].sort() : [path];
    entry.suspended.head = head;
    first = false;
  }
  const idsTip = await persistIds(context, options, ids);
  const updates = [
    { ref: stateRef(options.config, 'ids'), expected: options.state.ids, next: idsTip },
    { ref: stateRef(options.config, 'linear'), expected: options.state.linear, next: options.state.linear as Oid },
  ];
  if (updateLane) updates.push({ ref: branchRef(suspendedBranch(options.config)), expected, next: head });
  if (normal !== undefined) updates.push({ ref: branchRef(options.config.syncBranch), ...normal });
  const pushed = await pushAtomic(context.git, options.config, updates);
  if (!pushed.ok) throw new LaneMoved();
  options.state.ids = idsTip;
  if (updateLane) context.fetched.suspended = head;
  if (normal !== undefined) context.fetched.sync = normal.next;
  return pushed.updated.length > 0;
}

async function addEpisodes(context: RunContext, options: LaneOptions, ids: IdMap, paths: ReadonlySet<string>, checks: string[], timedOut: string[] = []): Promise<void> {
  // A normal batch can delete a document: capture has already removed its
  // live id entry, but its episode still needs the historical identity.
  const knownId = knownIdLookup(context.git, options.state.ids, ids);
  for (const path of paths) if (!ids.has(path)) {
    const id = await knownId(path);
    if (id !== undefined && ![...ids.values()].some((entry) => entry.id === id)) ids.set(path, { id });
  }
  for (const [path, entry] of ids) if (paths.has(path) && entry.suspended === undefined) {
    entry.suspended = { noticeId: randomUUID(), paths: [path], checks: [...checks], ...(timedOut.length > 0 ? { timedOut: [...timedOut] } : {}) };
    delete entry.releaseBase;
    delete entry.releasePaths;
  }
}

/** Maintain and, when green over the current tracked tip, release the second lane. */
export async function maintainSuspended(context: RunContext, options: LaneOptions): Promise<SuspendedResult | undefined> {
  const { git } = context;
  const linear = options.state.linear;
  if (linear === null) return undefined;
  const ids = await readIds(git, options.state.ids);
  const paths = suspendedPaths(ids);
  const tracked = context.fetched.tracked;
  const previous = context.fetched.suspended ?? null;
  // A batch containing only CI/non-document files still has a lane to finish.
  if (paths.size === 0) {
    if (previous === null || await isAncestor(git, previous, tracked)) return undefined;
    for (const path of await changedPaths(git, tracked, previous)) paths.add(path);
  }
  let head = previous;
  let bases: { tracked: Oid; linear: Oid };
  if (head === null) {
    const releasedHead = [...ids.values()].find((entry) => entry.suspended?.head !== undefined)?.suspended?.head;
    if (releasedHead !== undefined && await isAncestor(git, releasedHead, tracked)) {
      const previousBases = await recordedBases(git, releasedHead);
      return release(context, options, ids, paths, releasedHead, previousBases.linear, tracked);
    }
    await includeCapturedAssets(git, linear, ids, paths);
    head = await commit(context, options, await takePaths(git, tracked, linear, paths), [tracked], 'Restore suspended changes' + note(tracked, linear));
    bases = { tracked, linear };
  } else {
    bases = await recordedBases(git, head);
    // Heal a run that died after GitHub merged but before the atomic state update.
    if (await isAncestor(git, head, tracked)) return release(context, options, ids, paths, head, bases.linear, tracked);
    if (bases.tracked !== tracked) {
      head = await commit(context, options, await mergeTree(git, head, tracked, bases.tracked, ids, options.state.ids), [head, tracked], 'Merge the tracked branch into suspended changes' + note(tracked, bases.linear));
      bases.tracked = tracked;
    }
    // Discover documents a person's/CI's changes on this branch added to the batch.
    for (const path of await changedPaths(git, tracked, head)) paths.add(path);
    await addEpisodes(context, options, ids, paths, []);
    if (bases.linear !== linear) {
      await includeCapturedAssets(git, linear, ids, paths);
      // The intake never carries paths outside this lane. Mask them before
      // the merge, so their unrelated image/config conflicts cannot hold it.
      const input = await treeCommit(git, await takePaths(git, head, linear, paths), linear);
      const base = await treeCommit(git, await takePaths(git, head, bases.linear, paths), bases.linear);
      const tree = await mergeTree(git, input, head, base, ids, options.state.ids);
      const linearChanged = await takePaths(git, head, linear, paths) !== await takePaths(git, head, bases.linear, paths);
      const selected = await takePaths(git, head, tree, paths);
      if (linearChanged || selected !== await git.text(['rev-parse', `${head}^{tree}`])) {
        head = await commit(context, options, selected, [head], LINEAR_INTAKE_MESSAGE + note(tracked, linear));
        bases.linear = linear;
      }
    }
  }
  const anchor = [...ids.values()].find((entry) => entry.suspended !== undefined);
  if (anchor?.suspended !== undefined) anchor.suspended.paths = [...paths].sort();
  const changed = await push(context, options, ids, head, previous);
  // A previous suspension may have died between its push and closing the normal PR.
  if (context.fetched.sync !== null && await git.text(['show', '-s', '--format=%s', context.fetched.sync]) === SET_ASIDE_MESSAGE) {
    const normal = await findOpenPullRequest(options.github, options.config.syncBranch, options.config.trackedBranch);
    if (normal !== null) await closePullRequest(options.github, normal.number);
  }
  const result: SuspendedResult = { paths: [...paths].sort(), checks: [], changed };
  const open = await findOpenPullRequest(options.github, suspendedBranch(options.config), options.config.trackedBranch);
  const old = /^<!-- suspended merge refused: head=([0-9a-f]+) base=([0-9a-f]+) status=(\d+) reason=([^\s]*) -->\r?$/m.exec(open?.body ?? '');
  const earlier = old?.[1] === head && old?.[2] === tracked ? old : null;
  // The deadline runs from the push of this head, noted in the description; a new head starts it now.
  const since = headSince(open?.body, head, new Date());
  const body = `Changes on hold until their checks pass.\n\n${result.paths.map((path) => `- ${path}`).join('\n')}\n${earlier === null ? '' : `\n${earlier[0]}\n`}\n${headNote(head, since)}\n`;
  const { pullRequest, opened } = await ensurePullRequest(options.github, {
    head: suspendedBranch(options.config), base: options.config.trackedBranch, title: SUSPENDED_TITLE, body,
  });
  result.pullRequest = { number: pullRequest.number, url: pullRequest.url };
  const fresh = head !== previous || opened;
  const grace = options.mergeGraceSeconds ?? 60;
  if (fresh && grace === 0) return { ...result, waiting: true };
  const checks = fresh ? await waitForChecks(options.github, head, grace) : await readChecks(options.github, head);
  result.checks = checks.failed;
  const expired = pastDeadline(since, options.checkDeadlineMinutes ?? DEFAULT_CHECK_DEADLINE_MINUTES, new Date());
  // A check still pending at the deadline counts as failed; the lane no longer holds the normal one for it.
  const timedOut = checks.state === 'pending' && expired ? checks.pending : [];
  if (timedOut.length > 0) result.timedOut = timedOut;
  if (checks.state === 'failed' || timedOut.length > 0) {
    const failures = checks.state === 'failed' ? checks.failures ?? checks.failed.map((name) => ({ name })) : [];
    // The same check failing on the tracked branch's tip is not the documents' fault: their comments stay as they are.
    // While it still runs there, the comments wait for that result, up to the deadline.
    const verdict = await readMainVerdict(options.github, tracked, [...failures.map(({ name }) => name), ...timedOut]);
    if (verdict.state === 'red') result.redMain = verdict.checks;
    else if (verdict.state === 'pending' && !expired) result.mainPending = verdict.checks;
    else if (verdict.state === 'clear' || expired) result.failure = { head, checks: failures, ...(timedOut.length > 0 ? { timedOut } : {}) };
  }
  result.waiting = checks.state === 'pending' && timedOut.length === 0;
  if (checks.state !== 'passed') return result;
  if (!(await isAncestor(git, tracked, head))) return result;
  const remoteTip = (await git.text(['ls-remote', '--refs', options.config.remote, branchRef(options.config.trackedBranch)])).split('\t')[0];
  if (remoteTip !== tracked) return { ...result, waiting: true };
  const merged = await mergePullRequest(options.github, pullRequest.number, head);
  if (!merged.merged) {
    const repeated = earlier !== null && Number(earlier[3]) === merged.status && earlier[4] === encodeURIComponent(merged.reason);
    const code = repeated ? 'merge-blocked' : 'merge-refused';
    if (!repeated) await updatePullRequest(options.github, pullRequest.number, {
      title: SUSPENDED_TITLE,
      body: `${body}\n<!-- suspended merge refused: head=${head} base=${tracked} status=${merged.status} reason=${encodeURIComponent(merged.reason)} -->\n`,
    });
    return { ...result, code, status: merged.status, reason: merged.reason };
  }
  await git.run(['fetch', '--no-tags', '--no-write-fetch-head', options.config.remote, branchRef(options.config.trackedBranch)]);
  return release(context, options, ids, paths, head, bases.linear, merged.sha);
}

async function release(context: RunContext, options: LaneOptions, ids: IdMap, paths: Set<string>, head: Oid, linearBase: Oid, tracked: Oid): Promise<SuspendedResult> {
  const { git } = context;
  let first = true;
  for (const [path, entry] of ids) if (entry.suspended !== undefined) {
    delete entry.suspended;
    entry.releaseBase = linearBase;
    entry.releasePaths = first ? [...paths].sort() : [path];
    first = false;
  }
  const normal = context.fetched.sync;
  let nextNormal = normal;
  if (normal !== null && !(await isAncestor(git, normal, tracked))) {
    // Normal never carried these paths; its set-aside tree is not a revert.
    const side = await treeCommit(git, await takePaths(git, normal, tracked, paths), normal);
    const tree = await mergeTree(git, side, tracked, undefined, ids, options.state.ids);
    nextNormal = await commit(context, options, await takePaths(git, tree, tracked, paths), [normal, tracked], 'Take released changes from the tracked branch');
  }
  await push(context, options, ids, head, context.fetched.suspended ?? null,
    normal === null || nextNormal === normal ? undefined : { expected: normal, next: nextNormal as Oid }, false);
  context.fetched.tracked = tracked;
  const advertised = await git.text(['ls-remote', '--refs', options.config.remote, branchRef(suspendedBranch(options.config))]);
  context.fetched.suspended = advertised === '' ? null : advertised.split('\t')[0] as Oid;
  return { paths: [...paths].sort(), checks: [], released: tracked, changed: true };
}

/** Move a failed normal batch, its set-aside head, and episodes together or not at all. */
export async function suspendBatch(context: RunContext, options: LaneOptions, failed: Oid, normalNumber: number, failures: CheckFailure[], timedOut: string[] = []): Promise<SuspendedResult> {
  const checks = failures.map(({ name }) => name);
  const { git } = context;
  const tracked = context.fetched.tracked;
  const linear = options.state.linear as Oid;
  const ids = await readIds(git, options.state.ids);
  const batchTree = await mergeTree(git, failed, tracked, undefined, ids, options.state.ids);
  const batch = await treeCommit(git, batchTree, failed);
  const paths = new Set(await changedPaths(git, tracked, batchTree));
  // The batch's own paths, before the lane's earlier ones join them: its failure describes only these.
  const batchPaths = [...paths].sort();
  const previous = context.fetched.suspended ?? null;
  let head: Oid;
  // Never adopt an unrelated pre-existing branch, even when main contains it.
  if (previous !== null) await recordedBases(git, previous);
  if (previous === null || await isAncestor(git, previous, tracked)) {
    head = await commit(context, options, batchTree, previous === null ? [failed, tracked] : [previous, failed, tracked], 'Suspend changes from Linear' + note(tracked, linear));
  } else {
    const bases = await recordedBases(git, previous);
    const updated = bases.tracked === tracked ? previous : await commit(context, options, await mergeTree(git, previous, tracked, bases.tracked, ids, options.state.ids), [previous, tracked], 'Merge the tracked branch into suspended changes' + note(tracked, bases.linear));
    head = await commit(context, options, await mergeTree(git, updated, batch, tracked, ids, options.state.ids), [updated, failed], 'Join suspended changes from Linear' + note(tracked, linear));
  }
  for (const path of await changedPaths(git, tracked, head)) paths.add(path);
  // A comment written from the episode alone (a deferred mark) names the failed checks and the late ones apart.
  await addEpisodes(context, options, ids, paths, checks, timedOut);
  const anchor = [...ids.values()].find((entry) => entry.suspended !== undefined);
  if (anchor?.suspended !== undefined) anchor.suspended.paths = [...paths].sort();
  const normal = await commit(context, options, await git.text(['rev-parse', `${tracked}^{tree}`]), [failed, tracked], SET_ASIDE_MESSAGE);
  await push(context, options, ids, head, previous, { expected: failed, next: normal });
  await closePullRequest(options.github, normalNumber);
  const { pullRequest } = await ensurePullRequest(options.github, {
    head: suspendedBranch(options.config), base: options.config.trackedBranch, title: SUSPENDED_TITLE,
    body: `Changes on hold: ${codeNames([...checks, ...timedOut])}.\n\n${[...paths].sort().map((path) => `- ${path}`).join('\n')}\n\n${headNote(head, new Date())}\n`,
  });
  const late = timedOut.length > 0 ? { timedOut } : {};
  return { paths: [...paths].sort(), checks, ...late, batchFailure: { head: failed, paths: batchPaths, checks: failures, ...late }, changed: true, pullRequest: { number: pullRequest.number, url: pullRequest.url } };
}
