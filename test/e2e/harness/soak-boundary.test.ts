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
    const first = world.boundaries.filter((boundary) => boundary.hour === 1 && boundary.drainSyncs === 0);
    assert.equal(first.length, 1);
    assert.ok(first.every((boundary) => !boundary.settled && !boundary.final), 'the hour ends with edits still in the sync pull request');
    // The drain merged them, and the hour's verdict is the settled look after it.
    assert.ok(world.syncs.some((sync) => sync.phase === 'drain' && sync.merged), 'a drain run merged the checked head');
    const verdicts = world.boundaries.filter((boundary) => boundary.settled || boundary.final);
    assert.equal(verdicts.length, 2);
    // The first hour drains; the last edits come 15 minutes before the second hour ends, so its runs settle it.
    assert.ok(verdicts[0]!.settled && verdicts[0]!.drainSyncs >= 1 && verdicts[0]!.drainSyncs <= 3);
    assert.deepEqual([verdicts[1]!.settled, verdicts[1]!.drainSyncs, verdicts[1]!.final], [true, 0, true]);
    assert.equal(world.editsDuringDrain(), 0, 'no edit is made while a check drains');

    // Every edit survives on both sides, every scheduled edit is still made, and the drain runs count.
    assert.equal(result.lostEdits, 0);
    assert.equal(result.invariantChecks, 2);
    assert.ok(world.made.every((item) => world.linear.has(item) && world.tracked.has(item)));
    assert.deepEqual(result.edits, soakEditCounts(OPTIONS));
    const drained = verdicts.reduce((sum, boundary) => sum + boundary.drainSyncs, 0);
    assert.equal(result.drainSyncs, drained);
    // The drain runs are scheduled runs: the soak makes the schedule's 24 runs and no more.
    assert.equal(result.syncRuns, 24);
    assert.equal(result.scheduleDelays.length, result.syncRuns);
    // The wall clock does not move: the soak ends within the duration plus one interval.
    assert.ok(world.now() <= OPTIONS.durationMs + SCHEDULE, String(world.now()));
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
    assert.deepEqual(world.syncs.filter((sync) => sync.phase === 'drain').map((sync) => sync.at - HOUR), [SCHEDULE, 2 * SCHEDULE, 3 * SCHEDULE], 'drain runs are the scheduled runs');
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

  it('keeps every event at its wall-clock time and every run at the fixed hard end, and makes the drain\'s edits after the verdict', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const edits: number[] = [];
    const driver: SoakDriver = {
      ...world.driver,
      linearEdit: async (actor, path) => { edits.push(world.now()); return world.driver.linearEdit(actor, path); },
      gitEdit: async (paths) => { edits.push(world.now()); return world.driver.gitEdit(paths); },
    };
    const result = await soak(driver, OPTIONS);
    const firstHour = world.boundaries.filter((boundary) => boundary.hour === 1);
    const drained = firstHour.at(-1)?.drainSyncs ?? 0;
    assert.ok(drained >= 1);
    const end = OPTIONS.durationMs + SCHEDULE;
    assert.deepEqual(result.clock, { startedAt: 0, editsEndAt: OPTIONS.durationMs - 3 * SCHEDULE, expectedEndAt: OPTIONS.durationMs, hardEndAt: end });
    // Every run, drain runs included, starts at its own scheduled time and may take until the plain hard end.
    assert.deepEqual(world.syncs.map((sync) => [sync.at, sync.deadlineAt]), Array.from({ length: 24 }, (_, index) => [(index + 1) * SCHEDULE, end]));
    // The drain took the first hour's next scheduled runs; the next plain run keeps its own slot.
    assert.deepEqual(world.syncs.filter((sync) => sync.phase === 'drain').map((sync) => sync.at), Array.from({ length: drained }, (_, index) => HOUR + (index + 1) * SCHEDULE));
    // The edits whose time came during the drain are made after the verdict, and none comes in the quiet tail.
    const verdictAt = firstHour.at(-1)!.at;
    assert.ok(edits.some((at) => at === verdictAt), 'a deferred edit is made at the verdict');
    assert.ok(edits.every((at) => at < HOUR || at >= verdictAt));
    assert.ok(edits.every((at) => at < result.clock.editsEndAt));
    assert.deepEqual(result.edits, soakEditCounts(OPTIONS));
  });

  it('ends a day within 24 hours and one interval with zero, typical or the most hourly drains, and every edit and verdict', async () => {
    const day: SoakOptions = { ...OPTIONS, durationMs: 24 * HOUR, documents: new Map(Array.from({ length: 40 }, (_, index) => [`d${index}.md`, ['# D\n']])) };
    const counts = soakEditCounts(day);
    for (const needs of [() => 0, (hour: number) => hour % 3, () => 3]) {
      const world = pipeline({ checkDelayMs: 0 });
      // An hour settles after the drain runs it needs; the last check has no run left and is strict at once.
      const driver: SoakDriver = {
        ...world.driver,
        checkInvariants: async (boundary) => {
          await world.driver.checkInvariants(boundary);
          const settled = boundary.hour === 24 || boundary.drainSyncs >= needs(boundary.hour);
          return { lostEdits: settled ? 0 : 1, converged: settled };
        },
      };
      const result = await soak(driver, day);
      const expected = Array.from({ length: 23 }, (_, index) => needs(index + 1)).reduce((sum, count) => sum + count, 0);
      assert.equal(result.drainSyncs, expected);
      assert.equal(result.syncRuns, 288, 'drain runs are scheduled runs');
      assert.equal(result.invariantChecks, 24);
      assert.deepEqual(result.edits, counts, 'every scheduled edit is made');
      assert.deepEqual(world.boundaries.filter((boundary) => boundary.hour === 24).map((boundary) => [boundary.drainSyncs, boundary.final]), [[0, true]]);
      // The last run starts at 24 hours and ends a minute later: well within the hard end.
      assert.equal(world.syncs.at(-1)?.at, 24 * HOUR);
      assert.ok(world.now() <= result.clock.hardEndAt && result.clock.hardEndAt === 24 * HOUR + SCHEDULE, String(world.now()));
    }
  });

  it('refuses a drain of half a check interval or more, which could reach the quiet tail, before the first edit', async () => {
    const world = pipeline({ checkDelayMs: 0 });
    await assert.rejects(soak(world.driver, { ...OPTIONS, drainSyncs: 6 }), /takes half the 3600000 ms check interval or more/);
    assert.equal(world.made.length, 0);
    assert.throws(() => soakEditCounts({ ...OPTIONS, drainSyncs: 6 }), /takes half the 3600000 ms check interval or more/);
    // With a drain, the soak lasts whole check intervals, so its last check is at its end.
    await assert.rejects(soak(world.driver, { ...OPTIONS, durationMs: 2 * HOUR + SCHEDULE }), /lasts whole check intervals/);
    assert.equal(world.made.length, 0);
  });

  it('settles the last hour strictly at the longest drain, when the hour before it drains up to the quiet tail', async () => {
    // Five five-minute drain runs, and a 25-minute quiet tail. The checks pass 25 minutes after a push, so the first
    // hour drains to its fifth run and its held-back edits come just before the tail starts.
    const world = pipeline({ checkDelayMs: 25 * 60_000 });
    const result = await soak(world.driver, { ...OPTIONS, drainSyncs: 5 });
    const hours = (hour: number) => world.boundaries.filter((boundary) => boundary.hour === hour);
    assert.equal(hours(1).at(-1)?.drainSyncs, 5);
    assert.ok(hours(1).at(-1)?.settled);
    assert.deepEqual(hours(2).map((boundary) => [boundary.settled, boundary.drainSyncs, boundary.final]), [[true, 0, true]]);
    assert.deepEqual([result.lostEdits, result.syncRuns, result.clock.editsEndAt], [0, 24, OPTIONS.durationMs - 5 * SCHEDULE]);
    assert.deepEqual(result.edits, soakEditCounts({ ...OPTIONS, drainSyncs: 5 }));
  });

  it('keeps the hour\'s evidence when the soak is past its hard end at a drain slot, and stops as blocked', async () => {
    // The checks never pass and the first hour's look itself takes until past the hard end.
    const world = pipeline({ checkDelayMs: Number.POSITIVE_INFINITY });
    const driver: SoakDriver = {
      ...world.driver,
      checkInvariants: async (boundary) => {
        const check = await world.driver.checkInvariants(boundary);
        if (boundary.hour === 1 && boundary.drainSyncs === 0 && !boundary.final) await world.driver.sleep(OPTIONS.durationMs);
        return check;
      },
    };
    await assert.rejects(soak(driver, OPTIONS), (error: unknown) => error instanceof EnvBlockedError && /wall-clock duration/.test(error.message));
    assert.deepEqual(world.boundaries.map((boundary) => [boundary.hour, boundary.drainSyncs, boundary.final]), [[1, 0, false], [1, 0, true]], 'a final look keeps the evidence');
    assert.equal(world.syncs.filter((sync) => sync.phase === 'drain').length, 0, 'no run starts past the hard end');
  });

  it('fails as blocked when runs fall behind the fixed wall clock', async () => {
    // Runs take two schedule intervals, so the soak falls behind its schedule and past its hard end.
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

/**
 * Sync runs that fail as the workflow does on a GitHub server error in the pull request step: `before` the step did
 * anything (the run only takes its time), or `after` GitHub applied it (the merge happened, the answer was an error).
 * `fatal` fails without the recoverable classification. Runs are counted from 1, drain runs included.
 */
type Interruption = 'before' | 'after' | 'fatal';
function interrupting(world: ReturnType<typeof pipeline>, plan: (run: number, phase: 'drain' | undefined) => Interruption | undefined) {
  let runs = 0;
  const failures: Array<{ run: number; error: ProductError }> = [];
  const sync: SoakDriver['sync'] = async (deadlineAt, phase) => {
    runs += 1;
    const how = plan(runs, phase);
    if (how === undefined) return world.driver.sync(deadlineAt, phase);
    const startedAt = world.now();
    if (how === 'before') await world.driver.sleep(60_000);
    else await world.driver.sync(deadlineAt, phase);
    const error = new ProductError(`scheduled soak workflow ${runs} failed (exit 1)`);
    failures.push({ run: runs, error });
    return { completed: true, startedAt, error, ...(how === 'fatal' ? {} : { recoverable: `GitHub HTTP 500 in workflow ${runs}` }) };
  };
  return { driver: { ...world.driver, sync } satisfies SoakDriver, failures, runs: () => runs };
}

const TOLERANT: SoakOptions = { ...OPTIONS, serverErrors: { ticks: 2, total: 3 } };

describe('soak recovery from GitHub server errors', () => {
  it('lets the next scheduled run recover a server error, before or after GitHub applied the step, with no run added', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const failing = interrupting(world, (run) => (run === 3 ? 'after' : run === 10 ? 'before' : undefined));
    const result = await soak(failing.driver, TOLERANT);
    assert.deepEqual(failing.failures.map((failure) => failure.run), [3, 10]);
    assert.deepEqual(result.serverErrors, { tolerated: 2, recovered: 2 });
    assert.equal(result.lostEdits, 0);
    assert.ok(world.made.every((item) => world.linear.has(item) && world.tracked.has(item)), 'every edit reached both sides');
    assert.deepEqual(result.edits, soakEditCounts(OPTIONS));
    // The failed runs kept their slots: every run is a scheduled run (drain runs included), and all of them count.
    assert.equal(failing.runs(), 24);
    assert.equal(result.syncRuns, failing.runs());
  });

  it('keeps an hour\'s drain going after a drain run with a server error, and its verdict stays strict', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const failing = interrupting(world, (_, phase) => (phase === 'drain' && world.boundaries.length === 1 ? 'before' : undefined));
    const result = await soak(failing.driver, TOLERANT);
    assert.deepEqual(result.serverErrors, { tolerated: 1, recovered: 1 });
    const firstHour = world.boundaries.filter((boundary) => boundary.hour === 1);
    assert.ok(firstHour.length >= 3, 'the hour looked again after the interrupted drain run');
    assert.ok(firstHour.at(-1)?.settled, 'the hour settled on a later drain run');
    assert.equal(result.lostEdits, 0);
  });

  it('stops on the third server error in a row, with the run\'s own failure', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const failing = interrupting(world, (run) => (run >= 5 && run <= 7 ? 'before' : undefined));
    const saved: Array<{ tolerated: number; recovered: number }> = [];
    const error = await soak({ ...failing.driver, progress: async (result) => void saved.push({ ...result.serverErrors }) }, TOLERANT).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof ProductError, String(error));
    assert.equal(error.message, 'scheduled soak workflow 7 failed (exit 1); not recovered: 3 runs in a row failed on a server error (bound 2)');
    assert.equal(failing.runs(), 7, 'no run after the stop');
    assert.deepEqual(saved.at(-1), { tolerated: 2, recovered: 0 });
  });

  it('does not count a run that succeeded with its pull request step still failing as a recovery', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    // Runs 5 and 7 fail on a server error; run 6 succeeds as a workflow, but its pull request step still failed.
    const failing = interrupting(world, (run) => (run === 5 || run === 7 ? 'before' : undefined));
    let runs = 0;
    const driver: SoakDriver = {
      ...failing.driver,
      sync: async (deadlineAt, phase) => {
        runs += 1;
        const outcome = await failing.driver.sync(deadlineAt, phase);
        return runs === 6 ? { completed: true, startedAt: world.now(), recovers: false } : outcome;
      },
    };
    const error = await soak(driver, { ...TOLERANT, serverErrors: { ticks: 1, total: 3 } }).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof ProductError, String(error));
    assert.equal(error.message, 'scheduled soak workflow 7 failed (exit 1); not recovered: 2 runs in a row failed on a server error (bound 1)');
  });

  it('stops on the fourth server error in the soak, even when each one before it recovered', async () => {
    const world = pipeline({ checkDelayMs: 120_000 });
    const failing = interrupting(world, (run) => ([3, 9, 15, 21].includes(run) ? 'after' : undefined));
    const error = await soak(failing.driver, TOLERANT).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof ProductError, String(error));
    assert.equal(error.message, 'scheduled soak workflow 21 failed (exit 1); not recovered: 4 runs failed on a server error in this soak (bound 3)');
  });

  it('stops when the soak ends before a later run recovers a server error', async () => {
    const world = pipeline({ checkDelayMs: 0 });
    const failing = interrupting(world, (run) => (run === 24 ? 'after' : undefined));
    // Settled sides at every check: only the unrecovered run can stop this soak.
    const driver: SoakDriver = { ...failing.driver, checkInvariants: async () => ({ lostEdits: 0, converged: true }) };
    await assert.rejects(soak(driver, { ...TOLERANT, drainSyncs: 0 }), (error: unknown) => {
      assert.ok(error instanceof ProductError);
      assert.equal(error.message, 'soak ended before a later run recovered 1 failed run(s): GitHub HTTP 500 in workflow 24');
      return true;
    });
  });

  it('stops on the first failed run in strict mode, the default, and on any failure not classified as recoverable', async () => {
    for (const [options, how] of [[OPTIONS, 'after'], [{ ...OPTIONS, serverErrors: { ticks: 0, total: 3 } }, 'after'], [TOLERANT, 'fatal']] as const) {
      const world = pipeline({ checkDelayMs: 120_000 });
      const failing = interrupting(world, (run) => (run === 3 ? how : undefined));
      await assert.rejects(soak(failing.driver, options), (error) => error === failing.failures[0]?.error);
      assert.equal(failing.runs(), 3);
    }
  });

  it('names the drain runs that failed on a server error when the hour\'s strict verdict fails', async () => {
    const world = pipeline({ checkDelayMs: Number.POSITIVE_INFINITY });
    let drains = 0;
    const failing = interrupting(world, (_, phase) => (phase === 'drain' && (drains += 1) <= 2 ? 'before' : undefined));
    await assert.rejects(soak(failing.driver, TOLERANT), (error: unknown) => {
      assert.ok(error instanceof ProductError);
      assert.match(error.message, /^soak stopped at hour 1: I1=false, \d+ edits lost \(\d+ retained pending, 0 absent everywhere\) after 3 of 3 drain syncs, 2 of them failed on a server error$/);
      return true;
    });
  });

  it('still stops on a lost edit with server errors tolerated', async () => {
    const world = pipeline({ checkDelayMs: 120_000, destroys: 'abcdef-002' });
    const failing = interrupting(world, (run) => (run === 3 ? 'after' : undefined));
    await assert.rejects(soak(failing.driver, TOLERANT), /^ProductError: soak stopped at hour 1: I1=false, 1 edits lost \(0 retained pending, 1 absent everywhere\) after 3 of 3 drain syncs$/);
  });

  it('refuses server error bounds that are not nonnegative whole numbers before the first edit', async () => {
    for (const serverErrors of [{ ticks: -1, total: 3 }, { ticks: 2, total: 1.5 }]) {
      const world = pipeline({ checkDelayMs: 0 });
      await assert.rejects(soak(world.driver, { ...OPTIONS, serverErrors }), /server error bounds must be nonnegative whole numbers/);
      assert.equal(world.made.length, 0);
    }
  });
});
