// Errors raised by the Linear client. Messages carry operation names, HTTP
// statuses and Linear's error codes only, never document content or tokens.

/** Why the client stopped sending requests for the rest of the run. */
export type StopReason =
  | { kind: 'rate-limited'; operation: string; retryAfterSeconds?: number | undefined }
  | {
      kind: 'budget-low';
      operation: string;
      /** The rate-limit header that ran low, for example `x-ratelimit-requests-remaining`. */
      header: string;
      remaining: number;
      threshold: number;
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
export class LinearTokenError extends LinearError {}

/** The file upload's PUT to storage failed. */
export class LinearUploadError extends LinearError {}

export interface GraphQLErrorShape {
  message?: string;
  extensions?: { code?: unknown; type?: unknown; [key: string]: unknown };
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
