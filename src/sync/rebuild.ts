// A lost `ids` ref, rebuilt by matching titles to paths: each synchronized
// file of the `linear` record gets the live document whose title is that
// file's title in the file's place. When several live documents share the
// title, the oldest is the match, as in initial sync. A file with no such
// document stays unmapped; a document with no file is captured as new.
// What the map alone held is lost: renames made in Linear since the last
// run (the document comes back under its new title as a new file), the
// ids reserved for documents not created yet, and a marked document's own
// icon and color.

import { type DocumentPlace, type LinearClient } from '../linear/index.ts';
import { type MappedDocument } from '../mapping/index.ts';
import { placeId } from '../initial-sync/plan.ts';
import { type ResolvedTargets } from '../setup/index.ts';
import { type IdMap } from '../state/index.ts';

export async function rebuildIds(linear: LinearClient, targets: ResolvedTargets, documents: readonly MappedDocument[]): Promise<IdMap> {
  const keyOf = (place: DocumentPlace, title: string) =>
    `${'projectId' in place ? `project:${place.projectId}` : `team:${place.teamId}`}\0${title.normalize('NFC')}`;
  const files = new Map<string, string>();
  const places = new Map<string, DocumentPlace>();
  for (const document of documents) {
    let place: DocumentPlace;
    try {
      place = placeId(targets, document.place);
    } catch {
      continue;
    }
    places.set(JSON.stringify(place), place);
    files.set(keyOf(place, document.title), document.path);
  }

  const ids: IdMap = new Map();
  const listed = await linear.listDocumentsInPlaces([...places.values()]);
  const oldestFirst = listed
    .filter((document) => !document.trashed && document.archivedAt === null)
    .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
  for (const document of oldestFirst) {
    if (document.projectId === null && document.teamId === null) continue;
    const place: DocumentPlace = document.projectId !== null ? { projectId: document.projectId } : { teamId: document.teamId as string };
    const path = files.get(keyOf(place, document.title));
    if (path !== undefined && !ids.has(path)) ids.set(path, { id: document.id });
  }
  return ids;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
