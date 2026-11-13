// How `run.settle` runs again after a GitHub server error in the sync pull request step, and how far.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunContext } from './context.ts';
import type { EngineResult } from './engine.ts';
import { ProductError } from './results.ts';
import { settle, SETTLE_SERVER_ERROR_RETRIES } from './steps.ts';

type Ending = 'changed' | 'merged' | 'settled' | 'server-error' | 'client-error' | 'server-error-and-failed-write';

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
async function settleWith(endings: Ending[], limit?: number) {
  const results: EngineResult[] = [];
  const log: string[] = [];
  const ctx = {
    live: null, scenario: { setup: { fixtures: [] } }, engine: { results }, observations: new Map<string, unknown>(), log: (line: string) => log.push(line),
  } as unknown as RunContext;
  const runOnce = async () => {
    const ending = endings[Math.min(results.length, endings.length - 1)]!;
    const failed = !['changed', 'merged', 'settled'].includes(ending);
    results.push({ command: 'sync', exitCode: failed ? 1 : 0, signal: null, timedOut: false, notImplemented: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: report(ending) });
  };
  const outcome = await settle(ctx, {}, limit, runOnce).then(() => undefined, (error: unknown) => error);
  return { outcome, runs: results.map((result) => (result.exitCode === 0 ? (result.report!.changed ? ((result.report!.pullRequest as { merged: unknown }).merged ? 'merged' : 'changed') : 'settled') : `failed ${String((result.report!.pullRequest as { status: number }).status)}`)), ctx, log };
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
