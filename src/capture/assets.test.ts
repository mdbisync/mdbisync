import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { resolveStateConfig } from '../state/index.ts';
import { captureAssets } from './assets.ts';

it('downloads new uploads next to the document, reuses content hashes and preserves ordinary links', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'docs/plan.md': 'Plan.\n', 'docs/existing.png': Buffer.from('image')});
    const git = await fixture.clone('assets');
    const base = await git.text(['rev-parse', 'origin/main']);
    const url = 'https://uploads.linear.app/workspace/image.png';
    const hash = createHash('sha256').update('image').digest('hex');
    let gets = 0;
    const fetcher: typeof fetch = async () => { gets++; return new Response('image'); };
    const content = `![Image](${url})\n\n[Site](https://example.com/guide)\n\n\`![code](${url})\`\n`;
    const cached = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', content, new Map([[hash, url]]), fetcher);
    assert.equal(gets, 0);
    assert.equal(cached.files.size, 0);
    assert.ok(cached.body.startsWith('![Image](existing.png)'));
    assert.ok(cached.body.includes('[Site](https://example.com/guide)'));
    assert.ok(cached.body.includes(`\`![code](${url})\``));
    const otherUrl = 'https://uploads.linear.app/workspace/new.png';
    const fresh = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', `![Image](${otherUrl})`, new Map(), async () => new Response('new-image'));
    const newHash = createHash('sha256').update('new-image').digest('hex');
    assert.deepEqual(fresh.files.get(`docs/${newHash}.png`), Buffer.from('new-image'));
    assert.equal(fresh.uploads.get(newHash), otherUrl);
  } finally { await fixture.cleanup(); }
});

it('rejects off-host redirects without sending a second request', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md': 'Plan.'});
    const git = await fixture.clone('redirect');
    const base = await git.text(['rev-parse', 'origin/main']);
    let gets = 0;
    await assert.rejects(captureAssets(git, resolveStateConfig({}), base, 'plan.md', '![Image](https://uploads.linear.app/image.png)', new Map(), async () => { gets++; return new Response(null, {status: 302, headers: {location:'http://127.0.0.1/private'}}); }), /not allowed/);
    assert.equal(gets, 1);
  } finally { await fixture.cleanup(); }
});
