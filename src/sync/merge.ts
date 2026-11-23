// Step 3 of a sync run: the tracked branch merged into the `linear` tip, in
// git's object store only. Nothing is pushed and no working tree is used.
// The result says, per synchronized path, what Linear must change so that
// it holds the merge result: a write, a rename or move, a create or a trash.

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAnnotation } from '../mapping/index.ts';
import { MAPPING_FILE_BYTES, MAPPING_TREE_BYTES, MappingBlobBudget, MappingBlobBudgetError, readableBlob } from '../mapping/blobs.ts';
import { mapTree, requireReadableAnnotations } from '../mapping/mapping.ts';
import { type TreeEntry, parseTreeListing } from '../state/objects.ts';
import { lintInTree, splitFile } from '../format/index.ts';
import { LINEAR_FACTS, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { MARKDOWN_EXTENSION, type MappedDocument, type Place, type RepositoryMapping } from '../mapping/index.ts';
import { findFileLinks } from '../initial-sync/uploads.ts';
import { type StructuralResult, type StructuralSummary, type Version, detectConflicts, mergeMarkdown, resolveStructural } from '../merge/index.ts';
import { MarkdownLimitError } from '../format/markdown.ts';
import { type Git, type IdMap, type Oid, INITIAL_SYNC_FROM_LINEAR_RECORD, NEUTRAL_IDENTITY, buildTree, checkRepoPath, commitTree, isAncestor, listTree, readBlobs, readIds } from '../state/index.ts';
import { message } from '../messages.ts';
import { type FileLeftOutRule } from '../codes.ts';

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
  leftOut: Array<{ path: string; rules: FileLeftOutRule[] }>;
  /** What Linear must change, in path order; documents that need nothing are absent. */
  changes: DocumentChange[];
  /** Documents whose text, title and place stay; a file they link to may still have changed. */
  unchanged: KeepChange[];
  /**
   * Documents whose file was renamed to one that cannot be written yet (a
   * conflict, or left out by a lint finding): neither renamed nor trashed.
   * The record keeps both paths as the tip has them, and the run is not complete.
   */
  held: HeldRename[];
  /** The blobs of every synchronized file of both sides, by id. */
  texts: Map<Oid, Buffer>;
  /** Kept READMEs (named by `keptAnnotations`) the tracked branch renamed: tip path to merge result path. */
  keptMoves: Map<string, string>;
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
  let mergeTracked = tracked;
  let mergeBase = options.base;
  const frozen = new Set([...ids].flatMap(([path, entry]) => entry.suspended === undefined ? [] : [path, ...entry.suspended.paths]));
  const released = [...ids].filter(([, entry]) => entry.releaseBase !== undefined);
  if (frozen.size > 0 || released.length > 0) {
    mergeBase ??= await git.text(['merge-base', linear, tracked]);
    let baseTree = mergeBase;
    const releaseGroups = new Map<Oid, Set<string>>();
    for (const [path, entry] of released) {
      const paths = releaseGroups.get(entry.releaseBase as Oid) ?? new Set<string>();
      for (const selected of entry.releasePaths ?? [path]) paths.add(selected);
      releaseGroups.set(entry.releaseBase as Oid, paths);
    }
    for (const [base, paths] of releaseGroups) baseTree = await takePaths(git, baseTree, base, paths);
    if (frozen.size > 0) {
      baseTree = await takePaths(git, baseTree, linear, frozen);
      mergeTracked = await treeCommit(git, await takePaths(git, tracked, linear, frozen), tracked);
    }
    mergeBase = await treeCommit(git, baseTree, mergeBase);
  }
  const { base, renames, resolved } = await mergeWithMarkers(git, linear, mergeTracked, ids, options.knownId, mergeBase, true);
  const { tree, unresolved: conflicts } = resolved;

  const linearSide = await synchronizedFiles(git, linear, facts, ids);
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
    if (previous === undefined && entry.releaseBase !== undefined) {
      // A retained suspended id whose file survived a Linear delete is a
      // restoration, not a keep of a still-live document.
      const version = { path: to, text: (blobs.get(next.oid) as Buffer).toString('utf8') };
      const input = { base: { path: from, text: '' }, git: version, linear: null };
      const restored = await resolveStructural(input);
      const gone = (await resolveStructural({ ...input, linearGone: true })).summary as StructuralSummary;
      changes.push({ kind: 'create', path: to, restore: { id: entry.id, gone } });
      if (restored.summary !== null) resolved.decided.push({ path: to, summary: restored.summary });
      continue;
    }
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
  /** The tip's README without a document that git renamed to `path`, when the merge result no longer holds it. */
  const renamedTo = new Map([...renames].map(([from, to]) => [to, from]));
  const renamedFrom = (path: string): string | undefined => {
    const from = renamedTo.get(path);
    if (from === undefined || !isReadme(from) || ids.has(from) || !linearSide.files.has(from) || resultSide.files.has(from)) return undefined;
    return from;
  };
  /** Kept READMEs the tracked branch moved, from their tip path to their path in the merge result. */
  const keptMoves = new Map<string, string>();
  for (const path of resultSide.files.keys()) {
    if (!claimed.has(path) && !conflicted.has(path)) {
      const file = resultSide.files.get(path)!;
      // A folder's annotation that the `linear` tip already holds without a document is repository
      // configuration, not a request to create one: the annotation-only carrier capture keeps after its
      // document leaves, and the README an initial sync from Linear keeps, body included, because Linear
      // has no document for it. Only a change to its body on the tracked branch makes it a new document.
      // A README with a body counts only when the kept set names it (the latest initial sync's, or the one a
      // later sync recorded after a kept README moved): one left out on the way to Linear, or one whose id map
      // was lost, is created as every other file without a document is. A renamed folder takes its README
      // along: the tip's file is found at git's rename source.
      const source = linearSide.files.has(path) ? path : renamedFrom(path);
      const previous = source === undefined ? undefined : linearSide.files.get(source);
      const unchanged = previous !== undefined && body(previous.oid) === body(file.oid);
      const keptByName = source !== undefined && options.keptAnnotations?.has(source) === true;
      const kept = unchanged && (body(file.oid) === '' || keptByName);
      if (isReadme(path) && kept) {
        const annotation = readAnnotation(path, (blobs.get(file.oid) as Buffer).toString('utf8'));
        if ('annotation' in annotation && annotation.annotation !== null) {
          if (keptByName && source !== path) keptMoves.set(source as string, path);
          continue;
        }
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
    keptMoves,
  };
}

/** Versions of the id map searched for the id of a document Linear removed or renamed. */
export const ID_HISTORY_DEPTH = 100;

/**
 * The id a path's document last had: in `ids`, the map at `idsCommit`, or
 * in an earlier version of that map (a document Linear removed, or renamed
 * since). Earlier versions are read once each, newest first, when needed.
 */
export function knownIdLookup(git: Git, idsCommit: Oid | null, ids: IdMap): (path: string) => Promise<string | undefined> {
  let history: Oid[] | undefined;
  const versions = new Map<Oid, IdMap>();
  return async (path) => {
    const current = ids.get(path);
    if (current !== undefined) return current.id;
    history ??= idsCommit === null ? [] : (await git.text(['rev-list', '--first-parent', '-n', String(ID_HISTORY_DEPTH), idsCommit])).split('\n').filter(Boolean);
    // Newest first, one version at a time: the first match is the answer.
    for (const commit of history) {
      let map = versions.get(commit);
      if (map === undefined) {
        map = await readIds(git, commit);
        versions.set(commit, map);
      }
      const entry = map.get(path);
      if (entry !== undefined) return entry.id;
    }
    return undefined;
  };
}

/** git's merge of two commits, with the documents it could not merge resolved by the structural rules and conflict markers. */
export interface MarkedMerge {
  /** The merge base of the two sides. */
  base: Oid;
  /** git's renames between the merge base and the git side. */
  renames: Map<string, string>;
  resolved: Resolved;
}

/**
 * Merges `gitSide` into `linearSide` as step 3 does: git's merge, then the
 * sync's own merge of each document git could not merge. In the markers,
 * `gitSide`'s text is the git version and `linearSide`'s the Linear version.
 * `ids` maps `linearSide`'s paths to documents. With `echo` (step 3 only),
 * a conflict Linear still holds as the sync wrote it, which the tracked
 * branch resolves, is merged from its earlier versions. It writes objects
 * only.
 */
export async function mergeWithMarkers(git: Git, linearSide: Oid, gitSide: Oid, ids: IdMap, knownId?: MergeOptions['knownId'], explicitBase?: Oid, echo = false): Promise<MarkedMerge> {
  const base = explicitBase ?? await git.text(['merge-base', linearSide, gitSide]);
  const merged = await git.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ...(explicitBase === undefined ? [] : [`--merge-base=${explicitBase}`]), linearSide, gitSide], { okCodes: [0, 1] });
  const [gitTree, ...rest] = merged.stdout.toString('utf8').split('\0');
  if (gitTree === undefined || !/^[0-9a-f]{40,64}$/.test(gitTree)) throw new Error(message('sync.no-merge-tree'));
  const unmerged = [...new Set(rest.filter((path) => path !== ''))].sort(compare);
  const renames = await renamesBetween(git, base, gitSide);
  const resolved = await resolveConflicts(git, { base, linear: linearSide, tracked: gitSide, tree: gitTree, unmerged, renames, ids, knownId, echo });
  return { base, renames, resolved };
}

