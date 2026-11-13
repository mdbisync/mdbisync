// Which failed scheduled soak workflows the soak may let the next scheduled
// run recover from, and how many. Only a GitHub server error (HTTP 5xx) in
// the sync pull request step qualifies: the engine ends that run incomplete
// on purpose and the next run repeats the step. Every other failure stops the
// soak, as does a bound used up (`soak` in load.ts). `run.settle` runs again
// after the same failure, within its own bound (`settleServerError`).

import type { EngineResult } from './engine.ts';
import { observedTokens } from './soak-report.ts';
import { ProductError } from './results.ts';

export interface SoakServerErrorPolicy {
  /** The most consecutive scheduled runs a server error may interrupt; the next one stops the soak. */
  ticks: number;
  /** The most interrupted runs in the whole soak; the next one stops it. */
  total: number;
}

/** No interruption is tolerated: any failed scheduled workflow stops the soak. */
export const STRICT_SERVER_ERRORS: SoakServerErrorPolicy = { ticks: 0, total: 0 };

/**
 * The step's `serverErrorTicks` and `serverErrorTotal`; strict when both are absent. Refused unless both are
 * nonnegative whole numbers, both zero or both positive, so a step never turns strict by setting one of them.
 */
export function soakServerErrorPolicy(args: Readonly<Record<string, unknown>>): SoakServerErrorPolicy {
  const read = (name: string): number => {
    const value = Number(args[name] ?? 0);
    if (!Number.isInteger(value) || value < 0) throw new Error(`soak ${name} must be a nonnegative whole number, not ${String(args[name])}`);
    return value;
  };
  const policy = { ticks: read('serverErrorTicks'), total: read('serverErrorTotal') };
  if ((policy.ticks === 0) !== (policy.total === 0)) throw new Error('soak serverErrorTicks and serverErrorTotal must both be set above zero, or both be zero (strict)');
  return policy;
}

/** A failed run the next scheduled run may recover from. */
export interface RecoverableServerError {
  status: number;
  workflowRunId?: number;
  pullRequest?: number;
}

export type ServerErrorVerdict = { recoverable: RecoverableServerError } | { refused: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);

/** The engine's own line for this ending, which the action reports as the sync step's failure. */
const ENGINE_LINE = 'sync: not finished (github-failed)';

/**
 * Whether a scheduled workflow that ended with a nonzero exit failed only on a GitHub server error in the sync pull
 * request step: the run concluded `failure` (not cancelled or timed out) with the engine's own line for that ending
 * in its logs, its report says so and holds no suspended lane, nothing else in the
 * report failed, and every engine token it minted was confirmed revoked. Anything the run does not show is refused.
 */
export function recoverableServerError(result: EngineResult): ServerErrorVerdict {
  if (result.exitCode === 0) return { refused: 'the run succeeded' };
  if (result.remote === undefined) return { refused: 'not a workflow run' };
  if (result.timedOut || result.signal !== null || result.exitCode === null || result.conclusion !== 'failure') {
    return { refused: `the run did not end on its own failure (conclusion ${String(result.conclusion)})` };
  }
  if (!result.stdout.includes(ENGINE_LINE)) return { refused: 'the logs lack the sync step\'s own GitHub failure' };
  const verdict = serverErrorInReport(result.report);
  if ('refused' in verdict) return verdict;
  const tokens = observedTokens([result]);
  if (tokens.outstanding !== 0) return { refused: 'the run\'s token revocation is unconfirmed' };
  return { recoverable: { ...verdict.recoverable, workflowRunId: result.remote.runId } };
}

/**
 * Whether an engine report shows a sync run that failed only on a GitHub server error (HTTP 5xx) in the sync pull
 * request step: the report says so and holds no suspended lane, and nothing else in it failed or stopped. It
 * judges the report alone; `recoverableServerError` adds what a workflow run must show around it.
 */
