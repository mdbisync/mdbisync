// The operations the engine needs from Linear, as our own GraphQL documents
// (no lazy SDK models, so a relation never costs an extra request).

import { DocumentTooLongError, LinearError, LinearStoppedError, LinearUploadError, type StopReason } from './errors.ts';
import { LINEAR_FACTS, lengthRefusal, type LinearFacts } from './facts.ts';
import { GraphQLTransport, type TransportOptions } from './transport.ts';

/** Largest page Linear serves for a connection. */
export const MAX_PAGE_SIZE = 250;
/**
 * Default page size for document lists and reads by id: the largest page.
 * Measured complexity of a documents page is about 2.7 points per document
 * (first 50, 100, 250: 135, 270, 675 points; 140, 280, 700 with content), far
 * below a single query's limit and 0.04% of the hourly 2,000,000 points, so
 * full pages save requests, the scarcer budget (5,000 an hour).
 */
export const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;
/** Longest wait for an upload's PUT to storage; files are at most a few MB. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface LinearDocument {
  id: string;
  title: string;
  slugId: string;
  icon: string | null;
  color: string | null;
  /** Present when the query asked for content. */
  content?: string | null;
  /** Needed to comment on the document. */
  documentContentId: string | null;
  projectId: string | null;
  teamId: string | null;
  trashed: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Where a document lives: a project, or a team without a project (a team zone). */
export type DocumentPlace = { projectId: string; teamId?: never } | { teamId: string; projectId?: never };

export interface CreateDocumentInput {
  title: string;
  content?: string;
  icon?: string;
  color?: string;
  /** A client-chosen id, so a retried create cannot make a duplicate. */
  id?: string;
}

/**
 * A partial update. Content, title (rename), place (move), icon and color can
 * be changed together in one request.
 */
export interface DocumentPatch {
  title?: string;
  content?: string;
  icon?: string | null;
  color?: string | null;
  projectId?: string | null;
  teamId?: string | null;
}

export interface ListOptions {
  withContent?: boolean;
  /** Include archived and trashed documents. */
  includeArchived?: boolean;
  pageSize?: number;
}

export interface UploadInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface RateLimitLimit {
  type: string;
  allowedAmount: number;
  remainingAmount: number;
  requestedAmount: number;
  period: number;
  reset: number;
}

export interface RateLimitStatus {
  identifier: string | null;
  kind: string;
  limits: RateLimitLimit[];
}

export interface EachResult<T, R> {
  done: Array<{ item: T; result: R }>;
  /** Items Linear rejected or whose outcome is unknown (network error); not written. */
  failed: Array<{ item: T; error: LinearError }>;
  /** Items not tried. */
  notAttempted: T[];
  /** The item being written when the client stopped; it may be partly applied. */
  interrupted?: { item: T; error: LinearStoppedError };
  /** The item whose write threw an error that is not Linear's; the caller rethrows it. */
  aborted?: { item: T; error: unknown };
  stopped?: StopReason;
}

const DOCUMENT_FIELDS = `
  id title slugId icon color trashed archivedAt createdAt updatedAt documentContentId
  content @include(if: $withContent)
  project { id }
  team { id }`;

