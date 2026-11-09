// Reading a commit's checks and merging a pull request with a merge commit,
// for callers that merge their own pull requests (the sync). The caller reads
// the checks itself, so merging does not depend on branch protection, which a
// private repository on GitHub Free cannot have.

import { type GitHubRepository, PullRequestError, request } from './github.ts';

/** Check run conclusions that let a merge go ahead. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** Enough for any real repository; a commit with more is read as pending, never as passed. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export interface CheckState {
  /** `passed`: every check finished and passed (also when there are none); `pending`: some still run; `failed`: one finished and failed. */
  state: 'passed' | 'pending' | 'failed';
  /** Names of the checks that failed, sorted. */
  failed: string[];
  /** Names of the checks that have not finished, sorted. */
  pending: string[];
}

/**
 * The checks on a commit: its check runs (GitHub Actions and other apps,
 * the latest run of each) and its commit statuses (the latest of each
 * context). A failure wins over a pending check, so a failed check is
 * reported as soon as it is seen.
 */
export async function readChecks(target: GitHubRepository, sha: string): Promise<CheckState> {
  const failed = new Set<string>();
  const pending = new Set<string>();

  let seen = 0;
  for (let page = 1; ; page += 1) {
    const answer = await request(target, 'GET', `/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
    const body = answer.json as { total_count?: unknown; check_runs?: unknown } | null;
    if (answer.status !== 200 || body === null || typeof body.total_count !== 'number' || !Array.isArray(body.check_runs)) {
      throw new PullRequestError('reading the check runs of the sync pull request', answer.status);
    }
    for (const run of body.check_runs as Array<{ name?: unknown; status?: unknown; conclusion?: unknown }>) {
      const name = typeof run.name === 'string' ? run.name : 'unnamed check';
      if (run.status !== 'completed') pending.add(name);
      else if (typeof run.conclusion !== 'string' || !PASSING_CONCLUSIONS.has(run.conclusion)) failed.add(name);
    }
    seen += body.check_runs.length;
    if (seen >= body.total_count) break;
    // Check runs GitHub counts but did not list are never read as passed.
    if (body.check_runs.length === 0 || page === MAX_PAGES) {
      pending.add(`${body.total_count - seen} more check runs`);
      break;
    }
  }

  const answer = await request(target, 'GET', `/commits/${sha}/status?per_page=${PAGE_SIZE}`);
  const combined = answer.json as { total_count?: unknown; statuses?: unknown } | null;
  if (answer.status !== 200 || combined === null || typeof combined.total_count !== 'number' || !Array.isArray(combined.statuses)) {
    throw new PullRequestError('reading the commit statuses of the sync pull request', answer.status);
  }
  // The combined status lists at most one page of contexts; ones it does not show are never read as passed.
  if (combined.total_count > combined.statuses.length) pending.add(`${combined.total_count - combined.statuses.length} more commit statuses`);
  for (const status of combined.statuses as Array<{ context?: unknown; state?: unknown }>) {
    const name = typeof status.context === 'string' ? status.context : 'unnamed status';
    if (status.state === 'pending') pending.add(name);
    else if (status.state !== 'success') failed.add(name);
  }

  const sorted = (names: Set<string>) => [...names].sort();
  return { state: failed.size > 0 ? 'failed' : pending.size > 0 ? 'pending' : 'passed', failed: sorted(failed), pending: sorted(pending) };
}

export type MergeOutcome =
  | { merged: true; sha: string }
  /** GitHub would not merge: the head moved (409), the pull request cannot be merged now (405), or it is not open (422). */
  | { merged: false; status: number; reason: string };

/** The longest reason kept from GitHub's answer. */
const REASON_LENGTH = 300;

/**
 * Merges a pull request with a merge commit, only while its head is still
 * `sha`, the commit whose checks the caller read.
 */
export async function mergePullRequest(target: GitHubRepository, number: number, sha: string): Promise<MergeOutcome> {
  const answer = await request(target, 'PUT', `/pulls/${number}/merge`, { merge_method: 'merge', sha });
  const body = answer.json as { merged?: unknown; sha?: unknown; message?: unknown } | null;
  if (answer.status === 200 && body !== null && body.merged === true && typeof body.sha === 'string') return { merged: true, sha: body.sha };
  if (answer.status === 405 || answer.status === 409 || answer.status === 422) {
    return { merged: false, status: answer.status, reason: refusalReason(body?.message) };
  }
  throw new PullRequestError('merging the sync pull request', answer.status);
}

/**
 * GitHub's message for a refused merge (a repository rule, a required review)
 * on one line, without backticks, so it can be quoted in Markdown.
 */
function refusalReason(message: unknown): string {
  if (typeof message !== 'string') return '';
  const line = message.replace(/[`\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > REASON_LENGTH ? `${line.slice(0, REASON_LENGTH - 1)}…` : line;
}
