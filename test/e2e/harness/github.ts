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
  head: { ref: string; sha: string };
  base: { ref: string };
  merged_at: string | null;
  created_at: string;
  user?: { login: string } | null;
  merged_by?: { login: string } | null;
  merge_commit_sha?: string | null;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  run_started_at?: string;
  updated_at?: string;
  head_branch?: string;
  head_sha?: string;
  path?: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  html_url?: string;
}

export interface WorkflowStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: WorkflowStep[];
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

  /** Bytes of a repository API path that answers with a redirect to a file (artifacts, logs). */
  async download(path: string): Promise<Buffer> {
    const response = await this.#fetch(`${API}${this.#repoPath}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.#token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'scenario-harness' },
    });
    if (!response.ok) throw new GitHubError(`GET ${path.split('?')[0]}: HTTP ${response.status}`, response.status);
    return Buffer.from(await response.arrayBuffer());
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

  async pullRequest(number: number): Promise<PullRequest> {
    return this.request('GET', `/pulls/${number}`);
  }

  /**
   * Closes a pull request and returns once it reads back closed. Deleting a
   * pull request's head branch makes GitHub close it itself, a little later,
   * and answer 422 to the close meanwhile: a 422 counts as closed only when
   * the pull request reads back closed within `settleMs`.
   */
  async closePullRequest(number: number, settleMs = 15_000, pollMs = 1_000): Promise<void> {
    let refused: GitHubError | undefined;
    try {
      const closed = await this.request<PullRequest>('PATCH', `/pulls/${number}`, { state: 'closed' });
      if (closed?.state === 'closed') return;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      refused = error;
    }
    const deadline = Date.now() + settleMs;
    for (;;) {
      if ((await this.pullRequest(number)).state === 'closed') return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new GitHubError(`pull request ${number} is still open${refused === undefined ? ' after the close' : ` (${refused.message})`}`, refused?.status ?? 0);
  }

  /**
   * Closes every open pull request whose head branch starts with `prefix`,
   * and returns their numbers once none reads open. The open listing can lag
   * behind a close, so a pull request it still lists is read on its own.
   */
  async closeOpenPullRequests(prefix: string, settleMs?: number, pollMs?: number): Promise<number[]> {
    const closed: number[] = [];
    for (const pr of await this.pullRequests(prefix, 'open')) {
      await this.closePullRequest(pr.number, settleMs, pollMs);
      closed.push(pr.number);
    }
    const open: number[] = [];
    for (const pr of await this.pullRequests(prefix, 'open')) if ((await this.pullRequest(pr.number)).state !== 'closed') open.push(pr.number);
    if (open.length > 0) throw new Error(`pull requests still open: ${open.join(', ')}`);
    return closed;
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

  /** The id of a `.github/workflows/` file in the repository's Actions registry, or undefined while it is not registered. */
  async workflowId(file: string): Promise<number | undefined> {
    const data = await this.request<{ workflows: Array<{ id: number; path: string }> }>('GET', '/actions/workflows?per_page=100');
    return data.workflows.find((workflow) => workflow.path === `.github/workflows/${file}`)?.id;
  }

  /** Dispatches a registered workflow, by its registry id (workflowId), on `ref`. */
  async dispatchWorkflow(workflowId: number, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.request('POST', `/actions/workflows/${workflowId}/dispatches`, { ref, inputs });
  }

  /** A run's jobs and their steps, in order. */
  async runJobs(runId: number): Promise<WorkflowJob[]> {
    const data = await this.request<{ jobs: WorkflowJob[] }>('GET', `/actions/runs/${runId}/jobs?per_page=100`);
    return data.jobs;
  }

  async workflowRuns(branch: string): Promise<WorkflowRun[]> {
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>('GET', `/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`);
    return data.workflow_runs;
  }

  async mergePullRequest(number: number): Promise<{ sha: string }> {
    return this.request('PUT', `/pulls/${number}/merge`, { merge_method: 'merge' });
  }

  async openPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequest> {
    return this.request('POST', '/pulls', { head, base, title, body });
  }
}
