// Cleanup and diagnostics for the Linear contract tests: the run removes only
// what it created, and a document it trashed never stays in the trash, even
// when an assertion stopped the test before its restore step.

import type { LinearClient, LinearDocument, LogEntry } from '../../src/linear/index.ts';

/** What the run created, and which of its documents a trash may have left in the trash. */
export interface OwnedRecords {
  projectIds: readonly string[];
  documentIds: readonly string[];
  /** A trash was sent and no restore confirmed since. */
  trashed: ReadonlySet<string>;
}

export interface CleanupError {
  operation: string;
  projectId?: string;
  documentId?: string;
  error: unknown;
}

/** A document's state as a read returned it, without content. */
export interface DocumentState {
  id: string;
  trashed: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface CleanupResult {
  errors: CleanupError[];
  /** Documents restored before their project was deleted. */
  restored: string[];
  /**
   * Restores refused for a document the read did not show trashed (its trash
   * may not have applied): not errors, since the final read decides.
   */
  unconfirmedRestoreFailures: CleanupError[];
  /** The owned documents as the last read after the project deletions returned them. */
  final: DocumentState[];
}

export interface CleanupOptions {
  /** Pause between the reads that verify the archival. */
  pauseMs?: number;
  /** Reads that verify the archival, at most; a later one only while an earlier one finds a problem. */
  verifyReads?: number;
}

/**
 * Restores every owned document that may still be in the trash, deletes the
 * owned projects (which archives their documents), then reads the documents
 * back: each must be archived and none trashed. Linear refuses to restore a
 * document whose project is gone, so the restore comes first. A document
 * may be in the trash when the read says so or when a trash was sent and no
 * restore confirmed, since a read right after a trash was once seen stale.
 * For the same reason the verifying read is repeated after a pause while it
 * finds a problem. Errors are collected, never thrown, so the test's own
 * failure stays first.
 */
export async function cleanUpOwned(linear: LinearClient, owned: OwnedRecords, options: CleanupOptions = {}): Promise<CleanupResult> {
  const { pauseMs = 2_000, verifyReads = 3 } = options;
  const result: CleanupResult = { errors: [], restored: [], unconfirmedRestoreFailures: [], final: [] };
  const confirmed = new Set<string>();
  if (owned.documentIds.length > 0) {
    try {
      for (const document of await linear.getDocuments(owned.documentIds)) {
        if (document.trashed) confirmed.add(document.id);
      }
    } catch (error) {
      result.errors.push({ operation: 'read owned documents', error });
    }
  }
  for (const id of new Set([...confirmed, ...owned.trashed])) {
    try {
      await linear.restoreDocument(id);
      result.restored.push(id);
    } catch (error) {
      (confirmed.has(id) ? result.errors : result.unconfirmedRestoreFailures).push({ operation: 'RestoreDocument', documentId: id, error });
    }
  }
  for (const id of owned.projectIds) {
    try {
      const data = await linear.request<{ projectDelete: { success: boolean } }>(
        'DeleteProject',
        'mutation',
        'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }',
        { id },
      );
      if (data.projectDelete.success !== true) throw new Error('DeleteProject: Linear reported success: false');
    } catch (error) {
      result.errors.push({ operation: 'DeleteProject', projectId: id, error });
    }
  }
  if (owned.documentIds.length > 0) {
    let problems: CleanupError[] = [];
    for (let read = 1; read <= verifyReads; read += 1) {
      if (read > 1) await pause(pauseMs);
      try {
        result.final = (await linear.getDocuments(owned.documentIds)).map(stateOf);
        problems = owned.documentIds.flatMap((id) => {
          const state = result.final.find((document) => document.id === id);
          const problem = state === undefined ? 'missing' : state.trashed ? 'still trashed' : state.archived ? undefined : 'not archived';
          return problem ? [{ operation: 'verify archived', documentId: id, error: new Error(`owned document ${problem}`) }] : [];
        });
      } catch (error) {
        problems = [{ operation: 'verify archived', error }];
      }
      if (problems.length === 0) break;
    }
    result.errors.push(...problems);
  }
  return result;
}

export function stateOf(document: LinearDocument): DocumentState {
  return { id: document.id, trashed: document.trashed, archived: document.archivedAt !== null, updatedAt: document.updatedAt };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One read of just-created documents: which of the asked ids came back, and when. */
export interface CreatedRead {
  /** Linear's request id of every attempt of this read, a retry included. */
  requestIds: Array<string | undefined>;
  /** The first attempt's start and the last attempt's answer. */
  startedAt: string | undefined;
  finishedAt: string | undefined;
  /** From the last create's answer to this read's answer, by the request log's clocks. */
  sinceCreateMs: number | undefined;
  returned: string[];
  missing: string[];
  /** The read failed; its error's name, never a server message. */
  error?: string;
}

/** Every read the contract made of the documents it had just created. */
export interface CreatedReadDiagnosis {
  /** Linear's request id of every attempt of the creates, a retry included. */
  createRequestIds: Array<string | undefined>;
  createsFinishedAt: string | undefined;
  pauseMs: number;
  maxReads: number;
  reads: CreatedRead[];
}

export interface CreatedReadOptions {
  /** Pause before each delayed read. */
  pauseMs?: number;
  /** Reads at most: the immediate one and the delayed ones. */
  maxReads?: number;
  /**
   * Receives the diagnosis before the first read; it is filled in place, so
   * the caller keeps every read also when one throws.
   */
  record?: (diagnosis: CreatedReadDiagnosis) => void;
}

/**
 * Reads documents right after their creates answered, and, while some asked
 * id is absent, again after a pause, at most `maxReads` times. Each read is
 * one GetDocuments request for all the ids, as the client sends it.
 *
 * Linear's reads can lag behind its writes: in a live batch, two of fifteen
 * runs read [] right after both creates had answered 200, while later
 * operations and cleanup found both documents. In the slower run the
 * documents were still absent from a read 1.4 s after the last create and
 * present 2.4 s after it. Three reads with two pauses of two seconds (about
 * four seconds) cover that with margin and match the cleanup's archival
 * verification budget; an id absent after them is a failure, not lag.
 *
 * Returns the last read's documents for the caller's exact assertions. The
 * diagnosis keeps every read's request ids, timing and ids, never content.
 * A read that throws is recorded and its error rethrown unchanged: a failed
 * request is not lag. Never repeats a write.
 */
export async function readCreated(
  linear: LinearClient,
  requests: readonly LogEntry[],
  ids: readonly string[],
  options: CreatedReadOptions = {},
): Promise<{ documents: LinearDocument[]; diagnosis: CreatedReadDiagnosis }> {
  const { pauseMs = 2_000, maxReads = 3 } = options;
  const creates = lastCalls(requests, 'CreateDocument', ids.length);
  const createsFinishedAt = creates.at(-1)?.finishedAt;
  const diagnosis: CreatedReadDiagnosis = { createRequestIds: creates.map((entry) => entry.requestId), createsFinishedAt, pauseMs, maxReads, reads: [] };
  options.record?.(diagnosis);
  let documents: LinearDocument[] = [];
  for (let read = 1; read <= maxReads; read += 1) {
    if (read > 1) await pause(pauseMs);
    const logged = requests.length;
    let failure: unknown;
    try {
      documents = await linear.getDocuments(ids, { withContent: true });
    } catch (error) {
      failure = error;
      documents = [];
    }
    const attempts = requests.slice(logged).filter((entry) => entry.operation === 'GetDocuments');
    const returned = documents.map((document) => document.id);
    const missing = ids.filter((id) => !returned.includes(id));
    const finishedAt = attempts.at(-1)?.finishedAt;
    diagnosis.reads.push({
      requestIds: attempts.map((entry) => entry.requestId),
      startedAt: attempts[0]?.startedAt,
      finishedAt,
      sinceCreateMs: finishedAt && createsFinishedAt ? Date.parse(finishedAt) - Date.parse(createsFinishedAt) : undefined,
      returned,
      missing,
      ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.name : 'Unknown error' }),
    });
    if (failure !== undefined) throw failure;
    if (missing.length === 0) break;
  }
  return { documents, diagnosis };
}

