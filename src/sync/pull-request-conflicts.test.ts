// Branch history, pending edits, and conflict resolutions kept through later sync runs.

import assert from 'node:assert/strict';
import { detectConflicts, MARKERS } from '../merge/index.ts';
import { MARKS } from './marks.ts';
import { touch } from '../setup/test-helpers.ts';
import { INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, PRE_COMMIT, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request conflicts', () => {
  const h = pullRequestHarness();
  const {
    sync, rev, show, ids, documentOf, editInLinear, checksOn, openPullRequests, editRef, PLAN, planText, BRANCH_EDIT, LATER_EDIT, settle, assertOneConflict, isAncestorOn, pendingBranchEdit, commitFile,
  } = h;

  for (const reviewed of [false, true]) it(`a record left on the sync branch by a closed pull request is not carried into the next sync pull request (reviewed: ${reviewed})`, async () => {
    const main = await rev('refs/heads/main');
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAbandoned text. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await h.fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    const review = reviewed ? await commitFile(record, 'combined/guide.md', blob) : record;
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, review]);
    h.syncValues.push(review);
    h.world.github.pullRequests.push({ number: 1, title: 'Initial sync from Linear', body: '', head: 'mdbisync/linear', base: 'main', state: 'closed', merged: false });
    await editInLinear('eng/notes/plan.md', `# Plan\n\nCarried. ${CANARY}\n`);

    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.report.pullRequest?.paths, ['eng/notes/plan.md']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/2/merge'], JSON.stringify(merged.report.pullRequest));
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Carried\./);
    assert.doesNotMatch(await show('refs/heads/main:combined/guide.md'), /Abandoned/);
  });

  it('a sync branch holding an initial sync from Linear that changed nothing is reused', async () => {
    // Such a record needed no pull request, so the tracked branch never merges it.
    const main = await rev('refs/heads/main');
    const record = await h.fixture.remote.text(['commit-tree', `${main}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, record]);
    h.syncValues.push(record);
    await editInLinear('eng/notes/plan.md', `# Plan\n\nReused. ${CANARY}\n`);
    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Reused\./);
  });

  it('a commit status that fails counts as a failed check', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nAnother step. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci/external', status: 'completed', conclusion: 'error', commitStatus: true }]);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.deepEqual(failed.report.pullRequest?.checks?.failed, ['ci/external']);
    assert.ok(failed.report.pullRequest?.suspended);
  });

  it('L2-33: merges CI fixes, writes the stable file next run, and names the hook of a rejected fix', async () => {
    const stable = 'eng/notes/plan.md';
    const unstable = 'combined/guide.md';
    await editInLinear(stable, '# Plan\n\nReady for review.\n');
    await sync();
    const before = (await documentOf(unstable)).content;
    const fixed = '---\nowner: example\n---\n\n# Plan\n\nReviewed and corrected.\n';
    await editRef(SYNC_BRANCH, stable, fixed, 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix');
    const last = await editRef(SYNC_BRANCH, unstable, '# Guide\n\n| Check | Result |\n| :-- | --: |\n| Format | Ready |\n', 'Apply pre-commit fixes\n\nPre-commit-fix: aligned-table\nPre-commit-fix: unknown-output');
    checksOn(last, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
    assert.deepEqual(merged.writes.filter((write) => !write.startsWith('PATCH /pulls/')), ['PUT /pulls/1/merge']);
    const written = await sync();
    assert.equal(written.result.exitCode, 0, written.result.stderr);
    assert.deepEqual(written.report.sync?.updated, [stable]);
    assert.equal((await documentOf(stable)).content, '# Plan\n\nReviewed and corrected.\n');
    assert.equal((await documentOf(unstable)).content, before);
    assert.deepEqual(written.report.sync?.leftOut, [{ path: unstable, rules: ['table-alignment'], hooks: ['aligned-table'] }]);
    assert.match(written.summary, /CI fixes not written/);
    assert.match(written.summary, /aligned-table/);
    assert.doesNotMatch(written.summary, /unknown-output/);
    // Later runs neither repeat the write nor lose the diagnostic.
    for (let n = 0; n < 2; n++) {
      const quiet = await sync();
      assert.deepEqual(quiet.writes, []);
      assert.match(quiet.summary, /aligned-table/);
    }
  });

  it('a revert on a closed sync branch reaches Linear through a history-only merge', async () => {
    const path = 'eng/notes/plan.md';
    const original = await show(`refs/heads/main:${path}`);
    await editInLinear(path, `# Plan\n\nChanged in Linear. ${CANARY}\n`);
    await sync();
    const commit = await editRef(SYNC_BRANCH, path, original);
    const first = h.world.github.pullRequests[0];
    assert.ok(first);
    first.state = 'closed';
    const opened = await sync();
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    assert.deepEqual(opened.report.pullRequest?.paths, []);
    await sync();
    await sync();
    const quiet = await sync();
    assert.equal(quiet.report.changed, false);
    assert.equal((await documentOf(path)).content, original.slice(original.indexOf('# ')));
    assert.equal((await h.fixture.remote.run(['merge-base', '--is-ancestor', commit, 'refs/heads/main'], { okCodes: [0, 1] })).code, 0);
  });

  for (const state of ['open', 'closed'] as const) for (const side of ['linear', 'tracked'] as const) {
    it(`MDS-011-2C: a pending sync-branch edit conflicting with a later ${side} edit, pull request ${state}: both versions kept between markers, then both sides converge`, async () => {
      const commit = await pendingBranchEdit(state);
      if (side === 'linear') await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
      else await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));

      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.equal(run.report.pullRequest?.code, undefined, JSON.stringify(run.report.pullRequest));
      assert.deepEqual(run.report.pullRequest?.marked, [PLAN]);
      assert.equal(run.report.pullRequest?.branchMoved, true);
      assert.ok(run.report.pullRequest?.paths.includes(PLAN));
      assert.match(run.summary, /Both versions are kept between conflict markers/);
      assert.equal(h.world.github.pullRequests.length, state === 'open' ? 1 : 2);
      assert.equal(openPullRequests().length, 1);
      assert.equal(openPullRequests()[0]?.head, h.world.github.pullRequests[0]?.head);
      // The branch keeps the person's commit and gains a merge holding both versions: the git version is the
      // git-side edit (the branch's against Linear, the tracked branch's against the branch).
      assert.ok(await isAncestorOn(commit, SYNC_BRANCH), 'the sync branch lost the pending commit');
      const head = await rev(SYNC_BRANCH);
      assert.equal((await h.fixture.remote.text(['rev-parse', `${head}^@`])).split('\n').length, 2, 'the reconciliation is not a merge commit');
      const [git, linear] = side === 'linear' ? [BRANCH_EDIT, LATER_EDIT.linear] : [LATER_EDIT.tracked, BRANCH_EDIT];
      assertOneConflict(await show(`${SYNC_BRANCH}:${PLAN}`), git, linear);
      assert.match(await show(`${SYNC_BRANCH}:${PLAN}`), /^---\nowner: example\n---\n/, 'front matter was lost');
      // Linear's state ref holds only what Linear returned: no intended content, no markers yet.
      assert.ok(!(await show(`refs/mdbisync/linear:${PLAN}`)).includes(MARKERS.git), "markers reached Linear's state before Linear held them");

      const quiet = await settle();
      assert.deepEqual(quiet.writes, []);
      const tracked = await show(`refs/heads/main:${PLAN}`);
      assertOneConflict(tracked, git, linear);
      const document = await documentOf(PLAN);
      assert.equal(document.content, tracked.slice(tracked.indexOf('# ')), 'Linear and the tracked branch differ (I1)');
      assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);
      assert.ok(await isAncestorOn(commit, 'refs/heads/main'), 'the tracked branch lost the pending commit');
      assert.ok(await isAncestorOn(head, 'refs/heads/main'), 'the tracked branch lost the reconciliation');
      assert.equal(openPullRequests().length, 0);
      assert.match(await show('refs/heads/main:combined/guide.md'), /edited in Linear/);
    });
  }

  it('MDS-011-2C: a sync-branch edit conflicting with both a tracked edit and a Linear edit of the same paragraph converges, all three kept', async () => {
    await editInLinear(PLAN, `# Plan\n\nChanged in Linear. ${CANARY}\n`);
    await sync();
    const commit = await editRef(SYNC_BRANCH, PLAN, planText(BRANCH_EDIT));
    await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    await settle();
    const tracked = await show(`refs/heads/main:${PLAN}`);
    for (const text of [BRANCH_EDIT, LATER_EDIT.tracked, LATER_EDIT.linear]) assert.ok(tracked.includes(text), `the edit "${text}" was lost (I2)`);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    assert.ok(await isAncestorOn(commit, 'refs/heads/main'));
    assert.ok(tracked.split(MARKERS.git).length <= 2, 'markers are nested or repeated');
  });

  for (const [change, branchFile, expected] of [
    ['edit', planText(BRANCH_EDIT).replace('owner: example', 'owner: reviewer'), /^---\nowner: reviewer\n---\n/],
    ['removal', `# Plan\n\n${BRANCH_EDIT} ${CANARY}\n`, /^# Plan\n/],
  ] as const) {
    it(`MDS-011-2C: a front matter ${change} pending on the sync branch survives a merge with a conflicting tracked edit`, async () => {
      await pendingBranchEdit('open');
      await editRef(SYNC_BRANCH, PLAN, branchFile);
      await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
      const run = await sync();
      assert.deepEqual(run.report.pullRequest?.marked, [PLAN]);
      await settle();
      const tracked = await show(`refs/heads/main:${PLAN}`);
      assert.match(tracked, expected, `the pending front matter ${change} was lost`);
      assertOneConflict(tracked, LATER_EDIT.tracked, BRANCH_EDIT);
    });
  }

  it('MDS-011-2C: a Linear title change and rewrite against a pending sync-branch edit stays one document', async () => {
    await pendingBranchEdit('open');
    const document = await documentOf(PLAN);
    const live = () => h.world.linear.documents.filter((candidate) => candidate.trashed !== true).length;
    const before = live();
    document.title = 'Roadmap';
    document.content = `# Roadmap\n\nEverything here was rewritten in Linear, line by line, so git sees no rename at all. ${CANARY}\n`;
    touch(document);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    await settle();
    assert.equal(live(), before, 'a document was duplicated');
    const mapped = Object.entries(await ids()).filter(([, entry]) => entry.id === document.id).map(([path]) => path);
    assert.equal(mapped.length, 1, `the document is mapped at ${mapped.join(', ')}`);
    const tracked = await show(`refs/heads/main:${mapped[0]}`);
    for (const text of [BRANCH_EDIT, 'Everything here was rewritten in Linear']) assert.ok(tracked.includes(text), `the edit "${text}" was lost (I2)`);
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${PLAN}`], { okCodes: [0, 128] })).code === 0 && mapped[0] !== PLAN, false, 'the old path stayed as a second file');
  });

  it('MDS-011-2C: a pending delete on the sync branch against a later Linear edit is decided and reported, the edit kept', async () => {
    await pendingBranchEdit('open');
    const base = await rev(SYNC_BRANCH);
    const deleted = await commitFile(base, PLAN, null);
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, deleted, base]);
    h.syncValues.push(deleted);
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, undefined, JSON.stringify(run.report.pullRequest));
    assert.deepEqual(run.report.pullRequest?.decided, [PLAN]);
    assert.match(run.summary, /decided them by its structural conflict rules/);
    await settle();
    assert.match(await show(`refs/heads/main:${PLAN}`), /Edited again in Linear\./);
    assert.ok(await isAncestorOn(deleted, 'refs/heads/main'), 'the pending delete commit was lost from history');
  });

  it('MDS-011-2C: a person resolves the markers on the sync branch; the resolution is kept and reaches Linear', async () => {
    const commit = await pendingBranchEdit('open');
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    const reconciled = await sync();
    assert.deepEqual(reconciled.report.pullRequest?.marked, [PLAN]);
    const resolution = await editRef(SYNC_BRANCH, PLAN, planText('Reviewed on the branch and edited again in Linear.'));

    const quiet = await settle();
    assert.deepEqual(quiet.writes, []);
    const tracked = await show(`refs/heads/main:${PLAN}`);
    assert.equal(detectConflicts(tracked).length, 0);
    assert.match(tracked, /Reviewed on the branch and edited again in Linear\./);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    for (const kept of [commit, resolution]) assert.ok(await isAncestorOn(kept, 'refs/heads/main'), 'a commit was lost');
    assert.equal(h.world.github.pullRequests.length, 1);
  });

  it('MDS-011-2C: a person merges the tracked branch into the sync branch by hand; the sync keeps that resolution', async () => {
    const commit = await pendingBranchEdit('open');
    await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
    // The person's own merge commit: parents (sync branch, tracked branch), one resolved paragraph, no markers.
    const parents = [await rev(SYNC_BRANCH), await rev('refs/heads/main')] as const;
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: planText('Resolved by a person.') });
    const resolution = await commitFile(parents[0], PLAN, blob, parents[1]);
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, resolution, parents[0]]);
    h.syncValues.push(resolution);

    const run = await sync();
    assert.deepEqual(run.report.pullRequest?.marked, []);
    assert.equal(await rev(SYNC_BRANCH), resolution, 'the sync replaced the resolution');
    const quiet = await settle();
    assert.deepEqual(quiet.writes, []);
    const tracked = await show(`refs/heads/main:${PLAN}`);
    assert.equal(detectConflicts(tracked).length, 0);
    assert.match(tracked, /Resolved by a person\./);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    for (const kept of [commit, resolution]) assert.ok(await isAncestorOn(kept, 'refs/heads/main'), 'a commit was lost');
  });

  it('MDS-011-2C: a conflicting file that is no document cannot hold markers: the branch is kept and a conflict reported', async () => {
    const path = '.pre-commit-config.yaml';
    await pendingBranchEdit('open');
    const commit = await editRef(SYNC_BRANCH, path, `${PRE_COMMIT}# changed on the branch\n`);
    await editRef('refs/heads/main', path, `${PRE_COMMIT}# changed on the tracked branch\n`);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, 'conflict');
    assert.deepEqual(run.report.pullRequest?.marked, []);
    assert.equal(await rev(SYNC_BRANCH), commit);
    assert.match(run.summary, /A conflicting file that is not a document waits/);
  });

  it('git edits alone open no pull request, run after run (L2-01)', async () => {
    for (const text of ['Edited once.', 'Edited twice.']) {
      const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\n${text} ${CANARY}\n` });
      const base = await rev('refs/heads/main');
      const commit = await commitFile(base, 'combined/guide.md', blob);
      await h.fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
      // The person's commit is the scenario's own (I3), not a sync merge.
      h.start = commit;
      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.deepEqual(run.writes.filter((write) => write.includes('/pulls')), []);
      assert.equal(run.report.pullRequest?.needed, false);
    }
    assert.deepEqual(h.world.github.pullRequests, []);
    assert.equal((await documentOf('combined/guide.md')).content, `# Guide\n\nEdited twice. ${CANARY}\n`);
  });
});
