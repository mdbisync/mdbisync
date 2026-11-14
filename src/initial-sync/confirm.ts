// The confirmed initial sync from git to Linear: makes Linear equal to the
// tracked branch and records the starting state.
//
// 1. Plan as the dry run does, listing documents with their content.
// 2. Write, in path order: a matched document gets the file's body (same
//    document, so its id, comments and history stay); a file without a
//    document gets a new one. A document that already holds the body is
//    not written. Ids are pushed to the `ids` state ref as the run goes, in
//    progress commits. A document whose text holds a conflict gets the
//    conflict mark and its comment, as the sync's write step gives it.
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

import { assessCapacity, capacityBlocked } from '../run/capacity.ts';
import { createHash, randomUUID } from 'node:crypto';
import { fixText, joinFile, sameMarkdown, splitFile } from '../format/index.ts';
import {
  DocumentTooLongError,
  type LinearDocument,
  LinearError,
  LinearReadBackError,
  LinearStoppedError,
  type StopReason, describeLinearError } from '../linear/index.ts';
import { type RunContext } from '../run/preflight.ts';
import {
  type CommitIdentity,
  type Git,
  type IdMap,
  type Oid,
  type RefUpdate,
  type StateConfig,
  type StateSnapshot,
  INITIAL_SYNC_FROM_LINEAR_RECORD,
  INITIAL_SYNC_PROGRESS,
  commitIds,
  initialSyncProgressMessage,
  readInitialSyncProgress,
  readReservedIds,
  readWrittenHashes,
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
import { type BodyTransform, LeaveOutError, restoreBody, sameLinkDestinations, transformBody } from './transform.ts';
import { detectConflicts } from '../merge/index.ts';
import { type ConflictNotices, MARKS, noConflictNotices, reconcileDocumentMark } from '../sync/marks.ts';
import { withRecorded } from '../sync/recorded.ts';
import { stableId } from '../sync/stable-id.ts';
import { message } from '../messages.ts';
import { type LeftOutAtWriteRule, type WriteCode } from '../codes.ts';

/** The subject of an `ids` commit made while an initial sync is still writing. */
export const PROGRESS_MESSAGE = INITIAL_SYNC_PROGRESS;
export const FINAL_IDS_MESSAGE = 'Initial sync: document ids';

const KEPT_ANNOTATION = /^Kept-annotation: (".*")$/gm;

/**
 * The trailer of an initial sync's final `ids` commit that names a folder's
 * README it kept, body included, without a document: Linear has none for it.
 */
export function keptAnnotationTrailer(path: string): string {
  return `Kept-annotation: ${JSON.stringify(path)}`;
}

/**
 * The trailer of a sync's `ids` commit that records the kept READMEs anew,
 * after the tracked branch moved one (its folder renamed): the
 * `Kept-annotation:` trailers of that commit are the whole set.
 */
export const KEPT_ANNOTATIONS_RECORDED = 'Kept-annotations: recorded';

/** The trailers that record `kept` as the whole set of kept READMEs, in path order. */
export function keptAnnotationsTrailers(kept: Iterable<string>): string[] {
  return [KEPT_ANNOTATIONS_RECORDED, ...[...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(keptAnnotationTrailer)];
}

/**
 * The READMEs kept without a document: named by the latest initial sync's
 * final `ids` commit, or by a later sync's `ids` commit that recorded the set
 * after one moved.
 */
export async function readKeptAnnotations(git: Git, ids: Oid | null): Promise<Set<string>> {
  if (ids === null) return new Set();
  const log = await git.text(['log', '--format=%B', '--fixed-strings', `--grep=${FINAL_IDS_MESSAGE}`, `--grep=${KEPT_ANNOTATIONS_RECORDED}`, '-1', ids]);
  const lines = log.split('\n');
  if (lines[0] !== FINAL_IDS_MESSAGE && !lines.includes(KEPT_ANNOTATIONS_RECORDED)) return new Set();
  return new Set([...log.matchAll(KEPT_ANNOTATION)].map((match) => JSON.parse(match[1] as string) as string));
}
export const RECORD_MESSAGE = "Initial sync: Linear's state";
/** The subjects of an initial sync's record, in either direction. */
export const INITIAL_RECORD_SUBJECTS: ReadonlySet<string> = new Set([RECORD_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD]);
export const UPLOADS_MESSAGE = 'Initial sync: upload cache';

/** Documents written between two progress pushes of `ids`. */
export const PROGRESS_BATCH = 25;

export interface ConfirmOptions {
  documentCap?: number | undefined;
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

/** A file a transform left out while writing: its rule, and the files that caused it when there are any. */
export interface LeftOutAtWrite {
  path: string;
  rule: LeftOutAtWriteRule;
  files?: string[];
}

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
  code?: WriteCode;
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
  leftOutAtWrite: LeftOutAtWrite[];
  failed: FailedWrite[];
  /** Paths not written because the run stopped first, the interrupted one included. */
  notAttempted: string[];
  stopped?: WriteStop;
  /** `ids` pushes while writing. */
  progressPushes: number;
  /** Every document this run wrote has its id in the `ids` ref (false only when a ref moved under the run). */
  progressRecorded: boolean;
  /** Documents whose conflict notice this run's marks set or resolved. */
  conflictNotices: ConflictNotices;
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
    super(message('initial-sync.state-moved'));
    this.name = 'StateMovedError';
  }
}

type Work = { kind: 'create'; entry: CreateEntry } | { kind: 'overwrite'; entry: OverwriteEntry };

export async function confirmInitialSync(context: RunContext, options: ConfirmOptions): Promise<{ plan: InitialSyncPlan; result: ConfirmedResult }> {
  const { git, fetched, targets, linear } = context;
  const transforms = options.transforms ?? [];
  const identity = options.identity ?? context.identity;
  const batch = Math.max(1, options.progressBatch ?? PROGRESS_BATCH);
  const stopAfter = 'stopAfterDocuments' in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint = options.checkpoint ?? ((name: Checkpoint) => testCheckpoint(name));
  const newId = options.newId ?? randomUUID;

  const sources = await readPlanSources(context, { withContent: true });
  const plan = planInitialSync(sources.input);
  plan.capacity = assessCapacity(context, sources.containers, plan.create, options.documentCap);
  const texts = sources.input.texts;

  const expected: StateSnapshot = { ...fetched.state };
  const resumed = (await readInitialSyncProgress(git, expected.ids)) !== null;
  const previous = await readIds(git, expected.ids);
  /** What the stopped run sent, by path, when this run resumes it; and what this run has sent. */
  const writtenBefore = resumed ? await readWrittenHashes(git, expected.ids) : new Map<string, string>();
  const sentHashes = new Map(writtenBefore);
  const ids: IdMap = resumed ? new Map(previous) : new Map();
  const uploads = await readUploads(git, expected.uploads);
  const uploadsAtStart = uploads.size;
  /** What Linear stores for each synchronized path, and the text this run sent or would send for it. */
  const stored = new Map<string, string>();
  const sent = new Map<string, string>();

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
    conflictNotices: noConflictNotices(),
    record: null,
  };

  if (capacityBlocked(plan.capacity)) {
    result.code = 'container-cap';
    result.notAttempted = [...plan.create, ...plan.overwrite, ...plan.trash].map((entry) => entry.path).sort();
    return { plan, result };
  }

  /** Each remembered document, as Linear returned it or listed it. */
  const rememberedDocuments = new Map<string, LinearDocument>();
  const remember = (path: string, document: LinearDocument) => {
    const before = previous.get(path);
    ids.set(path, before !== undefined && before.id === document.id && before.saved !== undefined ? { id: document.id, saved: before.saved } : { id: document.id });
    stored.set(path, document.content ?? '');
    rememberedDocuments.set(path, document);
  };

  let unpushed = 0;
  /** The upload cache's size at the last push; uploads made since are recorded even when no document was. */
  let uploadsPushed = uploads.size;
  const pushProgress = async () => {
    const updates: RefUpdate[] = [];
    const idsCommit = await commitIds(git, expected.ids, ids, identity, {
      message: initialSyncProgressMessage(fetched.tracked),
      always: true,
      written: sentHashes,
    });
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
    uploadsPushed = uploads.size;
  };

  /**
   * Sets or clears a synchronized document's status mark from the text Linear
   * stores, as the sync's write step does: conflict markers show the conflict
   * mark and its one comment, after the document's own icon and color are
   * pushed in `ids`. A document without a conflict and without a saved icon
   * costs no request. The comment's id follows from the document and the text
   * sent, so a run again after the state is lost finds the comment it posted
   * instead of adding a second one.
   */
  const reconcileMark = async (path: string, document: LinearDocument, hash: string, listed: LinearDocument = document) => {
    const entry = ids.get(path);
    if (entry === undefined || entry.id !== document.id || document.content === undefined) return;
    // Without a saved icon (the state was lost) a conflict mark Linear showed on a conflicted text before this run
    // wrote it (`listed`) is this tool's, not the document's own. On a text that held no conflict it is the
    // document's own icon, and it stays, even when this run writes a conflict into it.
    const shown = entry.saved === undefined && listed.icon === MARKS.conflict.icon && listed.color === MARKS.conflict.color
      && detectConflicts(listed.content ?? '').length > 0;
    await reconcileDocumentMark({
      document,
      entry: shown ? { ...entry, saved: { icon: null, color: null } } : entry,
      linear,
      noticeId: (state) => stableId('initial-sync', state, document.id, hash),
      onConflictNotice: (change) => result.conflictNotices[change].push(path),
      persistEntry: async (next) => {
        ids.set(path, next);
        await pushProgress();
      },
    });
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
  const saved = new Map<string, string>();
  for (const entry of plan.create) {
    const chosen = (resumed ? previous.get(entry.path)?.id : undefined) ?? reserved.get(entry.path);
    if (chosen !== undefined && !sources.documents.has(chosen)) saved.set(entry.path, chosen);
  }
  // An id absent from the listed containers may still exist elsewhere in
  // Linear. Check before reusing it: create refuses an existing id.
  const taken = new Set<string>();
  if (saved.size > 0) for (const document of await linear.getDocuments([...new Set(saved.values())])) taken.add(document.id);
  for (const entry of plan.create) {
    const chosen = saved.get(entry.path);
    documentIds.set(entry.path, chosen !== undefined && !taken.has(chosen) ? chosen : newId());
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
      if (item.kind === 'overwrite' && document === undefined) throw new Error(message('initial-sync.document-not-listed', { path }));

      try {
        const source = splitFile(texts.get(path) as string).body;
        const body = await transformBody(transforms, path, source);
        const hash = sha256(body);
        sent.set(path, body);
        // A resumed run skips what the stopped run wrote, as long as the text
        // to send is the same; a file changed since is written again.
        if (document !== undefined && resumed && previous.get(path)?.id === document.id && writtenBefore.get(path) === hash) {
          result.skippedCompleted.push(path);
          sentHashes.set(path, hash);
          remember(path, document);
          // The stopped run may have stopped between the write and the mark.
          await reconcileMark(path, document, hash);
          continue;
        }
        // A document already holding the body, as sent or in the form Linear
        // stores it, is not written again: files are often not in Linear's
        // form, and writing them again would change nothing but the
        // document's history. Linear's form can depend on what a transform
        // wrote (a link to an uploaded file is stored as a file), so the
        // content is also compared after the transforms' inverses, with the
        // file's own body. Normalize the restored text too: restoring document
        // links can put back their original spelling in otherwise formatted text.
        // That inverse comparison alone also accepts seeded relative links:
        // require stored destinations to match what was sent before using it.
        if (document !== undefined && (holdsBody(document.content ?? '', body) || (
          sameLinkDestinations(document.content ?? '', body)
          && holdsBody(fixText(restoreBody(transforms, path, document.content ?? '', body)), source)
        ))) {
          result.unchanged.push(path);
          remember(path, document);
          await reconcileMark(path, document, hash);
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
          sentHashes.set(path, hash);
          result.created.push(path);
          await checkpoint('document-created-before-ids-push');
          written += 1;
          unpushed += 1;
          await reconcileMark(path, created, hash);
        } else {
          const updated = await linear.updateDocument(item.entry.documentId, { content: body });
          remember(path, updated);
          sentHashes.set(path, hash);
          result.overwritten.push(path);
          written += 1;
          unpushed += 1;
          await reconcileMark(path, updated, hash, document);
        }
      } catch (error) {
        if (error instanceof LeaveOutError) {
          result.leftOutAtWrite.push(error.files.length > 0 ? { path, rule: error.rule, files: [...error.files] } : { path, rule: error.rule });
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
          result.failed.push({ path, operation: error.operation, error: describeLinearError(error) });
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
            result.failed.push({ path: entry.path, operation: error.operation, error: describeLinearError(error) });
            continue;
          }
          throw error;
        }
      }
    }

    if (result.stopped !== undefined || result.failed.length > 0) {
      // Always leave a progress commit: even a run that only trashed
      // documents has changed Linear, and the sync must not run on the old
      // state until initial sync finishes.
      if (unpushed > 0 || uploads.size !== uploadsPushed || (await readInitialSyncProgress(git, expected.ids)) === null) await pushProgress();
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
    if (unpushed > 0 || uploads.size !== uploadsPushed) await pushProgress().catch(() => undefined);
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
      const file = joinFile(splitFile(text).head, restoreBody(transforms, path, stored.get(path) ?? '', sent.get(path) as string));
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
    // The record holds what Linear returned for each document written or found holding its body: the first
    // capture need not read those again when the title and place are the file's too. One a resumed run skipped
    // was not read, so it is read again.
    const entries = new Map<string, CreateEntry | OverwriteEntry>([...plan.create, ...plan.overwrite].map((entry) => [entry.path, entry]));
    const recorded = new Map(
      [...result.created, ...result.overwritten, ...result.unchanged].flatMap((path) => {
        const document = rememberedDocuments.get(path);
        const entry = entries.get(path);
        if (document === undefined || entry === undefined) return [];
        const where = placeId(targets, entry.place);
        const placed = 'projectId' in where ? document.projectId === where.projectId : document.projectId === null && document.teamId === where.teamId;
        return placed && document.title.normalize('NFC') === entry.title.normalize('NFC') ? [[document.id, document.updatedAt] as const] : [];
      }),
    );
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      reserved: stillReserved,
      message: withRecorded(FINAL_IDS_MESSAGE, recorded),
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Whether Linear's content is the body: the same document in any spelling,
 * or the body in the form Linear stores (as the format module writes it).
 */
export function holdsBody(content: string, body: string): boolean {
  return sameMarkdown(content, body) || content === fixText(body);
}


function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
