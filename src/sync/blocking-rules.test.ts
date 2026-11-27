// Which findings hold a file back: only a lint finding that Linear would corrupt
// holds a file back; a minor loss of formatting is written, and comes back
// from Linear as a change.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY } from './pull-request-test-helpers.ts';

const LINEAR_RECORD = 'refs/mdbisync/linear';
const PLAN = 'eng/notes/plan.md';
const GUIDE = 'combined/guide.md';
const aligned = (owner: string) => `---\nowner: example\n---\n\n# Plan\n\n| Step | Owner |\n| :-- | --: |\n| Plan | ${owner} ${CANARY} |\n`;

describe('sync: which findings hold a file back', () => {
  const h = pullRequestHarness();
  const { sync, show, documentOf, editRef, settle } = h;
  // As Linear stores a table: it drops the column alignment.
  const dropAlignment = () => {
    h.world.linear.store = (content) => content.replace(/^\| :-- \| --: \|$/gm, '| -- | -- |');
  };

  it('writes a file whose findings only lose formatting, and holds back one Linear would corrupt, in the same run; the loss comes back in the sync pull request', async () => {
    dropAlignment();
    const before = (await documentOf(GUIDE)).content;
    await editRef('refs/heads/main', PLAN, aligned('Team'));
    await editRef('refs/heads/main', GUIDE, `# Guide\n\nHow to start.[^1] ${CANARY}\n\n[^1]: A note.\n`);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.sync?.updated, [PLAN]);
    assert.match((await documentOf(PLAN)).content ?? '', /\| -- \| -- \|/);
    assert.deepEqual(run.report.sync?.leftOut, [{ path: GUIDE, rules: ['footnote'] }]);
    assert.equal((await documentOf(GUIDE)).content, before);

    // Linear's form reaches the tracked branch through the sync pull request, and nothing is written again.
    const quiet = await settle();
    assert.deepEqual(quiet.writes, []);
    assert.match(await show(`refs/heads/main:${PLAN}`), /\| -- \| -- \|/);
    assert.deepEqual(quiet.report.sync?.leftOut, [{ path: GUIDE, rules: ['footnote'] }]);
  });

  it('writes a file an earlier release left out for a construct Linear drops, though its version is already recorded', async () => {
    dropAlignment();
    const held = (await documentOf(PLAN)).content;
    // An earlier release held the file back for its alignment and recorded the tracked branch's version anyway.
    const tracked = await editRef('refs/heads/main', PLAN, aligned('Team'));
    await editRef(LINEAR_RECORD, PLAN, aligned('Team'), 'Record', tracked);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.sync?.updated, [PLAN], JSON.stringify({ sync: run.report.sync, pr: run.report.pullRequest, capture: run.report.capture }));
    assert.notEqual((await documentOf(PLAN)).content, held);
    assert.match((await documentOf(PLAN)).content ?? '', /\| Plan \| Team /);

    // A later edit in git is written too, not taken for an edit in Linear.
    await settle();
    await editRef('refs/heads/main', PLAN, aligned('Ops'));
    const next = await sync();
    assert.deepEqual(next.report.sync?.updated, [PLAN]);
    assert.match((await documentOf(PLAN)).content ?? '', /\| Plan \| Ops /);
  });
});
