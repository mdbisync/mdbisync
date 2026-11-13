// Suspended-branch recovery, concurrent changes, and intake through the CLI and Action.

import assert from 'node:assert/strict';
import { detectConflicts } from '../merge/index.ts';
import { SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { FAKE_APP_IDENTITY, FAKE_APP_SLUG, fakeFetch, touch } from '../setup/test-helpers.ts';
import { IDENTITY } from '../state/test-helpers.ts';
import { CHECK_NAME } from '../../test/corpus/check-workflow.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, PRE_COMMIT, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request recovery', () => {
  const h = pullRequestHarness();
  const {
    cli, sync, mergeOnRemote, rev, show, ids, documentOf, editInLinear, checksOn, openPullRequests, gitEdit, SUSPENDED, FAILED, PASSED, suspendOne, releaseHeld, action, editRef, ruleBlocks, commitFile,
  } = h;

  it('keeps suspended membership by id through a Linear rename', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.title = 'renamed';
    touch(document);
    await sync();
    assert.equal((await ids())['eng/notes/renamed.md']?.id, document.id);
    assert.match(await show(`${SUSPENDED}:eng/notes/renamed.md`), /Held Linear edit/);
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `${SUSPENDED}:${path}`], {okCodes:[0,128]})).code, 128);
    await releaseHeld();
    assert.match(await show('refs/heads/main:eng/notes/renamed.md'), /Held Linear edit/);
    assert.equal(document.title, 'renamed');
  });

  it('L5-33: recreates a deleted suspended branch from current Linear text', async () => {
    await suspendOne();
    await h.fixture.remote.run(['update-ref', '-d', SUSPENDED]);
    const before = h.world.github.pullRequests.length;
    await editInLinear('eng/notes/plan.md', '# Plan\n\nCurrent held text.\n');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Current held text/);
    assert.equal(h.world.github.pullRequests.length, before);
    await releaseHeld();
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Current held text/);
  });

  it('L5-34: a lost lease before the atomic suspension push moves neither lane nor episodes', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nHeld Linear edit.\n');
    await sync();
    const normal = await rev(SYNC_BRANCH);
    checksOn(normal, FAILED);
    const transport = fakeFetch(h.world);
    let raced = false;
    h.fetchOverride = async (input, init) => {
      if (!raced && String(input).includes('/check-runs?')) {
        raced = true;
        h.concurrentMove = true;
        const before = await rev('refs/mdbisync/ids');
        const tree = await rev(`${before}^{tree}`);
        const next = await h.fixture.remote.text(['commit-tree', tree, '-p', before, '-m', 'Concurrent capture'], {env:{GIT_AUTHOR_NAME:IDENTITY.name,GIT_AUTHOR_EMAIL:IDENTITY.email,GIT_COMMITTER_NAME:IDENTITY.name,GIT_COMMITTER_EMAIL:IDENTITY.email}});
        await h.fixture.remote.run(['update-ref', 'refs/mdbisync/ids', next, before]);
      }
      return transport(input, init);
    };
    const run = await cli('sync');
    assert.equal(run.report.pullRequest?.code, 'state-moved');
    assert.equal(await rev(SYNC_BRANCH), normal);
    assert.equal((await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', SUSPENDED], {okCodes:[0,1]})).code, 1);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    h.fetchOverride = undefined;
    h.concurrentMove = false;
    await sync();
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
  });

  it('releases while the normal pull request is open without reverting the released paths', async () => {
    await suspendOne();
    await editInLinear('combined/guide.md', '# Guide\n\nWaiting normal edit.\n');
    await sync();
    const normal = await rev(SYNC_BRANCH);
    checksOn(normal, [{name:'ci', status:'in_progress'}]);
    const released = await releaseHeld();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().filter((pr) => pr.head === 'mdbisync/linear').length, 1);
    assert.match(await show(`${SYNC_BRANCH}:eng/notes/plan.md`), /Held Linear edit/);
    assert.match(await show(`${SYNC_BRANCH}:combined/guide.md`), /Waiting normal edit/);
    // The normal branch now holds main's released text, so merging it does not undo the release.
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Held Linear edit/);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Waiting normal edit/);
  });

  it('recovers a release interrupted after GitHub merged and before ids were cleared', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    const pr = openPullRequests().find((pr) => pr.head === 'mdbisync/suspended')!;
    const merged = await mergeOnRemote(pr, head);
    assert.ok('sha' in merged);
    pr.state = 'closed';
    pr.merged = true;
    // The next run finds the head in main and completes the durable release.
    const healed = await sync();
    assert.equal(healed.result.exitCode, 0, healed.result.stderr);
    assert.ok(healed.report.pullRequest?.suspended?.released);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
  });

  it('suspends a batch that deletes a document using its historical id', async () => {
    const path = 'eng/notes/plan.md';
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.ok(held.report.pullRequest?.suspended);
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    await releaseHeld();
    assert.equal((await h.fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], {okCodes:[0,128]})).code, 128);
    assert.equal(document.trashed, true);
    assert.equal((await ids())[path], undefined);
  });

  it('advances Linear-base when Linear adopts a CI repair without changing the selected tree', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path, '# Plan\n\nBad content.\n');
    await editRef(SUSPENDED, path, '# Plan\n\nFixed content.\n');
    await editInLinear(path, '# Plan\n\nFixed content.\n');
    await sync();
    checksOn(await rev(SUSPENDED), FAILED);
    await editInLinear(path, '# Plan\n\nNew content.\n');
    await sync();
    const text = await show(`${SUSPENDED}:${path}`);
    assert.equal(detectConflicts(text).length, 0);
    assert.match(text, /New content/);
  });

  it('a suspended non-document conflict leaves the normal lane moving', async () => {
    await suspendOne();
    await editRef(SUSPENDED, '.pre-commit-config.yaml', PRE_COMMIT + '# lane repair\n');
    await gitEdit('.pre-commit-config.yaml', PRE_COMMIT + '# tracked repair\n');
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    const run = await sync();
    assert.ok(run.report.pullRequest?.suspended?.conflicts?.includes('.pre-commit-config.yaml'));
    assert.ok(openPullRequests().some((pr) => pr.head === 'mdbisync/linear'));
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Independent edit/);
  });

  it('Linear intake ignores non-document conflicts outside the suspended paths', async () => {
    await suspendOne();
    await gitEdit('eng/notes/image.png', 'tracked bytes');
    await editRef('refs/mdbisync/linear', 'eng/notes/image.png', 'captured bytes');
    await editInLinear('eng/notes/plan.md', '# Plan\n\nLater held edit.\n');
    const run = await sync();
    assert.equal(run.report.pullRequest?.suspended?.conflicts, undefined);
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Later held edit/);
  });

  it('restores a suspended Linear delete when a git edit keeps its file at release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await gitEdit(path, '# Plan\n\nGit edit while held.\n');
    await sync();
    const released = await releaseHeld();
    assert.notEqual(document.trashed, true);
    assert.match(document.content ?? '', /Git edit while held/);
    assert.ok(released.report.sync?.restored.includes(path));
    assert.equal((await ids())[path]?.id, document.id);
  });

  it('releases when GitHub automatically deletes the suspended branch after merging', async () => {
    await suspendOne();
    h.world.github.merge = async (pr, sha) => {
      const outcome = await mergeOnRemote(pr, sha);
      if ('sha' in outcome && pr.head === 'mdbisync/suspended') {
        await h.fixture.remote.run(['update-ref', '-d', SUSPENDED]);
        h.deletedSuspendedDuringRun = true;
      }
      return outcome;
    };
    const released = await releaseHeld();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('heals a release interrupted after GitHub merged and automatically deleted its branch', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    const pr = openPullRequests().find((pr) => pr.head === 'mdbisync/suspended')!;
    assert.ok('sha' in await mergeOnRemote(pr, head));
    await h.fixture.remote.run(['update-ref', '-d', SUSPENDED]);
    pr.state = 'closed'; pr.merged = true;
    const run = await sync();
    assert.ok(run.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().length, 0);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
  });

  it('reports an idle failed suspended head as unchanged', async () => {
    await suspendOne();
    const run = await sync();
    assert.equal(run.report.changed, false);
    assert.deepEqual(run.report.writes.git, {});
    assert.deepEqual(run.writes.filter((write) => !write.startsWith('PATCH /pulls/')), []);
  });

  it('leaves a pre-existing unrelated suspended branch untouched', async () => {
    await h.fixture.remote.run(['update-ref', SUSPENDED, h.start]);
    await editInLinear('eng/notes/plan.md', '# Plan\n\nA changed page.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const run = await sync();
    assert.equal(await rev(SUSPENDED), h.start);
    assert.equal(run.report.pullRequest?.code, 'conflict');
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
  });

  it('a repeated protection-rule refusal on the suspended lane stays a setup error', async () => {
    await suspendOne();
    ruleBlocks();
    checksOn(await rev(SUSPENDED), PASSED);
    const first = await sync();
    assert.equal(first.report.pullRequest?.suspended?.code, 'merge-refused');
    const second = await sync();
    assert.equal(second.report.pullRequest?.suspended?.code, 'merge-blocked');
    assert.equal(second.result.exitCode, SETUP_FAILED_EXIT_CODE);
    h.world.github.merge = mergeOnRemote;
    const released = await sync();
    assert.equal(released.result.exitCode, 0, released.result.stderr);
    assert.ok(released.report.pullRequest?.suspended?.released);
  });

  it('a GitHub failure for the suspended head still allows the normal lane to open', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    await editInLinear('combined/guide.md', '# Guide\n\nAn independent page.\n');
    const transport = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => String(input).includes(`/commits/${head}/check-runs`)
      ? new Response('{}', {status:503}) : transport(input, init);
    const run = await sync();
    assert.equal(run.report.pullRequest?.suspended?.code, 'github-failed');
    assert.equal(run.report.pullRequest?.suspended?.status, 503);
    assert.ok(openPullRequests().some((pr) => pr.head === 'mdbisync/linear'));
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('authors suspended lane, intake and release commits as the configured App', async () => {
    const initialRefs = await Promise.all(['refs/mdbisync/linear','refs/mdbisync/ids','refs/mdbisync/uploads','refs/heads/main'].map(rev));
    const extra = {MDBISYNC_APP_SLUG:FAKE_APP_SLUG};
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld App edit.\n');
    await cli('sync', extra);
    checksOn(await rev(SYNC_BRANCH), FAILED);
    await cli('sync', extra);
    await editInLinear(path, '# Plan\n\nLater held App edit.\n');
    await cli('sync', extra);
    const checkAuthors = async () => {
      const log = await h.fixture.remote.text(['log','--format=%s%x00%an <%ae>%x00%cn <%ce>', SUSPENDED,SYNC_BRANCH,'refs/mdbisync/linear','refs/mdbisync/ids','--not',...initialRefs,'refs/heads/main']);
      const expected = `${FAKE_APP_IDENTITY.name} <${FAKE_APP_IDENTITY.email}>`;
      for (const line of log.split('\n').filter(Boolean)) {
        const [subject, author, committer] = line.split('\0');
        assert.notEqual(subject, 'Merge input');
        assert.equal(author, expected, subject);
        assert.equal(committer, expected, subject);
      }
    };
    await checkAuthors();
    checksOn(await rev(SUSPENDED), PASSED);
    const run = await cli('sync', extra);
    assert.ok(run.report.pullRequest?.suspended?.released);
    await checkAuthors();
  });

  it('L5-22: captures a huge Linear document byte for byte, warns, and never writes an oversized git edit back', async () => {
    const path = 'eng/notes/large.md';
    const content = `${CANARY}\n\n${'a'.repeat(260_000)}\n`;
    h.world.linear.documents.push({id:'large', title:'large', content, projectId:'project-api', createdAt:'2026-02-01T00:00:00Z'});
    const before = structuredClone(h.world.linear.documents);
    const captured = await sync();
    assert.equal(captured.result.exitCode, 0, captured.result.stderr);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), content);
    assert.deepEqual(captured.report.capture?.writeBackWarnings, [{path, code:'linear-content-too-large-to-write-back', length:content.length, limit:250_000}]);
    assert.match(captured.summary, /Linear will not accept it back if it is changed in git/);
    assert.match(captured.summary, /eng\/notes\/large\.md/);
    assert.deepEqual(captured.writes, ['POST /pulls']);
    checksOn(await rev(SYNC_BRANCH), [{name:CHECK_NAME, status:'completed', conclusion:'success'}]);
    const merged = await sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.equal(await show(`refs/heads/main:${path}`), content);
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.deepEqual(h.world.linear.documents, before);

    const base = await rev('refs/heads/main');
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], {input:content + 'Another paragraph.\n'});
    h.start = await commitFile(base, path, blob);
    await h.fixture.remote.run(['update-ref', 'refs/heads/main', h.start, base]);
    const edited = await sync();
    assert.equal(edited.result.exitCode, 0, edited.result.stderr);
    assert.ok(edited.report.sync?.leftOut.some((entry) => entry.path === path && entry.rules.includes('content-too-long')));
    assert.deepEqual(edited.writes, []);
    assert.deepEqual(h.world.linear.documents, before);
  });

  it('the GitHub Action succeeds when a failed batch is suspended', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nA step for the action. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'secrets', status: 'completed', conclusion: 'failure' }]);

    const { output, exitCode } = await action();
    assert.equal(exitCode ?? 0, 0);
    assert.doesNotMatch(output, /::error::/);
    assert.equal(h.world.github.pullRequests[0]?.merged, false);
  });
});
