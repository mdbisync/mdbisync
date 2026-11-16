// The sync merges a pull request only into the tracked branch, at the commit its checks of the merge were made on.
// A person who can push may change the pull request's base or move the tracked branch after the sync checked it.
// Before the sync's last look right before the merge, that change stops the merge and a later run checks again; in
// the moment between that look and GitHub's merge, it is found after the merge and reported for a person.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { type FakePullRequest, fakeFetch } from '../setup/test-helpers.ts';
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
   * Runs `act` each time the sync reads the commit statuses of the head of `branch`: after the sync chose the pull
   * request and checked its merge, before its last look.
   */
  function afterChecksOf(branch: string, act: () => Promise<void>) {
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const answer = await transport(input, init);
      if (/\/commits\/[0-9a-f]+\/status\?/.test(String(input)) && String(input).includes(await rev(branch))) await act();
      return answer;
    };
  }

  /** Runs `act` when GitHub takes the merge of the pull request from `head`: after the sync's last look. */
  function atMergeOf(head: string, act: (pr: FakePullRequest) => Promise<void>) {
    const merge = h.world.github.merge;
    h.world.github.merge = async (pr, sha) => {
      if (pr.head === head) await act(pr);
      return merge === undefined ? { status: 405 } : merge(pr, sha);
    };
  }

  /** Changes the base of every open pull request from `head` to the other branch, as a person may at any time. */
  const retarget = (head: string) => async () => {
    for (const pr of h.world.github.pullRequests) if (pr.state === 'open' && pr.head === head) pr.base = OTHER.slice('refs/heads/'.length);
  };

  describe('a change before the last look stops the merge', () => {
    it('a pull request retargeted after the sync checked it merges nothing', async () => {
      const other = await otherBranch();
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      const opened = await sync();
      assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
      const main = await rev('refs/heads/main');
      checksOn(await rev(SYNC_BRANCH), PASSED);
      afterChecksOf(SYNC_BRANCH, retarget('mdbisync/linear'));

      // A grace lets the run that reopens the pull request on the tracked branch also try to merge it.
      const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '25' });
      assert.equal(await rev(OTHER), other, 'the other branch received the sync head');
      assert.equal(await rev('refs/heads/main'), main);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(run.report.pullRequest?.code, 'state-moved');
      assert.ok(!run.writes.some((write) => write.endsWith('/merge')), run.writes.join('\n'));
    });

    it('a suspended pull request retargeted after the sync checked it merges nothing', async () => {
      const other = await otherBranch();
      await h.suspendOne();
      const main = await rev('refs/heads/main');
      checksOn(await rev(SUSPENDED), PASSED);
      afterChecksOf(SUSPENDED, retarget('mdbisync/suspended'));

      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.equal(await rev(OTHER), other, 'the other branch received the suspended head');
      assert.equal(await rev('refs/heads/main'), main);
      assert.equal(run.report.pullRequest?.suspended?.released, undefined);
      assert.ok(!run.writes.some((write) => write.endsWith('/merge')), run.writes.join('\n'));
    });

    it('a tracked branch that moved after the sync checked its pull request is checked again before it merges', async () => {
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      checksOn(await rev(SYNC_BRANCH), PASSED);
      let moved: string | undefined;
      afterChecksOf(SYNC_BRANCH, async () => {
        moved ??= await editRef('refs/heads/main', 'eng/notes/plan.md', '# Plan\n\nMoved by a person.\n', 'Edit the plan');
      });

      const run = await sync();
      assert.ok(moved !== undefined);
      assert.equal(await rev('refs/heads/main'), moved, 'the head merged onto a tracked commit its merge was not checked on');
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(run.report.pullRequest?.code, 'state-moved');

      // The next run checks the merge against the moved commit, and merges there.
      h.fetchOverride = undefined;
      let again = await sync();
      if (again.report.pullRequest?.branchMoved === true) {
        checksOn(await rev(SYNC_BRANCH), PASSED);
        again = await sync();
      }
      const now = await rev('refs/heads/main');
      assert.equal(again.report.pullRequest?.merged, now);
      assert.equal(await rev(`${now}^1`), moved);
    });
  });

  describe('a change after the last look is reported once GitHub merged', () => {
    it('a pull request retargeted at the merge is reported with the branch that took it', async () => {
      await otherBranch();
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      const head = await rev(SYNC_BRANCH);
      checksOn(head, PASSED);
      atMergeOf('mdbisync/linear', async (pr) => { pr.base = 'release'; });

      const run = await sync();
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      const landed = await rev(OTHER);
      assert.equal(await rev(`${landed}^2`), head, 'GitHub merged the head into the other branch');
      assert.equal(run.report.pullRequest?.code, 'merge-misplaced');
      assert.deepEqual(run.report.pullRequest?.misplaced, { branch: 'release', commit: landed });
      assert.equal(run.report.pullRequest?.merged, null);
      assert.match(run.result.stderr, /setup error \(merge-misplaced\): GitHub merged a sync pull request into `release` at `[0-9a-f]{12}`/);
      assert.match(run.summary, /Setup error: GitHub merged the sync pull request \[#1\]\(.*\) into `release`/);
    });

    it('a suspended pull request retargeted at the merge is reported, its documents stay suspended, and the normal lane waits', async () => {
      await otherBranch();
      await h.suspendOne();
      checksOn(await rev(SUSPENDED), PASSED);
      atMergeOf('mdbisync/suspended', async (pr) => { pr.base = 'release'; });
      // A normal batch is ready in the same run; it must neither hide the report nor merge before a person looked.
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      const main = await rev('refs/heads/main');

      const run = await sync();
      assert.equal(await rev('refs/heads/main'), main);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(run.report.pullRequest?.code, undefined);
      assert.doesNotMatch(run.summary, /GitHub merged the sync pull request/);
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      assert.equal(run.report.pullRequest?.suspended?.code, 'merge-misplaced');
      assert.equal(run.report.pullRequest?.suspended?.misplaced?.branch, 'release');
      assert.equal(run.report.pullRequest?.suspended?.released, undefined);
      assert.match(await h.show('refs/mdbisync/ids:ids.json'), /"suspended"/);
      assert.match(run.summary, /Setup error: GitHub merged the suspended pull request .* into `release`.* Its documents stay suspended\./);
    });

    it('a tracked branch that moved at the merge is reported: the merge sits on a commit the sync did not check', async () => {
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      checksOn(await rev(SYNC_BRANCH), PASSED);
      let moved: string | undefined;
      atMergeOf('mdbisync/linear', async () => {
        moved ??= await editRef('refs/heads/main', 'eng/notes/plan.md', '# Plan\n\nMoved by a person.\n', 'Edit the plan');
      });

      const run = await sync();
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      const now = await rev('refs/heads/main');
      assert.equal(await rev(`${now}^1`), moved);
      assert.equal(run.report.pullRequest?.code, 'merge-misplaced');
      assert.deepEqual(run.report.pullRequest?.misplaced, { branch: 'main', commit: now });
    });

    it('a merge whose pull request GitHub then does not show is still reported', async () => {
      await otherBranch();
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      checksOn(await rev(SYNC_BRANCH), PASSED);
      atMergeOf('mdbisync/linear', async (pr) => { pr.base = 'release'; });
      const transport = fakeFetch(h.world);
      h.fetchOverride = async (input, init) => {
        // Every read of the pull request after its merge fails.
        if (/\/pulls\/1$/.test(String(input)) && (init?.method ?? 'GET') === 'GET' && h.world.github.pullRequests[0]?.merged === true) return new Response('{}', { status: 502 });
        return transport(input, init);
      };

      const run = await sync();
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      assert.equal(run.report.pullRequest?.code, 'merge-misplaced');
      assert.equal(run.report.pullRequest?.misplaced?.branch, null);
      assert.match(run.result.stderr, /into a branch GitHub did not name at `[0-9a-f]{12}`/);
    });
  });

  describe('the tracked branch is read by its exact name', () => {
    it('a branch whose name ends like the tracked one does not stand in for it', async () => {
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      const checked = await rev('refs/heads/main');
      checksOn(await rev(SYNC_BRANCH), PASSED);
      // A branch that sorts before the tracked one and stays at the checked commit while the tracked branch moves.
      await h.fixture.remote.run(['update-ref', 'refs/heads/a/refs/heads/main', checked, '']);
      let moved: string | undefined;
      afterChecksOf(SYNC_BRANCH, async () => {
        moved ??= await editRef('refs/heads/main', 'eng/notes/plan.md', '# Plan\n\nMoved by a person.\n', 'Edit the plan');
      });

      const run = await sync();
      assert.equal(await rev('refs/heads/main'), moved);
      assert.equal(run.report.pullRequest?.code, 'state-moved');
    });
  });
});
