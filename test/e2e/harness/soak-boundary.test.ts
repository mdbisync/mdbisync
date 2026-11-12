// The soak's hourly observation boundary, against a model of the sync's
// pipeline with delayed checks: a capture opens or moves the sync pull
// request's head, the checks of a head pass some time after the run that
// pushed it, and only a later run that finds the same head passed merges it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { soak, soakEditCounts, type Actor, type SoakBoundary, type SoakCheck, type SoakDriver, type SoakOptions } from './load.ts';
import { EnvBlockedError, ProductError } from './results.ts';

const SCHEDULE = 300_000;
const HOUR = 3_600_000;

interface PipelineOptions {
  /** How long after a run pushes a head its checks pass; Infinity for checks that never finish. */
  checkDelayMs: number;
  /** How long a sync run takes. */
  runMs?: number;
  /** A token the sync drops from Linear, the sync branch and the tracked branch, once it has been written. */
  destroys?: string;
}

/** The sync's pipeline with delayed checks, and a soak driver over it. */
function pipeline(options: PipelineOptions) {
  let now = 0;
  const made: string[] = [];
  const linear = new Set<string>();
  const tracked = new Set<string>();
  let pr: { tokens: Set<string>; checkPassesAt: number } | null = null;
  const boundaries: Array<SoakBoundary & { settled: boolean; at: number }> = [];
  const syncs: Array<{ at: number; deadlineAt: number | undefined; phase: 'drain' | undefined; merged: boolean }> = [];
  let editsDuringDrain = 0;
  let draining = false;
  const token = () => {
    const next = `abcdef-${String(made.length + 1).padStart(3, '0')}`;
    made.push(next);
    return next;
  };
  const destroy = () => {
    if (options.destroys === undefined) return;
    linear.delete(options.destroys);
    tracked.delete(options.destroys);
    pr?.tokens.delete(options.destroys);
  };
  const driver: SoakDriver = {
    now: () => now,
    sleep: async (ms) => void (now += Math.max(0, ms)),
    linearEdit: async () => {
      if (draining) editsDuringDrain += 1;
      linear.add(token());
    },
    gitEdit: async () => {
      if (draining) editsDuringDrain += 1;
      tracked.add(token());
    },
    sync: async (deadlineAt, phase) => {
      const at = now;
      // Capture first: new Linear changes move the sync head, whose checks start over.
      const captured = [...linear].filter((item) => !tracked.has(item) && !(pr?.tokens.has(item) ?? false));
      let merged = false;
      if (captured.length > 0) {
        pr = { tokens: new Set([...(pr?.tokens ?? []), ...captured]), checkPassesAt: at + options.checkDelayMs };
      } else if (pr !== null && at >= pr.checkPassesAt) {
        for (const item of pr.tokens) tracked.add(item);
        pr = null;
        merged = true;
      }
      // The tracked branch to Linear.
      for (const item of tracked) linear.add(item);
      destroy();
      now += options.runMs ?? 60_000;
      syncs.push({ at, deadlineAt, phase, merged });
    },
    checkInvariants: async (boundary): Promise<SoakCheck> => {
      const lost = made.filter((item) => !(linear.has(item) && tracked.has(item)));
      const retained = lost.filter((item) => linear.has(item) || tracked.has(item) || (pr?.tokens.has(item) ?? false)).length;
      const settled = lost.length === 0;
      boundaries.push({ ...boundary, settled, at: now });
      draining = !settled && !boundary.final;
      return { lostEdits: lost.length, converged: settled, ...(settled ? {} : { retained, absent: lost.length - retained }) };
    },
  };
  return { driver, made, linear, tracked, boundaries, syncs, now: () => now, pr: () => pr, editsDuringDrain: () => editsDuringDrain };
}

const OPTIONS: SoakOptions = {
  durationMs: 2 * HOUR,
  scheduleMs: SCHEDULE,
  invariantIntervalMs: HOUR,
  actors: ['editor-a', 'editor-b', 'git'] as readonly Actor[],
  seed: 'boundary-7',
  documents: new Map([['a.md', ['# A\n']], ['b.md', ['# B\n']], ['c.md', ['# C\n']], ['d.md', ['# D\n']]]),
  lastToken: () => 'abcdef-999',
  drainSyncs: 3,
};

