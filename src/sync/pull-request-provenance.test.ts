// What the sync merges: only changes to synchronized documents and their assets reach the tracked branch through
// the sync pull request, whoever added the commits to the sync branch.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request head check', () => {
  const h = pullRequestHarness();
  const { sync, rev, editInLinear, checksOn, editRef, commitFile, suspendOne } = h;
  const SUSPENDED = 'refs/heads/mdbisync/suspended';

  const passing = (head: string) => checksOn(head, [{ name: 'ci', status: 'completed', conclusion: 'success' }]);
  const onMain = async (path: string) => (await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], { okCodes: [0, 128] })).code === 0;

  for (const path of ['.github/workflows/release.yml', 'eng/.github/workflows/release.yml', 'tools/build.sh', 'eng/notes/build.sh']) {
    it(`a commit on the sync branch that changes ${path} is not merged: the pull request waits for a person`, async () => {
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      const opened = await sync();
      assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
      const pushed = await editRef(SYNC_BRANCH, path, 'echo changed\n', 'Add a build step');
      passing(pushed);

      const run = await sync();
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      assert.match(run.result.stderr, /head-unverified/);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(run.report.pullRequest?.code, 'head-unverified');
      assert.deepEqual(run.report.pullRequest?.unverified, [path]);
      assert.ok(run.report.pullRequest?.pullRequest, 'the pull request stays open');
      assert.ok(!run.writes.some((write) => write.endsWith('/merge')), run.writes.join('\n'));
      assert.match(run.summary, /a person reviews and merges it/);
      assert.equal(await onMain(path), false);
      assert.equal(await rev(SYNC_BRANCH), pushed, 'the sync branch keeps the commit');

      // Later runs keep waiting; a person's merge ends it.
      const again = await sync();
      assert.equal(again.report.pullRequest?.code, 'head-unverified');
      assert.ok(!again.writes.some((write) => write.endsWith('/merge')));
    });
  }

  it("a commit on the sync branch that changes a folder's Linear team is not merged", async () => {
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    await sync();
    const pushed = await editRef(SYNC_BRANCH, 'eng/README.md', '---\nlinear-team: OPS\n---\n\n# Engineering\n', 'Move the folder');
    passing(pushed);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, 'head-unverified');
    assert.deepEqual(run.report.pullRequest?.unverified, ['eng/README.md']);
    assert.match(await h.fixture.remote.text(['show', 'refs/heads/main:eng/README.md']), /linear-team: ENG/);
  });

  it('a commit on the sync branch that edits a synchronized document is merged, as a CI fix is', async () => {
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    await sync();
    const pushed = await editRef(SYNC_BRANCH, 'eng/notes/plan.md', '# Plan\n\nFixed by CI.\n', 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix');
    passing(pushed);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, undefined, JSON.stringify(run.report.pullRequest));
    assert.ok(run.report.pullRequest?.merged);
  });

  for (const replacement of ['a regular file', 'nothing'] as const) {
    it(`a commit on the sync branch that replaces a symbolic link named like a document with ${replacement} is not merged`, async () => {
      const path = 'eng/notes/link.md';
      const main = await rev('refs/heads/main');
      const target = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: 'plan.md' });
      const linked = await commitFile(main, path, target, undefined, 'Link the plan', '120000');
      await h.fixture.remote.run(['update-ref', 'refs/heads/main', linked, main]);
      h.start = linked;
      await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
      await sync();
      const head = await rev(SYNC_BRANCH);
      const blob = replacement === 'nothing' ? null : await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: '# Link\n\nReplaced.\n' });
      const pushed = await commitFile(head, path, blob, undefined, 'Replace the link');
      await h.fixture.remote.run(['update-ref', SYNC_BRANCH, pushed, head]);
      h.syncValues.push(pushed);
      passing(pushed);

      const run = await sync();
      assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, run.result.stderr);
      assert.equal(run.report.pullRequest?.code, 'head-unverified');
      assert.deepEqual(run.report.pullRequest?.unverified, [path]);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.ok(!run.writes.some((write) => write.endsWith('/merge')), run.writes.join('\n'));
      assert.equal((await h.fixture.remote.text(['ls-tree', 'refs/heads/main', '--', path])).split(' ')[0], '120000', 'the link stays on the tracked branch');
    });
  }

  it('a commit on the sync branch that reverts a tracked-branch change outside the documents is not merged', async () => {
    await editRef('refs/heads/main', '.github/workflows/ci.yml', 'safe: true\n', 'Add CI');
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    await sync();
    // A merge of the tracked branch that takes the workflow back: each file comes from one of its parents.
    const head = await rev(SYNC_BRANCH);
    const old = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: 'safe: false\n' });
    const pushed = await commitFile(head, '.github/workflows/ci.yml', old, await rev('refs/heads/main'), 'Merge the tracked branch into the sync branch');
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, pushed, head]);
    h.syncValues.push(pushed);
    passing(pushed);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, 'head-unverified');
    assert.deepEqual(run.report.pullRequest?.unverified, ['.github/workflows/ci.yml']);
    assert.equal(await h.fixture.remote.text(['show', 'refs/heads/main:.github/workflows/ci.yml']), 'safe: true');
  });

  it('a commit on the suspended branch that changes a workflow is not merged with the suspended batch', async () => {
    await suspendOne();
    const path = '.github/workflows/release.yml';
    const pushed = await editRef(SUSPENDED, path, 'echo changed\n', 'Add a build step');
    passing(pushed);
    const run = await sync();
    assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, JSON.stringify(run.report.pullRequest));
    assert.equal(run.report.pullRequest?.suspended?.code, 'head-unverified');
    assert.deepEqual(run.report.pullRequest?.suspended?.unverified, [path]);
    assert.equal(run.report.pullRequest?.suspended?.released, undefined);
    assert.ok(!run.writes.some((write) => write.endsWith('/merge')), run.writes.join('\n'));
    assert.match(run.summary, /The suspended pull request also changes files/);
    assert.equal(await onMain(path), false);
  });

  it('a failing normal batch cannot push a join with a suspended head outside the documents', async () => {
    await suspendOne();
    const path = '.github/workflows/release.yml';
    const pushed = await editRef(SUSPENDED, path, 'echo changed\n', 'Add a build step');
    checksOn(pushed, [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    assert.equal((await sync()).report.pullRequest?.suspended?.code, 'head-unverified');
    await editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    const normal = await rev(SYNC_BRANCH);
    const suspended = await rev(SUSPENDED);
    const run = await sync();
    assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, JSON.stringify(run.report.pullRequest));
    assert.equal(run.report.pullRequest?.suspended?.batchFailure, undefined, 'the unsafe join must not be published');
    assert.equal(await rev(SYNC_BRANCH), normal);
    assert.equal(await rev(SUSPENDED), suspended);
    assert.deepEqual(run.report.pullRequest?.suspended?.unverified, [path]);
    const held = h.world.github.pullRequests.find((pr) => pr.head === 'mdbisync/suspended' && pr.state === 'open');
    assert.match(held?.body ?? '', /The sync does not merge this pull request: .*`\.github\/workflows\/release\.yml`/);
  });

  for (const lane of ['normal', 'suspended']) it(`does not push a new ${lane} head that carries an existing workflow edit`, async () => {
    if (lane === 'suspended') await suspendOne();
    else {
      await editInLinear('combined/guide.md', '# Guide\n\nA first edit.\n');
      await sync();
    }
    const branch = lane === 'normal' ? SYNC_BRANCH : SUSPENDED;
    const path = '.github/workflows/example.yml';
    const head = await editRef(branch, path, 'name: Example\n');
    await editInLinear(lane === 'normal' ? 'combined/guide.md' : 'eng/notes/plan.md', '# Page\n\nA later edit.\n');
    const run = await sync();
    const result = lane === 'normal' ? run.report.pullRequest : run.report.pullRequest?.suspended;
    assert.equal(result?.code, 'head-unverified');
    assert.deepEqual(result?.unverified, [path]);
    assert.equal(await rev(branch), head, 'no new tree outside the document scope may be pushed');
    let pr = h.openPullRequests().find(pr => `refs/heads/${pr.head}` === branch)!;
    assert.match(pr.body, /The sync does not merge this pull request:/);
    await editRef(branch, 'tools/example.sh', 'echo example\n');
    await sync();
    assert.equal((pr.body.match(/The sync does not merge this pull request:/g) ?? []).length, 1);
    assert.match(pr.body, /tools\/example.sh/);
    pr.state = 'closed';
    await editRef(branch, 'tools/other.sh', 'echo other\n');
    await sync();
    pr = h.openPullRequests().find(pr => `refs/heads/${pr.head}` === branch)!;
    assert.ok(pr, 'a closed pull request is replaced for the existing unsafe branch');
    assert.equal((pr.body.match(/The sync does not merge this pull request:/g) ?? []).length, 1);
    assert.match(pr.body, /tools\/example.sh/);
  });

  it('releases a merged suspended batch without pushing an unsafe normal head', async () => {
    await suspendOne();
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    await sync();
    const normal = await editRef(SYNC_BRANCH, '.github/workflows/example.yml', 'name: Example\n');
    passing(await rev(SUSPENDED));
    const run = await sync();
    assert.ok(run.report.pullRequest?.suspended?.released, 'the already merged batch must be released');
    assert.equal(await rev(SYNC_BRANCH), normal);
    assert.doesNotMatch(await h.show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    assert.match(await h.show('refs/heads/main:eng/notes/plan.md'), /Held Linear edit/);
  });

  it('a commit on a failing suspended branch is reported at once, its file named in the description, and the normal lane does not wait for it', async () => {
    await suspendOne();
    const path = '.github/workflows/release.yml';
    const pushed = await editRef(SUSPENDED, path, 'echo changed\n', 'Add a build step');
    checksOn(pushed, [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    const run = await sync();
    assert.equal(run.result.exitCode, SETUP_FAILED_EXIT_CODE, JSON.stringify(run.report.pullRequest));
    assert.equal(run.report.pullRequest?.suspended?.code, 'head-unverified');
    assert.equal(run.report.pullRequest?.suspended?.failure, undefined, 'no check failure is pinned on its documents');
    assert.notEqual(run.report.pullRequest?.suspended?.waiting, true);
    const held = h.world.github.pullRequests.find((pr) => pr.head === 'mdbisync/suspended' && pr.state === 'open');
    assert.match(held?.body ?? '', /The sync does not merge this pull request: .*`\.github\/workflows\/release\.yml`/);
  });
});
