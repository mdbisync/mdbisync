// How a run ends, for the command line, the action and the run report.
// `runEnding` is the one decision: its status, exit code, message and code
// are what the command line, the action and the report each give.
//
// A sync run is partial when Linear stopped it (a rate limit, a budget
// running low), a write failed or was rejected, or a state ref moved under
// it. It kept what it could record, and the next scheduled run goes on from
// there, so it ends with a warning, not a failure: a sync that meets one of
// Linear's bad minutes does not fail its job. Other operations have no next
// run to go on, so a stop fails them.

import {
  COMMANDS,
  INCOMPLETE_EXIT_CODE,
  NO_STATE_EXIT_CODE,
  SETUP_FAILED_EXIT_CODE,
  notImplementedMessage,
} from '../commands.ts';
import { fixUrl } from '../setup/fixes.ts';
import { type PullRequestFailure, pullRequestFailure } from '../sync/index.ts';
import { type OperationOutcome } from './operation.ts';
import { PARTIAL } from './stop.ts';

export type ExitStatus = 'success' | 'warning' | 'failure';

/** Why a sync run is partial: a capture or write code, or a removal capture held. */
export type PartialCode =
  | NonNullable<NonNullable<OperationOutcome['captured']>['code']>
  | Exclude<NonNullable<NonNullable<NonNullable<OperationOutcome['sync']>['write']>['code']>, 'container-cap'>
  | 'removal-held';

/**
 * Why a sync run is partial, or undefined when it is not: Linear stopped it
 * (in the setup check, the capture or the write step), failed a request
 * while capturing, held a removal it could not confirm, failed or rejected
 * a write, or a state ref moved. A container at its document cap is not
 * partial: the next run cannot go on until a person makes room; nor is a
 * sync pull request that needs a person.
 */
export function partialCode(outcome: OperationOutcome): PartialCode | undefined {
  if (pullRequestEnding(outcome) !== null) return undefined;
  return linearPartialCode(outcome);
}

/**
 * The sync pull request's failure that decides how the run ends, or null.
 * A failure a person must fix (a failed check, an initial sync waiting to
 * be merged) comes before a partial ending. A transient one (a lost lease,
 * a GitHub server error) yields to a partial ending, since the next run
 * repeats both; alone, it fails the run.
 */
export function pullRequestEnding(outcome: OperationOutcome): PullRequestFailure | null {
  const failure = pullRequestFailure(outcome.sync?.pullRequest);
  if (failure === null) return null;
  if (failure.kind === 'incomplete' && linearPartialCode(outcome) !== undefined) return null;
  return failure;
}

/**
 * How a run ended: its status, the command line's exit code, the one-line
 * message the command line prints and the action reports (as a warning or
 * as the step's failure), and the action's `code` output.
 */
export interface RunEnding {
  readonly status: ExitStatus;
  readonly exitCode: number;
  /** Undefined for a run that succeeded. */
  readonly message: string | undefined;
  /** Empty when the run has no code to give. */
  readonly code: string;
}

/**
 * The one decision for how a run ends. The order matters: a sync pull
 * request's failure that decides the ending, a partial sync, a stop by
 * Linear before any write, a failed preflight, a container at its cap, an
 * unfinished initial sync, and an operation that is not built yet.
 */