interface RawDocument extends Omit<LinearDocument, 'projectId' | 'teamId' | 'trashed'> {
  trashed: boolean | null;
  project: { id: string } | null;
  team: { id: string } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export class LinearClient {
  readonly transport: GraphQLTransport;
  /** What the client assumes about Linear; the measured `LINEAR_FACTS` unless a test or the probe sets others. */
  readonly facts: LinearFacts;

  constructor(options: TransportOptions | GraphQLTransport, facts: LinearFacts = LINEAR_FACTS) {
    this.transport = options instanceof GraphQLTransport ? options : new GraphQLTransport(options);
    this.facts = facts;
  }

  get stats() {
    return this.transport.stats;
  }

  /** Why the client stopped, or undefined while it runs. */
  get stopped(): StopReason | undefined {
    return this.transport.stopped;
  }

  /** Sends any GraphQL document; for setup checks and tests. */
  request<T>(operation: string, kind: 'query' | 'mutation', query: string, variables?: Record<string, unknown>) {
    return this.transport.request<T>(operation, kind, query, variables);
  }

  async rateLimitStatus(): Promise<RateLimitStatus> {
    const data = await this.request<{ rateLimitStatus: RateLimitStatus }>(
      'RateLimitStatus',
      'query',
      `query RateLimitStatus {
        rateLimitStatus { identifier kind limits { type allowedAmount remainingAmount requestedAmount period reset } }
      }`,
    );
    return data.rateLimitStatus;
  }

  /**
   * Lists every document of a project, or of a team zone (the team's
   * documents outside projects), page by page. Trashed documents are listed
   * only with `includeArchived`, then with `trashed` and `archivedAt` set.
   */
  async listDocuments(place: DocumentPlace, options: ListOptions = {}): Promise<LinearDocument[]> {
    if (place.projectId !== undefined) {
      return this.#pagedDocuments('ListDocuments', { project: { id: { eq: place.projectId } } }, options);
    }
    const documents = await this.#pagedDocuments('ListDocuments', { team: { id: { eq: place.teamId } } }, options);
    // Linear's team filter returns only the team zone (`LINEAR_FACTS`); should
    // that change, project documents still stay out of it.
    return this.facts.teamFilterIncludesProjectDocuments ? documents.filter((d) => d.projectId === null) : documents;
  }

  /**
   * Reads documents by id, one request per page of ids (one request for up
   * to `pageSize` ids). Trashed documents are included; ids that no longer
   * exist are absent from the result.
   */
  async getDocuments(ids: readonly string[], options: Omit<ListOptions, 'includeArchived'> = {}): Promise<LinearDocument[]> {
    const pageSize = clampPageSize(options.pageSize);
    const result: LinearDocument[] = [];
    for (let start = 0; start < ids.length; start += pageSize) {
      const chunk = ids.slice(start, start + pageSize);
      const data = await this.request<{ documents: { nodes: RawDocument[] } }>(
        'GetDocuments',
        'query',
        `query GetDocuments($ids: [ID!]!, $first: Int!, $withContent: Boolean!) {
          documents(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
            nodes { ${DOCUMENT_FIELDS} }
          }
        }`,
        { ids: chunk, first: chunk.length, withContent: options.withContent ?? false },
      );
      result.push(...data.documents.nodes.map(toDocument));
    }
    return result;
  }

  /**
   * Creates a document and returns its record with the stored content. A
   * title or content longer than Linear accepts throws `DocumentTooLongError`
   * without a request. Linear's payload holds the stored content, so this is
   * one request; it reads the document back only when `facts` says otherwise.
   */
  async createDocument(place: DocumentPlace, input: CreateDocumentInput): Promise<LinearDocument> {
    this.#refuseTooLong('CreateDocument', input);
    const data = await this.request<{ documentCreate: { success: boolean; document: RawDocument } }>(
      'CreateDocument',
      'mutation',
      `mutation CreateDocument($input: DocumentCreateInput!, $withContent: Boolean!) {
        documentCreate(input: $input) { success document { ${DOCUMENT_FIELDS} } }
      }`,
      { input: { ...input, ...place }, withContent: true },
    );
    const created = toDocument(succeeded('CreateDocument', data.documentCreate).document);
    return this.#storedRecord('CreateDocument', created);
  }

  /**
   * Updates a document: content, rename (title), move (projectId or teamId),
   * icon and color. Like `createDocument`, refuses a too-long title or
   * content without a request, and returns the stored content when the patch
   * changes content, in one request.
   */
  async updateDocument(id: string, patch: DocumentPatch): Promise<LinearDocument> {
    this.#refuseTooLong('UpdateDocument', patch);
    const data = await this.request<{ documentUpdate: { success: boolean; document: RawDocument } }>(
      'UpdateDocument',
      'mutation',
      `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!, $withContent: Boolean!) {
        documentUpdate(id: $id, input: $input) { success document { ${DOCUMENT_FIELDS} } }
      }`,
      { id, input: patch, withContent: patch.content !== undefined },
    );
    const updated = toDocument(succeeded('UpdateDocument', data.documentUpdate).document);
    return patch.content === undefined ? updated : this.#storedRecord('UpdateDocument', updated);
  }

  /** Moves a document to trash; it can be restored. Never deletes for good. */
  async trashDocument(id: string): Promise<void> {
    const data = await this.request<{ documentDelete: { success: boolean } }>(
      'TrashDocument',
      'mutation',
      `mutation TrashDocument($id: String!) { documentDelete(id: $id) { success } }`,
      { id },
    );
    succeeded('TrashDocument', data.documentDelete);
  }

  async restoreDocument(id: string): Promise<void> {
    const data = await this.request<{ documentUnarchive: { success: boolean } }>(
      'RestoreDocument',
      'mutation',
      `mutation RestoreDocument($id: String!) { documentUnarchive(id: $id) { success } }`,
      { id },
    );
    succeeded('RestoreDocument', data.documentUnarchive);
  }

  /** Comments on a document; `documentContentId` comes from the document. */
  async commentOnDocument(documentContentId: string, body: string): Promise<{ id: string }> {
    const data = await this.request<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      'CommentOnDocument',
      'mutation',
      `mutation CommentOnDocument($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { documentContentId, body } },
    );
    return succeeded('CommentOnDocument', data.commentCreate).comment;
  }

  /**
   * Uploads a file: `fileUpload` returns a signed storage URL, the bytes go
   * there with one PUT, and the returned asset URL is what documents embed.
   * Measured: Linear issues an upload target for a declared 10 MiB and for
   * 10 MiB + 1 byte, and refuses a declared 100 MiB (INPUT_ERROR).
   */
  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    const data = await this.request<{
      fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null };
    }>(
      'FileUpload',
      'mutation',
      `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { contentType: input.contentType, filename: input.filename, size: input.bytes.byteLength },
    );
    const target = succeeded('FileUpload', data.fileUpload).uploadFile;
    if (!target) throw new LinearUploadError('FileUpload', 'FileUpload: Linear returned no upload target');

    const headers = new Headers({ 'content-type': input.contentType, 'cache-control': 'public, max-age=31536000' });
    for (const { key, value } of target.headers) headers.set(key, value);
    this.stats.storagePuts += 1;
    let response: Response;
    try {
      response = await this.transport.fetch(target.uploadUrl, {
        method: 'PUT',
        headers,
        body: input.bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LinearUploadError('FileUpload.put', 'FileUpload.put: storage request failed', { cause: error });
    }
    if (!response.ok) {
      throw new LinearUploadError('FileUpload.put', `FileUpload.put: storage answered HTTP ${response.status}`);
    }
    return { assetUrl: target.assetUrl };
  }

  #refuseTooLong(operation: string, document: { title?: string | undefined; content?: string | undefined }): void {
    const refusal = lengthRefusal(document, this.facts);
    if (refusal) throw new DocumentTooLongError(operation, refusal);
  }

  /** The written document's record with its stored content: the payload, or a read-back when the payload may differ. */
  async #storedRecord(operation: string, written: LinearDocument): Promise<LinearDocument> {
    if (this.facts.mutationsReturnStoredContent) return written;
    const [stored] = await this.getDocuments([written.id], { withContent: true });
    if (!stored) throw new LinearError(operation, `${operation}: the written document could not be read back`);
    return stored;
  }

