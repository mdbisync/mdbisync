// Reading a commit's checks and merging a pull request with a merge commit,
// for callers that merge their own pull requests (the sync). The caller reads
// the checks itself, so merging does not depend on branch protection, which a
// private repository on GitHub Free cannot have.

import { setTimeout as sleep } from 'node:timers/promises';
import { type CheckClock, type GitHubRepository, PullRequestError, readPullRequest, request } from './github.ts';
import { actionsJobs, type WorkflowIdentity } from './actions.ts';
import { message } from '../messages.ts';

/** Check run conclusions that let a merge go ahead. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** Enough for any real repository; a commit with more is read as pending, never as passed. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const REAL_CLOCK: CheckClock = { now: () => performance.now(), sleep: (ms) => sleep(ms), timeout: (ms) => AbortSignal.timeout(ms) };

/** Only the first commit-check response can establish that the commit itself is unknown. */
export class CommitNotFoundError extends PullRequestError {}

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

/**
 * Who published a check: the GitHub App behind a check run, or the account
 * that created a commit status. Anyone who may write commit statuses can name
 * one as they like, so a name alone does not tell who ran the check.
 */
export interface CheckPublisher {
  kind: 'run' | 'status';
  /**
   * The App's or the account's id on GitHub; 0 when GitHub named none (a
   * deleted App or account, a status not found in the list). A check expected
   * from publisher 0 is never satisfied: who ran it cannot be told.
   */
  id: number;
}

/** A check a commit must pass: its name and, when known, the publisher it must come from. */
export interface ExpectedCheck {
  name: string;
  /** Absent for a configured name: a check of that name from any publisher counts. */
  publisher?: CheckPublisher;
  /** Actions checks also identify the workflow that ran; null means unverifiable. */
  workflow?: WorkflowIdentity | null;
}

/** What a commit must show beyond the checks registered on it before it counts as passed. */
export interface CheckExpectation {
  /**
   * Checks that must be registered on the commit and pass there; an absent one keeps it pending. A check with a
   * publisher counts only when that publisher registered it: a same-name check from another one is not it.
   */
  checks?: readonly ExpectedCheck[];
  /** Whether a commit with no checks at all can pass; when false, such a commit stays pending. */
  allowNone?: boolean;
}

/** One check run (the latest of its name) or commit status (the latest of its context) on a commit. */
export interface CommitCheck {
  name: string;
  publisher: CheckPublisher;
  workflow?: WorkflowIdentity | null;
  outcome: 'pending' | 'failed' | 'passed';
  /** For a failed check: an https link to its run, when GitHub gave one. */
  url?: string;
  /** For a failed check run: its id, which its annotations are read by. */
  checkRunId?: number;
}

/** Everything GitHub lists on a commit: its checks, whether it counts any, and notes for those it did not list. */
export interface CommitChecks {
  checks: CommitCheck[];
  hasChecks: boolean;
  /** "3 more check runs" and the like: checks GitHub counts but did not list, which are never read as passed. */
  unlisted: string[];
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
  // Who created the statuses costs more requests; only a check expected from a status's account needs it.
  const creators = (expect.checks ?? []).some(({ publisher }) => publisher?.kind === 'status');
  return checkState(await readCommitChecks(target, sha, { creators }), expect);
}

/**
 * The check runs and commit statuses on a commit, each with its publisher.
 * A status's creator is read only with `creators`; without it every status's
 * publisher is unknown.
 */
