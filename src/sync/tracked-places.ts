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
import { type Git, type Oid } from '../state/index.ts';
import { parseTreeListing } from '../state/objects.ts';
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
  const subjects = new Set([MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE, ...INITIAL_RECORD_SUBJECTS]);
  // Only a record that took in the change counts: one from an earlier stay in the new place may be merged later.
  const records = await git.text(['log', '--ancestry-path', '--format=%H %s', '--fixed-strings', ...[...subjects].map((subject) => `--grep=${subject}`), tracked, '--not', change]);
  for (const line of records.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0 || !subjects.has(line.slice(space + 1))) continue;
    const zones = await zonesAt(git, line.slice(0, space), readmes);
    if (zones === undefined) return false;
    const zone = nearestZone(zones, folder);
    if (zone !== undefined && placeKey(placeOf(zone)) === target) return false;
  }
  return true;
}

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
  const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', ...readmes], { maxOutputBytes: MAPPING_TREE_BYTES });
  const entries = parseTreeListing(stdout).filter((entry) => entry.type === 'blob');
  // An unreadable annotation could override an inherited place.
  if (entries.some((entry) => !readableBlob(entry))) return undefined;
  const blobs = await new MappingBlobBudget().read(git, entries);
  const texts = new Map(entries.map((entry) => [entry.path, blobs.get(entry.oid)!.toString('utf8')]));
  return resolveZones(collectAnnotations(texts).annotations).zones;
}
