// One sync run, in the order of its steps:
//
// 1. Capture: Linear's changes onto the `linear` state ref.
// 2. The sync pull request: `linear`'s changes towards the tracked branch.
// 3-5. The tracked branch's changes to Linear (write.ts).
//
// Each step takes the state refs as the previous step left them and returns
// them as it leaves them, so every push leases the values it expects.

import { type BodyTransform } from '../initial-sync/transform.ts';
import { type RunContext } from '../run/preflight.ts';
import { type StateConfig } from '../state/index.ts';
import { type WriteResult, writeTrackedToLinear } from './write.ts';

export interface CycleOptions {
  config: StateConfig;
  /** Makes the body transforms (uploads, links); see `WriteOptions.transforms`. */
  transforms?: () => readonly BodyTransform[];
}

export interface CycleResult {
  /** Every step finished its work; a later run has nothing left over from this one. */
  complete: boolean;
  /** Something was written to Linear or to a ref. */
  changed: boolean;
  write: WriteResult;
}

export async function runSyncCycle(context: RunContext, options: CycleOptions): Promise<CycleResult> {
  const state = { ...context.fetched.state };
  // Steps 1 and 2 are not built yet: the state stays as fetched.
  const write = await writeTrackedToLinear(context, { config: options.config, state, ...(options.transforms ? { transforms: options.transforms } : {}) });
  return { complete: write.complete, changed: write.changed, write };
}