/** The path a change is listed under: where the document's file is after the run, or was before a trash. */
export function changePath(change: DocumentChange): string {
  return change.kind === 'keep' ? change.to : change.path;
}

export function placeKey(place: Place): string {
  return place.kind === 'project' ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
}

export interface Side {
  mapping: RepositoryMapping;
  files: Map<string, SideFile>;
  leftOut: Array<{ path: string; rules: FileLeftOutRule[] }>;
  leftOutPaths: Set<string>;
}

/**
 * The files of a commit or tree that are synchronized: mapped, and neither
 * reported by the linter, nor with a title Linear refuses, nor colliding.
 * The same rules as the initial sync's plan.
 */
async function synchronizedFiles(git: Git, treeish: Oid, facts: LinearFacts, observedRepairs?: IdMap): Promise<Side> {
  const entries = await listTree(git, treeish, MAPPING_TREE_BYTES);
  requireReadableAnnotations(entries);
  const budget = new MappingBlobBudget();
  const mapping = await mapTree(git, entries, budget);
  const paths = new Set(mapping.documents.map((document) => document.path));
  const blobs = await budget.read(git, entries.filter((entry) => paths.has(entry.path)));
  const files = new Map<string, SideFile>();
  const leftOut: Array<{ path: string; rules: FileLeftOutRule[] }> = [];
  const leave = (path: string, rules: FileLeftOutRule[]) => leftOut.push({ path, rules: [...new Set(rules)].sort() });
  for (const document of mapping.documents) {
    const rules: FileLeftOutRule[] = lintInTree(document.path, (blobs.get(document.oid) as Buffer).toString('utf8'), mapping.files).map((finding) => finding.rule);
    if (lengthRefusal({ title: document.title }, facts) !== undefined) rules.push('title-too-long');
    // A checked repair's source is an observation used only for comparison, never a writable result.
    const repair = observedRepairs?.get(document.path)?.pullRewrite;
    const observed = repair !== undefined && createHash('sha256').update(blobs.get(document.oid)!).digest('hex') === repair.hash;
    if (rules.length > 0 && !observed) leave(document.path, rules);
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
export async function leftOutFiles(git: Git, treeish: Oid, facts: LinearFacts = LINEAR_FACTS): Promise<Array<{ path: string; rules: FileLeftOutRule[] }>> {
  return (await synchronizedFiles(git, treeish, facts)).leftOut;
}

/** Commits of the `linear` chain examined for a file's last synchronized version: those that change it or a file it links. */
export const BASELINE_DEPTH = 20;

/**
 * The newest commit of the `linear` chain, walking its own commits only
 * (first parents: records and captures, never the tracked branch's), in
 * which a file was synchronized by the run's own rules (mapped, accepted by
 * the linter, a title Linear takes, no collision). That version is what
 * Linear was last given, with its title, place and linked files. A commit
 * that changes only a linked file counts too: removing or restoring an
 * image changes whether the file is synchronized. Null when none of the
 * last `BASELINE_DEPTH` such commits on the chain synchronized it.
 * Calls that share `sides` read each commit's synchronized files once.
 * With `oldest`, no commit older than it on the chain is examined, and
 * `oldest` itself counts as one of those commits, the oldest: it holds the
 * version the later commits changed, though it may not change the file.
 */
export async function lastSynchronized(
  git: Git,
  linear: Oid,
  path: string,
  facts: LinearFacts = LINEAR_FACTS,
  sides: Map<Oid, Promise<Side>> = new Map(),
  oldest?: Oid,
): Promise<{ commit: Oid; file: SideFile; text: string } | null> {
  for (const commit of await baselineCommits(git, linear, path, oldest)) {
    const file = await synchronizedAt(git, commit, path, facts, sides);
    if (file !== undefined) return { commit, file, text: ((await readBlobs(git, [file.oid])).get(file.oid) as Buffer).toString('utf8') };
  }
  return null;
}

/**
 * The commits `lastSynchronized` examines for `path`, newest first: the last `BASELINE_DEPTH` commits of the chain's
 * first-parent line that change the file or a file it links, down to `oldest` when given.
 */
export async function baselineCommits(git: Git, linear: Oid, path: string, oldest?: Oid): Promise<Oid[]> {
  const range = oldest === undefined ? [linear] : [linear, '--not', `${oldest}^@`];
  const log = async (paths: readonly string[]) => {
    const commits = (await git.text(['--literal-pathspecs', 'log', '--first-parent', '--format=%H', '-n', String(BASELINE_DEPTH), ...range, '--', ...paths])).split('\n').filter(Boolean);
    return oldest !== undefined && commits.length < BASELINE_DEPTH && !commits.includes(oldest) ? [...commits, oldest] : commits;
  };
  const versions = await log([path]);
  // Whether a version is synchronized, and which upload its images get, changes too in a commit that changes only a
  // file it links: an image removed, restored or replaced.
  const linked = await linkedFiles(git, versions, path);
  return linked.length === 0 ? versions : await log([path, ...linked]);
}

/** The file at `path` as `commit` synchronizes it, or undefined when the sync leaves it out there. Calls that share `sides` read each commit once. */
export async function synchronizedAt(git: Git, commit: Oid, path: string, facts: LinearFacts, sides: Map<Oid, Promise<Side>>): Promise<SideFile | undefined> {
  if (!sides.has(commit)) sides.set(commit, synchronizedFiles(git, commit, facts));
  return (await (sides.get(commit) as Promise<Side>)).files.get(path);
}

/** The files other than Markdown documents that the versions of `path` at `commits` link, each once. */
async function linkedFiles(git: Git, commits: readonly Oid[], path: string): Promise<string[]> {
  const linked = new Set<string>();
  for (const commit of commits) {
    const object = `${commit}:${path}`;
    // The commit removed the file: that version links nothing.
    const result = await git.run(['cat-file', '-s', object], { okCodes: [0, 128], maxOutputBytes: 64 });
    const size = Number(result.stdout.toString('utf8'));
    if (result.code !== 0 || !Number.isSafeInteger(size) || size < 0 || size > MAPPING_FILE_BYTES) continue;
    const blob = await git.run(['cat-file', 'blob', object], { okCodes: [0, 128], maxOutputBytes: MAPPING_FILE_BYTES });
    if (blob.code !== 0) continue;
    try {
      for (const link of findFileLinks(path, splitFile(blob.stdout.toString('utf8')).body, () => true)) {
        if (!link.target.endsWith(MARKDOWN_EXTENSION)) linked.add(link.target);
      }
    } catch (error) {
      // Unsupported history cannot serve as a synchronized baseline.
      if (!(error instanceof MarkdownLimitError)) throw error;
    }
  }
  return [...linked];
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
  /** Explicit per-run base for release; topology alone includes set-aside history. */
  base?: Oid | undefined;
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
  /** Step 3's merge with Linear: a conflict Linear still holds as the sync wrote it, which the tracked branch resolves, is merged from its earlier versions (`echoedConflicts`). */
  echo?: boolean;
}

export interface Resolved {
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
  const entriesByPath = async (side: Oid) => new Map((await listTree(git, side, MAPPING_TREE_BYTES)).map((entry) => [entry.path, entry]));
  const [baseFiles, gitFiles, linearFiles] = await Promise.all([entriesByPath(input.base), entriesByPath(input.tracked), entriesByPath(input.linear)]);
  // Only documents the sync maps get marker paragraphs; other files (unmapped Markdown, images) stay unresolved.
  const mapped = new Set<string>();
  for (const side of [baseFiles, gitFiles, linearFiles]) {
    const entries = [...side.values()];
    requireReadableAnnotations(entries);
    for (const document of (await mapTree(git, entries, new MappingBlobBudget())).documents) mapped.add(document.path);
  }
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
    const entry = linearFiles.get(path)!;
    if (!readableBlob(entry)) return false;
    const text = (await new MappingBlobBudget().read(git, [entry])).get(entry.oid)!.toString('utf8');
    if (splitFile(text).body.trim() !== '') return false;
    const annotation = readAnnotation(path, text);
    return 'annotation' in annotation && annotation.annotation !== null;
  };

  const groups: Array<{ base: TreeEntry | undefined; tracked: TreeEntry | undefined; linear: TreeEntry | undefined; involved: string[] }> = [];
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
    const base = basePath === null ? undefined : baseFiles.get(basePath);
    const tracked = gitPath === null ? undefined : gitFiles.get(gitPath);
    const linear = linearPath === null ? undefined : linearFiles.get(linearPath);
    if (!collides && [base, tracked, linear].every((entry) => entry === undefined || readableBlob(entry)) &&
      involved.every((entry) => mapped.has(entry) || !input.unmerged.includes(entry))) groups.push({ base, tracked, linear, involved });
    // Every path of the group waits, so neither document is trashed or overwritten until a person sorts it out.
    else out.unresolved.push(...involved);
  }

  const blobs = await new MappingBlobBudget().read(git, groups.flatMap(({ base, tracked, linear }) =>
    [base, tracked, linear].filter((entry) => entry !== undefined)));
  const version = (entry: TreeEntry | undefined): Version | null =>
    entry === undefined ? null : { path: entry.path, text: blobs.get(entry.oid)!.toString('utf8') };

  const changes = new Map<string, string | null>();
  const echo = input.echo === true ? echoedConflicts(git, input.linear) : null;
  for (const { base, tracked, linear, involved } of groups) {
    const basePath = base?.path ?? null;
    const linearPath = linear?.path ?? null;
    const versions = {
      // Both sides added the path: an empty base, so the whole text is merged.
      base: version(base) ?? { path: involved[0] as string, text: '' },
      git: version(tracked),
      linear: version(linear),
    };
    if (echo !== null && base !== undefined && tracked !== undefined && linear !== undefined && base.path === tracked.path && base.path === linear.path) {
      const earlier = await echo(base, tracked, linear);
      if (earlier !== null) Object.assign(versions, { base: { path: base.path, text: earlier.base }, linear: { path: base.path, text: earlier.linear } });
    }
    let result: StructuralResult;
    let gone: StructuralSummary | undefined;
    try {
      result = await resolveStructural(versions);
      if (result.kind === 'linear-deleted-git-changed' && result.path !== null) {
        gone = (await resolveStructural({ ...versions, linearGone: true })).summary as StructuralSummary;
      }
    } catch (error) {
      if (!(error instanceof MarkdownLimitError)) throw error;
      out.unresolved.push(...involved);
      continue;
    }
    for (const path of involved) changes.set(path, null);
    if (result.path !== null && result.text !== null) changes.set(result.path, result.text);
    if (linearPath !== null && result.path !== null && result.path !== linearPath) out.moves.set(linearPath, result.path);
    if (linearPath !== null && result.linear.comment !== undefined) out.comments.set(linearPath, result.linear.comment);
    let summary = result.summary;
    if (result.kind === 'linear-deleted-git-changed' && result.path !== null) {
      const id = basePath === null ? undefined : await knownId(basePath);
      if (id !== undefined) out.restores.set(result.path, { id, gone: gone! });
      else summary = gone!;
    }
    if (result.path !== null && result.conflicts.length > 0) out.marked.push(result.path);
    if (summary !== null) out.decided.push({ path: result.path ?? basePath ?? (involved[0] as string), summary });
  }
  out.tree = await buildTree(git, input.tree, changes);
  out.unresolved.sort(compare);
  return out;
}

