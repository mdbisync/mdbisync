// One sync run, in the order of its steps:
//
// 1. Capture: Linear's changes onto the `linear` state ref.
// 2. The sync pull request: `linear`'s changes towards the tracked branch.
// 3-5. The tracked branch's changes to Linear (write.ts).
//
// Each step takes the state refs as the previous step left them and returns
// them as it leaves them, so every push leases the values it expects.

import { capture, type CaptureResult } from './capture.ts';
import { checkpoint } from '../test-hooks.ts';
import { type BodyTransform } from '../initial-sync/transform.ts';
import { type RunContext } from '../run/preflight.ts';
import { type StateConfig } from '../state/index.ts';
import { type WriteResult, writeTrackedToLinear } from './write.ts';

export interface CycleOptions {
  documentCap?: number | undefined;
  config: StateConfig;
  fetch?: typeof fetch;
  /** Makes the body transforms (uploads, links); see `WriteOptions.transforms`. */
  transforms?: () => readonly BodyTransform[];
}

export interface CycleResult {
  /** Every step finished its work; a later run has nothing left over from this one. */
  complete: boolean;
  /** Something was written to Linear or to a ref. */
  changed: boolean;
  capture: CaptureResult;
  /** Absent when capture stops before the write step. */
  write?: WriteResult;
}

export async function runSyncCycle(context: RunContext, options: CycleOptions): Promise<CycleResult> {
  const state = { ...context.fetched.state };
  const captured = await capture(context, {config:options.config, state, ...(options.fetch ? {fetch:options.fetch} : {})});
  const changed = captured.changed.length > 0 || captured.removed.length > 0 || captured.blocked.length > 0;
  if (!captured.ok) return {complete:false, changed, capture:captured};
  await checkpoint('after-capture-push-before-pr');
  // Step 2 will take the captured state to the tracked branch through a pull request.
  const write = await writeTrackedToLinear(context, { config: options.config, documentCap: options.documentCap, state:captured.state, ...(options.transforms ? { transforms: options.transforms } : {}) });
  return {complete:write.complete, changed:changed || write.changed, capture:captured, write};
}
