// The sync needs its state: without the `linear` state ref, or while an
// initial sync has not finished, it writes nothing and asks for initial
// sync. It never picks a direction itself. After an initial sync from
// Linear, it also waits until a person has merged that sync's pull request.
// A `linear` tip the sync did not write is lost state too: initial sync
// records it anew.

import { type StateConfig, type StateSnapshot, stateRef } from '../state/index.ts';
import { type FailureCode } from './report.ts';
import { message } from '../messages.ts';

export interface StateRefusal {
  code: Extract<FailureCode, 'initial-sync-required' | 'initial-pull-request-pending'>;
  message: string;
}

/** What the preflight read about the state, beside its refs. */
export interface StateFindings {
  /** The `ids` ref is at a progress commit of an initial sync that stopped; its map may hold only part of the documents. */
  initialSyncUnfinished?: boolean;
  /** The sync did not sign `linear`'s tip, and the tracked branch never held its tree. */
  linearUntrusted?: boolean;
  /**
   * `linear`'s history holds an initial sync's record from Linear that the
   * tracked branch has not taken yet, wherever the tip has moved since.
   */
  initialPullRequestPending?: boolean;
}

/**
 * Returns the refusal when the sync has no state it may build on, or null
 * when it may go on. An untrusted tip comes before a pending record: that
 * record is read from the same history, which may not be the sync's.
 */
export function checkSyncState(state: StateSnapshot, config: StateConfig, findings: StateFindings = {}): StateRefusal | null {
  if (findings.initialSyncUnfinished === true) {
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
  if (findings.linearUntrusted === true) {
    return {
      code: 'initial-sync-required',
      message: message('setup.linear-untrusted', { ref: stateRef(config, 'linear') }),
    };
  }
  if (findings.initialPullRequestPending === true) {
    return {
      code: 'initial-pull-request-pending',
      message: message('setup.initial-pull-request-pending', { tracked: config.trackedBranch, sync: config.syncBranch }),
    };
  }
  return null;
}
