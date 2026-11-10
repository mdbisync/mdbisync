// Locks shared by every harness process on one host, as folders in a state
// folder: `mkdir` is atomic, so exactly one process creates a lock. A lock
// whose owner process has died is taken over; the owner's file says who it
// was, so a wait can be explained.
//
// The same folder holds the registry of live runs, which the sweeper reads
// so it never removes what a live run uses.

import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { forgetOwnership } from './ownership.ts';

export const STATE_DIR_ENV = 'MDBISYNC_HARNESS_STATE_DIR';

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[STATE_DIR_ENV] || join(tmpdir(), 'mdbisync-harness');
}

export interface Owner {
  pid: number;
  host: string;
  runId: string;
  since: string;
  /** A lock kept for its run's UI session: it outlives the process until then, epoch milliseconds, while the run is held. */
  holdUntil?: number;
  /** A kept lock that a take-up of its run is working with: it also lives while that process does. */
  active?: boolean;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerAlive(owner: Owner | null, stateDir: string): boolean {
  if (owner === null) return false;
  // A kept lock lives by its hold, not by the process that kept it, which may go on with other scenarios.
  // A take-up working with it holds it while it runs, also past the hold.
  if (owner.holdUntil !== undefined) return heldLock(owner, stateDir) || (owner.active === true && owner.host === hostname() && processAlive(owner.pid));
  // A lock of another host cannot be checked; it counts as alive.
  return owner.host !== hostname() || processAlive(owner.pid);
}

/** A kept lock stays while both its own hold and its run's hold last: a run that ends or is recovered early lets it go. */
function heldLock(owner: Owner, stateDir: string, now = Date.now()): boolean {
  if (owner.holdUntil === undefined || owner.holdUntil <= now) return false;
  try {
    const run = JSON.parse(readFileSync(join(stateDir, 'runs', `${owner.runId}.json`), 'utf8')) as LiveRun;
    return run.runId === owner.runId && run.holdUntil !== undefined && run.holdUntil > now;
  } catch {
    return false;
  }
}

/** Writes a whole file at once: readers never see it half written or empty. */
export function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

function writeOwner(dir: string, owner: Owner): void {
  // A half-written owner would read as a lock whose owner died.
  writeAtomically(join(dir, 'owner.json'), JSON.stringify(owner));
}

function readOwner(dir: string): Owner | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as Owner;
  } catch {
    return null;
  }
}

export interface Lock {
  readonly name: string;
  release(): void;
  /**
   * Keeps the lock for the run's UI session instead of releasing it: it
   * outlives this process until `untilMs`, or until the run's registered
   * hold ends. A later process of the same run takes it over.
   */
  hold(untilMs: number): void;
}

export interface LockOptions {
  stateDir: string;
  runId: string;
  /** Longest wait; 0 tries once. */
  timeoutMs: number;
  pollMs?: number;
  /** Told once per new holder while waiting. */
  onWait?: (holder: Owner | null) => void;
  /** Stops the wait when aborted. */
  signal?: AbortSignal;
  /** Takes over this run's own kept lock (a held run's take-up); it stays kept until `hold` or `release`. */
  takeOverHeld?: boolean;
}

export class LockTimeoutError extends Error {
  constructor(name: string, holder: Owner | null) {
    super(`lock ${name} is held${holder === null ? '' : ` by run ${holder.runId} (pid ${holder.pid})`}`);
    this.name = 'LockTimeoutError';
  }
}

