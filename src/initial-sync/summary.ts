// The initial sync's job summary and its machine-readable form: paths,
// places and rule names only, never document content.

import { describeStop } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { type ConfirmedResult } from './confirm.ts';
import { type InitialSyncPlan, type LeftOutEntry } from './plan.ts';
import { type ReversePlan, type ReverseResult } from './reverse.ts';

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
    /** Files an initial sync from Linear would remove from the tracked branch. */
    remove: string[];
    /** Every path the run would write, trash or remove, each once (a duplicate document's trash entry shares its file's path). */
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
      remove: [],
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
  pushTable(lines, 'Create', ['Path', 'In Linear'], plan.create.map((entry) => [entry.path, placeLabel(entry.place)]), true);
  pushTable(lines, 'Overwrite', ['Path', 'In Linear', 'Document'], plan.overwrite.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines, 'Move to trash', ['Path', 'In Linear', 'Document'], plan.trash.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines, 'Left out', LEFT_OUT_HEAD, leftOutRows(plan.leftOut), true);
  return lines.join('\n');
}

/** Markdown for the job summary of a confirmed run: counts, paths and rule names, never content. */
export function renderConfirmed(plan: InitialSyncPlan, result: ConfirmedResult): string {
  const outcome = result.complete
    ? 'Linear now equals the tracked branch, and the sync state is recorded.'
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
  pushTable(lines, 'Failed', ['Path', 'Operation', 'Error'], result.failed.map((entry) => [entry.path, entry.operation, entry.error]), false);
  pushTable(lines, 'Moved to trash', ['Path'], result.trashed.map((path) => [path]), false);
  pushTable(
    lines,
    'Left out',
    ['Path', 'Rules', 'Lines', 'Collides with, or the files'],
    [...leftOutRows(plan.leftOut), ...result.leftOutAtWrite.map((entry) => [entry.path, entry.rule, '', (entry.files ?? []).join(', ')])],
    false,
  );
  if (result.record !== null && result.record.reformatted.length > 0) {
    lines.push(
      `Linear stores ${count(result.record.reformatted.length, 'file')} in a different form than the tracked branch; the next sync proposes that form in its pull request.`,
      '',
    );
  }
  return lines.join('\n');
}

/** The plan of an initial sync from Linear in the run report. */
export function toReversePlanReport(plan: ReversePlan, confirm: boolean): PlanReport {
  const paths = (entries: Array<{ path: string }>) => entries.map((entry) => entry.path);
  return {
    direction: 'linear-to-git',
    confirm,
    plan: {
      create: paths(plan.create),
      overwrite: paths(plan.overwrite),
      trash: [],
      remove: [...plan.remove],
      paths: [...new Set([...paths(plan.create), ...paths(plan.overwrite), ...plan.remove])].sort(compare),
    },
    leftOut: paths(plan.leftOut),
    leftOutFiles: plan.leftOut,
    collisionPaths: plan.leftOut.filter((entry) => entry.rules.includes('duplicate-title')).map((entry) => entry.path),
  };
}

/** Markdown for the job summary of a dry run from Linear. */
export function renderReverseDryRun(plan: ReversePlan): string {
  const lines = [
    '## Initial sync from Linear to the tracked branch: dry run',
    '',
    'Nothing was written. Run again with `confirm` set to `true` to open one pull request that makes the synchronized folders equal to Linear. A person merges it; the sync never does, because it removes files:',
    '',
    `- overwrite ${count(plan.overwrite.length, 'file')} with the document's text (front matter kept);`,
    `- create ${count(plan.create.length, 'file')}, one per document without a file;`,
    `- remove ${count(plan.remove.length, 'file')} without a document (they stay in the history);`,
    `- keep ${count(plan.kept.length, 'file')} without a document that hold a folder's annotation;`,
    `- leave out ${count(plan.leftOut.length, 'file or document', 'files or documents')}.`,
    '',
  ];
  pushTable(lines, 'Overwrite', ['Path', 'Document'], plan.overwrite.map((entry) => [entry.path, entry.documentId]), true);
  pushTable(lines, 'Create', ['Path', 'From Linear', 'Document'], plan.create.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines, 'Remove', ['Path'], plan.remove.map((path) => [path]), true);
  pushTable(lines, 'Kept', ['Path', 'Why'], plan.kept.map((entry) => [entry.path, 'holds the annotation of its folder']), false);
  pushTable(lines, 'Left out', LEFT_OUT_HEAD, leftOutRows(plan.leftOut), true);
  return lines.join('\n');
}

