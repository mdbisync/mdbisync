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
import { INITIAL_RECORD_SUBJECTS } from '../initial-sync/index.ts';
import { placeId } from '../initial-sync/plan.ts';
import { type ResolvedTargets } from '../setup/index.ts';
import { resolveTargets } from '../setup/linear.ts';
import { type Git, type IdMap, type Oid, isAncestor } from '../state/index.ts';
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
  /** The record's Markdown files that are not documents: a title another file has, or outside annotated folders. */
  unmapped: readonly string[];
}

export async function rebuildIds({ git, record, linear, facts, targets, documents, files: treeFiles, unmapped }: RebuildInput): Promise<IdMap> {
  const keyOf = (place: DocumentPlace, title: string) =>
    `${'projectId' in place ? `project:${place.projectId}` : `team:${place.teamId}`}\0${title.normalize('NFC')}`;
  const files = new Map<string, string>();
  const places = new Map<string, DocumentPlace>();
  /** Files by place, for the paths capture gives: folder and path. */
  const byPlace = new Map<string, Array<{ folder: string; path: string }>>();
  // A synchronized file comes first: a left-out file's last title does not take its document.
  const add = (path: string, title: string, place: DocumentPlace) => {
    if (files.has(keyOf(place, title))) return;
    places.set(JSON.stringify(place), place);
    files.set(keyOf(place, title), path);
    const folder = path.slice(0, -(title.length + '.md'.length)).replace(/\/$/, '');
    byPlace.set(JSON.stringify(place), [...(byPlace.get(JSON.stringify(place)) ?? []), { folder, path }]);
  };
  // A file left out now gets the document of its last synchronized version, with the title and place Linear was given
  // then. Several such files walk the same commits of the chain: each commit is read once.
  let initial: Promise<Oid | undefined> | undefined;
  const sides = new Map<Oid, Promise<Side>>();
  const leftOut: string[] = [...unmapped];
  for (const document of documents) {
    if (lintInTree(document.path, document.text, treeFiles).length > 0 || lengthRefusal({ title: document.title }, facts) !== undefined) {
      leftOut.push(document.path);
      continue;
    }
    let place: DocumentPlace;
    try {
      place = placeId(targets, document.place);
    } catch {
      continue;
    }
    add(document.path, document.title, place);
  }
  for (const path of leftOut) {
    initial ??= latestInitialRecord(git, record);
    const oldest = await lifetimeStart(git, record, path, await initial);
    const last = oldest === undefined ? null : await lastSynchronized(git, record, path, facts, sides, oldest);
    if (last === null) continue;
    const place = await lastPlace(linear, targets, last.file.place);
    if (place !== undefined) add(path, last.file.title, place);
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
  const log = await git.text(['log', '--first-parent', '--format=%H %s', '--fixed-strings', ...[...INITIAL_RECORD_SUBJECTS].map((subject) => `--grep=${subject}`), record]);
  for (const line of log.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && INITIAL_RECORD_SUBJECTS.has(line.slice(space + 1))) return line.slice(0, space);
  }
  return undefined;
}

/**
 * The oldest commit on the `linear` chain where the file at `path` is the
 * one it is now: the latest initial record, or the commit that added it
 * again after that. A file removed in between had a document of its own,
 * which its removal trashed; the new file at its path never had it.
 */
async function lifetimeStart(git: Git, record: Oid, path: string, initial: Oid | undefined): Promise<Oid | undefined> {
  if (initial === undefined) return undefined;
  const added = (await git.text(['--literal-pathspecs', 'log', '--first-parent', '--diff-filter=A', '--format=%H', '-1', record, '--', path])).trim();
  return added !== '' && added !== initial && await isAncestor(git, initial, added) ? added : initial;
}

/**
 * The place a left-out file's last synchronized version had. An annotation
 * changed since names another place than the record's zones: it is looked
 * up, as capture does for that file's document.
 */
async function lastPlace(linear: LinearClient, targets: ResolvedTargets, place: Place): Promise<DocumentPlace | undefined> {
  try {
    return placeId(targets, place);
  } catch {
    const lookup = await resolveTargets(linear, [{ team: place.team, teamFolder: '', ...(place.kind === 'project' ? { project: place.project, projectFolder: '' } : {}) }]);
    return lookup.targets === undefined ? undefined : placeId(lookup.targets, place);
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
