// The harness's side of the engine's checkpoint contract (src/test-hooks.ts):
// arm a pause, wait until the engine reaches it, resume it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHECKPOINTS, type Checkpoint } from '../../../src/test-hooks.ts';

export function isCheckpoint(value: unknown): value is Checkpoint {
  return typeof value === 'string' && (CHECKPOINTS as readonly string[]).includes(value);
}

export class CheckpointControl {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    for (const kind of ['pause', 'reached', 'passed']) mkdirSync(join(dir, kind), { recursive: true });
  }

  /**
   * Arms a pause. Earlier visits are forgotten first: every engine process
   * counts its visits from one, so a visit by an earlier run must not count.
   */
  pause(name: Checkpoint): void {
    rmSync(join(this.dir, 'reached', name), { force: true });
    rmSync(join(this.dir, 'passed', name), { force: true });
    writeFileSync(join(this.dir, 'pause', name), '');
  }

  resume(name: Checkpoint): void {
    rmSync(join(this.dir, 'pause', name), { force: true });
  }

  resumeAll(): void {
    for (const name of CHECKPOINTS) this.resume(name);
  }

  /** How many times the engine reached the checkpoint so far. */
  reached(name: Checkpoint): number {
    const file = join(this.dir, 'reached', name);
    if (!existsSync(file)) return 0;
    return (JSON.parse(readFileSync(file, 'utf8')) as { count: number }).count;
  }

  /**
   * Waits until the engine reaches the checkpoint (more than `before` times),
   * or `exited` settles first, or the time is up. Returns whether it reached it.
   */
  async waitReached(name: Checkpoint, options: { timeoutMs: number; before?: number; exited?: Promise<unknown> }): Promise<boolean> {
    let gone = false;
    void options.exited?.then(() => (gone = true), () => (gone = true));
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (this.reached(name) > (options.before ?? 0)) return true;
      if (gone) return this.reached(name) > (options.before ?? 0);
      await sleep(50);
    }
    return false;
  }
}
