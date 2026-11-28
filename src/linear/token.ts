// Run tokens: each run exchanges the OAuth app's client credentials for a
// fresh app-actor token and revokes it when the run ends, also on failure.
// A request Linear refuses because another run of the same app revoked the
// shared token gets a fresh one (`TokenRenewal`).
// The action's `post` step revokes a token left behind by a killed run with
// `revokeToken`.

import { authMetadata, emitLog, requestTiming, type AuthContext } from './diagnostics.ts';
import { readRateLimitHeaders } from './rate-limit.ts';
import { LinearTokenError } from './errors.ts';
import { RequestStats } from './stats.ts';
import { DEFAULT_BASE_URL, defaultFetch, trimSlash, type LinearHooks, type LogEntry } from './transport.ts';
import { message } from '../messages.ts';

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  /** Defaults to read and write. */
  scopes?: string[];
}

export interface TokenOptions {
  baseUrl?: string | undefined;
  stats?: RequestStats;
  fetch?: typeof fetch;
  timeoutMs?: number;
  hooks?: Pick<LinearHooks, 'log'>;
  /** Mint metadata, when revoking a token created by this run. */
  auth?: AuthContext;
}

export interface RunToken {
  accessToken: string;
  /** Seconds until Linear expires the token. */
  expiresIn: number;
  scope: string[];
  context: AuthContext;
}

export async function mintAppToken(credentials: AppCredentials, options: TokenOptions = {}): Promise<RunToken> {
  const requestedScopes = credentials.scopes ?? ['read', 'write'];
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: requestedScopes.join(','),
  });
  const { response, json } = await oauthPost('oauth.token', '/oauth/token', body, options, requestedScopes);
  if (!response.ok || typeof json.access_token !== 'string') {
    const reason = oauthErrorCode(json.error) ?? `HTTP ${response.status}`;
    throw new LinearTokenError('oauth.token', message('linear.token-refused', { reason }), { httpStatus: response.status });
  }
  const scope = readScopes(json.scope);
  return {
    accessToken: json.access_token,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 0,
    scope,
    context: { grantType: 'client_credentials', requestedScopes: [...requestedScopes], returnedScopes: [...scope] },
  };
}

/**
 * Revokes a token. A success status means revoked (Linear also answers
 * `{"success": true}`, but an empty body is accepted); an error status or an
 * explicit `success: false` throws LinearTokenError.
 */
export async function revokeToken(accessToken: string, options: TokenOptions = {}): Promise<void> {
  const { response, json } = await oauthPost('oauth.revoke', '/oauth/revoke', new URLSearchParams({ token: accessToken }), options);
  if (!response.ok || json.success === false) {
    throw new LinearTokenError('oauth.revoke', message('linear.revoke-unconfirmed', { status: response.status }), {
      httpStatus: response.status,
    });
  }
}

/**
 * Lets a caller keep a minted token where a later process can revoke it
 * (the action's `post` step), and forget it once this run revoked it.
 */
export interface TokenLifecycle {
  minted(accessToken: string): void;
  revoked(): void;
}

/**
 * A run's hold on its token, for a token another holder of the same Linear
 * app may revoke. Linear gives concurrent mints of one app's client
 * credentials the same token, so another run (another repository on the same
 * app, a test worker) that ends revokes the token this run holds. A request
 * Linear refuses with 401 then asks `renew` for a fresh token.
 */
export interface TokenRenewal {
  /**
   * The token to use after Linear refused `rejected`: the run's current one
   * when another request already renewed it, a freshly minted one otherwise.
   * When Linear hands back `rejected` itself, the token is still active and
   * the refusal was about something else; the caller then keeps the refusal.
   */
  renew(rejected: string): Promise<string>;
}

type RunTokenOptions = TokenOptions & { onRevokeError: (error: unknown) => void; lifecycle?: TokenLifecycle };

/**
 * Mints the run's token on first use and again on renewal, and revokes the
 * last one at the end. A token replaced by a renewal is not revoked: Linear
 * refused it, so it is already ended.
 */
class RunTokenHold implements TokenRenewal {
  readonly #credentials: AppCredentials;
  readonly #options: RunTokenOptions;
  #current: Promise<RunToken> | undefined;
  #last: RunToken | undefined;

  constructor(credentials: AppCredentials, options: RunTokenOptions) {
    this.#credentials = credentials;
    this.#options = options;
  }

  token(): Promise<RunToken> {
    return this.#current ??= this.#mint();
  }

  async accessToken(): Promise<string> {
    return (await this.token()).accessToken;
  }

