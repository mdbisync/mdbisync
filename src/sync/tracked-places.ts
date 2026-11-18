// Which Linear places capture may read for the recorded state. The state refs
// are not the tracked branch: anyone who can push to the repository can move
// them, without the review its branch rules ask for. A folder annotation the
// recorded state names is read only to finish the tracked branch's latest move
// of that folder (`pendingMove`). Other recorded places, such as an excluded
// file's last place, are read only when the tracked branch gave that place to
// the folder in some commit (`trackedPlaces`).

import { type Place, type Zone, collectAnnotations, nearestZone, placeOf, resolveZones } from '../mapping/index.ts';
import { MAPPING_TREE_BYTES, MappingBlobBudget, readableBlob } from '../mapping/blobs.ts';
import { placeKey } from '../initial-sync/plan.ts';
import { type Git, type Oid, isAncestor } from '../state/index.ts';
import { type TreeEntry, parseTreeListing } from '../state/objects.ts';
import { INITIAL_RECORD_SUBJECTS } from '../initial-sync/index.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from './write.ts';

/** Whether files of `folder` may be read from `place`. */
export type PlaceCheck = (folder: string, place: Place) => Promise<boolean>;

/**
 * A place of the current mapping is allowed anywhere. Any other place is allowed for a folder when a commit of the
 * tracked branch gave the folder that place, through its own annotation or an inherited one.
 */
export function trackedPlaces(git: Git, tracked: Oid, current: ReadonlyMap<string, Zone>): PlaceCheck {
  const allowed = new Set([...current.values()].map((zone) => placeKey(placeOf(zone))));
  const answers = new Map<string, Promise<boolean>>();
  return (folder, place) => {
    if (allowed.has(placeKey(place))) return Promise.resolve(true);
    const key = `${folder}\0${placeKey(place)}`;
    let answer = answers.get(key);
    if (answer === undefined) answers.set(key, answer = named(git, tracked, folder, place));
    return answer;
  };
}

/**
 * Whether the recorded place `from` of `folder` is a move the tracked branch made and the sync has not recorded yet:
 * `from` is the folder's place just before the tracked branch's first-parent line last changed it to `to`, and no
 * commit the tracked branch holds that descends from that change is a sync record that gives the folder `to`. A record the
 * sync merged in after the move took the new place, so a recorded state that still names the old one was moved back
 * by someone else. A commit with a record's subject that someone else made can only make this answer no.
 */
export async function pendingMove(git: Git, tracked: Oid, folder: string, from: Place, to: Place): Promise<boolean> {
  const readmes = annotationChain(folder);
  const target = placeKey(to);
  let change: string | undefined;
  let before: Zone | undefined;
  for await (const { commit, zone } of zonesAlong(git, tracked, readmes, folder)) {
    if (zone === undefined || placeKey(placeOf(zone)) !== target) {
      before = zone;
      break;
    }
    change = commit;
  }
  if (change === undefined || before === undefined || placeKey(placeOf(before)) !== placeKey(from)) return false;
  return !(await moveRecorded(git, tracked, change, readmes, folder, target));
}

/**
 * Whether `linear` took in the tracked branch's latest move of a folder of the current mapping, and no sync record on
 * the tracked branch holds that move yet (the rule of `pendingMove`). Until such a record reaches the tracked branch, a
 * state ref moved back to before the move can read the folder's previous place, so the sync pull request carries that
 * record even when it changes no file. One pass over the README history serves every folder.
 */
export async function recordsUnmergedMove(git: Git, tracked: Oid, linear: Oid, current: ReadonlyMap<string, Zone>): Promise<boolean> {
  const folders = [...current].map(([folder, zone]) => ({ folder, readmes: annotationChain(folder), target: placeKey(placeOf(zone)), change: undefined as string | undefined, done: false }));
  if (folders.length === 0) return false;
  const moves: Array<{ folder: string; readmes: string[]; target: string; change: string }> = [];
  for await (const { commit, texts, unreadable } of readmeHistory(git, tracked, [...new Set(folders.flatMap((entry) => entry.readmes))])) {
    for (const entry of folders) {
      if (entry.done) continue;
      const chain = new Map(entry.readmes.flatMap((path) => texts.has(path) ? [[path, texts.get(path)!] as const] : []));
      // As in `zonesAlong`: an unreadable annotation leaves the folder without a known place at that commit.
      const zone = entry.readmes.some((path) => unreadable.has(path)) ? undefined : nearestZone(resolveZones(collectAnnotations(chain).annotations).zones, entry.folder);
      if (zone !== undefined && placeKey(placeOf(zone)) === entry.target) {
        entry.change = commit;
        continue;
      }
      entry.done = true;
      if (entry.change !== undefined && zone !== undefined) moves.push({ ...entry, change: entry.change });
    }
    if (folders.every((entry) => entry.done)) break;
  }
  for (const move of moves) {
    if (await isAncestor(git, move.change, linear) && !(await moveRecorded(git, tracked, move.change, move.readmes, move.folder, move.target))) return true;
  }
  return false;
}

