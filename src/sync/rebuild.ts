// A lost `ids` ref, rebuilt by matching titles to paths: each synchronized
// file of the `linear` record gets the document whose title is that file's
// title in the file's place. Live documents come first, the oldest of them
// as in initial sync; a trashed or archived document is matched only when
// no live one has the title, so capture records its removal instead of the
// write step creating it again. A file the sync leaves out now (lint
// findings, a title Linear refuses) keeps the document it had, as an ongoing
// run keeps it untouched: it is matched by the title and place of its last
// synchronized version since the latest initial sync. One left out ever since
// was never mapped, and stays git-only. A file capture named (an encoded
// title, a collision suffix) is matched by the path capture gives that
// document, as the write step checks it. A file with no such document stays
// unmapped; a document with no file is captured as new.
// What the map alone held is lost: renames made in Linear since the last
// run (the document comes back under its new title as a new file), the ids
// reserved for documents not created yet, and a marked document's own icon
// and color.

import { lintInTree } from '../format/index.ts';
import { type DocumentPlace, type LinearClient, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { type MappedDocument, type Place } from '../mapping/index.ts';
import { RECORD_MESSAGE } from '../initial-sync/index.ts';
import { placeId } from '../initial-sync/plan.ts';
import { type ResolvedTargets } from '../setup/index.ts';
import { type Git, type IdMap, type Oid, INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { type Side, lastSynchronized } from './merge.ts';
import { documentPath } from './paths.ts';

export interface RebuildInput {
  git: Git;
  /** The `linear` record the documents are read from. */
  record: Oid;
  linear: LinearClient;
  facts: LinearFacts;
  targets: ResolvedTargets;
  /** The synchronized files of the `linear` record, with their text. */
  documents: ReadonlyArray<MappedDocument & { text: string }>;
  /** The regular files of the `linear` record's tree, which images must name (`RepositoryMapping.files`). */
  files: ReadonlySet<string>;
}

export async function rebuildIds({ git, record, linear, facts, targets, documents, files: treeFiles }: RebuildInput): Promise<IdMap> {
  const keyOf = (place: DocumentPlace, title: string) =>
    `${'projectId' in place ? `project:${place.projectId}` : `team:${place.teamId}`}\0${title.normalize('NFC')}`;
  const files = new Map<string, string>();
  const places = new Map<string, DocumentPlace>();
  /** Files by place, for the paths capture gives: folder and path. */
  const byPlace = new Map<string, Array<{ folder: string; path: string }>>();
  const initial = await latestInitialRecord(git, record);
  const sides = new Map<Oid, Promise<Side>>();
  for (const document of documents) {
    // The title and place Linear was last given for the file.
    let synchronized: { title: string; place: Place } = document;
    if (lintInTree(document.path, document.text, treeFiles).length > 0 || lengthRefusal({ title: document.title }, facts) !== undefined) {
      const last = initial === undefined ? null : await lastSynchronized(git, record, document.path, facts, sides, initial);
      if (last === null) continue;
      synchronized = last.file;
    }
    const { title } = synchronized;
    let place: DocumentPlace;
    try {
      place = placeId(targets, synchronized.place);
    } catch {
      continue;
    }
    places.set(JSON.stringify(place), place);
    files.set(keyOf(place, title), document.path);
    const folder = document.path.slice(0, -(title.length + '.md'.length)).replace(/\/$/, '');
    byPlace.set(JSON.stringify(place), [...(byPlace.get(JSON.stringify(place)) ?? []), { folder, path: document.path }]);
  }
  const allPaths = new Set(documents.map((document) => document.path));

  const ids: IdMap = new Map();
  const listed = await linear.listDocumentsInPlaces([...places.values()], { includeArchived: true });
  const gone = (document: (typeof listed)[number]) => document.trashed || document.archivedAt !== null;
  const order = listed.sort((a, b) => Number(gone(a)) - Number(gone(b)) || compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
  const unmatched: Array<{ document: (typeof listed)[number]; place: DocumentPlace }> = [];
  for (const document of order) {
    if (document.projectId === null && document.teamId === null) continue;
    const place: DocumentPlace = document.projectId !== null ? { projectId: document.projectId } : { teamId: document.teamId as string };
    const path = files.get(keyOf(place, document.title));
    if (path !== undefined && !ids.has(path)) ids.set(path, { id: document.id });
    else unmatched.push({ document, place });
  }
  // Only what plain titles left over: a document and a file of its place whose path is the one capture gives it.
  const leftFiles = new Map([...byPlace].map(([place, list]) => [place, list.filter(({ path }) => !ids.has(path))]));
  const taken = new Set([...ids.values()].map((entry) => entry.id));
  for (const { document, place } of unmatched) {
    const candidates = leftFiles.get(JSON.stringify(place)) ?? [];
    if (taken.has(document.id) || candidates.length === 0) continue;
    const index = candidates.findIndex(({ folder, path }) => documentPath(folder, document.title, document.id, new Set([...allPaths].filter((other) => other !== path)), path) === path);
    if (index < 0) continue;
    ids.set((candidates[index] as { path: string }).path, { id: document.id });
    taken.add(document.id);
    candidates.splice(index, 1);
  }
  return ids;
}

/**
 * The newest initial sync record on the `linear` chain (first parents). The
 * chain goes on into the tracked branch's history before it, where a file
 * was never synchronized.
 */
async function latestInitialRecord(git: Git, record: Oid): Promise<Oid | undefined> {
  const subjects = new Set([RECORD_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD]);
  const log = await git.text(['log', '--first-parent', '--format=%H %s', '--fixed-strings', ...[...subjects].map((subject) => `--grep=${subject}`), record]);
  for (const line of log.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && subjects.has(line.slice(space + 1))) return line.slice(0, space);
  }
  return undefined;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
