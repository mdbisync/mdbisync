// The suspended lane keeps its own merge bases: normal merges carry the
// failed batch's history with its tree set aside, so topology is insufficient.
import { randomUUID } from 'node:crypto';
import { SYNC_IDENTITY } from '../initial-sync/index.ts';
import { closePullRequest, ensurePullRequest, findOpenPullRequest, mergePullRequest, readChecks, waitForChecks, type GitHubRepository } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { branchRef, commitIds, commitTree, isAncestor, pushAtomic, readIds, readReservedIds, readSupersededIds, readWrittenHashes, stateRef, suspendedBranch, type Git, type IdMap, type Oid, type StateConfig, type StateSnapshot } from '../state/index.ts';
import { knownIdLookup, mergeWithMarkers, takePaths, treeCommit } from './merge.ts';

export const SUSPENDED_TITLE = 'Suspended changes from Linear';
export const SET_ASIDE_MESSAGE = 'Set aside suspended changes';
export const LINEAR_INTAKE_MESSAGE = "Take Linear's changes to suspended documents";

export interface SuspendedResult {
  paths: string[];
  checks: string[];
  pullRequest?: { number: number; url: string };
  released?: Oid;
  waiting?: boolean;
}

export interface LaneOptions {
  config: StateConfig;
  state: StateSnapshot;
  github: GitHubRepository;
  mergeGraceSeconds?: number | undefined;
}

export class LaneMoved extends Error {}
export class LaneConflict extends Error {
  readonly paths: string[];
  constructor(message: string, paths: string[] = []) { super(message); this.paths = paths; }
}

export function suspendedPaths(ids: IdMap): Set<string> {
  return new Set([...ids].flatMap(([path, entry]) => entry.suspended === undefined ? [] : [path, ...entry.suspended.paths]));
}

const commit = (git: Git, tree: Oid, parents: Oid[], message: string) => commitTree(git, {
  base: tree, changes: new Map(), parents, message, identity: SYNC_IDENTITY, skipIfUnchanged: false,
});
const note = (tracked: Oid, linear: Oid) => `\n\nTracked-base: ${tracked}\nLinear-base: ${linear}\n`;

