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

import { randomUUID } from 'node:crypto';
import { documentPath } from './paths.ts';
import { splitFile } from '../format/index.ts';
import { type DocumentPatch, type LinearClient, type LinearDocument, LinearError, LinearStoppedError } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { projectKey } from '../setup/index.ts';
import { type FailedWrite, type InitialSyncPlan, type LeftOutAtWrite, SYNC_IDENTITY, type WriteStop, placeId } from '../initial-sync/index.ts';
import { type BodyTransform, LeaveOutError, restoreBody, transformBody } from '../initial-sync/transform.ts';
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
  readUploads,
  stateRef,
} from '../state/index.ts';
import { type Checkpoint, checkpoint as testCheckpoint, testStopAfterDocuments } from '../test-hooks.ts';
import { type CreateChange, type DocumentChange, type KeepChange, type SideFile, type TrashChange, alreadyMerged, changePath, filesOf, mergeLocally } from './merge.ts';
import { reconcileDocumentMark } from './marks.ts';

export const MERGE_RECORD_MESSAGE = "Sync: Linear's state after taking in the tracked branch";
export const PARTIAL_RECORD_MESSAGE = "Sync: Linear's state, part of the tracked branch taken in";
export const IDS_MESSAGE = 'Sync: document ids';

/** Documents read again in one request, just before they are written. */
export const REREAD_BATCH = 50;

export interface WriteOptions {
  config: StateConfig;
  /** The state refs after capture: the expected old values of this step's push. */
  state: StateSnapshot;
  /**
   * Makes a fresh set of body transforms. The run uses two: one turns the
   * merge result's files into what is written, the other turns the
   * `linear` tip's files into what Linear should hold now, to tell whether
   * a document changed in Linear since the capture.
   */
  transforms?: () => readonly BodyTransform[];
  identity?: CommitIdentity;
  rereadBatch?: number;
  /** Stop after this many written documents, as if the budget ran low; the test hook's value by default. */
  stopAfterDocuments?: number | undefined;
  checkpoint?: (name: Checkpoint) => Promise<void>;
  /** The client-chosen id of a new document. */
  newId?: () => string;
}

/** Why a document was not written. */
export type SkipReason = 'edited-in-linear' | 'missing-in-linear' | 'conflict' | 'renamed-to-unwritable';

export interface WriteResult {
  /** Every change was made and recorded with a merge commit, or there was nothing to take in. */
  complete: boolean;
  /** Something was written to Linear or a state ref moved. */
  changed: boolean;
  code?: 'stopped' | 'write-failed' | 'state-moved';
  /** Content written to existing documents (a rename or move may come with it). */
  updated: string[];
  /** Documents renamed (new title) or moved to another project or team: from → to. */
  relocated: Array<{ from: string; to: string }>;
  created: string[];
  /** Documents of removed files, now in Linear's trash. */
  trashed: string[];
  /** Created by an earlier run that stopped before recording the id; found by title and written. */
  adopted: string[];
  skipped: Array<{ path: string; reason: SkipReason }>;
  /** Synchronized files the sync leaves out (lint, title, collisions); their documents stay as they were. */
  leftOut: Array<{ path: string; rules: string[] }>;
  /** Left out by a transform while writing. */
  leftOutAtWrite: LeftOutAtWrite[];
  failed: FailedWrite[];
  notAttempted: string[];
  stopped?: WriteStop;
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
  const identity = options.identity ?? SYNC_IDENTITY;
  const rereadBatch = Math.max(1, options.rereadBatch ?? REREAD_BATCH);
  const stopAfter = 'stopAfterDocuments' in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint = options.checkpoint ?? ((name: Checkpoint) => testCheckpoint(name));
  const newId = options.newId ?? randomUUID;
  const expected: StateSnapshot = { ...options.state };
  const tracked = fetched.tracked;
  const linearTip = expected.linear;
  if (linearTip === null) throw new Error('the sync writes to Linear only after initial sync has recorded `linear`');