/**
 * Whether a commit the tracked branch holds that descends from `change` is a sync record that gives the folder the
 * place `target`. Only a record that took in the change counts: one from an earlier stay in that place may be merged
 * later.
 */
async function moveRecorded(git: Git, tracked: Oid, change: string, readmes: readonly string[], folder: string, target: string): Promise<boolean> {
  const subjects = new Set([MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE, ...INITIAL_RECORD_SUBJECTS]);
  const records = await git.text(['log', '--ancestry-path', '--format=%H %s', '--fixed-strings', ...[...subjects].map((subject) => `--grep=${subject}`), tracked, '--not', change]);
  for (const line of records.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0 || !subjects.has(line.slice(space + 1))) continue;
    const zones = await zonesAt(git, line.slice(0, space), readmes);
    // A record whose annotations cannot be read proves nothing either way: the move counts as recorded, so capture
    // refuses the old place.
    if (zones === undefined) return true;
    const zone = nearestZone(zones, folder);
    if (zone !== undefined && placeKey(placeOf(zone)) === target) return true;
  }
  return false;
}

/**
 * The texts of `readmes` after each commit of the tracked branch's first-parent line that changed one of them, newest
 * first: the commits `zonesAlong` visits for any of them. The states come from the tip's files and each commit's raw
 * diff against its first parent, in two git calls; blobs are read in batches as the walk reaches them, within the
 * mapping's limits. `unreadable` names the files over the mapping's size limit, which `zonesAt` does not read either.
 */
async function* readmeHistory(git: Git, tracked: Oid, readmes: readonly string[]): AsyncGenerator<{ commit: string; texts: ReadonlyMap<string, string>; unreadable: ReadonlySet<string> }> {
  const tip = await blobEntries(git, tracked, readmes);
  const sizes = new Map(tip.map((entry) => [entry.oid, entry.size]));
  const state = new Map(tip.map((entry) => [entry.path, entry.oid]));
  const { stdout } = await git.run(['--literal-pathspecs', 'log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--raw', '-z', '--no-abbrev', '--format=%x01%H', tracked, '--', ...readmes]);
  const commits = parseRawLog(stdout.toString('utf8'));
  const texts = new Map<Oid, string>();
  for (let start = 0; start < commits.length; start += HISTORY_BATCH) {
    const batch = commits.slice(start, start + HISTORY_BATCH);
    // The files of this batch's states: the current ones and those before each of its commits.
    const needed = new Map([...state].map(([path, oid]) => [oid, path]));
    for (const { changes } of batch) for (const change of changes) if (change.before !== undefined) needed.set(change.before, change.path);
    const unsized = [...needed.keys()].filter((oid) => !sizes.has(oid));
    for (const [oid, size] of await blobSizes(git, unsized)) sizes.set(oid, size);
    const entries: TreeEntry[] = [...needed].filter(([oid]) => !texts.has(oid)).map(([oid, path]) => ({ path, mode: '100644', type: 'blob', oid, size: sizes.get(oid) ?? null }));
    for (const [oid, blob] of await new MappingBlobBudget().read(git, entries)) texts.set(oid, blob.toString('utf8'));
    for (const { commit, changes } of batch) {
      const unreadable = new Set([...state].flatMap(([path, oid]) => texts.has(oid) ? [] : [path]));
      yield { commit, texts: new Map([...state].flatMap(([path, oid]) => texts.has(oid) ? [[path, texts.get(oid)!] as const] : [])), unreadable };
      for (const change of changes) {
        if (change.before === undefined) state.delete(change.path);
        else state.set(change.path, change.before);
      }
    }
    // Only the current files are read again.
    const current = new Set(state.values());
    for (const oid of texts.keys()) if (!current.has(oid)) texts.delete(oid);
  }
}

