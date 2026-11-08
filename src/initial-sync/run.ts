// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch and the live documents of every annotated place. Reads
// only; one paged list per place.

import { type LinearDocument } from '../linear/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { readBlobs } from '../state/index.ts';
import { type InitialSyncPlan, type PlaceDocuments, type PlanInput, annotatedPlaces, placeId, planInitialSync } from './plan.ts';

export interface PlanSources {
  input: PlanInput;
  /** Every listed document, by id. */
  documents: Map<string, LinearDocument>;
}

/**
 * Reads the files' texts and lists each place's live documents. A confirmed
 * run lists them with their content, at no extra request, to skip documents
 * that already hold the text and to record what Linear stores.
 */
export async function readPlanSources(context: RunContext, options: { withContent?: boolean } = {}): Promise<PlanSources> {
  const { git, mapping, targets, linear } = context;
  const blobs = await readBlobs(git, mapping.documents.map((document) => document.oid));
  const texts = new Map(mapping.documents.map((document) => [document.path, (blobs.get(document.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  const documents = new Map<string, LinearDocument>();
  for (const { place } of annotatedPlaces(mapping.annotations)) {
    const listed = await linear.listDocuments(placeId(targets, place), { withContent: options.withContent ?? false });
    for (const document of listed) documents.set(document.id, document);
    places.push({ place, documents: listed });
  }
  return { input: { mapping, texts, places, facts: linear.facts }, documents };
}

export async function planFromRepository(context: RunContext): Promise<InitialSyncPlan> {
  return planInitialSync((await readPlanSources(context)).input);
}
