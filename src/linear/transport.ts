// GraphQL transport: one POST per operation, request counting, rate-limit
// handling and hooks for an external budget governor.
//
// Rate limits (Linear answers 429, or a GraphQL error with code RATELIMITED):
// - with a short Retry-After, wait and retry once;
// - otherwise stop: this request and every later one throws LinearStoppedError.
// After each response the remaining-budget headers are checked against the
// budget floor; below it the client stops before the next request.
//
// Authentication (Linear answers 401 without data, as for a revoked token,
// with code AUTHENTICATION_ERROR): with `renewToken`, the request is sent once more
// with a fresh token, as another run of the same Linear app may have revoked
// the shared one. Linear refuses such a request before running it, so a
// write is repeated safely.

import {
  LinearGraphQLError,
  LinearHttpError,
  LinearNetworkError,
  LinearResponseLimitError,
  LinearError,
  isTransientLinearError,
  LinearStoppedError,
  type GraphQLErrorShape,
  type StopReason,
} from './errors.ts';
import {
  DEFAULT_BUDGET_FLOOR,
  findLowBudget,
  limitsOf,
  parseRetryAfter,
  readRateLimitHeaders,
  type BudgetFloor,
  type RateLimitSnapshot,
} from './rate-limit.ts';
import { authMetadata, emitLog, requestTiming, type AuthContext } from './diagnostics.ts';
import { RequestStats } from './stats.ts';
import { type LinearReads, graphqlReadKey } from './reads.ts';
import { message } from '../messages.ts';
import { isUploadUrl } from './upload-url.ts';

export const DEFAULT_BASE_URL = 'https://api.linear.app';

/**
 * Most bytes of one Linear answer. A full page of 250 documents at Linear's
 * longest content (250,000 code points) is about 63 MB as ASCII JSON; this
 * leaves room for escapes and wider characters. The answer is read as a
 * stream and given up past this, before it is parsed.
 */
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
/**
 * Most bytes of the Linear answers whose document bodies a run holds
 * together (reads of many documents with content), over one run (one
 * transport). Those bodies stay in memory until the run decides what to
 * write, so this bounds that memory: each answer is checked once it is read
 * (under `MAX_RESPONSE_BYTES`) and before its bodies are kept, so a run holds
 * at most this plus one answer. An error answer does not count. A few
 * thousand ordinary documents use a small part of it. A read of one
 * document just before it is written is not counted.
 */
export const DOCUMENT_BODY_BUDGET_BYTES = 256 * 1024 * 1024;

export interface ResponseLimits {
  /** Most bytes of one answer. */
  responseBytes: number;
  /** Most bytes of all answers read with document bodies. */
  bodyBytes: number;
}

export type OperationKind = 'query' | 'mutation';

export interface RequestInfo {
  operation: string;
  kind: OperationKind;
  /** 1 for the first try; each retry (after a short Retry-After, with a renewed token) counts one more. */
  attempt: number;
}

export interface ResponseInfo extends RequestInfo {
  status: number;
  /** Time to response headers; LogEntry.durationMs also includes reading the body. */
  durationMs: number;
  rateLimit: RateLimitSnapshot;
}

/** A log line about a request. It never holds content, variables or tokens. */
export interface LogEntry extends Partial<AuthContext> {
  operation: string;
  kind: OperationKind | 'oauth';
  attempt: number;
  status: number | 'network-error';
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  rateLimitHeaders: Record<string, string>;
  /** Linear's `x-request-id`, for matching a failure with Linear's side. */
  requestId?: string | undefined;
  /** Codes of the GraphQL errors in the answer, for example INPUT_ERROR. */
  errorCodes?: string[] | undefined;
  /** OAuth revocation outcome, including a 200 with success:false. */
  revocationConfirmed?: boolean;
  /** The governor rejected the response before its body was read. */
  responseHookFailed?: true;
  retryAfterSeconds?: number | undefined;
  stop?: StopReason | undefined;
}

