// A suspended lane an older version captured: the documents are read again
// by the running version and leave the lane when they are what git holds.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signTip } from '../state/test-helpers.ts';
import { VERSION } from '../version.ts';
import { pullRequestHarness } from './pull-request-test-helpers.ts';

describe('sync: a suspended lane an older version captured', () => {
  const h = pullRequestHarness();
  const { sync, show, rev, suspendOne, gitEdit, editRef, documentOf, SUSPENDED, checksOn, PASSED, FAILED } = h;
  const path = 'eng/notes/plan.md';
  // Linear's export: three plus signs before text, with a nested list below them.
  const linear = '# Plan\n\n1. Week\n   1. +++Plan\n      1. First step\n';
  // fix's form of the same document.
  const fixed = '# Plan\n\n1. Week\n   1. \\+++Plan\n      1. First step\n';

  /** Puts the lane back to what an older version recorded: Linear's spelling as it came, and no version on the entry. */
  async function asCapturedByAnOlderVersion(text: string) {
    await editRef('refs/mdbisync/linear', path, text, 'Sync: older capture');
    await signTip(h.fixture.remote);
    const ids = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, Record<string, unknown>>;
    delete ids[path]!.capturedWith;
    await editRef('refs/mdbisync/ids', 'ids.json', `${JSON.stringify(ids, null, 2)}\n`, 'Sync: older ids');
  }

  it('reads a document again and lets it go once it reads back as what git holds', async () => {
    await suspendOne(path, linear);
    // Git takes fix's form of the same document, as a person fixing the lane's lint finding would; Linear does not change.
    await gitEdit(path, fixed);
    await asCapturedByAnOlderVersion(linear);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), fixed, "the running version reads Linear's text as git's");
    assert.equal(await show(`${SUSPENDED}:${path}`), fixed, 'the lane holds what git holds');
    const ids = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, Record<string, unknown>>;
    assert.equal(ids[path]?.capturedWith, VERSION);
    // Read once: the next run takes nothing new.
    const quiet = await sync();
    assert.deepEqual(quiet.report.capture?.changed, []);
    // The lane's checks now pass, and it releases.
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.deepEqual(released.report.pullRequest?.holdMarks?.cleared, [path]);
    assert.equal(await show(`refs/heads/main:${path}`), fixed);
    assert.equal((await documentOf(path)).content, linear, 'Linear keeps its own spelling of the same document');
  });

  it('lets a document go whose emoji Linear exports as its shortcode', async () => {
    // Linear can export an emoji added in its editor as its shortcode.
    const shortcode = '# Plan\n\n[:spiral_calendar_pad:](<https://example.com/img/calendar.png>) Week\n';
    const emoji = '# Plan\n\n[🗓️](<https://example.com/img/calendar.png>) Week\n';
    await suspendOne(path, shortcode);
    await gitEdit(path, emoji);
    await asCapturedByAnOlderVersion(shortcode);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), emoji, "the shortcode reads as git's emoji");
    assert.equal(await show(`${SUSPENDED}:${path}`), emoji);
    const quiet = await sync();
    assert.deepEqual(quiet.report.capture?.changed, [], 'no change on the next read');
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(await show(`refs/heads/main:${path}`), emoji);
  });

  it('keeps a document suspended when Linear holds another document than git', async () => {
    await suspendOne(path, linear);
    const other = '# Plan\n\n1. Week\n   1. A step git rewrote\n';
    await gitEdit(path, other);
    await asCapturedByAnOlderVersion(linear);
    await sync();
    // The older reading stays recorded: the newer one is not git's text either, and a person resolves the document.
    assert.equal(await show(`refs/mdbisync/linear:${path}`), linear);
    const held = await show(`${SUSPENDED}:${path}`);
    assert.match(held, /Sync conflict: git version[\s\S]*A step git rewrote[\s\S]*Sync conflict: Linear version/);
    assert.notEqual(held, other, 'the lane still differs from the tracked branch');
  });
  it('reads nothing again on the run after a suspension by the running version', async () => {
    await suspendOne(path, linear);
    const ids = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, Record<string, unknown>>;
    assert.equal(ids[path]?.capturedWith, VERSION, 'the suspension notes the version that read the batch');
    const recorded = await show(`refs/mdbisync/linear:${path}`);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.capture?.changed, []);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), recorded);
  });

  it("keeps a person's commit on the suspended branch where the reading converges", async () => {
    await suspendOne(path, linear);
    await gitEdit(path, fixed);
    // A person fixes the document on the suspended branch, after the sync's last push there.
    const personal = '# Plan\n\n1. Week\n   1. \\+++Plan\n      1. First step, fixed on the branch\n';
    await editRef(SUSPENDED, path, personal, 'Fix the plan on the branch');
    checksOn(await rev(SUSPENDED), FAILED);
    await asCapturedByAnOlderVersion(linear);
    await sync();
    assert.equal(await show(`refs/mdbisync/linear:${path}`), fixed, 'the newer reading is recorded');
    assert.match(await show(`${SUSPENDED}:${path}`), /fixed on the branch/, "the person's edit stays in the lane");
  });

  it("converges on the tracked branch's file when only its front matter differs", async () => {
    await suspendOne(path, linear);
    const withHead = `---\nowner: example\n---\n\n${fixed}`;
    await gitEdit(path, withHead);
    await asCapturedByAnOlderVersion(linear);
    await sync();
    assert.equal(await show(`${SUSPENDED}:${path}`), withHead, "the lane takes the tracked branch's file with its front matter");
  });
});
