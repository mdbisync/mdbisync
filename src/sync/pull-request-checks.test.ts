// Check registration, merge grace, and fresh-head requirements before merging.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MARKS } from './marks.ts';
import { SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { type FakeCheck, fakeFetch } from '../setup/test-helpers.ts';
import { IDENTITY } from '../state/test-helpers.ts';
import { DEFAULT_MERGE_GRACE_SECONDS } from './pull-request.ts';
import { DEFAULT_CHECK_DEADLINE_MINUTES } from './deadline.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request checks', () => {
  const h = pullRequestHarness();
  const {
    githubRequests, cli, sync, mergeOnRemote, rev, show, documentOf, editInLinear, checksOn, commentsOf, openPullRequests, backdate, assertNoRerun, editRef, settle, assertOneConflict,
  } = h;

  it('keeps action and CLI merge-grace defaults aligned', async () => {
    const action = await readFile('action.yml', 'utf8');
    assert.match(action, new RegExp(`merge-grace-seconds:[\\s\\S]*?default: \"${DEFAULT_MERGE_GRACE_SECONDS}\"`));
    assert.match(action, new RegExp(`check-deadline-minutes:[\\s\\S]*?default: \"${DEFAULT_CHECK_DEADLINE_MINUTES}\"`));
  });

  it('merges a new pull request in the same run after checks pass', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const transport = fakeFetch(h.world);
    let observations = 0;
    h.fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?') && h.world.github.pullRequests.length > 0) {
        checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: ++observations === 1 ? 'in_progress' : 'completed', conclusion: 'success' }]);
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, ['POST /pulls', 'PUT /pulls/1/merge']);
    assert.ok(run.report.pullRequest?.merged);
    const head = await rev(SYNC_BRANCH);
    assert.equal((await h.fixture.remote.text(['show', '-s', '--format=%P', await rev('refs/heads/main')])).split(' ')[1], head);
  });

  it('merges an existing pull request in the run that advances its head', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nFirst edit.\n');
    await sync();
    const firstHead = await rev(SYNC_BRANCH);
    await editInLinear('eng/notes/plan.md', '# Plan\n\nSecond edit.\n');
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?')) {
        const head = await rev(SYNC_BRANCH);
        checksOn(head, [{ name: 'ci', status: head === firstHead ? 'in_progress' : 'completed', conclusion: 'success' }]);
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.branchMoved, true);
    assert.ok(run.report.pullRequest?.merged);
    assert.notEqual(await rev(SYNC_BRANCH), firstHead);
    assert.equal(h.world.github.pullRequests.length, 1);
  });

  it('makes repeated checked progress while every cycle captures fresh edits', async () => {
    const path = 'eng/notes/plan.md';
    const tokens: string[] = [];
    const mergedHeads: string[] = [];
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) {
        checksOn(match[1]!, [{ name: 'format', status: 'in_progress' }]);
      }
      return transport(input, init);
    };
    h.world.github.merge = async (pr, sha) => {
      assert.deepEqual(h.world.github.checks?.get(sha), [{ name: 'format', status: 'completed', conclusion: 'success' }]);
      const answer = await mergeOnRemote(pr, sha);
      if ('sha' in answer) mergedHeads.push(sha);
      return answer;
    };
    for (let cycle = 0; cycle < 8; cycle += 1) {
      // CI finishes after the previous invocation's grace and before this one.
      if (openPullRequests().length > 0) checksOn(await rev(SYNC_BRANCH), [{ name: 'format', status: 'completed', conclusion: 'success' }]);
      tokens.push(`edit-${cycle}`);
      await editInLinear(path, `# Plan\n\n${tokens.join('\n\n')}\n`);
      const before = await rev('refs/heads/main');
      const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      if (cycle % 2 === 1) {
        assert.notEqual(await rev('refs/heads/main'), before, 'a passed head starved behind a fresh capture');
        assert.equal(run.report.pullRequest?.branchMoved, false);
        assert.ok(run.report.pullRequest?.merged);
      }
      for (const token of tokens) assert.ok((await documentOf(path)).content?.includes(token), `Linear lost ${token}`);
    }
    for (let drain = 0; drain < 5; drain += 1) {
      if (openPullRequests().length > 0) checksOn(await rev(SYNC_BRANCH), [{ name: 'format', status: 'completed', conclusion: 'success' }]);
      const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      if (!run.report.changed) break;
      assert.ok(drain < 4, 'quiet drain did not converge');
    }
    assert.ok(mergedHeads.length >= 4);
    const tracked = await show(`refs/heads/main:${path}`);
    for (const token of tokens) assert.ok(tracked.includes(token), `tracked branch lost ${token}`);
    assert.equal((await documentOf(path)).content, tracked.slice(tracked.indexOf('# ')));
    assert.equal(openPullRequests().length, 0);
  });

  it('advances a passed head after a recorded merge refusal so new CI can run', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const checked = await rev(SYNC_BRANCH);
    checksOn(checked, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
    h.world.github.merge = async () => ({ status: 405, message: 'Required status check is expected' });
    const refused = await sync();
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    await editInLinear(path, '# Plan\n\nFirst edit.\n\nLater edit.\n');
    const advanced = await sync();
    assert.equal(advanced.result.exitCode, 0, advanced.result.stderr);
    assert.equal(advanced.report.pullRequest?.branchMoved, true);
    assert.equal(advanced.report.pullRequest?.merged, null);
    const next = await rev(SYNC_BRANCH);
    assert.notEqual(next, checked);
    assert.match(await show(`${SYNC_BRANCH}:${path}`), /Later edit/);
    h.world.github.merge = mergeOnRemote;
    checksOn(next, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
    assert.match(await show(`refs/heads/main:${path}`), /Later edit/);
  });

  it('refuses an overtaken checked head and retains the replacement and fresh capture', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const checked = await rev(SYNC_BRANCH);
    checksOn(checked, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
    await editInLinear('combined/guide.md', '# Guide\n\nFresh capture.\n');
    const transport = fakeFetch(h.world);
    let replacement: string | undefined;
    h.fetchOverride = async (input, init) => {
      if (replacement === undefined && String(input).includes(`/commits/${checked}/check-runs`)) {
        h.concurrentSyncMove = true;
        replacement = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nReview edit.\n');
      }
      return transport(input, init);
    };
    const run = await sync();
    assert.equal(run.report.pullRequest?.merged, null);
    assert.equal(run.report.pullRequest?.code, 'merge-refused');
    assert.equal(await rev('refs/heads/main'), h.start);
    assert.equal(await rev(SYNC_BRANCH), replacement);
    assert.match(await show('refs/mdbisync/linear:combined/guide.md'), /Fresh capture/);
    h.fetchOverride = undefined;
    h.concurrentSyncMove = false;
    await settle();
    assert.match(await show(`refs/heads/main:${path}`), /Review edit/);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Fresh capture/);
  });

  it('requires fresh checks when a passed head must reconcile a tracked conflict', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear('combined/guide.md', '# Guide\n\nFirst capture.\n');
    await sync();
    const checked = await editRef(SYNC_BRANCH, path, '---\nowner: example\n---\n\n# Plan\n\nLinear version.\n');
    checksOn(checked, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
    const person = await editRef('refs/heads/main', path, '---\nowner: example\n---\n\n# Plan\n\nTracked version.\n');
    await editInLinear('combined/guide.md', '# Guide\n\nFresh capture.\n');
    const run = await cli('sync');
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null);
    assert.equal(run.report.pullRequest?.branchMoved, true);
    const reconciled = await rev(SYNC_BRANCH);
    assert.notEqual(reconciled, checked);
    assert.equal(await rev('refs/heads/main'), person);
    assertOneConflict(await show(`${SYNC_BRANCH}:${path}`), 'Tracked version.', 'Linear version.');
    checksOn(reconciled, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
    const merged = await cli('sync');
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.ok(merged.report.pullRequest?.merged);
    assertOneConflict(await show(`refs/heads/main:${path}`), 'Tracked version.', 'Linear version.');
  });

  it('leaves pending checks open at the grace deadline, and suspends failed checks', async () => {
    for (const failed of [false, true]) {
      await editInLinear('eng/notes/plan.md', `# Plan\n\nReady ${failed}.\n`);
      const transport = fakeFetch(h.world);
      h.fetchOverride = async (input, init) => {
        if (String(input).includes('/check-runs?') && h.world.github.pullRequests.length > 0) checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: failed ? 'completed' : 'queued', conclusion: 'failure' }]);
        return transport(input, init);
      };
      const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '1' });
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(await rev('refs/heads/main'), h.start);
      if (failed) assert.ok(run.report.pullRequest?.suspended);
      else assert.match(run.summary, /Waiting for `ci`/);
    }
  });

  it('merges a head with no checks after the registration settle time using the default grace', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.ok(run.report.pullRequest?.merged);
    assert.ok(run.clock.now() >= 15_000, 'merged before the registration settle time');
    const quiet = await cli('sync');
    assert.deepEqual(quiet.writes, []);
  });

  // The deadline covers registered checks only. A required check that never
  // registers is not read as pending: the sync tries the merge, GitHub refuses
  // it for the missing check, and the repeated refusal is a setup error. Nothing
  // is suspended or marked, even past the deadline, because no check result
  // blames the batch's documents.
  for (const registered of [[], [{ name: 'build', status: 'completed', conclusion: 'success' }]] satisfies FakeCheck[][]) {
    it(`a required check that never registers ${registered.length === 0 ? 'on a head with no checks' : 'beside a passing check'} is a merge refusal, not a deadline suspension`, async () => {
      const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
      const path = 'eng/notes/plan.md';
      await editInLinear(path, `# Plan\n\nWaits for a check that never runs. ${CANARY}\n`);
      await sync(deadline);
      checksOn(await rev(SYNC_BRANCH), registered);
      const missing = 'Repository rule violations found\n\nRequired status check "lint" is expected.';
      const reason = 'Repository rule violations found Required status check "lint" is expected.';
      h.world.github.merge = async () => ({ status: 405, message: missing });

      const requestsBefore = githubRequests.length;
      const refused = await sync(deadline);
      assert.equal(refused.result.exitCode, 0, refused.result.stderr);
      assert.equal(refused.report.pullRequest?.code, 'merge-refused');
      assert.equal(refused.report.pullRequest?.reason, reason);
      assert.equal(refused.report.pullRequest?.suspended, undefined);
      assert.ok(githubRequests.slice(requestsBefore).some((request) => request.startsWith('PUT ') && request.endsWith('/pulls/1/merge')), 'the sync tried the merge');
      // The refusal is noted on the pull request, which is what lets the next run call it repeated.
      assert.deepEqual(refused.writes, ['PATCH /pulls/1']);
      assert.ok(openPullRequests()[0]?.body.includes('Required status check "lint" is expected.'), 'the pull request names the refusal');

      backdate('mdbisync/linear', 11);
      const blocked = await sync(deadline);
      assert.equal(blocked.result.exitCode, SETUP_FAILED_EXIT_CODE, blocked.result.stderr);
      assert.equal(blocked.report.pullRequest?.code, 'merge-blocked');
      assert.equal(blocked.report.pullRequest?.suspended, undefined);
      assert.ok(blocked.summary.includes(reason), blocked.summary);
      assert.match(blocked.summary, /make that check run on the sync pull request/);
      assert.deepEqual(blocked.writes, []);
      assert.deepEqual(openPullRequests().map((pr) => pr.head), ['mdbisync/linear']);
      assert.equal(await rev('refs/heads/main'), h.start);
      const document = await documentOf(path);
      assert.notEqual(document.icon, MARKS.suspended.icon);
      assert.deepEqual(commentsOf(document), []);
      assertNoRerun();
    });
  }

  // The time limit turns a wait that never ends into this test's own failure instead of a stalled suite.
  it('cannot merge a branch that moves while waiting using checks from its old head', { timeout: 60_000 }, async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const transport = fakeFetch(h.world);
    let observations = 0;
    h.fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?') && h.world.github.pullRequests.length > 0) {
        const head = await rev(SYNC_BRANCH);
        checksOn(head, [{ name: 'ci', status: ++observations === 1 ? 'queued' : 'completed', conclusion: 'success' }]);
        if (observations === 2) {
          const tree = await rev(`${head}^{tree}`);
          const next = await h.fixture.remote.text(['commit-tree', tree, '-p', head, '-m', 'Concurrent edit'], {
            env: { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email },
          });
          await h.fixture.remote.run(['update-ref', SYNC_BRANCH, next, head]);
        }
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.ok(observations >= 2, `the run read the checks ${observations} times, so the branch never moved while it waited`);
    assert.equal(run.report.pullRequest?.merged, null);
    assert.equal(run.report.pullRequest?.code, 'merge-refused');
    assert.equal(await rev('refs/heads/main'), h.start);
  });
});
