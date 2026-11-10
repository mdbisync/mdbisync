// Reads what the initial sync plans with: the text of every mapped file of
// the tracked branch (colliding ones included, so they are linted too) and
// all documents of every annotated place, including trash. Reads only.

import { assessCapacity, containerKey, readContainerDocuments } from '../run/capacity.ts';
import { type LinearDocument } from '../linear/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { readBlobs, readUploads } from '../state/index.ts';
import { type InitialSyncPlan, type PlaceDocuments, type PlanInput, annotatedPlaces, leaveOutAtWrite, planInitialSync } from './plan.ts';
import { predictUploadLeaveOuts } from './uploads.ts';

export interface PlanSources {
  input: PlanInput;
  containers: Map<string, LinearDocument[]>;
  /** Every listed document, by id. */
  documents: Map<string, LinearDocument>;
}

/**
 * Lists all documents for counts, then reads live content in batches for a
 * confirmed run. Bodies of trashed and archived documents are not needed.
 */
export async function readPlanSources(context: RunContext, options: { withContent?: boolean } = {}): Promise<PlanSources> {
  const { git, mapping, linear } = context;
  const files = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, files.map((file) => file.oid));
  const texts = new Map(files.map((file) => [file.path, (blobs.get(file.oid) as Buffer).toString('utf8')]));
  const places: PlaceDocuments[] = [];
  const documents = new Map<string, LinearDocument>();
  const containers = await readContainerDocuments(context);
  if (options.withContent) {
    const liveIds = [...new Set([...containers.values()].flat().filter((document) => !document.trashed && document.archivedAt === null).map((document) => document.id))];
    for (const document of await linear.getDocuments(liveIds, { withContent: true })) documents.set(document.id, document);
  }
  for (const { place } of annotatedPlaces(mapping.zones)) {
    const listed = containers.get(containerKey(context, place)) as LinearDocument[];
    for (const document of listed) if (!documents.has(document.id)) documents.set(document.id, document);
    places.push({ place, documents: listed });
  }
  return { input: { mapping, texts, places, facts: linear.facts }, documents, containers };
}

/**
 * The dry run's plan: what a confirmed run would do, with the container
 * counts it checks before writing and the documents its uploads would leave
 * out already listed as left out. Uploads and downloads nothing.
 *
 * @param options.remote the remote the run reads LFS objects from
 * @param options.cap the document cap of the run's containers
 */
export async function planFromRepository(context: RunContext, options: { remote: string; cap?: number | undefined }): Promise<InitialSyncPlan> {
  const sources = await readPlanSources(context);
  const plan = planInitialSync(sources.input);
  // Counted as the confirmed run counts them: before the uploads leave any document out.
  plan.capacity = assessCapacity(context, sources.containers, plan.create, options.cap);
  const uploads = await readUploads(context.git, context.fetched.state.uploads);
  return leaveOutAtWrite(plan, await predictUploadLeaveOuts(context.git, context.fetched.tracked, plan, sources.input.texts, uploads, { remote: options.remote }));
}
