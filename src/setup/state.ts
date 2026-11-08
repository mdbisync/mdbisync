// The sync needs its state: without the `linear` state ref it writes
// nothing and asks for initial sync. It never picks a direction itself.

import { type StateConfig, type StateSnapshot, stateRef } from '../state/index.ts';
import { type FailureCode } from './report.ts';

export interface StateRefusal {
  code: Extract<FailureCode, 'initial-sync-required'>;
  message: string;
}

/** Returns the refusal when the sync has no state, or null when it may go on. */
export function checkSyncState(state: StateSnapshot, config: StateConfig): StateRefusal | null {
  if (state.linear !== null) return null;
  return {
    code: 'initial-sync-required',
    message: `${stateRef(config, 'linear')} does not exist: run initial sync first. The sync wrote nothing.`,
  };
}
