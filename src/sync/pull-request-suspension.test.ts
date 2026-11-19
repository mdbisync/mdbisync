// Failed batches moved to the suspended lane with bounded document notices.

import assert from 'node:assert/strict';
import { MARKS } from './marks.ts';
import { HOLD_MARK_LIMIT } from './hold.ts';
import { INCOMPLETE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { FAKE_ACTIONS_APP_ID, type FakeCheck, type FakeDocument, fakeFetch, touch } from '../setup/test-helpers.ts';
import { CHECK_NAME } from '../../test/corpus/check-workflow.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, MANY, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request suspension', () => {
  const h = pullRequestHarness();
  const {
    cli, sync, rev, show, ids, documentOf, editInLinear, checksOn, commentsOf, openPullRequests, gitEdit, SUSPENDED, FAILED, PASSED, suspendOne, releaseHeld, assertNoRerun,
  } = h;

  it('L5-17: a failed check suspends its batch, unrelated git writes go on, then it releases', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, `# Plan\n\nA new step. ${CANARY}\n`);
    await sync();
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    checksOn(await rev(SYNC_BRANCH), [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure', annotations: [
      { path, start_line: 3, title: 'Lists', message: 'Expected a blank line before the list.' },
      { path, start_line: 3, message: `Found A new step. ${CANARY} here` },
      { path: 'combined/guide.md', start_line: 1, message: 'Another file.' },
    ] }]);
    const other = 'combined/guide.md';
    const content = `# Guide\n\nA tracked edit. ${CANARY}\n`;
    await gitEdit(other, content);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.ok(failed.report.pullRequest?.suspended);
    assert.match(failed.summary, /Suspended changes/);
    assert.equal(h.world.github.pullRequests[0]?.state, 'closed');
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal((await documentOf(other)).content, content);
    assert.doesNotMatch(await show(`refs/heads/main:${path}`), /A new step/);
    assert.match(await show(`refs/heads/mdbisync/suspended:${path}`), /A new step/);
    // The red mark and one comment: the check, a link to its run and its annotations on this file only.
    const held = await documentOf(path);
    assert.deepEqual({ icon: held.icon, color: held.color }, MARKS.suspended);
    const notes = commentsOf(held);
    assert.equal(notes.length, 1);
    const note = notes[0]?.body ?? '';
    assert.match(note, /^Changes to this document are on hold: a check failed/);
    assert.ok(note.includes(`- Check \`${CHECK_NAME}\`: [run](https://github.test/owner/repo/runs/`), note);
    assert.match(note, / {2}- Line 3: Lists: Expected a blank line before the list\./);
    // A message that repeats the document's text is left out: only its line is shown.
    assert.match(note, / {2}- Line 3\.\n/);
    assert.doesNotMatch(note, /Another file/);
    assert.deepEqual(failed.report.pullRequest?.holdMarks?.set, [path]);
    checksOn(await rev('refs/heads/mdbisync/suspended'), [{ name: CHECK_NAME, status: 'completed', conclusion: 'success' }]);
    const repaired = await sync();
    assert.equal(repaired.result.exitCode, 0, repaired.result.stderr);
    assert.ok(repaired.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().length, 0);
    assert.match(await show(`refs/heads/main:${path}`), /A new step/);
    // Release clears it: the document's own icon and color come back and the comment is resolved, not deleted.
    const released = await documentOf(path);
    assert.deepEqual({ icon: released.icon ?? null, color: released.color ?? null }, own);
    assert.equal(commentsOf(released).length, 1);
    assert.equal(commentsOf(released)[0]?.resolved, true);
    assert.deepEqual(repaired.report.pullRequest?.holdMarks?.cleared, [path]);
    assert.equal('saved' in ((await ids())[path] as object), false);
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
    assertNoRerun();
  });

  it('a move whose record failed a check waits in the suspended lane, and no record-only pull request reopens meanwhile', async () => {
    h.world.linear.projects.push({ id: 'project-archive', name: 'Archive', teamIds: ['team-eng'] });
    await gitEdit('eng/notes/README.md', `---\nlinear-project: Archive\n---\n\n# Field notes\n\n${CANARY}\n`);
    const moved = await sync();
    assert.equal(moved.result.exitCode, 0, moved.result.stderr);
    const record = await rev('refs/mdbisync/linear');
    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.equal(openPullRequests().length, 1);
    checksOn(await rev(SYNC_BRANCH), [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure' }]);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.ok(failed.report.pullRequest?.suspended);
    assert.equal((await h.fixture.remote.run(['merge-base', '--is-ancestor', record, 'refs/heads/mdbisync/suspended'], { okCodes: [0, 1] })).code, 0);
    // While the suspended batch waits, the record waits with it: the normal pull request stays closed.
    for (let run = 0; run < 3; run++) {
      checksOn(await rev('refs/heads/mdbisync/suspended'), [{ name: CHECK_NAME, status: 'queued' }]);
      const waiting = await sync();
      assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
      assert.deepEqual(openPullRequests().map((pr) => pr.head), ['mdbisync/suspended']);
      assert.equal(h.world.github.pullRequests.length, 2);
    }
  });

  it('repaints a suspended document still showing the red Cross of earlier versions, then restores its own icon', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, `# Plan\n\nA new step. ${CANARY}\n`);
    await sync();
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    checksOn(await rev(SYNC_BRANCH), [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure' }]);
    await sync();
    // An earlier version marked the suspended document with a red Cross.
    Object.assign(await documentOf(path), { icon: 'Cross', color: '#EB5757' });
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    const held = await documentOf(path);
    assert.deepEqual({ icon: held.icon, color: held.color }, MARKS.suspended);
    assert.equal(commentsOf(held).length, 1);
    checksOn(await rev('refs/heads/mdbisync/suspended'), [{ name: CHECK_NAME, status: 'completed', conclusion: 'success' }]);
    await sync();
    const released = await documentOf(path);
    assert.deepEqual({ icon: released.icon ?? null, color: released.color ?? null }, own);
  });

  it('waits for GitHub to show the empty head before closing a suspended normal pull request', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nHeld edit.\n');
    await sync();
    const failed = await rev(SYNC_BRANCH);
    checksOn(failed, [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure' }]);
    let reads = 0;
    let visible = failed;
    h.world.github.pullRequestHead = async (pr) => {
      reads += 1;
      visible = reads < 3 ? failed : await rev(`refs/heads/${pr.head}`);
      return visible;
    };
    h.world.github.reset = (request, body) => {
      if (request === 'PATCH /pulls/1' && body.state === 'closed') {
        assert.notEqual(visible, failed, 'closed while GitHub still showed the failed batch');
      }
      return undefined;
    };
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.equal(reads, 3);
    assert.equal(h.world.github.pullRequests[0]?.state, 'closed');
    assert.equal(await rev(`${visible}^{tree}`), await rev('refs/heads/main^{tree}'));
    assert.ok(held.report.pullRequest?.suspended?.pullRequest);
  });

  for (const crash of [false, true]) it(`recovers a ${crash ? 'failed close after the atomic suspension push' : 'head update deferred beyond the polling limit'} without reusing the normal pull request`, async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld edit.\n');
    await sync();
    const failed = await rev(SYNC_BRANCH);
    checksOn(failed, [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure' }]);
    let reads = 0;
    h.world.github.pullRequestHead = async (pr) => {
      reads += 1;
      return crash ? rev(`refs/heads/${pr.head}`) : failed;
    };
    if (crash) h.world.github.reset = (request, body) => request === 'PATCH /pulls/1' && body.state === 'closed' ? 'before' : undefined;
    const first = await sync();
    assert.equal(first.result.exitCode, crash ? INCOMPLETE_EXIT_CODE : 0, first.result.stderr);
    assert.equal(reads, crash ? 1 : 5);
    if (!crash) {
      assert.equal(first.report.pullRequest?.suspended?.normalClosePending, true);
      assert.ok(first.report.pullRequest?.suspended?.pullRequest);
      assert.match(first.summary, /waiting for GitHub to show its empty head/);
      assert.doesNotMatch(first.summary, /no pull request is needed/);
    }
    const empty = await rev(SYNC_BRANCH);
    assert.notEqual(empty, failed);
    assert.equal(await rev(`${empty}^{tree}`), await rev('refs/heads/main^{tree}'));
    assert.equal(h.world.github.pullRequests[0]?.state, 'open');
    assert.ok(((await ids())[path] as { suspended?: unknown }).suspended);
    delete h.world.github.reset;
    h.world.github.pullRequestHead = async () => failed;
    await editInLinear('combined/guide.md', '# Guide\n\nAn unrelated edit.\n');
    // Even a green suspended head cannot release before the normal PR closes:
    // release would replace the empty head, making the old close unrecoverable.
    checksOn(await rev(SUSPENDED), [{ name: CHECK_NAME, status: 'completed', conclusion: 'success' }]);
    h.world.github.reset = (request) => request === 'GET /pulls/1' ? 'before' : undefined;
    const unavailable = await sync();
    assert.equal(unavailable.result.exitCode, INCOMPLETE_EXIT_CODE, unavailable.result.stderr);
    assert.equal(unavailable.report.pullRequest?.suspended?.normalClosePending, true);
    assert.doesNotMatch(unavailable.summary, /the normal lane still runs/);
    assert.equal(await rev(SYNC_BRANCH), empty);
    delete h.world.github.reset;
    const stale = await sync();
    assert.equal(stale.result.exitCode, 0, stale.result.stderr);
    assert.equal(stale.report.pullRequest?.suspended?.normalClosePending, true);
    assert.equal(stale.report.pullRequest?.suspended?.waiting, undefined);
    assert.match(stale.summary, /New normal batches and suspended release wait for that close/);
    assert.doesNotMatch(stale.summary, /no pull request is needed/);
    assert.equal(await rev(SYNC_BRANCH), empty);
    assert.equal(h.world.github.pullRequests[0]?.state, 'open');
    h.world.github.pullRequestHead = (pr) => rev(`refs/heads/${pr.head}`);
    let closedAt: string | undefined;
    h.world.github.reset = (request, body) => {
      if (request === 'PATCH /pulls/1' && body.state === 'closed') closedAt = empty;
      return undefined;
    };
    const recovered = await sync();
    assert.equal(recovered.result.exitCode, 0, recovered.result.stderr);
    assert.equal(closedAt, empty);
    assert.equal(h.world.github.pullRequests[0]?.state, 'closed');
    // A crash before opening the suspended PR still gives its new checks the
    // normal grace period. An existing PR can release in this recovery run.
    if (crash) {
      assert.equal(recovered.report.pullRequest?.suspended?.waiting, true);
      assert.ok((await sync()).report.pullRequest?.suspended?.released);
    } else assert.ok(recovered.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().filter((pr) => pr.head === 'mdbisync/linear').length, 1);
    assert.notEqual(openPullRequests().find((pr) => pr.head === 'mdbisync/linear')?.number, 1);
  });

  it('L5-35: a batch of 60 suspended documents is marked 50 in one run and 10 in the next, within I9', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nClosed.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nFinal.\n`);
    for (let i = 0; i < MANY; i += 1) {
      h.world.linear.documents.push({ id: `fresh-${i}`, title: `fresh-${i}`, projectId, content: `# Fresh ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(h.world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    // I9: 2.5 per written document, 5 per run, and 2 per document whose suspended mark or comment changed.
    const withinBudget = (run: Awaited<ReturnType<typeof sync>>) => {
      const marks = run.report.pullRequest?.holdMarks;
      const changes = (marks?.set.length ?? 0) + (marks?.updated.length ?? 0) + (marks?.cleared.length ?? 0);
      const written = run.writes.filter((write) => write === 'CreateDocument').length + run.writes.filter((write) => write === 'UpdateDocument').length - changes;
      assert.ok(run.linearRequests <= 2.5 * Math.max(written, 0) + 5 + 2 * changes, `${run.linearRequests} Linear requests for ${changes} mark changes and ${written} written documents`);
    };
    const first = await sync();
    assert.ok(first.report.pullRequest?.suspended);
    assert.equal(first.report.pullRequest?.holdMarks?.set.length, HOLD_MARK_LIMIT);
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    assert.match(first.summary, /10 more suspended documents get their mark or comment in a later run/);
    withinBudget(first);
    checksOn(await rev(SUSPENDED), FAILED);
    const second = await sync();
    assert.equal(second.report.pullRequest?.holdMarks?.set.length, 60 - HOLD_MARK_LIMIT);
    assert.equal(second.report.pullRequest?.holdMarks?.deferred, 0);
    withinBudget(second);
    const held = Object.entries(await ids()).filter(([, entry]) => (entry as { suspended?: unknown }).suspended !== undefined).map(([path]) => path);
    assert.equal(held.length, 60);
    for (const path of held) {
      const document = await documentOf(path);
      assert.equal(document.icon, MARKS.suspended.icon);
      assert.equal(commentsOf(document).length, 1);
    }
    // A long suspension costs nothing per run: the held documents are not read again.
    const idle = await sync();
    assert.equal(idle.report.pullRequest?.holdMarks, undefined);
    assert.ok(idle.linearRequests <= 5, `an idle suspended run made ${idle.linearRequests} Linear requests`);
  });

  it('L5-35: a release past the per-run limit clears the rest in the next run and says so, within I9', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nClosed.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nFinal.\n`);
    for (let i = 0; i < MANY; i += 1) {
      h.world.linear.documents.push({ id: `fresh-${i}`, title: `fresh-${i}`, projectId, content: `# Fresh ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(h.world.linear.documents.at(-1) as FakeDocument);
    }
    const own = new Map(h.world.linear.documents.map((document) => [document.id, { icon: document.icon ?? null, color: document.color ?? null }]));
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    await sync();
    checksOn(await rev(SUSPENDED), FAILED);
    await sync();
    const held = Object.entries(await ids()).filter(([, entry]) => (entry as { suspended?: unknown }).suspended !== undefined).map(([path]) => path);
    assert.equal(held.length, 60);
    // I9 as the harness counts it: Linear's API requests, without the token's exchange and revocation.
    const withinBudget = (run: Awaited<ReturnType<typeof sync>>) => {
      const marks = run.report.pullRequest?.holdMarks;
      const changes = (marks?.set.length ?? 0) + (marks?.updated.length ?? 0) + (marks?.cleared.length ?? 0);
      const written = run.writes.filter((write) => write === 'CreateDocument').length + run.writes.filter((write) => write === 'UpdateDocument').length - changes;
      assert.ok(run.linearApiRequests <= 2.5 * Math.max(written, 0) + 5 + 2 * changes, `${run.linearApiRequests} Linear requests for ${changes} mark changes and ${written} written documents`);
    };
    const released = await releaseHeld();
    assert.equal(released.report.pullRequest?.holdMarks?.cleared.length, HOLD_MARK_LIMIT);
    assert.equal(released.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    assert.match(released.summary, /10 more suspended documents get their mark or comment in a later run/);
    assert.equal(released.report.complete, false);
    withinBudget(released);
    // The next run finishes the rest and reports it: nothing is left for a later run that never comes.
    const rest = await sync();
    assert.equal(rest.result.exitCode, 0, rest.result.stderr);
    assert.equal(rest.report.pullRequest?.holdMarks?.cleared.length, 60 - HOLD_MARK_LIMIT);
    assert.equal(rest.report.pullRequest?.holdMarks?.deferred, 0);
    assert.match(rest.summary, /Suspended documents in Linear: 10 cleared\./);
    withinBudget(rest);
    for (const path of held) {
      const document = await documentOf(path);
      assert.deepEqual({ icon: document.icon ?? null, color: document.color ?? null }, own.get(document.id), path);
      assert.equal(commentsOf(document).length, 1, path);
      assert.equal(commentsOf(document)[0]?.resolved, true, path);
      assert.equal('saved' in ((await ids())[path] as object), false, path);
    }
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
    assert.deepEqual(quiet.writes, []);
  });

  it('a batch that joins while earlier documents still wait for their mark describes only its own documents', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nClosed.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nFinal.\n`);
    for (let i = 0; i < MANY; i += 1) {
      h.world.linear.documents.push({ id: `fresh-${i}`, title: `fresh-${i}`, projectId, content: `# Fresh ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(h.world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const first = await sync();
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    const waiting = Object.entries(await ids()).filter(([, entry]) => (entry as { suspended?: unknown; saved?: unknown }).suspended !== undefined && (entry as { saved?: unknown }).saved === undefined).map(([path]) => path);
    assert.equal(waiting.length, 60 - HOLD_MARK_LIMIT);
    // The suspended head fails `ci` again; a new normal batch fails `spelling` within the same run.
    checksOn(await rev(SUSPENDED), FAILED);
    const spelling: FakeCheck[] = [{ name: 'spelling', status: 'completed', conclusion: 'failure' }];
    const known = h.world.github.checks as Map<string, FakeCheck[]>;
    h.world.github.checks = new (class extends Map<string, FakeCheck[]> { override get(sha: string) { return super.get(sha) ?? spelling; } })(known);
    // The tracked branch's tip has no such failure: `spelling` is the new batch's own (not a red tracked branch).
    checksOn(await rev('refs/heads/main'), []);
    await editInLinear('eng/backend/notes.md', '# Notes\n\nA joining edit.\n');
    const joined = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '5' });
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    assert.ok(joined.report.pullRequest?.suspended);
    assert.match(commentsOf(await documentOf('eng/backend/notes.md'))[0]?.body ?? '', /Check `spelling`/);
    for (const path of waiting) {
      const body = commentsOf(await documentOf(path))[0]?.body ?? '';
      assert.match(body, /Check `ci`: \[run\]/, path);
      assert.doesNotMatch(body, /spelling/, path);
    }
  });

  it('L5-25: a Linear edit of a suspended document reaches only the suspended pull request and releases it', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const normal = await rev(SYNC_BRANCH);
    const before = commentsOf(await documentOf(path)).map(({ body }) => body);
    await editInLinear(path, '# Plan\n\nThe fixed line.\n');
    const intake = await sync();
    assert.equal(intake.result.exitCode, 0, intake.result.stderr);
    assert.equal(await rev(SYNC_BRANCH), normal, 'the normal lane took a suspended edit');
    assert.doesNotMatch(await show(`${SYNC_BRANCH}:${path}`), /The fixed line/);
    assert.match(await show(`${SUSPENDED}:${path}`), /The fixed line/);
    // Still held while its checks run: the mark and the one comment stay.
    assert.deepEqual(commentsOf(await documentOf(path)).map(({ body }) => body), before);
    assert.equal((await documentOf(path)).icon, MARKS.suspended.icon);
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.match(await show(`refs/heads/main:${path}`), /The fixed line/);
    const document = await documentOf(path);
    assert.notEqual(document.icon, MARKS.suspended.icon);
    assert.equal(commentsOf(document).length, 1);
    assert.equal(commentsOf(document)[0]?.resolved, true);
  });

  it('edits the one comment of an episode when a later head fails differently, and starts a new one for a new episode', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const first = commentsOf(await documentOf(path));
    assert.equal(first.length, 1);
    assert.match(first[0]?.body ?? '', /Check `ci`/);
    // The suspended head fails on another check: the same comment says so, no second comment.
    await editInLinear(path, '# Plan\n\nAnother held edit.\n');
    await sync();
    checksOn(await rev(SUSPENDED), [{ name: 'format', status: 'completed', conclusion: 'failure', annotations: [{ path, start_line: 1, message: 'Heading level.' }] }]);
    const changed = await sync();
    assert.deepEqual(changed.report.pullRequest?.holdMarks?.updated, [path]);
    const edited = commentsOf(await documentOf(path));
    assert.equal(edited.length, 1);
    assert.match(edited[0]?.body ?? '', /Check `format`/);
    assert.match(edited[0]?.body ?? '', /Line 1: Heading level\./);
    // An unchanged failure writes nothing.
    const idle = await sync();
    assert.equal(idle.report.pullRequest?.holdMarks, undefined);
    assert.deepEqual(idle.writes.filter((write) => !write.startsWith('PATCH /pulls/')), []);
    await releaseHeld();
    assert.equal(commentsOf(await documentOf(path))[0]?.resolved, true);
    // Suspended again later: a new episode, a new comment.
    await suspendOne(path, '# Plan\n\nA second episode.\n');
    const again = commentsOf(await documentOf(path));
    assert.equal(again.length, 2);
    assert.equal(again.filter((comment) => comment.resolved !== true).length, 1);
  });

  it('a joining batch names its own failure on its own documents and leaves the earlier comments as they are', async () => {
    await suspendOne();
    const firstNote = commentsOf(await documentOf('eng/notes/plan.md'))[0]?.body;
    await editInLinear('combined/guide.md', '# Guide\n\nSecond held edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'spelling', status: 'completed', conclusion: 'failure' }]);
    const joined = await sync();
    assert.deepEqual(joined.report.pullRequest?.holdMarks?.set, ['combined/guide.md']);
    assert.deepEqual(joined.report.pullRequest?.holdMarks?.updated, []);
    assert.equal(commentsOf(await documentOf('eng/notes/plan.md'))[0]?.body, firstNote);
    assert.match(commentsOf(await documentOf('combined/guide.md'))[0]?.body ?? '', /Check `spelling`/);
  });

  it('a check run whose annotations GitHub refuses is named without them, and the marks go on', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld Linear edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'lint', status: 'completed', conclusion: 'failure', annotationsStatus: 404, annotations: [{ path, start_line: 1, message: 'Unseen.' }] }]);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.pullRequest?.holdMarks?.set, [path]);
    assert.deepEqual(run.report.pullRequest?.holdMarks?.unreadAnnotations, ['lint']);
    assert.match(run.summary, /GitHub did not give the annotations of `lint`/);
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.match(note, /Check `lint`: \[run\]/);
    assert.doesNotMatch(note, /Unseen/);
  });

  // A formatter's fix pushed with the workflow's own token carries only the formatter's check: the suspended
  // batch is not released on it, and past the deadline the run says which check never started.
  it('does not release a suspended batch on a fix that lacks the check its earlier head ran', async () => {
    const path = 'eng/notes/plan.md';
    const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
    await suspendOne(path);
    await sync(deadline);
    const fixed = await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync(deadline);
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released a head that never ran `ci`');
    assert.equal(await rev(SUSPENDED), fixed);
    // Five minutes on, the sync pushes a commit of its own with the same files, so CI runs; `ci` stays expected there.
    h.backdate('mdbisync/suspended', 6);
    const again = await sync(deadline);
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    const own = await rev(SUSPENDED);
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P%n%s', own]), `${fixed}\nRun the checks again on suspended changes`);
    assert.equal(await rev(`${own}^{tree}`), await rev(`${fixed}^{tree}`));
    checksOn(own, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const waitingOwn = await sync(deadline);
    assert.equal(waitingOwn.report.pullRequest?.suspended?.released, undefined, 'released a head that never ran `ci`');
    assert.equal(await rev(SUSPENDED), own, 'pushed again on a head the sync pushed itself');
    h.backdate('mdbisync/suspended', 11);
    const late = await sync(deadline);
    assert.equal(late.result.exitCode, SETUP_FAILED_EXIT_CODE, late.result.stderr);
    assert.equal(late.report.pullRequest?.suspended?.code, 'checks-missing');
    assert.deepEqual(late.report.pullRequest?.suspended?.missing, ['ci']);
    assert.match(late.summary, /suspended pull request has waited past the check deadline for checks that never started on its head \(missing `ci`\)/);
    checksOn(own, [...PASSED, { name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const released = await sync(deadline);
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.match(await show(`refs/heads/main:${path}`), /Formatted/);
  });

  // Editing the suspended pull request's description cannot drop the check its earlier head failed.
  for (const fixes of [1, 2]) for (const tamper of ['deleted', 'forged'] as const) it(`does not release ${fixes} suspended fix${fixes === 1 ? '' : 'es'} in a row when the head note is ${tamper}`, async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    let fixed = await rev(SUSPENDED);
    for (let fix = 1; fix <= fixes; fix += 1) {
      fixed = await h.editRef(SUSPENDED, path, `# Plan\n\nHeld Linear edit.\n\nFormatted ${fix}.\n`, 'Apply pre-commit fixes');
      checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      if (fix < fixes) await sync();
    }
    h.editHeadNote('mdbisync/suspended', () => tamper === 'deleted' ? '' : `<!-- head: sha=${fixed} since=${new Date().toISOString()} -->`);
    const start = await rev('refs/heads/main');
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released a head that never ran `ci`');
    assert.equal(await rev(SUSPENDED), fixed);
    assert.equal(await rev('refs/heads/main'), start);
    const again = await sync();
    assert.equal(again.report.pullRequest?.suspended?.released, undefined);
    assert.equal(await rev('refs/heads/main'), start);
    checksOn(fixed, [...PASSED, { name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
  });

  // A merge made up to look like the sync's own (of the tracked branch or Linear's state) does not end the suspended
  // branch's history: the check its earlier head failed still counts.
  for (const parent of ['main', 'linear'] as const) it(`does not release past a forged merge of ${parent === 'main' ? 'the tracked branch' : "Linear's state"} when the head note is deleted`, async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nChanged.\n', 'Merge', await rev(parent === 'main' ? 'refs/heads/main' : 'refs/mdbisync/linear'));
    const fixed = await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nChanged and formatted.\n', 'Apply pre-commit fixes');
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'deploy', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 }]);
    h.editHeadNote('mdbisync/suspended', () => '');
    const start = await rev('refs/heads/main');
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released a head that never ran `ci`');
    assert.equal(await rev(SUSPENDED), fixed);
    assert.equal(await rev('refs/heads/main'), start);
    checksOn(fixed, [...PASSED, { name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
  });

  // The episodes in the sync's state are a ref anyone who may push can rewrite: naming a head there as the sync's own
  // push, rebuilt on the tracked branch so no earlier check is below it, does not end the suspended branch's history.
  it('does not release a head someone else recorded as its own push on the suspended branch', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    const held = await rev(SUSPENDED);
    const env = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const message = await h.fixture.remote.text(['show', '-s', '--format=%B', held]);
    const forged = await h.fixture.remote.text(['commit-tree', `${held}^{tree}`, '-p', await rev('refs/heads/main'), '-m', message], { env });
    await h.forcePush(SUSPENDED, forged);
    const recorded = await ids() as Record<string, { suspended?: { pushed?: string; pushedMac?: unknown } }>;
    // A signature in a form the sync never writes is no signature either: the run goes on without it.
    for (const entry of Object.values(recorded)) if (entry.suspended !== undefined) Object.assign(entry.suspended, { pushed: forged, pushedMac: { forged: true } });
    await h.editRef('refs/mdbisync/ids', 'ids.json', `${JSON.stringify(recorded, null, 2)}\n`, 'Record');
    const status: FakeCheck = { name: 'deploy', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 };
    checksOn(forged, [status]);
    h.editHeadNote('mdbisync/suspended', () => '');
    const start = await rev('refs/heads/main');
    const checked = { MDBISYNC_MERGE_WITHOUT_CHECKS: 'false' };
    const waiting = await sync(checked);
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released a head whose checks never ran');
    assert.equal(await rev('refs/heads/main'), start);
    // The sync's own commit on top runs the checks again; its record holds from run to run, and once they pass it releases.
    const again = await rev(SUSPENDED);
    assert.equal(await h.fixture.remote.text(['show', '-s', '--format=%P%n%s', again]), `${forged}\nRun the checks again on suspended changes`);
    checksOn(again, [...PASSED, status]);
    const released = await sync(checked);
    assert.ok(released.report.pullRequest?.suspended?.released, 'did not release the sync\'s own push once its checks passed');
  });

  it('does not release a suspended batch on a commit status named after the check run its earlier head ran', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    const fixed = await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const formatter: FakeCheck = { name: 'pre-commit', status: 'completed', conclusion: 'success' };
    checksOn(fixed, [formatter, ...PASSED.map((check) => ({ ...check, commitStatus: true, creator: 666 }))]);
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'a commit status released a head that never ran `ci`');
    assert.equal(await rev(SUSPENDED), fixed);
    checksOn(fixed, [formatter, ...PASSED]);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
  });

  it('requires the earlier head\'s Actions check from the Actions App on a formatter child before releasing a suspended batch', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    const fixed = await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const main = await rev('refs/heads/main');
    // None, a commit status, or another App's check run of the same name: not the earlier job.
    for (const substitute of [[], [{ commitStatus: true }], [{ app: 77 }]] satisfies Partial<FakeCheck>[][]) {
      checksOn(fixed, substitute.flatMap((from) => PASSED.map((check) => ({ ...check, ...from }))));
      h.editHeadNote('mdbisync/suspended', () => '');
      const waiting = await sync();
      assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
      assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, `released with ${JSON.stringify(substitute)}`);
      assert.equal(await rev('refs/heads/main'), main);
    }
    checksOn(fixed, PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released, 'CI on the formatter fix did not release');
  });

  // As on the normal lane: a fixer's push with a workflow token starts no pull_request checks, so its CI comes from a
  // dispatch run under the same job names, while GitHub holds a pull_request run of that push for approval. The sync
  // reads check runs and statuses only, and the held run has no check runs, so it leaves nothing for the sync to see.
  // The dispatch run's checks count: the batch is released on the first run after they pass, with no Linear change.
  it('releases a suspended batch whose fixed head has checks only from a dispatch run beside a held run without check runs', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    await sync();
    const fixed = await h.editRef(SUSPENDED, path, '# Plan\n\nHeld Linear edit.\n\nFormatted.\n', 'Apply pre-commit fixes');
    const main = await rev('refs/heads/main');
    const asked = h.githubRequests.length;
    // The dispatch run still runs `ci`: the batch waits.
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'ci', status: 'in_progress' }]);
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released while `ci` still ran');
    assert.equal(await rev(SUSPENDED), fixed);
    assert.equal(await rev('refs/heads/main'), main);
    // Five minutes on, the sync runs the checks again only on a head where an expected check never registered; here
    // `ci` did register, from the dispatch run, so the sync pushes nothing.
    h.backdate('mdbisync/suspended', 6);
    const later = await sync();
    assert.equal(later.result.exitCode, 0, later.result.stderr);
    assert.equal(later.report.pullRequest?.suspended?.released, undefined, 'released while `ci` still ran, six minutes on');
    assert.equal(await rev(SUSPENDED), fixed, 'ran the checks again on a head whose dispatch run had started `ci`');
    assert.equal(await rev('refs/heads/main'), main);
    // The dispatch run passed.
    checksOn(fixed, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, ...PASSED]);
    const released = await sync();
    assert.equal(released.result.exitCode, 0, released.result.stderr);
    assert.ok(released.report.pullRequest?.suspended?.released, 'the dispatch run\'s passing checks did not release the fixer\'s head');
    assert.equal(openPullRequests().length, 0);
    assert.match(await show(`refs/heads/main:${path}`), /Formatted/);
    assert.deepEqual(released.report.pullRequest?.holdMarks?.cleared, [path]);
    const document = await documentOf(path);
    assert.equal(commentsOf(document).length, 1);
    assert.equal(commentsOf(document)[0]?.resolved, true);
    assert.ok(!h.githubRequests.slice(asked).some((request) => request.includes('/actions/')), 'the sync read GitHub Actions');
  });

  // A Linear edit of a suspended document is a push of the sync's own on the suspended branch: a check its CI no longer
  // runs (a renamed job) stays expected for that one push only, as on the normal lane.
  it('stops expecting a renamed check once the sync pushed the suspended branch twice', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    checksOn(await rev(SUSPENDED), [{ name: 'old-job', status: 'completed', conclusion: 'failure' }]);
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => {
      const match = String(input).match(/\/commits\/([0-9a-f]+)\/check-runs/);
      if (match && !h.world.github.checks?.has(match[1]!)) checksOn(match[1]!, [{ name: 'new-job', status: 'completed', conclusion: 'success' }]);
      return transport(input, init);
    };
    const noGrace = { MDBISYNC_MERGE_GRACE_SECONDS: '0' };
    await editInLinear(path, '# Plan\n\nHeld Linear edit, second.\n');
    await sync(noGrace);
    const first = await rev(SUSPENDED);
    await editInLinear(path, '# Plan\n\nHeld Linear edit, third.\n');
    await sync(noGrace);
    assert.notEqual(await rev(SUSPENDED), first, 'the second Linear edit did not reach the suspended branch');
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released, 'still waits for a check its CI no longer runs');
    assert.match(await show(`refs/heads/main:${path}`), /third/);
  });

  it('a batch that joins the suspended lane keeps the checks its heads ran expected', async () => {
    await suspendOne('eng/notes/plan.md');
    // A second batch fails and joins the suspended pull request: the sync pushes a new suspended head.
    await editInLinear('combined/guide.md', '# Guide\n\nAnother held edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const joined = await sync();
    assert.ok(joined.report.pullRequest?.suspended);
    const head = await rev(SUSPENDED);
    assert.match(openPullRequests().find((pr) => pr.head === 'mdbisync/suspended')?.body ?? '', new RegExp(`<!-- head: sha=${head} since=\\S+ checks=ci@run:${FAKE_ACTIONS_APP_ID} -->`));
    // Only the formatter's check registers on the joined head: `ci`, which both earlier heads ran, is missing.
    checksOn(head, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const waiting = await sync();
    assert.equal(waiting.report.pullRequest?.suspended?.released, undefined, 'released a joined head that never ran `ci`');
    checksOn(head, [...PASSED, { name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
  });
});
