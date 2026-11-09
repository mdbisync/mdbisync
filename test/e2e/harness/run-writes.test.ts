import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ConfirmedReport, ReverseReport, RunReport, SyncReport } from '../../../src/run/finish.ts';
import type { PullRequestResult } from '../../../src/sync/index.ts';
import { ProductError } from './results.ts';
import { runWrites, type RunWrites } from './subjects.ts';

// Engine run reports, fixed: the three runs of L1R-03 as the engine reported
// them live (the reverse initial sync, the first sync after a person merged
// its pull request, which created two documents, and the quiet run after it),
// two more sync runs whose writes the report names elsewhere, and a
// confirmed initial sync from git to Linear.
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
  skippedConcurrentDocument: true, capturedTrackedTip: true, rereadWindowMs: true, linearToGit: true,
} satisfies Record<keyof RunReport, true>;
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
  needed: true, pullRequest: true, branchMoved: true, checks: true, merged: true, paths: true, code: true, status: true, reason: true,
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
const PULL_REQUEST_OPTIONAL = ['code', 'status', 'reason'];

const EXPECTED: Record<string, RunWrites> = {
  'reverse-initial-sync': { linear: 0, git: 1, pullRequests: 1, total: 2 },
  'first-sync-two-created': { linear: 2, git: 1, pullRequests: 0, total: 3 },
  'quiet-sync': { linear: 0, git: 0, pullRequests: 0, total: 0 },
  'state-ref-only-sync': { linear: 0, git: 1, pullRequests: 0, total: 1 },
  'sync-pull-request-opened': { linear: 0, git: 2, pullRequests: 1, total: 3 },
  // Three created and one overwritten; the record and one progress push.
  'initial-sync-to-linear': { linear: 4, git: 2, pullRequests: 0, total: 6 },
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

  it('never counts fewer documents than the report says it wrote', () => {
    const report = runReport('first-sync-two-created');
    assert.equal(runWrites(report).linear, report['writtenDocuments']);
    // A written document in a list this count does not read is still counted through writtenDocuments.
    const unlisted = { ...report, sync: { ...(report['sync'] as object), created: [] }, writtenCount: 0 };
    assert.equal(runWrites(unlisted).linear, 2);
  });

  it('counts each document once across the lists that name it', () => {
    const report = runReport('quiet-sync');
    const moved = {
      ...report,
      changed: true,
      sync: { ...(report['sync'] as object), updated: ['eng/b.md'], relocated: [{ from: 'eng/a.md', to: 'eng/b.md' }], trashed: ['eng/c.md'], restored: ['eng/d.md'] },
    };
    assert.deepEqual(runWrites(moved), { linear: 3, git: 0, pullRequests: 0, total: 3 });
  });

  it('counts no write for a document that stays blocked', () => {
    // The capture lists it on every run, and the run reports changed, though its mark is already in place.
    const report = runReport('quiet-sync');
    const blocked = { ...report, changed: true, capture: { ...(report['capture'] as object), blocked: [{ id: 'x', path: 'eng/e.md', findings: [{ hook: 'secret-check', line: 5 }] }] } };
    assert.deepEqual(runWrites(blocked), { linear: 0, git: 0, pullRequests: 0, total: 0 });
  });

  it('counts a capture that lists changes also when it did not finish', () => {
    const opened = runReport('sync-pull-request-opened');
    const capture = opened['capture'] as Record<string, unknown>;
    assert.equal(runWrites({ ...opened, pullRequest: null }).git, 1);
    // Published, then a lost lease while it saved marks, or a Linear failure: it keeps its lists, and so does a
    // capture whose first push was refused. The report does not tell them apart, so neither passes as zero writes.
    for (const code of ['state-moved', 'stopped', 'linear-failed']) {
      const unfinished: Record<string, unknown> = { ...opened, ok: false, code, pullRequest: null, sync: null, capture: { ...capture, ok: false } };
      assert.deepEqual(runWrites(unfinished), { linear: 0, git: 1, pullRequests: 0, total: 1 }, code);
    }
    // One that failed before it published cleared its lists, and the run reports no change.
    const cleared = { ...opened, ok: false, changed: false, code: 'linear-failed', pullRequest: null, sync: null, capture: { ...capture, ok: false, changed: [] } };
    assert.deepEqual(runWrites(cleared), { linear: 0, git: 0, pullRequests: 0, total: 0 });
  });

  it('counts a merge and a closed pull request', () => {
    const merged = runReport('quiet-sync');
    merged['changed'] = true;
    merged['pullRequest'] = { ...(merged['pullRequest'] as object), merged: 'c0e66191259920baa3abdfa6f88abac44bfb65db' };
    assert.deepEqual(runWrites(merged), { linear: 0, git: 0, pullRequests: 1, total: 1 });
    const closing = runReport('reverse-initial-sync');
    const reverse = closing['linearToGit'] as Record<string, unknown>;
    closing['linearToGit'] = { ...reverse, record: null, pullRequest: null, closedPullRequest: 15 };
    assert.deepEqual(runWrites(closing), { linear: 0, git: 0, pullRequests: 1, total: 1 });
  });

  it('refuses a report that is not a run report', () => {
    assert.throws(() => runWrites({ summary: { code: 'initial-sync-required' } }), ProductError);
  });
});
