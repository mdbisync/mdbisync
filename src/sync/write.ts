// Steps 3 to 5 of a sync run: the tracked branch's changes go to Linear.
//
// 3. Merge the tracked branch into the `linear` tip locally (merge.ts).
// 4. Write: for each document the merge result changes, read it again; if
//    Linear still holds what the `linear` tip says it holds, write the
//    change (content, title, project or team in one request), create the
//    new documents and trash the removed ones. A document a person changed
//    since the capture is skipped: the next run captures that edit and
//    merges again.
// 5. Record: commit what Linear returned. When every change was made, the
//    commit merges the tracked branch (parents: `linear` tip, tracked
//    branch), so the merge base moves forward; otherwise it is an ordinary
//    commit on the `linear` tip that keeps the skipped documents as Linear
//    holds them. `linear`, `ids` and `uploads` move in one atomic push.
//
// A run that stops (rate limit, low budget, a rejected write) records what
// it wrote in an ordinary commit; the next run merges again and writes the
// rest. A run that dies after writing and before recording heals itself:
// the next capture reads the written documents, whose text equals the
// tracked branch, and a document created without its id recorded is
// adopted by its title.

import { type ContainerCapacity, assessCapacity, capacityBlocked, containerKey, readContainerDocuments } from '../run/capacity.ts';
import { createHash, randomUUID } from 'node:crypto';
import { documentPath } from './paths.ts';
import { sameMarkdown, splitFile } from '../format/index.ts';
import { type DocumentPatch, type LinearClient, type LinearDocument, LinearError, LinearStoppedError, describeLinearError } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { projectKey } from '../setup/index.ts';
import { type FailedWrite, type InitialSyncPlan, type LeftOutAtWrite, type WriteStop, placeId, readKeptAnnotations } from '../initial-sync/index.ts';
import { type BodyTransform, LeaveOutError, restoreBody, transformBody } from '../initial-sync/transform.ts';
import { linkDestinations, resolveRelative } from '../initial-sync/links.ts';
import {
  type CommitIdentity,
  type IdEntry,
  type IdMap,
  type Oid,
  type RefUpdate,
  type StateConfig,
  type StateSnapshot,
  commitIds,
  commitTree,
  commitUploads,
  pushAtomic,
  readBlobs,
  readIds,
  readReservedIds,
  readSupersededIds,
  readUploads,
  UPLOADS_REBUILT,
  uploadsRebuilding,
  stateRef,
  branchRef,
} from '../state/index.ts';
import { type Checkpoint, checkpoint as testCheckpoint, testStopAfterDocuments } from '../test-hooks.ts';
import { type CreateChange, type Decided, type DocumentChange, type KeepChange, type SideFile, type TrashChange, alreadyMerged, changePath, mergedInitialRecord, filesOf, knownIdLookup, lastSynchronized, leftOutFiles, mergeLocally } from './merge.ts';
import { reconcileDocumentMark } from './marks.ts';
import { withRecorded } from './recorded.ts';
import { message } from '../messages.ts';
import { type FileLeftOutRule, type SkipReason, type WriteCode } from '../codes.ts';

export const MERGE_RECORD_MESSAGE = "Sync: Linear's state after taking in the tracked branch";
export const PARTIAL_RECORD_MESSAGE = "Sync: Linear's state, part of the tracked branch taken in";
export const IDS_MESSAGE = 'Sync: document ids';

/** Documents read again in one request, just before they are written. */
export const REREAD_BATCH = 50;

export interface WriteOptions {
  documentCap?: number | undefined;
  /**
   * The containers' documents as this run's capture listed them, by
   * `containerKey`. Used only for the capacity report of a run whose
   * tracked branch already holds `linear` (it returns before any write);
   * every other run lists the containers again.
   */
  containers?: Map<string, LinearDocument[]> | undefined;
  config: StateConfig;
  /**
   * The sync branch does not exist after step 2: the record creates it at the new `linear` tip, in the same push, so
   * it follows `linear` from the first record on (a missing branch then means a person deleted it).
   */
  createSyncBranch?: boolean;
  /** The state refs after capture: the expected old values of this step's push. */
  state: StateSnapshot;
  /**
   * Makes fresh body transforms. The write set turns the merge result's
   * files into what is written. Comparison sets detect linked file changes
   * and changes in Linear since capture, without uploading.
   */
  transforms?: () => readonly BodyTransform[];
  identity?: CommitIdentity;
  rereadBatch?: number;
  /** Stop after this many written documents, as if the budget ran low; the test hook's value by default. */
  stopAfterDocuments?: number | undefined;
  checkpoint?: (name: Checkpoint) => Promise<void>;
  /** The client-chosen id of a new document. */
  newId?: () => string;
  /** The documents as this run's capture read them, by id: a removed document changed since then is not restored. */
  captured?: ReadonlyMap<string, LinearDocument>;
}

export type { SkipReason } from '../codes.ts';

export interface WriteResult {
  capacity?: ContainerCapacity[];
  /** Every change was made and recorded with a merge commit, or there was nothing to take in. */
  complete: boolean;
  /** Something was written to Linear or a state ref moved. */
  changed: boolean;
  /** The run went on from a partial record that an earlier run left on `linear`. */
  resumed: boolean;
  code?: WriteCode;
  /** Content written to existing documents (a rename or move may come with it). */
  updated: string[];
  /** Documents renamed (new title) or moved to another project or team: from → to. */
  relocated: Array<{ from: string; to: string }>;
  created: string[];
  /** Documents of removed files, now in Linear's trash. */
  trashed: string[];
  /** Created by an earlier run that stopped before recording the id; found by title and written. */
  adopted: string[];
  /** Documents Linear removed while git changed their files: restored with the same id and the git text. */
  restored: string[];
  /** Documents whose merged text holds conflict marker paragraphs. */
  conflicts: string[];
  /** Cases the structural conflict rules decided. */
  decided: Decided[];
  skipped: Array<{ path: string; reason: SkipReason }>;
  /** Synchronized files the sync leaves out (lint, title, collisions); their documents stay as they were. */
  leftOut: Array<{ path: string; rules: FileLeftOutRule[] }>;
  /** Left out by a transform while writing. */
  leftOutAtWrite: LeftOutAtWrite[];
  failed: FailedWrite[];
  notAttempted: string[];
  stopped?: WriteStop;
  /**
   * The longest time, in milliseconds, between a document's re-read and the
   * answer to its write (an upper bound: the write lands inside it, after
   * any retry); an edit made in Linear inside it can be overwritten (Linear
   * takes writes without a version). Null when no document that was read
   * again was written.
   */
  rereadWindowMs: number | null;
  record: SyncRecord | null;
  /** The state refs after this step. */
  state: StateSnapshot;
}