async function recordedBases(git: Git, head: Oid): Promise<{ tracked: Oid; linear: Oid }> {
  // First-parent history ignores the batches joined as second parents and
  // also permits a person's ordinary commit at the tip of this branch.
  const log = await git.text(['log', '--first-parent', '--format=%B', head]);
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

async function persistIds(git: Git, options: LaneOptions, ids: IdMap): Promise<Oid> {
  // Preserve auxiliary state files, such as reserved ids, in every lane update.
  return commitIds(git, options.state.ids, ids, SYNC_IDENTITY, { message: 'Sync: suspended document ids', reserved: await readReservedIds(git, options.state.ids), superseded: await readSupersededIds(git, options.state.ids), written: await readWrittenHashes(git, options.state.ids) });
}

async function push(context: RunContext, options: LaneOptions, ids: IdMap, head: Oid, expected: Oid | null, normal?: { expected: Oid | null; next: Oid }): Promise<void> {
  const idsTip = await persistIds(context.git, options, ids);
  const updates = [
    { ref: stateRef(options.config, 'ids'), expected: options.state.ids, next: idsTip },
    { ref: stateRef(options.config, 'linear'), expected: options.state.linear, next: options.state.linear as Oid },
    { ref: branchRef(suspendedBranch(options.config)), expected, next: head },
  ];
  if (normal !== undefined) updates.push({ ref: branchRef(options.config.syncBranch), ...normal });
  if (!(await pushAtomic(context.git, options.config, updates)).ok) throw new LaneMoved();
  options.state.ids = idsTip;
  context.fetched.suspended = head;
  if (normal !== undefined) context.fetched.sync = normal.next;
}

async function addEpisodes(context: RunContext, options: LaneOptions, ids: IdMap, paths: ReadonlySet<string>, checks: string[]): Promise<void> {
  // A normal batch can delete a document: capture has already removed its
  // live id entry, but its episode still needs the historical identity.
  const knownId = knownIdLookup(context.git, options.state.ids, ids);
  for (const path of paths) if (!ids.has(path)) {
    const id = await knownId(path);
    if (id !== undefined && ![...ids.values()].some((entry) => entry.id === id)) ids.set(path, { id });
  }
  for (const [path, entry] of ids) if (paths.has(path) && entry.suspended === undefined) {
    entry.suspended = { noticeId: randomUUID(), paths: [...paths].sort(), checks: [...checks] };
    delete entry.releaseBase;
  }
}

/** Maintain and, when green over the current tracked tip, release the second lane. */
export async function maintainSuspended(context: RunContext, options: LaneOptions): Promise<SuspendedResult | undefined> {
  const { git } = context;
  const linear = options.state.linear;
  if (linear === null) return undefined;
  const ids = await readIds(git, options.state.ids);
  const paths = suspendedPaths(ids);
  if (paths.size === 0) return undefined;
  const tracked = context.fetched.tracked;
  const previous = context.fetched.suspended ?? null;
  let head = previous;
  let bases: { tracked: Oid; linear: Oid };
  if (head === null) {
    head = await commit(git, await takePaths(git, tracked, linear, paths), [tracked], 'Restore suspended changes' + note(tracked, linear));
    bases = { tracked, linear };
  } else {
    bases = await recordedBases(git, head);
    // Heal a run that died after GitHub merged but before the atomic state update.
    if (await isAncestor(git, head, tracked)) return release(context, options, ids, paths, head, bases.linear, tracked);
    if (bases.tracked !== tracked) {
      head = await commit(git, await mergeTree(git, head, tracked, bases.tracked, ids, options.state.ids), [head, tracked], 'Merge the tracked branch into suspended changes' + note(tracked, bases.linear));
      bases.tracked = tracked;
    }
    // Discover documents a person's/CI's changes on this branch added to the batch.
    for (const path of await changedPaths(git, tracked, head)) paths.add(path);
    await addEpisodes(context, options, ids, paths, []);
    if (bases.linear !== linear) {
      const tree = await mergeTree(git, linear, head, bases.linear, ids, options.state.ids);
      const selected = await takePaths(git, head, tree, paths);
      if (selected !== await git.text(['rev-parse', `${head}^{tree}`])) {
        head = await commit(git, selected, [head], LINEAR_INTAKE_MESSAGE + note(tracked, linear));
        bases.linear = linear;
      }
    }
  }
  for (const entry of ids.values()) if (entry.suspended !== undefined) entry.suspended.paths = [...paths].sort();
  await push(context, options, ids, head, previous);
  // A previous suspension may have died between its push and closing the normal PR.
  if (context.fetched.sync !== null && await git.text(['show', '-s', '--format=%s', context.fetched.sync]) === SET_ASIDE_MESSAGE) {
    const normal = await findOpenPullRequest(options.github, options.config.syncBranch, options.config.trackedBranch);
    if (normal !== null) await closePullRequest(options.github, normal.number);
  }
  const result: SuspendedResult = { paths: [...paths].sort(), checks: [] };
  const { pullRequest, opened } = await ensurePullRequest(options.github, {
    head: suspendedBranch(options.config), base: options.config.trackedBranch, title: SUSPENDED_TITLE,
    body: `Changes on hold until their checks pass.\n\n${result.paths.map((path) => `- ${path}`).join('\n')}\n`,
  });
  result.pullRequest = { number: pullRequest.number, url: pullRequest.url };
  const fresh = head !== previous || opened;
  const grace = options.mergeGraceSeconds ?? 60;
  if (fresh && grace === 0) return { ...result, waiting: true };
  const checks = fresh ? await waitForChecks(options.github, head, grace) : await readChecks(options.github, head);
  result.checks = checks.failed;
  result.waiting = checks.state === 'pending';
  if (checks.state !== 'passed') return result;
  if (!(await isAncestor(git, tracked, head))) return result;
  const remoteTip = (await git.text(['ls-remote', '--refs', options.config.remote, branchRef(options.config.trackedBranch)])).split('\t')[0];
  if (remoteTip !== tracked) return { ...result, waiting: true };
  const merged = await mergePullRequest(options.github, pullRequest.number, head);
  if (!merged.merged) return result;
  await git.run(['fetch', '--no-tags', '--no-write-fetch-head', options.config.remote, branchRef(options.config.trackedBranch)]);
  return release(context, options, ids, paths, head, bases.linear, merged.sha);
}

async function release(context: RunContext, options: LaneOptions, ids: IdMap, paths: Set<string>, head: Oid, linearBase: Oid, tracked: Oid): Promise<SuspendedResult> {
  const { git } = context;
  for (const entry of ids.values()) if (entry.suspended !== undefined) {
    delete entry.suspended;
    entry.releaseBase = linearBase;
    entry.releasePaths = [...paths].sort();
  }
  const normal = context.fetched.sync;
  let nextNormal = normal;
  if (normal !== null && !(await isAncestor(git, normal, tracked))) {
    // Normal never carried these paths; its set-aside tree is not a revert.
    const side = await treeCommit(git, await takePaths(git, normal, tracked, paths), normal);
    const tree = await mergeTree(git, side, tracked, undefined, ids, options.state.ids);
    nextNormal = await commit(git, await takePaths(git, tree, tracked, paths), [normal, tracked], 'Take released changes from the tracked branch');
  }
  await push(context, options, ids, head, context.fetched.suspended ?? null,
    normal === null || nextNormal === normal ? undefined : { expected: normal, next: nextNormal as Oid });
  context.fetched.tracked = tracked;
  return { paths: [...paths].sort(), checks: [], released: tracked };
}

/** Move a failed normal batch, its set-aside head, and episodes together or not at all. */
export async function suspendBatch(context: RunContext, options: LaneOptions, failed: Oid, normalNumber: number, checks: string[]): Promise<SuspendedResult> {
  const { git } = context;
  const tracked = context.fetched.tracked;
  const linear = options.state.linear as Oid;
  const ids = await readIds(git, options.state.ids);
  const batchTree = await mergeTree(git, failed, tracked, undefined, ids, options.state.ids);
  const batch = await treeCommit(git, batchTree, failed);
  const paths = new Set(await changedPaths(git, tracked, batchTree));
  const previous = context.fetched.suspended ?? null;
  let head: Oid;
  if (previous === null || await isAncestor(git, previous, tracked)) {
    head = await commit(git, batchTree, previous === null ? [failed, tracked] : [previous, failed, tracked], 'Suspend changes from Linear' + note(tracked, linear));
  } else {
    const bases = await recordedBases(git, previous);
    const updated = bases.tracked === tracked ? previous : await commit(git, await mergeTree(git, previous, tracked, bases.tracked, ids, options.state.ids), [previous, tracked], 'Merge the tracked branch into suspended changes' + note(tracked, bases.linear));
    head = await commit(git, await mergeTree(git, updated, batch, tracked, ids, options.state.ids), [updated, failed], 'Join suspended changes from Linear' + note(tracked, linear));
  }
  for (const path of await changedPaths(git, tracked, head)) paths.add(path);
  await addEpisodes(context, options, ids, paths, checks);
  const normal = await commit(git, await git.text(['rev-parse', `${tracked}^{tree}`]), [failed, tracked], SET_ASIDE_MESSAGE);
  await push(context, options, ids, head, previous, { expected: failed, next: normal });
  await closePullRequest(options.github, normalNumber);
  const { pullRequest } = await ensurePullRequest(options.github, {
    head: suspendedBranch(options.config), base: options.config.trackedBranch, title: SUSPENDED_TITLE,
    body: `Changes on hold: ${checks.map((name) => `\`${name}\``).join(', ')}.\n\n${[...paths].sort().map((path) => `- ${path}`).join('\n')}\n`,
  });
  return { paths: [...paths].sort(), checks, pullRequest: { number: pullRequest.number, url: pullRequest.url } };
}
