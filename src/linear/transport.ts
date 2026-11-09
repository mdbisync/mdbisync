// GraphQL transport: one POST per operation, request counting, rate-limit
// handling and hooks for an external budget governor.
//
// Rate limits (Linear answers 429, or a GraphQL error with code RATELIMITED):
// - with a short Retry-After, wait and retry once;
// - otherwise stop: this request and every later one throws LinearStoppedError.
// After each response the remaining-budget headers are checked against the
// budget floor; below it the client stops before the next request.

import {
  LinearGraphQLError,
  LinearHttpError,
  LinearNetworkError,
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

export const DEFAULT_BASE_URL = 'https://api.linear.app';

export type OperationKind = 'query' | 'mutation';

export interface RequestInfo {
  operation: string;
  kind: OperationKind;
  /** 1 for the first try, 2 for the single retry after a short Retry-After. */
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
  /** Answers kept from an earlier step of the job, or where to keep this one's (see reads.ts). */
  reads?: LinearReads;
  /** Safe mint metadata for correlating this token's requests, never credentials. */
  auth?: AuthContext;
  /** API origin; a test proxy can sit here. Defaults to https://api.linear.app. */
  baseUrl?: string | undefined;
  budgetFloor?: Partial<BudgetFloor>;
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
  #auth: AuthContext | undefined;
  #floor: BudgetFloor;
  #maxRetryAfterSeconds: number;
  #timeoutMs: number;
  #hooks: LinearHooks;
  #sleep: (ms: number) => Promise<void>;
  #stopped: StopReason | undefined;
  #lastRateLimit: RateLimitSnapshot | undefined;

  constructor(options: TransportOptions) {
    this.#token = options.token;
    if (options.reads !== undefined) this.reads = options.reads;
    this.#auth = authMetadata(options.auth);
    this.baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#floor = { ...DEFAULT_BUDGET_FLOOR, ...options.budgetFloor };
    this.#maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 10;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#hooks = options.hooks ?? {};
    this.stats = options.stats ?? new RequestStats();
    this.fetch = options.fetch ?? defaultFetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Authenticated storage GET, restricted to Linear's documented upload host. */
  async fetchUpload(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'uploads.linear.app' || target.username !== '' || target.password !== '' || target.port !== '') {
      throw new Error('upload destination is not allowed');
    }
    return this.fetch(url, { ...init, method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${await this.#accessToken()}` } });
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
    const requestBody = JSON.stringify({ query, variables, operationName: operation });
    // Only reads are kept and answered again; a write always reaches Linear.
    const key = this.reads !== undefined && kind === 'query' ? graphqlReadKey(requestBody) : undefined;
    for (let attempt = 1; ; attempt += 1) {
      if (this.#stopped) throw this.#refuse(operation, kind, this.#stopped);
      const kept = attempt === 1 && key !== undefined ? this.reads?.take(key) : undefined;
      if (kept !== undefined) return keptData<T>(operation, kept.status, kept.body);
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
      try {
        text = await response.text();
        body = JSON.parse(text) as typeof body;
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
        if (attempt === 1 && shortWait && !findLowBudget(operation, rateLimit, this.#floor)) {
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

      const firstError = body?.errors?.[0];
      if (firstError) throw new LinearGraphQLError(operation, response.status, firstError, requestId);
      // A success status with an unreadable body (cut connection, timeout while
      // reading): the write may have been applied, so the outcome is unknown.
      if (response.ok && body === undefined) throw new LinearNetworkError(operation, bodyError);
      if (!response.ok || body === undefined || body.data === undefined || body.data === null) {
        throw new LinearHttpError(operation, response.status, requestId);
      }
      if (key !== undefined) this.reads?.keep(key, { status: response.status, type: 'application/json', body: Buffer.from(text, 'utf8') });
      return body.data as T;
    }
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

function isRateLimited(status: number, errors: GraphQLErrorShape[] | undefined): boolean {
  return status === 429 || (errors ?? []).some((error) => error.extensions?.code === 'RATELIMITED');
}

/** The global fetch, called unbound. */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
