// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch (colliding ones included, so they are linted too) and
// the live documents of every annotated place. Reads only; one paged list
// per place.

import { type RunContext } from '../run/preflight.ts';
import { readBlobs } from '../state/index.ts';
import { type InitialSyncPlan, type PlaceDocuments, annotatedPlaces, placeId, planInitialSync } from './plan.ts';

export async function planFromRepository(context: RunContext): Promise<InitialSyncPlan> {
  const { git, mapping, targets, linear } = context;
  const files = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, files.map((file) => file.oid));
  const texts = new Map(files.map((file) => [file.path, (blobs.get(file.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  for (const { place } of annotatedPlaces(mapping.zones)) {
    places.push({ place, documents: await linear.listDocuments(placeId(targets, place)) });
  }
  return planInitialSync({ mapping, texts, places, facts: linear.facts });
}
