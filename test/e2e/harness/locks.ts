// Locks shared by every harness process on one host, as folders in a state
// folder: `mkdir` is atomic, so exactly one process creates a lock. A lock
// whose owner process has died is taken over; the owner's file says who it
// was, so a wait can be explained.
//
// The same folder holds the registry of live runs, which the sweeper reads
// so it never removes what a live run uses.

import { hostname, tmpdir } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const STATE_DIR_ENV = 'MDBISYNC_HARNESS_STATE_DIR';

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[STATE_DIR_ENV] || join(tmpdir(), 'mdbisync-harness');
}

export interface Owner {
  pid: number;
  host: string;
  runId: string;
  since: string;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerAlive(owner: Owner | null): boolean {
  // A lock of another host cannot be checked; it counts as alive.
  return owner !== null && (owner.host !== hostname() || processAlive(owner.pid));
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
}

export interface LockOptions {
  stateDir: string;
  runId: string;
  /** Longest wait; 0 tries once. */
  timeoutMs: number;
  pollMs?: number;
  /** Told once per new holder while waiting. */
  onWait?: (holder: Owner | null) => void;
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
    try {
      mkdirSync(dir);
      const owner: Owner = { pid: process.pid, host: hostname(), runId: options.runId, since: new Date().toISOString() };
      writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
      let released = false;
      return {
        name,
        release() {
          if (released) return;
          released = true;
          const current = readOwner(dir);
          if (current?.pid === owner.pid && current.runId === owner.runId) rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readOwner(dir);
    if (holder !== null && !ownerAlive(holder)) {
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

export function registerRun(stateDir: string, runId: string): { heartbeat(): void; hold(untilMs: number): void; done(): void } {
  const root = join(stateDir, 'runs');
  mkdirSync(root, { recursive: true });
  const file = join(root, `${runId}.json`);
  const since = new Date().toISOString();
  let holdUntil: number | undefined;
  const write = () => {
    const entry: LiveRun = { pid: process.pid, host: hostname(), runId, since, heartbeatAt: new Date().toISOString(), ...(holdUntil === undefined ? {} : { holdUntil }) };
    writeFileSync(file, JSON.stringify(entry));
  };
  write();
  return {
    heartbeat: write,
    hold(untilMs: number) {
      holdUntil = untilMs;
      write();
    },
    done: () => rmSync(file, { force: true }),
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
  rmSync(join(stateDir, 'runs', `${runId}.json`), { force: true });
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
