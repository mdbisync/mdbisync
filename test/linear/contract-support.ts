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

/** A read of a trashed document that did not say trashed, and one read after a pause. */
export interface TrashReadDiagnosis {
  trashRequestId: string | undefined;
  trashFinishedAt: string | undefined;
  immediate: DocumentState & { requestId: string | undefined };
  delayed:
    | (DocumentState & { requestId: string | undefined; afterMs: number })
    | { requestId: string | undefined; afterMs: number; absent: true }
    | { afterMs: number; error: string };
}

/**
 * Records why a read right after a successful trash did not say trashed: its
 * request id and state (a stale record keeps the old `updatedAt` and no
 * `archivedAt`; a record that has `archivedAt` without `trashed` points at
 * the field instead), then reads the document once more after `pauseMs`. A
 * read only: it changes nothing, never throws, and the caller's assertion
 * still fails.
 */
export async function diagnoseTrashRead(
  linear: LinearClient,
  requests: readonly LogEntry[],
  immediate: LinearDocument,
  pauseMs = 2_000,
): Promise<TrashReadDiagnosis> {
  const last = (operation: string) => requests.findLast((entry) => entry.operation === operation);
  const trash = last('TrashDocument');
  const diagnosis: Omit<TrashReadDiagnosis, 'delayed'> = {
    trashRequestId: trash?.requestId,
    trashFinishedAt: trash?.finishedAt,
    immediate: { ...stateOf(immediate), requestId: last('GetDocuments')?.requestId },
  };
  await pause(pauseMs);
  try {
    const [later] = await linear.getDocuments([immediate.id]);
    const requestId = last('GetDocuments')?.requestId;
    return {
      ...diagnosis,
      delayed: later === undefined ? { requestId, afterMs: pauseMs, absent: true } : { ...stateOf(later), requestId, afterMs: pauseMs },
    };
  } catch (error) {
    return { ...diagnosis, delayed: { afterMs: pauseMs, error: error instanceof Error ? error.name : 'Unknown error' } };
  }
}