export function serverErrorInReport(report: Readonly<Record<string, unknown>> | null): ServerErrorVerdict {
  if (report === null) return { refused: 'the run left no engine report' };
  if (report.operation !== 'sync' || report.code !== 'github-failed' || report.exitStatus !== 'failure') {
    return { refused: `the run ended with code ${String(report.code)}, not a GitHub failure of the sync pull request` };
  }
  const pullRequest = record(report.pullRequest);
  const status = pullRequest?.status;
  if (pullRequest?.code !== 'github-failed') return { refused: 'the GitHub failure is not in the sync pull request step' };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 500 || status > 599) {
    return { refused: status === undefined ? 'GitHub gave no answer' : `GitHub answered HTTP ${String(status)}, not a server error` };
  }
  // A held lane may carry failed or timed-out checks and its own GitHub answers: never an isolated server error.
  if (pullRequest.suspended !== undefined && pullRequest.suspended !== null) return { refused: 'the run holds a suspended pull request lane' };
  const checks = record(pullRequest.checks);
  const capture = record(report.capture);
  const sync = record(report.sync);
  if (report.stop !== null && report.stop !== undefined) return { refused: 'the run was stopped' };
  if (report.notImplemented === true || report.stoppedEarly === true) return { refused: 'the run stopped early' };
  if (report.failedWriteRecorded !== false || report.writesAfterLimit !== 0 || report.progressRecorded !== true) {
    return { refused: 'the report shows a write or progress failure' };
  }
  if (checks !== undefined && (checks.state === 'failed' || !empty(checks.failed))) return { refused: 'checks of the sync pull request failed' };
  if (capture !== undefined && (capture.ok !== true || !empty(capture.blocked))) return { refused: 'the capture did not complete' };
  if (sync !== undefined && (sync.complete !== true || !empty(sync.failed) || !empty(sync.notAttempted) || (sync.stopped !== null && sync.stopped !== undefined))) {
    return { refused: 'the write to Linear did not complete' };
  }
  const number = record(pullRequest.pullRequest)?.number;
  return { recoverable: { status, ...(typeof number === 'number' ? { pullRequest: number } : {}) } };
}

/**
 * Whether a settle run failed only on a GitHub server error in the sync pull request step. A workflow run must show
 * what the soak asks of it (`recoverableServerError`: its own failure, the engine's line, tokens confirmed revoked);
 * a local run must have ended on its own failure (not killed or timed out) with a report that shows nothing else
 * failed (`serverErrorInReport`). The run stays a failed run among the scenario's results; this only lets the settle
 * run again.
 */
export function settleServerError(result: EngineResult): ServerErrorVerdict {
  if (result.remote !== undefined) return recoverableServerError(result);
  if (result.exitCode === 0) return { refused: 'the run succeeded' };
  if (result.timedOut || result.signal !== null || result.exitCode === null) {
    return { refused: `the run did not end on its own failure (exit ${String(result.exitCode)}, signal ${String(result.signal)})` };
  }
  return serverErrorInReport(result.report);
}

/**
 * How a completed scheduled workflow with a nonzero exit fails the soak: always with the strict failure, and with
 * the line a later run may recover from when the run qualifies (`recoverableServerError`). `note` says which, for
 * the log.
 */
export function failedWorkflow(result: EngineResult): { error: ProductError; recoverable?: string; note: string } {
  const error = new ProductError(`scheduled soak workflow ${result.remote?.runId ?? 'unknown'} failed (exit ${String(result.exitCode)})`);
  const verdict = recoverableServerError(result);
  if ('refused' in verdict) return { error, note: `not recoverable: ${verdict.refused}` };
  const recoverable = describeServerError(verdict.recoverable);
  return { error, recoverable, note: `recoverable by a later scheduled run: ${recoverable}` };
}

/**
 * Whether a run that succeeded shows the sync pull request step working again: its report names no pull request
 * failure. A run the engine ends with a warning (a partial write) succeeds as a workflow even when the step still
 * failed; it recovers nothing.
 */
export function pullRequestStepClean(result: EngineResult): boolean {
  if (result.report === null) return false;
  const pullRequest = record(result.report.pullRequest);
  return pullRequest === undefined || pullRequest.code === undefined;
}

/** One line for logs and stop messages. */
export function describeServerError(error: RecoverableServerError): string {
  const run = error.workflowRunId === undefined ? '' : ` in workflow ${error.workflowRunId}`;
  const pr = error.pullRequest === undefined ? '' : ` (sync pull request #${error.pullRequest})`;
  return `GitHub HTTP ${error.status}${run}${pr}`;
}
