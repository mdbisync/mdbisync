import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import type { LogEntry } from '../../../src/linear/index.ts';
import type { SandboxRest, WorkflowRun } from './github.ts';
import type { RunContext } from './context.ts';
import { diagnosticRequests, engineRequestCount, requestBuckets, remoteRequests } from './request-accounting.ts';
import { INVARIANT_CHECKS } from './checks.ts';
import { resultOf } from './runner.ts';
import { BudgetBlockedError, Governor } from './governor.ts';
import { loadScenarios } from './spec.ts';
import { runResult } from './workflows.ts';

// Retained dry and confirmed initial-sync diagnostics, stripped to safe request
// metadata, with neutral request identifiers. Counts and limit headers are real.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/remote-requests.json', import.meta.url), 'utf8')) as Record<'dry' | 'confirmed', LogEntry[]>;
const logs = (entries: LogEntry[]) => new Map([
  ['0_job.txt', entries.map((entry) => `2026-11-09T22:37:05.1253126Z ${JSON.stringify(entry)}`).join('\n')],
  ['job/7_Apply.txt', entries.map((entry) => `2026-11-09T22:37:05.1253124Z ${JSON.stringify(entry)}`).join('\n')],
]);
const rest = { request: async () => ({ artifacts: [] }) } as unknown as SandboxRest;
const run = (id: number): WorkflowRun => ({ id, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: '2026-11-09T22:37:00Z' });

it('collects each remote request once despite duplicated job and step logs', async () => {
  for (const [id, entries] of [[1, recorded.dry], [2, recorded.confirmed]] as const) {
    const result = await runResult(rest, run(id), 'initial-sync', logs(entries));
    assert.equal(result.remote?.requests.length, entries.length);
  }
});

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scenario = loadScenarios().find((item) => item.id === 'L1-20')!;
async function context(): Promise<RunContext> {
  const results = await Promise.all([runResult(rest, run(1), 'initial-sync', logs(recorded.dry)), runResult(rest, run(2), 'initial-sync', logs(recorded.confirmed))]);
  return {
    scenario, names: { runId: 'abcdef' }, live: null,
    engine: { results, setupRuns: 0 }, observations: new Map(),
    proxy: { requests: Array.from({ length: 4 }, () => ({ kind: 'query', operation: 'Read', status: 200, injected: false })) },
  } as unknown as RunContext;
}

it('includes actual remote writes in the runner total and I9 while keeping local cost', async () => {
  const ctx = await context();
  assert.equal(engineRequestCount(ctx), 21); // 4 local + 2 dry + 15 confirmed
  const result = resultOf(ctx, { result: 'pass' }, { startedAt: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } });
  assert.equal(result.engineRequests, 21);
  assert.equal(requestBuckets(ctx).remote.scenario.graphql, 17);
  assert.equal(requestBuckets(ctx).remote.scenario.uploadGraphql, 1);
  assert.equal(requestBuckets(ctx).remote.scenario.oauthExchange, 2);
  assert.equal(requestBuckets(ctx).remote.scenario.oauthRevoke, 2);
  assert.equal(requestBuckets(ctx).remote.scenario.uploadPut, 'unobserved');
  assert.equal(remoteRequests(ctx).filter(({ entry }) => entry.operation === 'CreateDocument').length, 12);
  assert.equal((await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); })).ok, true);
  // An excessive remote read cost must fail I9, even when the local proxy is quiet.
  ctx.engine.results[1]!.remote!.requests.push(...Array.from({ length: 40 }, (_, index) => ({ ...recorded.confirmed[1]!, requestId: `extra-${index}` })));
  assert.equal((await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); })).ok, false);
});

it('deduplicates repeated settling but counts workflow retries and request attempts', async () => {
  const ctx = await context();
  ctx.engine.results.push(ctx.engine.results[1]!);
  assert.equal(engineRequestCount(ctx), 21);
  ctx.engine.results.push({ ...ctx.engine.results[1]!, remote: { ...ctx.engine.results[1]!.remote!, runAttempt: 2 } });
  assert.equal(engineRequestCount(ctx), 36);
  const entry = recorded.dry[1]!;
  const retry = { ...entry, requestId: 'retry', attempt: 2 };
  assert.equal(diagnosticRequests(logs([entry, retry])).length, 2);
  const noId = { ...entry, requestId: undefined };
  assert.equal(diagnosticRequests(new Map([['job', [noId, noId, { ...noId, attempt: 2 }].map((e) => JSON.stringify(e)).join('\n')]])).length, 3);
});

it('keeps setup and I6 separate from the scenario and from editor traffic', async () => {
  const ctx = await context();
  ctx.engine.setupRuns = 1;
  ctx.observations.set('scenario.runsEnd', 1);
  ctx.observations.set('start.proxyIndex', 1);
  ctx.observations.set('scenario.proxyEnd', 3);
  const buckets = requestBuckets(ctx);
  assert.deepEqual(buckets.local, { setup: 1, scenario: 2, I6: 1 });
  assert.equal(buckets.remote.setup.graphql, 2);
  assert.equal(buckets.remote.scenario.graphql, 0);
  assert.equal(buckets.remote.I6.graphql, 15);
  assert.equal(engineRequestCount(ctx), 21);
});

it('does not claim a zero-cost successful remote run when diagnostics are missing', async () => {
  const ctx = await context();
  ctx.proxy = null;
  for (const conclusion of ['success', 'failure']) {
    ctx.engine.results = [await runResult(rest, { ...run(3), conclusion }, 'initial-sync', new Map([['job', 'unrelated output']]))];
    const check = await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); });
    assert.equal(check.ok, false);
    assert.match(check.detail!, /diagnostics are missing/);
  }
});

