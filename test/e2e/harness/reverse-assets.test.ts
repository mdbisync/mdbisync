import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFixture } from '../../../src/state/test-helpers.ts';
import type { RunContext, LiveWorld } from './context.ts';
import { runNames } from './isolation.ts';
import { FIXTURE_PREPARATION } from './runner.ts';
import { BEFORE_VIEW, resolveSubject } from './subjects.ts';
import { loadScenarios } from './spec.ts';
import { compare } from './checks.ts';

for (const lfs of [false, true]) {
  it(`checks only the seeded reverse image with an existing linked image (${lfs ? 'LFS' : 'regular'})`, async () => {
    const fixture = await createFixture();
    try {
      const names = runNames('abcdef');
      const existing = Buffer.from('an existing corpus image');
      await fixture.seed({ 'docs/old.md': '![old](old.png)\n', 'docs/old.png': existing }, lfs ? { lfs: ['*.png'] } : {});
      const tip = await fixture.remote.text(['rev-parse', 'main']);
      const git = await fixture.clone('reader');
      await git.run(['checkout', 'main']);
      const scenario = loadScenarios().find((candidate) => candidate.id === 'L1R-04');
      assert.ok(scenario);
      const ctx = { names, live: null, observations: new Map([[BEFORE_VIEW, { tip }]]), person: async () => git } as unknown as RunContext;
      let uploaded = Buffer.alloc(0);
      const live = {
        projects: new Map([['project', { id: 'p', name: 'Handbook' }]]),
        tree: { rewritten: new Map([['docs/README.md', 'project: Handbook']]), projects: new Map([['project', 'Handbook']]) },
        seededDocuments: [],
        editors: { 'editor-a': {
          uploadFile: async ({ bytes }: { bytes: Uint8Array }) => { uploaded = Buffer.from(bytes); return { assetUrl: 'https://uploads.example.com/diagram.png' }; },
          createDocument: async (_place: unknown, input: { title: string }) => ({ id: 'fixture', title: input.title }),
        } },
      } as unknown as LiveWorld;
      ctx.live = live;
      await FIXTURE_PREPARATION['reverse-assets']!(ctx, live);
      ctx.live = null;
      const [asset] = ctx.observations.get('linear.assets') as Array<{ path: string; documentPath: string; sha256: string; bytes: Buffer }>;
      assert.ok(asset);
      assert.deepEqual(asset.bytes, uploaded);
      const document = `![diagram](${asset.sha256}.png)\n`;
      const seed = (files: Record<string, string | Buffer>) => fixture.seed(files, { branch: names.syncBranch });
      const value = async (subject: string) => (await resolveSubject(ctx, subject)).value;
      await seed({ [asset.documentPath]: document, [asset.path]: uploaded });
      for (const check of scenario.checks.assertions) {
        const expected = check.operator === 'same-as' ? await value(String(check.expected)) : check.expected;
        assert.ok(compare(check.operator, await value(check.subject), expected), check.subject);
      }
      assert.deepEqual(await value('pullRequests.assetBytes'), new Map([[asset.path, asset.sha256]]));

      // A valid copy elsewhere must not hide a broken fixture link or download.
      await seed({ [asset.documentPath]: '![diagram](other.png)\n', 'docs/guides/other.png': uploaded });
      await assert.rejects(() => value('pullRequests.assetBytes'), /expected download path/);
      await seed({ [asset.documentPath]: document, [asset.path]: Buffer.from('corrupt download') });
      await assert.rejects(() => value('pullRequests.assetBytes'), /different bytes/);
      await seed({ [asset.documentPath]: '![diagram](missing.png)\n' });
      await assert.rejects(() => value('pullRequests.assetBytes'), /expected download path/);
      await seed({ [asset.documentPath]: document, [asset.path]: uploaded, 'docs/old.png': Buffer.from('changed corpus image') });
      assert.equal(await value('pullRequests.existingAssetsUnchanged'), false);
      // Removing the expected blob also fails when the link and an unrelated valid image remain.
      const writer = await fixture.clone('writer');
      await writer.run(['checkout', names.syncBranch]);
      await writer.run(['rm', '--', asset.path]);
      await writer.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Remove download']);
      await writer.run(['push', 'origin', names.syncBranch]);
      await assert.rejects(() => value('pullRequests.assetBytes'), /download is missing/);
    } finally {
      await fixture.cleanup();
    }
  });
}
