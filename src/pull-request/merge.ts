// Reading a commit's checks and merging a pull request with a merge commit,
// for callers that merge their own pull requests (the sync). The caller reads
// the checks itself, so merging does not depend on branch protection, which a
// private repository on GitHub Free cannot have.

import { setTimeout as sleep } from 'node:timers/promises';
import { type CheckClock, type GitHubRepository, PullRequestError, request } from './github.ts';
import { message } from '../messages.ts';

/** Check run conclusions that let a merge go ahead. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** Enough for any real repository; a commit with more is read as pending, never as passed. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const REAL_CLOCK: CheckClock = { now: () => performance.now(), sleep: (ms) => sleep(ms), timeout: (ms) => AbortSignal.timeout(ms) };

export interface CheckState {
  /** `passed`: every check finished and passed (also when there are none); `pending`: some still run; `failed`: one finished and failed. */
  state: 'passed' | 'pending' | 'failed';
  /** Names of the checks that failed, sorted. */
  failed: string[];
  /** Whether GitHub has registered any checks or statuses. */
  hasChecks: boolean;
  /** Names of the checks that have not finished, sorted. */
  pending: string[];
  /** The failed checks with their runs, sorted by name; absent when nothing failed. */
  failures?: CheckFailure[];
  /** Names of the checks that finished and passed, sorted; absent when none did. */
  succeeded?: string[];
  /** Expected checks that are not registered on the commit, sorted; absent when none is missing. */
  missing?: string[];
}

/** What a commit must show beyond the checks registered on it before it counts as passed. */
export interface CheckExpectation {
  /** Check names that must be registered on the commit and pass there; an absent one keeps it pending. */
  names?: readonly string[];
  /** Whether a commit with no checks at all can pass; when false, such a commit stays pending. */
  allowNone?: boolean;
}

/** A failed check run or commit status: its name, its page on GitHub and, for a check run, its id. */
export interface CheckFailure {
  name: string;
  /** An https link to the run, or absent when GitHub gave none. */
  url?: string;
  /** A check run's id, which its annotations are read by; commit statuses have none. */
  checkRunId?: number;
}

/** A check run's annotation on one file: its line and text, never a log. */
export interface CheckAnnotation {
  path: string;
  line: number;
  title?: string;
  message: string;
}

/**
 * The checks on a commit: its check runs (GitHub Actions and other apps,
 * the latest run of each) and its commit statuses (the latest of each
 * context). A failure wins over a pending check, so a failed check is
 * reported as soon as it is seen. An expected check that is not registered
 * keeps the commit pending, as does a commit with no checks when
 * `expect.allowNone` is false: a commit pushed with a workflow's own token
 * starts no other workflow, so what is absent there never ran.
 */
