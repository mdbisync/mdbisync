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
import { type SecurityGate } from './security.ts';
import { type PullRequestResult, syncPullRequest } from './pull-request.ts';
import { type WriteResult, writeTrackedToLinear } from './write.ts';

export interface CycleOptions {
  documentCap?: number | undefined;
  mergeGraceSeconds?: number | undefined;
  config: StateConfig;
  /** The repository the sync pull request is in, with the token the run acts as. */
  github: GitHubRepository;
  fetch?: typeof fetch;
  /** Makes the body transforms (uploads, links); see `WriteOptions.transforms`. */
  transforms?: () => readonly BodyTransform[];
  /** The capture's security gate; the tracked branch's hooks, run in this process, by default. */
  security?: SecurityGate;
}

export interface CycleResult {
  /** Every step finished its work; a later run has nothing left over from this one. */
  complete: boolean;
  /** Something was written to Linear or to a ref. */
  changed: boolean;
  /** The tracked branch's commit this run took in: fetched at its start, so a later push waits for the next run. */
  trackedTip: string;
  capture: CaptureResult;
  /** Absent when capture stops before step 2. */
  pullRequest?: PullRequestResult;
  /** Absent when capture stops before the write step. */
  write?: WriteResult;
}

export async function runSyncCycle(context: RunContext, options: CycleOptions): Promise<CycleResult> {
  const state = { ...context.fetched.state };
  const trackedTip = context.fetched.tracked;
  const captured = await capture(context, {config:options.config, state, ...(options.security ? {security:options.security} : {}), ...(options.fetch ? {fetch:options.fetch} : {})});
  // Also when the capture ended early: the steps after it never take an answer kept by the stage step.
  context.linear.transport.reads?.end();
  const changed = captured.changed.length > 0 || captured.removed.length > 0 || captured.blocked.length > 0;
  if (!captured.ok) return {complete:false, changed, trackedTip, capture:captured};
  await checkpoint('after-capture-push-before-pr');
  // After the bounded grace, pending checks still allow steps 3 to 5. A
  // failed check needs a configuration fix first, so leave Linear untouched.
  const pullRequest = await syncPullRequest(context, { config: options.config, state: captured.state, github: options.github, mergeGraceSeconds: options.mergeGraceSeconds });
  // Writing Linear from the tracked branch while that pull request waits would leave it to be merged over the new state.
  if (pullRequest.code === 'initial-pull-request-pending' || pullRequest.code === 'check-failed') return { complete: false, changed, trackedTip, capture: captured, pullRequest };
  const moved = pullRequest.branchMoved || pullRequest.merged !== null || pullRequest.pullRequest?.opened === true;
  const createSyncBranch = context.fetched.sync === null && !pullRequest.branchMoved;
  const write = await writeTrackedToLinear(context, { config: options.config, documentCap: options.documentCap, containers: captured.containers, createSyncBranch, state:captured.state, captured:captured.documents, ...(options.transforms ? { transforms: options.transforms } : {}) });
  // A held removal waits for the next run to confirm it.
  return {complete:write.complete && pullRequest.code === undefined && captured.heldRemovals.length === 0, changed:changed || moved || write.changed, trackedTip, capture:captured, pullRequest, write};
}