export function runEnding(outcome: OperationOutcome): RunEnding {
  const command = outcome.operation;
  const otherwise = outcome.code ?? '';
  // The security hooks run in a step of their own; this step's part succeeded.
  if (outcome.ok && outcome.staged !== undefined) return { status: 'success', exitCode: 0, message: undefined, code: '' };
  const failure = pullRequestEnding(outcome);
  if (failure !== null) {
    const exitCode = failure.kind === 'setup' ? SETUP_FAILED_EXIT_CODE : failure.kind === 'no-state' ? NO_STATE_EXIT_CODE : INCOMPLETE_EXIT_CODE;
    return { status: 'failure', exitCode, message: `${command}: ${failure.message}`, code: failure.code };
  }
  const partial = partialCode(outcome);
  if (partial !== undefined) {
    return { status: 'warning', exitCode: INCOMPLETE_EXIT_CODE, message: `${command}: ${PARTIAL} (${partial})`, code: partial };
  }
  if (outcome.stopped !== undefined) {
    return { status: 'failure', exitCode: INCOMPLETE_EXIT_CODE, message: stoppedMessage(command), code: outcome.code ?? 'stopped' };
  }
  if (!outcome.ok) {
    const exitCode = outcome.code === 'initial-sync-required' || outcome.code === 'initial-pull-request-pending' ? NO_STATE_EXIT_CODE : SETUP_FAILED_EXIT_CODE;
    return { status: 'failure', exitCode, message: stoppedBeforeWritingMessage(command, outcome), code: otherwise };
  }
  if (outcome.confirmed?.code === 'container-cap' || outcome.sync?.write?.code === 'container-cap') {
    return { status: 'failure', exitCode: INCOMPLETE_EXIT_CODE, message: containerCapMessage(command), code: 'container-cap' };
  }
  const unfinished = outcome.confirmed ?? outcome.reverse;
  if (unfinished !== undefined && !unfinished.complete) {
    return { status: 'failure', exitCode: INCOMPLETE_EXIT_CODE, message: unfinishedMessage(command, unfinished.code), code: unfinished.code ?? '' };
  }
  if (outcome.notImplemented) {
    return { status: 'failure', exitCode: COMMANDS[command].notImplementedExitCode, message: notImplementedMessage(command), code: otherwise };
  }
  return { status: 'success', exitCode: 0, message: undefined, code: otherwise };
}

export function exitStatusOf(outcome: OperationOutcome): ExitStatus {
  return runEnding(outcome).status;
}

/**
 * The message of a run whose preflight stopped it before any write: its
 * code and why, on one line: the failed setup check's detail (names and
 * states only, as in the job summary) or the state refusal's message. The
 * run's log then says what failed without the job summary.
 */
export function stoppedBeforeWritingMessage(command: string, outcome: OperationOutcome): string {
  const detail = outcome.setup?.detail ?? outcome.refusal?.message;
  const fix = fixUrl(outcome.code);
  // Names from README front matter may hold line breaks; one line keeps them from reading as further log lines.
  const explained = `${command}: stopped before any write (${outcome.code})${detail === undefined ? '' : `: ${detail.replace(/\s*[\r\n]+\s*/g, ' ')}`}`;
  return fix === undefined ? explained : `${explained.replace(/\.$/, '')}. How to fix it: ${fix}`;
}

/** The message of a run that is not a sync, stopped by Linear before any write. */
function stoppedMessage(command: string): string {
  return `${command}: stopped by Linear before any write; run it again once the limit has reset`;
}

/** The message of a run whose container would go over its document cap. */
function containerCapMessage(command: string): string {
  return `${command}: stopped before any write (container-cap); reduce additions or check document-cap`;
}

/** The one-line failure of an initial sync that did not finish: why, and what to do next. */
export function unfinishedMessage(command: string, code: string | undefined): string {
  if (code === 'sync-branch-changed') {
    return `${command}: not finished (${code}); merge or close the pull request of the sync branch and delete the branch, then run it again`;
  }
  return `${command}: not finished (${code}); run it again with the same inputs`;
}

/** Why a sync run is partial on Linear's side, before the sync pull request is weighed. */
function linearPartialCode(outcome: OperationOutcome): PartialCode | undefined {
  if (outcome.operation !== 'sync') return undefined;
  if (outcome.stopped !== undefined) return 'stopped';
  // Every way a capture ends unfinished (a stop, a failed request, a moved ref) leaves its state for the next run.
  if (outcome.captured !== undefined && !outcome.captured.ok) return outcome.captured.code ?? 'stopped';
  const code = outcome.sync?.write?.code;
  if (code !== undefined) return code === 'container-cap' ? undefined : code;
  // Capture held a removal Linear's answers could not confirm; the next run decides it.
  return (outcome.captured?.heldRemovals.length ?? 0) > 0 ? 'removal-held' : undefined;
}