export async function readCommitChecks(target: GitHubRepository, sha: string, options: { creators: boolean }): Promise<CommitChecks> {
  const checks: CommitCheck[] = [];
  const unlisted: string[] = [];
  let seen = 0;
  let hasRuns = false;
  const suites = new Map<number, Awaited<ReturnType<typeof actionsJobs>>>();
  for (let page = 1; ; page += 1) {
    const answer = await request(target, 'GET', `/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
    const body = answer.json as { total_count?: unknown; check_runs?: unknown } | null;
    if (answer.status !== 200 || body === null || typeof body.total_count !== 'number' || !Array.isArray(body.check_runs)) {
      const ErrorType = page === 1 && (answer.status === 404 || answer.status === 422) ? CommitNotFoundError : PullRequestError;
      throw new ErrorType(message('github.reading-check-runs'), answer.status);
    }
    hasRuns ||= body.total_count > 0;
    for (const run of body.check_runs as Array<{ id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; app?: { id?: unknown; slug?: unknown } | null; check_suite?: { id?: unknown } | null }>) {
      const name = typeof run.name === 'string' ? run.name : 'unnamed check';
      const outcome = run.status !== 'completed' ? 'pending' : typeof run.conclusion === 'string' && PASSING_CONCLUSIONS.has(run.conclusion) ? 'passed' : 'failed';
      const check = commitCheck(name, outcome, publisher('run', run.app?.id), run.html_url, run.id);
      if (run.app?.slug === 'github-actions') {
        const suite = run.check_suite?.id;
        let job;
        if (Number.isSafeInteger(suite) && (suite as number) > 0) {
          if (!suites.has(suite as number)) suites.set(suite as number, await actionsJobs(target, sha, suite as number));
          job = suites.get(suite as number)?.get(run.id as number);
        }
        if (job?.name !== name) job = undefined;
        check.workflow = job?.workflow ?? null;
        // A successful check payload cannot override the actual job result.
        if (check.outcome === 'passed') check.outcome = job?.outcome ?? 'pending';
      }
      checks.push(check);
    }
    seen += body.check_runs.length;
    if (seen >= body.total_count) break;
    // Check runs GitHub counts but did not list are never read as passed.
    if (body.check_runs.length === 0 || page === MAX_PAGES) {
      unlisted.push(`${body.total_count - seen} more check runs`);
      break;
    }
  }

  const answer = await request(target, 'GET', `/commits/${sha}/status?per_page=${PAGE_SIZE}`);
  const combined = answer.json as { total_count?: unknown; statuses?: unknown } | null;
  if (answer.status !== 200 || combined === null || typeof combined.total_count !== 'number' || !Array.isArray(combined.statuses)) {
    throw new PullRequestError(message('github.reading-statuses'), answer.status);
  }
  // The combined status lists at most one page of contexts; ones it does not show are never read as passed.
  if (combined.total_count > combined.statuses.length) unlisted.push(`${combined.total_count - combined.statuses.length} more commit statuses`);
  const statuses = combined.statuses as Array<{ id?: unknown; context?: unknown; state?: unknown; target_url?: unknown }>;
  const creators = statuses.length === 0 || !options.creators ? new Map<unknown, unknown>() : await statusCreators(target, sha, new Set(statuses.map(({ id }) => id)));
  for (const status of statuses) {
    const name = typeof status.context === 'string' ? status.context : 'unnamed status';
    const outcome = status.state === 'pending' ? 'pending' : status.state === 'success' ? 'passed' : 'failed';
    checks.push(commitCheck(name, outcome, publisher('status', creators.get(status.id)), status.target_url));
  }
  return { checks, hasChecks: hasRuns || combined.total_count > 0, unlisted };
}

/**
 * The account that created each of the given commit statuses, by status id.
 * The combined status names no creator, so the commit's statuses are listed,
 * newest first, until each given one is found; a status not found in
 * `MAX_PAGES` pages has an unknown publisher.
 */
async function statusCreators(target: GitHubRepository, sha: string, ids: ReadonlySet<unknown>): Promise<Map<unknown, unknown>> {
  const creators = new Map<unknown, unknown>();
  for (let page = 1; page <= MAX_PAGES && creators.size < ids.size; page += 1) {
    const answer = await request(target, 'GET', `/commits/${sha}/statuses?per_page=${PAGE_SIZE}&page=${page}`);
    if (answer.status !== 200 || !Array.isArray(answer.json)) throw new PullRequestError(message('github.reading-statuses'), answer.status);
    const listed = answer.json as Array<{ id?: unknown; creator?: { id?: unknown } | null }>;
    for (const status of listed) if (ids.has(status.id) && !creators.has(status.id)) creators.set(status.id, status.creator?.id);
    if (listed.length < PAGE_SIZE) break;
  }
  return creators;
}

function publisher(kind: CheckPublisher['kind'], id: unknown): CheckPublisher {
  return { kind, id: Number.isSafeInteger(id) && (id as number) > 0 ? id as number : 0 };
}

function commitCheck(name: string, outcome: CommitCheck['outcome'], from: CheckPublisher, url: unknown, checkRunId?: unknown): CommitCheck {
  const check: CommitCheck = { name, outcome, publisher: from };
  if (outcome === 'failed') {
    const link = httpsLink(url);
    if (link !== undefined) check.url = link;
    if (Number.isSafeInteger(checkRunId) && (checkRunId as number) > 0) check.checkRunId = checkRunId as number;
  }
  return check;
}

/** Whether a check comes from the publisher an expected check names; any does when it names none, none when it is unknown. */
function publishedBy(check: CommitCheck, expected: ExpectedCheck): boolean {
  if (expected.workflow !== undefined) {
    const actual = check.workflow;
    const wanted = expected.workflow;
    if (!actual || !wanted || actual.path !== wanted.path || actual.revision !== wanted.revision ||
        ((actual.event === 'dynamic') !== (wanted.event === 'dynamic'))) return false;
  }
  if (expected.publisher === undefined) return true;
  return expected.publisher.id > 0 && check.publisher.kind === expected.publisher.kind && check.publisher.id === expected.publisher.id;
}

/** What the checks listed on a commit say about it, given what it must show. */
export function checkState(commit: CommitChecks, expect: CheckExpectation = {}): CheckState {
  const pending = new Set<string>(commit.unlisted);
  const succeeded = new Set<string>();
  const failures = new Map<string, CheckFailure>();
  for (const check of commit.checks) {
    if (check.outcome === 'pending') pending.add(check.name);
    else if (check.outcome === 'passed') succeeded.add(check.name);
    else if (!failures.has(check.name)) {
      const failure: CheckFailure = { name: check.name };
      if (check.url !== undefined) failure.url = check.url;
      if (check.checkRunId !== undefined) failure.checkRunId = check.checkRunId;
      failures.set(check.name, failure);
    }
  }

  const failed = [...failures.keys()].sort();
  // An expected check is registered only by its own publisher: a same-name check from another one does not count.
  const missing = [...new Set((expect.checks ?? []).filter((expected) => !commit.checks.some((check) => check.name === expected.name && publishedBy(check, expected))).map(({ name }) => name))].sort();
  const waiting = pending.size > 0 || missing.length > 0 || (!commit.hasChecks && expect.allowNone === false);
  const state: CheckState = { hasChecks: commit.hasChecks, state: failed.length > 0 ? 'failed' : waiting ? 'pending' : 'passed', failed, pending: [...pending].sort() };
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
  /** `late`: GitHub first answered with a server error or that a merge was already in progress, and a merge landed while the run looked again. */
  | { merged: true; sha: string; late?: true }
  /** GitHub would not merge: the head moved (409), the pull request cannot be merged now (405), or it is not open (422). */
  | { merged: false; status: number; reason: string };

/** The longest reason kept from GitHub's answer. */
const REASON_LENGTH = 300;

/** How long a run looks again whether a merge GitHub says is already in progress lands. */
export const MERGE_IN_PROGRESS_WAIT_SECONDS = 60;
/** The pause between those looks. */
const MERGE_IN_PROGRESS_PAUSE_MS = 5000;

/**
 * Whether GitHub refused a merge because an earlier merge of the same pull
 * request still runs: HTTP 405 "Merge already in progress". GitHub answers so
 * after it answered that earlier merge with a server error. The pull request
 * may still merge, so the refusal decides nothing about its head.
 */
export function mergeInProgress(refusal: { status?: number | undefined; reason?: string | undefined }): boolean {
  return refusal.status === 405 && /^merge already in progress\b/i.test(refusal.reason ?? '');
}

/**
 * Merges a pull request with a merge commit, only while its head is still
 * `sha`, the commit whose checks the caller read. When GitHub answers with a
 * server error, or that a merge is already in progress, it looks again, for
 * up to `MERGE_IN_PROGRESS_WAIT_SECONDS`, whether the pull request merged;
 * the error or the refusal stands while it has not.
 */
export async function mergePullRequest(target: GitHubRepository, number: number, sha: string): Promise<MergeOutcome> {
  const answer = await request(target, 'PUT', `/pulls/${number}/merge`, { merge_method: 'merge', sha }, { kind: 'merged', accepted: 200 });
  const body = answer.json as { merged?: unknown; sha?: unknown; message?: unknown } | null;
  if (answer.status === 200 && body !== null && body.merged === true && typeof body.sha === 'string') return { merged: true, sha: body.sha };
  if (answer.status === 405 || answer.status === 409 || answer.status === 422) {
    const refused = { merged: false as const, status: answer.status, reason: refusalReason(body?.message) };
    if (!mergeInProgress(refused)) return refused;
    const landed = await awaitMerge(target, number, MERGE_IN_PROGRESS_WAIT_SECONDS);
    return landed === null ? refused : { merged: true, sha: landed, late: true };
  }
  // GitHub answers a merge that takes longer than about ten seconds with a server error, and may still finish it.
  if (answer.status >= 500) {
    const landed = await awaitMerge(target, number, MERGE_IN_PROGRESS_WAIT_SECONDS);
    if (landed !== null) return { merged: true, sha: landed, late: true };
  }
  throw new PullRequestError(message('github.merging'), answer.status);
}

/**
 * Reads the pull request until GitHub shows it merged, for up to `seconds` on
 * the target's clock, and returns its merge commit; null when it is still
 * open, or closed without a merge, at the end.
 */
async function awaitMerge(target: GitHubRepository, number: number, seconds: number): Promise<string | null> {
  const clock = target.clock ?? REAL_CLOCK;
  const deadline = clock.now() + seconds * 1000;
  // Also cap the reads independently of the clock and API latency.
  for (let read = 0; read <= Math.ceil((seconds * 1000) / MERGE_IN_PROGRESS_PAUSE_MS); read += 1) {
    let pr: Awaited<ReturnType<typeof readPullRequest>>;
    try {
      pr = await readPullRequest(target, number);
    } catch (error) {
      // A failed look leaves the refusal as it was: a later run looks again.
      if (error instanceof PullRequestError) return null;
      throw error;
    }
    if (pr.mergeCommit !== null) return pr.mergeCommit;
    if (pr.state === 'closed') return null;
    const now = clock.now();
    if (now >= deadline) break;
    await clock.sleep(Math.min(MERGE_IN_PROGRESS_PAUSE_MS, deadline - now));
  }
  return null;
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
