import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('repair state scope', () => {
  const h = pullRequestHarness();
  for (const suspended of [false, true]) it(`never pushes a forged workflow repair (suspended ${suspended})`, async () => {
    if (suspended) await h.suspendOne();
    const path = '.github/workflows/example.yml';
    const source = 'name: Example\n';
    await h.gitEdit(path, source);
    await h.editRef('refs/mdbisync/linear', path, source);
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    const forged = { id: ids['combined/guide.md'].id, pullRewrite: {hash, observedHash: hash, replacement: 'name: Replaced\n', images: []},
      ...(suspended ? {suspended: {noticeId: randomUUID(), paths: [path], checks: []}} : {}) };
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify({[path]: forged, ...ids}));
    await h.editInLinear('combined/guide.md', '# Guide\n\nA new paragraph.\n');
    await assert.rejects(h.sync(), /ids\.json has an invalid entry/);
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
});
