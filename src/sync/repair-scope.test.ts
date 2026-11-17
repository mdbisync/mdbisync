import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('repair state scope', () => {
  const h = pullRequestHarness();
  for (const suspended of [false, true]) for (const duplicate of [false, true]) it(`never pushes a forged workflow repair (suspended ${suspended}, duplicate ${duplicate})`, async () => {
    if (suspended) await h.suspendOne();
    const path = '.github/workflows/example.yml';
    const source = 'name: Example\n';
    await h.gitEdit(path, source);
    await h.editRef('refs/mdbisync/linear', path, source);
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    const forged = { id: duplicate ? ids['combined/guide.md'].id : 'unknown-document', pullRewrite: {hash, observedHash: hash, replacement: 'name: Replaced\n', images: []},
      ...(suspended ? {suspended: {noticeId: randomUUID(), paths: [path], checks: []}} : {}) };
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify({[path]: forged, ...ids}));
    await h.editInLinear('combined/guide.md', '# Guide\n\nA new paragraph.\n');
    if (duplicate) await assert.rejects(h.sync(), /ids\.json maps a document id to more than one path/);
    else await h.sync();
    for (const branch of [SYNC_BRANCH, h.SUSPENDED]) {
      const exists = await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', branch], {okCodes: [0, 1]});
      if (exists.code !== 0) continue;
      // Inspect every tree newly published on the branch, including intermediate heads.
      const commits = (await h.fixture.remote.text(['rev-list', branch, '--not', 'refs/heads/main'])).split('\n').filter(Boolean);
      for (const commit of commits) {
        const file = await h.fixture.remote.run(['show', `${commit}:${path}`], {okCodes: [0, 128]});
        if (file.code === 0) assert.equal(file.stdout.toString(), source);
      }
    }
  });

  it('does not recreate a missing sync branch from an out-of-scope Linear tree during write-back', async () => {
    await h.fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);
    await h.editRef('refs/mdbisync/linear', '.github/workflows/example.yml', 'name: Example\n');
    await h.editInLinear('combined/guide.md', '# Guide\n\nA new paragraph.\n');
    const run = await h.sync();
    assert.equal(run.report.pullRequest?.code, 'head-unverified');
    const branch = await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], {okCodes: [0, 1]});
    assert.equal(branch.code, 1, 'write-back must not publish a head refused by the pull request step');
    assert.equal(run.report.writes.git.syncBranch ?? 0, 0);
  });

  for (const existing of [false, true]) it(`preserves later tracked files in the proposed branch tree (existing ${existing})`, async () => {
    if (existing) {
      await h.editInLinear('combined/guide.md', '# Guide\n\nA first edit.\n');
      await h.sync();
    } else await h.fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);
    await h.gitEdit('tools/example.sh', 'echo example\n');
    await h.editInLinear('combined/guide.md', '# Guide\n\nA later edit.\n');
    const run = await h.sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(await h.show(`${SYNC_BRANCH}:tools/example.sh`), 'echo example\n');
  });

  it('does not pull an unchecked tracked tip into a held branch to satisfy push scope', async () => {
    await h.editInLinear('eng/notes/plan.md', '# Plan\n\nA held edit.\n');
    await h.sync();
    const head = await h.rev(SYNC_BRANCH);
    h.checksOn(head, h.FAILED);
    h.checksOn(await h.rev('refs/heads/main'), h.FAILED);
    assert.ok((await h.sync()).report.pullRequest?.redMain);
    await h.gitEdit('tools/example.sh', 'echo example\n');
    h.checksOn(await h.rev('refs/heads/main'), h.FAILED);
    await h.editInLinear('combined/guide.md', '# Guide\n\nA later edit.\n');
    const run = await h.sync();
    assert.equal(run.report.pullRequest?.branchMoved, false);
    assert.equal(await h.rev(SYNC_BRANCH), head);
  });
});