export interface SyncRecord {
  commit: Oid;
  kind: 'merge' | 'ordinary';
  parents: Oid[];
}

class StopWriting extends Error {}

/** A state ref moved while the run was writing: another run records first, this one records nothing. */
class StateMovedError extends Error {}

export async function writeTrackedToLinear(context: RunContext, options: WriteOptions): Promise<WriteResult> {
  const { git, fetched, targets, linear } = context;
  const transforms = options.transforms?.() ?? [];
  const tipTransforms = options.transforms?.() ?? [];
  const identity = options.identity ?? context.identity;
  const rereadBatch = Math.max(1, options.rereadBatch ?? REREAD_BATCH);
  const stopAfter = 'stopAfterDocuments' in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint = options.checkpoint ?? ((name: Checkpoint) => testCheckpoint(name));
  const newId = options.newId ?? randomUUID;
  const expected: StateSnapshot = { ...options.state };
  const tracked = fetched.tracked;
  const linearTip = expected.linear;
  if (linearTip === null) throw new Error(message('sync.write-before-record'));

  const result: WriteResult = {
    complete: false,
    changed: false,
    resumed: await wentOnFromPartial(git, [context.fetched.state.linear, linearTip]),
    updated: [],
    relocated: [],
    created: [],
    trashed: [],
    adopted: [],
    restored: [],
    conflicts: [],
    decided: [],
    skipped: [],
    leftOut: [],
    leftOutAtWrite: [],
    failed: [],
    notAttempted: [],
    rereadWindowMs: null,
    record: null,
    state: { ...expected },
  };
  /** The containers' documents as Linear lists them now; undefined, with the result set, when the listing failed. */
  const readContainers = async (): Promise<Map<string, LinearDocument[]> | undefined> => {
    try {
      return await readContainerDocuments(context);
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      result.notAttempted = context.mapping.documents.map((document) => document.path).sort();
      if (error instanceof LinearStoppedError) {
        result.code = 'stopped';
        result.stopped = error.reason;
      } else {
        result.code = 'write-failed';
        result.failed = result.notAttempted.map((path) => ({ path, operation: error.operation, error: describeLinearError(error) }));
      }
      return undefined;
    }
  };
  // The upload cache was lost (or never recorded): each document that links a file is written again with fresh
  // uploads, run after run, until one run has done them all and marks the cache complete.
  const cacheLost = await uploadsRebuilding(git, expected.uploads);
  // Nothing new either right after a person merged an initial sync from Linear unchanged: recording that merge
  // would move `linear` with nothing written (I6). A sync branch GitHub deleted on that merge comes back with the
  // next record, as a branch a person deleted does.
  const nothingNew = (await alreadyMerged(git, linearTip, tracked)) || (await mergedInitialRecord(git, linearTip, tracked));
  if (nothingNew && !cacheLost) {
    // Nothing to write, but the files left out stay left out: the report names them on every run, not only on
    // the run that first met them. The `linear` tip holds what a merge would give.
    result.leftOut = await leftOutFiles(git, linearTip, linear.facts);
    // The capacity report can use this run's earlier listing.
    const containers = options.containers ?? await readContainers();
    if (containers === undefined) return result;
    result.capacity = assessCapacity(context, containers, [], options.documentCap);
    if (capacityBlocked(result.capacity)) {
      result.code = 'container-cap';
      return result;
    }
    result.complete = true;
    return result;
  }

  // Step 3.
  const ids = await readIds(git, expected.ids);
  const reserved = await readReservedIds(git, expected.ids);
  const supersededBefore = await readSupersededIds(git, expected.ids);
  const knownId = knownIdLookup(git, expected.ids, ids);
  const merge = await mergeLocally(git, linearTip, tracked, ids, linear.facts, { knownId, keptAnnotations: await readKeptAnnotations(git, expected.ids) });
  // The tracked branch has nothing new: only the documents the cache rebuild relinks are written.
  if (nothingNew) merge.changes.length = 0;
  result.leftOut = merge.leftOut;
  // Anything from here may write (linked-file changes are found later too): capacity, adoption and
  // reserved ids are decided on the containers as Linear lists them now, not as capture saw them.
  const containerListing = await readContainers();
  if (containerListing === undefined) return result;
  // A separate const: the hoisted `adoptableDocuments` below does not see the narrowing above.
  const containers: Map<string, LinearDocument[]> = containerListing;
  await findGoneRestores();
  for (const path of merge.conflicts) if (merge.result.has(path) || merge.linear.has(path) || ids.has(path)) result.skipped.push({ path, reason: 'conflict' });
  for (const entry of merge.held) result.skipped.push({ path: entry.from, reason: 'renamed-to-unwritable' });
  await checkpoint('after-local-merge-before-record');

  const uploads = await readUploads(git, expected.uploads);
  const resultFiles = await filesOf(git, merge.tree);
  const linearFiles = await filesOf(git, linearTip);
  const texts = merge.texts;
  const textOf = (file: SideFile) => (texts.get(file.oid) as Buffer).toString('utf8');

  // What the merge result holds, as a commit, so a transform reads the files it links to from it.
  const candidate = await git.text(['commit-tree', '--no-gpg-sign', merge.tree, '-p', linearTip, '-p', tracked, '-m', 'merge result'], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
  });

  const creates = merge.changes.filter((change): change is CreateChange => change.kind === 'create');
  // A document to restore keeps its own id; it is never adopted by title.
  const adoptable = await adoptableDocuments(creates.filter((change) => change.restore === undefined));
  // A document restored where it already is (in that container's trash) adds nothing: the container counts it already.
  const restoresInPlace = (change: CreateChange) => {
    if (change.restore === undefined || change.restore.recreate !== undefined) return false;
    const destination = merge.result.get(change.path) as SideFile;
    return containers.get(containerKey(context, destination.place))?.some((document) => document.id === change.restore?.id) === true;
  };
  const additions = creates.filter((change) => !adoptable.has(change.path) && !restoresInPlace(change)).map((change) => merge.result.get(change.path) as SideFile);
  // Moves consume destination capacity too; do not subtract departures, since writes may arrive first.
  for (const change of merge.changes) {
    if (change.kind !== 'keep' || !change.place) continue;
    const destination = merge.result.get(change.to) as SideFile;
    const present = containers.get(containerKey(context, destination.place))?.some((document) => document.id === change.id);
    if (!present) additions.push(destination);
  }
  result.capacity = assessCapacity(context, containers, additions, options.documentCap);
  if (capacityBlocked(result.capacity)) {
    result.code = 'container-cap';
    result.notAttempted = merge.changes.map(changePath);
    return result;
  }
  /** Reserved ids that a document in Linear already has (archived, trashed or retitled since): Linear refuses to create a second one. */
  const taken = new Set<string>();
  /** The new documents that would use a reserved id. */
  const usingReserved = new Set(creates.filter((change) => !adoptable.has(change.path) && reserved.has(change.path)).map((change) => change.path));
  /** Why the reserved ids could not be checked: those creates could be refused or collide, so they wait for the next run. */
  let unchecked: LinearError | undefined;
  try {
    const listed = new Set([...containers.values()].flat().map((document) => document.id));
    const saved = [...new Set([...usingReserved].map((path) => reserved.get(path) as string))];
    for (const id of saved) if (listed.has(id)) taken.add(id);
    // A document moved out of the targets is not in their listing.
    const unlisted = saved.filter((id) => !listed.has(id));
    if (unlisted.length > 0) for (const document of await linear.getDocuments(unlisted, { withContent: false })) taken.add(document.id);
  } catch (error) {
    if (error instanceof LinearStoppedError) {
      // Stopped before any write or upload: nothing to record, and the next run starts again.
      result.stopped = error.reason;
      result.notAttempted = merge.changes.map(changePath);
      result.code = 'stopped';
      return result;
    }
    if (!(error instanceof LinearError)) throw error;
    unchecked = error;
  }
  const documentIds = new Map<string, string>();
  for (const [path, entry] of ids) documentIds.set(path, entry.id);
  for (const change of merge.changes) if (change.kind === 'keep') documentIds.set(change.to, change.id);
  // A new document gets its id before any write, so documents written in this run can link to it. A new document an
  // earlier run did not create (left out, failed, refused or stopped) keeps the id reserved for it then, since documents
  // written then may link to it; an id Linear already gives another document is not reused. A document to restore
  // keeps its own id, or gets the one derived from it when Linear no longer has it.
  for (const change of creates) {
    const saved = reserved.get(change.path);
    const restoreId = change.restore?.recreate ?? change.restore?.id;
    documentIds.set(change.path, restoreId ?? adoptable.get(change.path)?.id ?? (saved !== undefined && !taken.has(saved) ? saved : newId()));
  }

  /** What Linear stores now for each path whose document this run wrote, with the body sent for it. */
  const stored = new Map<string, { content: string; sent: string; document: LinearDocument }>();
  const nextIds: IdMap = new Map(ids);
  // A file that moved and kept its title, place and text (a renamed project folder): Linear needs nothing, the id map follows the file.
  for (const change of merge.unchanged) {
    if (change.from === change.to) continue;
    nextIds.set(change.to, nextIds.get(change.from) as IdEntry);
    nextIds.delete(change.from);
    documentIds.set(change.to, change.id);
  }
  // Reserved ids of files still in the tree; a file that is gone frees its id. Every new document this run creates is
  // reserved until its id is in the map, so each ids push, also one in the middle of the run, keeps the ids the written
  // documents may link to. An adopted document is not reserved: its id is not ours to create with.
  const nextReserved = new Map([...reserved].filter(([path]) => resultFiles.has(path)));
  for (const change of creates) if (!adoptable.has(change.path)) nextReserved.set(change.path, documentIds.get(change.path) as string);
  /** Paths of the merge result whose changes were not made: the record keeps the `linear` tip's version. */
  const notDone: DocumentChange[] = [];
  // The tip's side only computes what Linear should hold: it never uploads. It reads the cache as the run found it,
  // before any upload of this run (preparing may upload ahead of the writes), so this run's uploads never count as
  // what Linear held.
  // While the cache is filled again, the URLs it held are unknown: a document that links a file cannot be checked
  // against the tip, and its write goes ahead (see `holdsVersion`).
  const tipUploads = cacheLost ? new Map<string, string>() : new Map(uploads);
  // A new document whose reserved id Linear already gives another one is created under a new id, but the documents an
  // earlier run wrote link the reserved one. By superseded id, the path it named; kept from earlier runs until every
  // document that links the path is written with its new id.
  // A target git renamed since keeps its superseded ids under its new path.
  const movedTo = new Map([...merge.unchanged, ...merge.changes].flatMap((change) => (change.kind === 'keep' && change.from !== change.to ? [[change.from, change.to] as const] : [])));
  const superseded = new Map(
    [...supersededBefore].map(([id, path]) => [id, movedTo.get(path) ?? path] as const)
      .filter(([id, path]) => resultFiles.has(path) && documentIds.has(path) && documentIds.get(path) !== id),
  );
  for (const [path, id] of reserved) if (documentIds.has(path) && documentIds.get(path) !== id) superseded.set(id, path);
  /** Documents whose text links a path with a superseded id, with those paths: each is written with the new id. */
  const relinks = new Map<string, Set<string>>();
  // Without transforms no link is written in Linear's form, so there is nothing to relink.
  if (superseded.size > 0 && transforms.length > 0) {
    const targets = new Set(superseded.values());
    /** Records under `path` the superseded paths that `text`, the file at `from`, links. */
    const linked = (path: string, text: string, from = path) => {
      const found = linkDestinations(splitFile(text).body).flatMap((destination) => {
        const target = resolveRelative(from, destination.url)?.path;
        return target !== undefined && targets.has(target) ? [target] : [];
      });
      if (found.length > 0) relinks.set(path, new Set([...(relinks.get(path) ?? []), ...found]));
    };
    const covered = new Set<string>();
    for (const change of [...merge.unchanged, ...merge.changes]) {
      if (change.kind === 'trash') {
        // Linear holds the document until the trash lands.
        covered.add(change.path);
        const tip = merge.linear.get(change.path);
        if (tip !== undefined) linked(change.path, textOf(tip));
      }
      if (change.kind !== 'keep') continue;
      covered.add(change.from);
      linked(change.to, textOf(merge.result.get(change.to) as SideFile));
      // Linear holds the tip's text until the write lands: a link git removed is still there if the write fails.
      const tip = merge.linear.get(change.from);
      if (tip !== undefined) linked(change.to, textOf(tip), change.from);
    }
    // A mapped document this run does not write (git could not merge its file, the sync leaves the file out, or its
    // rename waits) keeps the superseded id until a later run writes it.
    const rest = [...ids.keys()].flatMap((path) => {
      const oid = covered.has(path) ? undefined : (resultFiles.get(path) ?? linearFiles.get(path));
      return oid === undefined ? [] : [[path, oid] as const];
    });
    const blobs = await readBlobs(git, rest.map(([, oid]) => oid));
    for (const [path, oid] of rest) linked(path, (blobs.get(oid) as Buffer).toString('utf8'));
  }
  /** The superseded ids to keep: a document that links the path was neither written with the new id nor trashed. */
  const nextSuperseded = () => new Map([...superseded].filter(([, path]) => [...relinks].some(([document, paths]) => paths.has(path) && !stored.has(document) && !result.trashed.includes(document))));

  let written = 0;
  /** When the current batch's re-read answered. */
  let rereadAt = 0;
  /**
   * Sends a write to a document that was read again, and records how long
   * Linear was unwatched for it: from the re-read to the write's answer, so
   * a retry after a rate limit counts too. The write lands somewhere inside
   * that time, so this is the window's upper bound. A write that fails
   * records nothing.
   */
  const timed = async <T>(write: () => Promise<T>): Promise<T> => {
    const done = await write();
    const window = Math.round((performance.now() - rereadAt) * 10) / 10;
    result.rereadWindowMs = Math.max(result.rereadWindowMs ?? 0, window);
    return done;
  };
  try {
    const plan = transformPlan();
    for (const transform of transforms) await transform.prepare?.({ git, tracked: candidate, linear, plan, uploads, documentIds });
    for (const transform of tipTransforms) await transform.prepare?.({ git, tracked: linearTip, linear: withoutUploads(linear), plan: { create: [], overwrite: [], trash: [], leftOut: [] }, uploads: tipUploads, documentIds });
    await findLinkedFileChanges();

    const changes = merge.changes;
    /** Stops writing: the change at `from` and every later one are not attempted. */
    const stopAt = (from: number, reason: WriteStop): never => {
      result.stopped = reason;
      const rest = changes.slice(from);
      result.notAttempted = rest.map(changePath);
      notDone.push(...rest);
      throw new StopWriting();
    };
    // Before the first re-read: an edit made in Linear while the run waits here is seen by the re-read and skipped.
    if (changes.length > 0) await checkpoint('before-write');
    for (let start = 0; start < changes.length; start += rereadBatch) {
      const batch = changes.slice(start, start + rereadBatch);
      let current: Map<string, LinearDocument>;
      try {
        current = await reread(batch);
        rereadAt = performance.now();
      } catch (error) {
        if (error instanceof LinearStoppedError) stopAt(start, error.reason);
        if (!(error instanceof LinearError)) throw error;
        // The batch cannot be checked against Linear, so none of it is written.
        for (const change of batch) result.failed.push({ path: changePath(change), operation: error.operation, error: describeLinearError(error) });
        notDone.push(...batch);
        continue;
      }
      await checkpoint('after-reread-before-write');
      for (let index = 0; index < batch.length; index += 1) {
        const change = batch[index] as DocumentChange;
        const stop = linear.stopped ?? (stopAfter !== undefined && written >= stopAfter ? { kind: 'test-threshold' as const, documents: stopAfter } : undefined);
        if (stop !== undefined) stopAt(start + index, stop);
        const path = changePath(change);
        if (change.kind === 'create' && unchecked !== undefined && usingReserved.has(path)) {
          result.failed.push({ path, operation: unchecked.operation, error: describeLinearError(unchecked) });
          notDone.push(change);
          continue;
        }
        try {
          const done = await apply(change, current);
          if (done) written += 1;
          else notDone.push(change);
        } catch (error) {
          if (error instanceof LeaveOutError) {
            result.leftOutAtWrite.push(error.files.length > 0 ? { path, rule: error.rule, files: [...error.files] } : { path, rule: error.rule });
            notDone.push(change);
            continue;
          }
          // The write may have been applied; the next run reads it again.
          if (error instanceof LinearStoppedError) stopAt(start + index, error.reason);
          if (error instanceof LinearError) {
            result.failed.push({ path, operation: error.operation, error: describeLinearError(error) });
            notDone.push(change);
            continue;
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof StateMovedError) {
      result.code = 'state-moved';
      return result;
    }
    if (error instanceof LinearStoppedError) {
      // Stopped before the writes (preparing the transforms; a stop inside the loop is a StopWriting): no change is
      // made. Uploads the preparation finished are still recorded, so the next run does not send them again.
      result.stopped = error.reason;
      result.notAttempted = merge.changes.map(changePath);
      notDone.splice(0, notDone.length, ...merge.changes);
    } else if (!(error instanceof StopWriting)) throw error;
  }
  if (written > 0) result.changed = true;
  // Report only the conflicts and decided cases this run carried out.
  const undone = new Set([
    ...notDone.flatMap(pathsOf), ...result.notAttempted, ...result.skipped.map((entry) => entry.path),
    ...result.failed.map((entry) => entry.path), ...result.leftOutAtWrite.map((entry) => entry.path),
  ]);
  result.conflicts = merge.marked.filter((path) => !undone.has(path));
  result.decided = merge.decided.filter((entry) => !undone.has(entry.path));

  await checkpoint('after-write-before-record');
  const allDone = notDone.length === 0 && merge.conflicts.length === 0 && merge.held.length === 0;
  const recorded = await record(allDone);
  if (recorded === null) {
    result.code = 'state-moved';
    return result;
  }
  if (result.stopped !== undefined) result.code = 'stopped';
  else if (result.failed.length > 0) result.code = 'write-failed';
  result.complete = allDone;
  return result;

  // -------------------------------------------------------------------------

  /**
   * A document whose text stays can still need a write: a file it links to
   * changed (an image with new bytes gets a new upload URL). Each document
   * whose text names a file that differs between the tip and the merge
   * result is compared in Linear's form, and those that differ join the
   * changes. So does each document that links a path by a superseded id.
   */
  async function findLinkedFileChanges(): Promise<void> {
    if (transforms.length === 0) return;
    const changedNames = new Set<string>();
    for (const path of new Set([...linearFiles.keys(), ...resultFiles.keys()])) {
      if (!path.endsWith('.md') && linearFiles.get(path) !== resultFiles.get(path)) changedNames.add(path.slice(path.lastIndexOf('/') + 1));
    }
    // A moved document is always compared: a relative link may now point at another file.
    // Documents with the same text: those needing nothing, and those only renamed or moved (their write must
    // carry the new link too).
    const keptText = [...merge.unchanged, ...merge.changes.filter((change): change is KeepChange => change.kind === 'keep' && !change.content)];
    // A document that links a path by its superseded id is written with the new one. Linear may hold either (an
    // earlier run may have written it already): the write compares, and sends nothing when Linear holds the new text.
    for (const change of keptText) if (relinks.has(change.to)) markContent(change);
    const sameText = keptText.filter((change) => !relinks.has(change.to));
    /** While the cache is filled again: documents that link a cached file, with the text they get from it. */
    const relinked: Array<{ change: KeepChange; written: string }> = [];
    if (!cacheLost && changedNames.size === 0 && !sameText.some((change) => change.from !== change.to)) {
      sortChanges();
      return;
    }
    // Comparing forms must not upload: an uncached file already needs a
    // write. Only the write loop sends its bytes and handles its failures.
    const comparisonTransforms = options.transforms?.() ?? [];
    for (const transform of comparisonTransforms) await transform.prepare?.({ git, tracked: candidate, linear: withoutUploads(linear), plan: { create: [], overwrite: [], trash: [], leftOut: [] }, uploads, documentIds });
    for (const change of sameText) {
      const next = merge.result.get(change.to) as SideFile;
      const previous = merge.linear.get(change.from) as SideFile;
      const text = textOf(next);
      // A cheap filter first for documents that stay where they are: a link to a changed file names it.
      const moved = change.from !== change.to;
      if (!moved && !cacheLost && ![...changedNames].some((name) => text.includes(name) || text.includes(encodeURI(name)) || text.includes(encodeURIComponent(name)))) continue;
      let differs: boolean;
      try {
        const written = await transformBody(comparisonTransforms, change.to, splitFile(text).body);
        if (cacheLost && !moved) {
          // Every file it links is cached already (an uncached one throws above: a write). Whether it links one shows
          // in the tip's form, which has no cache to take URLs from.
          const links = await transformBody(tipTransforms, change.from, splitFile(textOf(previous)).body).then(() => false, (error: unknown) => error instanceof UploadRefusedError);
          if (links) relinked.push({ change, written });
          continue;
        }
        differs = written !== (await transformBody(tipTransforms, change.from, splitFile(textOf(previous)).body));
      } catch (error) {
        // Left out or uncached: the write reports it, or stops before it.
        if (!(error instanceof LeaveOutError) && !(error instanceof LinearStoppedError) && !(error instanceof UploadRefusedError)) throw error;
        differs = true;
      }
      if (differs) markContent(change);
    }
    // A run that stopped partway already wrote some: only documents that do not hold their text with the cache's URLs
    // are written again, so the rebuild gets further every run.
    if (relinked.length > 0) {
      let held: Map<string, string | null | undefined> | undefined;
      try {
        held = new Map((await linear.getDocuments(relinked.map(({ change }) => change.id), { withContent: true })).map((document) => [document.id, document.content]));
      } catch (error) {
        // Not read: each is written, and the write's own read decides.
        if (!(error instanceof LinearError) || error instanceof LinearStoppedError) throw error;
      }
      for (const { change, written } of relinked) if (held?.get(change.id) !== written) markContent(change);
    }
    sortChanges();

    function markContent(change: KeepChange): void {
      if (merge.changes.includes(change)) change.content = true;
      else merge.changes.push({ ...change, content: true });
    }

    function sortChanges(): void {
      merge.changes.sort((a, b) => compare(changePath(a), changePath(b)));
    }
  }

  /** Live, unmapped documents with the title of a new file in its place, from a run that created them and stopped. */
  async function adoptableDocuments(changes: readonly CreateChange[]): Promise<Map<string, LinearDocument>> {
    const found = new Map<string, LinearDocument>();
    if (changes.length === 0) return found;
    const mapped = new Set([...ids.values()].map((entry) => entry.id));
    const byPlace = new Map<string, { place: Place; paths: string[] }>();
    for (const change of changes) {
      const file = merge.result.get(change.path) as SideFile;
      const key = containerKey(context, file.place);
      const group = byPlace.get(key) ?? { place: file.place, paths: [] };
      group.paths.push(change.path);
      byPlace.set(key, group);
    }
    for (const { place, paths } of byPlace.values()) {
      const listed = (containers.get(containerKey(context, place)) ?? []).filter((document) => !document.trashed && document.archivedAt === null);
      const oldestFirst = [...listed].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
      for (const path of paths) {
        const title = (merge.result.get(path) as SideFile).title.normalize('NFC');
        const fits = (candidate: LinearDocument) => !mapped.has(candidate.id) && candidate.title.normalize('NFC') === title;
        // The document with the reserved id first: an earlier run created it and lost the answer, and documents may link to it.
        const document = oldestFirst.find((candidate) => candidate.id === reserved.get(path) && fits(candidate)) ?? oldestFirst.find(fits);
        if (document !== undefined) {
          mapped.add(document.id);
          found.set(path, document);
        }
      }
    }
    return found;
  }

  /** Reads the batch's existing documents again, with content, in one request. */
  async function reread(batch: readonly DocumentChange[]): Promise<Map<string, LinearDocument>> {
    const wanted = batch.flatMap((change) => (change.kind === 'create' ? [] : [change.id]));
    for (const change of batch) if (change.kind === 'create' && adoptable.has(change.path)) wanted.push((adoptable.get(change.path) as LinearDocument).id);
    for (const change of batch) if (change.kind === 'create' && change.restore !== undefined) wanted.push(change.restore.recreate ?? change.restore.id);
    const documents = wanted.length === 0 ? [] : await linear.getDocuments(wanted, { withContent: true });
    return new Map(documents.map((document) => [document.id, document]));
  }

  /**
   * Whether Linear still holds what the `linear` tip says: the capture has
   * seen the document as it is now. Compared in Linear's form: the tip's
   * file through the transforms (images become their cached upload URLs).
   */
  async function unchangedSinceCapture(held: LinearDocument, path: string): Promise<boolean> {
    if (held.trashed || held.archivedAt !== null) return false;
    const document = withCurrentIds(held);
    const synchronized = merge.linear.get(path);
    if (synchronized !== undefined) return holdsVersion(document, synchronized, textOf(synchronized), tipTransforms, true);
    // The tip does not synchronize the file (a lint finding, a collision, not text): it records the git text, and
    // Linear holds the version it was last given. Without one there is nothing to compare with, and the document is
    // not written.
    const baseline = await lastSynchronized(git, linearTip as Oid, path, linear.facts);
    if (baseline === null) return false;
    // That version's links resolve against its own tree: its images may have changed since.
    const baselineTransforms = options.transforms?.() ?? [];
    const plan: InitialSyncPlan = { create: [], overwrite: [], trash: [], leftOut: [] };
    for (const transform of baselineTransforms) {
      await transform.prepare?.({ git, tracked: baseline.commit, linear: withoutUploads(linear), plan, uploads: tipUploads, documentIds });
    }
    return holdsVersion(document, baseline.file, baseline.text, baselineTransforms, false);
  }

  /**
   * The document with each link by a superseded id read as the link by its
   * path's current id: written before the id was superseded, it is the same
   * text. Any mix of old and new ids in one document compares the same way.
   */
  function withCurrentIds(document: LinearDocument): LinearDocument {
    if (superseded.size === 0 || document.content == null) return document;
    const held = document.content;
    // Only link destinations: a URL quoted in code or prose is text, and stays as it is.
    let content = '';
    let at = 0;
    for (const { from, to, url } of linkDestinations(held)) {
      const id = /^https:\/\/linear\.app\/[^/]+\/document\/([^/#?]+)/.exec(url)?.[1];
      const path = id === undefined ? undefined : superseded.get(id);
      if (id === undefined || path === undefined) continue;
      content += held.slice(at, from) + held.slice(from, to).replace(id, documentIds.get(path) as string);
      at = to;
    }
    content += held.slice(at);
    return content === held ? document : { ...document, content };
  }

  /**
   * Whether a document holds a version of its file: title, project or team,
   * and text in Linear's form. When the text cannot be put in Linear's form
   * (a file it links to is gone or not in the upload cache), `uncheckable`
   * is the answer: the tip's own file lets the write go ahead, an older
   * version that cannot be checked does not.
   */
  async function holdsVersion(document: LinearDocument, file: SideFile, text: string, through: readonly BodyTransform[], uncheckable: boolean): Promise<boolean> {
    // Capture can encode a title or assign a stable collision suffix.
    const folder = file.path.slice(0, -(file.title.length + '.md'.length)).replace(/\/$/, '');
    const occupied = new Set([...linearFiles.keys()].filter((path) => path !== file.path));
    if (document.title.normalize('NFC') !== file.title.normalize('NFC')
      && documentPath(folder, document.title, document.id, occupied, file.path) !== file.path) return false;
    // Moved to another project or team in Linear: that move is the capture's to take in. A place the setup no longer
    // resolves (an annotation now names another project) cannot be checked.
    if (resolves(file.place) && !inPlace(document, file.place)) return false;
    let expected: string;
    try {
      expected = await transformBody(through, file.path, splitFile(text).body);
    } catch (error) {
      if (!(error instanceof LeaveOutError) && !(error instanceof UploadRefusedError)) throw error;
      return uncheckable;
    }
    return sameMarkdown(document.content ?? '', expected);
  }

  function resolves(place: Place): boolean {
    return place.kind === 'project' ? targets.projects.has(projectKey(place.team, place.project)) : targets.teams.has(place.team);
  }

  /** Whether a document is in the project, or the team zone, of a place. */
  function inPlace(document: LinearDocument, place: Place): boolean {
    const where = placeId(targets, place);
    return 'projectId' in where ? document.projectId === where.projectId : document.projectId === null && document.teamId === where.teamId;
  }

  /** Makes one change in Linear. False when it was skipped. */
  async function apply(change: DocumentChange, current: ReadonlyMap<string, LinearDocument>): Promise<boolean> {
    if (change.kind === 'trash') return trash(change, current);
    if (change.kind === 'keep') return keep(change, current);
    return create(change, current);
  }

  async function trash(change: TrashChange, current: ReadonlyMap<string, LinearDocument>): Promise<boolean> {
    const document = current.get(change.id);
    if (document === undefined || document.trashed || document.archivedAt !== null) {
      // Already gone from Linear: nothing to trash, and the id goes with the file.
      nextIds.delete(change.path);
      result.trashed.push(change.path);
      return true;
    }
    if (!(await unchangedSinceCapture(document, change.path))) return skip(change.path, 'edited-in-linear');
    await timed(() => linear.trashDocument(change.id));
    nextIds.delete(change.path);
    result.trashed.push(change.path);
    return true;
  }

  async function keep(change: KeepChange, current: ReadonlyMap<string, LinearDocument>): Promise<boolean> {
    const document = current.get(change.id);
    if (document === undefined || document.trashed || document.archivedAt !== null) return skip(change.to, 'missing-in-linear');
    const file = merge.result.get(change.to) as SideFile;
    const patch: DocumentPatch = {};
    /** The document as Linear stores it after the content change, for its status mark. */
    let readBack: LinearDocument | undefined;
    if (change.content) patch.content = await transformBody(transforms, change.to, splitFile(textOf(file)).body);
    if (change.title) patch.title = file.title.normalize('NFC');
    if (change.place) Object.assign(patch, placePatch(file.place));
    const holds =
      (patch.content === undefined || (document.content != null && sameMarkdown(document.content, patch.content))) &&
      (patch.title === undefined || document.title.normalize('NFC') === patch.title) &&
      (!change.place || inPlace(document, file.place));
    if (holds) {
      // Linear already holds the change: written by a run that stopped before recording it, or kept back by a partial record.
      if (patch.content !== undefined) {
        stored.set(change.to, { content: document.content ?? '', sent: patch.content, document });
        readBack = document;
      }
    } else {
      if (!(await unchangedSinceCapture(document, change.from))) return skip(change.to, 'edited-in-linear');
      const updated = await timed(() => linear.updateDocument(change.id, patch));
      // Without a content write the merge result's file stands: Linear holds its body already.
      if (patch.content !== undefined) {
        stored.set(change.to, { content: updated.content ?? '', sent: patch.content, document: updated });
        readBack = updated;
      }
    }
    // The structural rules set Linear's title back: say so where people see it. The comment id follows from the
    // document and the merge, so a run that repeats this merge after stopping finds its comment instead of adding one.
    if (change.comment !== undefined && document.documentContentId !== null) {
      await linear.ensureDocumentComment(document.documentContentId, change.comment, stableId('retitled', change.id, merge.base));
    }
    const entry = nextIds.get(change.from);
    nextIds.delete(change.from);
    nextIds.set(change.to, entry !== undefined && entry.id === change.id ? entry : { id: change.id });
    if (readBack !== undefined) await reconcileMark(change.to, readBack);
    if (change.content) result.updated.push(change.to);
    if (change.from !== change.to || change.title || change.place) result.relocated.push({ from: change.from, to: change.to });
    return true;
  }

  async function create(change: CreateChange, current: ReadonlyMap<string, LinearDocument>): Promise<boolean> {
    const file = merge.result.get(change.path) as SideFile;
    const body = await transformBody(transforms, change.path, splitFile(textOf(file)).body);
    const id = documentIds.get(change.path) as string;
    if (change.restore !== undefined && change.restore.recreate === undefined) return restore(change, file, body, current);
    // Created again under its derived id by a run that stopped before recording it.
    const recreated = change.restore?.recreate === undefined ? undefined : current.get(change.restore.recreate);
    const adopted = adoptable.get(change.path) ?? recreated;
    let document: LinearDocument;
    if (adopted !== undefined) {
      const live = current.get(adopted.id);
      const write = () => linear.updateDocument(adopted.id, { content: body });
      // Only a document the re-read returned has a window.
      document = live === undefined ? await write() : live.content != null && sameMarkdown(live.content, body) ? live : await timed(write);
      if (recreated === undefined) result.adopted.push(change.path);
    } else {
      document = await linear.createDocument(placeId(targets, file.place), { id, title: file.title.normalize('NFC'), content: body });
      await checkpoint('document-created-before-ids-push');
    }
    stored.set(change.path, { content: document.content ?? '', sent: body, document });
    nextIds.set(change.path, { id: document.id });
    result.created.push(change.path);
    await reconcileMark(change.path, document);
    return true;
  }

  /**
   * The document Linear removed while git changed its file is restored with
   * the same id, so its comments stay; the run summary, not a comment, says
   * why. A document a person changed since the capture read it (restored,
   * moved or edited) is left: the next capture takes that in.
   */
  async function restore(change: CreateChange, file: SideFile, body: string, current: ReadonlyMap<string, LinearDocument>): Promise<boolean> {
    const removed = current.get((change.restore as NonNullable<CreateChange['restore']>).id);
    if (removed === undefined) return skip(change.path, 'missing-in-linear');
    const seen = options.captured?.get(removed.id);
    const changed = seen === undefined
      // Without the capture's read, only a document still in trash is known to be as the capture left it.
      ? !removed.trashed && removed.archivedAt === null
      : seen.updatedAt !== removed.updatedAt || seen.trashed !== removed.trashed || seen.projectId !== removed.projectId || seen.teamId !== removed.teamId;
    if (changed) return skip(change.path, 'edited-in-linear');
    const document = await timed(async () => {
      if (removed.trashed || removed.archivedAt !== null) await linear.restoreDocument(removed.id);
      return linear.updateDocument(removed.id, { content: body, title: file.title.normalize('NFC'), ...placePatch(file.place) });
    });
    result.restored.push(change.path);
    stored.set(change.path, { content: document.content ?? '', sent: body, document });
    nextIds.set(change.path, { id: document.id });
    await reconcileMark(change.path, document);
    return true;
  }

  /**
   * Documents to restore that Linear no longer has at all are created again,
   * and the summary says their comments are lost. Decided before the
   * transforms run, so links to them carry the new id, which is derived from
   * the old one: a run that stops after creating it finds it again. When
   * Linear cannot be asked here, the write reads the documents again and
   * skips those it does not find.
   */
  async function findGoneRestores(): Promise<void> {
    const restoring = merge.changes.filter((change): change is CreateChange => change.kind === 'create' && change.restore !== undefined);
    if (restoring.length === 0) return;
    let found: LinearDocument[];
    try {
      found = await linear.getDocuments(restoring.map((change) => (change.restore as NonNullable<CreateChange['restore']>).id));
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      return;
    }
    const present = new Set(found.map((document) => document.id));
    for (const change of restoring) {
      const restore = change.restore as NonNullable<CreateChange['restore']>;
      if (present.has(restore.id)) continue;
      change.restore = { ...restore, recreate: stableId('recreated', restore.id) };
      const entry = merge.decided.find((decided) => decided.path === change.path);
      if (entry !== undefined) entry.summary = restore.gone;
    }
  }

  /**
   * Sets or clears the document's status mark from the text Linear now
   * stores (conflict markers show the conflict mark), and records the
   * document's own icon and color in `ids` before the mark replaces them.
   */
  async function reconcileMark(path: string, document: LinearDocument): Promise<void> {
    const entry = nextIds.get(path);
    if (entry === undefined || entry.id !== document.id || document.content === undefined) return;
    await reconcileDocumentMark({
      document,
      entry,
      linear,
      persistEntry: async (next) => {
        nextIds.set(path, next);
        await pushIds();
      },
    });
  }

  /** Pushes the id map on its own, with its lease, so a saved icon is durable before the mark replaces it. */
  async function pushIds(): Promise<void> {
    for (const path of nextIds.keys()) nextReserved.delete(path);
    const next = await commitIds(git, expected.ids, nextIds, identity, { message: IDS_MESSAGE, reserved: nextReserved, superseded: nextSuperseded() });
    const pushed = await pushAtomic(git, options.config, [{ ref: stateRef(options.config, 'ids'), expected: expected.ids, next }]);
    if (!pushed.ok) throw new StateMovedError();
    expected.ids = next;
  }

  /** A document's place as a patch: a project, or a team without a project. */
  function placePatch(place: Place): Pick<DocumentPatch, 'projectId' | 'teamId'> {
    const where = placeId(targets, place);
    return 'projectId' in where ? { projectId: where.projectId } : { teamId: where.teamId, projectId: null };
  }

  function skip(path: string, reason: SkipReason): false {
    result.skipped.push({ path, reason });
    return false;
  }

  /** The plan transforms are given: what this run overwrites and creates. */
  function transformPlan(): InitialSyncPlan {
    const plan: InitialSyncPlan = { create: [], overwrite: [], trash: [], leftOut: [] };
    for (const change of merge.changes) {
      if (change.kind === 'trash') continue;
      const path = changePath(change);
      const file = merge.result.get(path) as SideFile;
      if (change.kind === 'keep') plan.overwrite.push({ path, title: file.title, place: file.place, documentId: change.id });
      else plan.create.push({ path, title: file.title, place: file.place });
    }
    plan.leftOut = merge.leftOut.map((entry) => ({ path: entry.path, rules: entry.rules, lines: [] }));
    return plan;
  }

  /** Step 5: commits what Linear holds and pushes `linear`, `ids` and `uploads` together. Null when a ref moved. */
  async function record(merged: boolean): Promise<SyncRecord | null> {
    const changes = new Map<string, string | Buffer | null>();
    /** Paths the record takes from the `linear` tip, filled in after the written documents. */
    const fromTip = new Set<string>();
    const keepTip = (path: string) => fromTip.add(path);

    // Written documents: the merge result's front matter and what Linear stored.
    for (const [path, { content, sent }] of stored) {
      const file = merge.result.get(path) as SideFile;
      const text = splitFile(textOf(file)).head + restoreBody(transforms, path, content, sent);
      if (resultFiles.get(path) !== undefined && text === textOf(file)) continue;
      changes.set(path, text);
    }
    // Changes not made, and files git could not merge: as the `linear` tip has them.
    for (const change of notDone) for (const path of pathsOf(change)) keepTip(path);
    for (const path of merge.conflicts) keepTip(path);
    if (!merged) {
      // Files whose change shows only through documents (an image's bytes, an annotation that moves a folder) stay as
      // the tip has them, so the next run sees the change again; documents already updated then need no write.
      for (const path of new Set([...linearFiles.keys(), ...resultFiles.keys()])) {
        const derived = !path.endsWith('.md') || path === 'README.md' || path.endsWith('/README.md');
        if (derived && linearFiles.get(path) !== resultFiles.get(path)) keepTip(path);
      }
    }
    for (const entry of merge.held) keepTip(entry.from);
    const tipBlobs = await readBlobs(git, [...fromTip].flatMap((path) => (linearFiles.has(path) ? [linearFiles.get(path) as Oid] : [])));
    for (const path of fromTip) {
      const oid = linearFiles.get(path);
      changes.set(path, oid === undefined ? null : (tipBlobs.get(oid) as Buffer));
    }

    const parents = merged ? [linearTip as Oid, tracked] : [linearTip as Oid];
    const message = merged ? MERGE_RECORD_MESSAGE : PARTIAL_RECORD_MESSAGE;
    const commit = await commitTree(git, { parents, base: merge.tree, changes, message, identity, skipIfUnchanged: true });
    for (const path of nextIds.keys()) nextReserved.delete(path);
    // A written document the record holds as Linear returned it (its text, title and place; not the tip's old
    // file) is named with its update time: the next capture need not read it again. A partial record keeps files
    // from the tip that written documents depend on (an image's old bytes), so it names none: the capture reads them.
    const asWritten = new Map(
      [...(merged ? stored : [])].flatMap(([path, { document }]) => {
        const file = merge.result.get(path);
        const held = !fromTip.has(path) && file !== undefined && document.title.normalize('NFC') === file.title.normalize('NFC') && inPlace(document, file.place);
        return held ? [[document.id, document.updatedAt] as const] : [];
      }),
    );
    const idsCommit = await commitIds(git, expected.ids, nextIds, identity, { message: withRecorded(IDS_MESSAGE, asWritten), reserved: nextReserved, superseded: nextSuperseded(), always: asWritten.size > 0 });
    // Only a run that went through every document finishes the rebuild: one that stopped (also while finding the
    // documents to relink, before they are changes) leaves the rest to the next run.
    const rebuilt = cacheLost && merged && result.stopped === undefined ? { message: UPLOADS_REBUILT, always: true } : {};
    const uploadsCommit = expected.uploads === null && uploads.size === 0 && !cacheLost ? null : await commitUploads(git, expected.uploads, uploads, identity, rebuilt);

    const updates: RefUpdate[] = [
      { ref: stateRef(options.config, 'linear'), expected: linearTip, next: commit },
      { ref: stateRef(options.config, 'ids'), expected: expected.ids, next: idsCommit },
    ];
    if (uploadsCommit !== null) updates.push({ ref: stateRef(options.config, 'uploads'), expected: expected.uploads, next: uploadsCommit });
    const branch: RefUpdate | undefined = options.createSyncBranch === true && commit !== linearTip ? { ref: branchRef(options.config.syncBranch), expected: null, next: commit } : undefined;
    let pushed = await pushAtomic(git, options.config, branch === undefined ? updates : [...updates, branch]);
    // The branch is optional: a refusal that is not a lease (a rule on branch names, missing rights) moved nothing,
    // and the record goes on without it.
    if (!pushed.ok && pushed.reason === 'rejected' && branch !== undefined) pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    if (pushed.updated.length > 0) result.changed = true;
    result.state = { linear: commit, ids: idsCommit, uploads: uploadsCommit };
    const recorded: SyncRecord = { commit, kind: merged ? 'merge' : 'ordinary', parents: commit === linearTip ? [] : parents };
    result.record = commit === linearTip ? null : recorded;
    return recorded;
  }
}

/**
 * A tip file links to a file that is not in the upload cache, so it cannot
 * be put in Linear's form without an upload. A `LinearError`, so a
 * transform that uploads ahead of time (and gives up quietly on a Linear
 * error) treats it as a failed upload.
 */
export class UploadRefusedError extends LinearError {
  constructor() {
    super('FileUpload', message('linear.not-in-upload-cache'));
  }
}

/**
 * The client with uploads refused: a transform that would upload throws
 * `UploadRefusedError` instead. Other calls go to the client itself.
 */
function withoutUploads(client: LinearClient): LinearClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'uploadFile' || property === 'uploadFiles') {
        return async () => {
          throw new UploadRefusedError();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Whether the run goes on from a partial record an earlier run left: the
 * `linear` tip it found, before its capture added a commit, or the tip it
 * writes on.
 */
async function wentOnFromPartial(git: RunContext['git'], tips: ReadonlyArray<Oid | null>): Promise<boolean> {
  for (const tip of new Set(tips)) {
    if (tip !== null && (await git.text(['log', '-1', '--format=%s', tip])) === PARTIAL_RECORD_MESSAGE) return true;
  }
  return false;
}

/** The paths of the record a change touches. */
function pathsOf(change: DocumentChange): string[] {
  if (change.kind === 'keep') return change.from === change.to ? [change.to] : [change.from, change.to];
  return [change.path];
}

/** A UUID that follows from its parts: a Linear id a repeated run must find again instead of making anew. */
function stableId(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  const variant = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
