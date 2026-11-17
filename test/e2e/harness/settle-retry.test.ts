// How `run.settle` runs again after a GitHub server error in the sync pull request step, and how far.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunContext } from './context.ts';
import type { EngineResult } from './engine.ts';
import { ProductError } from './results.ts';
import { mergeStillInProgress, settle, SETTLE_MERGE_IN_PROGRESS_RETRIES, SETTLE_SERVER_ERROR_RETRIES } from './steps.ts';

type Ending = 'changed' | 'merged' | 'settled' | 'server-error' | 'client-error' | 'server-error-and-failed-write' | 'in-progress' | 'refused';

/** The report a sync run leaves for each ending; the server error is an HTTP 502. */
function report(ending: Ending): Record<string, unknown> {
  const base = {
    operation: 'sync', code: null, exitStatus: 'success', changed: ending === 'changed', stop: null, notImplemented: false, stoppedEarly: false,
    failedWriteRecorded: false, writesAfterLimit: 0, progressRecorded: true,
    capture: { ok: true, blocked: [] },
    pullRequest: { needed: false, pullRequest: null, checks: null, merged: null },
    sync: { complete: true, failed: [], notAttempted: [], stopped: null },
  };
  if (ending === 'merged') return { ...base, changed: true, pullRequest: { ...base.pullRequest, needed: true, pullRequest: { number: 412, opened: false }, merged: 'a'.repeat(40) } };
  if (ending === 'changed' || ending === 'settled') return base;
  if (ending === 'in-progress' || ending === 'refused') {
    // The run that met GitHub's refusal changed nothing and ended successfully.
    const refusal = ending === 'in-progress' ? 'Merge already in progress' : 'Required status check "ci" is expected.';
    return { ...base, pullRequest: { ...base.pullRequest, needed: true, pullRequest: { number: 412, opened: false }, checks: { hasChecks: false, state: 'passed', failed: [], pending: [] }, code: 'merge-refused', status: 405, reason: refusal } };
  }
  return {
    ...base, code: 'github-failed', exitStatus: 'failure', changed: false,
    pullRequest: {
      needed: true, pullRequest: { number: 412, opened: false }, branchMoved: false, checks: { hasChecks: false, state: 'passed', failed: [], pending: [] },
      merged: null, code: 'github-failed', status: ending === 'client-error' ? 422 : 502,
    },
    ...(ending === 'server-error-and-failed-write' ? { sync: { complete: true, failed: ['a.md'], notAttempted: [], stopped: null } } : {}),
  };
}

/** A local settle whose runs end as `endings` says, in order; the last ending repeats. */
async function settleWith(endings: Ending[], limit?: number, options: { args?: Record<string, unknown>; now?: () => number } = {}) {
  const results: EngineResult[] = [];
  const log: string[] = [];
  const ctx = {
    live: null, scenario: { setup: { fixtures: [] } }, engine: { results }, observations: new Map<string, unknown>(), log: (line: string) => log.push(line),
  } as unknown as RunContext;
  const runOnce = async () => {
    const ending = endings[Math.min(results.length, endings.length - 1)]!;
    const failed = !['changed', 'merged', 'settled', 'in-progress', 'refused'].includes(ending);
    results.push({ command: 'sync', exitCode: failed ? 1 : 0, signal: null, timedOut: false, notImplemented: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: report(ending) });
  };
  const outcome = await settle(ctx, options.args ?? {}, limit, runOnce, options.now).then(() => undefined, (error: unknown) => error);
  const name = (result: EngineResult) => {
    const pullRequest = result.report!.pullRequest as { merged: unknown; status?: number; reason?: string };
    if (result.exitCode !== 0) return `failed ${String(pullRequest.status)}`;
    if (pullRequest.reason !== undefined) return pullRequest.reason === 'Merge already in progress' ? 'in-progress' : 'refused';
    return result.report!.changed ? (pullRequest.merged ? 'merged' : 'changed') : 'settled';
  };
  return { outcome, runs: results.map(name), ctx, log };
}