  async renew(rejected: string): Promise<string> {
    const held = this.#current;
    const current = await held?.catch(() => undefined);
    // Another request renewed it while this one waited, or a mint is under way.
    if (this.#current !== held || (current !== undefined && current.accessToken !== rejected)) return this.accessToken();
    const next = this.#mint();
    this.#current = next;
    // A failed renewal fails only the request that asked for it: later ones go on from the token held before.
    next.catch(() => {
      if (this.#current === next) this.#current = held;
    });
    return this.accessToken();
  }

  async #mint(): Promise<RunToken> {
    const token = await mintAppToken(this.#credentials, this.#options);
    this.#last = token;
    // A lifecycle that fails fails the request; the token is still revoked at the end.
    this.#options.lifecycle?.minted(token.accessToken);
    return token;
  }

  /** Revokes the last token; a failure goes to `onRevokeError`, never replacing the run's outcome. */
  async end(): Promise<void> {
    // A mint that failed left no token; its error reached the request that asked for it.
    await this.#current?.catch(() => undefined);
    if (this.#last !== undefined) await endRunToken(this.#last, this.#options);
  }
}

/**
 * Mints a token, runs `work` with it and revokes it afterwards, whether `work`
 * succeeded or not. A failed revocation never replaces the run's own outcome
 * (its result or its error): it goes to `onRevokeError`, which the caller
 * must give, so a token left active is reported, never silent. `accessToken`
 * is the first token; requests that pass `current` and `renew` to the client
 * survive another run of the same app revoking it.
 */
export async function withRunToken<T>(
  credentials: AppCredentials,
  options: RunTokenOptions,
  work: (token: RunToken & TokenRenewal & { current(): Promise<string> }) => Promise<T>,
): Promise<T> {
  const hold = new RunTokenHold(credentials, options);
  try {
    const token = await hold.token();
    return await work({ ...token, current: () => hold.accessToken(), renew: (rejected) => hold.renew(rejected) });
  } finally {
    await hold.end();
  }
}

/** Revokes a run's token; a failure goes to `onRevokeError`, never replacing the run's outcome. */
async function endRunToken(token: RunToken, options: RunTokenOptions): Promise<void> {
  let revoked = false;
  try {
    await revokeToken(token.accessToken, { ...options, auth: token.context });
    revoked = true;
  } catch (revokeError) {
    options.onRevokeError(revokeError);
  }
  // Forgetting a revoked token is best effort: a later revocation of it is harmless.
  if (revoked) {
    try {
      options.lifecycle?.revoked();
    } catch {
      // Nothing to report: the token is revoked.
    }
  }
}

/** A run token that is minted when a request first needs it. */
export interface DeferredRunToken extends TokenRenewal {
  /** The scopes an earlier step's token of the same credentials returned. */
  scope: string[];
  context: AuthContext;
  /** Mints the token on the first call; later calls give the same one until a renewal. */
  accessToken(): Promise<string>;
}

/**
 * Like `withRunToken`, for a run that may need no request of its own (its
 * reads are answered from an earlier step's): the token is minted on the
 * first request, and revoked afterwards only when it was minted.
 */
export async function withDeferredRunToken<T>(
  credentials: AppCredentials,
  known: { scope: string[]; context: AuthContext },
  options: RunTokenOptions,
  work: (token: DeferredRunToken) => Promise<T>,
): Promise<T> {
  const hold = new RunTokenHold(credentials, options);
  const token: DeferredRunToken = {
    scope: [...known.scope],
    context: known.context,
    accessToken: () => hold.accessToken(),
    renew: (rejected) => hold.renew(rejected),
  };
  try {
    return await work(token);
  } finally {
    await hold.end();
  }
}

interface OAuthBody {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  success?: unknown;
}

async function oauthPost(
  operation: string,
  path: string,
  body: URLSearchParams,
  options: TokenOptions,
  requestedScopes?: string[],
): Promise<{ response: Response; json: OAuthBody }> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const started = Date.now();
  const info = {
    operation, kind: 'oauth' as const, attempt: 1,
    ...(requestedScopes ? { grantType: 'client_credentials' as const, requestedScopes: [...requestedScopes] } : authMetadata(options.auth)),
  };
  options.stats?.count(operation);
  let response: Response;
  try {
    response = await fetchImpl(`${trimSlash(options.baseUrl ?? DEFAULT_BASE_URL)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    emitLog<LogEntry>(options.hooks?.log, { ...info, ...requestTiming(started), status: 'network-error', rateLimitHeaders: {} });
    throw new LinearTokenError(operation, message('linear.token-request-failed', { operation }), { cause: error });
  }
  const json = await readJson(response);
  emitLog<LogEntry>(options.hooks?.log, {
    ...info, ...requestTiming(started), status: response.status,
    ...(requestedScopes ? { returnedScopes: readScopes(json.scope) } : {}),
    requestId: response.headers.get('x-request-id') ?? undefined,
    errorCodes: json.error === undefined ? [] : [oauthErrorCode(json.error) ?? 'unknown'],
    ...(operation === 'oauth.revoke' ? { revocationConfirmed: response.ok && json.success !== false } : {}),
    rateLimitHeaders: readRateLimitHeaders(response.headers).headers,
  });
  return { response, json };
}

/** OAuth errors are codes, never arbitrary response descriptions. */
function oauthErrorCode(error: unknown): string | undefined {
  return typeof error === 'string' && [
    'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
    'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error',
    'temporarily_unavailable', 'Error',
  ].includes(error) ? error : undefined;
}

function readScopes(scope: unknown): string[] {
  return Array.isArray(scope) ? scope.filter((s): s is string => typeof s === 'string')
    : typeof scope === 'string' ? scope.split(/[ ,]+/).filter(Boolean) : [];
}

async function readJson(response: Response): Promise<OAuthBody> {
  try {
    const json: unknown = await response.json();
    return json !== null && typeof json === 'object' ? json as OAuthBody : {};
  } catch {
    return {};
  }
}
