// Check deadlines and tracked-branch failures that hold or suspend a batch.

import assert from 'node:assert/strict';
import { MARKS } from './marks.ts';
import { HOLD_MARK_LIMIT, HOLD_TIMED_OUT } from './hold.ts';
import { APP_PERMISSIONS } from '../setup/app.ts';
import { type FakeCheck, type FakeDocument, touch } from '../setup/test-helpers.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, MANY, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request deadlines', () => {
  const h = pullRequestHarness();
  const {
    sync, rev, show, documentOf, editInLinear, checksOn, commentsOf, openPullRequests, gitEdit, SUSPENDED, FAILED, PASSED, suspendOne, backdate, assertNoRerun,
  } = h;

  it('L5-26: a flaky check suspends its batch at once with no rerun request, and a rerun by a person that passes releases it', async () => {
    assert.equal('actions' in APP_PERMISSIONS, false, 'the App asks for no actions permission');
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nA flaky first attempt.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.deepEqual(failed.report.pullRequest?.suspended?.checks, ['ci']);
    assert.equal(failed.report.pullRequest?.redMain, undefined);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal((await documentOf(path)).icon, MARKS.suspended.icon);
    // A person reruns the check on the suspended head; the latest run passes and counts.
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.equal(released.result.exitCode, 0, released.result.stderr);
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.match(await show(`refs/heads/main:${path}`), /A flaky first attempt/);
    assert.equal(commentsOf(await documentOf(path))[0]?.resolved, true);
    assertNoRerun();
  });

  it('L5-27: a check that never finishes suspends its batch at the deadline, and the comment says it did not finish in time', async () => {
    const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nA change whose check never starts.\n');
    await sync(deadline);
    const head = await rev(SYNC_BRANCH);
    assert.match(openPullRequests()[0]?.body ?? '', new RegExp(`^<!-- head: sha=${head} since=\\S+ -->$`, 'm'));
    checksOn(head, [{ name: 'ci', status: 'queued' }]);
    const waiting = await sync(deadline);
    assert.equal(waiting.report.pullRequest?.suspended, undefined);
    assert.match(waiting.summary, /waits for `ci`/);
    // Short of the deadline the head still waits; the note keeps the push time, so a quiet run writes nothing.
    backdate('mdbisync/linear', 9);
    const early = await sync(deadline);
    assert.equal(early.report.pullRequest?.suspended, undefined);
    assert.deepEqual(early.writes, []);
    backdate('mdbisync/linear', 11);
    const late = await sync(deadline);
    assert.equal(late.result.exitCode, 0, late.result.stderr);
    assert.deepEqual(late.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.deepEqual(late.report.pullRequest?.suspended?.checks, []);
    assert.match(late.summary, /Checks that did not finish in time: `ci`/);
    assert.equal(h.world.github.pullRequests[0]?.state, 'closed');
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal(await rev('refs/heads/main'), h.start);
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.ok(note.startsWith(HOLD_TIMED_OUT), note);
    assert.match(note, /^- Check `ci` did not finish in time\.$/m);
    // The suspended head never finishes either: past its own deadline the comment already says so and stays.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'queued' }]);
    await sync(deadline);
    backdate('mdbisync/suspended', 11);
    const still = await sync(deadline);
    assert.deepEqual(still.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.equal(still.report.pullRequest?.holdMarks, undefined);
    assert.equal(commentsOf(await documentOf(path))[0]?.body, note);
    assertNoRerun();
  });

  it('the input check-deadline-minutes is noted per head: a new head starts its own clock', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nFirst.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'queued' }]);
    backdate('mdbisync/linear', 59);
    await editInLinear('combined/guide.md', '# Guide\n\nSecond.\n');
    const moved = await sync();
    assert.equal(moved.report.pullRequest?.branchMoved, true);
    const head = await rev(SYNC_BRANCH);
    checksOn(head, [{ name: 'ci', status: 'queued' }]);
    const since = /^<!-- head: sha=([0-9a-f]+) since=(\S+) -->$/m.exec(openPullRequests()[0]?.body ?? '');
    assert.equal(since?.[1], head);
    assert.ok(Date.now() - Date.parse(since?.[2] ?? '') < 60_000, 'a new head kept the old push time');
    backdate('mdbisync/linear', 59);
    const short = await sync();
    assert.equal(short.report.pullRequest?.suspended, undefined, 'suspended before the default deadline of 60 minutes');
    backdate('mdbisync/linear', 60);
    const due = await sync();
    assert.deepEqual(due.report.pullRequest?.suspended?.timedOut, ['ci']);
  });

  it('the suspended lane goes first: a passing normal head waits while the suspended checks run, up to the deadline', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    // A person reruns the suspended check; it runs.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'in_progress' }]);
    await editInLinear('combined/guide.md', '# Guide\n\nA normal edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), PASSED);
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.waitsForSuspended, true);
    assert.equal(waiting.report.pullRequest?.merged, null);
    assert.match(waiting.summary, /merges after the suspended pull request, whose checks still run/);
    assert.doesNotMatch(await show('refs/heads/main:combined/guide.md'), /A normal edit/);
    // The suspended check never finishes: past the deadline it no longer holds the normal lane, and the comment says so.
    backdate('mdbisync/suspended', 61);
    const late = await sync();
    assert.equal(late.result.exitCode, 0, late.result.stderr);
    assert.ok(late.report.pullRequest?.merged);
    assert.deepEqual(late.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.match(await show('refs/heads/main:combined/guide.md'), /A normal edit/);
    assert.deepEqual(late.report.pullRequest?.holdMarks?.updated, [path]);
    assert.ok((commentsOf(await documentOf(path))[0]?.body ?? '').startsWith(HOLD_TIMED_OUT));
  });

  it('L5-28: a check that also fails on the tracked branch tip holds the sync pull request: nothing suspended, marked or written to Linear about it', async () => {
    const path = 'eng/notes/plan.md';
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    await editInLinear(path, '# Plan\n\nAn edit that is not to blame.\n');
    await sync();
    const head = await rev(SYNC_BRANCH);
    checksOn(head, FAILED);
    const other = 'combined/guide.md';
    await gitEdit(other, '# Guide\n\nA tracked edit while checks fail there.\n');
    checksOn(await rev('refs/heads/main'), FAILED);
    const comments = h.world.linear.comments.size;
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.equal(held.report.pullRequest?.suspended, undefined);
    assert.deepEqual(held.report.pullRequest?.redMain?.map(({ name }) => name), ['ci']);
    assert.match(held.summary, /is held: `ci` \(\[run\]\(https:\/\/github\.test\/owner\/repo\/runs\/\d+\)\) also failed on the tracked branch's tip/);
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/linear');
    assert.match(openPullRequests()[0]?.body ?? '', /^<!-- red main: head=[0-9a-f]+ main=[0-9a-f]+ checks=ci -->$/m);
    assert.equal(await rev(SYNC_BRANCH), head);
    // Nothing about it in Linear: no mark and no comment; the tracked branch's own edit still reaches Linear.
    assert.equal(h.world.linear.comments.size, comments);
    assert.deepEqual({ icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null }, own);
    assert.equal(held.report.pullRequest?.holdMarks, undefined);
    assert.match((await documentOf(other)).content ?? '', /while checks fail there/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    // Past the deadline it still holds: the deadline never suspends a batch for a red tracked branch.
    backdate('mdbisync/linear', 61);
    const again = await sync();
    assert.equal(again.report.pullRequest?.suspended, undefined);
    assert.ok(again.report.pullRequest?.redMain);
    assert.equal(h.world.linear.comments.size, comments);
    // The check is fixed on the tracked branch: the sync branch merges it, and its checks run again on the new head.
    await gitEdit('ci/settings.txt', 'fixed\n');
    // The fix's checks have not registered on the new tip yet: the held head waits, it is neither merged nor suspended.
    const unregistered = await sync();
    assert.equal(unregistered.report.pullRequest?.suspended, undefined);
    assert.equal(unregistered.report.pullRequest?.branchMoved, false);
    assert.deepEqual(unregistered.report.pullRequest?.mainPending, ['ci']);
    checksOn(await rev('refs/heads/main'), PASSED);
    const fixed = await sync();
    assert.equal(fixed.result.exitCode, 0, fixed.result.stderr);
    assert.equal(fixed.report.pullRequest?.branchMoved, true);
    const merged = await rev(SYNC_BRANCH);
    assert.deepEqual((await h.fixture.remote.text(['show', '-s', '--format=%P', merged])).split(' '), [head, await rev('refs/heads/main')]);
    assert.doesNotMatch(openPullRequests()[0]?.body ?? '', /red main/);
    checksOn(merged, PASSED);
    const done = await sync();
    assert.ok(done.report.pullRequest?.merged);
    assert.match(await show(`refs/heads/main:${path}`), /not to blame/);
    assert.equal(h.world.linear.comments.size, comments);
    assertNoRerun();
  });

  it('L5-28: a Linear edit that joins a held branch in the run that the tracked branch turns green keeps the hold and takes the fix', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nHeld first.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    checksOn(await rev('refs/heads/main'), FAILED);
    const held = await sync();
    assert.ok(held.report.pullRequest?.redMain);
    await editInLinear('combined/guide.md', '# Guide\n\nJoins the held branch.\n');
    await gitEdit('ci/settings.txt', 'fixed\n');
    checksOn(await rev('refs/heads/main'), PASSED);
    const joined = await sync();
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    assert.equal(joined.report.pullRequest?.suspended, undefined);
    const head = await rev(SYNC_BRANCH);
    const ancestor = await h.fixture.remote.run(['merge-base', '--is-ancestor', await rev('refs/heads/main'), head], { okCodes: [0, 1] });
    assert.equal(ancestor.code, 0, 'the joined head lacks the tracked branch fix');
    assert.match(await show(`${head}:combined/guide.md`), /Joins the held branch/);
    checksOn(head, PASSED);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  it('deferred notices of a batch that timed out still say the check did not finish in time', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nLate.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nLate.\n`);
    for (let i = 0; i < MANY; i += 1) {
      h.world.linear.documents.push({ id: `late-${i}`, title: `late-${i}`, projectId, content: `# Late ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(h.world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'queued' }]);
    backdate('mdbisync/linear', 61);
    const first = await sync();
    assert.deepEqual(first.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    // The suspended head's own check still runs, short of its deadline: the deferred notices come from the episodes.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'queued' }]);
    const second = await sync();
    assert.equal(second.report.pullRequest?.holdMarks?.set.length, 60 - HOLD_MARK_LIMIT);
    for (const path of second.report.pullRequest?.holdMarks?.set ?? []) {
      const body = commentsOf(await documentOf(path))[0]?.body ?? '';
      assert.ok(body.startsWith(HOLD_TIMED_OUT), body);
      assert.match(body, /^- Check `ci` did not finish in time\.$/m);
    }
  });

  it('L5-28: a failed check that still runs on the tracked branch tip waits for that result, up to the deadline', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nWaiting on the tracked branch.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    checksOn(await rev('refs/heads/main'), [{ name: 'ci', status: 'in_progress' }]);
    const waiting = await sync();
    assert.equal(waiting.report.pullRequest?.suspended, undefined);
    assert.deepEqual(waiting.report.pullRequest?.mainPending, ['ci']);
    assert.match(waiting.summary, /still runs on the tracked branch's tip/);
    backdate('mdbisync/linear', 61);
    const late = await sync();
    assert.deepEqual(late.report.pullRequest?.suspended?.checks, ['ci']);
  });

  it('L5-28: with a batch already suspended, its comments are not rewritten for a failure the tracked branch shares', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    await sync();
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.match(note, /Check `ci`/);
    const lint: FakeCheck[] = [{ name: 'lint', status: 'completed', conclusion: 'failure' }];
    checksOn(await rev(SUSPENDED), lint);
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'completed', conclusion: 'failure' }]);
    const red = await sync();
    assert.equal(red.result.exitCode, 0, red.result.stderr);
    assert.deepEqual(red.report.pullRequest?.suspended?.redMain?.map(({ name }) => name), ['lint']);
    assert.equal(red.report.pullRequest?.holdMarks, undefined);
    assert.equal(commentsOf(await documentOf(path))[0]?.body, note);
    assert.match(red.summary, /comments in Linear stay as they are: `lint`/);
    // While `lint` still runs on the tip, the comments wait for that result and the summary says so.
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'in_progress' }]);
    const pending = await sync();
    assert.deepEqual(pending.report.pullRequest?.suspended?.mainPending, ['lint']);
    assert.equal(pending.report.pullRequest?.holdMarks, undefined);
    assert.match(pending.summary, /comments in Linear wait: `lint` failed on the suspended pull request and still runs/);
    // The tracked branch passes `lint` again: now the failure is the batch's, and its comment says so.
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'completed', conclusion: 'success' }]);
    const own = await sync();
    assert.deepEqual(own.report.pullRequest?.holdMarks?.updated, [path]);
    assert.match(commentsOf(await documentOf(path))[0]?.body ?? '', /Check `lint`/);
  });
});
