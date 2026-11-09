// A lost `ids` ref, rebuilt by matching titles to paths: each synchronized
// file of the `linear` record gets the document whose title is that file's
// title in the file's place. Live documents come first, the oldest of them
// as in initial sync; a trashed or archived document is matched only when
// no live one has the title, so capture records its removal instead of the
// write step creating it again. Files the sync leaves out (lint findings, a
// title Linear refuses) stay git-only and are not matched. A file with no
// such document stays unmapped; a document with no file is captured as new.
// What the map alone held is lost: renames made in Linear since the last
// run (the document comes back under its new title as a new file), the ids
// reserved for documents not created yet, and a marked document's own icon
// and color.

import { lintText } from '../format/index.ts';
import { type DocumentPlace, type LinearClient, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { type MappedDocument } from '../mapping/index.ts';
import { placeId } from '../initial-sync/plan.ts';
import { type ResolvedTargets } from '../setup/index.ts';
import { type IdMap } from '../state/index.ts';

export interface RebuildInput {
  linear: LinearClient;
  facts: LinearFacts;
  targets: ResolvedTargets;
  /** The synchronized files of the `linear` record, with their text. */
  documents: ReadonlyArray<MappedDocument & { text: string }>;
}

export async function rebuildIds({ linear, facts, targets, documents }: RebuildInput): Promise<IdMap> {
  const keyOf = (place: DocumentPlace, title: string) =>
    `${'projectId' in place ? `project:${place.projectId}` : `team:${place.teamId}`}\0${title.normalize('NFC')}`;
  const files = new Map<string, string>();
  const places = new Map<string, DocumentPlace>();
  for (const document of documents) {
    if (lintText(document.path, document.text).length > 0 || lengthRefusal({ title: document.title }, facts) !== undefined) continue;
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
  const listed = await linear.listDocumentsInPlaces([...places.values()], { includeArchived: true });
  const gone = (document: (typeof listed)[number]) => document.trashed || document.archivedAt !== null;
  const order = listed.sort((a, b) => Number(gone(a)) - Number(gone(b)) || compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
  for (const document of order) {
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
