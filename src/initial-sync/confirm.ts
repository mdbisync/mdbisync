// The confirmed initial sync from git to Linear: makes Linear equal to the
// tracked branch and records the starting state.
//
// 1. Plan as the dry run does, listing documents with their content.
// 2. Write, in path order: a matched document gets the file's body (same
//    document, so its id, comments and history stay); a file without a
//    document gets a new one. A document that already holds the body is
//    not written. Ids are pushed to the `ids` state ref as the run goes, in
//    progress commits.
// 3. Move the documents without a file to Linear's trash.
// 4. Record: one atomic push of the final `ids`, `uploads` (created when
//    missing) and `linear`, a commit whose parent is the tracked branch and
//    whose tree is the tracked tree with each synchronized file's body
//    replaced by what Linear stored.
//
// A run that stops (rate limit, low budget, a rejected write) records no
// `linear`. Run again with the same inputs: while the `ids` tip is a
// progress commit, recorded documents are skipped, and a document created
// just before a crash, before its id was pushed, is matched by its title
// like any other. Run again after the state is lost and the refs are
// rebuilt, without duplicates.

import { randomUUID } from 'node:crypto';
import { splitFile } from '../format/index.ts';
import {
  DocumentTooLongError,
  type LinearDocument,
  LinearError,
  LinearReadBackError,
  LinearStoppedError,
  type StopReason,
} from '../linear/index.ts';
import { type RunContext } from '../run/preflight.ts';
import {
  type CommitIdentity,
  type IdMap,
  type Oid,
  type RefUpdate,
  type StateConfig,
  type StateSnapshot,
  INITIAL_SYNC_PROGRESS,
  commitIds,
  initialSyncProgressMessage,
  readInitialSyncProgress,
  readReservedIds,
  commitTree,
  commitUploads,
  pushAtomic,
  readIds,
  readUploads,
  stateRef,
} from '../state/index.ts';
import { type Checkpoint, checkpoint as testCheckpoint, testStopAfterDocuments } from '../test-hooks.ts';
import { type CreateEntry, type InitialSyncPlan, type OverwriteEntry, placeId, planInitialSync } from './plan.ts';
import { readPlanSources } from './run.ts';
import { type BodyTransform, LeaveOutError, restoreBody, transformBody } from './transform.ts';

/** The subject of an `ids` commit made while an initial sync is still writing. */
export const PROGRESS_MESSAGE = INITIAL_SYNC_PROGRESS;
export const FINAL_IDS_MESSAGE = 'Initial sync: document ids';
export const RECORD_MESSAGE = "Initial sync: Linear's state";
export const UPLOADS_MESSAGE = 'Initial sync: upload cache';

/** Who the state commits are by. */
export const SYNC_IDENTITY: CommitIdentity = Object.freeze({ name: 'mdbisync', email: 'mdbisync@sync.invalid' });

/** Documents written between two progress pushes of `ids`. */
export const PROGRESS_BATCH = 25;

export interface ConfirmOptions {
  config: StateConfig;
  transforms?: readonly BodyTransform[];
  identity?: CommitIdentity;
  progressBatch?: number;
  /** Stop after this many written documents, as if the budget ran low; the test hook's value by default. */
  stopAfterDocuments?: number | undefined;
  checkpoint?: (name: Checkpoint) => Promise<void>;
  /** The client-chosen id of a new document, so a retried create cannot make a duplicate. */
  newId?: () => string;
}

/** Why the run stopped writing: the Linear client stopped, or a test threshold. */
export type WriteStop = StopReason | { kind: 'test-threshold'; documents: number };

export interface FailedWrite {
  path: string;
  operation: string;
  /** The error's class and Linear's code; never content. */
  error: string;
}

