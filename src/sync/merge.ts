// Step 3 of a sync run: the tracked branch merged into the `linear` tip, in
// git's object store only. Nothing is pushed and no working tree is used.
// The result says, per synchronized path, what Linear must change so that
// it holds the merge result: a write, a rename or move, a create or a trash.

import { lintText, splitFile } from '../format/index.ts';
import { LINEAR_FACTS, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { type MappedDocument, type Place, type RepositoryMapping, loadMapping } from '../mapping/index.ts';
import { type Git, type IdMap, type Oid, listTree, readBlobs } from '../state/index.ts';

/** A synchronized file of one side: its path, blob, Linear title and place. */
export interface SideFile {
  path: string;
  oid: Oid;
  title: string;
  place: Place;
}

/** A document that stays: the same id, perhaps at a new path (a rename or a move across folders). */
export interface KeepChange {
  kind: 'keep';
  id: string;
  /** The path in the `linear` tip. */
  from: string;
  /** The path in the merge result. */
  to: string;
  /** The body changed (front matter does not count). */
  content: boolean;
  /** The title changed. */
  title: boolean;
  /** The project or team changed. */
  place: boolean;
}

export interface CreateChange {
  kind: 'create';
  path: string;
}

export interface TrashChange {
  kind: 'trash';
  id: string;
  path: string;
}

export type DocumentChange = KeepChange | CreateChange | TrashChange;

export interface LocalMerge {
  /** The merge base: the tracked commit `linear` last took in. */
  base: Oid;
  /** The merged tree, with git's own markers in conflicted files. */
  tree: Oid;
  /** Paths git could not merge on its own; neither side's version is written to Linear. */
  conflicts: string[];
  /** Synchronized files of the `linear` tip, by path. */
  linear: Map<string, SideFile>;
  /** Synchronized files of the merge result, by path. */
  result: Map<string, SideFile>;
  /** Files of the merge result the sync leaves out (lint, title, collisions); their documents stay as they are. */
  leftOut: Array<{ path: string; rules: string[] }>;
  /** What Linear must change, in path order; documents that need nothing are absent. */
  changes: DocumentChange[];
  /** Documents whose text, title and place stay; a file they link to may still have changed. */
  unchanged: KeepChange[];
  /**
   * Documents whose file was renamed to one that cannot be written yet (a
   * conflict, or left out by a lint finding): neither renamed nor trashed.
   * The record keeps the tip's file, and the run is not complete.
   */
  held: HeldRename[];
  /** The blobs of every synchronized file of both sides, by id. */
  texts: Map<Oid, Buffer>;
}

export interface HeldRename {
  id: string;
  from: string;
  to: string;
}

/**
 * Merges `tracked` into `linear` with git's merge (renames detected) and
 * compares the result with the `linear` tip. `ids` maps the tip's
 * synchronized paths to documents; a path whose document is unknown is
 * created.
 */
export async function mergeLocally(git: Git, linear: Oid, tracked: Oid, ids: IdMap, facts: LinearFacts = LINEAR_FACTS): Promise<LocalMerge> {
  const base = await git.text(['merge-base', linear, tracked]);
  const merged = await git.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', linear, tracked], { okCodes: [0, 1] });
  const [tree, ...rest] = merged.stdout.toString('utf8').split('\0');
  if (tree === undefined || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree gave no tree');
  const conflicts = [...new Set(rest.filter((path) => path !== ''))].sort(compare);

  const linearSide = await synchronizedFiles(git, linear, facts);
  const resultSide = await synchronizedFiles(git, tree, facts);
  const renames = await renamesBetween(git, base, tracked);
  const conflicted = new Set(conflicts);

  const changes: DocumentChange[] = [];
  const unchanged: KeepChange[] = [];
  const held: HeldRename[] = [];
  const claimed = new Set<string>();
  const blobs = await readBlobs(git, [...linearSide.files.values(), ...resultSide.files.values()].map((file) => file.oid));
  const body = (oid: Oid) => splitFile((blobs.get(oid) as Buffer).toString('utf8')).body;

  for (const [from, entry] of [...ids].sort(([a], [b]) => compare(a, b))) {
    if (conflicted.has(from)) {
      claimed.add(from);
      continue;
    }
    let to: string | undefined;
    if (resultSide.files.has(from)) to = from;
    else {
      const renamed = renames.get(from);
      if (renamed !== undefined && !ids.has(renamed) && !claimed.has(renamed)) {
        if (resultSide.files.has(renamed) && !conflicted.has(renamed)) to = renamed;
        else if (conflicted.has(renamed) || resultSide.leftOutPaths.has(renamed)) {
          // Renamed to a file that cannot be written yet: the document waits where it is.
          claimed.add(renamed);
          held.push({ id: entry.id, from, to: renamed });
          continue;
        }
      }
    }
    if (to === undefined) {
      // A file the merge result keeps but the sync leaves out: its document stays as it was.
      if (resultSide.leftOutPaths.has(from)) continue;
      changes.push({ kind: 'trash', id: entry.id, path: from });
      continue;
    }
    claimed.add(to);
    const next = resultSide.files.get(to) as SideFile;
    const previous = linearSide.files.get(from);
    const change: KeepChange = {
      kind: 'keep',
      id: entry.id,
      from,
      to,
      content: previous === undefined || body(previous.oid) !== body(next.oid),
      title: previous === undefined || previous.title.normalize('NFC') !== next.title.normalize('NFC'),
      place: previous === undefined || placeKey(previous.place) !== placeKey(next.place),
    };
    if (change.content || change.title || change.place) changes.push(change);
    else unchanged.push(change);
  }
  for (const path of resultSide.files.keys()) {
    if (!claimed.has(path) && !conflicted.has(path)) changes.push({ kind: 'create', path });
  }
  changes.sort((a, b) => compare(changePath(a), changePath(b)));

  return {
    base,
    tree,
    conflicts,
    linear: linearSide.files,
    result: resultSide.files,
    leftOut: resultSide.leftOut,
    changes,
    unchanged: unchanged.sort((a, b) => compare(a.to, b.to)),
    held,
    texts: blobs,
  };
}

/** The path a change is listed under: where the document's file is after the run, or was before a trash. */
export function changePath(change: DocumentChange): string {
  return change.kind === 'keep' ? change.to : change.path;
}

export function placeKey(place: Place): string {
  return place.kind === 'project' ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
}

interface Side {
  mapping: RepositoryMapping;
  files: Map<string, SideFile>;
  leftOut: Array<{ path: string; rules: string[] }>;
  leftOutPaths: Set<string>;
}

/**
 * The files of a commit or tree that are synchronized: mapped, and neither
 * reported by the linter, nor with a title Linear refuses, nor colliding.
 * The same rules as the initial sync's plan.
 */
async function synchronizedFiles(git: Git, treeish: Oid, facts: LinearFacts): Promise<Side> {
  const mapping = await loadMapping(git, treeish);
  const blobs = await readBlobs(git, mapping.documents.map((document) => document.oid));
  const files = new Map<string, SideFile>();
  const leftOut: Array<{ path: string; rules: string[] }> = [];
  const leave = (path: string, rules: string[]) => leftOut.push({ path, rules: [...new Set(rules)].sort() });
  for (const document of mapping.documents) {
    const rules: string[] = lintText(document.path, (blobs.get(document.oid) as Buffer).toString('utf8')).map((finding) => finding.rule);
    if (lengthRefusal({ title: document.title }, facts) !== undefined) rules.push('title-too-long');
    if (rules.length > 0) leave(document.path, rules);
    else files.set(document.path, toSideFile(document));
  }
  for (const file of mapping.leftOut) leave(file.path, [file.rule]);
  for (const file of mapping.unsynced) if (file.place !== undefined) leave(file.path, [file.reason]);
  leftOut.sort((a, b) => compare(a.path, b.path));
  return { mapping, files, leftOut, leftOutPaths: new Set(leftOut.map((entry) => entry.path)) };
}

/** Versions of the `linear` chain examined for a file's last synchronized version. */
export const BASELINE_DEPTH = 20;

/**
 * The newest commit of the `linear` chain, walking its own commits only
 * (first parents: records and captures, never the tracked branch's), in
 * which a file was synchronized by the run's own rules (mapped, accepted by
 * the linter, a title Linear takes, no collision). That version is what
 * Linear was last given, with its title, place and linked files. Null when
 * none of the last `BASELINE_DEPTH` versions on the chain was synchronized.
 */
export async function lastSynchronized(git: Git, linear: Oid, path: string, facts: LinearFacts = LINEAR_FACTS): Promise<{ commit: Oid; file: SideFile; text: string } | null> {
  const log = await git.text(['log', '--first-parent', '--format=%H', '-n', String(BASELINE_DEPTH), linear, '--', path]);
  for (const commit of log.split('\n').filter(Boolean)) {
    const file = (await synchronizedFiles(git, commit, facts)).files.get(path);
    if (file !== undefined) return { commit, file, text: ((await readBlobs(git, [file.oid])).get(file.oid) as Buffer).toString('utf8') };
  }
  return null;
}

function toSideFile(document: MappedDocument): SideFile {
  return { path: document.path, oid: document.oid, title: document.title, place: document.place };
}

/** Renames git detects between two commits: old path → new path. */
async function renamesBetween(git: Git, from: Oid, to: Oid): Promise<Map<string, string>> {
  const { stdout } = await git.run(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--diff-filter=R', '--name-status', '-z', from, to]);
  const parts = stdout.toString('utf8').split('\0');
  const renames = new Map<string, string>();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const [status, old, renamed] = [parts[index], parts[index + 1], parts[index + 2]];
    if (status?.startsWith('R') && old !== undefined && renamed !== undefined) renames.set(old, renamed);
  }
  return renames;
}

/** Whether the tracked commit is already merged into `linear`, so there is nothing to take to Linear. */
export async function alreadyMerged(git: Git, linear: Oid, tracked: Oid): Promise<boolean> {
  return (await git.run(['merge-base', '--is-ancestor', tracked, linear], { okCodes: [0, 1] })).code === 0;
}

/** Lists a tree's files by path. */
export async function filesOf(git: Git, treeish: Oid): Promise<Map<string, Oid>> {
  return new Map((await listTree(git, treeish)).map((entry) => [entry.path, entry.oid]));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
