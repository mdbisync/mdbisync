import { cell } from '../run/summary.ts';
// The sync run's job summary: paths, rule names and reasons only, never
// document content.

import { renderCapacity } from '../run/capacity.ts';
import { PARTIAL, renderStop } from '../run/stop.ts';
import { type CycleResult } from './cycle.ts';
import { renderPullRequest } from './pull-request.ts';
import { type SkipReason } from './write.ts';

/** Why a document was skipped, as the "Skipped" table says it. */
export const SKIP_REASON_TEXTS: Record<SkipReason, string> = {
  'edited-in-linear': 'changed in Linear since it was read; the next run takes that change in and writes again',
  'missing-in-linear': 'not found in Linear, or in its trash; the next run takes that in',
  conflict: 'changed on both sides in a way git cannot merge; it is written when the conflict is resolved',
  'renamed-to-unwritable': 'its file was renamed to one that is in conflict or left out; the document stays as it is until that is fixed',
};

export function renderSync(result: CycleResult): string {
  const write = result.write;
  const lines = ['## Sync', '', result.capture.summary, ''];
  if (result.pullRequest !== undefined) lines.push(...renderPullRequest(result.pullRequest));
  if (write === undefined) {
    if (result.pullRequest === undefined) lines.push('Capture did not finish; no tracked-branch changes were written.', '');
    return lines.join('\n');
  }
  lines.push('### Tracked branch to Linear', '');
  if (write.complete && write.record === null && !write.changed) {
    lines.push('Linear already holds the tracked branch: nothing to write.', '');
  } else {
    const outcome =
      write.code === 'container-cap'
        ? 'Nothing was written. Reduce planned additions or increase document-cap after checking the container limit.'
        : write.code === 'state-moved'
        ? 'A state ref moved while this run was writing, so it recorded nothing. Another run may be working on this repository; the next run writes again what is still missing.'
        : write.complete
          ? 'Linear now holds the tracked branch.'
          : 'Some documents were not written; the next run writes them.';
    lines.push(
      outcome,
      '',
      `- wrote ${count(write.updated.length, 'document')} with the file's new text;`,
      `- renamed or moved ${count(write.relocated.length, 'document')};`,
      `- created ${count(write.created.length, 'document')};`,
      `- restored ${count(write.restored.length, 'document')} that Linear had removed while git changed them;`,
      `- ${count(write.conflicts.length, 'document')} with conflict markers, where both sides changed the same lines; either side resolves them by editing the text;`,
      `- moved ${count(write.trashed.length, 'document')} of removed files to Linear's trash, from which they can be restored;`,
      `- skipped ${count(write.skipped.length, 'document')};`,
      `- left out ${count(write.leftOut.length + write.leftOutAtWrite.length, 'file')}, which stay in git only until they are fixed.`,
      '',
    );
  }
  if (write.code === 'state-moved') lines.push(`This run is ${PARTIAL}: the next run writes again what is still missing.`, '');
  else if (write.code !== undefined && write.code !== 'container-cap') lines.push(`This run is ${PARTIAL}: it recorded what it finished, and the next run goes on from there.`, '');
  if (write.stopped !== undefined) {
    lines.push(...renderStop(write.stopped), `Not written yet: ${count(write.notAttempted.length, 'item')}.`, '');
  }
  const table = (title: string, head: string[], rows: string[][]) => {
    if (rows.length === 0) return;
    lines.push(`#### ${title} (${rows.length})`, '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
    lines.push('');
  };
  table('Failed', ['Path', 'Operation', 'Error'], write.failed.map((entry) => [entry.path, entry.operation, entry.error]));
  table('Skipped', ['Path', 'Why'], write.skipped.map((entry) => [entry.path, SKIP_REASON_TEXTS[entry.reason]]));
  table('Conflict markers', ['Path'], write.conflicts.map((path) => [path]));
  table('Decided by the conflict rules', ['Rule', 'What happened'], write.decided.map((entry) => [entry.summary.code, entry.summary.text]));
  table('Renamed or moved', ['From', 'To'], write.relocated.map((entry) => [entry.from, entry.to]));
  table('Moved to trash', ['Path'], write.trashed.map((path) => [path]));
  table('Left out', ['Path', 'Rules'], [...write.leftOut.map((entry) => [entry.path, entry.rules.join(', ')]), ...write.leftOutAtWrite.map((entry) => [entry.path, entry.rule])]);
  return lines.join('\n') + renderCapacity(write.capacity ?? []);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
