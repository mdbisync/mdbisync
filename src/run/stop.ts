// Summary lines for a run that Linear stopped, and the words a partial
// run ends with. Header names and numbers only, never content.

import { type WriteStop } from '../initial-sync/index.ts';
import { describeStop } from '../linear/index.ts';
import { cell } from './summary.ts';
import { message } from '../messages.ts';

/** The words every partial sync run ends with, in its summary and its last message. */
export const PARTIAL = message('run.partial');

/**
 * Why the run stopped, and Linear's rate-limit headers of the answer that
 * stopped it (the hourly and endpoint limits, what remains and when they
 * reset), which say when the budget comes back.
 */
export function renderStop(stop: WriteStop): string[] {
  const why = stop.kind === 'test-threshold' ? `the test threshold of ${stop.documents} documents` : describeStop(stop);
  const lines = [`Stopped: ${why}.`, ''];
  const limits = stop.kind === 'test-threshold' ? undefined : stop.limits;
  if (limits !== undefined) {
    lines.push("Linear's rate-limit headers at the stop:", '', '| Header | Value |', '| --- | --- |');
    for (const name of Object.keys(limits).sort()) lines.push(`| ${cell(name)} | ${cell(limits[name] ?? '')} |`);
    lines.push('');
  }
  return lines;
}

/**
 * The summary of a run Linear stopped before it could write. A sync run is
 * partial and the next scheduled run starts again; another operation is run
 * again by hand.
 */
export function renderStoppedBeforeWriting(stop: WriteStop, partial: boolean): string {
  const outcome = partial ? `Stopped before any write; ${PARTIAL}: the next run starts again.` : 'Stopped before any write: run it again once the limit has reset.';
  return ['## Linear stopped the run', '', outcome, '', ...renderStop(stop)].join('\n');
}
