// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch (colliding ones included, so they are linted too) and
// the live documents of every annotated place. Reads only; one paged list
// per place.

import { type LinearDocument } from '../linear/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { readBlobs } from '../state/index.ts';
import { type InitialSyncPlan, type PlaceDocuments, type PlanInput, annotatedPlaces, leaveOutAtWrite, placeId, planInitialSync } from './plan.ts';
import { predictUploadLeaveOuts } from './uploads.ts';

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
  const files = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, files.map((file) => file.oid));
  const texts = new Map(files.map((file) => [file.path, (blobs.get(file.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  const documents = new Map<string, LinearDocument>();
  for (const { place } of annotatedPlaces(mapping.zones)) {
    const listed = await linear.listDocuments(placeId(targets, place), { withContent: options.withContent ?? false });
    for (const document of listed) documents.set(document.id, document);
    places.push({ place, documents: listed });
  }
  return { input: { mapping, texts, places, facts: linear.facts }, documents };
}

/**
 * The dry run's plan: what a confirmed run would do, with the documents its
 * uploads would leave out already listed as left out. Uploads and downloads
 * nothing.
 */
export async function planFromRepository(context: RunContext): Promise<InitialSyncPlan> {
  const plan = planInitialSync((await readPlanSources(context)).input);
  return leaveOutAtWrite(plan, await predictUploadLeaveOuts(context.git, context.fetched.tracked, plan));
}
