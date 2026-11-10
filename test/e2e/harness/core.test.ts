import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { operationArguments } from '../../scenarios/schema.ts';
import { BudgetBlockedError, Governor, MAX_WORKERS_PER_APP, budgetFromStatus, engineRuns, estimate, type App, type Budget } from './governor.ts';
import { newRunId, runNames, runOfProject, runOfRef, runOfTeamTitle } from './isolation.ts';
import { LockTimeoutError, acquireLock, acquireSlot, deadLocalRuns, forgetRun, liveRuns, registerRun } from './locks.ts';
import { levelOf, loadScenarios, selectScenarios } from './spec.ts';

const scenarios = loadScenarios();
const byId = (id: string) => scenarios.find((scenario) => scenario.id === id) ?? assert.fail(id);
const stateDirs: string[] = [];
const freshStateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-core-'));
  stateDirs.push(dir);
  return dir;
};
after(() => stateDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('scenario selection', () => {
  it('loads every spec of the catalog, validated', () => {
    assert.ok(scenarios.length >= 137);
    assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  });

  it('selects by id, level, slice and mode, and all filters apply together', () => {
    assert.deepEqual(selectScenarios(scenarios, { ids: ['L1-04', 'L2-01'] }).map((s) => s.id), ['L1-04', 'L2-01']);
    const l1r = selectScenarios(scenarios, { levels: ['L1R'] });
    assert.ok(l1r.length > 0 && l1r.every((s) => s.id.startsWith('L1R-')));
    assert.ok(selectScenarios(scenarios, { levels: ['L1'] }).every((s) => levelOf(s.id) === 'L1'));
    const miniL2 = selectScenarios(scenarios, { levels: ['L2'], slices: ['mini'], modes: ['local'] });
    assert.ok(miniL2.length > 0 && miniL2.every((s) => s.slice === 'mini' && s.mode === 'local' && s.id.startsWith('L2-')));
    assert.equal(selectScenarios(scenarios, {}).length, scenarios.length);
  });

  it('refuses an unknown id or level instead of running nothing', () => {
    assert.throws(() => selectScenarios(scenarios, { ids: ['L1-99'] }), /unknown scenario id/);
    assert.throws(() => selectScenarios(scenarios, { levels: ['L7'] }), /unknown level/);
  });

  it('the schema and the harness know the same step actions', async () => {
    const { STEP_ACTIONS } = await import('./steps.ts');
    assert.deepEqual([...Object.keys(STEP_ACTIONS)].sort(), Object.keys(operationArguments).sort());
  });
});

describe('isolation names', () => {
  it('gives a run its own branches, state refs, projects and team-zone prefix', () => {
    const names = runNames('4f1a9c');
    assert.equal(names.trackedBranch, 't/4f1a9c/main');
    assert.equal(names.syncBranch, 't/4f1a9c/sync');
    assert.equal(names.refPrefix, 'refs/mdbisync-t/4f1a9c');
    assert.equal(names.teamZonePrefix, '4f1a9c/');
    assert.equal(names.project(0), 'Field notes 4f1a9c');
    assert.throws(() => names.project(99));
    assert.throws(() => runNames('XYZ'));
    assert.match(newRunId(), /^[0-9a-f]{6}$/);
  });

  it('maps leftovers back to their run and ignores everything else', () => {
    assert.equal(runOfRef('refs/heads/t/4f1a9c/main'), '4f1a9c');
    assert.equal(runOfRef('refs/heads/t/4f1a9c/sync'), '4f1a9c');
    assert.equal(runOfRef('refs/heads/t/4f1a9c/suspended'), '4f1a9c');
    assert.equal(runOfRef('refs/mdbisync-t/4f1a9c/ids'), '4f1a9c');
    for (const ref of ['refs/heads/main', 'refs/mdbisync/linear', 'refs/heads/t/4f1a9c/other', 'refs/heads/mdbisync/linear']) assert.equal(runOfRef(ref), null, ref);
    assert.equal(runOfProject('Harbor log 4f1a9c'), '4f1a9c');
    for (const name of ['Sync sandbox ENG', 'Sync sandbox DOCS', 'Harbor log', 'Other words 4f1a9c']) assert.equal(runOfProject(name), null, name);
    assert.equal(runOfTeamTitle('4f1a9c/guides/start'), '4f1a9c');
    assert.equal(runOfTeamTitle('guides/start'), null);
  });
});

describe('locks', () => {
  it('lets one holder in at a time and hands over on release', async () => {
    const stateDir = freshStateDir();
    const first = await acquireLock('team-eng', { stateDir, runId: 'aaaaaa', timeoutMs: 0 });
    let waitedFor: string | undefined;
    await assert.rejects(
      acquireLock('team-eng', { stateDir, runId: 'bbbbbb', timeoutMs: 300, pollMs: 50, onWait: (holder) => (waitedFor = holder?.runId) }),
      LockTimeoutError,
    );
    assert.equal(waitedFor, 'aaaaaa');
    const second = acquireLock('team-eng', { stateDir, runId: 'bbbbbb', timeoutMs: 5_000, pollMs: 20 });
    setTimeout(() => first.release(), 100);
    (await second).release();
  });

  it('takes over a lock whose holder process died', async () => {
    const stateDir = freshStateDir();
    const child = spawn(process.execPath, ['-e', `
      const { acquireLock } = await import(${JSON.stringify(new URL('./locks.ts', import.meta.url).href)});
      await acquireLock('team-docs', { stateDir: ${JSON.stringify(stateDir)}, runId: 'cccccc', timeoutMs: 0 });
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);
    `, '--input-type=module'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    await assert.rejects(acquireLock('team-docs', { stateDir, runId: 'dddddd', timeoutMs: 0 }), LockTimeoutError);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    (await acquireLock('team-docs', { stateDir, runId: 'dddddd', timeoutMs: 1_000 })).release();
  });

  it('keeps a held run\'s lock after its process ends, for its own take-up, until its hold ends', async () => {
    const stateDir = freshStateDir();
    const keep = async (runId: string, lockUntil: number, runUntil: number) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { acquireLock, registerRun } = await import(${JSON.stringify(new URL('./locks.ts', import.meta.url).href)});
        const stateDir = ${JSON.stringify(stateDir)};
        const lock = await acquireLock('team-eng', { stateDir, runId: '${runId}', timeoutMs: 0 });
        registerRun(stateDir, '${runId}').hold(${runUntil});
        lock.hold(${lockUntil});
      `], { stdio: ['ignore', 'inherit', 'inherit'] });
      const [code] = await new Promise<unknown[]>((resolve) => child.once('exit', (...args) => resolve(args)));
      assert.equal(code, 0);
    };
    const later = Date.now() + 3_600_000;
    await keep('aaaaaa', later, later);
    await assert.rejects(acquireLock('team-eng', { stateDir, runId: 'bbbbbb', timeoutMs: 0 }), LockTimeoutError, 'the holder\'s process ended, the hold did not');
    await keep('aaaaaa', later, later); // the run's take-up in a later process, still waiting for the UI session
    await assert.rejects(acquireLock('team-eng', { stateDir, runId: 'bbbbbb', timeoutMs: 0 }), LockTimeoutError, 'kept again after the take-up');
    registerRun(stateDir, 'aaaaaa').done();
    (await acquireLock('team-eng', { stateDir, runId: 'bbbbbb', timeoutMs: 0 })).release();

    await keep('cccccc', Date.now() + 200, later);
    await new Promise((resolve) => setTimeout(resolve, 250));
    (await acquireLock('team-eng', { stateDir, runId: 'dddddd', timeoutMs: 0 })).release();
    await keep('eeeeee', later, Date.now() - 1);
    (await acquireLock('team-eng', { stateDir, runId: 'ffffff', timeoutMs: 0 })).release();
    forgetRun(stateDir, 'cccccc');
    forgetRun(stateDir, 'eeeeee');
  });

  it('counts slots: at most N holders of a semaphore', async () => {
    const stateDir = freshStateDir();
    const held = await Promise.all(Array.from({ length: 4 }, (_, i) => acquireSlot('app-x', 4, { stateDir, runId: `00000${i}`, timeoutMs: 0 })));
    await assert.rejects(acquireSlot('app-x', 4, { stateDir, runId: '000009', timeoutMs: 0 }), LockTimeoutError);
    held[2]?.release();
    (await acquireSlot('app-x', 4, { stateDir, runId: '000009', timeoutMs: 0 })).release();
    held.forEach((lock) => lock.release());
  });

  it('knows live runs and finds killed ones', () => {
    const stateDir = freshStateDir();
    const live = registerRun(stateDir, 'eeeeee');
    assert.ok(liveRuns(stateDir).has('eeeeee'));
    assert.equal(deadLocalRuns(stateDir).size, 0);
    live.done();
    assert.equal(liveRuns(stateDir).size, 0);
    forgetRun(stateDir, 'eeeeee');
  });
});

describe('budget governor', () => {
  const full = (overrides: Partial<Budget> = {}): Budget => ({ requestsRemaining: 5_000, complexityRemaining: 2_000_000, resetAt: 0, ...overrides });

  it('estimates from the slice, the engine runs and I9', () => {
    const l104 = byId('L1-04');
    assert.equal(engineRuns(l104), 2); // initial sync and the I6 re-run
    assert.equal(estimate(byId('L0-01')).requests, 0);
    const mini = estimate(byId('L2-01'));
    const bank = estimate(l104);
    assert.ok(mini.requests > 0 && bank.requests > mini.requests);
    assert.equal(bank.complexity, bank.requests * 400);
  });

  it('reads both limits from rateLimitStatus', () => {
    const budget = budgetFromStatus({
      identifier: null,
      kind: 'app',
      limits: [
        { type: 'requestLimit', allowedAmount: 5000, remainingAmount: 4200, requestedAmount: 1, period: 3600000, reset: 1_900_000_000_000 },
        { type: 'complexityLimit', allowedAmount: 2_000_000, remainingAmount: 1_500_000, requestedAmount: 1, period: 3600000, reset: 1_900_000_100_000 },
      ],
    }, 0);
    assert.deepEqual(budget, { requestsRemaining: 4200, complexityRemaining: 1_500_000, resetAt: 1_900_000_100_000, requestsAllowed: 5000, complexityAllowed: 2_000_000 });
    const unknown = budgetFromStatus({
      identifier: null,
      kind: 'api key',
      limits: [
        { type: 'requestLimit', allowedAmount: null as never, remainingAmount: 10, requestedAmount: 1, period: 3600000, reset: 1_900_000_000_000 },
        { type: 'complexityLimit', allowedAmount: 0, remainingAmount: 10, requestedAmount: 1, period: 3600000, reset: 1_900_000_000_000 },
      ],
    }, 0);
    assert.deepEqual(unknown, { requestsRemaining: 10, complexityRemaining: 10, resetAt: 1_900_000_000_000 }, 'a missing or zero allowance is unknown, not a zero window');
    assert.throws(() => budgetFromStatus({ identifier: null, kind: 'app', limits: [] }, 0), /lacks/);
  });

  function fakeApp(name: string, budgets: Budget[]): App & { reads: number } {
    const app = {
      name,
      reads: 0,
      async readBudget() {
        app.reads += 1;
        return budgets[Math.min(app.reads - 1, budgets.length - 1)] as Budget;
      },
    };
    return app;
  }

  it('admits at once when the budget covers the estimate', async () => {
    const app = fakeApp('one', [full()]);
    const governor = new Governor({ apps: [app], stateDir: freshStateDir() });
    const grant = await governor.admit(byId('L2-01'), 'aaaaa1', { requests: 100, complexity: 1000 });
    assert.equal(grant.app.name, 'one');
    grant.release();
  });

  it('waits for the window to refill when the budget is short', async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const app = fakeApp('one', [full({ requestsRemaining: 250, resetAt: now + 60_000 }), full()]);
    const governor = new Governor({ apps: [app], stateDir: freshStateDir(), now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
    const grant = await governor.admit(byId('L2-01'), 'aaaaa2', { requests: 100, complexity: 1000 });
    assert.deepEqual(slept, [61_000]);
    assert.equal(grant.waitedMs, 61_000);
    grant.release();
  });

  it('reports the scenario budget-blocked rather than waiting past the longest wait', async () => {
    let now = 0;
    const app = fakeApp('one', [full({ requestsRemaining: 10, resetAt: 10 * 3_600_000 })]);
    const governor = new Governor({ apps: [app], stateDir: freshStateDir(), now: () => now, sleep: async (ms) => { now += ms; } });
    await assert.rejects(governor.admit(byId('L2-01'), 'aaaaa3', { requests: 100, complexity: 1 }), BudgetBlockedError);
  });

  it('starts a scenario bigger than one window on a mostly full window', async () => {
    const app = fakeApp('one', [full()]);
    const governor = new Governor({ apps: [app], stateDir: freshStateDir() });
    const grant = await governor.admit(byId('L1-16'), 'aaaaa4', { requests: 50_000, complexity: 20_000_000 });
    grant.release();
  });

  it('counts the budget it already promised to running scenarios', async () => {
    const app = fakeApp('one', [full({ requestsRemaining: 2_200 })]);
    const governorDir = freshStateDir();
    const governor = new Governor({ apps: [app], stateDir: governorDir, maxWaitMs: 0, sleep: async () => {} });
    const first = await governor.admit(byId('L2-01'), 'ddddd1', { requests: 1_500, complexity: 1 });
    await assert.rejects(governor.admit(byId('L2-01'), 'ddddd2', { requests: 1_500, complexity: 1 }), BudgetBlockedError);
    // A second governor (another harness process) sees the same reservation.
    const other = new Governor({ apps: [fakeApp('one', [full({ requestsRemaining: 2_200 })])], stateDir: governorDir, maxWaitMs: 0, sleep: async () => {} });
    await assert.rejects(other.admit(byId('L2-01'), 'ddddd3', { requests: 1_500, complexity: 1 }), BudgetBlockedError);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    (await other.admit(byId('L2-01'), 'ddddd2', { requests: 1_500, complexity: 1 })).release();
  });

  it('admits a scenario held back only by reservations as soon as they end, not at the window\'s reset', async () => {
    let now = 0;
    const slept: number[] = [];
    const stateDir = freshStateDir();
    const app = fakeApp('one', [full({ requestsRemaining: 2_200, resetAt: 3_600_000 })]);
    let first: Awaited<ReturnType<Governor['admit']>> | undefined;
    const governor = new Governor({
      apps: [app],
      stateDir,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
        first?.release();
        await new Promise((resolve) => setTimeout(resolve, 30)); // the ledger entry goes a moment after release
      },
    });
    first = await governor.admit(byId('L2-01'), 'eeeee1', { requests: 1_500, complexity: 1 });
    (await governor.admit(byId('L2-01'), 'eeeee2', { requests: 1_500, complexity: 1 })).release();
    assert.ok(slept.length > 0 && slept.every((ms) => ms < 60_000), `slept ${slept.join(', ')} ms`);
  });

  it('caps workers per app and spreads them over every app', async () => {
    const stateDir = freshStateDir();
    const apps = [fakeApp('one', [full()]), fakeApp('two', [full()])];
    const governor = new Governor({ apps, stateDir, maxWaitMs: 0, sleep: async () => {} });
    const grants = [];
    for (let i = 0; i < MAX_WORKERS_PER_APP * 2; i += 1) grants.push(await governor.admit(byId('L2-01'), `bbbbb${i}`, { requests: 1, complexity: 1 }));
    assert.equal(grants.filter((grant) => grant.app.name === 'one').length, MAX_WORKERS_PER_APP);
    assert.equal(grants.filter((grant) => grant.app.name === 'two').length, MAX_WORKERS_PER_APP);
    await assert.rejects(governor.admit(byId('L2-01'), 'bbbbbf', { requests: 1, complexity: 1 }), BudgetBlockedError);
    grants.forEach((grant) => grant.release());
  });

  it('runs one full slice at a time', async () => {
    const stateDir = freshStateDir();
    const governor = new Governor({ apps: [fakeApp('one', [full()])], stateDir, maxWaitMs: 0, sleep: async () => {} });
    const first = await governor.admit(byId('L1-16'), 'ccccc1', { requests: 1, complexity: 1 });
    await assert.rejects(governor.admit(byId('L1-16'), 'ccccc2', { requests: 1, complexity: 1 }));
    first.release();
    (await governor.admit(byId('L1-16'), 'ccccc2', { requests: 1, complexity: 1 })).release();
  });
});