/** The sizes of blobs by id, in one git process. */
async function blobSizes(git: Git, oids: readonly Oid[]): Promise<Map<Oid, number | null>> {
  const sizes = new Map<Oid, number | null>();
  if (oids.length === 0) return sizes;
  const lines = await git.text(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${oids.join('\n')}\n` });
  for (const line of lines.split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid !== undefined) sizes.set(oid, type === 'blob' && size !== undefined ? Number(size) : null);
  }
  return sizes;
}

const HISTORY_BATCH = 200;

/**
 * Commits of `git log --raw -z --format=%x01%H`, each with its changed files as they were before it. Fields are
 * NUL-separated: a commit header, then pairs of `:<old mode> <new mode> <old oid> <new oid> <status>` and a path. A
 * header is read only where one can stand, so a path may hold any byte but NUL.
 */
function parseRawLog(text: string): Array<{ commit: string; changes: Array<{ path: string; before: string | undefined }> }> {
  const fields = text.split('\0');
  const commits: Array<{ commit: string; changes: Array<{ path: string; before: string | undefined }> }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!.replace(/^\n/, '');
    if (field.startsWith('\x01')) commits.push({ commit: field.slice(1), changes: [] });
    else if (field.startsWith(':') && commits.length > 0 && index + 1 < fields.length) {
      // The file before the commit, when it was a blob there (`ls-tree` lists a link as one too).
      const [mode, , oid] = field.slice(1).split(' ');
      commits.at(-1)!.changes.push({ path: fields[++index]!, before: mode !== undefined && BLOB_MODES.has(mode) ? oid : undefined });
    }
  }
  return commits;
}

const BLOB_MODES = new Set(['100644', '100755', '120000']);

async function named(git: Git, tracked: Oid, folder: string, place: Place): Promise<boolean> {
  for await (const { zone } of zonesAlong(git, tracked, annotationChain(folder), folder)) {
    if (zone !== undefined && placeKey(placeOf(zone)) === placeKey(place)) return true;
  }
  return false;
}

/**
 * The folder's zone at each commit of the tracked branch's first-parent line that changed its README chain, newest
 * first. Only the branch's own line counts: a merge is its result against the previous tip. The commits a merge
 * brought in are not the branch's states, and the sync pull request brings in the state chain itself.
 */
async function* zonesAlong(git: Git, tracked: Oid, readmes: readonly string[], folder: string): AsyncGenerator<{ commit: string; zone: Zone | undefined }> {
  const log = await git.text(['--literal-pathspecs', 'log', '--first-parent', '--format=%H', tracked, '--', ...readmes]);
  for (const commit of log.split('\n')) {
    if (commit === '') continue;
    const zones = await zonesAt(git, commit, readmes);
    yield { commit, zone: zones === undefined ? undefined : nearestZone(zones, folder) };
  }
}

/** The README files whose annotations decide a folder's place: its own and its ancestors'. */
function annotationChain(folder: string): string[] {
  const readmes = ['README.md'];
  const parts = folder === '' ? [] : folder.split('/');
  for (let depth = 1; depth <= parts.length; depth++) readmes.push(`${parts.slice(0, depth).join('/')}/README.md`);
  return readmes;
}

async function zonesAt(git: Git, commit: string, readmes: readonly string[]): Promise<Map<string, Zone> | undefined> {
  const entries = await blobEntries(git, commit, readmes);
  // An unreadable annotation could override an inherited place.
  if (entries.some((entry) => !readableBlob(entry))) return undefined;
  const blobs = await new MappingBlobBudget().read(git, entries);
  const texts = new Map(entries.map((entry) => [entry.path, blobs.get(entry.oid)!.toString('utf8')]));
  return resolveZones(collectAnnotations(texts).annotations).zones;
}

/** The blobs among `readmes` at `commit`, with their sizes. */
async function blobEntries(git: Git, commit: string, readmes: readonly string[]): Promise<TreeEntry[]> {
  const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', ...readmes], { maxOutputBytes: MAPPING_TREE_BYTES });
  return parseTreeListing(stdout).filter((entry) => entry.type === 'blob');
}