/** Takes the lock `name`, waiting while a live process holds it. */
export async function acquireLock(name: string, options: LockOptions): Promise<Lock> {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`bad lock name: ${name}`);
  const root = join(options.stateDir, 'locks');
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  const deadline = Date.now() + options.timeoutMs;
  let lastHolder: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const owner: Owner = { pid: process.pid, host: hostname(), runId: options.runId, since: new Date().toISOString() };
    try {
      mkdirSync(dir);
      writeOwner(dir, owner);
      return ownedLock(name, dir, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readOwner(dir);
    if (options.takeOverHeld === true && holder !== null && holder.runId === options.runId && holder.host === owner.host && heldLock(holder, options.stateDir)) {
      // The run's own kept lock: its take-up for the UI session's answers goes on holding the zone. The hold
      // stays on the lock, so a take-up that dies before it ends still leaves the zone kept.
      const takeUp: Owner = { ...owner, holdUntil: holder.holdUntil as number, active: true };
      try {
        writeOwner(dir, takeUp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // the lock went meanwhile: take it anew
        throw error;
      }
      return ownedLock(name, dir, takeUp);
    }
    if (holder !== null && !ownerAlive(holder, options.stateDir)) {
      // The holder died. Remove its lock only if it is still that holder's.
      if (readOwner(dir)?.pid === holder.pid) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (holder === null) {
      // Created a moment ago and its owner file is not written yet, or the
      // owner died between the two steps: wait a little, then take it over.
      await sleep(options.pollMs ?? 200);
      if (readOwner(dir) === null) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const key = `${holder.host}:${holder.pid}:${holder.runId}`;
    if (key !== lastHolder) {
      lastHolder = key;
      options.onWait?.(holder);
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(name, holder);
    await sleep(options.pollMs ?? 500);
  }
}

function ownedLock(name: string, dir: string, owner: Owner): Lock {
  let done = false;
  const ours = () => {
    const current = readOwner(dir);
    return current?.pid === owner.pid && current.runId === owner.runId;
  };
  return {
    name,
    release() {
      if (done) return;
      done = true;
      if (ours()) rmSync(dir, { recursive: true, force: true });
    },
    hold(untilMs: number) {
      if (done) return;
      done = true;
      if (ours()) {
        const { active: _active, ...parked } = owner;
        writeOwner(dir, { ...parked, holdUntil: untilMs });
      }
    },
  };
}

/**
 * Takes one of `slots` numbered locks `<name>-<i>`: a counting semaphore
 * across processes, for example at most four workers per OAuth app.
 */
export async function acquireSlot(name: string, slots: number, options: LockOptions): Promise<Lock> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      try {
        return await acquireLock(`${name}-${index}`, { ...options, timeoutMs: 0, onWait: () => {} });
      } catch (error) {
        if (!(error instanceof LockTimeoutError)) throw error;
      }
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(`${name} (all ${slots} slots)`, null);
    await sleep(options.pollMs ?? 500);
  }
}

// The registry of live runs.

export interface LiveRun extends Owner {
  heartbeatAt: string;
  /** Kept for a UI session until then, epoch milliseconds, even after its process ends. */
  holdUntil?: number;
}

/** A run counts as live while its process runs or, on another host, while its heartbeat is fresh. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

/** Registers a live run; `options.holdUntil` registers a held run's take-up, held from the first write. */
export function registerRun(stateDir: string, runId: string, options: { holdUntil?: number } = {}): { heartbeat(): void; hold(untilMs: number): void; done(): void } {
  const root = join(stateDir, 'runs');
  mkdirSync(root, { recursive: true });
  const file = join(root, `${runId}.json`);
  const since = new Date().toISOString();
  let holdUntil = options.holdUntil;
  const write = () => {
    const entry: LiveRun = { pid: process.pid, host: hostname(), runId, since, heartbeatAt: new Date().toISOString(), ...(holdUntil === undefined ? {} : { holdUntil }) };
    // Kept locks read this file: a rewrite must never show a held run as unheld, even for a moment.
    writeAtomically(file, JSON.stringify(entry));
  };
  write();
  return {
    heartbeat: write,
    hold(untilMs: number) {
      holdUntil = untilMs;
      write();
    },
    // A run cleaned up needs its ownership record no more.
    done: () => {
      forgetOwnership(stateDir, runId);
      rmSync(file, { force: true });
    },
  };
}

/** Run ids that are live now. */
export function liveRuns(stateDir: string, now = Date.now()): Set<string> {
  const root = join(stateDir, 'runs');
  const live = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return live;
  }
  for (const name of names) {
    let entry: LiveRun;
    try {
      entry = JSON.parse(readFileSync(join(root, name), 'utf8')) as LiveRun;
    } catch {
      continue;
    }
    const held = entry.holdUntil !== undefined && entry.holdUntil > now;
    const alive = held || (entry.host === hostname() ? processAlive(entry.pid) : now - Date.parse(entry.heartbeatAt) < HEARTBEAT_STALE_MS);
    if (alive) live.add(entry.runId);
  }
  return live;
}

/** Forgets a run once the sweeper has removed what it left. */
export function forgetRun(stateDir: string, runId: string): void {
  forgetOwnership(stateDir, runId);
  rmSync(join(stateDir, 'runs', `${runId}.json`), { force: true });
}

/** Recovery is local and explicit. Heartbeat age cannot prove a writer died.
 * Keep the ui-result lock while calling this and throughout recovery, so a
 * saved continuation cannot race the death check and ownership rotation. */
export function requireStoppedLocalRun(stateDir: string, runId: string): void {
  let entry: LiveRun;
  try { entry = JSON.parse(readFileSync(join(stateDir, 'runs', `${runId}.json`), 'utf8')) as LiveRun; }
  catch { throw new Error('recovery needs the original readable local run registration'); }
  if (entry.runId !== runId || entry.host !== hostname() || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) {
    throw new Error('recovery cannot verify this writer on the current host');
  }
  if (processAlive(entry.pid)) throw new Error('recovery refused: the writer process is still alive');
}

/** Run ids this host registered whose process is gone (killed runs). */
export function deadLocalRuns(stateDir: string, now = Date.now()): Set<string> {
  const root = join(stateDir, 'runs');
  const dead = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return dead;
  }
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(root, name), 'utf8')) as LiveRun;
      const held = entry.holdUntil !== undefined && entry.holdUntil > now;
      if (entry.host === hostname() && !held && !processAlive(entry.pid)) dead.add(entry.runId);
    } catch {
      // A half-written entry: its writer is alive or will be found dead next time.
    }
  }
  return dead;
}
