// How many drain runs a soak's hourly check may wait for before its strict
// verdict (`soak` in load.ts). The soak step and the budget estimate read the
// same value from the step's arguments, so the budget reserves the runs the
// step may make.

/** One run to merge a checked head, one for a check that started late, one spare. */
export const SOAK_DRAIN_SYNCS = 3;

/** The step's `drainSyncs`, or the default; anything but a nonnegative whole number is refused. */
export function soakDrainSyncs(args: Readonly<Record<string, unknown>>): number {
  const value = Number(args.drainSyncs ?? SOAK_DRAIN_SYNCS);
  if (!Number.isInteger(value) || value < 0) throw new Error(`soak drainSyncs must be a nonnegative whole number, not ${String(args.drainSyncs)}`);
  return value;
}
