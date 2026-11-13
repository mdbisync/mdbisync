// Which failed scheduled soak workflows a later run may recover from.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineResult } from './engine.ts';
import type { LogEntry } from '../../../src/linear/index.ts';
import { describeServerError, failedWorkflow, pullRequestStepClean, recoverableServerError, soakServerErrorPolicy, STRICT_SERVER_ERRORS } from './soak-recovery.ts';
import { ProductError } from './results.ts';

const entry = (operation: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  operation, kind: 'oauth', attempt: 1, status: 200, durationMs: 1,
  startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', rateLimitHeaders: {}, ...extra,
});
const revoked = [entry('oauth.token'), entry('oauth.revoke', { revocationConfirmed: true }), entry('oauth.token'), entry('oauth.revoke', { revocationConfirmed: true })];

/** The shape of a sync run whose pull request step got a GitHub server error while everything else completed. */
function report(changes: { pullRequest?: Record<string, unknown>; [key: string]: unknown } = {}): Record<string, unknown> {
  const { pullRequest, ...rest } = changes;
  return {
    operation: 'sync', ok: true, code: 'github-failed', exitStatus: 'failure', stop: null, complete: false, notImplemented: false, stoppedEarly: false,
    failedWriteRecorded: false, writesAfterLimit: 0, progressRecorded: true,
    capture: { ok: true, changed: ['a.md'], removed: [], heldRemovals: [], blocked: [], leftOut: [], writeBackWarnings: [] },
    pullRequest: {
      needed: true, pullRequest: { number: 328, url: 'https://github.com/owner/repo/pull/328', opened: false }, branchMoved: false,
      checks: { hasChecks: true, state: 'passed', failed: [], pending: [], succeeded: ['pre-commit'] },
      merged: null, paths: ['a.md'], marked: [], decided: [], code: 'github-failed', status: 500, ...pullRequest,
    },
    sync: { complete: true, updated: ['b.md'], failed: [], notAttempted: [], stopped: null },
    ...rest,
  };
}

function run(changes: Partial<EngineResult> = {}, reportChanges?: Parameters<typeof report>[0]): EngineResult {
  return {
    remote: { runId: 43, runAttempt: 1, linearEngine: true, requests: revoked },
    command: 'sync', exitCode: 1, conclusion: 'failure', signal: null, notImplemented: false, timedOut: false, durationMs: 1000,
    stdout: 'Sync\t2026-11-13T09:15:12Z ##[error]sync: not finished (github-failed); run it again\n', stderr: '', summary: '', report: report(reportChanges), ...changes,
  };
}