  const result: WriteResult = {
    complete: false,
    changed: false,
    updated: [],
    relocated: [],
    created: [],
    trashed: [],
    adopted: [],
    skipped: [],
    leftOut: [],
    leftOutAtWrite: [],
    failed: [],
    notAttempted: [],
    record: null,
    state: { ...expected },
  };
  if (await alreadyMerged(git, linearTip, tracked)) {
    result.complete = true;
    return result;
  }

  // Step 3.
  const ids = await readIds(git, expected.ids);
  const reserved = await readReservedIds(git, expected.ids);
  const merge = await mergeLocally(git, linearTip, tracked, ids, linear.facts);
  result.leftOut = merge.leftOut;
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
  const adoptable = await adoptableDocuments(creates);
  const documentIds = new Map<string, string>();
  for (const [path, entry] of ids) documentIds.set(path, entry.id);
  for (const change of merge.changes) if (change.kind === 'keep') documentIds.set(change.to, change.id);
  // A new document left out by an earlier run keeps the id it was given, since other documents may link to it.
  for (const change of creates) documentIds.set(change.path, adoptable.get(change.path)?.id ?? reserved.get(change.path) ?? newId());

  /** What Linear stores now for each path whose document this run wrote. */
  const stored = new Map<string, string>();
  const nextIds: IdMap = new Map(ids);
  // A file that moved and kept its title, place and text (a renamed project folder): Linear needs nothing, the id map follows the file.
  for (const change of merge.unchanged) {
    if (change.from === change.to) continue;
    nextIds.set(change.to, nextIds.get(change.from) as IdEntry);
    nextIds.delete(change.from);
    documentIds.set(change.to, change.id);
  }
  // Reserved ids of files still in the tree; a file that is gone frees its id.
  const nextReserved = new Map([...reserved].filter(([path]) => resultFiles.has(path)));
  /** Paths of the merge result whose changes were not made: the record keeps the `linear` tip's version. */
  const notDone: DocumentChange[] = [];

