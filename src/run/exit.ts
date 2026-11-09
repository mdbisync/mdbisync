// How a run ends, for the command line, the action and the run report.
//
// A sync run is partial when Linear stopped it (a rate limit, a budget
// running low), a write failed or was rejected, or a state ref moved under
// it. It kept what it could record, and the next scheduled run goes on from
// there, so it ends with a warning, not a failure: a sync that meets one of
// Linear's bad minutes does not fail its job. Other operations have no next
// run to go on, so a stop fails them.

import { fixUrl } from '../setup/fixes.ts';
import { type PullRequestFailure, pullRequestFailure } from '../sync/index.ts';
import { type OperationOutcome } from './operation.ts';

export { PARTIAL } from './stop.ts';

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

export function exitStatusOf(outcome: OperationOutcome): ExitStatus {
  if (partialCode(outcome) !== undefined) return 'warning';
  if (!outcome.ok || outcome.notImplemented) return 'failure';
  if (outcome.sync?.write?.code === 'container-cap' || pullRequestEnding(outcome) !== null) return 'failure';
  const unfinished = outcome.confirmed ?? outcome.reverse;
  if (unfinished !== undefined && !unfinished.complete) return 'failure';
  return 'success';
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
export function stoppedMessage(outcome: OperationOutcome): string | undefined {
  if (outcome.stopped === undefined || partialCode(outcome) !== undefined) return undefined;
  return `${outcome.operation}: stopped by Linear before any write; run it again once the limit has reset`;
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
