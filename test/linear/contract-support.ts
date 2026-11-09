// Cleanup and diagnostics for the Linear contract tests: the run removes only
// what it created, and a document it trashed never stays in the trash, even
// when an assertion stopped the test before its restore step.

import type { LinearClient, LinearDocument, LogEntry } from '../../src/linear/index.ts';

/** What the run created, and which of its documents a successful trash may have left in the trash. */
export interface OwnedRecords {
  projectIds: readonly string[];
  documentIds: readonly string[];
  /** Trashed with a confirmed success and not restored since. */
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
  /** The owned documents as the read after the project deletions returned them. */
  final: DocumentState[];
}

/**
 * Restores every owned document that is still in the trash, deletes the
 * owned projects (which archives their documents), then reads the documents
 * back: each must be archived and none trashed. Linear refuses to restore a
 * document whose project is gone, so the restore comes first. A document
 * counts as trashed when the read says so or when its trash succeeded and no
 * restore followed, since a read right after a trash was once seen stale.
 * Errors are collected, never thrown, so the test's own failure stays first.
 */
export async function cleanUpOwned(linear: LinearClient, owned: OwnedRecords): Promise<CleanupResult> {
  const result: CleanupResult = { errors: [], restored: [], final: [] };
  const toRestore = new Set(owned.trashed);
  if (owned.documentIds.length > 0) {
    try {
      for (const document of await linear.getDocuments(owned.documentIds)) {
        if (document.trashed) toRestore.add(document.id);
      }
    } catch (error) {
      result.errors.push({ operation: 'read owned documents', error });
    }
  }
  for (const id of toRestore) {
    try {
      await linear.restoreDocument(id);
      result.restored.push(id);
    } catch (error) {
      result.errors.push({ operation: 'RestoreDocument', documentId: id, error });
    }
  }
  for (const id of owned.projectIds) {
    try {
      await linear.request('DeleteProject', 'mutation', 'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }', { id });
    } catch (error) {
      result.errors.push({ operation: 'DeleteProject', projectId: id, error });
    }
  }
  if (owned.documentIds.length > 0) {
    try {
      result.final = (await linear.getDocuments(owned.documentIds)).map(stateOf);
      for (const id of owned.documentIds) {
        const state = result.final.find((document) => document.id === id);
        const problem = state === undefined ? 'missing' : state.trashed ? 'still trashed' : state.archived ? undefined : 'not archived';
        if (problem) result.errors.push({ operation: 'verify archived', documentId: id, error: new Error(`owned document ${problem}`) });
      }
    } catch (error) {
      result.errors.push({ operation: 'verify archived', error });
    }
  }
  return result;
}

export function stateOf(document: LinearDocument): DocumentState {
  return { id: document.id, trashed: document.trashed, archived: document.archivedAt !== null, updatedAt: document.updatedAt };
}

/** A read of a trashed document that did not say trashed, and one read after a pause. */
export interface TrashReadDiagnosis {
  trashRequestId: string | undefined;
  trashFinishedAt: string | undefined;
  immediate: DocumentState & { requestId: string | undefined };
  delayed: (DocumentState & { requestId: string | undefined; afterMs: number }) | { requestId: string | undefined; afterMs: number; absent: true };
}

/**
 * Records why a read right after a successful trash did not say trashed: its
 * request id and state (a stale record keeps the old `updatedAt` and no
 * `archivedAt`; a record that has `archivedAt` without `trashed` points at
 * the field instead), then reads the document once more after `pauseMs`. A
 * read only: it changes nothing and the caller's assertion still fails.
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
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  const [later] = await linear.getDocuments([immediate.id]);
  const requestId = last('GetDocuments')?.requestId;
  return {
    ...diagnosis,
    delayed: later === undefined ? { requestId, afterMs: pauseMs, absent: true } : { ...stateOf(later), requestId, afterMs: pauseMs },
  };
}
