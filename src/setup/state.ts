// The sync needs its state: without the `linear` state ref, or while an
// initial sync has not finished, it writes nothing and asks for initial
// sync. It never picks a direction itself. After an initial sync from
// Linear, it also waits until a person has merged that sync's pull request.

import { type StateConfig, type StateSnapshot, stateRef } from '../state/index.ts';
import { type FailureCode } from './report.ts';

export interface StateRefusal {
  code: Extract<FailureCode, 'initial-sync-required' | 'initial-pull-request-pending'>;
  message: string;
}

/**
 * Returns the refusal when the sync has no state, or null when it may go on.
 * `initialSyncUnfinished`: the `ids` ref is at a progress commit of an
 * initial sync that stopped; its map may hold only part of the documents.
 * `initialPullRequestPending`: `linear` is an initial sync's record from
 * Linear that the tracked branch has not taken yet.
 */
export function checkSyncState(
  state: StateSnapshot,
  config: StateConfig,
  initialSyncUnfinished = false,
  initialPullRequestPending = false,
): StateRefusal | null {
  if (initialSyncUnfinished) {
    return {
      code: 'initial-sync-required',
      message: 'An initial sync stopped before it finished: run it again with the same inputs first. The sync wrote nothing.',
    };
  }
  if (state.linear === null) {
    return {
      code: 'initial-sync-required',
      message: `${stateRef(config, 'linear')} does not exist: run initial sync first. The sync wrote nothing.`,
    };
  }
  if (initialPullRequestPending) {
    return {
      code: 'initial-pull-request-pending',
      message: `The pull request of the initial sync from Linear is not merged into ${config.trackedBranch} yet: a person reviews and merges it (it can remove files), then the sync runs. To start over instead, run initial sync again. The sync wrote nothing.`,
    };
  }
  return null;
}
