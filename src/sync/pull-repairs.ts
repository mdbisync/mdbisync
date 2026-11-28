// A checked branch view is derived from an observation without changing the observation ref.
import { createHash } from 'node:crypto';
import { type Git, type Oid, type IdMap, type IdEntry, type CommitIdentity, type StateSnapshot, type PushedKey, listTree, buildTree, readIds, signedObservation } from '../state/index.ts';
import { candidateFiles, mapFiles, type Zone } from '../mapping/index.ts';
import { MAPPING_TREE_BYTES, MappingBlobBudget } from '../mapping/blobs.ts';
import { isSyncedChange, oneLine } from './head-check.ts';
import { type SecurityGate } from './security.ts';
import { takePaths } from './merge.ts';

/** The part of a security gate a repair needs: the hooks' answer for a set of files. */
export type RepairGate = Pick<SecurityGate, 'check'>;

type Repair = NonNullable<IdEntry['pullRewrite']>;

/** The set of files the hooks see for a repair: its text alone, the same in every step that asks about it. */
export const repairSet = (path: string, replacement: string): Map<string, string> => new Map([[path, replacement]]);

/** `repair` for the document `id` at `path`, with the sync's signature. */
export function signRepair(key: PushedKey, path: string, id: string, repair: Repair): Repair {
  const {mac: _, ...unsigned} = repair;
  return {...unsigned, mac: key.repairMac(path, id, unsigned)};
}

/**
 * The ids ref is taken as any writer left it, so a stored repair is the sync's own only when it carries the sync's
 * signature for its path and document (`PushedKey.repairMac`). An unsigned one is never applied or trusted as the
 * held text; capture reads its document again and records the repair anew.
 */
export function signedRepair(key: PushedKey, path: string, entry: IdEntry): Repair | undefined {
  return entry.pullRewrite !== undefined && key.verifiesRepair(path, entry.id, entry.pullRewrite) ? entry.pullRewrite : undefined;
}

/** The entries of `ids`, with every repair the sync did not sign left out (`signedRepair`). */
export function signedRepairs(ids: IdMap, key: PushedKey): IdMap {
  return new Map([...ids].map(([path, entry]) => {
    if (entry.pullRewrite === undefined || signedRepair(key, path, entry) !== undefined) return [path, entry];
    const {pullRewrite: _, ...rest} = entry;
    return [path, rest];
  }));
}

/**
 * The repairs a view would apply: mapped synchronized documents with a unique id, still holding the observed text.
 * `unsigned` are the paths whose stored repair would apply but lacks the sync's signature.
 */
async function pendingRepairs(git: Git, linear: Oid, ids: IdMap, zones: ReadonlyMap<string, Zone>, key: PushedKey, paths?: ReadonlySet<string>): Promise<{repairs: Map<string, Repair>; unsigned: Set<string>}> {
  // A repeated id has no canonical path. Check the complete map, before selecting a lane.
  const counts = new Map<string, number>();
  for (const entry of ids.values()) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  const pending = [...ids].filter(([path, entry]) => entry.pullRewrite !== undefined && counts.get(entry.id) === 1 && (paths === undefined || paths.has(path)));
  const repairs = new Map<string, Repair>();
  const unsigned = new Set<string>();
  if (pending.length === 0) return {repairs, unsigned};
  const entries = new Map((await listTree(git, linear, MAPPING_TREE_BYTES)).map(entry => [entry.path, entry]));
  const files = candidateFiles([...entries.values()], zones);
  const blobs = await new MappingBlobBudget().read(git, files);
  const documents = new Set(mapFiles([...entries.values()], zones, blobs).documents.map(document => document.path));
  for (const [path, entry] of pending) {
    const file = entries.get(path);
    if (!documents.has(path) || file === undefined || !isSyncedChange(path, file.mode, zones)) continue;
    const source = blobs.get(file.oid);
    const repair = entry.pullRewrite!;
    if (source === undefined || createHash('sha256').update(source).digest('hex') !== repair.hash) continue;
    if (source.toString('utf8') === repair.replacement) continue;
    if (signedRepair(key, path, entry) === undefined) unsigned.add(path);
    else repairs.set(path, repair);
  }
  return {repairs, unsigned};
}

/**
 * The ids ref only stores a repair's text; it is not the text the hooks checked. Each replacement is applied only
 * when the sync signed it (`signedRepair`) and the tracked branch's security hooks pass its exact bytes. The document
 * of an unsigned, refused or unanswered one keeps its version in `hold` (the branch the view is merged into), so
 * neither the repair nor the observation it would replace is proposed: the write step leaves it waiting for its
 * repair, and a later run asks again.
 */