export interface ConfirmedResult {
  /** Every document written, every extra one trashed and the state recorded. */
  complete: boolean;
  /** Why not complete. */
  code?: 'stopped' | 'write-failed' | 'state-moved';
  /** The run continued an unfinished one: documents it had recorded were skipped. */
  resumed: boolean;
  created: string[];
  overwritten: string[];
  /** Matched documents that already held the body. */
  unchanged: string[];
  /** Recorded by the unfinished run this one continued; not read or written again. */
  skippedCompleted: string[];
  /** Paths where a document without a file would be; the documents are in Linear's trash. */
  trashed: string[];
  /** Files a transform left out while writing, with its rule. */
  leftOutAtWrite: Array<{ path: string; rule: string }>;
  failed: FailedWrite[];
  /** Paths not written because the run stopped first, the interrupted one included. */
  notAttempted: string[];
  stopped?: WriteStop;
  /** `ids` pushes while writing. */
  progressPushes: number;
  /** Every document this run wrote has its id in the `ids` ref (false only when a ref moved under the run). */
  progressRecorded: boolean;
  record: RecordResult | null;
}

export interface RecordResult {
  linear: Oid;
  /** False when the `linear` ref already held this record (nothing changed). */
  moved: boolean;
  /** Synchronized files whose recorded text differs from the tracked branch: Linear reformatted them. */
  reformatted: string[];
  /** The record commit's parents, as read back from git. */
  parents: Oid[];
  /** Its one parent is the tracked commit the run wrote from. */
  hasTrackedParent: boolean;
}

class StateMovedError extends Error {
  constructor() {
    super('a state ref moved while the run was writing');
    this.name = 'StateMovedError';
  }
}

type Work = { kind: 'create'; entry: CreateEntry } | { kind: 'overwrite'; entry: OverwriteEntry };

