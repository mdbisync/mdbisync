// A checked branch view is derived from an observation without changing the observation ref.
import { createHash } from 'node:crypto';
import { type Git, type Oid, type IdMap, type IdEntry, type CommitIdentity, type StateSnapshot, listTree, buildTree, readIds } from '../state/index.ts';
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

/** The repairs a view would apply: mapped synchronized documents with a unique id, still holding the observed text. */
async function pendingRepairs(git: Git, linear: Oid, ids: IdMap, zones: ReadonlyMap<string, Zone>, paths?: ReadonlySet<string>): Promise<Map<string, Repair>> {
  // A repeated id has no canonical path. Check the complete map, before selecting a lane.
  const counts = new Map<string, number>();
  for (const entry of ids.values()) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  const pending = [...ids].filter(([path, entry]) => entry.pullRewrite !== undefined && counts.get(entry.id) === 1 && (paths === undefined || paths.has(path)));
  const repairs = new Map<string, Repair>();
  if (pending.length === 0) return repairs;
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
    repairs.set(path, repair);
  }
  return repairs;
}

/**
 * The ids ref only stores a repair's text; it is not the text the hooks checked. Each replacement is applied only
 * when the tracked branch's security hooks pass its exact bytes. The document of a refused or unanswered one keeps
 * its version in `hold` (the branch the view is merged into), so neither the repair nor the observation it would
 * replace is proposed: the write step leaves it waiting for its repair, and a later run asks again.
 */
export async function checkedPullView(git: Git, linear: Oid, ids: IdMap, zones: ReadonlyMap<string, Zone>, identity: CommitIdentity, gate: RepairGate, hold: Oid, paths?: ReadonlySet<string>): Promise<{commit: Oid; notes: string[]}> {
  const changes = new Map<string, string>();
  const held = new Set<string>();
  const notes: string[] = [];
  for (const [path, repair] of await pendingRepairs(git, linear, ids, zones, paths)) {
    const findings = await gate.check(repairSet(path, repair.replacement));
    if (findings === null || findings.length > 0) { held.add(path); continue; }
    changes.set(path, repair.replacement);
    for (const image of repair.images) notes.push(`- ${oneLine(path)}: image ${image.image} of ${image.total} (line ${image.line}).`);
  }
  if (changes.size === 0 && held.size === 0) return {commit: linear, notes};
  let tree = changes.size === 0 ? await git.text(['rev-parse', `${linear}^{tree}`]) : await buildTree(git, linear, changes);
  if (held.size > 0) tree = await takePaths(git, tree, hold, held);
  if (tree === await git.text(['rev-parse', `${linear}^{tree}`])) return {commit: linear, notes};
  const date = await git.text(['show', '-s', '--format=%cI', linear]);
  const commit = await git.text(['commit-tree', '--no-gpg-sign', tree, '-p', linear, '-m', 'Apply checked image and link repairs'], {env: {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  }});
  return {commit, notes};
}

/** The staged steps' first step: asks the hooks about every repair the state refs hold, so the last step can apply it. */
export async function stagePullRepairs(git: Git, state: StateSnapshot, zones: ReadonlyMap<string, Zone>, gate: RepairGate): Promise<void> {
  if (state.linear === null) return;
  const repairs = await pendingRepairs(git, state.linear, await readIds(git, state.ids), zones);
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
