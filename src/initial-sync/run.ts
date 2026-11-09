// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch (colliding ones included, so they are linted too) and
// all documents of every annotated place, including trash. Reads only; one paged list
// per place.

import { assessCapacity, containerKey } from '../run/capacity.ts';
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
 * Reads the files' texts and lists each place's documents, including trash. A confirmed
 * run lists them with their content, at no extra request, to skip documents
 * that already hold the text and to record what Linear stores.
 */
export async function readPlanSources(context: RunContext, options: { withContent?: boolean } = {}): Promise<PlanSources> {
  const { git, mapping, targets, linear } = context;
  const files = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, files.map((file) => file.oid));
  const texts = new Map(files.map((file) => [file.path, (blobs.get(file.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  const documents = new Map<string, LinearDocument>();
  const containers = new Map<string, LinearDocument[]>();
  for (const { place } of annotatedPlaces(mapping.zones)) {
    const key = containerKey(context, place);
    let listed = containers.get(key);
    if (listed === undefined) {
      listed = await linear.listDocuments(placeId(targets, place), { withContent: options.withContent ?? false, includeArchived: true });
      containers.set(key, listed);
    }
    for (const document of listed) documents.set(document.id, document);
    places.push({ place, documents: listed });
  }
  return { input: { mapping, texts, places, facts: linear.facts }, documents };
}

export async function planFromRepository(context: RunContext, cap?: number): Promise<InitialSyncPlan> {
  const sources = await readPlanSources(context);
  const plan = planInitialSync(sources.input);
  plan.capacity = assessCapacity(context, new Map(sources.input.places.map(({ place, documents }) => [containerKey(context, place), documents])), plan.create, cap);
  return plan;
}
