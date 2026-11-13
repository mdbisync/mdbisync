// How many scheduled sync runs a soak's hourly check may wait for, as drain
// runs, before its strict verdict (`soak` in load.ts). The soak step and the
// budget estimate read the same value from the step's arguments, so the budget
// reserves the side reads the step may make.

/** One run to merge a checked head, one for a check that started late, one spare. */
export const SOAK_DRAIN_SYNCS = 3;

/** The step's `drainSyncs`, or the default; anything but a nonnegative whole number is refused. */
export function soakDrainSyncs(args: Readonly<Record<string, unknown>>): number {
  const value = Number(args.drainSyncs ?? SOAK_DRAIN_SYNCS);
  if (!Number.isInteger(value) || value < 0) throw new Error(`soak drainSyncs must be a nonnegative whole number, not ${String(args.drainSyncs)}`);
  return value;
}

export interface SoakDrainPlan {
  /** The soak's hourly checks. */
  checks: number;
  /** The checks with scheduled runs after them to drain on: all but the last, which ends the soak. */
  drainable: number;
  /** When the scheduled edits end, from the soak's start: the last check's drain runs come after them. */
  editsEndMs: number;
}

/**
 * The one definition of how a soak drains, for the soak and the budget estimate alike. A drain runs on the next
 * scheduled runs after its check, and takes less than half a check interval. With a drain, the soak's duration is
 * whole check intervals: the last check comes at the end, has no run after it, and the edits stop the drain's
 * runs before it, so those runs drain the last hour and its check is strict at once.
 */
export function soakDrainPlan(options: { durationMs: number; scheduleMs: number; invariantIntervalMs: number; drainSyncs: number }): SoakDrainPlan {
  const { durationMs, scheduleMs, invariantIntervalMs, drainSyncs } = options;
  if (!Number.isInteger(drainSyncs) || drainSyncs < 0) throw new Error('soak drain syncs must be a nonnegative whole number');
  const checks = Math.floor(durationMs / invariantIntervalMs);
  if (drainSyncs === 0) return { checks, drainable: 0, editsEndMs: durationMs };
  // The quiet tail starts the drain's length before the end; the hour before it may drain for as long, and the
  // edits it held back come after that drain. They must come before the tail starts, so that the tail's runs
  // drain them as fully as a drain would: each takes less than half a check interval.
  if (2 * drainSyncs * scheduleMs >= invariantIntervalMs) {
    throw new Error(`soak drain of ${drainSyncs} sync runs every ${scheduleMs} ms takes half the ${invariantIntervalMs} ms check interval or more, so an hour's drain would reach the last hour's quiet tail`);
  }
  if (durationMs % invariantIntervalMs !== 0) throw new Error(`a soak with a drain lasts whole check intervals: ${durationMs} ms is not a multiple of ${invariantIntervalMs} ms`);
  return { checks, drainable: Math.max(0, checks - 1), editsEndMs: Math.max(0, durationMs - drainSyncs * scheduleMs) };
}