describe('soak hourly boundary', () => {
  it('lets a retained edit awaiting a passing check merge before the strict hourly verdict', async () => {
    // The checks pass after the run that pushed the head has ended, but before the next run.
    const world = pipeline({ checkDelayMs: 120_000 });
    const result = await soak(world.driver, OPTIONS);

    // Each hour's first look found edits retained but not yet on the tracked branch.
    const first = world.boundaries.filter((boundary) => boundary.drainSyncs === 0);
    assert.equal(first.length, 2);
    assert.ok(first.every((boundary) => !boundary.settled && !boundary.final), 'the hour ends with edits still in the sync pull request');
    // The drain merged them, and the hour's verdict is the settled look after it.
    assert.ok(world.syncs.some((sync) => sync.phase === 'drain' && sync.merged), 'a drain run merged the checked head');
    const verdicts = world.boundaries.filter((boundary) => boundary.settled || boundary.final);
    assert.equal(verdicts.length, 2);
    assert.ok(verdicts.every((boundary) => boundary.settled && boundary.drainSyncs >= 1 && boundary.drainSyncs <= 3));
    assert.equal(world.editsDuringDrain(), 0, 'no edit is made while a check drains');

    // Every edit survives on both sides, every scheduled edit is still made, and the drain runs count.
    assert.equal(result.lostEdits, 0);
    assert.equal(result.invariantChecks, 2);
    assert.ok(world.made.every((item) => world.linear.has(item) && world.tracked.has(item)));
    assert.deepEqual(result.edits, soakEditCounts(OPTIONS));
    const drained = verdicts.reduce((sum, boundary) => sum + boundary.drainSyncs, 0);
    assert.equal(result.drainSyncs, drained);
    assert.equal(result.syncRuns, 24 + drained);
    assert.equal(result.scheduleDelays.length, result.syncRuns);
    // The drain moves the rest of the schedule, so the wall clock stays within the duration, one interval and the drains.
    assert.ok(world.now() <= OPTIONS.durationMs + SCHEDULE + drained * SCHEDULE, String(world.now()));
  });

  it('fails without a drain, as before, when the hour ends with edits pending', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    await assert.rejects(soak(world.driver, { ...OPTIONS, drainSyncs: 0 }), (error: unknown) => {
      assert.ok(error instanceof ProductError);
      assert.match(error.message, /^soak stopped at hour 1: I1=false, \d+ edits lost \(\d+ retained pending, 0 absent everywhere\) after 0 of 0 drain syncs$/);
      return true;
    });
    assert.deepEqual(world.boundaries.map((boundary) => [boundary.drainSyncs, boundary.final]), [[0, true]]);
  });

  it('fails a stuck pipeline after its bounded drain, with the strict verdict last and no further edits', async () => {
    const world = pipeline({ checkDelayMs: Number.POSITIVE_INFINITY });
    const saved: number[] = [];
    let editsAtCheck = -1;
    const driver: SoakDriver = {
      ...world.driver,
      checkInvariants: async (boundary) => {
        if (boundary.drainSyncs === 0) editsAtCheck = world.made.length;
        return world.driver.checkInvariants(boundary);
      },
      progress: async (result) => void saved.push(result.drainSyncs),
    };
    const error = await soak(driver, OPTIONS).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof ProductError, String(error));
    assert.ok(!(error instanceof EnvBlockedError));
    assert.match(error.message, /^soak stopped at hour 1: I1=false, \d+ edits lost \((\d+) retained pending, 0 absent everywhere\) after 3 of 3 drain syncs$/);
    // Looks before each of the three drain runs, then the final, strict look.
    assert.deepEqual(world.boundaries.map((boundary) => [boundary.hour, boundary.drainSyncs, boundary.final]), [[1, 0, false], [1, 1, false], [1, 2, false], [1, 3, true]]);
    assert.deepEqual(world.syncs.filter((sync) => sync.phase === 'drain').map((sync) => sync.at - HOUR), [SCHEDULE, 2 * SCHEDULE, 3 * SCHEDULE], 'drain runs keep the schedule');
    assert.equal(world.made.length, editsAtCheck, 'no edit after the hour');
    assert.equal(world.pr()?.tokens.size, Number(/\((\d+) retained/.exec(error.message)?.[1]));
    assert.equal(saved.at(-1), 3, 'the drain runs are saved before the stop');
  });

  it('fails a destroyed token as absent everywhere, even when the rest of the drain settles', async () => {
    const world = pipeline({ checkDelayMs: 120_000, destroys: 'abcdef-002' });
    await assert.rejects(soak(world.driver, OPTIONS), (error: unknown) => {
      assert.ok(error instanceof ProductError);
      assert.match(error.message, /^soak stopped at hour 1: I1=false, 1 edits lost \(0 retained pending, 1 absent everywhere\) after 3 of 3 drain syncs$/);
      return true;
    });
    assert.ok(world.made.includes('abcdef-002'));
    assert.ok(!world.linear.has('abcdef-002') && !world.tracked.has('abcdef-002'));
  });

  it('refuses a drain limit that is not a nonnegative whole number before the first edit', async () => {
    for (const drainSyncs of [-1, 1.5, Number.NaN]) {
      const world = pipeline({ checkDelayMs: 0 });
      await assert.rejects(soak(world.driver, { ...OPTIONS, drainSyncs }), /drain syncs must be a nonnegative whole number/);
      assert.equal(world.made.length, 0);
    }
  });

  it('moves the rest of the schedule and its hard end by the drain, and gives drain runs the whole drain', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    await soak(world.driver, OPTIONS);
    const firstHour = world.boundaries.filter((boundary) => boundary.hour === 1);
    const drained = firstHour.at(-1)?.drainSyncs ?? 0;
    assert.ok(drained >= 1);
    const end = OPTIONS.durationMs + SCHEDULE;
    // Before the first drain: the scheduled runs' deadline is the plain hard end.
    const before = world.syncs.filter((sync) => sync.phase === undefined && sync.at < HOUR);
    assert.ok(before.length > 0 && before.every((sync) => sync.deadlineAt === end));
    // A drain run may take until the hard end grown by the whole drain allowance.
    const drains = world.syncs.filter((sync) => sync.phase === 'drain' && sync.at < 2 * HOUR);
    assert.deepEqual(drains.slice(0, drained).map((sync) => [sync.at, sync.deadlineAt]), Array.from({ length: drained }, (_, index) => [HOUR + (index + 1) * SCHEDULE, end + 3 * SCHEDULE]));
    // The next scheduled run comes one interval after the last drain slot, with the hard end moved by the drain.
    const next = world.syncs.find((sync) => sync.phase === undefined && sync.at > HOUR);
    assert.deepEqual([next?.at, next?.deadlineAt], [HOUR + (drained + 1) * SCHEDULE, end + drained * SCHEDULE]);
  });

  it('keeps the hard end when runs fall behind the schedule moved by the drains', async () => {
    // Runs take two schedule intervals, so the soak falls behind its schedule: the overrun stop still applies.
    const world = pipeline({ checkDelayMs: 0, runMs: 2 * SCHEDULE });
    await assert.rejects(soak(world.driver, OPTIONS), EnvBlockedError);
  });

  it('keeps the hour\'s evidence when a drain run fails, and stops with the run\'s own failure', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const failure = new EnvBlockedError('runner logs unavailable');
    const driver: SoakDriver = { ...world.driver, sync: async (deadlineAt, phase) => (phase === 'drain' ? { completed: true, startedAt: world.now(), error: failure } : world.driver.sync(deadlineAt, phase)) };
    await assert.rejects(soak(driver, OPTIONS), (error) => error === failure);
    // The look before the failed run, then a final look that keeps the evidence; the failed run completed, so it counts.
    assert.deepEqual(world.boundaries.map((boundary) => [boundary.hour, boundary.drainSyncs, boundary.final]), [[1, 0, false], [1, 1, true]]);
  });

  it('counts only completed drain runs, while every started one takes its schedule slot', async () => {
    const world = pipeline({ checkDelayMs: Number.POSITIVE_INFINITY });
    const driver: SoakDriver = { ...world.driver, sync: async (deadlineAt, phase) => (phase === 'drain' ? { completed: false } : world.driver.sync(deadlineAt, phase)) };
    const error = await soak(driver, OPTIONS).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof ProductError, String(error));
    assert.match(error.message, /after 0 of 3 drain syncs$/);
    assert.deepEqual(world.boundaries.map((boundary) => [boundary.drainSyncs, boundary.final]), [[0, false], [0, false], [0, false], [0, true]]);
    assert.equal(world.now() >= HOUR + 3 * SCHEDULE, true, 'the three started runs took their slots');
  });
});
