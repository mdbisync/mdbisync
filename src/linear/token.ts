// Run tokens: each run exchanges the OAuth app's client credentials for a
// fresh app-actor token and revokes it when the run ends, also on failure.
// The action's `post` step revokes a token left behind by a killed run with
// `revokeToken`.

import { LinearTokenError } from './errors.ts';
import { RequestStats } from './stats.ts';
import { DEFAULT_BASE_URL, defaultFetch, trimSlash } from './transport.ts';

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
}

export interface RunToken {
  accessToken: string;
  /** Seconds until Linear expires the token. */
  expiresIn: number;
  scope: string[];
}

export async function mintAppToken(credentials: AppCredentials, options: TokenOptions = {}): Promise<RunToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: (credentials.scopes ?? ['read', 'write']).join(','),
  });
  const response = await oauthPost('oauth.token', '/oauth/token', body, options);
  const json = (await readJson(response)) as Partial<{
    access_token: string;
    expires_in: number;
    scope: string | string[];
    error: string;
  }>;
  if (!response.ok || typeof json.access_token !== 'string') {
    const reason = typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
    throw new LinearTokenError('oauth.token', `oauth.token: Linear refused the token request (${reason})`);
  }
  const scope = Array.isArray(json.scope) ? json.scope : (json.scope ?? '').split(/[ ,]+/).filter(Boolean);
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 0, scope };
}

/**
 * Revokes a token. A success status means revoked (Linear also answers
 * `{"success": true}`, but an empty body is accepted); an error status or an
 * explicit `success: false` throws LinearTokenError.
 */
export async function revokeToken(accessToken: string, options: TokenOptions = {}): Promise<void> {
  const response = await oauthPost('oauth.revoke', '/oauth/revoke', new URLSearchParams({ token: accessToken }), options);
  const json = (await readJson(response)) as { success?: unknown };
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
      await revokeToken(token.accessToken, options);
    } catch (revokeError) {
      options.onRevokeError(revokeError);
    }
  }
}

async function oauthPost(
  operation: string,
  path: string,
  body: URLSearchParams,
  options: TokenOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? defaultFetch;
  options.stats?.count(operation);
  try {
    return await fetchImpl(`${trimSlash(options.baseUrl ?? DEFAULT_BASE_URL)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new LinearTokenError(operation, `${operation}: request to Linear failed`, { cause: error });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
