// GitHub access for the harness: a token that starts workflows (the GitHub
// App's installation token when its key is present, else the host's own git
// credential for the sandbox), and the few REST calls the harness needs.

import { createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { TestConfig } from './config.ts';

const API = 'https://api.github.com';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** A GitHub App JWT (RS256), valid for nine minutes, issued a minute in the past for clock skew. */
export function appJwt(clientId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: clientId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface GitHubToken {
  token: string;
  source: 'app' | 'host';
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

async function call<T>(token: string, method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'scenario-harness',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new GitHubError(`${method} ${path.split('?')[0]}: HTTP ${response.status}`, response.status);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export async function appInstallationToken(config: TestConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (config.githubApp === null) throw new Error('the GitHub App key or client id is missing');
  const jwt = appJwt(config.githubApp.clientId, config.githubApp.privateKey);
  const installation = await call<{ id: number }>(jwt, 'GET', `/repos/${config.owner}/${config.repo}/installation`, undefined, fetchImpl);
  const created = await call<{ token: string }>(jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, { repositories: [config.repo] }, fetchImpl);
  return created.token;
}

/** The host's git credential for the sandbox, through git's credential helper. */
export function hostToken(config: TestConfig): string | null {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\npath=${config.owner}/${config.repo}.git\n\n`,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) return null;
  return /^password=(.+)$/m.exec(result.stdout)?.[1] ?? null;
}

/** Local runs: the App when its key is present, else the host's token. Actions mode always uses the App. */
export async function githubToken(config: TestConfig, mode: 'local' | 'actions'): Promise<GitHubToken> {
  if (config.githubApp !== null) return { token: await appInstallationToken(config), source: 'app' };
  if (mode === 'actions') throw new Error(`actions mode needs the GitHub App: ${config.githubAppMissing.join(' and ')} not in the test secrets`);
  const token = hostToken(config);
  if (token === null) throw new Error('no GitHub token: neither the App key nor a host credential for the sandbox');
  return { token, source: 'host' };
}

/** Environment that makes git authenticate with `token` without putting it on a command line or in a URL. */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
  merged_at: string | null;
  created_at: string;
}

export class SandboxRest {
  readonly #token: string;
  readonly #repoPath: string;
  readonly #fetch: typeof fetch;

  constructor(config: Pick<TestConfig, 'owner' | 'repo'>, token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#repoPath = `/repos/${config.owner}/${config.repo}`;
    this.#fetch = fetchImpl;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(this.#token, method, `${this.#repoPath}${path}`, body, this.#fetch);
  }

  /** Pull requests whose head branch starts with `prefix` (all states, newest first). */
  async pullRequests(prefix: string, state: 'open' | 'all' = 'all'): Promise<PullRequest[]> {
    const result: PullRequest[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.request<PullRequest[]>('GET', `/pulls?state=${state}&per_page=100&page=${page}&sort=created&direction=desc`);
      result.push(...batch.filter((pr) => pr.head.ref.startsWith(prefix)));
      if (batch.length < 100) break;
    }
    return result;
  }

  async closePullRequest(number: number): Promise<void> {
    await this.request('PATCH', `/pulls/${number}`, { state: 'closed' });
  }

  async workflowExists(file: string, ref: string): Promise<boolean> {
    try {
      await this.request('GET', `/contents/.github/workflows/${encodeURIComponent(file)}?ref=${encodeURIComponent(ref)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  async dispatchWorkflow(file: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.request('POST', `/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref, inputs });
  }

  async workflowRuns(branch: string): Promise<Array<{ id: number; status: string; conclusion: string | null; event: string; created_at: string }>> {
    const data = await this.request<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; event: string; created_at: string }> }>(
      'GET',
      `/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`,
    );
    return data.workflow_runs;
  }
}
