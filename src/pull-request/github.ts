// Pull requests through GitHub's REST API, with the token the run acts as
// (the deployer's GitHub App). Finds the open pull request from a branch or
// opens one. Never merges: callers that may merge do it themselves.

import { DEFAULT_GITHUB_API_URL } from '../setup/github.ts';

export interface GitHubRepository {
  /** `owner/name`. */
  repository: string;
  token: string;
  apiUrl?: string | undefined;
  fetch?: typeof fetch;
}

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  base: string;
}

export interface NewPullRequest {
  /** The branch with the changes, in the same repository. */
  head: string;
  /** The branch the changes go to. */
  base: string;
  title: string;
  body: string;
}

/** GitHub refused or failed a pull request request; carries the status, never a body. */
export class PullRequestError extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`GitHub answered HTTP ${status} while ${what}`);
    this.name = 'PullRequestError';
    this.status = status;
  }
}

/** The open pull request from `head` into `base`, or null. */
export async function findOpenPullRequest(target: GitHubRepository, head: string, base: string): Promise<PullRequest | null> {
  const owner = target.repository.split('/')[0] as string;
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, base, per_page: '10' });
  const answer = await request(target, 'GET', `/pulls?${query.toString()}`);
  if (answer.status !== 200 || !Array.isArray(answer.json)) throw new PullRequestError('listing open pull requests', answer.status);
  const found = (answer.json as unknown[]).map(toPullRequest).find((pr) => pr !== null && pr.head === head && pr.base === base);
  return found ?? null;
}

/** Opens a pull request; the caller checks first that none is open. */
export async function openPullRequest(target: GitHubRepository, spec: NewPullRequest): Promise<PullRequest> {
  const answer = await request(target, 'POST', '/pulls', { title: spec.title, head: spec.head, base: spec.base, body: spec.body, maintainer_can_modify: false });
  const opened = answer.status === 201 ? toPullRequest(answer.json) : null;
  if (opened === null) throw new PullRequestError('opening a pull request', answer.status);
  return opened;
}

/** The open pull request from `head` into `base`, opened when there is none. */
export async function ensurePullRequest(target: GitHubRepository, spec: NewPullRequest): Promise<{ pullRequest: PullRequest; opened: boolean }> {
  const open = await findOpenPullRequest(target, spec.head, spec.base);
  if (open !== null) return { pullRequest: open, opened: false };
  return { pullRequest: await openPullRequest(target, spec), opened: true };
}

function toPullRequest(value: unknown): PullRequest | null {
  const pr = value as { number?: unknown; html_url?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown } } | null;
  if (pr === null || typeof pr !== 'object' || typeof pr.number !== 'number') return null;
  if (typeof pr.head?.ref !== 'string' || typeof pr.base?.ref !== 'string') return null;
  return { number: pr.number, url: typeof pr.html_url === 'string' ? pr.html_url : '', head: pr.head.ref, base: pr.base.ref };
}

async function request(target: GitHubRepository, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '')}/repos/${target.repository}`;
  const response = await (target.fetch ?? fetch)(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A body that is not JSON carries nothing the caller needs.
  }
  return { status: response.status, json };
}
