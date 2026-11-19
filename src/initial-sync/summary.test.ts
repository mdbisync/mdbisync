import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type LinearDocument } from '../linear/index.ts';
import { type Place } from '../mapping/index.ts';
import { MARKUP_TEXTS, tableRows } from '../run/summary-test-helpers.ts';
import { noConflictNotices } from '../sync/marks.ts';
import { type ConfirmedResult, type FailedWrite } from './confirm.ts';
import { type InitialSyncPlan } from './plan.ts';
import { renderConfirmed, renderDryRun } from './summary.ts';

// A path in a table cell may hold Markdown or HTML: a file's title is free
// text too, and a newer Linear duplicate of it is listed at that file's path.
// Each must render as its own text.

const ENG: Place = { kind: 'team', team: 'ENG' };

function document(title: string, index: number): LinearDocument {
  return {
    id: `doc-${index}`,
    title,
    slugId: `s${index}`,
    icon: null,
    color: null,
    documentContentId: null,
    projectId: null,
    teamId: 'team-eng',
    trashed: false,
    archivedAt: null,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * A plan with one document per title in the team folder `eng`, each going to trash at its title's path: the newer
 * duplicate of a file is listed at the path of the file's title (a document from Linear alone is named by its id).
 */
function planOfTitles(): InitialSyncPlan {
  const trash = MARKUP_TEXTS.map((title, index) => ({ path: `eng/${title}.md`, title, place: ENG, documentId: `doc-${index}` }));
  return { create: [], overwrite: [], leftOut: [], trash: trash.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

function confirmedResult(trashed: string[], failed: FailedWrite[]): ConfirmedResult {
  return {
    complete: true,
    resumed: false,
    created: [],
    overwritten: [],
    unchanged: [],
    skippedCompleted: [],
    trashed,
    leftOutAtWrite: [],
    failed,
    notAttempted: [],
    progressPushes: 0,
    progressRecorded: true,
    conflictNotices: noConflictNotices(),
    record: null,
  };
}

describe('initial-sync summaries show paths that hold markup as their own text', () => {
  const plan = planOfTitles();
  const paths = MARKUP_TEXTS.map((title) => `eng/${title}.md`).sort();

  it('dry run: one row per trashed document, with its path and id as written', () => {
    const rows = tableRows(renderDryRun(plan)).filter((row) => row.length === 3 && row[1] === 'team "ENG"');
    assert.deepEqual(rows.map((row) => row[0]).sort(), paths);
    assert.deepEqual(rows.map((row) => row[2]).sort(), plan.trash.map((entry) => entry.documentId).sort());
  });

  it('confirmed run: every trashed path and every failure as written', () => {
    const failed = MARKUP_TEXTS.map((title, index) => ({ path: `eng/${title}.md`, operation: 'trash', error: `LinearGraphQLError ${title} ${index}` }));
    const rows = tableRows(renderConfirmed(plan, confirmedResult(plan.trash.map((entry) => entry.path), failed)));
    for (const path of paths) assert.ok(rows.some((row) => row.length === 1 && row[0] === path), path);
    for (const entry of failed) assert.ok(rows.some((row) => row.join('\u0000') === [entry.path, entry.operation, entry.error].join('\u0000')), entry.path);
  });
});
