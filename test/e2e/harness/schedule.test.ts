// The batch scheduler (schedule.ts) on a virtual clock: which scenario a free
// worker starts, and what it changes against workers that each take the next
// scenario in order and wait in admission for it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { BudgetBlockedError, Governor, MAX_BUDGET_WAIT_MS } from './governor.ts';
import { nextStartable, runScheduled, type Conflicts } from './schedule.ts';
import { parseSharedState, SharedAdmission, type SharedState, type StateStore } from './shared-state.ts';
import { loadScenarios, type Scenario } from './spec.ts';

const catalog = loadScenarios();
const byId = (id: string) => catalog.find((scenario) => scenario.id === id)!;
const governor = (shared: boolean) =>
  new Governor({ apps: [{ name: 'app', readBudget: async () => { throw new Error('not read'); } }], stateDir: '/nonexistent', ...(shared ? { shared: new SharedAdmission({} as StateStore) } : {}) });

/** A clock that moves only when every worker waits on it. */
class VirtualClock {
  now = 0;
  readonly #timers: Array<{ at: number; resolve: () => void }> = [];
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.#timers.push({ at: this.now + ms, resolve }));
  }
  async drive<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const result = work.finally(() => { done = true; });
    for (;;) {
      for (let i = 0; i < 20; i++) await flush();
      if (done) return result;
      this.#timers.sort((a, b) => a.at - b.at);
      const first = this.#timers[0];
      if (first === undefined) throw new Error('deadlock: nothing runs and the batch is not done');
      this.now = first.at;
      for (const timer of this.#timers.splice(0, this.#timers.filter((t) => t.at === first.at).length)) timer.resolve();
    }
  }
}

interface Trace {
  /** When the batch ended, minutes. */
  end: number;
  /** The most workers waiting in admission at once. */
  admissionWaiters: number;
  /** Per index: the wait in admission and the time from a worker taking it to its end, minutes. */
  waited: number[];
  reported: number[];
  /** Indices whose admission wait passed the governor's longest wait. */
  blocked: number[];
  /** The most scenarios running at once. */
  overlap: number;
}

type Run = (index: number) => Promise<'kept' | 'released'>;
type Model = (indices: readonly number[], workers: number, conflicts: Conflicts, run: Run, admitted: (index: number) => Promise<boolean>) => Promise<void>;

/** Before: each worker takes the next scenario in order and waits in admission until it may run. */
const inOrder: Model = async (indices, workers, conflicts, run, admitted) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, indices.length) }, async () => {
    for (let index = indices[next++]; index !== undefined; index = indices[next++]) {
      if (await admitted(index)) await run(index);
    }
  }));
};

/** Now: the scheduler in front of the same admission. */
const scheduled: Model = (indices, workers, conflicts, run, admitted) => runScheduled(indices, workers, conflicts, async (index) => (await admitted(index) ? run(index) : 'released'));

interface Options {
  workers?: number;
  shared?: boolean;
  /** Runs whose reservation outlives their result, with the minute it is recovered (Infinity: never). */
  kept?: ReadonlyMap<number, number>;
}

