// The run report's count of refs a refused push updated, read from a refused
// push shaped as a live run recorded it (made-up commit ids): GitHub refused
// an atomic push for a lost lease on `ids` and still printed `linear` as
// updated, while the remote kept the winning run's `linear`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RefusedPush } from '../state/index.ts';
import { toRunReport } from './finish.ts';
import { type OperationOutcome } from './operation.ts';

const LINEAR = 'refs/mdbisync-t/0a1b2c/linear';
const IDS = 'refs/mdbisync-t/0a1b2c/ids';
const PUSHED = '1'.repeat(40);
const WINNER = '2'.repeat(40);

/** The refused push as a live run's report kept it, with the value it sent for `linear` (its porcelain line's source). */
function liveRefusal(remoteAfter: RefusedPush['remoteAfter']): RefusedPush {
  return {
    refs: [LINEAR, IDS],
    moved: [LINEAR],
    output: [
      'To https://github.com/example/sandbox',
      `=\t${'3'.repeat(40)}:refs/mdbisync-t/0a1b2c/uploads\t[up to date]`,
      ` \t${PUSHED}:${LINEAR}\t4444444..1111111`,
      `!\t${'5'.repeat(40)}:${IDS}\t[remote rejected] (cannot lock ref '${IDS}': is at ${'6'.repeat(40)} but expected ${'7'.repeat(40)})`,
      'Done',
      "error: failed to push some refs to 'https://github.com/example/sandbox'",
    ],
    pushed: { [LINEAR]: PUSHED },
    remoteAfter,
  };
}

function reportOf(refusal: RefusedPush) {
  return toRunReport({
    operation: 'sync',
    ok: false,
    summary: '',
    notImplemented: false,
    refusedPushes: [refusal],
    writes: { linear: {}, git: {}, pullRequests: {} },
  } as unknown as OperationOutcome);
}

describe('the refs a refused push updated', () => {
  it('leaves out a ref git reported updated while the remote kept the winning run\'s value', () => {
    const report = reportOf(liveRefusal({ [LINEAR]: WINNER }));
    assert.equal(report.atomicPushRefused, true);
    assert.equal(report.partialRefUpdates, 0);
    // The evidence stays in the report for diagnosis.
    assert.deepEqual(report.refusedPushes, [liveRefusal({ [LINEAR]: WINNER })]);
  });

  it('counts a reported ref the remote holds at the pushed value', () => {
    assert.equal(reportOf(liveRefusal({ [LINEAR]: PUSHED })).partialRefUpdates, 1);
  });

  it('counts a reported ref when the remote could not be read', () => {
    assert.equal(reportOf(liveRefusal(null)).partialRefUpdates, 1);
  });

  it('leaves out a reported ref the refusal left absent on the remote', () => {
    assert.equal(reportOf(liveRefusal({ [LINEAR]: null })).partialRefUpdates, 0);
  });
});
