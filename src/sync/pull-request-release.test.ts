// Suspended batches released with their documents, assets, and comment cleanup.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectConflicts } from '../merge/index.ts';
import { MARKS } from './marks.ts';
import { HOLD_FAILED, MESSAGE_WITHHELD } from './hold.ts';
import { touch } from '../setup/test-helpers.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request release', () => {
  const h = pullRequestHarness();
  const {
    sync, rev, show, ids, documentOf, editInLinear, checksOn, commentsOf, openPullRequests, gitEdit, SUSPENDED, FAILED, PASSED, suspendOne, releaseHeld, suspendThenTrash, onResolve, linearAnswer, onMutation, refusal,
  } = h;

  it('L5-23/L5-24: another batch merges and recorded bases keep the held batch at release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const heldHead = await rev(SUSPENDED);
    const episode = await show('refs/mdbisync/ids:ids.json');
    assert.match(episode, /"noticeId"/);
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Independent edit/);
    assert.doesNotMatch(await show(`refs/heads/main:${path}`), /Held Linear edit/);
    // This is the dangerous topology: main contains the capture through the
    // set-aside head, so git alone treats the missing batch as a deliberate undo.
    const wrong = await h.fixture.remote.text(['merge-tree', '--write-tree', await rev('refs/heads/main'), heldHead]);
    assert.doesNotMatch(await show(`${wrong.split('\n')[0]}:${path}`), /Held Linear edit/);
    await releaseHeld();
    assert.match(await show(`refs/heads/main:${path}`), /Held Linear edit/);
    assert.match((await documentOf(path)).content ?? '', /Held Linear edit/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
  });

  it('L5-29: a second failed batch joins the one suspended pull request', async () => {
    await suspendOne();
    const first = await rev(SUSPENDED);
    await editInLinear('combined/guide.md', '# Guide\n\nSecond held edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    await sync();
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Held Linear edit/);
    assert.match(await show(`${SUSPENDED}:combined/guide.md`), /Second held edit/);
    assert.equal((await h.fixture.remote.run(['merge-base', '--is-ancestor', first, await rev(SUSPENDED)], {okCodes:[0,1]})).code, 0);
    await releaseHeld();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Second held edit/);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('L5-30/L5-31: frozen git edits wait, merge records still advance, and release keeps both versions', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    await gitEdit(path, '# Plan\n\nA conflicting git edit.\n');
    const frozen = await sync();
    assert.equal(frozen.result.exitCode, 0, frozen.result.stderr);
    assert.ok(frozen.report.sync?.skipped.some((entry) => entry.path === path && entry.reason === 'suspended'));
    assert.equal(frozen.report.sync?.record?.kind, 'merge');
    assert.match((await documentOf(path)).content ?? '', /Held Linear edit/);
    assert.doesNotMatch((await documentOf(path)).content ?? '', /conflicting git/);
    assert.match(await show(`${SUSPENDED}:${path}`), /Sync conflict: git version/);
    await releaseHeld();
    const gitText = await show(`refs/heads/main:${path}`);
    const linearText = (await documentOf(path)).content ?? '';
    for (const text of [gitText, linearText]) {
      assert.match(text, /Held Linear edit/);
      assert.match(text, /A conflicting git edit/);
      assert.equal(detectConflicts(text).length, 1);
    }
  });

  it('takes later Linear edits only into the suspended lane with one parent and a Linear-base', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const previous = await rev(SUSPENDED);
    await editInLinear(path, '# Plan\n\nA repaired Linear edit.\n');
    await sync();
    assert.equal(await rev(SYNC_BRANCH), h.normalValues.at(-2));
    const head = await rev(SUSPENDED);
    const parents = (await h.fixture.remote.text(['show', '-s', '--format=%P', head])).split(' ');
    assert.deepEqual(parents, [previous]);
    assert.match(await show(head), /Linear-base: [0-9a-f]+/);
    assert.match(await show(`${SUSPENDED}:${path}`), /A repaired Linear edit/);
    await releaseHeld();
    assert.match(await show(`refs/heads/main:${path}`), /A repaired Linear edit/);
  });

  it('keeps newly captured assets with their suspended document through intake and release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const url = 'https://uploads.linear.app/workspace/photo.png';
    const bytes = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));
    h.world.linear.uploads.push({ filename: 'photo.png', contentType: 'image/png', size: bytes.length, assetUrl: url, bytes });
    await editInLinear(path, `# Plan\n\nA repaired edit.\n\n![Photo](${url})\n`);
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    const captured = await show(`refs/mdbisync/linear:${path}`);
    const link = /!\[Photo\]\(<?([^)>]+)>?\)/.exec(captured)?.[1];
    assert.ok(link, captured);
    const asset = `eng/notes/${link}`;
    assert.deepEqual((await h.fixture.remote.run(['show', `${SUSPENDED}:${asset}`])).stdout, bytes);
    assert.ok((await show('refs/mdbisync/ids:ids.json')).includes(asset));
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `${SYNC_BRANCH}:${asset}`], { okCodes: [0, 128] })).code, 128);
    assert.match(await show(`${SYNC_BRANCH}:combined/guide.md`), /Independent edit/);
    checksOn(await rev(SUSPENDED), FAILED);
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${asset}`], { okCodes: [0, 128] })).code, 128);
    await releaseHeld();
    assert.deepEqual((await h.fixture.remote.run(['show', `refs/heads/main:${asset}`])).stdout, bytes);
    assert.match((await documentOf(path)).content ?? '', /Photo/);
  });

  it('L5-32: a suspended Linear deletion releases as a deletion, and a restore stays in the lane', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await sync();
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `${SUSPENDED}:${path}`], {okCodes:[0,128]})).code, 128);
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    checksOn(await rev(SUSPENDED), FAILED);
    const idle = await sync();
    assert.equal(idle.report.changed, false);
    document.trashed = false;
    touch(document);
    await sync();
    assert.match(await show(`${SUSPENDED}:${path}`), /Held Linear edit/);
    // Back from the trash, it shows the cross again, with the same one comment.
    assert.equal(document.icon, MARKS.suspended.icon);
    assert.equal(commentsOf(document).length, 1);
    document.trashed = true;
    touch(document);
    await sync();
    const released = await releaseHeld();
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], {okCodes:[0,128]})).code, 128);
    assert.equal(document.trashed, true);
    assert.equal((await ids())[path], undefined);
    // Released while in the trash: Linear refuses to resolve its comment, so the
    // release reports the refusal once and the comment stays as it is.
    assert.deepEqual(released.report.pullRequest?.holdMarks?.unresolved?.map(({ path: where }) => where), [path]);
    assert.equal(commentsOf(document).length, 1);
    assert.equal(commentsOf(document)[0]?.resolved, undefined);
  });

  it('L5-32: a comment Linear will not resolve on a released document in the trash is reported once and not tried again', async () => {
    const path = 'eng/notes/plan.md';
    const document = await suspendThenTrash(path);
    // The fake refuses as Linear does; the override only counts the requests.
    const resolve = onResolve(() => undefined);
    const released = await releaseHeld();
    const marks = released.report.pullRequest?.holdMarks;
    assert.equal(marks?.code, undefined);
    assert.deepEqual(marks?.unresolved?.map(({ path: where }) => where), [path]);
    assert.match(marks?.unresolved?.[0]?.error ?? '', /INPUT_ERROR/);
    assert.ok(released.summary.includes(`Linear refused to resolve the suspension comment of released documents: \`${path}\``), released.summary);
    assert.doesNotMatch(released.summary, /a later run goes on/);
    assert.equal(resolve.calls, 1);
    assert.equal((await ids())[path], undefined);
    assert.equal(commentsOf(document)[0]?.resolved, undefined);
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
    assert.equal(resolve.calls, 1, 'the refused comment was tried again');
  });

  it('a released comment a person deleted gives the document its own icon back and is reported once, without stalling later runs', async () => {
    const path = 'eng/notes/plan.md';
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    await suspendOne(path);
    const resolve = onResolve(() => linearAnswer(200, 'INPUT_ERROR'));
    const released = await releaseHeld();
    const marks = released.report.pullRequest?.holdMarks;
    assert.equal(marks?.code, undefined);
    assert.deepEqual(marks?.unresolved?.map(({ path: where }) => where), [path]);
    const document = await documentOf(path);
    assert.deepEqual({ icon: document.icon ?? null, color: document.color ?? null }, own);
    assert.equal('saved' in ((await ids())[path] as object), false);
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
    assert.equal(resolve.calls, 1, 'the refused comment was tried again');
  });

  it('a token refusal or a server failure while resolving a released comment in the trash is not final: the comment waits for a later run', async () => {
    const path = 'eng/notes/plan.md';
    const document = await suspendThenTrash(path);
    // A token refusal, then a server failure Linear reports with HTTP 200: neither is about the comment.
    const answers = [linearAnswer(401, 'AUTHENTICATION_ERROR'), linearAnswer(200, 'DEADLOCK_DETECTED')];
    let refused = true;
    const resolve = onResolve(() => (refused ? answers.shift() : undefined));
    checksOn(await rev(SUSPENDED), FAILED);
    await sync();
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(released.report.pullRequest?.holdMarks?.code, 'write-failed');
    assert.equal(released.report.pullRequest?.holdMarks?.unresolved, undefined);
    assert.ok(((await ids())[path] as { saved?: { hold?: unknown } } | undefined)?.saved?.hold !== undefined, 'the pending comment was forgotten');
    const again = await sync();
    assert.equal(again.report.pullRequest?.holdMarks?.code, 'write-failed');
    assert.equal(again.report.pullRequest?.holdMarks?.unresolved, undefined);
    // Then Linear answers about the comment itself: it refuses to resolve it
    // in the trash. That answer is final: reported once, not tried again.
    refused = false;
    const next = await sync();
    assert.equal(next.report.pullRequest?.holdMarks?.code, undefined);
    assert.deepEqual(next.report.pullRequest?.holdMarks?.unresolved?.map(({ path: where }) => where), [path]);
    assert.match(next.report.pullRequest?.holdMarks?.unresolved?.[0]?.error ?? '', /INPUT_ERROR/);
    assert.equal(commentsOf(document)[0]?.resolved, undefined);
    assert.equal((await ids())[path], undefined);
    assert.equal(resolve.calls, 3);
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
    assert.equal(resolve.calls, 3, 'the refused comment was tried again');
  });

  it('L5-32: a comment on a released document in the trash that Linear could not answer for yet is tried by the next run, which reports Linear\'s refusal', async () => {
    const path = 'eng/notes/plan.md';
    const document = await suspendThenTrash(path);
    let outage = true;
    const resolve = onResolve(() => (outage ? linearAnswer(500, 'INTERNAL_SERVER_ERROR') : undefined));
    checksOn(await rev(SUSPENDED), FAILED);
    await sync();
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(released.report.pullRequest?.holdMarks?.code, 'write-failed');
    assert.match(released.summary, /a later run goes on/);
    assert.equal(released.report.complete, false);
    // The release is recorded, and the comment's id stays until Linear answers about it.
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], { okCodes: [0, 128] })).code, 128);
    const kept = (await ids())[path] as { saved?: { hold?: unknown }; releaseBase?: unknown } | undefined;
    assert.ok(kept?.saved?.hold !== undefined, 'the pending comment was forgotten');
    assert.equal(kept?.releaseBase, undefined);
    outage = false;
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.equal(next.report.pullRequest?.holdMarks?.code, undefined);
    assert.deepEqual(next.report.pullRequest?.holdMarks?.unresolved?.map(({ path: where }) => where), [path]);
    assert.ok(next.summary.includes(`Linear refused to resolve the suspension comment of released documents: \`${path}\``), next.summary);
    assert.equal(commentsOf(document)[0]?.resolved, undefined);
    assert.equal(document.trashed, true);
    assert.equal((await ids())[path], undefined);
    assert.equal(resolve.calls, 2);
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
    assert.deepEqual(quiet.writes, []);
  });

  it('a released comment Linear could not resolve during an outage is resolved by the next run', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path);
    let outage = true;
    const resolve = onResolve(() => (outage ? linearAnswer(500, 'INTERNAL_SERVER_ERROR') : undefined));
    checksOn(await rev(SUSPENDED), FAILED);
    await sync();
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(released.report.pullRequest?.holdMarks?.code, 'write-failed');
    assert.match(released.summary, /a later run goes on/);
    assert.ok(((await ids())[path] as { saved?: { hold?: unknown } } | undefined)?.saved?.hold !== undefined, 'the pending comment was forgotten');
    outage = false;
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.deepEqual(next.report.pullRequest?.holdMarks?.cleared, [path]);
    assert.match(next.summary, /Suspended documents in Linear: 1 cleared\./);
    assert.equal(commentsOf(await documentOf(path))[0]?.resolved, true);
    assert.equal(resolve.calls, 2);
    const quiet = await sync();
    assert.equal(quiet.report.pullRequest?.holdMarks, undefined);
  });

  it("L5-35: a mark Linear refuses names the document and Linear's code and message, and the next run sets it", async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld Linear edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    let refuse = true;
    const marks = onMutation('UpdateDocument', () => (refuse ? refusal('Argument Validation Error: icon') : undefined));
    const held = await sync();
    assert.ok(held.report.pullRequest?.suspended);
    assert.equal(held.report.complete, false);
    const report = held.report.pullRequest?.holdMarks;
    assert.equal(report?.code, 'write-failed');
    assert.deepEqual(report?.failure, { operation: 'UpdateDocument', path, error: 'LinearGraphQLError INPUT_ERROR HTTP 200', code: 'INPUT_ERROR', status: 200, request: 'request-35', message: 'Argument Validation Error: icon' });
    assert.ok(held.summary.includes(`The suspended marks did not finish (\`write-failed\`, \`UpdateDocument\` on \`${path}\`, \`LinearGraphQLError INPUT_ERROR HTTP 200\`: Argument Validation Error: icon); a later run goes on.`), held.summary);
    assert.equal(marks.calls, 1);
    refuse = false;
    checksOn(await rev(SUSPENDED), FAILED);
    const next = await sync();
    assert.deepEqual(next.report.pullRequest?.holdMarks?.set, [path]);
    assert.equal(next.report.pullRequest?.holdMarks?.failure, undefined);
    assert.equal((await documentOf(path)).icon, MARKS.suspended.icon);
  });

  it("a comment Linear refuses with a message that echoes the comment keeps the code and leaves the message out", async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld Linear edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    let refuse = true;
    onMutation('CommentOnDocument', () => (refuse ? refusal(`Variable "$input" got invalid value { body: "${HOLD_FAILED}" }`) : undefined));
    const held = await sync();
    const report = held.report.pullRequest?.holdMarks;
    assert.equal(report?.code, 'write-failed');
    assert.equal(report?.failure?.path, path);
    assert.equal(report?.failure?.code, 'INPUT_ERROR');
    assert.equal(report?.failure?.message, MESSAGE_WITHHELD);
    for (const text of [held.summary, JSON.stringify(held.report)]) assert.ok(!text.includes(HOLD_FAILED.slice(0, 40)), 'the comment was quoted');
    refuse = false;
    checksOn(await rev(SUSPENDED), FAILED);
    const next = await sync();
    assert.deepEqual(next.report.pullRequest?.holdMarks?.set, [path]);
    assert.equal(commentsOf(await documentOf(path)).length, 1);
  });
});