it('ignores unrelated or malformed log JSON and strips fields outside the diagnostic schema', () => {
  const requests = diagnosticRequests(new Map([['job', [
    '{broken', 'null', '{"operation":"x"}',
    JSON.stringify({ ...recorded.confirmed[1], token: 'private-canary', rateLimitHeaders: { ...recorded.confirmed[1]!.rateLimitHeaders, 'set-cookie': 'private-canary' } }),
  ].join('\n')]]));
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests).includes('private-canary'), false);
});

it('feeds real recorded limit headers to admission without manufacturing a budget status', async () => {
  const header = recorded.confirmed.find((entry) => entry.operation === 'SetupTargets')!.rateLimitHeaders;
  const resetAt = Math.max(Number(header['x-ratelimit-requests-reset']), Number(header['x-ratelimit-complexity-reset']));
  let now = Date.parse(recorded.confirmed[1]!.startedAt);
  let reads = 0;
  const root = mkdtempSync(join(tmpdir(), 'remote-budget-'));
  roots.push(root);
  const governor = new Governor({
    apps: [{ name: 'app', readBudget: async () => { reads++; return { requestsRemaining: 5000, complexityRemaining: 2000000, resetAt: now }; } }],
    stateDir: root, now: () => now, maxWaitMs: 0,
  });
  governor.observeRateLimits('app', header);
  const first = await governor.admit(scenario, 'abcde1', { requests: 1, complexity: 1200000 });
  try {
    // Existing reservations plus the actual observed complexity leave less
    // than 698000 points, although a fresh full window could cover it.
    await assert.rejects(governor.admit(scenario, 'abcde2', { requests: 1, complexity: 698000 }), BudgetBlockedError);
    assert.equal(reads, 2, 'the governor still queries the real current app budget');
    now = resetAt + 1;
    const grant = await governor.admit(scenario, 'abcde3', { requests: 1, complexity: 698000 });
    grant.release();
  } finally { first.release(); }
});

it('preserves identical simultaneous attempts without server ids across step and overview logs', () => {
  const { requestId: _, ...entry } = recorded.dry[1]!;
  const text = JSON.stringify(entry);
  assert.equal(diagnosticRequests(new Map([
    ['0_job.txt', `${text}\n${text}`], ['job/1_stage.txt', text], ['job/2_apply.txt', text],
  ])).length, 2);
  assert.equal(diagnosticRequests(new Map([
    ['0_job.txt', `${text}\n${text}`], ['job/1_stage.txt', `${text}\n${text}`],
  ])).length, 2);
});

it('counts rejected mutations as requests without granting a written-document allowance', async () => {
  const ctx = await context();
  ctx.proxy = null;
  const rejected = Array.from({ length: 20 }, (_, index) => ({ ...recorded.confirmed[3]!, requestId: `rejected-${index}`, errorCodes: ['INPUT_ERROR'] }));
  ctx.engine.results = [await runResult(rest, { ...run(4), conclusion: 'failure' }, 'initial-sync', logs(rejected))];
  assert.equal(engineRequestCount(ctx), 20);
  assert.equal((await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); })).ok, false);
});

it('admits workflows on their configured app and lets a later fresh read supersede old limits', async () => {
  let now = Date.parse(recorded.confirmed[1]!.startedAt);
  const root = mkdtempSync(join(tmpdir(), 'remote-app-'));
  roots.push(root);
  const governor = new Governor({
    apps: ['primary', 'other'].map((name) => ({ name, readBudget: async () => ({ requestsRemaining: 5000, complexityRemaining: 2000000, resetAt: now }) })),
    stateDir: root, now: () => now, maxWaitMs: 0,
  });
  // A depleted requests observation expires earlier than complexity. A fresh
  // later read wins even before either rolling window reset.
  governor.observeRateLimits('primary', {
    ...recorded.confirmed[1]!.rateLimitHeaders,
    'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': String(now + 1000),
  });
  const other = await governor.admit(scenario, 'abcdef1', { requests: 1, complexity: 1 }, 'other');
  assert.equal(other.app.name, 'other');
  other.release();
  await assert.rejects(governor.admit(scenario, 'abcdef2', { requests: 1, complexity: 1 }, 'primary'), BudgetBlockedError);
  now += 1;
  const primary = await governor.admit(scenario, 'abcdef3', { requests: 1, complexity: 1 }, 'primary');
  assert.equal(primary.app.name, 'primary');
  primary.release();
  now += 2000;
  const recovered = await governor.admit(scenario, 'abcdef4', { requests: 1, complexity: 1 }, 'primary');
  recovered.release();
});

it('allows the hook-only L0-09 workflow while requiring diagnostics from Linear engine workflows', async () => {
  const ctx = await context();
  ctx.scenario = loadScenarios().find((item) => item.id === 'L0-09')!;
  ctx.proxy = null;
  assert.equal(ctx.scenario.checks.invariants.I9.required, true);
  for (const conclusion of ['success', 'failure']) {
    for (const path of ['.github/workflows/pre-commit.yml', '.github/workflows/pre-commit.yml@refs/pull/1/merge']) {
      ctx.engine.results = [await runResult(rest, { ...run(5), conclusion, path }, 'sync', new Map([['job', 'Formatting hooks completed']]))];
      assert.equal((await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); })).ok, true);
    }
    for (const path of [undefined, '.github/workflows/mdbisync.yml', '.github/workflows/mdbisync-initial-sync.yml']) {
      ctx.engine.results = [await runResult(rest, { ...run(6), conclusion, ...(path === undefined ? {} : { path }) }, 'sync', new Map())];
      assert.equal((await INVARIANT_CHECKS.I9(ctx, async () => { throw new Error('unexpected world read'); })).ok, false);
    }
  }
});