/** Markdown for the job summary of a confirmed run from Linear: counts, paths and rule names, never content. */
export function renderReverseConfirmed(plan: ReversePlan, result: ReverseResult): string {
  const outcome = result.complete
    ? result.pullRequest === null
      ? 'The tracked branch already equals Linear: no pull request is needed. The sync state is recorded.'
      : `The sync state is recorded and pull request #${result.pullRequest.number} ${result.pullRequest.opened ? 'is open' : 'was already open'}. A person reviews and merges it; the sync does not run until it is merged.`
    : result.code === 'state-moved'
      ? 'A state ref moved while this run was working, so it recorded nothing more. Another run may be working on this repository; run initial sync again when it is done.'
      : result.code === 'pull-request-failed'
        ? `The sync state is recorded, but the pull request could not be opened (${result.pullRequestStatus === undefined ? 'GitHub could not be reached' : `GitHub answered HTTP ${result.pullRequestStatus}`}). Run initial sync again with the same inputs to open it.`
        : result.code === 'sync-branch-changed'
          ? 'The sync branch holds commits this sync did not make, so nothing was recorded. Merge or close its pull request and delete the branch, then run initial sync again.'
        : 'The run stopped before it finished, so the sync state is not recorded yet. Run initial sync again with the same inputs to go on; documents already taken are skipped.';
  const lines = [
    '## Initial sync from Linear to the tracked branch',
    '',
    outcome,
    '',
    `- took ${count(result.overwritten.length, 'document')} into existing files and ${count(result.created.length, 'document')} into new files;`,
    ...(result.resumed ? [`- skipped ${count(result.skippedCompleted.length, 'document')} taken by the run this one continued;`] : []),
    `- ${result.record === null ? 'will remove' : 'removes'} ${count(plan.remove.length, 'file')} without a document;`,
    `- left out ${count(plan.leftOut.length + result.leftOutAtRecord.length, 'file or document', 'files or documents')}.`,
    '',
  ];
  if (result.stopped !== undefined) {
    const why = result.stopped.kind === 'test-threshold' ? `the test threshold of ${result.stopped.documents} documents` : describeStop(result.stopped);
    lines.push(`Stopped: ${why}. Not taken yet: ${count(result.notAttempted.length, 'document')}.`, '');
  }
  pushTable(lines, 'Remove', ['Path'], plan.remove.map((path) => [path]), false);
  pushTable(lines, 'Left out', LEFT_OUT_HEAD, [...leftOutRows(plan.leftOut), ...result.leftOutAtRecord.map((entry) => [entry.path, entry.rule, '', ''])], false);
  return lines.join('\n');
}

const LEFT_OUT_HEAD = ['Path', 'Rules', 'Lines', 'Collides with'];

function leftOutRows(entries: readonly LeftOutEntry[]): string[][] {
  return entries.map((entry) => [entry.path, entry.rules.join(', '), entry.lines.join(', '), (entry.collidesWith ?? []).join(', ')]);
}

/** Adds a table section; an empty one says "None." when `always`, and is skipped otherwise. */
function pushTable(lines: string[], title: string, head: string[], rows: string[][], always: boolean): void {
  if (rows.length === 0 && !always) return;
  lines.push(`### ${title} (${rows.length})`, '');
  if (rows.length === 0) {
    lines.push('None.', '');
    return;
  }
  lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  lines.push('');
}

export function placeLabel(place: Place): string {
  return place.kind === 'project' ? `project "${place.project}" of team "${place.team}"` : `team "${place.team}"`;
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** A table cell: pipes, backslashes and line breaks would break the row. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
