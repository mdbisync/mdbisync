// Linear edits captured into one pull request and merged without losing front matter.

import assert from 'node:assert/strict';
import { SYNC_PULL_REQUEST_TITLE } from './pull-request.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, MANY, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request capture', () => {
  const h = pullRequestHarness();
  const { sync, rev, show, editInLinear, checksOn, openPullRequests } = h;

  it('merges titles containing reserved GitHub folders alongside ordinary edits', async () => {
    const titles = ['.github/x', '.GitHub/workflows/notes', 'nested/.GITHUB/page'];
    for (const [index, title] of titles.entries()) {
      h.world.linear.documents.push({ id: `new-${index}`, title, projectId: 'project-api', content: 'New page.\n', createdAt: '2026-01-02T00:00:00Z' });
    }
    const renamed = await h.documentOf('combined/guide.md');
    renamed.title = '.github/guide';
    await editInLinear('combined/guide.md', '# Guide\n\nRenamed page.\n');
    await editInLinear('eng/notes/plan.md', '# Plan\n\nOrdinary edit.\n');
    const first = await sync();
    assert.equal(first.result.exitCode, 0, JSON.stringify(first.report));
    const paths = (await h.fixture.remote.text(['ls-tree', '-r', '--name-only', SYNC_BRANCH])).split('\n');
    assert.ok(!paths.some((path) => path.split('/').some((part) => part.toLowerCase() === '.github')), paths.join(', '));
    const merged = await sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.equal(h.world.github.pullRequests[0]?.merged, true);
    for (const path of ['%2Egithub/x', '%2EGitHub/workflows/notes', 'nested/%2EGITHUB/page']) assert.equal(await show(`refs/heads/main:eng/notes/${path}.md`), 'New page.\n');
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Ordinary edit/);
    assert.match(await show('refs/heads/main:combined/%2Egithub/guide.md'), /Renamed page/);
    await h.settle();
    assert.equal(renamed.title, '.github/guide');
  });

  it('keeps tracked GitHub templates in place while ordinary edits merge', async () => {
    const template = 'eng/notes/.github/pull_request_template.md';
    await h.gitEdit(template, 'Template.\n');
    await h.settle();
    const document = await h.documentOf(template);
    assert.equal(document.title, '.github/pull_request_template');
    await editInLinear('eng/notes/plan.md', '# Plan\n\nOrdinary edit.\n');
    await h.settle();
    assert.equal(await show(`refs/heads/main:${template}`), 'Template.\n');
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Ordinary edit/);
    assert.equal((await h.ids())[template]?.id, document.id);
    assert.ok(!Object.keys(await h.ids()).some((path) => path.includes('%2Egithub')));
  });

  it('L2-20: a Linear edit reaches the tracked branch through the sync pull request, merged with a merge commit, front matter kept', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps one, two and three. ${CANARY}\n`);

    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.writes, ['POST /pulls'], 'the first run opens the pull request and writes nothing to Linear');
    const [pr] = h.world.github.pullRequests;
    assert.ok(pr !== undefined);
    assert.deepEqual({ head: pr.head, base: pr.base, title: pr.title, state: pr.state }, { head: 'mdbisync/linear', base: 'main', title: SYNC_PULL_REQUEST_TITLE, state: 'open' });
    assert.match(pr.body, /eng\/notes\/plan\.md/);
    assert.equal(await rev('refs/heads/main'), h.start, 'the tracked branch moved before the merge');
    assert.equal(first.report.pullRequest?.pullRequest?.opened, true);
    assert.match(first.summary, /Opened the sync pull request/);

    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.deepEqual(second.writes, ['PUT /pulls/1/merge']);
    assert.equal(pr.merged, true);
    const main = await rev('refs/heads/main');
    assert.equal((await h.fixture.remote.text(['show', '-s', '--format=%P', main])).split(' ').length, 2, 'not a merge commit');
    assert.equal(await show('refs/heads/main:eng/notes/plan.md'), `---\nowner: example\n---\n\n# Plan\n\nSteps one, two and three. ${CANARY}\n`);
    assert.match(second.summary, /Merged the sync pull request with a merge commit/);
  });

  it('L2-34: the run started by the merge writes nothing and opens no pull request', async () => {
    await editInLinear('eng/backend/notes.md', `# Notes\n\nFirst paragraph.\n\nSecond paragraph, longer. ${CANARY}\n`);
    await sync();
    await sync();
    assert.equal(h.world.github.pullRequests[0]?.merged, true);

    const linearWrites = h.world.linear.writes.count;
    const after = await sync();
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.deepEqual(after.writes, []);
    assert.equal(h.world.linear.writes.count, linearWrites, 'the run after the merge wrote to Linear');
    assert.equal(h.world.github.pullRequests.length, 1);
    assert.match(after.summary, /no pull request is needed/);
    assert.equal(after.report.pullRequest?.needed, false);

    const again = await sync();
    assert.deepEqual(again.writes, []);
    assert.equal(h.world.github.pullRequests.length, 1);
  });

  it('L2-31: edits to many documents in two teams arrive in one pull request, merged once', async () => {
    for (let i = 0; i < MANY; i += 1) {
      await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nDone. ${CANARY}\n`);
      await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nPublished. ${CANARY}\n`);
    }
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(first.report.pullRequest?.paths.length, 2 * MANY);
    const second = await sync();
    assert.deepEqual(second.writes, ['PUT /pulls/1/merge']);
    assert.equal(h.world.github.pullRequests.length, 1);
    const merges = (await h.fixture.remote.text(['rev-list', '--merges', `${h.start}..refs/heads/main`])).split('\n').filter(Boolean);
    assert.equal(merges.length, 1);
    for (let i = 0; i < MANY; i += 1) {
      assert.match(await show(`refs/heads/main:eng/notes/item-${i}.md`), /Done\./);
      assert.match(await show(`refs/heads/main:combined/page-${i}.md`), /Published\./);
    }
  });

  it('L2-32: new edits while the pull request waits for checks join its branch; one pull request, never force-pushed', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps one and two, reviewed. ${CANARY}\n`);
    await sync();
    const firstHead = await rev(SYNC_BRANCH);
    checksOn(firstHead, [{ name: 'lint', status: 'in_progress' }]);

    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.deepEqual(waiting.writes, [], 'a run merged or changed something while checks ran');
    assert.match(waiting.summary, /waits for `lint`/);
    assert.deepEqual(waiting.report.pullRequest?.checks?.pending, ['lint']);

    await editInLinear('combined/guide.md', `# Guide\n\nHow to start, step by step. ${CANARY}\n`);
    const joined = await sync();
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    const secondHead = await rev(SYNC_BRANCH);
    assert.notEqual(secondHead, firstHead);
    assert.equal(openPullRequests().length, 1);
    assert.equal(h.world.github.pullRequests.length, 1);
    assert.equal(joined.report.pullRequest?.branchMoved, true);
    assert.ok(!joined.writes.includes('PUT /pulls/1/merge'), 'merged a head whose checks had not run');
    assert.match(h.world.github.pullRequests[0]?.body ?? '', /combined\/guide\.md/);

    checksOn(secondHead, [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
      { name: 'ci/external', status: 'completed', conclusion: 'success', commitStatus: true },
    ]);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /reviewed/);
    assert.match(await show('refs/heads/main:combined/guide.md'), /step by step/);
  });
});
