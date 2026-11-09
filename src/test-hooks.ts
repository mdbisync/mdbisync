// Test hooks: named checkpoints where a test can pause or kill the engine,
// and a test budget threshold. All of it is off unless the process runs
// with MDBISYNC_TEST_HOOKS=1, so a real run never reads these variables,
// touches these files or waits.
//
// The checkpoint contract, through files in the folder MDBISYNC_TEST_HOOKS_DIR:
//
// - On reaching checkpoint <name>, the engine writes `reached/<name>`
//   (JSON: pid, how many times it was reached, when).
// - If `pause/<name>` exists, the engine then waits until that file is
//   removed. The test removes it to resume, or kills the process to test a
//   crash at that point.
// - When it goes on, the engine writes `passed/<name>` the same way.
//
// MDBISYNC_TEST_STOP_AFTER_DOCUMENTS makes the engine stop writing after that
// many documents, as if Linear's budget had run low.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Every checkpoint the engine offers, in the order of a sync run:
 *
 * - after-capture-push-before-pr: Linear's changes are on `linear`; the sync pull request is next.
 * - after-local-merge-before-record: the tracked branch is merged locally, from the commit fetched at the start.
 * - before-write: in a sync run, before the first re-read, so an edit made here is seen and its document skipped.
 *   An initial sync reads nothing again: there it marks the moment just before its first write.
 * - after-reread-before-write: between a batch's re-read and its writes, the window Linear has no lock for.
 * - document-created-before-ids-push: a new document exists in Linear; its id is not recorded yet.
 * - after-write-before-record: the writes are done; the record commit and its push are next.
 */
export const CHECKPOINTS = [
  'after-capture-push-before-pr',
  'after-local-merge-before-record',
  'before-write',
  'after-reread-before-write',
  'document-created-before-ids-push',
  'after-write-before-record',
] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export const HOOKS_ENV = 'MDBISYNC_TEST_HOOKS';
export const HOOKS_DIR_ENV = 'MDBISYNC_TEST_HOOKS_DIR';
export const STOP_AFTER_ENV = 'MDBISYNC_TEST_STOP_AFTER_DOCUMENTS';
export const POLL_MS = 50;

type Env = Readonly<Record<string, string | undefined>>;

export class TestHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestHookError';
  }
}

export function hooksEnabled(env: Env = process.env): boolean {
  return env[HOOKS_ENV] === '1';
}

/** The folder of the checkpoint files, or null when hooks are off. */
export function hooksDir(env: Env = process.env): string | null {
  if (!hooksEnabled(env)) return null;
  const dir = env[HOOKS_DIR_ENV] ?? '';
  if (!isAbsolute(dir)) throw new TestHookError(`${HOOKS_ENV}=1 needs an absolute ${HOOKS_DIR_ENV}`);
  return dir;
}

/** The test's budget threshold in documents, or undefined. */
export function testStopAfterDocuments(env: Env = process.env): number | undefined {
  if (!hooksEnabled(env)) return undefined;
  const value = env[STOP_AFTER_ENV];
  if (value === undefined || value === '') return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new TestHookError(`${STOP_AFTER_ENV} must be a whole number`);
  return count;
}

const counts = new Map<string, number>();

/**
 * Marks a checkpoint. Without hooks it returns at once and touches nothing.
 * With hooks it records the visit and waits while the checkpoint is paused.
 */
export async function checkpoint(name: Checkpoint, env: Env = process.env): Promise<void> {
  const dir = hooksDir(env);
  if (dir === null) return;
  const count = (counts.get(name) ?? 0) + 1;
  counts.set(name, count);
  mark(dir, 'reached', name, count);
  while (existsSync(join(dir, 'pause', name))) await sleep(POLL_MS);
  mark(dir, 'passed', name, count);
}

function mark(dir: string, kind: 'reached' | 'passed', name: string, count: number): void {
  mkdirSync(join(dir, kind), { recursive: true });
  writeFileSync(join(dir, kind, name), `${JSON.stringify({ pid: process.pid, count, at: new Date().toISOString() })}\n`);
}