describe('soak recovery from GitHub server errors', () => {
  it('lets a later run recover from a server error in the sync pull request step', () => {
    assert.deepEqual(recoverableServerError(run()), { recoverable: { status: 500, workflowRunId: 43, pullRequest: 328 } });
    for (const status of [502, 503, 599]) assert.ok('recoverable' in recoverableServerError(run({}, { pullRequest: { status } })), String(status));
    assert.equal(describeServerError({ status: 500, workflowRunId: 43, pullRequest: 328 }), 'GitHub HTTP 500 in workflow 43 (sync pull request #328)');
    // The pull request was not opened yet: no number to name.
    assert.deepEqual(recoverableServerError(run({}, { pullRequest: { pullRequest: null } })), { recoverable: { status: 500, workflowRunId: 43 } });
  });

  it('refuses GitHub answers that are not server errors, and a request with no answer', () => {
    for (const status of [401, 403, 404, 409, 422, 429, 499, 600]) {
      assert.deepEqual(recoverableServerError(run({}, { pullRequest: { status } })), { refused: `GitHub answered HTTP ${status}, not a server error` });
    }
    assert.deepEqual(recoverableServerError(run({}, { pullRequest: { status: undefined } })), { refused: 'GitHub gave no answer' });
    assert.ok('refused' in recoverableServerError(run({}, { pullRequest: { status: '500' } })));
  });

  it('refuses any other ending, and a server error outside the pull request step', () => {
    for (const code of ['merge-blocked', 'linear-failed', 'stopped', null]) {
      assert.ok('refused' in recoverableServerError(run({}, { code })), String(code));
    }
    assert.ok('refused' in recoverableServerError(run({}, { pullRequest: { code: 'merge-refused' } })));
    assert.ok('refused' in recoverableServerError(run({ report: { ...report(), pullRequest: null } })));
    assert.ok('refused' in recoverableServerError(run({}, { operation: 'initial-sync' })));
    assert.ok('refused' in recoverableServerError(run({}, { exitStatus: 'warning' })));
  });

  it('refuses a report that shows another failure next to the server error', () => {
    const others: Array<[string, Parameters<typeof report>[0]]> = [
      ['stopped', { stop: { reason: 'rate-limited' } }],
      ['stopped early', { stoppedEarly: true }],
      ['not implemented', { notImplemented: true }],
      ['failed check', { pullRequest: { checks: { state: 'failed', failed: ['pre-commit'] } } }],
      ['blocked capture', { capture: { ok: true, blocked: ['a.md'] } }],
      ['failed capture', { capture: { ok: false } }],
      ['failed write recorded as written', { failedWriteRecorded: true }],
      ['writes after a limit', { writesAfterLimit: 2 }],
      ['progress not recorded', { progressRecorded: false }],
      ['older report without the write fields', { failedWriteRecorded: undefined }],
      ['failed write', { sync: { complete: true, failed: ['b.md'], notAttempted: [], stopped: null } }],
      ['unfinished write', { sync: { complete: false, failed: [], notAttempted: [], stopped: null } }],
      ['skipped write', { sync: { complete: true, failed: [], notAttempted: ['c.md'], stopped: null } }],
      ['stopped write', { sync: { complete: true, failed: [], notAttempted: [], stopped: 'limit' } }],
    ];
    for (const [name, changes] of others) assert.ok('refused' in recoverableServerError(run({}, changes)), name);
  });

  it('refuses a run that holds a suspended lane, failed or not', () => {
    for (const suspended of [{ paths: ['x.md'], checks: [] }, { paths: ['x.md'], checks: ['ci'] }, { paths: ['x.md'], checks: [], timedOut: ['ci'] }]) {
      assert.deepEqual(recoverableServerError(run({}, { pullRequest: { suspended } })), { refused: 'the run holds a suspended pull request lane' });
    }
  });

  it('counts a successful run as a recovery only when its pull request step did not fail', () => {
    assert.equal(pullRequestStepClean(run({ exitCode: 0, conclusion: 'success' }, { pullRequest: { code: undefined, status: undefined } })), true);
    assert.equal(pullRequestStepClean(run({ exitCode: 0, conclusion: 'success', report: { ...report(), pullRequest: null } })), true);
    // A partial write ends the run with a warning, which the workflow reports as a success, while the step still failed.
    assert.equal(pullRequestStepClean(run({ exitCode: 0, conclusion: 'success' }, { exitStatus: 'warning', code: 'write-failed' })), false);
    assert.equal(pullRequestStepClean(run({ exitCode: 0, conclusion: 'success', report: null })), false);
  });

  it('refuses a run that was cancelled or timed out, did not fail in the sync step, left no report or did not fail', () => {
    assert.deepEqual(recoverableServerError(run({ exitCode: 0 })), { refused: 'the run succeeded' });
    for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', null]) {
      assert.deepEqual(recoverableServerError(run({ conclusion })), { refused: `the run did not end on its own failure (conclusion ${String(conclusion)})` });
    }
    const { conclusion: _conclusion, ...unknown } = run();
    assert.ok('refused' in recoverableServerError(unknown));
    assert.ok('refused' in recoverableServerError(run({ timedOut: true })));
    assert.ok('refused' in recoverableServerError(run({ signal: 'SIGTERM' })));
    // Another step failed: the engine's own line for this ending is not in the logs.
    assert.deepEqual(recoverableServerError(run({ stdout: '##[error]Process completed with exit code 1.\n' })), { refused: 'the logs lack the sync step\'s own GitHub failure' });
    assert.deepEqual(recoverableServerError(run({ report: null })), { refused: 'the run left no engine report' });
    const { remote: _, ...local } = run();
    assert.deepEqual(recoverableServerError(local), { refused: 'not a workflow run' });
  });

  it('refuses a run whose tokens are not all confirmed revoked', () => {
    const unconfirmed = [entry('oauth.token'), entry('oauth.revoke', { revocationConfirmed: true }), entry('oauth.token'), entry('oauth.revoke')];
    const remote = (requests: LogEntry[]) => ({ remote: { runId: 43, runAttempt: 1, linearEngine: true, requests } });
    assert.deepEqual(recoverableServerError(run(remote(unconfirmed))), { refused: 'the run\'s token revocation is unconfirmed' });
    // No token diagnostics at all: unknown, not zero.
    assert.deepEqual(recoverableServerError(run(remote([]))), { refused: 'the run\'s token revocation is unconfirmed' });
  });

  it('fails the soak with the strict failure, and names a recoverable one for the soak\'s bound', () => {
    const recoverable = failedWorkflow(run());
    assert.ok(recoverable.error instanceof ProductError);
    assert.equal(recoverable.error.message, 'scheduled soak workflow 43 failed (exit 1)');
    assert.equal(recoverable.recoverable, 'GitHub HTTP 500 in workflow 43 (sync pull request #328)');
    assert.equal(recoverable.note, 'recoverable by a later scheduled run: GitHub HTTP 500 in workflow 43 (sync pull request #328)');
    const refused = failedWorkflow(run({}, { pullRequest: { status: 403 } }));
    assert.equal(refused.error.message, 'scheduled soak workflow 43 failed (exit 1)');
    assert.equal(refused.recoverable, undefined);
    assert.equal(refused.note, 'not recoverable: GitHub answered HTTP 403, not a server error');
  });

  it('is strict unless the step sets both bounds, and refuses bounds that are not whole numbers or set alone', () => {
    assert.deepEqual(soakServerErrorPolicy({}), STRICT_SERVER_ERRORS);
    assert.deepEqual(soakServerErrorPolicy({ serverErrorTicks: 0, serverErrorTotal: 0 }), STRICT_SERVER_ERRORS);
    assert.deepEqual(soakServerErrorPolicy({ serverErrorTicks: 2, serverErrorTotal: 3 }), { ticks: 2, total: 3 });
    for (const alone of [{ serverErrorTicks: 2 }, { serverErrorTotal: 3 }, { serverErrorTicks: 0, serverErrorTotal: 3 }]) {
      assert.throws(() => soakServerErrorPolicy(alone), /must both be set above zero, or both be zero/);
    }
    for (const bad of [-1, 1.5, 'two', Number.NaN]) {
      assert.throws(() => soakServerErrorPolicy({ serverErrorTicks: bad, serverErrorTotal: 3 }), /serverErrorTicks must be a nonnegative whole number/);
      assert.throws(() => soakServerErrorPolicy({ serverErrorTicks: 2, serverErrorTotal: bad }), /serverErrorTotal must be a nonnegative whole number/);
    }
  });
});
