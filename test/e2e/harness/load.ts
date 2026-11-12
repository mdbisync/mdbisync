// Load scenarios: a burst of edits while the sync runs (L4-12) and the
// 24-hour soak (L4-13). The loops are written against a driver, so the
// timing logic is tested with fakes and the live run plugs in real edits
// and engine runs.

import { setTimeout as delay } from 'node:timers/promises';
import { CONTENT_LIMIT } from '../../../src/format/rules.ts';
import { paragraphEdit } from './fixtures.ts';
import { MARKERS } from './conflicts.ts';
import { Rng } from '../../corpus/rng.ts';
import { ProductError, EnvBlockedError } from './results.ts';

export type Actor = 'editor-a' | 'editor-b' | 'git';

export interface LoadDriver {
  /** One Linear edit by an editor on a document. */
  linearEdit(actor: 'editor-a' | 'editor-b', path: string): Promise<void>;
  /** One git push that edits these documents. */
  gitEdit(paths: readonly string[]): Promise<void>;
  /** One sync run; resolves when it ends, optionally with the actual runner start time. */
  sync(): Promise<void | number>;
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
}

export interface SoakDriver extends LoadDriver {
  /** Checks I1 and I2 now; returns how many edits are lost. */
  checkInvariants(): Promise<{ lostEdits: number; converged?: boolean }>;
  /** Saves completed events, including the final hourly verdict, before the next wait. */
  progress?(result: SoakResult): Promise<void>;
}

export interface SoakResult {
  edits: Record<Actor, number>;
  syncRuns: number;
  invariantChecks: number;
  /** Edits lost at any hourly check (must stay zero). */
  lostEdits: number;
  /** How late each sync run started after its scheduled time, in ms. */
  scheduleDelays: number[];
}

type SoakScheduleOptions = Omit<SoakOptions, 'documents' | 'lastToken'>;
const ACTORS: readonly Actor[] = ['editor-a', 'editor-b', 'git'];

type SoakEvent = { at: number; kind: 'edit'; actor: Actor } | { at: number; kind: 'sync' } | { at: number; kind: 'check' };

/** The seeded event times, from the soak's start; the same generator then picks each edit's document. */
function soakSchedule(options: SoakScheduleOptions): { events: SoakEvent[]; rng: Rng } {
  if (![options.durationMs, options.scheduleMs, options.invariantIntervalMs].every(Number.isFinite) || options.durationMs < 0 || options.scheduleMs <= 0 || options.invariantIntervalMs <= 0) {
    throw new Error('soak duration and intervals must be finite numbers, with a nonnegative duration and positive intervals');
  }
  const unknown = options.actors.filter((actor) => !ACTORS.includes(actor));
  if (unknown.length > 0) throw new Error(`unknown soak actors: ${unknown.join(', ')}`);
  const rng = new Rng(options.seed);
  const events: SoakEvent[] = [];
  for (const actor of options.actors) {
    for (let at = rng.int(0, options.scheduleMs * 2); at < options.durationMs; at += rng.int(1, options.scheduleMs * 2)) events.push({ at, kind: 'edit', actor });
  }
  for (let at = options.scheduleMs; at <= options.durationMs; at += options.scheduleMs) events.push({ at, kind: 'sync' });
  for (let at = options.invariantIntervalMs; at <= options.durationMs; at += options.invariantIntervalMs) events.push({ at, kind: 'check' });
  // At one moment: edits first, then the sync, then the check.
  const order = { edit: 0, sync: 1, check: 2 };
  events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
  return { events, rng };
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
 */
export async function soak(driver: SoakDriver, options: SoakOptions): Promise<SoakResult> {
  const { events, rng } = soakSchedule(options);
  const counts = editCounts(events);
  const lastToken = options.lastToken(counts);
  const remaining = new Map([...options.documents].map(([path, versions]) => [path, editCapacity(versions, lastToken)] as const).filter(([, capacity]) => capacity > 0));
  const edits = counts['editor-a'] + counts['editor-b'] + counts.git;
  const room = [...remaining.values()].reduce((sum, capacity) => sum + capacity, 0);
  if (room < edits) throw new Error(`the documents have room for ${room} of the ${edits} soak edits`);
  const start = driver.now();
  const result: SoakResult = { edits: { 'editor-a': 0, 'editor-b': 0, git: 0 }, syncRuns: 0, invariantChecks: 0, lostEdits: 0, scheduleDelays: [] };
  await driver.progress?.(result);
  for (const event of events) {
    const at = start + event.at;
    await driver.sleep(at - driver.now());
    if (driver.now() > start + options.durationMs + options.scheduleMs) throw new EnvBlockedError('soak exceeded its wall-clock duration plus one schedule interval');
    let converged = true;
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
        const invoked = driver.now();
        const started = await driver.sync();
        result.scheduleDelays.push(Math.max(0, (started ?? invoked) - at));
        result.syncRuns += 1;
      } else {
        const check = await driver.checkInvariants();
        result.invariantChecks += 1;
        result.lostEdits = Math.max(result.lostEdits, check.lostEdits);
        converged = check.converged ?? true;
      }
    } catch (error) {
      await driver.progress?.(result);
      throw error;
    }
    await driver.progress?.(result);
    if (!converged || result.lostEdits > 0) throw new ProductError(`soak stopped at hour ${result.invariantChecks}: I1=${String(converged)}, ${result.lostEdits} edits lost`);
    if (driver.now() > start + options.durationMs + options.scheduleMs) throw new EnvBlockedError('soak exceeded its wall-clock duration plus one schedule interval');
  }
  return result;
}
