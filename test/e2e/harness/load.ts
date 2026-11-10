// Load scenarios: a burst of edits while the sync runs (L4-12) and the
// 24-hour soak (L4-13). The loops are written against a driver, so the
// timing logic is tested with fakes and the live run plugs in real edits
// and engine runs.

import { setTimeout as delay } from 'node:timers/promises';
import { CONTENT_LIMIT } from '../../../src/format/rules.ts';
import { paragraphEdit } from './fixtures.ts';
import { Rng } from '../../corpus/rng.ts';

export type Actor = 'editor-a' | 'editor-b' | 'git';

export interface LoadDriver {
  /** One Linear edit by an editor on a document. */
  linearEdit(actor: 'editor-a' | 'editor-b', path: string): Promise<void>;
  /** One git push that edits these documents. */
  gitEdit(paths: readonly string[]): Promise<void>;
  /** One sync run; resolves when it ends. */
  sync(): Promise<void>;
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

/** Reserve the entire burst's append budget on every candidate, even if all edits land there. */
export function burstDocuments(
  documents: ReadonlyMap<string, readonly string[]>,
  options: Omit<BurstOptions, 'documents'>,
  lastToken: string,
): string[] {
  const count = (rate: number) => Math.ceil(Math.max(0, rate) * options.durationMs / 60_000);
  const edits = count(options.linearEditsPerMinute) + count(options.gitPushesPerMinute);
  const growth = paragraphEdit('', undefined, lastToken).length * edits;
  const paths = [...documents].filter(([, versions]) => versions.length > 0 && versions.every((text) => text.length + growth <= CONTENT_LIMIT)).map(([path]) => path);
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
  const start = driver.now();
  const end = start + options.durationMs;
  const result: BurstResult = { linearEdits: 0, gitPushes: 0, syncRuns: 0 };
  let failed: unknown;
  const scheduled = async (perMinute: number, act: (index: number) => Promise<void>) => {
    if (perMinute <= 0) return;
    const interval = 60_000 / perMinute;
    for (let index = 0; index * interval < options.durationMs && failed === undefined; index += 1) {
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
    guard(scheduled(options.linearEditsPerMinute, async (index) => {
      await driver.linearEdit(index % 2 === 0 ? 'editor-a' : 'editor-b', options.documents[index % options.documents.length] as string);
      result.linearEdits += 1;
    })),
    guard(scheduled(options.gitPushesPerMinute, async (index) => {
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
  documents: readonly string[];
}

export interface SoakDriver extends LoadDriver {
  /** Checks I1 and I2 now; returns how many edits are lost. */
  checkInvariants(): Promise<{ lostEdits: number }>;
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

/**
 * The soak: each actor edits at random times (on average once per schedule
 * period), the sync runs on its schedule, and I1 and I2 are checked every
 * `invariantIntervalMs`. Random choices come from the seed, so a run can be
 * repeated.
 */
export async function soak(driver: SoakDriver, options: SoakOptions): Promise<SoakResult> {
  if (options.documents.length === 0) throw new Error('a soak needs documents to edit');
  const rng = new Rng(options.seed);
  const start = driver.now();
  const end = start + options.durationMs;
  type Event = { at: number; kind: 'edit'; actor: Actor } | { at: number; kind: 'sync' } | { at: number; kind: 'check' };
  const events: Event[] = [];
  for (const actor of options.actors) {
    for (let at = start + rng.int(0, options.scheduleMs * 2); at < end; at += rng.int(1, options.scheduleMs * 2)) events.push({ at, kind: 'edit', actor });
  }
  for (let at = start + options.scheduleMs; at <= end; at += options.scheduleMs) events.push({ at, kind: 'sync' });
  for (let at = start + options.invariantIntervalMs; at <= end; at += options.invariantIntervalMs) events.push({ at, kind: 'check' });
  // At one moment: edits first, then the sync, then the check.
  const order = { edit: 0, sync: 1, check: 2 };
  events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
  const result: SoakResult = { edits: { 'editor-a': 0, 'editor-b': 0, git: 0 }, syncRuns: 0, invariantChecks: 0, lostEdits: 0, scheduleDelays: [] };
  for (const event of events) {
    await driver.sleep(event.at - driver.now());
    if (event.kind === 'edit') {
      const path = options.documents[rng.int(0, options.documents.length - 1)] as string;
      if (event.actor === 'git') await driver.gitEdit([path]);
      else await driver.linearEdit(event.actor, path);
      result.edits[event.actor] += 1;
    } else if (event.kind === 'sync') {
      result.scheduleDelays.push(Math.max(0, driver.now() - event.at));
      await driver.sync();
      result.syncRuns += 1;
    } else {
      const { lostEdits } = await driver.checkInvariants();
      result.invariantChecks += 1;
      result.lostEdits = Math.max(result.lostEdits, lostEdits);
    }
  }
  return result;
}
