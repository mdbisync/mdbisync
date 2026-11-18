// Check registration, merge grace, and fresh-head requirements before merging.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MARKS } from './marks.ts';
import { SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { FAKE_ACTIONS_APP_ID, FAKE_CI_ACCOUNT_ID, type FakeCheck, fakeFetch } from '../setup/test-helpers.ts';
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
    // The checked head ran `format`, so every later head must too: the repository's CI runs it on each of them.
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'format', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
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

  // A formatter workflow that pushes its fix with the workflow's own token starts no other workflow on the new head,
  // and publishes only its own check there. The other checks never ran on that head, so it has not passed them.
  it('does not merge a formatter fix that carries only the formatter check', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const pushed = await rev(SYNC_BRANCH);
    checksOn(pushed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'in_progress' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'merged a head that the other checks never saw');
    assert.deepEqual(run.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    // The description carries the expectation, so a later run that reads only the fixed head still asks for `tests`.
    assert.match(openPullRequests()[0]?.body ?? '', new RegExp(`<!-- head: sha=${fixed} since=\\S+ checks=pre-commit@run:${FAKE_ACTIONS_APP_ID}~[^, ]+,tests@run:${FAKE_ACTIONS_APP_ID}~[^, ]+ -->`));
    const again = await sync();
    assert.equal(again.report.pullRequest?.merged, null);
    assert.deepEqual(again.report.pullRequest?.checks?.missing, ['tests']);
    // Once the repository's CI runs `tests` on the fixed head, it merges.
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
    assert.match(await show(`refs/heads/main:${path}`), /Formatted/);
  });

  // The description is text anyone who may edit the pull request can change. Deleting its head note, or rewriting it to
  // name the current head with no checks, must not drop a check that ran on an earlier head.
  for (const fixes of [1, 2]) for (const tamper of ['deleted', 'forged'] as const) it(`does not merge ${fixes} formatter fix${fixes === 1 ? '' : 'es'} in a row when the head note is ${tamper}`, async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const pushed = await rev(SYNC_BRANCH);
    checksOn(pushed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'failure' }]);
    let fixed = pushed;
    for (let fix = 1; fix <= fixes; fix += 1) {
      fixed = await editRef(SYNC_BRANCH, path, `# Plan\n\nFirst edit.\n\nFormatted ${fix}.\n`, 'Apply pre-commit fixes');
      checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      // A run between the fixes notes the head; the tampering below comes after the last one.
      if (fix < fixes) await sync();
    }
    h.editHeadNote('mdbisync/linear', () => tamper === 'deleted' ? '' : `<!-- head: sha=${fixed} since=${new Date().toISOString()} -->`);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'merged a head that never ran `tests`');
    assert.deepEqual(run.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    const again = await sync();
    assert.equal(again.report.pullRequest?.merged, null);
    assert.deepEqual(again.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  it('requires genuine workflow jobs on a formatter child before merging', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const main = await rev('refs/heads/main');
    for (const workflow of [false, { path: '.github/workflows/other.yml' },
      { path: '.github/workflows/ci.yml', revision: 'c'.repeat(40) }, { event: 'workflow_run' },
      { head: main }, { repository: 'other/repo' }] satisfies NonNullable<FakeCheck['workflow']>[]) {
      checksOn(fixed, [{ name: 'tests', status: 'completed', conclusion: 'success', workflow }]);
      h.editHeadNote('mdbisync/linear', () => '');
      const waiting = await sync();
      assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
      assert.equal(waiting.report.pullRequest?.merged, null, `merged with ${JSON.stringify(workflow)}`);
      assert.equal(await rev('refs/heads/main'), main);
    }
    checksOn(fixed, [{ name: 'tests', status: 'completed', conclusion: 'success', workflow: { event: 'workflow_dispatch' } }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged, 'genuine CI on the document-only formatter fix did not merge');
  });

  // Both hold together: with the note gone, the checks read from the branch's history keep their publishers too.
  it('does not let a commit status stand in for an earlier check run when the head note is deleted', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'failure' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const formatter: FakeCheck = { name: 'pre-commit', status: 'completed', conclusion: 'success' };
    checksOn(fixed, [formatter, { name: 'tests', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    h.editHeadNote('mdbisync/linear', () => '');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'a commit status stood in for `tests` once the note was gone');
    assert.deepEqual(run.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    assert.match(openPullRequests()[0]?.body ?? '', new RegExp(`<!-- head: sha=${fixed} since=\\S+ checks=pre-commit@run:${FAKE_ACTIONS_APP_ID}~[^, ]+,tests@run:${FAKE_ACTIONS_APP_ID}~[^, ]+ -->`));
  });

  // A merge's parents are whatever its author chose: anyone who may push to the sync branch can make one look like the
  // sync's own merge of the tracked branch or of Linear's state. Below such a merge, the earlier head's checks still count.
  for (const parent of ['main', 'linear'] as const) it(`does not merge past a forged merge of ${parent === 'main' ? 'the tracked branch' : "Linear's state"} when the head note is deleted`, async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    // The sync records the head it pushed in its own state, beside the document ids.
    assert.equal((JSON.parse(await show('refs/mdbisync/ids:sync-pushed.json')) as { head: string }).head, await rev(SYNC_BRANCH));
    checksOn(await rev(SYNC_BRANCH), [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'failure' }]);
    // Linear's state below its tip: the tip is the branch's head itself.
    await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nChanged.\n', 'Merge', await rev(parent === 'main' ? 'refs/heads/main' : 'refs/mdbisync/linear~1'));
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nChanged and formatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'deploy', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    h.editHeadNote('mdbisync/linear', () => '');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'merged a head that never ran `tests`');
    assert.deepEqual(run.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  // A branch rebuilt by hand (or last pushed before the sync recorded its heads) no longer holds the head the sync
  // recorded pushing: its earlier checks are unknown. The sync puts a commit of its own on top, which runs the checks
  // again, rather than waiting for a Linear change.
  it('runs the checks again with a commit of its own when the branch no longer holds the head it pushed', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'tests', status: 'completed', conclusion: 'failure' }]);
    const env = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const rebuilt = await h.fixture.remote.text(['commit-tree', `${await rev(SYNC_BRANCH)}^{tree}`, '-p', h.start, '-m', 'Rebuilt'], { env });
    await h.forcePush(SYNC_BRANCH, rebuilt);
    checksOn(rebuilt, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    h.editHeadNote('mdbisync/linear', () => '');
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
    const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.branchMoved, true, 'did not run the checks again');
    const again = run.report.pullRequest?.merged ? (await h.fixture.remote.text(['show', '-s', '--format=%P', await rev('refs/heads/main')])).split(' ')[1]! : await rev(SYNC_BRANCH);
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P%n%s', again]), `${rebuilt}\nRun the checks again on the sync branch`);
    assert.equal((JSON.parse(await show('refs/mdbisync/ids:sync-pushed.json')) as { head: string }).head, again);
    assert.ok(run.report.pullRequest?.merged, 'did not merge once the checks passed on the new head');
  });

  // The sync's state is a ref anyone who may push can rewrite: a record naming a head the sync never pushed proves
  // nothing. Such a head, rebuilt on the tracked branch so no earlier check is below it, with a status of its own and
  // the description's note cleared, gets a commit of the sync's own on top, whose checks must pass before it merges.
  it('does not take a head someone else recorded as its own push for one it pushed', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'tests', status: 'completed', conclusion: 'failure' }]);
    const env = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const forged = await h.fixture.remote.text(['commit-tree', `${await rev(SYNC_BRANCH)}^{tree}`, '-p', h.start, '-m', 'Rebuilt'], { env });
    await h.forcePush(SYNC_BRANCH, forged);
    const recorded = JSON.parse(await show('refs/mdbisync/ids:sync-pushed.json')) as Record<string, unknown>;
    await editRef('refs/mdbisync/ids', 'sync-pushed.json', `${JSON.stringify({ ...recorded, head: forged })}\n`, 'Record');
    checksOn(forged, [{ name: 'deploy', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    h.editHeadNote('mdbisync/linear', () => '');
    const checked = { MDBISYNC_MERGE_WITHOUT_CHECKS: 'false', MDBISYNC_MERGE_GRACE_SECONDS: '20' };
    const run = await sync(checked);
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'merged a head whose checks never ran');
    assert.equal(await rev('refs/heads/main'), h.start);
    const again = await rev(SYNC_BRANCH);
    assert.equal(run.report.pullRequest?.branchMoved, true, 'did not run the checks again');
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P%n%s', again]), `${forged}\nRun the checks again on the sync branch`);
    assert.equal((JSON.parse(await show('refs/mdbisync/ids:sync-pushed.json')) as { head: string }).head, again);
    // The record of the sync's own push holds from run to run: once the checks of that push pass, it merges.
    checksOn(again, [{ name: 'deploy', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync(checked);
    assert.equal(merged.report.pullRequest?.branchMoved, false);
    assert.ok(merged.report.pullRequest?.merged);
  });

  // A record written before the sync signed its records proves nothing either: one push of its own replaces it.
  it('runs the checks again once over a record of its own push that is not signed', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const head = await rev(SYNC_BRANCH);
    checksOn(head, [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    await editRef('refs/mdbisync/ids', 'sync-pushed.json', `${JSON.stringify({ head })}\n`, 'Record');
    const run = await sync({ MDBISYNC_MERGE_WITHOUT_CHECKS: 'false' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null);
    const again = await rev(SYNC_BRANCH);
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P', again]), head);
    checksOn(again, [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync({ MDBISYNC_MERGE_WITHOUT_CHECKS: 'false' });
    assert.ok(merged.report.pullRequest?.merged);
  });

  // Anyone who may write commit statuses can name one after a check run; only the check's own publisher proves it ran.
  it('does not let a commit status or another app stand in for an expected check run', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const formatter: FakeCheck = { name: 'pre-commit', status: 'completed', conclusion: 'success' };
    checksOn(fixed, [formatter, { name: 'tests', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    const status = await sync();
    assert.equal(status.result.exitCode, 0, status.result.stderr);
    assert.equal(status.report.pullRequest?.merged, null, 'a commit status stood in for the `tests` check run');
    assert.deepEqual(status.report.pullRequest?.checks?.missing, ['tests']);
    checksOn(fixed, [formatter, { name: 'tests', status: 'completed', conclusion: 'success', app: 666 }]);
    const app = await sync();
    assert.equal(app.report.pullRequest?.merged, null, 'another app\'s check run stood in for the `tests` check run');
    assert.deepEqual(app.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    // The description keeps who must publish each check, so the binding holds in runs that read only the fixed head.
    assert.match(openPullRequests()[0]?.body ?? '', new RegExp(`<!-- head: sha=${fixed} since=\\S+ checks=pre-commit@run:${FAKE_ACTIONS_APP_ID}~[^, ]+,tests@run:${FAKE_ACTIONS_APP_ID}~[^, ]+ -->`));
    checksOn(fixed, [formatter, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  it('runs the checks again on a head whose history runs past the search bound before the sync\'s recorded head', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    let head = await rev(SYNC_BRANCH);
    for (let fix = 1; fix <= 51; fix += 1) head = await editRef(SYNC_BRANCH, path, `# Plan\n\nFirst edit.\n\nFormatted ${fix}.\n`, 'Apply fixes');
    checksOn(head, [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.merged, null, 'merged without knowing the checks of its earlier heads');
    assert.equal(await rev('refs/heads/main'), h.start);
    // The sync's own commit on top ends the history: its push runs the checks again, and once they pass it merges.
    const again = await rev(SYNC_BRANCH);
    assert.equal(run.report.pullRequest?.branchMoved, true, 'kept the head whose earlier checks are unknown');
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P', again]), head);
    checksOn(again, [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const recovered = await sync();
    assert.ok(recovered.report.pullRequest?.merged);
  });

  it('expects a commit status from the account that published it on the earlier head', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci/build', status: 'completed', conclusion: 'success', commitStatus: true }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const formatter: FakeCheck = { name: 'pre-commit', status: 'completed', conclusion: 'success' };
    checksOn(fixed, [formatter, { name: 'ci/build', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    const foreign = await sync();
    assert.equal(foreign.report.pullRequest?.merged, null, 'a status from another account stood in for `ci/build`');
    assert.deepEqual(foreign.report.pullRequest?.checks?.missing, ['ci/build']);
    checksOn(fixed, [formatter, { name: 'ci/build', status: 'completed', conclusion: 'success' }]);
    const run = await sync();
    assert.equal(run.report.pullRequest?.merged, null, 'a check run stood in for the `ci/build` commit status');
    checksOn(fixed, [formatter, { name: 'ci/build', status: 'completed', conclusion: 'success', commitStatus: true }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  it('reports checks-missing past the deadline when an expected check never starts, without suspending', async () => {
    const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync(deadline);
    checksOn(await rev(SYNC_BRANCH), [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync(deadline);
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.match(waiting.summary, /waits for its checks/);
    // The formatter's head gets the sync's own commit on top once; its checks do not start there either.
    backdate('mdbisync/linear', 6);
    const again = await sync(deadline);
    assert.equal(again.report.pullRequest?.branchMoved, true);
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P', await rev(SYNC_BRANCH)]), fixed);
    backdate('mdbisync/linear', 6);
    const own = await sync(deadline);
    assert.equal(own.report.pullRequest?.branchMoved, undefined, 'pushed again on a head the sync pushed itself');
    assert.deepEqual(own.writes, []);
    backdate('mdbisync/linear', 11);
    const late = await sync(deadline);
    assert.equal(late.result.exitCode, SETUP_FAILED_EXIT_CODE, late.result.stderr);
    assert.equal(late.report.pullRequest?.code, 'checks-missing');
    assert.equal(late.report.pullRequest?.suspended, undefined);
    assert.match(late.result.stderr, /checks-missing.*missing `tests`/);
    assert.match(late.summary, /never started on its head \(missing `tests`\)/);
    assert.deepEqual(late.writes, []);
    assert.equal(await rev('refs/heads/main'), h.start);
    const document = await documentOf(path);
    assert.notEqual(document.icon, MARKS.suspended.icon);
    assert.deepEqual(commentsOf(document), []);
  });

  // A formatter's fix pushed with a workflow's own token starts no other workflow: without a push of the sync's own, its
  // head would wait for a Linear change or the deadline. A run held for approval registers no check run, so it holds nothing.
  it('runs the checks again on a formatter\'s head whose expected checks never start, and merges without a Linear change', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync();
    assert.equal(waiting.report.pullRequest?.branchMoved, undefined, 'pushed before the formatter\'s checks had time to start');
    assert.deepEqual(waiting.report.pullRequest?.checks?.missing, ['tests']);
    backdate('mdbisync/linear', 4);
    const early = await sync();
    assert.equal(early.report.pullRequest?.branchMoved, undefined, 'pushed before the head waited five minutes');
    backdate('mdbisync/linear', 6);
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
    const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.branchMoved, true);
    assert.ok(run.report.pullRequest?.merged, 'the head the sync pushed on the formatter\'s fix did not merge');
    const merged = (await h.fixture.remote.text(['show', '-s', '--format=%P', await rev('refs/heads/main')])).split(' ')[1] as string;
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P%n%s', merged]), `${fixed}\nRun the checks again on the sync branch`);
    assert.equal(await rev(`${merged}^{tree}`), await rev(`${fixed}^{tree}`));
    assert.equal(h.world.github.pullRequests.length, 1);
  });

  it('waits for a configured required check that is not registered, and merges once it passes', async () => {
    const required = { MDBISYNC_REQUIRED_CHECKS: 'tests @ actions:.github/workflows/ci.yml\nlint @ actions:.github/workflows/ci.yml' };
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    await sync(required);
    const head = await rev(SYNC_BRANCH);
    checksOn(head, [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync(required);
    assert.equal(waiting.report.pullRequest?.merged, null);
    assert.deepEqual(waiting.report.pullRequest?.checks?.missing, ['lint']);
    checksOn(head, [{ name: 'tests', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }]);
    const merged = await sync(required);
    assert.ok(merged.report.pullRequest?.merged);
  });

  // A new sync branch has no earlier heads to bind a configured check to its publisher: only the configuration can.
  it('does not let a commit status from an unconfigured account meet a configured check on a new branch', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const forged = { name: 'tests', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 } as const;
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?') && h.world.github.pullRequests.length > 0) checksOn(await rev(SYNC_BRANCH), [forged]);
      return transport(input, init);
    };
    // A name without its publisher is an input error: the run stops before it reads anything, and writes no report.
    const writes = h.world.writes.length;
    await assert.rejects(cli('sync', { MDBISYNC_REQUIRED_CHECKS: 'tests', MDBISYNC_MERGE_GRACE_SECONDS: '25' }), { code: 'ENOENT' },
      'a configured check named without its publisher was accepted');
    assert.equal(h.world.writes.length, writes);
    assert.equal(await rev('refs/heads/main'), h.start);
    const bound = await cli('sync', { MDBISYNC_REQUIRED_CHECKS: 'tests @ status:2001', MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(bound.result.exitCode, 0, bound.result.stderr);
    assert.equal(bound.report.pullRequest?.merged, null, 'a status from an unconfigured account met a configured check');
    assert.deepEqual(bound.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
    checksOn(await rev(SYNC_BRANCH), [{ ...forged, creator: FAKE_CI_ACCOUNT_ID }]);
    h.fetchOverride = undefined;
    const merged = await sync({ MDBISYNC_REQUIRED_CHECKS: 'tests @ status:2001' });
    assert.ok(merged.report.pullRequest?.merged, 'a status from the configured account did not meet its check');
  });

  // The sync's own push starts the repository's whole CI: a check that stopped running (a renamed job) is not
  // expected for good, only as long as the head the sync pushes on still shows it.
  it('expects again only what CI registers once the sync itself pushes a new head', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    const first = await rev(SYNC_BRANCH);
    checksOn(first, [{ name: 'old-name', status: 'in_progress' }]);
    const fixed = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'new-name', status: 'completed', conclusion: 'success' }]);
    const held = await sync();
    assert.deepEqual(held.report.pullRequest?.checks?.missing, ['old-name']);
    await editInLinear('combined/guide.md', '# Guide\n\nLater edit.\n');
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'new-name', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
    const pushed = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
    assert.equal(pushed.report.pullRequest?.branchMoved, true);
    assert.ok(pushed.report.pullRequest?.merged, 'a head the sync pushed still waited for a check its CI no longer runs');
  });

  it('expects of a head the sync pushes in a run what the head it pushed on registered', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nFirst edit.\n');
    await sync();
    // A person pushes; the repository's CI runs `tests` on that head.
    const person = await editRef(SYNC_BRANCH, path, '# Plan\n\nFirst edit, reviewed.\n', 'Review');
    checksOn(person, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'in_progress' }]);
    await editInLinear('combined/guide.md', '# Guide\n\nLater edit.\n');
    // The head the sync pushes on top never registers `tests`.
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
    const run = await sync({ MDBISYNC_MERGE_GRACE_SECONDS: '20' });
    assert.equal(run.report.pullRequest?.branchMoved, true);
    assert.equal(run.report.pullRequest?.merged, null, 'merged without `tests`, which ran on the head it was pushed on');
    assert.deepEqual(run.report.pullRequest?.checks?.missing, ['tests']);
    assert.equal(await rev('refs/heads/main'), h.start);
  });

  it('stops expecting a configured check once it is removed from the configuration', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    await sync({ MDBISYNC_REQUIRED_CHECKS: 'tset @ actions:.github/workflows/ci.yml' });
    checksOn(await rev(SYNC_BRANCH), [{ name: 'tests', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync({ MDBISYNC_REQUIRED_CHECKS: 'tset @ actions:.github/workflows/ci.yml' });
    assert.deepEqual(waiting.report.pullRequest?.checks?.missing, ['tset']);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged, 'a name removed from required-checks still held the head');
  });

  it('does not merge a head with no checks unless merging without checks is allowed', async () => {
    const strict = { MDBISYNC_MERGE_WITHOUT_CHECKS: '', MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const fresh = await cli('sync', { ...strict, MDBISYNC_MERGE_GRACE_SECONDS: '' });
    assert.equal(fresh.result.exitCode, 0, fresh.result.stderr);
    assert.equal(fresh.report.pullRequest?.merged, null, 'merged a head on which no check ran');
    const waiting = await sync(strict);
    assert.equal(waiting.report.pullRequest?.merged, null);
    backdate('mdbisync/linear', 11);
    const late = await sync(strict);
    assert.equal(late.result.exitCode, SETUP_FAILED_EXIT_CODE, late.result.stderr);
    assert.equal(late.report.pullRequest?.code, 'checks-missing');
    assert.match(late.summary, /no check ran on its head/);
    assert.equal(await rev('refs/heads/main'), h.start);
    const allowed = await sync({ MDBISYNC_MERGE_WITHOUT_CHECKS: 'true' });
    assert.ok(allowed.report.pullRequest?.merged);
  });

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
