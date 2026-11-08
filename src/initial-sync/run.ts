// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch and the live documents of every annotated place. Reads
// only; one paged list per place.

import { type RunContext } from '../run/preflight.ts';
import { readBlobs } from '../state/index.ts';
import { type InitialSyncPlan, type PlaceDocuments, annotatedPlaces, placeId, planInitialSync } from './plan.ts';

export async function planFromRepository(context: RunContext): Promise<InitialSyncPlan> {
  const { git, mapping, targets, linear } = context;
  const blobs = await readBlobs(git, mapping.documents.map((document) => document.oid));
  const texts = new Map(mapping.documents.map((document) => [document.path, (blobs.get(document.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  for (const { place } of annotatedPlaces(mapping.zones)) {
    places.push({ place, documents: await linear.listDocuments(placeId(targets, place)) });
  }
  return planInitialSync({ mapping, texts, places, facts: linear.facts });
}
