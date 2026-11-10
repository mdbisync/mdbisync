// The sync needs its state: without the `linear` state ref, or while an
// initial sync has not finished, it writes nothing and asks for initial
// sync. It never picks a direction itself. After an initial sync from
// Linear, it also waits until a person has merged that sync's pull request.

import { type StateConfig, type StateSnapshot, stateRef } from '../state/index.ts';
import { type FailureCode } from './report.ts';
import { message } from '../messages.ts';

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
      message: message('setup.initial-sync-unfinished'),
    };
  }
  if (state.linear === null) {
    return {
      code: 'initial-sync-required',
      message: message('setup.initial-sync-required', { ref: stateRef(config, 'linear') }),
    };
  }
  if (initialPullRequestPending) {
    return {
      code: 'initial-pull-request-pending',
      message: message('setup.initial-pull-request-pending', { tracked: config.trackedBranch, sync: config.syncBranch }),
    };
  }
  return null;
}