async function simulate(model: Model, scenarios: readonly Scenario[], minutes: readonly number[], options: Options = {}): Promise<Trace> {
  const clock = new VirtualClock();
  const gov = governor(options.shared ?? true);
  const conflicts: Conflicts = (a, b) => gov.conflicts(scenarios[a]!, scenarios[b]!);
  // Admission as the shared state grants it: a scenario waits while a conflicting one holds a reservation or
  // asked before it, and ends env-blocked after the governor's longest wait.
  const holding = new Set<number>();
  const queue: number[] = [];
  let wake: Array<() => void> = [];
  const changed = () => { const woken = wake; wake = []; woken.forEach((resolve) => resolve()); };
  const trace: Trace = { end: 0, admissionWaiters: 0, waited: [], reported: [], blocked: [], overlap: 0 };
  const taken: number[] = [];
  let waiters = 0;
  let running = 0;
  const admitted = async (index: number) => {
    taken[index] = clock.now;
    const deadline = clock.now + MAX_BUDGET_WAIT_MS / 60_000;
    queue.push(index);
    let waiting = false;
    const mayRun = () => queue.slice(0, queue.indexOf(index)).every((other) => !conflicts(index, other)) && [...holding].every((other) => !conflicts(index, other));
    while (!mayRun() && clock.now < deadline) {
      if (!waiting) trace.admissionWaiters = Math.max(trace.admissionWaiters, ++waiters);
      waiting = true;
      await Promise.race([new Promise<void>((resolve) => wake.push(resolve)), clock.sleep(deadline - clock.now)]);
    }
    if (waiting) waiters--;
    const may = mayRun();
    queue.splice(queue.indexOf(index), 1);
    trace.waited[index] = clock.now - taken[index]!;
    if (!may) {
      trace.blocked.push(index);
      trace.reported[index] = trace.waited[index]!;
      changed();
      return false;
    }
    holding.add(index);
    trace.overlap = Math.max(trace.overlap, ++running);
    return true;
  };
  const run: Run = async (index) => {
    await clock.sleep(minutes[index]!);
    running--;
    trace.reported[index] = clock.now - taken[index]!;
    const recovered = options.kept?.get(index);
    if (recovered === undefined) holding.delete(index);
    else if (Number.isFinite(recovered)) void clock.sleep(recovered - clock.now).then(() => { holding.delete(index); changed(); });
    changed();
    return recovered === undefined ? 'released' : 'kept';
  };
  await clock.drive(model(scenarios.map((_, index) => index), options.workers ?? 4, conflicts, run, admitted));
  trace.end = Math.max(...trace.reported.map((reported, index) => taken[index]! + reported));
  return trace;
}

describe('the next scenario a worker starts', () => {
  const conflicts: Conflicts = (a, b) => a < 10 && b < 10; // 0-9 exclusive, 10+ free

  it('takes the first pending scenario that conflicts with nothing running', () => {
    assert.equal(nextStartable([1, 2, 10], new Set(), conflicts), 1);
    assert.equal(nextStartable([1, 2, 10], new Set([0]), conflicts), 10);
    assert.equal(nextStartable([1, 2], new Set([0]), conflicts), undefined);
  });

  it('never lets a scenario overtake an earlier pending one it conflicts with', () => {
    const shared: Conflicts = (a, b) => a === 0 || b === 0; // 0 is exclusive, the rest share
    assert.equal(nextStartable([0, 1, 2], new Set([3]), shared), undefined, 'the exclusive one waits, and the shared ones behind it wait for it');
    assert.equal(nextStartable([4, 0, 1], new Set([3]), shared), 4, 'an earlier shared one still starts');
  });

  it('keeps every live scenario apart under shared admission except two zone-concurrent ones', () => {
    const shared = governor(true);
    const [offline, audited, exclusive, other] = [byId('L0-08'), byId('L1-05'), byId('L2-30'), byId('L4-04')];
    assert.equal(shared.conflicts(audited, structuredClone(audited)), false);
    assert.equal(shared.conflicts(audited, exclusive), true);
    assert.equal(shared.conflicts(exclusive, other), true);
    assert.equal(shared.conflicts(offline, exclusive), false);
    const local = governor(false);
    assert.equal(local.conflicts(exclusive, other), false, 'host-local admission runs mini slices side by side');
    assert.equal(local.conflicts(byId('L1-16'), structuredClone(byId('L1-16'))), true, 'and keeps full slices apart');
    assert.equal(local.conflicts(byId('L0-01'), structuredClone(byId('L0-01'))), false, 'an offline full slice is never admitted');
  });
});

