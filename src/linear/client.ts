// The operations the engine needs from Linear, as our own GraphQL documents
// (no lazy SDK models, so a relation never costs an extra request).

import {
  DocumentTooLongError,
  LinearError,
  LinearGraphQLError,
  LinearHttpError,
  LinearNetworkError,
  LinearReadBackError,
  LinearStoppedError,
  LinearUploadError,
  type StopReason,
} from './errors.ts';
import { LINEAR_FACTS, lengthRefusal, type LinearFacts } from './facts.ts';
import { GraphQLTransport, type TransportOptions } from './transport.ts';
import { message } from '../messages.ts';

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
  /**
   * Items Linear rejected or whose outcome is unknown (network error); not
   * recorded as written. With a `LinearReadBackError` the write was applied.
   */
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
    // Linear's team filter already leaves project documents out
    // (`LINEAR_FACTS.teamFilterIncludesProjectDocuments`), measured for live
    // documents only; the check costs nothing and keeps any other project
    // document out of the team zone.
    return documents.filter((d) => d.projectId === null);
  }

  /** Lists mapped places together, using the same pagination and document parser. */
  async listDocumentsInPlaces(places: readonly DocumentPlace[], options: ListOptions = {}): Promise<LinearDocument[]> {
    if (places.length === 0) return [];
    const filters = places.map((place) => place.projectId !== undefined ? {project:{id:{eq:place.projectId}}} : {team:{id:{eq:place.teamId}}});
    const documents = await this.#pagedDocuments('ListDocuments', {or:filters}, options);
    return documents.filter((doc) => places.some((place) => place.projectId !== undefined ? doc.projectId === place.projectId : doc.projectId === null && doc.teamId === place.teamId));
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
   * Reads one document by id with `document(id:)`, which answers for trashed
   * and archived documents too; null when Linear no longer has the id.
   */
  async getDocument(id: string): Promise<LinearDocument | null> {
    try {
      const data = await this.request<{ document: RawDocument | null }>(
        'GetDocument',
        'query',
        `query GetDocument($id: String!, $withContent: Boolean!) {
          document(id: $id) { ${DOCUMENT_FIELDS} }
        }`,
        { id, withContent: false },
      );
      return data.document === null ? null : toDocument(data.document);
    } catch (error) {
      if (error instanceof LinearGraphQLError && error.notFound) return null;
      throw error;
    }
  }

  /**
   * Creates a document and returns its record with the stored content. A
   * title or content longer than Linear accepts throws `DocumentTooLongError`
   * without a request. When `facts.mutationsReturnStoredContent` holds (as
   * measured), the payload is the stored record and this is one request;
   * otherwise a second request reads the document back. A failed read-back
   * throws `LinearReadBackError`: the document was created.
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
    this.stats.wrote('CreateDocument');
    return this.#storedRecord('CreateDocument', created);
  }

  /**
   * Updates a document: content, rename (title), move (projectId or teamId),
   * icon and color. Like `createDocument`, refuses a too-long title or
   * content without a request and returns the stored content of a content
   * change: one request as measured, two when the facts call for a read-back.
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
    this.stats.wrote('UpdateDocument');
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
    this.stats.wrote('TrashDocument');
  }

  async restoreDocument(id: string): Promise<void> {
    const data = await this.request<{ documentUnarchive: { success: boolean } }>(
      'RestoreDocument',
      'mutation',
      `mutation RestoreDocument($id: String!) { documentUnarchive(id: $id) { success } }`,
      { id },
    );
    succeeded('RestoreDocument', data.documentUnarchive);
    this.stats.wrote('RestoreDocument');
  }

  /** Comments on a document; `documentContentId` comes from the document. */
  async commentOnDocument(documentContentId: string, body: string, id?: string): Promise<{ id: string }> {
    const data = await this.request<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      'CommentOnDocument',
      'mutation',
      `mutation CommentOnDocument($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { documentContentId, body, ...(id === undefined ? {} : { id }) } },
    );
    const comment = succeeded('CommentOnDocument', data.commentCreate).comment;
    this.stats.wrote('CommentOnDocument');
    return comment;
  }

  /** Update a previously posted notice without adding another comment. */
  async updateDocumentComment(id: string, body: string): Promise<{ id: string }> {
    const data = await this.request<{ commentUpdate: { success: boolean; comment: { id: string } } }>(
      'UpdateDocumentComment', 'mutation',
      `mutation UpdateDocumentComment($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success comment { id } }
      }`,
      { id, input: { body } },
    );
    const comment = succeeded('UpdateDocumentComment', data.commentUpdate).comment;
    this.stats.wrote('UpdateDocumentComment');
    return comment;
  }

  /** Ensure one notice exists, including recovery after a lost create response. */
  async ensureDocumentComment(documentContentId: string, body: string, id: string, updateExisting = false): Promise<{ id: string; created: boolean }> {
    const find = async (): Promise<boolean> => {
      const data = await this.request<{ comments: { nodes: Array<{ id: string; documentContentId: string | null }> } }>(
        'FindDocumentComment', 'query',
        `query FindDocumentComment($id: ID!) {
          comments(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id documentContentId } }
        }`,
        { id },
      );
      const comment = data.comments.nodes[0];
      if (!comment) return false;
      if (comment.id !== id || comment.documentContentId !== documentContentId) {
        throw new LinearError('FindDocumentComment', message('linear.comment-mismatch'));
      }
      return true;
    };
    const existing = async () => {
      if (updateExisting) {
        const comment = await this.updateDocumentComment(id, body);
        if (comment.id !== id) throw new LinearError('UpdateDocumentComment', message('linear.updated-comment-mismatch'));
      }
      return { id, created: false };
    };
    if (await find()) return existing();
    let comment: { id: string };
    try {
      comment = await this.commentOnDocument(documentContentId, body, id);
    } catch (error) {
      // A mutation may succeed before a network failure, or a concurrent
      // caller may create the same id. Read it back before reporting failure.
      if (error instanceof LinearError && this.stopped === undefined) {
        let found = false;
        try { found = await find(); } catch { /* Preserve the original mutation failure. */ }
        if (found) {
          // Only a create whose answer was lost (no answer, a server error) may be the one that was applied: it
          // counts, so a zero-write check fails rather than passes on it. Any answer that refused it (an error,
          // `success: false`) means the comment is another caller's.
          const lost = error instanceof LinearNetworkError || ((error instanceof LinearHttpError || error instanceof LinearGraphQLError) && error.httpStatus >= 500);
          if (lost) this.stats.wrote('CommentOnDocument');
          return existing();
        }
      }
      throw error;
    }
    // A successful response with the wrong identity is a protocol failure,
    // not an ambiguous mutation to recover by looking up another comment.
    if (comment.id !== id) throw new LinearError('CommentOnDocument', message('linear.created-comment-mismatch'));
    return { id, created: true };
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
    if (!target) throw new LinearUploadError('FileUpload', message('linear.no-upload-target', { operation: 'FileUpload' }));
    await this.#putUpload('FileUpload.put', target, input);
    return { assetUrl: target.assetUrl };
  }

  /**
   * Uploads several files with one API request: one `fileUpload` per file,
   * aliased in a single mutation, then one storage PUT per file. Linear's
   * request budget is the scarce one (5,000 an hour); each `fileUpload`
   * still counts against the complexity budget. Returns the asset URLs in
   * the order of `inputs`; throws when any file fails, after uploading the
   * ones before it (their URLs are lost to the caller, which uploads them
   * again one by one).
   */
  async uploadFiles(inputs: readonly UploadInput[]): Promise<Array<{ assetUrl: string }>> {
    if (inputs.length === 0) return [];
    const declarations = inputs.map((_, index) => `$contentType${index}: String!, $filename${index}: String!, $size${index}: Int!`).join(', ');
    const fields = inputs
      .map((_, index) => `f${index}: fileUpload(contentType: $contentType${index}, filename: $filename${index}, size: $size${index}) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }`)
      .join('\n        ');
    const variables: Record<string, unknown> = {};
    inputs.forEach((input, index) => {
      variables[`contentType${index}`] = input.contentType;
      variables[`filename${index}`] = input.filename;
      variables[`size${index}`] = input.bytes.byteLength;
    });
    type Payload = { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null };
    const data = await this.request<Record<string, Payload>>('FileUploads', 'mutation', `mutation FileUploads(${declarations}) {\n        ${fields}\n      }`, variables);
    const targets = inputs.map((_, index) => {
      const payload = data[`f${index}`];
      const target = payload === undefined ? null : succeeded('FileUploads', payload).uploadFile;
      if (!target) throw new LinearUploadError('FileUploads', message('linear.no-upload-target', { operation: 'FileUploads' }));
      return target;
    });
    const result: Array<{ assetUrl: string }> = [];
    for (const [index, input] of inputs.entries()) {
      const target = targets[index] as (typeof targets)[number];
      await this.#putUpload('FileUploads.put', target, input);
      result.push({ assetUrl: target.assetUrl });
    }
    return result;
  }

  /** Sends a file's bytes to the storage URL Linear issued for it. */
  async #putUpload(operation: string, target: { uploadUrl: string; headers: Array<{ key: string; value: string }> }, input: UploadInput): Promise<void> {
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
      throw new LinearUploadError(operation, message('linear.storage-failed', { operation }), { cause: error });
    }
    if (!response.ok) {
      throw new LinearUploadError(operation, message('linear.storage-answered', { operation, status: response.status }));
    }
    // A file is stored once storage took its bytes; the upload target alone stores nothing.
    this.stats.wrote('FileUpload');
  }

  #refuseTooLong(operation: string, document: { title?: string | undefined; content?: string | undefined }): void {
    const refusal = lengthRefusal(document, this.facts);
    if (refusal) throw new DocumentTooLongError(operation, refusal);
  }

  /** The written document's record with its stored content: the payload, or a read-back when the payload may differ. */
  async #storedRecord(operation: string, written: LinearDocument): Promise<LinearDocument> {
    if (this.facts.mutationsReturnStoredContent) return written;
    let stored: LinearDocument | undefined;
    try {
      [stored] = await this.getDocuments([written.id], { withContent: true });
    } catch (error) {
      // A stop stays a stop: writeEach then reports the write as interrupted.
      if (error instanceof LinearStoppedError || !(error instanceof LinearError)) throw error;
      throw new LinearReadBackError(operation, written, error);
    }
    if (!stored) throw new LinearReadBackError(operation, written);
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
        throw new LinearError(operation, message('linear.page-without-cursor', { operation }));
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
 *   rest go on; a `LinearReadBackError` there was written all the same;
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
  if (payload.success !== true) throw new LinearError(operation, message('linear.not-success', { operation }));
  return payload;
}

function toDocument(raw: RawDocument): LinearDocument {
  const { project, team, trashed, ...rest } = raw;
  return { ...rest, projectId: project?.id ?? null, teamId: team?.id ?? null, trashed: trashed === true };
}

function clampPageSize(pageSize: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)));
}
