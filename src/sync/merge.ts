// Step 3 of a sync run: the tracked branch merged into the `linear` tip, in
// git's object store only. Nothing is pushed and no working tree is used.
// The result says, per synchronized path, what Linear must change so that
// it holds the merge result: a write, a rename or move, a create or a trash.

import { readAnnotation } from '../mapping/index.ts';
import { lintText, splitFile } from '../format/index.ts';
import { LINEAR_FACTS, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { type MappedDocument, type Place, type RepositoryMapping, loadMapping } from '../mapping/index.ts';
import { type StructuralResult, type StructuralSummary, type Version, resolveStructural } from '../merge/index.ts';
import { type Git, type IdMap, type Oid, INITIAL_SYNC_FROM_LINEAR_RECORD, buildTree, isAncestor, listTree, readBlobs } from '../state/index.ts';

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
  /** A neutral comment for the document once it is written (its Linear title was set back). */
  comment?: string;
}

export interface CreateChange {
  kind: 'create';
  path: string;
  /**
   * The document Linear removed while git changed its file: it is
   * restored with this id, so its comments stay, or created anew when Linear
   * no longer has it.
   */
  restore?: {
    id: string;
    /** The summary entry when Linear no longer has the document. */
    gone: StructuralSummary;
    /** Set when Linear no longer has it: the id the new document gets. */
    recreate?: string;
  };
}

/** A case the structural conflict rules decided, for the run summary. */
export interface Decided {
  path: string;
  summary: StructuralSummary;
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
  /**
   * The merged tree. Documents git could not merge hold the sync's conflict
   * marker paragraphs, and delete or rename conflicts are decided by the
   * structural rules.
   */
  tree: Oid;
  /** Paths that could not be merged even so (files that are not mapped documents); neither side's version is written to Linear. */
  conflicts: string[];
  /** Documents of the merge result whose text holds conflict markers this merge wrote. */
  marked: string[];
  /** Cases the structural rules decided. */
  decided: Decided[];
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
export async function mergeLocally(git: Git, linear: Oid, tracked: Oid, ids: IdMap, facts: LinearFacts = LINEAR_FACTS, options: MergeOptions = {}): Promise<LocalMerge> {
  const base = await git.text(['merge-base', linear, tracked]);
  const merged = await git.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', linear, tracked], { okCodes: [0, 1] });
  const [gitTree, ...rest] = merged.stdout.toString('utf8').split('\0');
  if (gitTree === undefined || !/^[0-9a-f]{40,64}$/.test(gitTree)) throw new Error('git merge-tree gave no tree');
  const unmerged = [...new Set(rest.filter((path) => path !== ''))].sort(compare);
  const renames = await renamesBetween(git, base, tracked);
  const resolved = await resolveConflicts(git, { base, linear, tracked, tree: gitTree, unmerged, renames, ids, knownId: options.knownId });
  const { tree, unresolved: conflicts } = resolved;

  const linearSide = await synchronizedFiles(git, linear, facts);
  const resultSide = await synchronizedFiles(git, tree, facts);
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
    const decidedPath = resolved.moves.get(from);
    if (decidedPath !== undefined && resultSide.files.has(decidedPath) && !ids.has(decidedPath)) to = decidedPath;
    else if (resultSide.files.has(from)) to = from;
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
    const comment = resolved.comments.get(from);
    if (comment !== undefined && (change.title || change.place)) change.comment = comment;
    if (change.content || change.title || change.place) changes.push(change);
    else unchanged.push(change);
  }
  for (const path of resultSide.files.keys()) {
    if (!claimed.has(path) && !conflicted.has(path)) {
      const file = resultSide.files.get(path)!;
      const previous = linearSide.files.get(path);
      // A folder's annotation that the `linear` tip already holds without a document is repository
      // configuration, not a request to create one: the annotation-only carrier capture keeps after its
      // document leaves, and the README an initial sync from Linear keeps, body included, because Linear
      // has no document for it. Only a change to its body on the tracked branch makes it a new document.
      // A README with a body counts only when the latest initial sync named it as kept: one left out on the
      // way to Linear, or one whose id map was lost, is created as every other file without a document is.
      const unchanged = previous !== undefined && body(previous.oid) === body(file.oid);
      const kept = unchanged && (body(file.oid) === '' || options.keptAnnotations?.has(path) === true);
      if ((path === 'README.md' || path.endsWith('/README.md')) && kept) {
        const annotation = readAnnotation(path, (blobs.get(file.oid) as Buffer).toString('utf8'));
        if ('annotation' in annotation && annotation.annotation !== null) continue;
      }
      const restore = resolved.restores.get(path);
      changes.push(restore === undefined ? { kind: 'create', path } : { kind: 'create', path, restore });
    }
  }
  changes.sort((a, b) => compare(changePath(a), changePath(b)));

