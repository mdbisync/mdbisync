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
import { type GitHubRepository } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { type StateConfig } from '../state/index.ts';
import { type PullRequestResult, syncPullRequest } from './pull-request.ts';
import { type WriteResult, writeTrackedToLinear } from './write.ts';

export interface CycleOptions {
  documentCap?: number | undefined;
  config: StateConfig;
  /** The repository the sync pull request is in, with the token the run acts as. */
  github: GitHubRepository;
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
  /** Absent when capture stops before step 2. */
  pullRequest?: PullRequestResult;
  /** Absent when capture stops before the write step. */
  write?: WriteResult;
}

export async function runSyncCycle(context: RunContext, options: CycleOptions): Promise<CycleResult> {
  const state = { ...context.fetched.state };
  const captured = await capture(context, {config:options.config, state, ...(options.fetch ? {fetch:options.fetch} : {})});
  const changed = captured.changed.length > 0 || captured.removed.length > 0 || captured.blocked.length > 0;
  if (!captured.ok) return {complete:false, changed, capture:captured};
  await checkpoint('after-capture-push-before-pr');
  // Nothing waits on the pull request: steps 3 to 5 run whatever step 2 found.
  const pullRequest = await syncPullRequest(context, { config: options.config, state: captured.state, github: options.github });
  // Writing Linear from the tracked branch while that pull request waits would leave it to be merged over the new state.
  if (pullRequest.code === 'initial-pull-request-pending') return { complete: false, changed, capture: captured, pullRequest };
  const moved = pullRequest.branchMoved || pullRequest.merged !== null || pullRequest.pullRequest?.opened === true;
  const write = await writeTrackedToLinear(context, { config: options.config, documentCap: options.documentCap, state:captured.state, ...(options.transforms ? { transforms: options.transforms } : {}) });
  return {complete:write.complete && pullRequest.code === undefined, changed:changed || moved || write.changed, capture:captured, pullRequest, write};
}
