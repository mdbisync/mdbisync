// The initial sync's job summary and its machine-readable form: paths,
// places and rule names only, never document content.

import { type Place } from '../mapping/index.ts';
import { type InitialSyncPlan, type LeftOutEntry } from './plan.ts';

export const DIRECTIONS = ['git-to-linear', 'linear-to-git'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The plan in the run report; every path list is sorted. */
export interface PlanReport {
  direction: Direction;
  confirm: boolean;
  plan: {
    create: string[];
    overwrite: string[];
    trash: string[];
    /** Every path the run would write or trash: create, overwrite and trash together. */
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
    direction,
    confirm,
    plan: {
      create: paths(plan.create),
      overwrite: paths(plan.overwrite),
      trash: paths(plan.trash),
      paths: [...paths(plan.create), ...paths(plan.overwrite), ...paths(plan.trash)].sort(compare),
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
  section('Overwrite', plan.overwrite.length, ['Path', 'In Linear'], plan.overwrite.map((entry) => [entry.path, placeLabel(entry.place)]));
  section('Move to trash', plan.trash.length, ['Path', 'In Linear'], plan.trash.map((entry) => [entry.path, placeLabel(entry.place)]));
  section(
    'Left out',
    plan.leftOut.length,
    ['Path', 'Rules', 'Lines', 'Collides with'],
    plan.leftOut.map((entry) => [entry.path, entry.rules.join(', '), entry.lines.join(', '), (entry.collidesWith ?? []).join(', ')]),
  );
  return lines.join('\n');
}

export function placeLabel(place: Place): string {
  return place.kind === 'project' ? `project "${place.project}" of team "${place.team}"` : `team "${place.team}"`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A table cell: pipes, backslashes and line breaks would break the row. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
