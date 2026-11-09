// Errors raised by the Linear client. Messages carry operation names, HTTP
// statuses and Linear's error codes only, never document content or tokens.

/**
 * Why the client stopped sending requests for the rest of the run. `limits`
 * holds the `x-ratelimit-*` and `x-complexity` headers of the answer that
 * stopped it (the hourly and endpoint limits, what remains and when they
 * reset), when Linear sent any; they hold no content.
 */
export type StopReason =
  | { kind: 'rate-limited'; operation: string; retryAfterSeconds?: number | undefined; limits?: Record<string, string> }
  | {
      kind: 'budget-low';
      operation: string;
      /** The rate-limit header that ran low, for example `x-ratelimit-requests-remaining`. */
      header: string;
      remaining: number;
      threshold: number;
      limits?: Record<string, string>;
    };

export class LinearError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.operation = operation;
  }
}

/**
 * The client has stopped: Linear rate-limited it, or a remaining-budget header
 * fell below its threshold. Every later request is refused with this error, so
 * the caller stops writing and reports what it finished.
 */
export class LinearStoppedError extends LinearError {
  readonly reason: StopReason;

  constructor(operation: string, reason: StopReason) {
    super(operation, `${operation}: Linear client stopped (${describeStop(reason)})`);
    this.reason = reason;
  }
}

/** Linear answered with a GraphQL error (invalid input, not found, forbidden). */
export class LinearGraphQLError extends LinearError {
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly httpStatus: number;
  /** The referenced entity does not exist (for example a document removed from trash). */
  readonly notFound: boolean;
  /** Linear's `x-request-id` of the answer. */
  readonly requestId: string | undefined;

  constructor(operation: string, httpStatus: number, error: GraphQLErrorShape, requestId?: string) {
    const code = stringOrUndefined(error.extensions?.code);
    const type = stringOrUndefined(error.extensions?.type);
    super(
      operation,
      `${operation}: Linear error ${code ?? 'unknown'} (HTTP ${httpStatus}, request ${requestId ?? 'unknown'}): ${error.message ?? ''}`.trim(),
    );
    this.code = code;
    this.type = type;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.notFound = typeof error.message === 'string' && error.message.startsWith('Entity not found');
  }
}

/** Linear answered with an HTTP error and no GraphQL error body (for example a 502). */
export class LinearHttpError extends LinearError {
  readonly httpStatus: number;
  readonly requestId: string | undefined;

  constructor(operation: string, httpStatus: number, requestId?: string) {
    super(operation, `${operation}: Linear answered HTTP ${httpStatus} (request ${requestId ?? 'unknown'})`);
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

/**
 * The request did not complete (connection reset, timeout). For a write the
 * outcome is unknown: the caller must not record it as written.
 */
export class LinearNetworkError extends LinearError {
  constructor(operation: string, cause: unknown) {
    super(operation, `${operation}: request to Linear failed (${causeName(cause)})`, { cause });
  }
}

/** Minting or revoking an OAuth token failed. */
export class LinearTokenError extends LinearError {
  /** Linear's HTTP status; undefined when the request did not complete. */
  readonly httpStatus: number | undefined;

  constructor(operation: string, message: string, options?: ErrorOptions & { httpStatus?: number }) {
    super(operation, message, options);
    this.httpStatus = options?.httpStatus;
  }

  /** Linear answered and refused the client credentials, as opposed to an outage or a lost request. */
  get credentialsRefused(): boolean {
    return this.operation === 'oauth.token' && (this.httpStatus === 400 || this.httpStatus === 401);
  }
}

/**
 * A title or content is longer than Linear accepts. Raised before any request
 * is sent, so the write counts as failed and the document is left out with
 * this reason.
 */
export class DocumentTooLongError extends LinearError {
  readonly field: 'title' | 'content';
  readonly length: number;
  readonly limit: number;

  constructor(operation: string, refusal: { field: 'title' | 'content'; length: number; limit: number }) {
    super(operation, `${operation}: ${refusal.field} is ${refusal.length} characters, Linear accepts at most ${refusal.limit}`);
    this.field = refusal.field;
    this.length = refusal.length;
    this.limit = refusal.limit;
  }
}

/**
 * Linear applied a write, but reading back its stored record failed. Unlike
 * other failures, the write took effect: `document` is the record from the
 * write's own payload, so the caller can keep its id.
 */
export class LinearReadBackError extends LinearError {
  readonly document: { id: string };

  constructor(operation: string, document: { id: string }, cause?: unknown) {
    super(operation, `${operation}: written, but reading back the stored record failed`, { cause });
    this.document = document;
  }
}

/** The file upload's PUT to storage failed. */
export class LinearUploadError extends LinearError {}

export interface GraphQLErrorShape {
  message?: string;
  extensions?: { code?: unknown; type?: unknown; [key: string]: unknown };
}

/**
 * A Linear error as its class, Linear's code and the HTTP status, for a
 * summary or a report; never Linear's message, which may quote content.
 */
export function describeLinearError(error: LinearError): string {
  const code = (error as { code?: unknown }).code;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return [error.name, typeof code === 'string' ? code : undefined, typeof status === 'number' ? `HTTP ${status}` : undefined].filter(Boolean).join(' ');
}

/**
 * The request may succeed when tried again: it did not complete, or Linear
 * answered with a server error. A refusal (forbidden, invalid input, not
 * found) is not transient: it comes back on every run until a person acts.
 */
export function isTransientLinearError(error: LinearError): boolean {
  if (error instanceof LinearNetworkError) return true;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return typeof status === 'number' && status >= 500;
}

export function describeStop(reason: StopReason): string {
  if (reason.kind === 'rate-limited') {
    return reason.retryAfterSeconds === undefined
      ? 'rate limited'
      : `rate limited, retry after ${reason.retryAfterSeconds} s`;
  }
  return `${reason.header} is ${reason.remaining}, below ${reason.threshold}`;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function causeName(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code ?? (cause.cause as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? `${cause.name} ${code}` : cause.name;
  }
  return 'unknown error';
}
