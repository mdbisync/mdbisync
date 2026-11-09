// How a run ends, for the command line, the action and the run report.
//
// A sync run that Linear stopped (a rate limit, a budget running low), that
// had a write fail or rejected, or that found a state ref moved under it is
// partial: it recorded what it finished and the next run goes on from there.
// It ends with a warning, not a failure, so a scheduled sync that meets one
// of Linear's bad minutes does not fail its job.

import { type WriteStop } from '../initial-sync/index.ts';
import { describeStop } from '../linear/index.ts';
import { type OperationOutcome } from './operation.ts';

export type ExitStatus = 'success' | 'warning' | 'failure';

/** The words every partial run ends with, in its summary and its last message. */
export const PARTIAL = 'partial, will continue';

/** Why the run is partial, or undefined when it is not. */
export function partialCode(outcome: OperationOutcome): string | undefined {
  if (outcome.stopped !== undefined) return 'stopped';
  return outcome.sync?.write.code;
}

export function exitStatusOf(outcome: OperationOutcome): ExitStatus {
  if (partialCode(outcome) !== undefined) return 'warning';
  if (!outcome.ok || outcome.notImplemented) return 'failure';
  if (outcome.confirmed !== undefined && !outcome.confirmed.complete) return 'failure';
  return 'success';
}

/**
 * Summary lines for a stop: why, and Linear's rate-limit headers of the
 * answer that stopped the run (the hourly and endpoint limits), which say
 * when the budget comes back. Header names and numbers only.
 */
export function renderStop(stop: WriteStop): string[] {
  const why = stop.kind === 'test-threshold' ? `the test threshold of ${stop.documents} documents` : describeStop(stop);
  const lines = [`Stopped: ${why}.`, ''];
  const limits = stop.kind === 'test-threshold' ? undefined : stop.limits;
  if (limits !== undefined) {
    lines.push("Linear's rate-limit headers at the stop:", '', '| Header | Value |', '| --- | --- |');
    for (const name of Object.keys(limits).sort()) lines.push(`| ${name} | ${limits[name]} |`);
    lines.push('');
  }
  return lines;
}

/** The summary of a run Linear stopped before it could write. */
export function renderStoppedBeforeWriting(stop: WriteStop): string {
  return ['## Linear stopped the run', '', `Stopped before any write; ${PARTIAL}: the next run starts again.`, '', ...renderStop(stop)].join('\n');
}
