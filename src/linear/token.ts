// Run tokens: each run exchanges the OAuth app's client credentials for a
// fresh app-actor token and revokes it when the run ends, also on failure.
// The action's `post` step revokes a token left behind by a killed run with
// `revokeToken`.

import { authMetadata, emitLog, requestTiming, type AuthContext } from './diagnostics.ts';
import { readRateLimitHeaders } from './rate-limit.ts';
import { LinearTokenError } from './errors.ts';
import { RequestStats } from './stats.ts';
import { DEFAULT_BASE_URL, defaultFetch, trimSlash, type LinearHooks, type LogEntry } from './transport.ts';

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
    throw new LinearTokenError('oauth.token', `oauth.token: Linear refused the token request (${reason})`);
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
    throw new LinearTokenError('oauth.revoke', `oauth.revoke: Linear did not confirm the revocation (HTTP ${response.status})`);
  }
}

/**
 * Mints a token, runs `work` with it and revokes it afterwards, whether `work`
 * succeeded or not. A failed revocation never replaces the run's own outcome
 * (its result or its error): it goes to `onRevokeError`, which the caller
 * must give, so a token left active is reported, never silent.
 */
export async function withRunToken<T>(
  credentials: AppCredentials,
  options: TokenOptions & { onRevokeError: (error: unknown) => void },
  work: (token: RunToken) => Promise<T>,
): Promise<T> {
  const token = await mintAppToken(credentials, options);
  try {
    return await work(token);
  } finally {
    try {
      await revokeToken(token.accessToken, { ...options, auth: token.context });
    } catch (revokeError) {
      options.onRevokeError(revokeError);
    }
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
    throw new LinearTokenError(operation, `${operation}: request to Linear failed`, { cause: error });
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
