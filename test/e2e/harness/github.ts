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
  /** The App's bot login (`<slug>[bot]`), which GitHub names as the actor of what this token writes; App tokens only. */
  appLogin?: string;
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

/** The App's installation token for the sandbox, and the bot login GitHub shows for what that token writes. */
export async function appInstallationToken(config: TestConfig, fetchImpl: typeof fetch = fetch): Promise<{ token: string; appLogin: string }> {
  if (config.githubApp === null) throw new Error('the GitHub App key or client id is missing');
  const jwt = appJwt(config.githubApp.clientId, config.githubApp.privateKey);
  const installation = await call<{ id: number; app_slug: string }>(jwt, 'GET', `/repos/${config.owner}/${config.repo}/installation`, undefined, fetchImpl);
  const created = await call<{ token: string }>(jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, { repositories: [config.repo] }, fetchImpl);
  return { token: created.token, appLogin: `${installation.app_slug}[bot]` };
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
  if (config.githubApp !== null) return { ...(await appInstallationToken(config)), source: 'app' };
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
  run_attempt?: number;
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

/** One entry of GitHub's repository activity: a push, force push, branch creation or deletion. */
export interface PushActivity {
  ref: string;
  before: string;
  after: string;
  activity_type: string;
  actor: { login: string; type: string } | null;
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
   * the pull request reads back closed within `settleMs`. A read that fails
   * meanwhile is retried; the last failure is reported at the deadline.
   */
  async closePullRequest(number: number, settleMs = 15_000, pollMs = 1_000): Promise<void> {
    let reason = 'after the close';
    try {
      const closed = await this.request<PullRequest>('PATCH', `/pulls/${number}`, { state: 'closed' });
      if (closed?.state === 'closed') return;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      reason = `(${error.message})`;
    }
    const deadline = Date.now() + settleMs;
    for (;;) {
      try {
        if ((await this.pullRequest(number)).state === 'closed') return;
      } catch (error) {
        reason = `(${(error as Error).message})`;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`pull request ${number} is still open ${reason}`);
  }

  /**
   * Closes every open pull request whose head branch starts with `prefix`,
   * and returns their numbers once none reads open. A close that fails does
   * not stop the others; every failure is reported. The open listing can lag
   * behind a close, so a pull request it still lists is read on its own.
   */
  async closeOpenPullRequests(prefix: string, settleMs?: number, pollMs?: number): Promise<number[]> {
    const closed: number[] = [];
    const problems: string[] = [];
    for (const pr of await this.pullRequests(prefix, 'open')) {
      try {
        await this.closePullRequest(pr.number, settleMs, pollMs);
        closed.push(pr.number);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
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

  /**
   * GitHub's own record of the pushes to one ref, newest first: who
   * authenticated each push (`actor`) and the commit it set the ref to
   * (`after`). A run's refs see a few pushes; a full page could hide older
   * ones, so it is refused rather than read as complete.
   */
  async pushActivities(ref: string): Promise<PushActivity[]> {
    const activities = await this.request<PushActivity[]>('GET', `/activity?ref=${encodeURIComponent(ref)}&per_page=100&direction=desc`);
    if (activities.length >= 100) throw new Error(`GitHub lists 100 or more pushes to ${ref}; the harness reads one page`);
    return activities.filter((activity) => activity.ref === ref);
  }

  /** A file's text on `ref` (the default branch when absent), or undefined when it is not there. */
  async fileText(path: string, ref?: string): Promise<string | undefined> {
    try {
      const file = await this.request<{ content?: string; encoding?: string }>('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`}`);
      if (file.encoding !== 'base64' || file.content === undefined) throw new Error(`${path} is not a file GitHub returns whole`);
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Writes a file on the default branch in one commit, creating or replacing it. */
  async putFile(path: string, text: string, message: string): Promise<{ commit: string }> {
    const url = `/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    let sha: string | undefined;
    try {
      sha = (await this.request<{ sha: string }>('GET', url)).sha;
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
    const result = await this.request<{ commit: { sha: string } }>('PUT', url, { message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha === undefined ? {} : { sha }) });
    return { commit: result.commit.sha };
  }

  /** A workflow file's state in the Actions registry (`active`, or one of the disabled states), or undefined while it is not registered. */
  async workflowState(file: string): Promise<string | undefined> {
    try {
      return (await this.request<{ state: string }>('GET', `/actions/workflows/${encodeURIComponent(file)}`)).state;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** The newest runs of one workflow file on one event, newest first. */
  async workflowFileRuns(file: string, event: string): Promise<WorkflowRun[]> {
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>('GET', `/actions/workflows/${encodeURIComponent(file)}/runs?event=${encodeURIComponent(event)}&per_page=50`);
    return data.workflow_runs;
  }

  /** Creates a branch at a commit. */
  async createBranch(branch: string, sha: string): Promise<void> {
    await this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  }

  /** Whether a branch exists. */
  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.request('GET', `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  /** Deletes a branch; one that is already gone is no error. */
  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.request('DELETE', `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    } catch (error) {
      // GitHub answers 422 "Reference does not exist" for a deleted branch.
      if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return;
      throw error;
    }
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