describe('run.settle after a GitHub server error', () => {
  it('runs again after one server error and settles, keeping the failed run among the results', async () => {
    const { outcome, runs, ctx, log } = await settleWith(['changed', 'server-error', 'changed', 'settled']);
    assert.equal(outcome, undefined);
    assert.deepEqual(runs, ['changed', 'failed 502', 'changed', 'settled']);
    assert.equal(ctx.observations.get('settle.serverErrorRetries'), 1);
    assert.deepEqual(log, [`run.settle: GitHub HTTP 502 (sync pull request #412); running again (1 of ${SETTLE_SERVER_ERROR_RETRIES})`]);
  });

  it('fails the settle with the server error when it persists past the bound', async () => {
    const { outcome, runs } = await settleWith(['server-error']);
    assert.ok(outcome instanceof ProductError);
    assert.equal(outcome.message, `run.settle: GitHub HTTP 502 (sync pull request #412) failed ${SETTLE_SERVER_ERROR_RETRIES + 1} runs, more than the ${SETTLE_SERVER_ERROR_RETRIES} the settle runs again after`);
    assert.equal(runs.length, SETTLE_SERVER_ERROR_RETRIES + 1);
  });

  it('counts server errors across the whole settle, not only in a row', async () => {
    const { outcome, runs } = await settleWith(['server-error', 'changed', 'server-error', 'changed', 'server-error', 'settled']);
    assert.ok(outcome instanceof ProductError);
    assert.deepEqual(runs, ['failed 502', 'changed', 'failed 502', 'changed', 'failed 502']);
  });

  it('gives the runs after a server error on top of the settle\'s limit', async () => {
    const { outcome, runs } = await settleWith(['changed', 'changed', 'changed', 'server-error', 'settled']);
    assert.equal(outcome, undefined);
    assert.deepEqual(runs, ['changed', 'changed', 'changed', 'failed 502', 'settled']);
  });

  it('keeps the run after a merge on the last attempt as its own bound next to the server error retries', async () => {
    const { outcome, runs } = await settleWith(['changed', 'server-error', 'changed', 'changed', 'merged', 'settled']);
    assert.equal(outcome, undefined);
    assert.deepEqual(runs, ['changed', 'failed 502', 'changed', 'changed', 'merged', 'settled']);
  });

  it('judges only a run the attempt recorded, never an earlier step\'s failed run', async () => {
    const results: EngineResult[] = [];
    const ctx = { live: null, scenario: { setup: { fixtures: [] } }, engine: { results }, observations: new Map<string, unknown>(), log: () => {} } as unknown as RunContext;
    results.push({ command: 'sync', exitCode: 1, signal: null, timedOut: false, notImplemented: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: report('server-error') });
    let attempts = 0;
    await settle(ctx, {}, 4, async () => { attempts += 1; });
    assert.equal(attempts, 4, 'attempts that record nothing use up the limit, as before');
    assert.equal(ctx.observations.get('settle.serverErrorRetries'), undefined);
  });

  it('does not run again after a client error or a server error next to another failure', async () => {
    for (const ending of ['client-error', 'server-error-and-failed-write'] as const) {
      const { outcome, runs, ctx } = await settleWith([ending, 'settled']);
      assert.equal(outcome, undefined, ending);
      assert.equal(runs.length, 1, `${ending}: the run that changed nothing ends the settle, as before`);
      assert.equal(ctx.observations.get('settle.serverErrorRetries'), undefined);
    }
  });
});

describe('run.settle while GitHub has a merge in progress', () => {
  it('runs again after a server error and the merge GitHub still has in progress, and settles once it merged', async () => {
    const { outcome, runs, ctx, log } = await settleWith(['changed', 'server-error', 'in-progress', 'in-progress', 'merged', 'settled']);
    assert.equal(outcome, undefined);
    assert.deepEqual(runs, ['changed', 'failed 502', 'in-progress', 'in-progress', 'merged', 'settled']);
    assert.equal(ctx.observations.get('settle.mergeInProgressRuns'), 2);
    assert.equal(log.at(-1), `run.settle: GitHub still has a merge of the sync pull request in progress; running again (2 of ${SETTLE_MERGE_IN_PROGRESS_RETRIES})`);
  });

  it('fails the settle when the merge stays in progress past the bound', async () => {
    const { outcome, runs } = await settleWith(['server-error', 'in-progress']);
    assert.ok(outcome instanceof ProductError);
    assert.equal(outcome.message, `run.settle: GitHub still had a merge of the sync pull request in progress after ${SETTLE_MERGE_IN_PROGRESS_RETRIES + 1} runs, more than the ${SETTLE_MERGE_IN_PROGRESS_RETRIES} the settle runs again after`);
    assert.equal(runs.length, SETTLE_MERGE_IN_PROGRESS_RETRIES + 2);
  });

  it('ends on any other refusal as before: the run changed nothing', async () => {
    const { outcome, runs, ctx } = await settleWith(['refused', 'settled']);
    assert.equal(outcome, undefined);
    assert.deepEqual(runs, ['refused']);
    assert.equal(ctx.observations.get('settle.mergeInProgressRuns'), undefined);
  });

  it('reads a merge in progress in the suspended lane too', () => {
    const suspended = { code: 'merge-refused', status: 405, reason: 'Merge already in progress' };
    assert.equal(mergeStillInProgress({ pullRequest: { code: 'merge-refused', suspended } }), true);
    assert.equal(mergeStillInProgress({ pullRequest: { suspended: { ...suspended, status: 409 } } }), false);
    assert.equal(mergeStillInProgress({ pullRequest: { code: 'merge-blocked', status: 405, reason: 'Merge already in progress' } }), false);
    assert.equal(mergeStillInProgress(null), false);
  });
});

describe('run.settle with a typing window', () => {
  /** A clock that moves 20 seconds each time it is read, from 2026-01-01T00:00:00Z. */
  function clock(): () => number {
    let at = Date.parse('2026-01-01T00:00:00Z') - 20_000;
    return () => (at += 20_000);
  }

  it('runs syncs through the window whatever they change, then settles as usual', async () => {
    const { outcome, runs, ctx, log } = await settleWith(['changed', 'settled', 'changed', 'settled'], undefined, { args: { typingSeconds: 50 }, now: clock() });
    assert.equal(outcome, undefined);
    // Without the window the settle would end on the second run; the window's three runs come first.
    assert.deepEqual(runs, ['changed', 'settled', 'changed', 'settled']);
    assert.deepEqual(ctx.observations.get('settle.typingWindow'), { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', runs: 3 });
    assert.deepEqual(log, [
      'run.settle: running syncs for 50 seconds while the UI session types',
      'run.settle: typing window 2026-01-01T00:00:00.000Z to 2026-01-01T00:01:00.000Z, 3 run(s); settling now',
    ]);
  });

  it('runs at least once in a window that has already passed, and settles without one as before', async () => {
    const short = await settleWith(['settled'], undefined, { args: { typingSeconds: 0 }, now: clock() });
    assert.deepEqual(short.runs, ['settled', 'settled']);
    const without = await settleWith(['settled'], undefined, { now: clock() });
    assert.deepEqual(without.runs, ['settled']);
    assert.equal(without.ctx.observations.has('settle.typingWindow'), false);
  });
});
