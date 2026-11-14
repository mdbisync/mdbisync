// Load scenarios: a burst of edits while the sync runs (L4-12) and the
// soak (L4-13). The loops are written against a driver, so the
// timing logic is tested with fakes and the live run plugs in real edits
// and engine runs.

import { setTimeout as delay } from 'node:timers/promises';
import { CONTENT_LIMIT } from '../../../src/format/rules.ts';
import { paragraphEdit } from './fixtures.ts';
import { MARKERS } from './conflicts.ts';
import { Rng } from '../../corpus/rng.ts';
import { ProductError, EnvBlockedError } from './results.ts';
import { soakDrainPlan } from './soak-drain.ts';

export type Actor = 'editor-a' | 'editor-b' | 'git';

export interface SyncOutcome {
  completed: boolean;
  startedAt?: number | undefined;
  error?: unknown;
  /**
   * With `error`: the run failed only on a GitHub server error that the next scheduled run may recover from, in one
   * line. The soak tolerates it within its `serverErrors` bound; otherwise `error` stops the soak as usual.
   */
  recoverable?: string;
  /**
   * Without `error`: false when the run succeeded but does not show that the step a tolerated interruption failed
   * in works again, so it recovers nothing. True when absent.
   */
  recovers?: boolean;
}

export interface LoadDriver {
  /** One Linear edit by an editor on a document. */
  linearEdit(actor: 'editor-a' | 'editor-b', path: string): Promise<void>;
  /** One git push that edits these documents. */
  gitEdit(paths: readonly string[]): Promise<void>;
  /** One sync run; resolves when it ends, optionally with the actual runner start time. */
  sync(deadlineAt?: number): Promise<void | number | SyncOutcome>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock = { now: () => Date.now(), sleep: (ms: number) => delay(Math.max(0, ms)) };

export interface BurstOptions {
  durationMs: number;
  linearEditsPerMinute: number;
  gitPushesPerMinute: number;
  documents: readonly string[];
}

/** Used by the scheduler, content budget and token-width bound. */
export function burstEditCounts(options: Omit<BurstOptions, 'documents'>): { linear: number; git: number } {
  const count = (rate: number) => Math.ceil(Math.max(0, rate) * options.durationMs / 60_000);
  if (![options.durationMs, options.linearEditsPerMinute, options.gitPushesPerMinute].every(Number.isFinite) || options.durationMs < 0) {
    throw new Error('burst duration and edit rates must be finite numbers, with a nonnegative duration');
  }
  return { linear: count(options.linearEditsPerMinute), git: count(options.gitPushesPerMinute) };
}

/**
 * How many appended edits a document takes within Linear's content limit: every edit appends a
 * note, and a conflict can hold both versions plus a marker set per edit. Tokens no wider than
 * `lastToken` keep the bound. Zero for a document with no versions.
 */
export function editCapacity(versions: readonly string[], lastToken: string): number {
  if (versions.length === 0) return 0;
  const perEdit = 2 * paragraphEdit('', undefined, lastToken).length + `${MARKERS.git}\n\n${MARKERS.linear}\n\n${MARKERS.end}\n\n`.length;
  const longest = Math.max(...versions.map((text) => text.length));
  return Math.max(0, Math.floor((CONTENT_LIMIT - 2 * longest) / perEdit));
}

/** Reserve all appends, duplicated conflict versions, and a marker set per edit on every candidate. */
export function burstDocuments(
  documents: ReadonlyMap<string, readonly string[]>,
  options: Omit<BurstOptions, 'documents'>,
  lastToken: string,
): string[] {
  const counts = burstEditCounts(options);
  const edits = counts.linear + counts.git;
  const paths = [...documents].filter(([, versions]) => editCapacity(versions, lastToken) >= edits).map(([path]) => path);
  if (paths.length === 0) throw new Error('no document has room for the burst edits');
  return paths;
}

export interface BurstResult {
  linearEdits: number;
  gitPushes: number;
  syncRuns: number;
}

/**
 * Edits on a fixed schedule for the duration (Linear edits alternate between
 * the two editors and walk the documents; each git push edits the next
 * document) while sync runs back to back; it ends with the last sync run.
 */
export async function burst(driver: LoadDriver, options: BurstOptions): Promise<BurstResult> {
  if (options.documents.length === 0) throw new Error('a burst needs documents to edit');
  const counts = burstEditCounts(options);
  const start = driver.now();
  const end = start + options.durationMs;
  const result: BurstResult = { linearEdits: 0, gitPushes: 0, syncRuns: 0 };
  let failed: unknown;
  const scheduled = async (perMinute: number, count: number, act: (index: number) => Promise<void>) => {
    if (perMinute <= 0) return;
    const interval = 60_000 / perMinute;
    for (let index = 0; index < count && failed === undefined; index += 1) {
      await driver.sleep(start + index * interval - driver.now());
      await act(index);
    }
  };
  const guard = (work: Promise<void>) => work.catch((error: unknown) => void (failed ??= error));
  const syncing = guard((async () => {
    while (driver.now() < end && failed === undefined) {
      await driver.sync();
      result.syncRuns += 1;
      // Leave a breath between runs, as a schedule would.
      if (driver.now() < end) await driver.sleep(1_000);
    }
  })());
  await Promise.all([
    guard(scheduled(options.linearEditsPerMinute, counts.linear, async (index) => {
      await driver.linearEdit(index % 2 === 0 ? 'editor-a' : 'editor-b', options.documents[index % options.documents.length] as string);
      result.linearEdits += 1;
    })),
    guard(scheduled(options.gitPushesPerMinute, counts.git, async (index) => {
      await driver.gitEdit([options.documents[(index * 7 + 3) % options.documents.length] as string]);
      result.gitPushes += 1;
    })),
    syncing,
  ]);
  if (failed !== undefined) throw failed;
  return result;
}

export interface SoakOptions {
  durationMs: number;
  /** How often the sync runs (the workflow's schedule). */
  scheduleMs: number;
  invariantIntervalMs: number;
  actors: readonly Actor[];
  seed: string;
  /** Each document the soak may edit, with its versions on both sides (`editCapacity`). */
  documents: ReadonlyMap<string, readonly string[]>;
  /** The widest token the scheduled edits can write, from each actor's edit count. */
  lastToken: (edits: Record<Actor, number>) => string;
  /**
   * The most scheduled sync runs an hourly check may wait for before its strict verdict (default 0: the check is
   * strict at once). See `soak`.
   */
  drainSyncs?: number;
  /**
   * How many failed runs the soak lets later scheduled runs recover from (`SyncOutcome.recoverable`): at most `ticks`
   * in a row and `total` in all. Default 0 and 0: any failed run stops the soak.
   */
  serverErrors?: { ticks: number; total: number };
}

/**
 * Where an hourly check stands, and how far its drain went. A look whose sides have settled (I1 holds and no edit
 * is lost) is always the hour's verdict. A look that finds them apart is the verdict only when it is `final`:
 * then the driver keeps the evidence of the failure. Otherwise another drain run follows.
 */
export interface SoakBoundary {
  /** 1 for the soak's first hourly check. */
  hour: number;
  /** The drain runs that completed for this check so far. */
  drainSyncs: number;
  /** No drain run follows: the drain is used up, no scheduled run is left, or a drain run failed. */
  final: boolean;
}

export interface SoakCheck {
  lostEdits: number;
  converged?: boolean;
  /**
   * Of the lost edits: those whose token is still on some side or sync lane, those found nowhere, those whose
   * sync lanes could not be read (not on either side, but maybe pending), and those an earlier step made
   * (outside the soak's ledger).
   */
  retained?: number;
  absent?: number;
  unknown?: number;
  unledgered?: number;
}

export interface SoakDriver extends LoadDriver {
  /** Checks I1 and I2 now; returns how many edits are lost. */
  checkInvariants(boundary: SoakBoundary): Promise<SoakCheck>;
  /** One sync run; a drain run of an hourly check says so. */
  sync(deadlineAt?: number, phase?: 'drain'): Promise<void | number | SyncOutcome>;
  /** Saves completed events, including the final hourly verdict, before the next wait. */
  progress?(result: SoakResult): Promise<void>;
}

/**
 * The soak's wall clock, in the driver's milliseconds. Everything happens at a fixed time from `startedAt`;
 * hourly drains never move it. Supervisors and reports read these bounds rather than deriving their own.
 */
export interface SoakClock {
  startedAt: number;
  /** No scheduled edit comes at or after this time: the last hour's drain runs follow it. */
  editsEndAt: number;
  /** The last scheduled sync run and the last hourly check: `startedAt` plus the duration. */
  expectedEndAt: number;
  /** The duration plus one schedule interval. No run may outlast it, and the soak fails as blocked past it. */
  hardEndAt: number;
}

export interface SoakResult {
  edits: Record<Actor, number>;
  syncRuns: number;
  invariantChecks: number;
  /** Edits lost at any hourly check (must stay zero). */
  lostEdits: number;
  /** The scheduled sync runs the hourly checks waited on as drain runs, already counted in `syncRuns` and `scheduleDelays`. */
  drainSyncs: number;
  /** How late each sync run started after its scheduled time, in ms. */
  scheduleDelays: number[];
  /**
   * Runs that failed on a recoverable server error and that the soak tolerated (already counted in `syncRuns`),
   * and how many of them a later clean run recovered.
   */
  serverErrors: { tolerated: number; recovered: number };
  clock: SoakClock;
}

type SoakScheduleOptions = Omit<SoakOptions, 'documents' | 'lastToken' | 'serverErrors'>;
const ACTORS: readonly Actor[] = ['editor-a', 'editor-b', 'git'];

type SoakEvent = { at: number; kind: 'edit'; actor: Actor } | { at: number; kind: 'sync' } | { at: number; kind: 'check' };

/** The seeded event times, from the soak's start; the same generator then picks each edit's document. */
function soakSchedule(options: SoakScheduleOptions): { events: SoakEvent[]; rng: Rng; drainLimit: number } {
  if (![options.durationMs, options.scheduleMs, options.invariantIntervalMs].every(Number.isFinite) || options.durationMs < 0 || options.scheduleMs <= 0 || options.invariantIntervalMs <= 0) {
    throw new Error('soak duration and intervals must be finite numbers, with a nonnegative duration and positive intervals');
  }
  const drainLimit = options.drainSyncs ?? 0;
  const { editsEndMs: editsEnd } = soakDrainPlan({ ...options, drainSyncs: drainLimit });
  const unknown = options.actors.filter((actor) => !ACTORS.includes(actor));
  if (unknown.length > 0) throw new Error(`unknown soak actors: ${unknown.join(', ')}`);
  const rng = new Rng(options.seed);
  const events: SoakEvent[] = [];
  for (const actor of options.actors) {
    for (let at = rng.int(0, options.scheduleMs * 2); at < editsEnd; at += rng.int(1, options.scheduleMs * 2)) events.push({ at, kind: 'edit', actor });
  }
  for (let at = options.scheduleMs; at <= options.durationMs; at += options.scheduleMs) events.push({ at, kind: 'sync' });
  for (let at = options.invariantIntervalMs; at <= options.durationMs; at += options.invariantIntervalMs) events.push({ at, kind: 'check' });
  // At one moment: edits first, then the sync, then the check.
  const order = { edit: 0, sync: 1, check: 2 };
  events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
  return { events, rng, drainLimit };
}

function editCounts(events: readonly SoakEvent[]): Record<Actor, number> {
  const counts: Record<Actor, number> = { 'editor-a': 0, 'editor-b': 0, git: 0 };
  for (const event of events) if (event.kind === 'edit') counts[event.actor] += 1;
  return counts;
}

/** How many edits each actor makes in the seeded schedule. */
export function soakEditCounts(options: SoakScheduleOptions): Record<Actor, number> {
  return editCounts(soakSchedule(options).events);
}

/**
 * The soak: each actor edits at random times (on average once per schedule
 * period), the sync runs on its schedule, and I1 and I2 are checked every
 * `invariantIntervalMs`. Each edit goes to a random document that still has
 * room for it (`editCapacity` at the schedule's widest token), and a soak
 * whose documents cannot take every scheduled edit fails before its first
 * edit. Random choices come from the seed, so a run can be repeated.
 *
 * The clock is the wall clock (`SoakClock`): every event keeps its time from
 * the start, the last sync run and check come at the duration, and the soak
 * ends within the duration plus one schedule interval. No run may outlast
 * that hard end; a soak still going past it fails as blocked.
 *
 * An hourly check reads the sides at a settled boundary. The sync merges a
 * waiting pull request only on a later run, once the checks of its head have
 * passed, so the hour's last edits may still be on their way. When a look
 * finds the sides apart, the soak makes no edit and waits for the next
 * scheduled sync runs, up to `drainSyncs` of them, looking again after each
 * run. These drain runs are the schedule's own runs, so a drain adds no run
 * and no time. The first look that finds the sides settled is the hour's
 * verdict; otherwise the look after the last drain run is, and the soak
 * fails: a drain that ends with an edit lost or the sides apart is a
 * failure, never a pass or a blocked environment. A drain run that fails
 * ends the soak with its own failure, after a final look that keeps the
 * hour's evidence. Edits whose time came during a drain are made right after
 * the verdict, in their order, so every scheduled edit is still made.
 *
 * The drain takes less than half a check interval, a soak with a drain lasts
 * whole check intervals, and the scheduled edits end `drainSyncs` schedule
 * intervals before the duration: the runs of that quiet tail take the place
 * of the last check's drain, so the last check is strict at once
 * (`soakDrainPlan`).
 *
 * A run that fails only on a recoverable server error (`SyncOutcome.recoverable`) keeps its slot and does not stop
 * the soak while `serverErrors` allows it: no run is added, and the next scheduled run, or the hour's next drain
 * run, is the recovery. A run that completes cleanly (`SyncOutcome.recovers`) recovers every interruption before it. One interruption past
 * either bound stops the soak with that run's failure, and so does an interruption no run recovered by the end.
 */
export async function soak(driver: SoakDriver, options: SoakOptions): Promise<SoakResult> {
  const tolerance = options.serverErrors ?? { ticks: 0, total: 0 };
  if (![tolerance.ticks, tolerance.total].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('soak server error bounds must be nonnegative whole numbers');
  const { events, rng, drainLimit } = soakSchedule(options);
  const counts = editCounts(events);
  const lastToken = options.lastToken(counts);
  const remaining = new Map([...options.documents].map(([path, versions]) => [path, editCapacity(versions, lastToken)] as const).filter(([, capacity]) => capacity > 0));
  const edits = counts['editor-a'] + counts['editor-b'] + counts.git;
  const room = [...remaining.values()].reduce((sum, capacity) => sum + capacity, 0);
  if (room < edits) throw new Error(`the documents have room for ${room} of the ${edits} soak edits`);
  const start = driver.now();
  const clock: SoakClock = {
    startedAt: start,
    editsEndAt: start + soakDrainPlan({ ...options, drainSyncs: drainLimit }).editsEndMs,
    expectedEndAt: start + options.durationMs,
    hardEndAt: start + options.durationMs + options.scheduleMs,
  };
  const result: SoakResult = { edits: { 'editor-a': 0, 'editor-b': 0, git: 0 }, syncRuns: 0, invariantChecks: 0, lostEdits: 0, drainSyncs: 0, scheduleDelays: [], serverErrors: { tolerated: 0, recovered: 0 }, clock };
  // The tolerated interruptions no clean run has recovered yet, in order.
  let pending: string[] = [];
  const overrun = () => {
    if (driver.now() > clock.hardEndAt) throw new EnvBlockedError('soak exceeded its wall-clock duration plus one schedule interval');
  };
  const runSync = async (at: number, phase?: 'drain') => {
    const invoked = driver.now();
    const outcome = await driver.sync(clock.hardEndAt, phase);
    const completed = typeof outcome === 'object' ? outcome.completed : true;
    const started = typeof outcome === 'object' ? outcome.startedAt : outcome ?? invoked;
    if (completed) {
      if (started !== undefined) result.scheduleDelays.push(Math.max(0, started - at));
      result.syncRuns += 1;
      if (phase === 'drain') result.drainSyncs += 1;
    }
    if (typeof outcome === 'object' && outcome.error !== undefined) {
      const detail = outcome.recoverable;
      if (detail === undefined || !completed || tolerance.ticks === 0 || tolerance.total === 0) throw outcome.error;
      const exhausted = pending.length + 1 > tolerance.ticks
        ? `${pending.length + 1} runs in a row failed on a server error (bound ${tolerance.ticks})`
        : result.serverErrors.tolerated + 1 > tolerance.total
          ? `${result.serverErrors.tolerated + 1} runs failed on a server error in this soak (bound ${tolerance.total})`
          : undefined;
      if (exhausted !== undefined) throw new ProductError(`${errorMessage(outcome.error)}; not recovered: ${exhausted}`);
      pending.push(detail);
      result.serverErrors.tolerated += 1;
      return;
    }
    if (completed && pending.length > 0 && (typeof outcome !== 'object' || outcome.recovers !== false)) {
      result.serverErrors.recovered += pending.length;
      pending = [];
    }
  };
  const settled = (check: SoakCheck) => (check.converged ?? true) && check.lostEdits === 0;
  // The scheduled runs a drain took: the main loop skips them.
  const drainedSlots = new Set<number>();
  // The check of the hour whose event is `events[index]`; no edit is made until it has its verdict. The drain
  // runs are the next scheduled sync runs, each at its own time.
  const hourlyCheck = async (index: number): Promise<{ check: SoakCheck; drained: number; interrupted: number }> => {
    const hour = result.invariantChecks + 1;
    const slots: number[] = [];
    for (let next = index + 1; next < events.length && slots.length < drainLimit; next += 1) {
      const event = events[next] as SoakEvent;
      if (event.kind === 'check') break;
      if (event.kind === 'sync') slots.push(next);
    }
    const before = result.drainSyncs;
    const drained = () => result.drainSyncs - before;
    const toleratedBefore = result.serverErrors.tolerated;
    for (let attempts = 0; ; attempts += 1) {
      const final = attempts >= slots.length;
      const check = await driver.checkInvariants({ hour, drainSyncs: drained(), final });
      if (final || settled(check)) return { check, drained: drained(), interrupted: result.serverErrors.tolerated - toleratedBefore };
      const slot = slots[attempts] as number;
      const at = start + (events[slot] as SoakEvent).at;
      drainedSlots.add(slot);
      await driver.sleep(at - driver.now());
      try {
        overrun();
        await runSync(at, 'drain');
      } catch (error) {
        // The sides were apart at the last look: keep the hour's evidence before the failure (the run's, or the
        // overrun before it) ends the soak. That failure stays the soak's verdict, whatever this look finds.
        await driver.progress?.(result);
        await driver.checkInvariants({ hour, drainSyncs: drained(), final: true }).catch(() => undefined);
        throw error;
      }
      await driver.progress?.(result);
    }
  };
  await driver.progress?.(result);
  for (const [index, event] of events.entries()) {
    if (drainedSlots.has(index)) continue;
    const at = start + event.at;
    await driver.sleep(at - driver.now());
    overrun();
    let verdict: Awaited<ReturnType<typeof hourlyCheck>> | undefined;
    try {
      if (event.kind === 'edit') {
        const open = [...remaining.keys()];
        const path = open[rng.int(0, open.length - 1)] as string;
        const left = (remaining.get(path) as number) - 1;
        if (left === 0) remaining.delete(path);
        else remaining.set(path, left);
        if (event.actor === 'git') await driver.gitEdit([path]);
        else await driver.linearEdit(event.actor, path);
        result.edits[event.actor] += 1;
      } else if (event.kind === 'sync') {
        await runSync(at);
      } else {
        verdict = await hourlyCheck(index);
        result.invariantChecks += 1;
        result.lostEdits = Math.max(result.lostEdits, verdict.check.lostEdits);
      }
    } catch (error) {
      await driver.progress?.(result);
      throw error;
    }
    await driver.progress?.(result);
    if (verdict !== undefined && !settled(verdict.check)) {
      const { check, drained, interrupted } = verdict;
      const optional = (count: number | undefined, label: string) => (count === undefined || count === 0 ? '' : `, ${count} ${label}`);
      const presence = check.retained === undefined && check.absent === undefined
        ? ''
        : ` (${check.retained ?? 0} retained pending, ${check.absent ?? 0} absent everywhere${optional(check.unknown, 'with unread sync lanes')}${optional(check.unledgered, 'outside the soak ledger')})`;
      throw new ProductError(`soak stopped at hour ${result.invariantChecks}: I1=${String(check.converged ?? true)}, ${check.lostEdits} edits lost${presence} after ${drained} of ${drainLimit} drain syncs${interrupted === 0 ? '' : `, ${interrupted} of them failed on a server error`}`);
    }
    overrun();
  }
  if (pending.length > 0) throw new ProductError(`soak ended before a later run recovered ${pending.length} failed run(s): ${pending.join('; ')}`);
  return result;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
