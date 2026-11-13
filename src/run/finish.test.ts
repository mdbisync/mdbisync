// The run report's count of refs a refused push updated, read from refused
// pushes shaped as live runs recorded them (made-up commit ids): GitHub
// refused an atomic push for a lost lease on `ids` and still printed `linear`
// as updated. In one run the remote kept the winning run's `linear`; in
// another both runs had built identical commits, so the remote held this
// push's own values for every ref.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RefusedPush } from '../state/index.ts';
import { toRunReport } from './finish.ts';
import { type OperationOutcome } from './operation.ts';

const LINEAR = 'refs/mdbisync-t/0a1b2c/linear';
const IDS = 'refs/mdbisync-t/0a1b2c/ids';
const UPLOADS = 'refs/mdbisync-t/0a1b2c/uploads';
const PUSHED = '1'.repeat(40);
const WINNER = '2'.repeat(40);
const UPLOADS_SHA = '3'.repeat(40);
const IDS_PUSHED = '5'.repeat(40);
const IDS_WINNER = '6'.repeat(40);
const IDS_EXPECTED = '7'.repeat(40);

/**
 * The refused push as a live run's report kept it: the values it sent for
 * every ref, and where the remote held them after the refusal. `ids` is
 * where the winning run left it, `uploads` kept its value (the push left it
 * unchanged).
 */
function liveRefusal(linearAfter: string | null, idsAfter = IDS_WINNER): RefusedPush {
  return {
    refs: [LINEAR, IDS],
    moved: [LINEAR],
    output: [
      'To https://github.com/example/sandbox',
      `=\t${UPLOADS_SHA}:${UPLOADS}\t[up to date]`,
      ` \t${PUSHED}:${LINEAR}\t4444444..1111111`,
      `!\t${IDS_PUSHED}:${IDS}\t[remote rejected] (cannot lock ref '${IDS}': is at ${idsAfter} but expected ${IDS_EXPECTED})`,
      'Done',
      "error: failed to push some refs to 'https://github.com/example/sandbox'",
    ],
    pushed: { [UPLOADS]: UPLOADS_SHA, [LINEAR]: PUSHED, [IDS]: IDS_PUSHED },
    remoteAfter: { [UPLOADS]: UPLOADS_SHA, [LINEAR]: linearAfter, [IDS]: idsAfter },
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
    const report = reportOf(liveRefusal(WINNER));
    assert.equal(report.atomicPushRefused, true);
    assert.equal(report.partialRefUpdates, 0);
    // The evidence stays in the report for diagnosis.
    assert.deepEqual(report.refusedPushes, [liveRefusal(WINNER)]);
  });

  it('leaves out every ref when the winning run pushed the identical commits', () => {
    // Both runs built the same commits: the remote holds this push's value for every ref.
    const report = reportOf(liveRefusal(PUSHED, IDS_PUSHED));
    assert.equal(report.atomicPushRefused, true);
    assert.equal(report.partialRefUpdates, 0);
    assert.deepEqual(report.refusedPushes, [liveRefusal(PUSHED, IDS_PUSHED)]);
  });

  it('counts a reported ref the remote holds at the pushed value while another ref holds the winning run\'s', () => {
    assert.equal(reportOf(liveRefusal(PUSHED)).partialRefUpdates, 1);
  });

  it('counts a reported ref when the record lacks the value sent for a ref of the push', () => {
    // A record without `ids`' value cannot show the remote holds the whole push.
    const refusal = liveRefusal(PUSHED, IDS_PUSHED);
    const { [IDS]: _ids, ...pushed } = refusal.pushed;
    assert.equal(reportOf({ ...refusal, pushed }).partialRefUpdates, 1);
  });

  it('counts a reported ref whose sent value the record lacks', () => {
    const refusal = liveRefusal(WINNER);
    const { [LINEAR]: _linear, ...pushed } = refusal.pushed;
    assert.equal(reportOf({ ...refusal, pushed }).partialRefUpdates, 1);
  });

  it('counts a reported ref when the remote could not be read', () => {
    assert.equal(reportOf({ ...liveRefusal(PUSHED), remoteAfter: null }).partialRefUpdates, 1);
  });

  it('leaves out a reported ref the refusal left absent on the remote', () => {
    assert.equal(reportOf(liveRefusal(null)).partialRefUpdates, 0);
  });
});
