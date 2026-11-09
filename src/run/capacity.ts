// Capacity is based on all documents Linear returns, including its trash.
import { type LinearDocument } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { placeLabel } from '../initial-sync/summary.ts';
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
  return JSON.stringify(placeId(context.targets, place));
}

export async function readContainerDocuments(context: RunContext): Promise<Map<string, LinearDocument[]>> {
  const documents = new Map<string, LinearDocument[]>();
  for (const { place } of annotatedPlaces(context.mapping.zones)) {
    const key = containerKey(context, place);
    if (!documents.has(key)) documents.set(key, await context.linear.listDocuments(placeId(context.targets, place), { includeArchived: true }));
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
  const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [
    '### Container document capacity', '',
    capacityBlocked(capacity) ? 'Stopped before any write: a container would exceed its document cap.' : 'Warning: a container is within 10% of its document cap. The run may proceed.', '',
    'Counts include trashed and archived documents returned by Linear with `includeArchived: true`. Moving a document to trash does not free capacity.', '',
    '| Container | Live | Trashed | Archived | Planned additions | Total | Cap | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...reported.map((c) => `| ${cell(placeLabel(c.place))} | ${c.live} | ${c.trashed} | ${c.archived} | ${c.planned} | ${c.total} | ${c.cap} | ${c.status} |`), '',
  ].join('\n');
}