describe('a batch on the default workers', () => {
  // The 11 ENG team-zone scenarios of run 2026-11-10-2c2f5a, two minutes each as there.
  const eng = ['L2-29', 'L2-30', 'L2-32', 'L2-33', 'L4-01', 'L4-03', 'L4-04', 'L4-05', 'L4-06', 'L4-07', 'L4-11'].map(byId);

  it('runs exclusive scenarios one at a time with no worker of the batch waiting in admission', async () => {
    const minutes = eng.map(() => 2);
    const before = await simulate(inOrder, eng, minutes);
    const after = await simulate(scheduled, eng, minutes);
    assert.equal(before.end, 22);
    assert.equal(after.end, 22, 'the exclusive slot still bounds the batch');
    assert.ok(before.admissionWaiters >= 3, 'the other workers polled the shared state and raced for it at each release');
    assert.equal(after.admissionWaiters, 0);
    assert.equal(Math.max(...before.reported), 8, 'a scenario reported up to three others\' time as its own');
    assert.deepEqual(after.reported, minutes);
    assert.equal(after.overlap, 1);
  });

  it('never ends a long exclusive scenario env-blocked for waiting behind its own batch', async () => {
    // Mid-slice scenarios of 25 minutes: the fourth worker waited 75 minutes, past the governor's 65.
    const mid = ['L1-07', 'L1-09', 'L1-10', 'L1-11'].map(byId);
    assert.ok(mid.every((scenario) => scenario.slice === 'mid'));
    const before = await simulate(inOrder, mid, [25, 25, 25, 25]);
    const after = await simulate(scheduled, mid, [25, 25, 25, 25]);
    assert.deepEqual(before.blocked, [3]);
    assert.deepEqual(after.blocked, []);
    assert.deepEqual(after.waited, [0, 0, 0, 0]);
  });

  it('runs offline and zone-concurrent scenarios while an exclusive one holds the slot', async () => {
    // Exclusive scenarios first, then the audited L1-05 and the offline L0 scenarios.
    const batch = ['L2-30', 'L2-32', 'L4-04', 'L1-05', 'L0-01', 'L0-02', 'L0-03', 'L0-08'].map(byId);
    const minutes = [10, 10, 10, 10, 35, 5, 5, 5];
    const before = await simulate(inOrder, batch, minutes);
    const after = await simulate(scheduled, batch, minutes);
    assert.equal(before.end, 45, 'the long offline fix started only when a worker held in admission was let through');
    assert.equal(after.end, 40, 'the four exclusive-lane scenarios still run one after another');
    assert.ok(after.overlap >= 3, 'offline scenarios run beside the exclusive one');
    assert.equal(after.admissionWaiters, 0);
    assert.deepEqual(after.reported, minutes);
  });

  it('lets the rest wait side by side when a run keeps the exclusive slot past its result', async () => {
    // A UI hold at the head of four exclusive scenarios that nobody recovers.
    const batch = ['L2-29', 'L2-30', 'L2-32', 'L4-04'].map(byId);
    const minutes = [5, 2, 2, 2];
    const kept = new Map([[0, Infinity]]);
    const before = await simulate(inOrder, batch, minutes, { kept });
    const after = await simulate(scheduled, batch, minutes, { kept });
    assert.deepEqual(before.blocked, [1, 2, 3]);
    assert.deepEqual(after.blocked, [1, 2, 3]);
    assert.ok(after.end <= 5 + 65, `the waits overlap, as before (ended at ${after.end} minutes)`);
    // Recovered after an hour: the waiters then run one after another.
    const recovered = await simulate(scheduled, batch, minutes, { kept: new Map([[0, 60]]) });
    assert.deepEqual(recovered.blocked, []);
    assert.equal(recovered.end, 66);
  });
});

describe('conflicts and shared admission', () => {
  class MemoryStore implements StateStore {
    state: SharedState = { version: 1, runs: [] };
    async read() { return structuredClone(this.state); }
    async update<T>(change: (state: SharedState) => T | Promise<T>) {
      const next = structuredClone(this.state);
      const result = await change(next);
      this.state = parseSharedState(JSON.stringify(next));
      return result;
    }
  }

  it('says two live scenarios conflict exactly when shared admission refuses the second while the first holds', async () => {
    const budget = { requestsRemaining: 5000, complexityRemaining: 2_000_000, resetAt: 0 };
    const live = [byId('L1-05'), byId('L2-30'), byId('L4-04'), byId('L1-16'), byId('L6-05')];
    for (const a of live) {
      for (const b of live) {
        const gov = new Governor({ apps: [{ name: 'app', readBudget: async () => budget }], stateDir: '/nonexistent', shared: new SharedAdmission(new MemoryStore()), maxWaitMs: 0, sleep: async () => {} });
        await gov.admit(a, 'aaaaaa', { requests: 1, complexity: 1 });
        const second = await gov.admit(structuredClone(b), 'bbbbbb', { requests: 1, complexity: 1 }).then(() => true, (error: unknown) => {
          if (error instanceof BudgetBlockedError) return false;
          throw error;
        });
        assert.equal(second, !gov.conflicts(a, b), `${a.id} then ${b.id}`);
      }
    }
  });
});
