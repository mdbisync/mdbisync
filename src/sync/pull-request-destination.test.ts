// The sync merges a pull request only into the tracked branch, at the commit its checks of the merge were made on.
// A person who can push may change the pull request's base or move the tracked branch after the sync chose and
// checked the pull request; neither may land the checked head anywhere else.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeFetch } from '../setup/test-helpers.ts';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request destination', () => {
  const h = pullRequestHarness();
  const { sync, rev, editInLinear, checksOn, editRef, PASSED } = h;
  const SUSPENDED = 'refs/heads/mdbisync/suspended';
  const OTHER = 'refs/heads/release';

  /** A branch other than the tracked one, at the tracked branch's tip, as a release branch would be. */
  async function otherBranch(): Promise<string> {
    const at = await rev('refs/heads/main');
    await h.fixture.remote.run(['update-ref', OTHER, at, '']);
    return at;
  }

  /**
   * Runs `act` each time the sync reads the commit statuses of the head of `branch`: the last read before a merge,
   * after the sync chose the pull request and its checks passed.
   */
  function afterChecksOf(branch: string, act: () => Promise<void>) {
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const answer = await transport(input, init);
      if (/\/commits\/[0-9a-f]+\/status\?/.test(String(input)) && String(input).includes(await rev(branch))) await act();
      return answer;
    };
  }

  /** Changes the base of every open pull request from `head` to the other branch, as a person may at any time. */
  const retarget = (head: string) => async () => {
    for (const pr of h.world.github.pullRequests) if (pr.state === 'open' && pr.head === head) pr.base = OTHER.slice('refs/heads/'.length);
  };

  it('a pull request retargeted after the sync checked it merges nothing into the other branch', async () => {
    const other = await otherBranch();
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    const opened = await sync();
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    const main = await rev('refs/heads/main');
    const head = await rev(SYNC_BRANCH);
    checksOn(head, PASSED);
    afterChecksOf(SYNC_BRANCH, retarget('mdbisync/linear'));

    // A grace lets the run that reopens the pull request on the tracked branch also merge it: the base changes again.
    const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(await rev(OTHER), other, 'the other branch received the sync head');
    // The checked merge may still land on the tracked branch, on the commit it was checked against.
    const now = await rev('refs/heads/main');
    if (now !== main) {
      assert.equal(run.report.pullRequest?.merged, now);
      assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P', now]), `${main} ${head}`);
    }
  });

  it('a suspended pull request retargeted after the sync checked it merges nothing into the other branch', async () => {
    const other = await otherBranch();
    await h.suspendOne();
    checksOn(await rev(SUSPENDED), PASSED);
    afterChecksOf(SUSPENDED, retarget('mdbisync/suspended'));

    await sync();
    assert.equal(await rev(OTHER), other, 'the other branch received the suspended head');
  });

  it('a tracked branch that moved after the sync checked its pull request is not merged as checked', async () => {
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    await sync();
    const checked = await rev('refs/heads/main');
    checksOn(await rev(SYNC_BRANCH), PASSED);
    let moved: string | undefined;
    afterChecksOf(SYNC_BRANCH, async () => {
      // A person's push to the tracked branch lands between the sync's last look and its merge.
      moved ??= await editRef('refs/heads/main', 'eng/notes/plan.md', '# Plan\n\nMoved by a person.\n', 'Edit the plan');
    });

    const run = await sync();
    assert.ok(moved !== undefined);
    const now = await rev('refs/heads/main');
    const first = now === moved ? null : await rev(`${now}^1`);
    assert.ok(first === null || first === checked, 'the head merged onto a tracked commit its merge was not checked on');
    assert.equal(run.report.pullRequest?.merged ?? null, now === moved ? null : now);
  });
});