/** The log entries of an operation's last `calls` calls, every attempt of each (a call starts at attempt 1). */
export function lastCalls(requests: readonly LogEntry[], operation: string, calls: number): LogEntry[] {
  const entries = requests.filter((entry) => entry.operation === operation);
  let start = entries.length;
  for (let found = 0; found < calls && start > 0; ) {
    start -= 1;
    if (entries[start]!.attempt === 1) found += 1;
  }
  return entries.slice(start);
}

/** An unconfirmed read after trash, and the one permitted delayed read. */
export interface TrashReadDiagnosis {
  trashRequestId: string | undefined;
  trashFinishedAt: string | undefined;
  immediate: (DocumentState | { absent: true }) & { requestId: string | undefined };
  delayed:
    | (DocumentState & { requestId: string | undefined; afterMs: number; elapsedMs: number })
    | { requestId: string | undefined; afterMs: number; elapsedMs: number; absent: true }
    | { requestId: string | undefined; afterMs: number; elapsedMs: number; error: string };
}

/**
 * Allows at most one delayed read after an absent or stale immediate read.
 * The default pause is two seconds, matching observed backend consistency
 * lag. This is a read budget (two requests, one pause), not a transport
 * deadline. The caller must assert that the final read confirms trash.
 * Records only request ids, timing and state; never retries a write.
 */
export async function diagnoseTrashRead(
  linear: LinearClient,
  requests: readonly LogEntry[],
  documentId: string,
  immediate: LinearDocument | undefined,
  pauseMs = 2_000,
): Promise<TrashReadDiagnosis> {
  const last = (operation: string) => requests.findLast((entry) => entry.operation === operation);
  const trash = last('TrashDocument');
  const diagnosis: Omit<TrashReadDiagnosis, 'delayed'> = {
    trashRequestId: trash?.requestId,
    trashFinishedAt: trash?.finishedAt,
    immediate: { ...(immediate ? stateOf(immediate) : { absent: true as const }), requestId: last('GetDocuments')?.requestId },
  };
  const started = performance.now();
  await pause(pauseMs);
  try {
    const [later] = await linear.getDocuments([documentId]);
    const requestId = last('GetDocuments')?.requestId;
    const elapsedMs = performance.now() - started;
    return {
      ...diagnosis,
      delayed: later === undefined ? { requestId, afterMs: pauseMs, elapsedMs, absent: true } : { ...stateOf(later), requestId, afterMs: pauseMs, elapsedMs },
    };
  } catch (error) {
    return { ...diagnosis, delayed: { requestId: last('GetDocuments')?.requestId, afterMs: pauseMs, elapsedMs: performance.now() - started, error: error instanceof Error ? error.name : 'Unknown error' } };
  }
}
