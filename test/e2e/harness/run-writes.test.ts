import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ConfirmedReport, ReverseReport, RunReport, SyncReport } from '../../../src/run/finish.ts';
import type { RunWrites as ReportedWrites } from '../../../src/run/operation.ts';
import type { PullRequestResult } from '../../../src/sync/index.ts';
import { ProductError } from './results.ts';
import { runWrites, type RunWrites } from './subjects.ts';

// Engine run reports, fixed: the three runs of L1R-03 as the engine reported
// them live (the reverse initial sync, the first sync after a person merged
// its pull request, which created two documents, and the quiet run after it),
// a sync that moved one state ref only, a sync that opened its pull request,
// and a confirmed initial sync from git to Linear. The live reports predate
// the report's `writes`; theirs are what the engine reports for the same
// runs offline.
const RUN_REPORTS = join(import.meta.dirname, 'run-reports');

function runReport(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RUN_REPORTS, `${name}.json`), 'utf8')) as Record<string, unknown>;
}

// Every field of the report types: the compiler fails here when a field is
// added or removed, and the fixtures must then follow the new contract.
const REPORT_KEYS = {
  capacity: true, operation: true, ok: true, code: true, exitStatus: true, stop: true, complete: true, changed: true,
  setupChecks: true, securityHooks: true, notImplemented: true, summary: true, initialSync: true, sync: true,
  pullRequest: true, capture: true, writtenCount: true, skippedCompletedCount: true, oversizeFiles: true,
  leftOutRules: true, paths: true, resumed: true, writtenDocuments: true, writesAfterLimit: true,
  failedWriteRecorded: true, endpointLimitHeadersPresent: true, rejectedDocumentNamed: true, stoppedEarly: true,
  progressRecorded: true, record: true, atomicPushRefused: true, partialRefUpdates: true,
  skippedConcurrentDocument: true, capturedTrackedTip: true, rereadWindowMs: true, linearToGit: true, writes: true,
  conflictNotices: true,
} satisfies Record<keyof RunReport, true>;
const WRITES_KEYS = { linear: true, git: true, pullRequests: true } satisfies Record<keyof ReportedWrites, true>;
const SYNC_KEYS = {
  complete: true, updated: true, relocated: true, created: true, adopted: true, restored: true, trashed: true,
  conflicts: true, decided: true, skipped: true, leftOut: true, leftOutAtWrite: true, failed: true, notAttempted: true,
  stopped: true, record: true,
} satisfies Record<keyof SyncReport, true>;
const REVERSE_KEYS = {
  complete: true, overwritten: true, created: true, skippedCompleted: true, removed: true, leftOutAtRecord: true,
  notAttempted: true, stopped: true, progressPushes: true, record: true, pullRequest: true, closedPullRequest: true,
} satisfies Record<keyof ReverseReport, true>;
const PULL_REQUEST_KEYS = {
  suspended: true, holdMarks: true, redMain: true, mainPending: true, waitsForSuspended: true,
  needed: true, pullRequest: true, branchMoved: true, checks: true, merged: true, paths: true, marked: true, decided: true, code: true, status: true, reason: true,
} satisfies Record<keyof PullRequestResult, true>;
const CONFIRMED_KEYS = {
  complete: true, created: true, overwritten: true, unchanged: true, skippedCompleted: true, trashed: true,
  leftOutAtWrite: true, failed: true, notAttempted: true, stopped: true, progressPushes: true, reformatted: true,
} satisfies Record<keyof ConfirmedReport, true>;
const CAPTURE_KEYS = {
  ok: true, changed: true, removed: true, heldRemovals: true, blocked: true, leftOut: true, writeBackWarnings: true, stopped: true, rebuiltIds: true,
} satisfies Record<keyof NonNullable<RunReport['capture']>, true>;
/** The capture's fields it leaves out unless they apply. */
const CAPTURE_OPTIONAL = ['stopped', 'rebuiltIds'];
/** The pull request step's fields it may leave out: only its ending's. */
const PULL_REQUEST_OPTIONAL = ['code', 'status', 'reason', 'suspended', 'holdMarks', 'redMain', 'mainPending', 'waitsForSuspended'];

const EXPECTED: Record<string, RunWrites> = {
  // The record on the linear, ids and uploads refs and the sync branch; the pull request it opened.
  'reverse-initial-sync': { linear: 0, git: 4, pullRequests: 1, total: 5 },
  // Two documents created; the merge record on the linear ref and their ids.
  'first-sync-two-created': { linear: 2, git: 2, pullRequests: 0, total: 4 },
  'quiet-sync': { linear: 0, git: 0, pullRequests: 0, total: 0 },
  'state-ref-only-sync': { linear: 0, git: 1, pullRequests: 0, total: 1 },
  // The capture on the linear and ids refs, the sync branch, the pull request.
  'sync-pull-request-opened': { linear: 0, git: 3, pullRequests: 1, total: 4 },
  // Three created and one overwritten; a progress push and the record on ids, the linear and uploads refs.
  'initial-sync-to-linear': { linear: 4, git: 4, pullRequests: 0, total: 8 },
};

