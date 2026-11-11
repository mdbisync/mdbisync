// Pull requests through GitHub's REST API, with the token the run acts as
// (the deployer's GitHub App). Finds the open pull request from a branch or
// opens one. Merging is in merge.ts, for the callers that may merge.

import { DEFAULT_GITHUB_API_URL } from '../setup/github.ts';
import { message } from '../messages.ts';
import { setTimeout } from 'node:timers/promises';

export interface GitHubRepository {
  /** `owner/name`. */
  repository: string;
  token: string;
  apiUrl?: string | undefined;
  fetch?: typeof fetch;
  /** Bounds a sequence of requests, including reading their bodies. */
  signal?: AbortSignal;
  /** Counts the pull request calls GitHub accepted, by kind (`opened`, `updated`, `merged`, `closed`); a refused or unanswered call is not counted. */
  writes?: Map<string, number>;
}

/** A pull request call that writes, and the status with which GitHub accepts it. */
export interface WriteCall {
  kind: 'opened' | 'updated' | 'merged' | 'closed';
  accepted: number;
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
    super(status === undefined ? message('github.no-answer', { action: what }) : message('github.answered', { status, action: what }), cause === undefined ? undefined : { cause });
    this.name = 'PullRequestError';
    this.status = status;
  }
}

/** The open pull request from `head` into `base`, or null. */
export async function findOpenPullRequest(target: GitHubRepository, head: string, base: string): Promise<PullRequest | null> {
  const owner = target.repository.split('/')[0] as string;
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, base, per_page: '10' });
  const answer = await request(target, 'GET', `/pulls?${query.toString()}`);
  if (answer.status !== 200 || !Array.isArray(answer.json)) throw new PullRequestError(message('github.listing'), answer.status);
  const found = (answer.json as unknown[]).map(toPullRequest).find((pr) => pr !== null && pr.head === head && pr.base === base);
  return found ?? null;
}

/** Opens a pull request; the caller checks first that none is open. */
export async function openPullRequest(target: GitHubRepository, spec: NewPullRequest): Promise<PullRequest> {
  const answer = await request(target, 'POST', '/pulls', { title: spec.title, head: spec.head, base: spec.base, body: spec.body, maintainer_can_modify: false }, { kind: 'opened', accepted: 201 });
  const opened = answer.status === 201 ? toPullRequest(answer.json) : null;
  if (opened === null) throw new PullRequestError(message('github.opening'), answer.status);
  return opened;
}

/** Replaces a pull request's title and description. */
export async function updatePullRequest(target: GitHubRepository, number: number, text: { title: string; body: string }): Promise<PullRequest> {
  const answer = await request(target, 'PATCH', `/pulls/${number}`, { title: text.title, body: text.body }, { kind: 'updated', accepted: 200 });
  const updated = answer.status === 200 ? toPullRequest(answer.json) : null;
  if (updated === null) throw new PullRequestError(message('github.updating'), answer.status);
  return updated;
}

/** Closes a pull request without merging it. */
export async function closePullRequest(target: GitHubRepository, number: number): Promise<void> {
  const answer = await request(target, 'PATCH', `/pulls/${number}`, { state: 'closed' }, { kind: 'closed', accepted: 200 });
  if (answer.status !== 200) throw new PullRequestError(message('github.closing'), answer.status);
}

/**
 * A push updates GitHub's PR head asynchronously. Closing before that update
 * freezes the old diff, so wait for the exact empty head first. A stale head
 * gets up to five reads, at one-second intervals, with at most five seconds for the
 * whole read sequence (including response bodies). A later run can retry.
 */
export async function closePullRequestAtHead(target: GitHubRepository, number: number, head: string): Promise<boolean> {
  const deadline = AbortSignal.timeout(5_000);
  const signal = AbortSignal.any([deadline, ...(target.signal ? [target.signal] : [])]);
  let ready = false;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = await request({ ...target, signal }, 'GET', `/pulls/${number}`);
      if (answer.status !== 200) throw new PullRequestError(message('github.reading-pull-request'), answer.status);
      const pr = answer.json as { state?: unknown; head?: { sha?: unknown } } | null;
      if (pr?.state === 'closed') return true;
      if (pr?.state === 'open' && pr.head?.sha === head) {
        ready = true;
        break;
      }
      if (attempt < 4) await setTimeout(1_000, undefined, { signal });
    }
  } catch (error) {
    // Only our visibility deadline is an ordinary deferral. API failures and
    // cancellation of the caller retain their normal error reporting.
    if (error instanceof Error && error.name === 'AbortError') {
      if (deadline.aborted && !target.signal?.aborted) return false;
      throw new PullRequestError(message('github.sending', { method: 'GET' }), undefined, error);
    }
    if (!(error instanceof PullRequestError) || !deadline.aborted || target.signal?.aborted) throw error;
  }
  if (!ready) return false;
  await closePullRequest(target, number);
  return true;
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

/**
 * Sends one request to the repository's API. For a call that writes, GitHub's
 * accepting status is counted in `target.writes` as soon as it arrives, also
 * when the answer's body then cannot be read.
 */
export async function request(target: GitHubRepository, method: string, path: string, body?: Record<string, unknown>, write?: WriteCall): Promise<{ status: number; json: unknown }> {
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
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(target.signal ? [target.signal] : [])]),
    });
    status = response.status;
    if (write !== undefined && status === write.accepted) target.writes?.set(write.kind, (target.writes.get(write.kind) ?? 0) + 1);
    text = await response.text();
  } catch (error) {
    // No whole answer came (a reset connection, a timeout, also while the
    // body was read). The request may still have reached GitHub, so callers
    // treat it as failed and a later run reads back what happened. Anything
    // else is not GitHub's doing and is not hidden.
    if (!isTransportError(error)) throw error;
    throw new PullRequestError(message('github.sending', { method }), undefined, error);
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
