// Which Linear places capture may read for the recorded state. The state refs
// are not the tracked branch: anyone who can push to the repository can move
// them, without the review its branch rules ask for. So a place that capture
// finds only in the recorded state is read only when the tracked branch gave
// it to that folder in some commit.

import { type Place, type Zone, collectAnnotations, nearestZone, placeOf, resolveZones } from '../mapping/index.ts';
import { placeKey } from '../initial-sync/plan.ts';
import { type Git, type Oid, readBlobs } from '../state/index.ts';

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

async function named(git: Git, tracked: Oid, folder: string, place: Place): Promise<boolean> {
  const readmes = annotationChain(folder);
  // Only the branch's own line counts: a merge is its result against the previous tip. The commits a merge brought in
  // are not the branch's states, and the sync pull request brings in the state chain itself.
  const log = await git.text(['--literal-pathspecs', 'log', '--first-parent', '--format=%H', tracked, '--', ...readmes]);
  for (const commit of log.split('\n')) {
    if (commit === '') continue;
    const zone = nearestZone(await zonesAt(git, commit, readmes), folder);
    if (zone !== undefined && placeKey(placeOf(zone)) === placeKey(place)) return true;
  }
  return false;
}

/** The README files whose annotations decide a folder's place: its own and its ancestors'. */
function annotationChain(folder: string): string[] {
  const readmes = ['README.md'];
  const parts = folder === '' ? [] : folder.split('/');
  for (let depth = 1; depth <= parts.length; depth++) readmes.push(`${parts.slice(0, depth).join('/')}/README.md`);
  return readmes;
}

async function zonesAt(git: Git, commit: string, readmes: readonly string[]): Promise<Map<string, Zone>> {
  const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...readmes]);
  const entries = stdout.toString('utf8').split('\0').filter((record) => record !== '').flatMap((record) => {
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    return type === 'blob' ? [{ path: record.slice(tab + 1), oid: oid! }] : [];
  });
  const blobs = await readBlobs(git, entries.map((entry) => entry.oid));
  const texts = new Map(entries.map((entry) => [entry.path, blobs.get(entry.oid)!.toString('utf8')]));
  return resolveZones(collectAnnotations(texts).annotations).zones;
}
