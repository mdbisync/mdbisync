// How a run ends, for the command line, the action and the run report.
// `runEnding` is the one decision: its status, exit code, message and code
// are what the command line, the action and the report each give.
//
// A sync run is partial when Linear stopped it (a rate limit, a budget
// running low), a write failed or was rejected, a state ref moved under
// it, or the sync pull request step stopped on a moved ref or a failed
// GitHub request. It kept what it could record, and the next run goes on
// from there, so it ends with a warning, not a failure: a sync that meets
// one of Linear's or GitHub's bad minutes does not fail its job. A run fails
// only when a person must act. Other operations have no next run to go on,
// so a stop fails them.

import {
  COMMANDS,
  INCOMPLETE_EXIT_CODE,
  NO_STATE_EXIT_CODE,
  SETUP_FAILED_EXIT_CODE,
  notImplementedMessage,
} from '../commands.ts';
import { fixUrl } from '../setup/fixes.ts';
import { type PullRequestFailure, pullRequestFailure, pullRequestPartialCode } from '../sync/index.ts';
import { type OperationOutcome } from './operation.ts';
import { PARTIAL } from './stop.ts';
import { type HeldCode } from '../codes.ts';
import { message } from '../messages.ts';

export type ExitStatus = 'success' | 'warning' | 'failure';

/** Why a sync run is partial: a capture, write or sync pull request code, or a removal capture held. */
export type PartialCode =
  | NonNullable<NonNullable<OperationOutcome['captured']>['code']>
  | Exclude<NonNullable<NonNullable<NonNullable<OperationOutcome['sync']>['write']>['code']>, 'container-cap'>
  | NonNullable<ReturnType<typeof pullRequestPartialCode>>
  | HeldCode;

/**
 * Why a sync run is partial, or undefined when it is not: Linear stopped it
 * (in the setup check, the capture or the write step), failed a request
 * while capturing, held a removal it could not confirm, failed or rejected
 * a write, or a state ref moved; or, Linear's side done, the sync pull
 * request step stopped on a moved ref or a failed GitHub request. A
 * container at its document cap is not partial: the next run cannot go on
 * until a person makes room; nor is a sync pull request that needs a person.
 */
export function partialCode(outcome: OperationOutcome): PartialCode | undefined {
  if (pullRequestEnding(outcome) !== null) return undefined;
  const linear = linearPartialCode(outcome);
  if (linear !== undefined || outcome.operation !== 'sync' || outcome.sync?.write?.code === 'container-cap') return linear;
  return pullRequestPartialCode(outcome.sync?.pullRequest);
}

/**
 * The sync pull request's failure that decides how the run ends, or null.
 * A failure a person must fix (a failed check, an initial sync waiting to
 * be merged) comes before a partial ending. A suspended batch whose assets
 * could not be collected yields to a partial ending on Linear's side;
 * alone, it fails the run. A moved ref or a failed GitHub request is no
 * failure: it makes the run partial (`partialCode`).
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
 * as the step's failure), and the `code` the action outputs and the run
 * report records (empty when the run has no code to give). A run that
 * succeeded says nothing more; any other ending says why.
 */
export type RunEnding =
  | { readonly status: 'success'; readonly exitCode: 0; readonly message: undefined; readonly code: string }
  | { readonly status: 'warning' | 'failure'; readonly exitCode: number; readonly message: string; readonly code: string };

/**
 * The one decision for how a run ends. The order matters: the stage step
 * of the security hooks (its part done, it succeeds), a sync pull
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
    const key = outcome.stopped.operation === 'CreateProject' ? 'run.project-create-stopped' : 'run.stopped-by-linear';
    return { status: 'failure', exitCode: INCOMPLETE_EXIT_CODE, message: message(key, { command }), code: outcome.code ?? 'stopped' };
  }
  if (outcome.projectCreateFailed) {
    return { status: 'failure', exitCode: INCOMPLETE_EXIT_CODE, message: unfinishedMessage(command, 'write-failed'), code: 'write-failed' };
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
  const explained = message('run.stopped-before-write', { command, code: String(outcome.code), detail: detail === undefined ? '' : message('run.stopped-detail', { detail: oneLine(detail) }) });
  return fix === undefined ? explained : message('run.how-to-fix', { message: explained.replace(/\.$/, ''), url: fix });
}

/**
 * The text on one line: each run of line breaks, with the white space around
 * it, becomes one space. Split, not a regular expression for the space before
 * a break: that one rescans a long run of spaces from each of its positions.
 */
function oneLine(text: string): string {
  const lines = text.split(/[\r\n]+/);
  if (lines.length === 1) return text;
  const last = lines.length - 1;
  return lines
    .map((line, index) => (index === 0 ? line.trimEnd() : index === last ? line.trimStart() : line.trim()))
    // A line of white space only joins the space around it.
    .filter((line, index) => line !== '' || index === 0 || index === last)
    .join(' ');
}

/** The message of a run whose container would go over its document cap. */
function containerCapMessage(command: string): string {
  return message('run.container-cap', { command });
}

/** The one-line failure of an initial sync that did not finish: why, and what to do next. */
export function unfinishedMessage(command: string, code: string | undefined): string {
  if (code === 'sync-branch-changed') {
    return message('run.not-finished-sync-branch', { command, code });
  }
  return message('run.not-finished', { command, code: String(code) });
}

/** Why a sync run is partial on Linear's side, before the sync pull request is weighed. */
function linearPartialCode(outcome: OperationOutcome): PartialCode | undefined {
  if (outcome.operation !== 'sync') return undefined;
  if (outcome.stopped !== undefined) return 'stopped';
  if (outcome.projectCreateFailed) return 'write-failed';
  // Every way a capture ends unfinished (a stop, a failed request, a moved ref) leaves its state for the next run.
  if (outcome.captured !== undefined && !outcome.captured.ok) return outcome.captured.code ?? 'stopped';
  const code = outcome.sync?.write?.code;
  if (code !== undefined) return code === 'container-cap' ? undefined : code;
  // The suspended marks stopped part way: the next run goes on with them.
  const marks = outcome.sync?.pullRequest?.holdMarks?.code;
  if (marks !== undefined) return marks;
  // Capture held a removal Linear's answers could not confirm; the next run decides it.
  return (outcome.captured?.heldRemovals.length ?? 0) > 0 ? 'removal-held' : undefined;
}
