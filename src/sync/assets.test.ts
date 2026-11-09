import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { resolveStateConfig } from '../state/index.ts';
import { captureAssets, createAssetCapture } from './assets.ts';

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

it('authenticates extensionless uploads, infers their image type and preserves fragments', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('authenticated');
    const base = await git.text(['rev-parse','origin/main']);
    const { GraphQLTransport } = await import('../linear/transport.ts');
    let requests = 0;
    const transport = new GraphQLTransport({token:'test-access-token', fetch: async (input, init) => {
      requests++;
      assert.equal(String(input),'https://uploads.linear.app/workspace/opaque');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access-token');
      assert.equal(init?.redirect, 'manual');
      return new Response('image-bytes',{headers:{'content-type':'image/png'}});
    }});
    const result = await captureAssets(git, resolveStateConfig({}), base, 'plan.md', '[Image](https://uploads.linear.app/workspace/opaque#page=3)', new Map(), (input,init) => transport.fetchUpload(String(input),init));
    assert.match(result.body, /\.png#page=3\)$/);
    assert.equal([...result.files.keys()].filter((path) => path.endsWith('.png')).length,1);
    await assert.rejects(transport.fetchUpload('https://example.com/private'),/not allowed/);
    assert.equal(requests,1);
  } finally {await fixture.cleanup();}
});

it('returns replacement bytes when a cached LFS pointer has no readable object', async () => {
  const fixture = await createFixture();
  try {
    const bytes = Buffer.from('replacement-image');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${hash}\nsize ${bytes.length}\n`;
    await fixture.seed({'plan.md':'![Image](missing.png)\n','missing.png':pointer});
    const git = await fixture.clone('missing-object');
    const base = await git.text(['rev-parse','origin/main']);
    const { createAssetCapture } = await import('./assets.ts');
    const url = 'https://uploads.linear.app/workspace/image.png';
    const read = createAssetCapture(git,resolveStateConfig({}),base,async()=>new Response(bytes));
    const result = await read('plan.md',`![Image](${url})\n`,new Map([[hash,url]]),'![Image](missing.png)\n');
    assert.deepEqual(result.files.get('missing.png'),bytes);
    assert.equal(result.body,'![Image](missing.png)\n');
  } finally {await fixture.cleanup();}
});

it('restores cached upload spellings before restricting new downloads to the upload host', async () => {
  const fixture = await createFixture();
  try {
    const previous = '![Image](<./image.png?download=1#page=2>)\n';
    await fixture.seed({'docs/plan.md': previous, 'docs/image.png': Buffer.from('image')});
    const git = await fixture.clone('cached-links');
    const base = await git.text(['rev-parse', 'origin/main']);
    const hash = createHash('sha256').update('image').digest('hex');
    const url = 'https://storage.example.test/image.png';
    const current = `![Image](<${url}?download=1#page=2>)\n`;
    const read = createAssetCapture(git, resolveStateConfig({}), base, async () => { throw new Error('a cached link must not be downloaded'); });
    const result = await read('docs/plan.md', current, new Map([[hash, url]]), previous);
    assert.equal(result.body, previous);
    assert.equal(result.files.size, 0);
    const fresh = await read('docs/other.md', current, new Map([[hash, url]]));
    assert.equal(fresh.body, '![Image](<image.png?download=1#page=2>)\n');
    assert.equal(fresh.files.size, 0);
  } finally { await fixture.cleanup(); }
});

it('prefers previously linked files for cached links, images and definitions across runs', async () => {
  const fixture = await createFixture();
  try {
    const previous = '[Earlier](<../assets/a%20preferred.png?view=1#old>)\n';
    await fixture.seed({'docs/plan.md': previous, 'assets/a preferred.png': Buffer.from('same-image'), 'assets/z.png': Buffer.from('same-image')});
    const git = await fixture.clone('prior-path');
    const base = await git.text(['rev-parse', 'origin/main']);
    const hash = createHash('sha256').update('same-image').digest('hex');
    const url = 'https://uploads.linear.app/workspace/shared.png';
    const content = [
      `[Earlier](<${url}?view=1#old>)`,
      `[New link](${url}?view=2#link)`,
      `![New image](<${url}?view=3#image>)`,
      '[Reference][asset]',
      '',
      `[asset]: <${url}?view=4#definition> "Asset title"`,
      '',
      `Literal URL: ${url}`,
      '',
      '`' + url + '`',
      '',
      '```md',
      `[Example](${url})`,
      '```',
      '',
    ].join('\n');
    const expected = content
      .replace(`${url}?view=1#old`, '../assets/a%20preferred.png?view=1#old')
      .replace(`${url}?view=2#link`, '../assets/a%20preferred.png?view=2#link')
      .replace(`${url}?view=3#image`, '../assets/a%20preferred.png?view=3#image')
      .replace(`${url}?view=4#definition`, '../assets/a%20preferred.png?view=4#definition');
    const read = createAssetCapture(git, resolveStateConfig({}), base, async () => { throw new Error('cached bytes must not be downloaded'); });
    const result = await read('docs/plan.md', content, new Map([[hash, url]]), previous);
    assert.equal(result.body, expected);
    assert.equal(result.files.size, 0);
    const withoutPriorBrackets = previous.replaceAll('<', '').replaceAll('>', '');
    assert.equal((await read('docs/plan.md', content, new Map([[hash, url]]), withoutPriorBrackets)).body, expected, 'new Linear brackets stay');
    const withoutCurrentBrackets = content.replace(`<${url}?view=1#old>`, `${url}?view=1#old`);
    assert.equal((await read('docs/plan.md', withoutCurrentBrackets, new Map([[hash, url]]), previous)).body, expected.replace('<../assets/a%20preferred.png?view=1#old>', '../assets/a%20preferred.png?view=1#old'), 'removed Linear brackets stay removed');
    const repeated = content + `\n[Repeat](${url}?view=1#old)`;
    assert.equal((await read('docs/plan.md', repeated, new Map([[hash, url]]), previous)).body, expected + '\n[Repeat](../assets/a%20preferred.png?view=1#old)', 'each repeated URL keeps its own brackets');
    // A new capture has no transform-local or reader-local knowledge of the first.
    const next = createAssetCapture(git, resolveStateConfig({}), base, async () => { throw new Error('cached bytes must not be downloaded'); });
    assert.equal((await next('docs/plan.md', content, new Map([[hash, url]]), result.body)).body, expected);
    const moved = await next('docs/deeper/plan.md', content, new Map([[hash, url]]), previous, 'docs/plan.md');
    assert.equal(moved.body, expected.replaceAll('../assets/', '../../assets/'));
  } finally { await fixture.cleanup(); }
});
