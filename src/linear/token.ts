// Run tokens: each run exchanges the OAuth app's client credentials for a
// fresh app-actor token and revokes it when the run ends, also on failure.
// The action's `post` step revokes a token left behind by a killed run with
// `revokeToken`.

import { LinearTokenError } from './errors.ts';
import { RequestStats } from './stats.ts';
import { DEFAULT_BASE_URL, trimSlash } from './transport.ts';

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

/** Revokes a token. Throws LinearTokenError when Linear does not confirm. */
export async function revokeToken(accessToken: string, options: TokenOptions = {}): Promise<void> {
  const response = await oauthPost('oauth.revoke', '/oauth/revoke', new URLSearchParams({ token: accessToken }), options);
  const json = (await readJson(response)) as { success?: unknown };
  if (!response.ok || json.success !== true) {
    throw new LinearTokenError('oauth.revoke', `oauth.revoke: Linear did not confirm the revocation (HTTP ${response.status})`);
  }
}

/**
 * Mints a token, runs `work` with it and revokes it afterwards, whether `work`
 * succeeded or not. When `work` fails, its error is thrown and a failed
 * revocation goes to `onRevokeError`; when only the revocation fails, its
 * error is thrown, so a token left active is never silent.
 */
export async function withRunToken<T>(
  credentials: AppCredentials,
  options: TokenOptions & { onRevokeError?: (error: unknown) => void },
  work: (token: RunToken) => Promise<T>,
): Promise<T> {
  const token = await mintAppToken(credentials, options);
  let result: T;
  try {
    result = await work(token);
  } catch (workError) {
    try {
      await revokeToken(token.accessToken, options);
    } catch (revokeError) {
      options.onRevokeError?.(revokeError);
    }
    throw workError;
  }
  await revokeToken(token.accessToken, options);
  return result;
}

async function oauthPost(
  operation: string,
  path: string,
  body: URLSearchParams,
  options: TokenOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
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