/**
 * A conflict the sync wrote that has not reached the tracked branch yet,
 * which the tracked branch's newer text resolves: the base and Linear
 * versions that conflict was merged from, to merge the newer text with in
 * their place.
 *
 * The newest commit of the `linear` chain (first parents) that changed the
 * document wrote its current text, so Linear did not change it since. That
 * commit must be a record: a merge whose second parent is a tracked commit
 * with the merge base's text, and whose first parent holds Linear's text
 * before the write, without markers. Merging that text with the record's
 * git text, from their merge base (an empty text when the base lacks the
 * document), must give exactly the recorded text, markers included, and the
 * merge base's text holds none (they have not reached the tracked branch).
 *
 * The merge of the tracked branch's text with those versions counts only
 * when it already holds every change the tracked branch made since the
 * merge base: merging that change into it again changes nothing. A git
 * edit that sets a line back to the older text, or writes new text into
 * the conflict, fails that check. Null otherwise, and the merge stays as it
 * was: Linear changed the document after the write (its edit conflicts as
 * any other), the record cannot be read back to the same text, or the
 * merge would drop a git edit.
 */
function echoedConflicts(git: Git, linear: Oid): (base: TreeEntry, tracked: TreeEntry, linearEntry: TreeEntry) => Promise<{ base: string; linear: string } | null> {
  const budget = new MappingBlobBudget();
  const entryAt = async (commit: Oid, path: string): Promise<TreeEntry | undefined> => {
    const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', path]);
    return parseTreeListing(stdout).find((entry) => entry.path === path && entry.type === 'blob' && readableBlob(entry));
  };
  const textOf = async (entry: TreeEntry) => (await budget.read(git, [entry])).get(entry.oid)!.toString('utf8');
  const versions = async (base: TreeEntry, tracked: TreeEntry, linearEntry: TreeEntry) => {
    const path = linearEntry.path;
    const [baseText, trackedText, linearText] = await Promise.all([textOf(base), textOf(tracked), textOf(linearEntry)]);
    if (detectConflicts(linearText).length === 0 || detectConflicts(baseText).length > 0) return null;
    const [commit, parent, second, ...more] = (await git.text(['--literal-pathspecs', 'log', '--first-parent', '--max-count=1', '--format=%H %P', linear, '--', path])).split(' ');
    if (commit === undefined || parent === undefined || second === undefined || more.length > 0) return null;
    const [previous, recordGit] = await Promise.all([entryAt(parent, path), entryAt(second, path)]);
    if (previous === undefined || recordGit?.oid !== base.oid) return null;
    const previousText = await textOf(previous);
    if (detectConflicts(previousText).length > 0) return null;
    const merged = await git.run(['merge-base', parent, second], { okCodes: [0, 1] });
    if (merged.code !== 0) return null;
    const older = await entryAt(merged.stdout.toString('utf8').trim(), path);
    const olderText = older === undefined ? '' : await textOf(older);
    if ((await mergeMarkdown(olderText, baseText, previousText)).text !== linearText) return null;
    const result = (await mergeMarkdown(olderText, trackedText, previousText)).text;
    if ((await mergeMarkdown(baseText, trackedText, result)).text !== result) return null;
    return { base: olderText, linear: previousText };
  };
  return async (base, tracked, linearEntry) => {
    try {
      return await versions(base, tracked, linearEntry);
    } catch (error) {
      // A text the merge refuses, or one past the read budget, keeps the merge as it was.
      if (error instanceof MarkdownLimitError || error instanceof MappingBlobBudgetError) return null;
      throw error;
    }
  };
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

/** Copy selected paths exactly (including absence and file modes), leaving all other paths alone. */
export async function takePaths(git: Git, into: Oid, from: Oid, paths: ReadonlySet<string>): Promise<Oid> {
  const entries = new Map((await listTree(git, from)).map((entry) => [entry.path, entry]));
  // A path absent from `from` is removed, which an older tree's path may be.
  for (const path of paths) checkRepoPath(path, { removal: !entries.has(path) });
  // buildTree handles blobs; copy modes through a private index so images and symlinks stay exact.
  const dir = await mkdtemp(join(tmpdir(), 'lane-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git.run(['read-tree', `${into}^{tree}`], { env });
    const zero = '0'.repeat((await git.text(['rev-parse', '--show-object-format'])) === 'sha256' ? 64 : 40);
    const input = [...paths].map((path) => {
      const entry = entries.get(path);
      return entry === undefined ? `0 ${zero}\t${path}\0` : `${entry.mode} ${entry.oid}\t${path}\0`;
    }).join('');
    if (input) await git.run(['update-index', '-z', '--index-info'], { env, input });
    return await git.text(['write-tree'], { env });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A content-only side for a merge; never pushed or used as a real lane parent. */
export function treeCommit(git: Git, tree: Oid, parent: Oid): Promise<Oid> {
  return commitTree(git, { base: tree, changes: new Map(), parents: [parent], message: 'Merge input', identity: NEUTRAL_IDENTITY });
}

function isReadme(path: string): boolean {
  return path === 'README.md' || path.endsWith('/README.md');
}