export async function confirmInitialSync(context: RunContext, options: ConfirmOptions): Promise<{ plan: InitialSyncPlan; result: ConfirmedResult }> {
  const { git, fetched, targets, linear } = context;
  const transforms = options.transforms ?? [];
  const identity = options.identity ?? SYNC_IDENTITY;
  const batch = Math.max(1, options.progressBatch ?? PROGRESS_BATCH);
  const stopAfter = 'stopAfterDocuments' in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint = options.checkpoint ?? ((name: Checkpoint) => testCheckpoint(name));
  const newId = options.newId ?? randomUUID;

  const sources = await readPlanSources(context, { withContent: true });
  const plan = planInitialSync(sources.input);
  const texts = sources.input.texts;

  const expected: StateSnapshot = { ...fetched.state };
  const resumed = (await readInitialSyncProgress(git, expected.ids)) !== null;
  const previous = await readIds(git, expected.ids);
  const ids: IdMap = resumed ? new Map(previous) : new Map();
  const uploads = await readUploads(git, expected.uploads);
  const uploadsAtStart = uploads.size;
  /** What Linear stores for each synchronized path. */
  const stored = new Map<string, string>();

  const result: ConfirmedResult = {
    complete: false,
    resumed,
    created: [],
    overwritten: [],
    unchanged: [],
    skippedCompleted: [],
    trashed: [],
    leftOutAtWrite: [],
    failed: [],
    notAttempted: [],
    progressPushes: 0,
    progressRecorded: true,
    record: null,
  };

  const remember = (path: string, document: LinearDocument) => {
    const before = previous.get(path);
    ids.set(path, before !== undefined && before.id === document.id && before.saved !== undefined ? { id: document.id, saved: before.saved } : { id: document.id });
    stored.set(path, document.content ?? '');
  };

  let unpushed = 0;
  const pushProgress = async () => {
    const updates: RefUpdate[] = [];
    const idsCommit = await commitIds(git, expected.ids, ids, identity, { message: initialSyncProgressMessage(fetched.tracked), always: true });
    updates.push({ ref: stateRef(options.config, 'ids'), expected: expected.ids, next: idsCommit });
    if (uploads.size !== uploadsAtStart || expected.uploads !== null) {
      const uploadsCommit = await commitUploads(git, expected.uploads, uploads, identity);
      updates.push({ ref: stateRef(options.config, 'uploads'), expected: expected.uploads, next: uploadsCommit });
    }
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) throw new StateMovedError();
    expected.ids = idsCommit;
    if (updates.length > 1) expected.uploads = (updates[1] as RefUpdate).next;
    result.progressPushes += 1;
    unpushed = 0;
  };

  const work: Work[] = [
    ...plan.overwrite.map((entry): Work => ({ kind: 'overwrite', entry })),
    ...plan.create.map((entry): Work => ({ kind: 'create', entry })),
  ].sort((a, b) => compare(a.entry.path, b.entry.path));

  // Every synchronized path's document id, known before the first write, so
  // a transform can link to a document this run has yet to create. A new
  // document's id is chosen here; a resumed run reuses the id its unfinished
  // run chose (kept in the progress commits), so links written before the
  // stop stay right.
  const documentIds = new Map<string, string>();
  for (const entry of plan.overwrite) documentIds.set(entry.path, entry.documentId);
  // A file left out while writing on an earlier run keeps the id reserved for it then.
  const reserved = await readReservedIds(git, expected.ids);
  for (const entry of plan.create) {
    const chosen = (resumed ? previous.get(entry.path)?.id : undefined) ?? reserved.get(entry.path);
    documentIds.set(entry.path, chosen !== undefined && !sources.documents.has(chosen) ? chosen : newId());
    ids.set(entry.path, { id: documentIds.get(entry.path) as string });
  }

  try {
    for (const transform of transforms) await transform.prepare?.({ git, tracked: fetched.tracked, linear, plan, uploads, documentIds });

    let written = 0;
    let beforeWriteReached = false;
    for (let index = 0; index < work.length; index += 1) {
      const item = work[index] as Work;
      const { path } = item.entry;
      const stop = linear.stopped ?? (stopAfter !== undefined && written >= stopAfter ? { kind: 'test-threshold' as const, documents: stopAfter } : undefined);
      if (stop !== undefined) {
        result.stopped = stop;
        result.notAttempted = work.slice(index).map((rest) => rest.entry.path);
        break;
      }

      const document = item.kind === 'overwrite' ? sources.documents.get(item.entry.documentId) : undefined;
      if (item.kind === 'overwrite' && document === undefined) throw new Error(`the planned document for ${path} was not listed`);

      try {
        const body = await transformBody(transforms, path, splitFile(texts.get(path) as string).body);
        // A document already holding the body is not written again. On a
        // resumed run, that is how the documents the stopped run wrote are
        // skipped; one whose file or Linear text changed since is written.
        if (document !== undefined && document.content === body) {
          const completed = resumed && previous.get(path)?.id === document.id;
          (completed ? result.skippedCompleted : result.unchanged).push(path);
          remember(path, document);
          continue;
        }
        if (!beforeWriteReached) {
          beforeWriteReached = true;
          await checkpoint('before-write');
        }
        if (item.kind === 'create') {
          // Matching compares titles in NFC; a new title is written in that form too, so the next run matches it.
          const title = item.entry.title.normalize('NFC');
          const id = documentIds.get(path) as string;
          const created = await linear.createDocument(placeId(targets, item.entry.place), { id, title, content: body });
          remember(path, created);
          result.created.push(path);
          await checkpoint('document-created-before-ids-push');
        } else {
          const updated = await linear.updateDocument(item.entry.documentId, { content: body });
          remember(path, updated);
          result.overwritten.push(path);
        }
        written += 1;
        unpushed += 1;
      } catch (error) {
        if (error instanceof LeaveOutError) {
          result.leftOutAtWrite.push({ path, rule: error.rule });
          continue;
        }
        if (error instanceof DocumentTooLongError) {
          // Refused before any request: the body grew past Linear's limit in a transform.
          result.leftOutAtWrite.push({ path, rule: 'content-too-long' });
          continue;
        }
        if (error instanceof LinearStoppedError) {
          // The write may have been applied; the next run matches it by title.
          result.stopped = error.reason;
          result.notAttempted = work.slice(index).map((rest) => rest.entry.path);
          break;
        }
        if (error instanceof LinearReadBackError) {
          // Written, but what Linear stored is unknown: keep the id, and let the next run read the content.
          ids.set(path, { id: error.document.id });
          unpushed += 1;
        }
        if (error instanceof LinearError) {
          result.failed.push({ path, operation: error.operation, error: describeError(error) });
          continue;
        }
        throw error;
      }
      if (unpushed >= batch) await pushProgress();
    }

    const writesDone = result.stopped === undefined && result.failed.length === 0;
    if (writesDone) {
      for (let index = 0; index < plan.trash.length; index += 1) {
        const entry = plan.trash[index] as (typeof plan.trash)[number];
        if (linear.stopped !== undefined) {
          result.stopped = linear.stopped;
          result.notAttempted = plan.trash.slice(index).map((rest) => rest.path);
          break;
        }
        try {
          await linear.trashDocument(entry.documentId);
          result.trashed.push(entry.path);
        } catch (error) {
          if (error instanceof LinearStoppedError) {
            result.stopped = error.reason;
            result.notAttempted = plan.trash.slice(index).map((rest) => rest.path);
            break;
          }
          if (error instanceof LinearError) {
            result.failed.push({ path: entry.path, operation: error.operation, error: describeError(error) });
            continue;
          }
          throw error;
        }
      }
    }

    if (result.stopped !== undefined || result.failed.length > 0) {
      if (unpushed > 0) await pushProgress();
      result.code = result.stopped !== undefined ? 'stopped' : 'write-failed';
      return { plan, result };
    }

    await checkpoint('after-write-before-record');
    const recorded = await record();
    if (recorded === null) {
      result.code = 'state-moved';
      result.progressRecorded = unpushed === 0;
      return { plan, result };
    }
    result.record = recorded;
    result.complete = true;
    return { plan, result };
  } catch (error) {
    if (error instanceof StateMovedError) {
      result.code = 'state-moved';
      result.progressRecorded = unpushed === 0;
      return { plan, result };
    }
    // A bug or a git failure: keep what was written before giving up.
    if (unpushed > 0) await pushProgress().catch(() => undefined);
    throw error;
  }

  /** Builds `linear`, the final `ids` and `uploads`, and pushes them together. Null when a ref moved. */
  async function record(): Promise<RecordResult | null> {
    const synced = new Set([...result.created, ...result.overwritten, ...result.unchanged, ...result.skippedCompleted]);
    const finalIds: IdMap = new Map([...ids].filter(([path]) => synced.has(path)));

    const changes = new Map<string, string>();
    const reformatted: string[] = [];
    for (const path of [...synced].sort(compare)) {
      const text = texts.get(path) as string;
      const file = splitFile(text).head + restoreBody(transforms, path, stored.get(path) ?? '');
      if (file !== text) {
        changes.set(path, file);
        reformatted.push(path);
      }
    }
    const tracked = fetched.tracked;
    let linearCommit = await commitTree(git, { parents: [tracked], base: tracked, changes, message: RECORD_MESSAGE, identity, skipIfUnchanged: false });
    if (expected.linear !== null && (await sameRecord(expected.linear, linearCommit))) linearCommit = expected.linear;

    // New documents left out while writing keep their chosen ids, which other documents may link to.
    const created = new Set(plan.create.map((entry) => entry.path));
    const stillReserved = new Map(
      result.leftOutAtWrite.filter(({ path }) => created.has(path)).map(({ path }) => [path, documentIds.get(path) as string]),
    );
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      reserved: stillReserved,
      message: FINAL_IDS_MESSAGE,
      always: (await readInitialSyncProgress(git, expected.ids)) !== null,
    });
    const uploadsCommit = await commitUploads(git, expected.uploads, uploads, identity);
    const updates: RefUpdate[] = [
      { ref: stateRef(options.config, 'ids'), expected: expected.ids, next: idsCommit },
      { ref: stateRef(options.config, 'uploads'), expected: expected.uploads, next: uploadsCommit },
      // Initial sync replaces `linear`: its new record does not descend from an earlier one.
      { ref: stateRef(options.config, 'linear'), expected: expected.linear, next: linearCommit, replace: true },
    ];
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    const parents = (await git.text(['show', '-s', '--format=%P', linearCommit])).split(' ').filter(Boolean);
    const hasTrackedParent = parents.length === 1 && parents[0] === tracked;
    return { linear: linearCommit, moved: linearCommit !== expected.linear, reformatted, parents, hasTrackedParent };
  }

  /** Whether two record commits have the same tree and parents, so the newer one adds nothing. */
  async function sameRecord(a: Oid, b: Oid): Promise<boolean> {
    const describe = (oid: Oid) => git.text(['show', '-s', '--format=%T %P', oid]);
    return (await describe(a)) === (await describe(b));
  }
}

function describeError(error: LinearError): string {
  const code = (error as { code?: unknown }).code;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return [error.name, typeof code === 'string' ? code : undefined, typeof status === 'number' ? `HTTP ${status}` : undefined].filter(Boolean).join(' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
