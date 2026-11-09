import { cell, placeLabel } from '../run/summary.ts';
// The initial sync's job summary and its machine-readable form: paths,
// places and rule names only, never document content.

import { type ContainerCapacity, renderCapacity } from '../run/capacity.ts';
import { describeStop } from '../linear/index.ts';
import { type ConfirmedResult } from './confirm.ts';
import { type InitialSyncPlan, type LeftOutEntry } from './plan.ts';

export const DIRECTIONS = ['git-to-linear', 'linear-to-git'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The plan in the run report; every path list is sorted. */
export interface PlanReport {
  capacity: ContainerCapacity[];
  direction: Direction;
  confirm: boolean;
  plan: {
    create: string[];
    overwrite: string[];
    trash: string[];
    /** Every path the run would write or trash, each once (a duplicate document's trash entry shares its file's path). */
    paths: string[];
  };
  /** Paths of the left-out files. */
  leftOut: string[];
  leftOutFiles: LeftOutEntry[];
  /** Paths of the files left out because their titles collide. */
  collisionPaths: string[];
}

export function toPlanReport(plan: InitialSyncPlan, direction: Direction, confirm: boolean): PlanReport {
  const paths = (entries: Array<{ path: string }>) => entries.map((entry) => entry.path);
  return {
    capacity: plan.capacity ?? [],
    direction,
    confirm,
    plan: {
      create: paths(plan.create),
      overwrite: paths(plan.overwrite),
      trash: paths(plan.trash),
      paths: [...new Set([...paths(plan.create), ...paths(plan.overwrite), ...paths(plan.trash)])].sort(compare),
    },
    leftOut: paths(plan.leftOut),
    leftOutFiles: plan.leftOut,
    collisionPaths: plan.leftOut.filter((entry) => entry.rules.includes('duplicate-title')).map((entry) => entry.path),
  };
}

/** Markdown for the job summary of a dry run. */
export function renderDryRun(plan: InitialSyncPlan): string {
  const lines = [
    '## Initial sync from git to Linear: dry run',
    '',
    'Nothing was written. Run again with `confirm` set to `true` to make Linear equal to the tracked branch:',
    '',
    `- create ${count(plan.create.length, 'document')};`,
    `- overwrite ${count(plan.overwrite.length, 'document')} with the file's text (same document, comments kept);`,
    `- move ${count(plan.trash.length, 'document')} without a file to Linear's trash, from which they can be restored;`,
    `- leave out ${count(plan.leftOut.length, 'file')}, which stay in git only until they are fixed.`,
    '',
  ];
  const section = (title: string, total: number, head: string[], rows: string[][]) => {
    lines.push(`### ${title} (${total})`, '');
    if (rows.length === 0) {
      lines.push('None.', '');
      return;
    }
    lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
    lines.push('');
  };
  section('Create', plan.create.length, ['Path', 'In Linear'], plan.create.map((entry) => [entry.path, placeLabel(entry.place)]));
  section('Overwrite', plan.overwrite.length, ['Path', 'In Linear', 'Document'], plan.overwrite.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]));
  section('Move to trash', plan.trash.length, ['Path', 'In Linear', 'Document'], plan.trash.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]));
  section(
    'Left out',
    plan.leftOut.length,
    ['Path', 'Rules', 'Lines', 'Collides with, or the files'],
    plan.leftOut.map((entry) => [entry.path, entry.rules.join(', '), entry.lines.join(', '), (entry.collidesWith ?? entry.files ?? []).join(', ')]),
  );
  return lines.join('\n') + renderCapacity(plan.capacity ?? []);
}

/** Markdown for the job summary of a confirmed run: counts, paths and rule names, never content. */
export function renderConfirmed(plan: InitialSyncPlan, result: ConfirmedResult): string {
  const outcome = result.complete
    ? 'Linear now equals the tracked branch, and the sync state is recorded.'
    : result.code === 'container-cap'
      ? 'Nothing was written. Reduce planned additions or increase document-cap after checking the container limit.'
    : result.code === 'state-moved'
      ? 'A state ref moved while this run was writing, so it recorded nothing more. Another run may be working on this repository; run initial sync again when it is done.'
      : 'The run stopped before it finished, so the sync state is not recorded yet. Run initial sync again with the same inputs to go on; documents already written are skipped.';
  const lines = [
    '## Initial sync from git to Linear',
    '',
    outcome,
    '',
    `- created ${count(result.created.length, 'document')};`,
    `- overwrote ${count(result.overwritten.length, 'document')} with the file's text (same document, comments kept);`,
    `- left ${count(result.unchanged.length, 'document')} as they were: they already held the file's text;`,
    ...(result.resumed ? [`- skipped ${count(result.skippedCompleted.length, 'document')} written by the run this one continued;`] : []),
    `- moved ${count(result.trashed.length, 'document')} without a file to Linear's trash, from which they can be restored;`,
    `- left out ${count(plan.leftOut.length + result.leftOutAtWrite.length, 'file')}, which stay in git only until they are fixed.`,
    '',
  ];
  if (result.stopped !== undefined) {
    const why = result.stopped.kind === 'test-threshold' ? `the test threshold of ${result.stopped.documents} documents` : describeStop(result.stopped);
    lines.push(`Stopped: ${why}. Not written yet: ${count(result.notAttempted.length, 'item')}.`, '');
  }
  const table = (title: string, head: string[], rows: string[][]) => {
    if (rows.length === 0) return;
    lines.push(`### ${title} (${rows.length})`, '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
    lines.push('');
  };
  table('Failed', ['Path', 'Operation', 'Error'], result.failed.map((entry) => [entry.path, entry.operation, entry.error]));
  table('Moved to trash', ['Path'], result.trashed.map((path) => [path]));
  table(
    'Left out',
    ['Path', 'Rules', 'Lines', 'Collides with, or the files'],
    [
      ...plan.leftOut.map((entry) => [entry.path, entry.rules.join(', '), entry.lines.join(', '), (entry.collidesWith ?? []).join(', ')]),
      ...result.leftOutAtWrite.map((entry) => [entry.path, entry.rule, '', (entry.files ?? []).join(', ')]),
    ],
  );
  if (result.record !== null && result.record.reformatted.length > 0) {
    lines.push(
      `Linear stores ${count(result.record.reformatted.length, 'file')} in a different form than the tracked branch; the next sync proposes that form in its pull request.`,
      '',
    );
  }
  return lines.join('\n') + renderCapacity(plan.capacity ?? []);
}

export { placeLabel };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}



function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