describe('run report fixtures', () => {
  const names = readdirSync(RUN_REPORTS).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

  it('cover every expected count and nothing else', () => {
    assert.deepEqual(names, Object.keys(EXPECTED).sort());
  });

  for (const name of names) {
    it(`${name} has the report's fields exactly`, () => {
      const report = runReport(name);
      assert.deepEqual(Object.keys(report).sort(), Object.keys(REPORT_KEYS).sort());
      assert.deepEqual(Object.keys(report['writes'] as object).sort(), Object.keys(WRITES_KEYS).sort());
      if (report['sync'] !== null) assert.deepEqual(Object.keys(report['sync'] as object).sort(), Object.keys(SYNC_KEYS).sort());
      if (report['linearToGit'] !== null) assert.deepEqual(Object.keys(report['linearToGit'] as object).sort(), Object.keys(REVERSE_KEYS).sort());
      if (report['initialSync'] !== null) assert.deepEqual(Object.keys(report['initialSync'] as object).sort(), Object.keys(CONFIRMED_KEYS).sort());
      if (report['capture'] !== null) {
        const required = Object.keys(CAPTURE_KEYS).filter((key) => !CAPTURE_OPTIONAL.includes(key));
        assert.deepEqual(Object.keys(report['capture'] as object).filter((key) => !CAPTURE_OPTIONAL.includes(key)).sort(), required.sort());
      }
      if (report['pullRequest'] !== null) {
        const keys = Object.keys(report['pullRequest'] as object);
        const required = Object.keys(PULL_REQUEST_KEYS).filter((key) => !PULL_REQUEST_OPTIONAL.includes(key));
        assert.deepEqual(keys.filter((key) => !PULL_REQUEST_OPTIONAL.includes(key)).sort(), required.sort());
      }
    });
  }
});

describe('a run\'s writes, from its report', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`counts ${name}`, () => {
      assert.deepEqual(runWrites(runReport(name)), expected);
    });
  }

  it('sums every operation of a kind', () => {
    const report = runReport('quiet-sync');
    report['writes'] = {
      linear: { CommentOnDocument: 1, CreateDocument: 2, FileUpload: 1, UpdateDocument: 3 },
      git: { ids: 2, linear: 1, uploads: 1 },
      pullRequests: { merged: 1, updated: 1 },
    };
    assert.deepEqual(runWrites(report), { linear: 7, git: 4, pullRequests: 2, total: 13 });
  });

  it('takes the writes from the engine, not from the results the report lists', () => {
    // Lists of written documents, a capture, a record and a pull request: the engine reported none of them as written.
    const listed = runReport('first-sync-two-created');
    listed['writes'] = { linear: {}, git: {}, pullRequests: {} };
    assert.deepEqual(runWrites(listed), { linear: 0, git: 0, pullRequests: 0, total: 0 });
    // A run that reports `changed` and names nothing counts what the engine reports, not one unnamed move.
    const quiet: Record<string, unknown> = { ...runReport('quiet-sync'), changed: true };
    assert.deepEqual(runWrites(quiet), { linear: 0, git: 0, pullRequests: 0, total: 0 });
    // A document that stays blocked is listed on every run; it counts only the writes the engine made.
    const blocked = { ...quiet, capture: { ...(quiet['capture'] as object), blocked: [{ id: 'x', path: 'eng/e.md', findings: [{ hook: 'secret-check', line: 5 }] }] } };
    assert.equal(runWrites(blocked).total, 0);
  });

  it('refuses a report that is not a run report, or whose writes are not counts', () => {
    assert.throws(() => runWrites({ summary: { code: 'initial-sync-required' } }), /the engine's report gives no writes$/);
    const report = runReport('quiet-sync');
    assert.throws(() => runWrites({ ...report, writes: { linear: {}, git: {} } }), /gives no writes\.pullRequests/);
    assert.throws(() => runWrites({ ...report, writes: { linear: { CreateDocument: -1 }, git: {}, pullRequests: {} } }), ProductError);
    assert.throws(() => runWrites({ ...report, writes: { linear: {}, git: { ids: '1' }, pullRequests: {} } }), /writes\.git\.ids that is not a count/);
  });
});