  async #pagedDocuments(operation: string, filter: unknown, options: ListOptions): Promise<LinearDocument[]> {
    const result: LinearDocument[] = [];
    let after: string | null = null;
    do {
      const data: { documents: { nodes: RawDocument[]; pageInfo: PageInfo } } = await this.request(
        operation,
        'query',
        `query ${operation}($filter: DocumentFilter, $first: Int!, $after: String, $includeArchived: Boolean!, $withContent: Boolean!) {
          documents(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: createdAt) {
            nodes { ${DOCUMENT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          filter,
          first: clampPageSize(options.pageSize),
          after,
          includeArchived: options.includeArchived ?? false,
          withContent: options.withContent ?? false,
        },
      );
      result.push(...data.documents.nodes.map(toDocument));
      const { hasNextPage, endCursor } = data.documents.pageInfo;
      if (hasNextPage && endCursor === null) {
        throw new LinearError(operation, `${operation}: Linear reported another page without a cursor`);
      }
      after = hasNextPage ? endCursor : null;
    } while (after !== null);
    return result;
  }
}

/**
 * Runs `write` for each item in order and always returns what happened, so
 * the caller can record `done` before anything else:
 * - an item Linear rejects (or whose request failed) goes to `failed` and the
 *   rest go on;
 * - when the client stops (rate limit or low budget) during an item, that
 *   item goes to `interrupted`, since a write of several requests may be
 *   partly applied; the rest go to `notAttempted`;
 * - when the client has already stopped, the rest go to `notAttempted`;
 * - any other error (a bug, a governor's own failure) ends the loop: the item
 *   goes to `aborted` and the rest to `notAttempted`; the caller records
 *   `done` and then rethrows `aborted.error`.
 */
export async function writeEach<T, R>(
  client: LinearClient,
  items: readonly T[],
  write: (item: T) => Promise<R>,
): Promise<EachResult<T, R>> {
  const outcome: EachResult<T, R> = { done: [], failed: [], notAttempted: [] };
  for (let index = 0; index < items.length; index += 1) {
    if (client.stopped) {
      outcome.stopped = client.stopped;
      outcome.notAttempted = items.slice(index);
      return outcome;
    }
    const item = items[index] as T;
    try {
      outcome.done.push({ item, result: await write(item) });
    } catch (error) {
      if (error instanceof LinearStoppedError) {
        outcome.stopped = error.reason;
        outcome.interrupted = { item, error };
        outcome.notAttempted = items.slice(index + 1);
        return outcome;
      }
      if (error instanceof LinearError) {
        outcome.failed.push({ item, error });
        continue;
      }
      outcome.aborted = { item, error };
      outcome.notAttempted = items.slice(index + 1);
      return outcome;
    }
  }
  if (client.stopped) outcome.stopped = client.stopped;
  return outcome;
}

/** Throws when a mutation's payload reports `success: false` without an error. */
function succeeded<P extends { success: boolean }>(operation: string, payload: P): P {
  if (payload.success !== true) throw new LinearError(operation, `${operation}: Linear reported success: false`);
  return payload;
}

function toDocument(raw: RawDocument): LinearDocument {
  const { project, team, trashed, ...rest } = raw;
  return { ...rest, projectId: project?.id ?? null, teamId: team?.id ?? null, trashed: trashed === true };
}

function clampPageSize(pageSize: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)));
}
