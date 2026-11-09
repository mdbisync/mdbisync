// Pull requests through GitHub's REST API, with the token the run acts as
// (the deployer's GitHub App). Finds the open pull request from a branch or
// opens one. Merging is in merge.ts, for the callers that may merge.

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
  title: string;
  body: string;
}

export interface NewPullRequest {
  /** The branch with the changes, in the same repository. */
  head: string;
  /** The branch the changes go to. */
  base: string;
  title: string;
  body: string;
}

/**
 * GitHub refused or failed a pull request request, or the request did not
 * complete (a reset connection, a timeout); carries the status, never a body.
 */
export class PullRequestError extends Error {
  /** GitHub's HTTP status; undefined when no answer came. */
  readonly status: number | undefined;

  constructor(what: string, status: number | undefined, cause?: unknown) {
    super(status === undefined ? `GitHub did not answer while ${what}` : `GitHub answered HTTP ${status} while ${what}`, cause === undefined ? undefined : { cause });
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

/** Replaces a pull request's title and description. */
export async function updatePullRequest(target: GitHubRepository, number: number, text: { title: string; body: string }): Promise<PullRequest> {
  const answer = await request(target, 'PATCH', `/pulls/${number}`, { title: text.title, body: text.body });
  const updated = answer.status === 200 ? toPullRequest(answer.json) : null;
  if (updated === null) throw new PullRequestError('updating a pull request', answer.status);
  return updated;
}

/** Closes a pull request without merging it. */
export async function closePullRequest(target: GitHubRepository, number: number): Promise<void> {
  const answer = await request(target, 'PATCH', `/pulls/${number}`, { state: 'closed' });
  if (answer.status !== 200) throw new PullRequestError('closing a pull request', answer.status);
}

/**
 * The open pull request from `head` into `base`, opened when there is none.
 * An open one gets the new title and description, which describe its head as
 * it is now.
 */
export async function ensurePullRequest(
  target: GitHubRepository,
  spec: NewPullRequest,
): Promise<{ pullRequest: PullRequest; opened: boolean; updated: boolean }> {
  const open = await findOpenPullRequest(target, spec.head, spec.base);
  if (open !== null) {
    if (open.title === spec.title && open.body === spec.body) return { pullRequest: open, opened: false, updated: false };
    return { pullRequest: await updatePullRequest(target, open.number, spec), opened: false, updated: true };
  }
  return { pullRequest: await openPullRequest(target, spec), opened: true, updated: false };
}

function toPullRequest(value: unknown): PullRequest | null {
  const pr = value as { number?: unknown; html_url?: unknown; title?: unknown; body?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown } } | null;
  if (pr === null || typeof pr !== 'object' || typeof pr.number !== 'number') return null;
  if (typeof pr.head?.ref !== 'string' || typeof pr.base?.ref !== 'string') return null;
  return {
    number: pr.number,
    url: typeof pr.html_url === 'string' ? pr.html_url : '',
    head: pr.head.ref,
    base: pr.base.ref,
    title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : '',
  };
}

export async function request(target: GitHubRepository, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '')}/repos/${target.repository}`;
  let status: number;
  let text: string;
  try {
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
    status = response.status;
    text = await response.text();
  } catch (error) {
    // No whole answer came (a reset connection, a timeout, also while the
    // body was read). The request may still have reached GitHub, so callers
    // treat it as failed and a later run reads back what happened. Anything
    // else is not GitHub's doing and is not hidden.
    if (!isTransportError(error)) throw error;
    throw new PullRequestError(`sending ${method} to the pull request API`, undefined, error);
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A body that is not JSON carries nothing the caller needs.
  }
  return { status, json };
}

/** What fetch throws when no answer comes: a network failure (`TypeError`) or the timeout (`TimeoutError`, `AbortError`). */
function isTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