  return {
    base,
    tree,
    conflicts,
    marked: resolved.marked.filter((path) => resultSide.files.has(path)).sort(compare),
    decided: resolved.decided,
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

/**
 * The files of a commit or tree the sync leaves out, with their rules: the
 * list a merge gives for its result, for a run that has nothing to merge.
 */
export async function leftOutFiles(git: Git, treeish: Oid, facts: LinearFacts = LINEAR_FACTS): Promise<Array<{ path: string; rules: string[] }>> {
  return (await synchronizedFiles(git, treeish, facts)).leftOut;
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

export interface MergeOptions {
  /**
   * The id a path's document last had in `refs/mdbisync/ids`, also after
   * Linear removed it; undefined when the path never had one. Finds a
   * document Linear renamed or removed since the merge base.
   */
  knownId?: ((path: string) => Promise<string | undefined>) | undefined;
  /** The folder READMEs the latest initial sync kept, body included, without a document. */
  keptAnnotations?: ReadonlySet<string> | undefined;
}

interface ConflictInput {
  base: Oid;
  linear: Oid;
  tracked: Oid;
  /** git's merge result, with its own markers in the unmerged files. */
  tree: Oid;
  /** Paths git could not merge. */
  unmerged: string[];
  /** git's renames between the merge base and the tracked branch. */
  renames: Map<string, string>;
  ids: IdMap;
  knownId?: MergeOptions['knownId'];
}

interface Resolved {
  tree: Oid;
  unresolved: string[];
  /** A document's path on the `linear` tip → its path in the result, where the rules moved it. */
  moves: Map<string, string>;
  /** A document's path on the `linear` tip → the comment it gets once written. */
  comments: Map<string, string>;
  /** A result path → the document Linear removed, to restore there. */
  restores: Map<string, { id: string; gone: StructuralSummary }>;
  marked: string[];
  decided: Decided[];
}

/**
 * Step 3's own merge of the documents git could not merge: per document,
 * the base, tracked and Linear versions go to the structural rules, which
 * merge the text with the conflict marker paragraphs and decide deletes
 * and renames. The result replaces git's conflicted files in the tree.
 * Files that are not mapped documents stay unresolved.
 */
async function resolveConflicts(git: Git, input: ConflictInput): Promise<Resolved> {
  const out: Resolved = { tree: input.tree, unresolved: [], moves: new Map(), comments: new Map(), restores: new Map(), marked: [], decided: [] };
  if (input.unmerged.length === 0) return out;
  const [baseFiles, gitFiles, linearFiles] = await Promise.all([filesOf(git, input.base), filesOf(git, input.tracked), filesOf(git, input.linear)]);
  // Only documents the sync maps get marker paragraphs; other files (unmapped Markdown, images) stay unresolved.
  const mapped = new Set<string>();
  for (const side of [input.base, input.tracked, input.linear]) for (const document of (await loadMapping(git, side)).documents) mapped.add(document.path);
  const linearRenames = await renamesBetween(git, input.base, input.linear);
  const pathById = new Map([...input.ids].map(([path, entry]) => [entry.id, path]));
  const knownId = async (path: string) => input.knownId?.(path);

  const basePathOf = (path: string): string | null => {
    if (baseFiles.has(path)) return path;
    for (const [from, to] of [...input.renames, ...linearRenames]) if (to === path && baseFiles.has(from)) return from;
    return null;
  };
  // Linear's side is found by the document's id first: a title change in
  // Linear moves the file, and a heavy edit hides that move from git.
  const linearPathOf = async (basePath: string): Promise<string | null> => {
    const id = await knownId(basePath);
    const byId = id === undefined ? undefined : pathById.get(id);
    if (byId !== undefined && linearFiles.has(byId)) return byId;
    const renamed = linearRenames.get(basePath);
    if (renamed !== undefined && linearFiles.has(renamed)) return renamed;
    if (!linearFiles.has(basePath)) return null;
    // Capture keeps a folder's annotation in its README after Linear removes the document: an annotation-only
    // carrier whose document has no id any more is a removed document, not Linear's version of it.
    if (id !== undefined && byId === undefined && (await annotationOnly(basePath))) {
      removedCarriers.add(basePath);
      return null;
    }
    return basePath;
  };
  /** Annotation-only carriers left on the `linear` tip by documents Linear removed. */
  const removedCarriers = new Set<string>();
  const annotationOnly = async (path: string): Promise<boolean> => {
    if (path !== 'README.md' && !path.endsWith('/README.md')) return false;
    const text = ((await readBlobs(git, [linearFiles.get(path) as Oid])).get(linearFiles.get(path) as Oid) as Buffer).toString('utf8');
    if (splitFile(text).body.trim() !== '') return false;
    const annotation = readAnnotation(path, text);
    return 'annotation' in annotation && annotation.annotation !== null;
  };

  const groups: Array<{ basePath: string | null; gitPath: string | null; linearPath: string | null; involved: string[] }> = [];
  const seen = new Set<string>();
  for (const path of input.unmerged) {
    if (seen.has(path)) continue;
    const basePath = basePathOf(path);
    const gitPath = basePath === null ? (gitFiles.has(path) ? path : null) : (input.renames.get(basePath) ?? (gitFiles.has(basePath) ? basePath : null));
    const linearPath = basePath === null ? (linearFiles.has(path) ? path : null) : await linearPathOf(basePath);
    const involved = [...new Set([path, basePath, gitPath, linearPath].filter((entry): entry is string => entry !== null))];
    for (const entry of involved) seen.add(entry);
    // A path of the group that one side holds for another document (git renamed onto a file Linear added) is a
    // collision of two documents: merging them would lose one, so it stays unresolved.
    const collides = involved.some((entry) => (linearFiles.has(entry) && entry !== linearPath && !removedCarriers.has(entry)) || (gitFiles.has(entry) && entry !== gitPath));
    if (!collides && involved.every((entry) => mapped.has(entry) || !input.unmerged.includes(entry))) groups.push({ basePath, gitPath, linearPath, involved });
    // Every path of the group waits, so neither document is trashed or overwritten until a person sorts it out.
    else out.unresolved.push(...involved);
  }

  const blobs = await readBlobs(git, groups.flatMap(({ basePath, gitPath, linearPath }) => [
    ...(basePath === null ? [] : [baseFiles.get(basePath) as Oid]),
    ...(gitPath === null ? [] : [gitFiles.get(gitPath) as Oid]),
    ...(linearPath === null ? [] : [linearFiles.get(linearPath) as Oid]),
  ]));
  const version = (files: Map<string, Oid>, path: string | null): Version | null =>
    path === null ? null : { path, text: (blobs.get(files.get(path) as Oid) as Buffer).toString('utf8') };

  const changes = new Map<string, string | null>();
  for (const { basePath, gitPath, linearPath, involved } of groups) {
    const versions = {
      // Both sides added the path: an empty base, so the whole text is merged.
      base: version(baseFiles, basePath) ?? { path: involved[0] as string, text: '' },
      git: version(gitFiles, gitPath),
      linear: version(linearFiles, linearPath),
    };
    const result: StructuralResult = await resolveStructural(versions);
    for (const path of involved) changes.set(path, null);
    if (result.path !== null && result.text !== null) changes.set(result.path, result.text);
    if (linearPath !== null && result.path !== null && result.path !== linearPath) out.moves.set(linearPath, result.path);
    if (linearPath !== null && result.linear.comment !== undefined) out.comments.set(linearPath, result.linear.comment);
    let summary = result.summary;
    if (result.kind === 'linear-deleted-git-changed' && result.path !== null) {
      const gone = (await resolveStructural({ ...versions, linearGone: true })).summary as StructuralSummary;
      const id = basePath === null ? undefined : await knownId(basePath);
      if (id !== undefined) out.restores.set(result.path, { id, gone });
      else summary = gone;
    }
    if (result.path !== null && result.conflicts.length > 0) out.marked.push(result.path);
    if (summary !== null) out.decided.push({ path: result.path ?? basePath ?? (involved[0] as string), summary });
  }
  out.tree = await buildTree(git, input.tree, changes);
  out.unresolved.sort(compare);
  return out;
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

/**
 * Whether the tracked branch is an initial sync from Linear taken in as it
 * is: `linear` is that record, and the tracked branch descends from it and
 * holds the same tree, as after a person merges its pull request and changes
 * nothing else. Recording that merge would only move the merge base, with
 * nothing to write; the record stays the merge base of the next change.
 */
export async function mergedInitialRecord(git: Git, linear: Oid, tracked: Oid): Promise<boolean> {
  const [subject] = (await git.text(['show', '-s', '--format=%s', linear])).split('\n');
  if (subject !== INITIAL_SYNC_FROM_LINEAR_RECORD) return false;
  if (!(await isAncestor(git, linear, tracked))) return false;
  const [linearTree, trackedTree] = (await git.text(['rev-parse', `${linear}^{tree}`, `${tracked}^{tree}`])).split('\n');
  return linearTree === trackedTree;
}

/** Lists a tree's files by path. */
export async function filesOf(git: Git, treeish: Oid): Promise<Map<string, Oid>> {
  return new Map((await listTree(git, treeish)).map((entry) => [entry.path, entry.oid]));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