export interface LinearHooks {
  /** Called before every request; a governor may wait here for budget. */
  beforeRequest?: (info: RequestInfo) => void | Promise<void>;
  /** Called after every HTTP response, before the body is interpreted. */
  afterResponse?: (info: ResponseInfo) => void | Promise<void>;
  log?: (entry: LogEntry) => void;
}

export interface TransportOptions {
  /** OAuth access token, or how to get it when the first request needs one (a run whose reads are all kept needs none). */
  token: string | (() => Promise<string>);
  /** A fresh token after Linear refused `rejected` (see `TokenRenewal`); without it a refusal is final. */
  renewToken?: (rejected: string) => Promise<string>;
  /** Answers kept from an earlier step of the job, or where to keep this one's (see reads.ts). */
  reads?: LinearReads;
  /** Safe mint metadata for correlating this token's requests, never credentials. */
  auth?: AuthContext;
  /** API origin; a test proxy can sit here. Defaults to https://api.linear.app. */
  baseUrl?: string | undefined;
  budgetFloor?: Partial<BudgetFloor>;
  /** Byte limits of Linear's answers; `MAX_RESPONSE_BYTES` and `DOCUMENT_BODY_BUDGET_BYTES` unless a test sets others. */
  limits?: Partial<ResponseLimits>;
  /** Longest Retry-After, in seconds, that is waited out with one retry. */
  maxRetryAfterSeconds?: number;
  timeoutMs?: number;
  hooks?: LinearHooks;
  stats?: RequestStats;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GraphQLTransport {
  readonly stats: RequestStats;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly reads?: LinearReads;
  #token: string | (() => Promise<string>);
  #renewToken: ((rejected: string) => Promise<string>) | undefined;
  #auth: AuthContext | undefined;
  #floor: BudgetFloor;
  #maxRetryAfterSeconds: number;
  #timeoutMs: number;
  #hooks: LinearHooks;
  #sleep: (ms: number) => Promise<void>;
  #stopped: StopReason | undefined;
  #lastRateLimit: RateLimitSnapshot | undefined;
  #limits: ResponseLimits;
  #bodyBytesRead = 0;

  constructor(options: TransportOptions) {
    this.#token = options.token;
    this.#renewToken = options.renewToken;
    if (options.reads !== undefined) this.reads = options.reads;
    this.#auth = authMetadata(options.auth);
    this.baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#floor = { ...DEFAULT_BUDGET_FLOOR, ...options.budgetFloor };
    this.#limits = { responseBytes: MAX_RESPONSE_BYTES, bodyBytes: DOCUMENT_BODY_BUDGET_BYTES, ...options.limits };
    this.#maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 10;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#hooks = options.hooks ?? {};
    this.stats = options.stats ?? new RequestStats();
    this.fetch = options.fetch ?? defaultFetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Authenticated storage GET, restricted to Linear's documented upload host. */
  async fetchUpload(url: string, init: RequestInit = {}): Promise<Response> {
    if (!isUploadUrl(url)) {
      throw new Error(message('linear.upload-not-allowed'));
    }
    const get = (token: string) => this.fetch(url, { ...init, method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${token}` } });
    const token = await this.#accessToken();
    const response = await get(token);
    // The upload host refuses a revoked token as it refuses a file: only a new token tells them apart.
    // So each refused file costs one token request: refused files are rare, and a token revoked after an
    // earlier refusal must still be told apart from the next refusal.
    if (response.status !== 401) return response;
    // A renewal that fails leaves the upload refused, as before: the capture decides what that means.
    const fresh = await this.#renewed(token).catch(() => undefined);
    if (fresh === undefined) return response;
    await response.body?.cancel().catch(() => {});
    return get(fresh);
  }

  /** A token to retry with after Linear refused `rejected`, or undefined when there is none (`rejected` is still the run's token). */
  async #renewed(rejected: string): Promise<string | undefined> {
    if (this.#renewToken === undefined) return undefined;
    const fresh = await this.#renewToken(rejected);
    if (fresh === rejected) return undefined;
    // Later requests start from the fresh token.
    this.#token = fresh;
    return fresh;
  }

  #accessToken(): Promise<string> {
    return typeof this.#token === 'string' ? Promise.resolve(this.#token) : this.#token();
  }

  /** Why the client stopped, or undefined while it is running. */
  get stopped(): StopReason | undefined {
    return this.#stopped;
  }

  /** Rate-limit headers of the latest response. */
  get lastRateLimit(): RateLimitSnapshot | undefined {
    return this.#lastRateLimit;
  }

  async request<T>(
    operation: string,
    kind: OperationKind,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    return kind === 'mutation' ? this.mutate<T>(operation, query, variables) : this.query<T>(operation, query, variables);
  }

  /**
   * Reads alone can consume or record a saved answer. With `bodies`, the
   * answer carries document bodies and counts toward the run's body budget,
   * a kept answer too.
   */
  async query<T>(operation: string, query: string, variables: Record<string, unknown> = {}, { bodies = false }: { bodies?: boolean } = {}): Promise<T> {
    if (this.#stopped) throw this.#refuse(operation, 'query', this.#stopped);
    const requestBody = JSON.stringify({ query, variables, operationName: operation });
    const key = this.reads === undefined ? undefined : graphqlReadKey(requestBody);
    const kept = key === undefined ? undefined : this.reads?.take(key);
    if (kept !== undefined) {
      // Only answers with data and no errors are kept, so a kept answer with bodies always counts.
      if (kept.body.length > this.#limits.responseBytes) throw new LinearResponseLimitError(operation, 'linear-response-too-large', this.#limits.responseBytes);
      if (bodies) this.#chargeBodies(operation, kept.body.length);
      return keptData<T>(operation, kept.status, kept.body);
    }
    const answer = await this.#network(operation, 'query', requestBody, bodies);
    if (key !== undefined) this.reads?.keep(key, { status: answer.status, type: 'application/json', body: Buffer.from(answer.text, 'utf8') });
    return answer.data as T;
  }

  /** Give optional reads at most this many extra bytes and leave half the budget for required reads. */
  optionalBodyLimit(bytes: number, share = 1): number {
    const remaining = Math.max(0, Math.floor(this.#limits.bodyBytes / 2) - this.#bodyBytesRead);
    return this.#bodyBytesRead + Math.floor(Math.min(bytes, remaining) * share);
  }

  /** Optional migration data can be omitted and replayed as omitted by the apply step. */
  async queryOptionalBodies<T>(operation: string, query: string, variables: Record<string, unknown>, limit: number, empty: T, allowLiveWithoutStage: boolean): Promise<T | undefined> {
    const requestBody = JSON.stringify({ query, variables, operationName: operation });
    const key = graphqlReadKey(`optional bodies\n${requestBody}`);
    const kept = this.reads?.take(key);
    if (kept !== undefined) {
      if (kept.type === 'application/x-mdbisync-page-split') return undefined;
      if (kept.body.length === 0 || kept.body.length > this.#limits.responseBytes || this.#bodyBytesRead + kept.body.length > limit) return empty;
      this.#chargeBodies(operation, kept.body.length);
      return keptData<T>(operation, kept.status, kept.body);
    }
    // A missing staged answer cannot authorize a live reread in the apply step.
    if (this.reads?.mode === 'replay' && !allowLiveWithoutStage) return empty;
    if (!this.#stopped && this.#bodyBytesRead < limit) {
      try {
        const answer = await this.#network(operation, 'query', requestBody, false, Math.min(this.#limits.responseBytes, limit - this.#bodyBytesRead));
        const body = Buffer.from(answer.text, 'utf8');
        if (this.#bodyBytesRead + body.length <= limit) {
          this.#chargeBodies(operation, body.length);
          this.reads?.keep(key, {status: answer.status, type: 'application/json', body});
          return answer.data as T;
        }
      } catch (error) {
        if (error instanceof LinearResponseLimitError) {
          this.reads?.keep(key, {status: 200, type: 'application/x-mdbisync-page-split', body: Buffer.alloc(0)});
          return undefined;
        }
        if (!(error instanceof LinearStoppedError) && !(error instanceof LinearError && isTransientLinearError(error))) throw error;
      }
    }
    this.reads?.keep(key, {status: 200, type: 'application/json', body: Buffer.alloc(0)});
    return empty;
  }

  /** A read that must reflect the token as it is now: never answered from the read store, never kept in it. */
  async queryLive<T>(operation: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (this.#stopped) throw this.#refuse(operation, 'query', this.#stopped);
    return (await this.#network(operation, 'query', JSON.stringify({ query, variables, operationName: operation }))).data as T;
  }

  /** Every write obtains its answer directly from the network, never the read store. */
  async mutate<T>(operation: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const requestBody = JSON.stringify({ query, variables, operationName: operation });
    return (await this.#network(operation, 'mutation', requestBody)).data as T;
  }

  /** Network execution shared by reads and writes; has no read-store access. */
  async #network(operation: string, kind: OperationKind, requestBody: string, bodies = false, responseLimit = this.#limits.responseBytes): Promise<{data: unknown; text: string; status: number}> {
    let waited = false;
    let renewed = false;
    for (let attempt = 1; ; attempt += 1) {
      if (this.#stopped) throw this.#refuse(operation, kind, this.#stopped);
      const info: RequestInfo = { operation, kind, attempt };
      await this.#hooks.beforeRequest?.(info);
      // Another request may have stopped the client while this one waited.
      if (this.#stopped) throw this.#refuse(operation, kind, this.#stopped);

      const token = await this.#accessToken();
      const started = Date.now();
      this.stats.count(operation);
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: requestBody,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        this.#log({ ...info, ...authMetadata(this.#auth), ...requestTiming(started), status: 'network-error', rateLimitHeaders: {} });
        throw new LinearNetworkError(operation, error);
      }

      const rateLimit = readRateLimitHeaders(response.headers);
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const durationMs = Date.now() - started;
      if (Object.keys(rateLimit.headers).length > 0) this.#lastRateLimit = rateLimit;
      try {
        await this.#hooks.afterResponse?.({ ...info, status: response.status, durationMs, rateLimit });
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        this.#log({ ...info, ...authMetadata(this.#auth), ...requestTiming(started), status: response.status,
          requestId, rateLimitHeaders: rateLimit.headers, responseHookFailed: true,
          ...(error instanceof LinearStoppedError ? { stop: error.reason } : {}) });
        throw error;
      }

      let body: { data?: unknown; errors?: GraphQLErrorShape[] } | undefined;
      let text = '';
      let bodyError: unknown;
      let over = false;
      let bytes = 0;
      try {
        const read = await readText(response, responseLimit);
        if (read === undefined) over = true;
        else {
          text = read.text;
          bytes = read.bytes;
          body = JSON.parse(text) as typeof body;
        }
      } catch (error) {
        body = undefined;
        bodyError = error;
      }

      const errorCodes = body?.errors?.map((error) => String(error.extensions?.code ?? 'unknown'));
      const entry: LogEntry = {
        ...info,
        ...authMetadata(this.#auth),
        ...requestTiming(started),
        status: response.status,
        rateLimitHeaders: rateLimit.headers,
        ...(requestId === undefined ? {} : { requestId }),
        ...(errorCodes === undefined ? {} : { errorCodes }),
      };

      if (isRateLimited(response.status, body?.errors)) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
        const shortWait = retryAfterSeconds !== undefined && retryAfterSeconds <= this.#maxRetryAfterSeconds;
        // No retry when the same answer also says the budget is below the floor.
        if (!waited && shortWait && !findLowBudget(operation, rateLimit, this.#floor)) {
          waited = true;
          this.#log({ ...entry, retryAfterSeconds });
          await this.#sleep(retryAfterSeconds * 1000);
          continue;
        }
        this.#stopped = { kind: 'rate-limited', operation, retryAfterSeconds, ...limitsOf(rateLimit) };
        this.#log({ ...entry, retryAfterSeconds, stop: this.#stopped });
        throw new LinearStoppedError(operation, this.#stopped);
      }

      const low = findLowBudget(operation, rateLimit, this.#floor);
      if (low) this.#stopped = low;
      this.#log(low ? { ...entry, stop: low } : entry);

      // Not after a stop: the request would be refused anyway.
      if (!renewed && !this.#stopped && isAuthenticationRefusal(response.status, body)) {
        renewed = true;
        if ((await this.#renewed(token)) !== undefined) continue;
      }

      if (over) {
        const error = new LinearResponseLimitError(operation, 'linear-response-too-large', responseLimit);
        // A write's answer that was not read leaves its outcome unknown, like a cut connection.
        throw kind === 'mutation' ? new LinearNetworkError(operation, error) : error;
      }
      const firstError = body?.errors?.[0];
      if (firstError) throw new LinearGraphQLError(operation, response.status, firstError, requestId);
      // A success status with an unreadable body (cut connection, timeout while
      // reading): the write may have been applied, so the outcome is unknown.
      if (response.ok && body === undefined) throw new LinearNetworkError(operation, bodyError);
      if (!response.ok || body === undefined || body.data === undefined || body.data === null) {
        throw new LinearHttpError(operation, response.status, requestId);
      }
      // Only an answer with data counts: an error answer (a rate limit, a lost cursor) is reported as itself above.
      if (bodies) this.#chargeBodies(operation, bytes);
      return {data: body.data, text, status: response.status};
    }
  }

  /** Counts an answer with document bodies toward the run's budget, or refuses it before its bodies are kept. */
  #chargeBodies(operation: string, bytes: number): void {
    if (this.#bodyBytesRead + bytes > this.#limits.bodyBytes) throw new LinearResponseLimitError(operation, 'linear-body-budget', this.#limits.bodyBytes);
    this.#bodyBytesRead += bytes;
  }

  /** A request after the stop is refused without being sent; a refused write is counted, so a run can show it stopped writing. */
  #refuse(operation: string, kind: OperationKind, reason: StopReason): LinearStoppedError {
    if (kind === 'mutation') this.stats.writesAfterStop += 1;
    return new LinearStoppedError(operation, reason);
  }

  #log(entry: LogEntry): void {
    emitLog(this.#hooks.log, entry);
  }
}

/** A kept answer: only answers with data and no errors are kept, so anything else is an error of the record. */
function keptData<T>(operation: string, status: number, bytes: Buffer): T {
  let body: { data?: unknown; errors?: unknown } | undefined;
  try {
    body = JSON.parse(bytes.toString('utf8')) as typeof body;
  } catch {
    body = undefined;
  }
  const errors = body?.errors;
  if (body === undefined || body === null || (Array.isArray(errors) ? errors.length > 0 : errors !== undefined) || body.data === undefined || body.data === null) {
    throw new LinearHttpError(operation, status, undefined);
  }
  return body.data as T;
}

/**
 * The answer's text and its size in bytes, or undefined when it has more
 * than `limit` bytes: reading stops there and the rest is never held.
 * Decoded like `response.text()`, which drops a leading byte order mark.
 */
async function readText(response: Response, limit: number): Promise<{ text: string; bytes: number } | undefined> {
  if (response.body === null) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks, bytes)), bytes };
}

/** A 401 without data: Linear refused the token before running anything, so the request can be sent again. */
function isAuthenticationRefusal(status: number, body: { data?: unknown } | undefined): boolean {
  return status === 401 && (body?.data === undefined || body.data === null);
}

function isRateLimited(status: number, errors: GraphQLErrorShape[] | undefined): boolean {
  return status === 429 || (errors ?? []).some((error) => error.extensions?.code === 'RATELIMITED');
}

/** The global fetch, called unbound. */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
