// Capacity is based on all documents Linear returns, including its trash.
import { type LinearDocument } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { cell, placeLabel } from './summary.ts';
import { type RunContext } from './preflight.ts';

export const DEFAULT_DOCUMENT_CAP = 1000;

export interface ContainerCapacity {
  place: Place;
  live: number;
  trashed: number;
  archived: number;
  planned: number;
  total: number;
  cap: number;
  status: 'ok' | 'warning' | 'over-cap';
}

export function containerKey(context: RunContext, place: Place): string {
  return documentPlaceKey(placeId(context.targets, place));
}

/** The key of a container by its Linear ids; `containerKey` of the place it resolves from. */
function documentPlaceKey(place: { projectId: string } | { teamId: string }): string {
  return JSON.stringify('projectId' in place ? { projectId: place.projectId } : { teamId: place.teamId });
}

/** Every annotated container's documents, trash included, listed together (one request per page). */
export async function readContainerDocuments(context: RunContext): Promise<Map<string, LinearDocument[]>> {
  const places = [...new Map(annotatedPlaces(context.mapping.zones).map(({ place }) => [containerKey(context, place), placeId(context.targets, place)])).values()];
  return containersOf(context, await context.linear.listDocumentsInPlaces(places, { includeArchived: true }));
}

/**
 * Groups a listing of the annotated containers by container. Every
 * container gets an entry, empty when it listed nothing; a document of no
 * annotated container is left out.
 */
export function containersOf(context: RunContext, listed: readonly LinearDocument[]): Map<string, LinearDocument[]> {
  const documents = new Map<string, LinearDocument[]>();
  for (const { place } of annotatedPlaces(context.mapping.zones)) documents.set(containerKey(context, place), []);
  for (const document of listed) {
    const place = document.projectId !== null ? { projectId: document.projectId } : document.teamId !== null ? { teamId: document.teamId } : undefined;
    if (place !== undefined) documents.get(documentPlaceKey(place))?.push(document);
  }
  return documents;
}

export function assessCapacity(
  context: RunContext,
  documents: ReadonlyMap<string, readonly LinearDocument[]>,
  creates: readonly { place: Place }[],
  cap = DEFAULT_DOCUMENT_CAP,
): ContainerCapacity[] {
  const planned = new Map<string, number>();
  for (const { place } of creates) {
    const key = containerKey(context, place);
    planned.set(key, (planned.get(key) ?? 0) + 1);
  }
  const result = new Map<string, ContainerCapacity>();
  for (const { place } of annotatedPlaces(context.mapping.zones)) {
    const key = containerKey(context, place);
    if (result.has(key)) continue;
    const listed = documents.get(key);
    if (listed === undefined) throw new Error('container documents were not read');
    const unique = [...new Map(listed.map((document) => [document.id, document])).values()];
    const trashed = unique.filter((document) => document.trashed).length;
    const archived = unique.filter((document) => !document.trashed && document.archivedAt !== null).length;
    const count = planned.get(key) ?? 0;
    const total = unique.length + count;
    result.set(key, { place, live: unique.length - trashed - archived, trashed, archived, planned: count, total, cap,
      status: total > cap ? 'over-cap' : total >= cap * 0.9 ? 'warning' : 'ok' });
  }
  return [...result.values()];
}

export function capacityBlocked(capacity: readonly ContainerCapacity[]): boolean {
  return capacity.some((container) => container.status === 'over-cap');
}

export function renderCapacity(capacity: readonly ContainerCapacity[]): string {
  const reported = capacity.filter((container) => container.status !== 'ok');
  if (reported.length === 0) return '';
  return [
    '### Container document capacity', '',
    capacityBlocked(capacity) ? 'Stopped before any write: a container would exceed its document cap.' : 'Warning: a container is within 10% of its document cap. The run may proceed.', '',
    'Counts include trashed and archived documents returned by Linear with `includeArchived: true`. Moving a document to trash does not free capacity.', '',
    '| Container | Live | Trashed | Archived | Planned additions | Total | Cap | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...reported.map((c) => `| ${cell(placeLabel(c.place))} | ${c.live} | ${c.trashed} | ${c.archived} | ${c.planned} | ${c.total} | ${c.cap} | ${c.status} |`), '',
  ].join('\n');
}