  let written = 0;
  try {
    // The tip's side only computes what Linear should hold: it never uploads. It reads the cache as the run found it,
    // before any upload of this run (preparing may upload ahead of the writes), so this run's uploads never count as
    // what Linear held.
    const tipUploads = new Map(uploads);
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
    for (let start = 0; start < changes.length; start += rereadBatch) {
      const batch = changes.slice(start, start + rereadBatch);
      let current: Map<string, LinearDocument>;
      try {
        current = await reread(batch);
      } catch (error) {
        if (error instanceof LinearStoppedError) stopAt(start, error.reason);
        if (!(error instanceof LinearError)) throw error;
        // The batch cannot be checked against Linear, so none of it is written.
        for (const change of batch) result.failed.push({ path: changePath(change), operation: error.operation, error: describeError(error) });
        notDone.push(...batch);
        continue;
      }
      await checkpoint('after-reread-before-write');
      for (let index = 0; index < batch.length; index += 1) {
        const change = batch[index] as DocumentChange;
        const stop = linear.stopped ?? (stopAfter !== undefined && written >= stopAfter ? { kind: 'test-threshold' as const, documents: stopAfter } : undefined);
        if (stop !== undefined) stopAt(start + index, stop);
        const path = changePath(change);
        try {
          const done = await apply(change, current);
          if (done) written += 1;
          else notDone.push(change);
        } catch (error) {
          if (error instanceof LeaveOutError) {
            result.leftOutAtWrite.push(error.files.length > 0 ? { path, rule: error.rule, files: [...error.files] } : { path, rule: error.rule });
            if (change.kind === 'create') nextReserved.set(path, documentIds.get(path) as string);
            notDone.push(change);
            continue;
          }
          // The write may have been applied; the next run reads it again.
          if (error instanceof LinearStoppedError) stopAt(start + index, error.reason);
          if (error instanceof LinearError) {
            result.failed.push({ path, operation: error.operation, error: describeError(error) });
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
    if (!(error instanceof StopWriting)) throw error;
  }
  if (written > 0) result.changed = true;

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
   * changes.
   */
  async function findLinkedFileChanges(): Promise<void> {
    if (transforms.length === 0) return;
    const changedNames = new Set<string>();
    for (const path of new Set([...linearFiles.keys(), ...resultFiles.keys()])) {
      if (!path.endsWith('.md') && linearFiles.get(path) !== resultFiles.get(path)) changedNames.add(path.slice(path.lastIndexOf('/') + 1));
    }
    if (changedNames.size === 0) return;
    for (const change of merge.unchanged) {
      const next = merge.result.get(change.to) as SideFile;
      const previous = merge.linear.get(change.from) as SideFile;
      const text = textOf(next);
      // A cheap filter first: a link to a changed file names it.
      if (![...changedNames].some((name) => text.includes(name) || text.includes(encodeURI(name)) || text.includes(encodeURIComponent(name)))) continue;
      let differs: boolean;
      try {
        const written = await transformBody(transforms, change.to, splitFile(text).body);
        differs = written !== (await transformBody(tipTransforms, change.from, splitFile(textOf(previous)).body));
      } catch (error) {
        // Left out or stopped: the write reports it, or stops before it.
        if (!(error instanceof LeaveOutError) && !(error instanceof LinearStoppedError) && !(error instanceof UploadRefusedError)) throw error;
        differs = true;
      }
      if (differs) merge.changes.push({ ...change, content: true });
    }
    merge.changes.sort((a, b) => compare(changePath(a), changePath(b)));
  }

  /** Live, unmapped documents with the title of a new file in its place, from a run that created them and stopped. */
  async function adoptableDocuments(changes: readonly CreateChange[]): Promise<Map<string, LinearDocument>> {
    const found = new Map<string, LinearDocument>();
    if (changes.length === 0) return found;
    const mapped = new Set([...ids.values()].map((entry) => entry.id));
    const byPlace = new Map<string, { place: Place; paths: string[] }>();
    for (const change of changes) {
      const file = merge.result.get(change.path) as SideFile;
      const key = JSON.stringify(placeId(targets, file.place));
      const group = byPlace.get(key) ?? { place: file.place, paths: [] };
      group.paths.push(change.path);
      byPlace.set(key, group);
    }
    for (const { place, paths } of byPlace.values()) {
      const listed = await linear.listDocuments(placeId(targets, place), { withContent: false });
      const oldestFirst = [...listed].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
      for (const path of paths) {
        const title = (merge.result.get(path) as SideFile).title.normalize('NFC');
        const document = oldestFirst.find((candidate) => !mapped.has(candidate.id) && candidate.title.normalize('NFC') === title);
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
    const documents = wanted.length === 0 ? [] : await linear.getDocuments(wanted, { withContent: true });
    return new Map(documents.map((document) => [document.id, document]));
  }

  /**
   * Whether Linear still holds what the `linear` tip says: the capture has
   * seen the document as it is now. Compared in Linear's form: the tip's
   * file through the transforms (images become their cached upload URLs).
   */
  async function unchangedSinceCapture(document: LinearDocument, file: SideFile | undefined): Promise<boolean> {
    if (document.trashed || document.archivedAt !== null) return false;
    // The tip's file was left out (a lint finding): Linear keeps an older text the tip does not show.
    if (file === undefined) return true;
    // Capture can encode a title or assign a stable collision suffix.
    const folder = file.path.slice(0, -(file.title.length + '.md'.length)).replace(/\/$/, '');
    const occupied = new Set([...linearFiles.keys()].filter((path) => path !== file.path));
    if (documentPath(folder, document.title, document.id, occupied, file.path) !== file.path) return false;
    // Moved to another project or team in Linear: that move is the capture's to take in. A place the setup no longer
    // resolves (an annotation now names another project) cannot be checked.
    if (resolves(file.place) && !inPlace(document, file.place)) return false;
    let expected: string;
    try {
      expected = await transformBody(tipTransforms, file.path, splitFile(textOf(file)).body);
    } catch (error) {
      // The tip's file cannot be put in Linear's form (a file it links to is gone): nothing to compare with.
      if (error instanceof LeaveOutError || error instanceof UploadRefusedError) return true;
      throw error;
    }
    return (document.content ?? '') === expected;
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
    if (!(await unchangedSinceCapture(document, merge.linear.get(change.path)))) return skip(change.path, 'edited-in-linear');
    await linear.trashDocument(change.id);
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
      (patch.content === undefined || document.content === patch.content) &&
      (patch.title === undefined || document.title.normalize('NFC') === patch.title) &&
      (!change.place || inPlace(document, file.place));
    if (holds) {
      // Linear already holds the change: written by a run that stopped before recording it, or kept back by a partial record.
      if (patch.content !== undefined) {
        stored.set(change.to, document.content ?? '');
        readBack = document;
      }
    } else {
      if (!(await unchangedSinceCapture(document, merge.linear.get(change.from)))) return skip(change.to, 'edited-in-linear');
      if (written === 0) await checkpoint('before-write');
      const updated = await linear.updateDocument(change.id, patch);
      // Without a content write the merge result's file stands: Linear holds its body already.
      if (patch.content !== undefined) {
        stored.set(change.to, updated.content ?? '');
        readBack = updated;
      }
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
    if (written === 0) await checkpoint('before-write');
    const adopted = adoptable.get(change.path);
    let document: LinearDocument;
    if (adopted !== undefined) {
      const live = current.get(adopted.id);
      document = live !== undefined && live.content === body ? live : await linear.updateDocument(adopted.id, { content: body });
      result.adopted.push(change.path);
    } else {
      document = await linear.createDocument(placeId(targets, file.place), { id, title: file.title.normalize('NFC'), content: body });
      await checkpoint('document-created-before-ids-push');
    }
    stored.set(change.path, document.content ?? '');
    nextIds.set(change.path, { id: document.id });
    result.created.push(change.path);
    await reconcileMark(change.path, document);
    return true;
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
    const next = await commitIds(git, expected.ids, nextIds, identity, { message: IDS_MESSAGE, reserved: nextReserved });
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
    for (const [path, content] of stored) {
      const file = merge.result.get(path) as SideFile;
      const text = splitFile(textOf(file)).head + restoreBody(transforms, path, content);
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
    const idsCommit = await commitIds(git, expected.ids, nextIds, identity, { message: IDS_MESSAGE, reserved: nextReserved });
    const uploadsCommit = expected.uploads === null && uploads.size === 0 ? null : await commitUploads(git, expected.uploads, uploads, identity);

    const updates: RefUpdate[] = [
      { ref: stateRef(options.config, 'linear'), expected: linearTip, next: commit },
      { ref: stateRef(options.config, 'ids'), expected: expected.ids, next: idsCommit },
    ];
    if (uploadsCommit !== null) updates.push({ ref: stateRef(options.config, 'uploads'), expected: expected.uploads, next: uploadsCommit });
    const pushed = await pushAtomic(git, options.config, updates);
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
    super('FileUpload', 'a linked file is not in the upload cache');
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

/** The paths of the record a change touches. */
function pathsOf(change: DocumentChange): string[] {
  if (change.kind === 'keep') return change.from === change.to ? [change.to] : [change.from, change.to];
  return [change.path];
}

function describeError(error: LinearError): string {
  const code = (error as { code?: unknown }).code;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return [error.name, typeof code === 'string' ? code : undefined, typeof status === 'number' ? `HTTP ${status}` : undefined].filter(Boolean).join(' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