export async function readChecks(target: GitHubRepository, sha: string, expect: CheckExpectation = {}): Promise<CheckState> {
  const pending = new Set<string>();
  const succeeded = new Set<string>();
  const failures = new Map<string, CheckFailure>();
  const fail = (name: string, url: unknown, checkRunId?: unknown) => {
    if (failures.has(name)) return;
    const failure: CheckFailure = { name };
    const link = httpsLink(url);
    if (link !== undefined) failure.url = link;
    if (Number.isSafeInteger(checkRunId) && (checkRunId as number) > 0) failure.checkRunId = checkRunId as number;
    failures.set(name, failure);
  };

  let seen = 0;
  let hasRuns = false;
  for (let page = 1; ; page += 1) {
    const answer = await request(target, 'GET', `/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
    const body = answer.json as { total_count?: unknown; check_runs?: unknown } | null;
    if (answer.status !== 200 || body === null || typeof body.total_count !== 'number' || !Array.isArray(body.check_runs)) {
      throw new PullRequestError(message('github.reading-check-runs'), answer.status);
    }
    hasRuns ||= body.total_count > 0;
    for (const run of body.check_runs as Array<{ id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown }>) {
      const name = typeof run.name === 'string' ? run.name : 'unnamed check';
      if (run.status !== 'completed') pending.add(name);
      else if (typeof run.conclusion !== 'string' || !PASSING_CONCLUSIONS.has(run.conclusion)) fail(name, run.html_url, run.id);
      else succeeded.add(name);
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
    throw new PullRequestError(message('github.reading-statuses'), answer.status);
  }
  // The combined status lists at most one page of contexts; ones it does not show are never read as passed.
  if (combined.total_count > combined.statuses.length) pending.add(`${combined.total_count - combined.statuses.length} more commit statuses`);
  for (const status of combined.statuses as Array<{ context?: unknown; state?: unknown; target_url?: unknown }>) {
    const name = typeof status.context === 'string' ? status.context : 'unnamed status';
    if (status.state === 'pending') pending.add(name);
    else if (status.state !== 'success') fail(name, status.target_url);
    else succeeded.add(name);
  }

  const failed = [...failures.keys()].sort();
  const hasChecks = hasRuns || combined.total_count > 0;
  const missing = [...new Set(expect.names ?? [])].filter((name) => !pending.has(name) && !succeeded.has(name) && !failures.has(name)).sort();
  const waiting = pending.size > 0 || missing.length > 0 || (!hasChecks && expect.allowNone === false);
  const state: CheckState = { hasChecks, state: failed.length > 0 ? 'failed' : waiting ? 'pending' : 'passed', failed, pending: [...pending].sort() };
  if (failed.length > 0) state.failures = failed.map((name) => failures.get(name) as CheckFailure);
  if (succeeded.size > 0) state.succeeded = [...succeeded].sort();
  if (missing.length > 0) state.missing = missing;
  return state;
}

/** A link GitHub gave, kept only when it is an https URL without credentials. */
function httpsLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Enough annotations for a comment; a check run with more is cut, never paged without end. */
const MAX_ANNOTATION_PAGES = 5;

/**
 * The annotations of one check run (`checks: read`): path, line, title and
 * message, as the check put them on the files. Never the run's logs.
 */
export async function readAnnotations(target: GitHubRepository, checkRunId: number): Promise<CheckAnnotation[]> {
  const annotations: CheckAnnotation[] = [];
  for (let page = 1; page <= MAX_ANNOTATION_PAGES; page += 1) {
    const answer = await request(target, 'GET', `/check-runs/${checkRunId}/annotations?per_page=${PAGE_SIZE}&page=${page}`);
    if (answer.status !== 200 || !Array.isArray(answer.json)) throw new PullRequestError(message('github.reading-annotations'), answer.status);
    const items = answer.json as Array<{ path?: unknown; start_line?: unknown; title?: unknown; message?: unknown }>;
    for (const item of items) {
      if (typeof item.path !== 'string' || typeof item.message !== 'string') continue;
      const line = Number.isSafeInteger(item.start_line) && (item.start_line as number) > 0 ? item.start_line as number : 0;
      annotations.push({ path: item.path, line, message: item.message, ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}) });
    }
    if (items.length < PAGE_SIZE) break;
  }
  return annotations;
}

/**
 * A new head gets a bounded wait for CI, polling every five seconds. No
 * checks must hold for fifteen seconds to allow CI registration. Registered
 * checks also get at least fifteen seconds before green can permit a merge.
 * The deadline also cuts off a read still unanswered; expiration always
 * leaves the PR open. All of it runs on the target's clock, real time by
 * default.
 */
export async function waitForChecks(target: GitHubRepository, sha: string, seconds: number, expect: CheckExpectation = {}): Promise<CheckState> {
  const clock = target.clock ?? REAL_CLOCK;
  const started = clock.now();
  const deadline = started + seconds * 1000;
  const signal = AbortSignal.any([clock.timeout(seconds * 1000), ...(target.signal ? [target.signal] : [])]);
  let emptySince: number | null = null;
  let last: CheckState = { state: 'pending', failed: [], pending: [], hasChecks: false };
  // Also cap observations independently of the clock and API latency.
  for (let attempt = 0; attempt < Math.ceil(seconds / 5); attempt += 1) {
    if (clock.now() >= deadline) break;
    try {
      last = await readChecks({ ...target, signal }, sha, expect);
    } catch (error) {
      if (signal.aborted && !target.signal?.aborted && error instanceof PullRequestError) break;
      throw error;
    }
    const now = clock.now();
    if (last.state === 'failed') return last;
    if (now >= deadline) break;
    if (last.hasChecks) emptySince = null;
    else emptySince ??= now;
    if (now - started >= 15_000 && last.state === 'passed' && (last.hasChecks || (emptySince !== null && now - emptySince >= 15_000))) return last;
    await clock.sleep(Math.min(5000, deadline - now));
  }
  return { ...last, state: 'pending' };
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
  const answer = await request(target, 'PUT', `/pulls/${number}/merge`, { merge_method: 'merge', sha }, { kind: 'merged', accepted: 200 });
  const body = answer.json as { merged?: unknown; sha?: unknown; message?: unknown } | null;
  if (answer.status === 200 && body !== null && body.merged === true && typeof body.sha === 'string') return { merged: true, sha: body.sha };
  if (answer.status === 405 || answer.status === 409 || answer.status === 422) {
    return { merged: false, status: answer.status, reason: refusalReason(body?.message) };
  }
  throw new PullRequestError(message('github.merging'), answer.status);
}

/**
 * GitHub's message for a refused merge (a repository rule, a required review)
 * on one line, without backticks, so it can be quoted in Markdown.
 */
function refusalReason(message: unknown): string {
  if (typeof message !== 'string') return '';
  const line = message.replace(/[`\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Cut by code points, so a character outside the BMP is never split.
  const points = [...line];
  return points.length > REASON_LENGTH ? `${points.slice(0, REASON_LENGTH - 1).join('')}…` : line;
}