export async function checkedPullView(git: Git, linear: Oid, ids: IdMap, zones: ReadonlyMap<string, Zone>, identity: CommitIdentity, gate: RepairGate, key: PushedKey, hold: Oid, paths?: ReadonlySet<string>): Promise<{commit: Oid; notes: string[]}> {
  const changes = new Map<string, string>();
  const held = new Set<string>();
  const notes: string[] = [];
  const {repairs, unsigned} = await pendingRepairs(git, linear, ids, zones, key, paths);
  for (const path of unsigned) held.add(path);
  for (const [path, repair] of repairs) {
    const findings = await gate.check(repairSet(path, repair.replacement));
    if (findings === null || findings.length > 0) { held.add(path); continue; }
    changes.set(path, repair.replacement);
    for (const image of repair.images) notes.push(`- ${oneLine(path)}: image ${image.image} of ${image.total} (line ${image.line}).`);
  }
  if (changes.size === 0 && held.size === 0) return {commit: linear, notes};
  let tree = changes.size === 0 ? await git.revParse(`${linear}^{tree}`) : await buildTree(git, linear, changes);
  if (held.size > 0) tree = await takePaths(git, tree, hold, held);
  if (tree === await git.revParse(`${linear}^{tree}`)) return {commit: linear, notes};
  const date = await git.text(['show', '-s', '--format=%cI', linear]);
  const commit = await git.text(['commit-tree', '--no-gpg-sign', tree, '-p', linear, '-m', 'Apply checked image and link repairs'], {env: {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  }});
  return {commit, notes};
}

/** The staged steps' first step: asks the hooks about every repair the state refs hold, so the last step can apply it. */
export async function stagePullRepairs(git: Git, state: StateSnapshot, zones: ReadonlyMap<string, Zone>, gate: RepairGate, key: PushedKey): Promise<void> {
  if (state.linear === null) return;
  const {repairs} = await pendingRepairs(git, state.linear, await readIds(git, state.ids), zones, key);
  for (const [path, repair] of repairs) await gate.check(repairSet(path, repair.replacement));
}

/**
 * Recover conservative plain-link provenance when the ids ref is rebuilt.
 * `firstParent: false` reads every commit `head` holds, as for a tracked
 * branch; a trailer only withholds an upload, so it can never grant one.
 */
export async function readPlainFileProvenance(git: Git, linear: Oid, options: { firstParent?: boolean } = {}): Promise<Map<string, Set<string>>> {
  const log = await git.text(['log', ...(options.firstParent === false ? [] : ['--first-parent']), '--format=%B', '--grep=^Plain-link:', linear]);
  const result = new Map<string, Set<string>>();
  for (const match of log.matchAll(/^Plain-link: (\S+) (\S+)$/gm)) {
    try {
      const id = decodeURIComponent(match[1]!);
      const target = decodeURIComponent(match[2]!);
      if (!result.has(id)) result.set(id, new Set());
      result.get(id)!.add(target);
    } catch { /* A malformed trailer grants no upload permission. */ }
  }
  return result;
}

/**
 * Joins each entry's plain files with those the `linear` record's history names for its document. Anyone who may
 * push can rewrite the ids ref, so an entry without plain files proves nothing: the `Plain-link:` trailers of the
 * sync's `linear` commits are the record of every link a Linear member made, and a run reads them on every run, not
 * only when the ids ref is lost. A `linear` the sync did not sign (one trusted for holding a tree of the tracked
 * branch) has no first-parent record of its own: then every commit it holds is read, the sync's records the tracked
 * branch merged included. A trailer only withholds an upload, so the join never grants one.
 */
export async function addRecordedPlainFiles(git: Git, ids: IdMap, linear: Oid, key: PushedKey): Promise<void> {
  const recorded = await readPlainFileProvenance(git, linear, { firstParent: await signedObservation(git, linear, key) });
  if (recorded.size === 0) return;
  for (const [path, entry] of ids) {
    const targets = recorded.get(entry.id);
    if (targets === undefined) continue;
    // By membership: the ids ref may hold any array, repeated targets included.
    const plainFiles = new Set(entry.plainFiles ?? []);
    if ([...targets].every((target) => plainFiles.has(target))) continue;
    for (const target of targets) plainFiles.add(target);
    ids.set(path, {...entry, plainFiles: [...plainFiles]});
  }
}
