import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { LinearReads } from '../linear/index.ts';
import { createFixture } from '../state/test-helpers.ts';
import { resolveStateConfig } from '../state/index.ts';
import { captureAssets, createAssetCapture, imageFindings, ImageBlockedError } from './assets.ts';

const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));

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
    const fresh = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', `![Image](${otherUrl})`, new Map(), async () => new Response(png));
    const newHash = createHash('sha256').update(png).digest('hex');
    assert.deepEqual(fresh.files.get(`docs/${newHash}.png`), png);
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
      return new Response(png,{headers:{'content-type':'image/png'}});
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

it('a download kept by the stage step is taken by the apply step without a request', async () => {
  const fixture = await createFixture();
  const dir = await mkdtemp(join(tmpdir(), 'kept-download-'));
  try {
    await fixture.seed({'plan.md': 'Plan.'});
    const git = await fixture.clone('kept');
    const base = await git.text(['rev-parse', 'origin/main']);
    const body = '![Image](https://uploads.linear.app/workspace/image.png)';
    let gets = 0;
    const fetcher: typeof fetch = async () => { gets++; return new Response(png, {headers: {'content-type': 'image/png'}}); };
    const recording = LinearReads.recording();
    recording.tokenMinted(['read', 'write'], {grantType: 'client_credentials', requestedScopes: ['read', 'write'], returnedScopes: ['read', 'write']});
    const staged = await createAssetCapture(git, resolveStateConfig({}), base, fetcher, recording)('plan.md', body, new Map());
    await recording.save(dir);
    assert.equal(gets, 1);
    const replaying = await LinearReads.replaying(dir);
    assert.ok(replaying !== null);
    const applied = await createAssetCapture(git, resolveStateConfig({}), base, fetcher, replaying)('plan.md', body, new Map());
    assert.equal(gets, 1, 'the apply step downloaded again');
    assert.deepEqual([...applied.files], [...staged.files]);
    assert.equal(applied.body, staged.body);
  } finally {
    await rm(dir, {recursive: true, force: true});
    await fixture.cleanup();
  }
});

for (const destination of ['https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA', 'relative.png', '/absolute.png', '', 'https://uploads.linear.app.example.com/a.png', 'http://uploads.linear.app/a.png']) {
  it(`rejects non-upload image destination ${JSON.stringify(destination)} in every image form`, () => {
    const body = `![Inline](${destination})\n\n[![Linked](${destination})](https://example.com)\n\n![Reference][picture]\n\n[picture]: <${destination}>\n`;
    const expected = 3;
    assert.deepEqual(imageFindings(body), Array.from({length: expected}, (_, index) => ({image: index + 1, total: expected, line: index * 2 + 1, reason: 'not-uploaded'})));
  });
}

it('counts upload images and repeated reference occurrences without treating links or code as images', () => {
  const body = '![Good](https://uploads.linear.app/a.png)\n\n![Bad][asset]\n\n![Bad again][asset]\n\n[asset]: https://example.com/a.png\n\n[Link](data:text/plain,hello)\n\n`![Code](bad.png)`\n';
  assert.deepEqual(imageFindings(body), [
    {image:2, total:3, line:3, reason:'not-uploaded'},
    {image:3, total:3, line:5, reason:'not-uploaded'},
  ]);
  assert.deepEqual(imageFindings('![Good][asset]\n\n[asset]: https://uploads.linear.app/a.png\n'), []);
});

it('uses detected extensions despite MIME type and URL, and reuses unrecognized tracked bytes', async () => {
  const fixture = await createFixture();
  try {
    const existing = Buffer.from('<html>Already tracked</html>');
    await fixture.seed({'docs/plan.md':'Plan.', 'assets/existing.html':existing});
    const git = await fixture.clone('byte-types');
    const base = await git.text(['rev-parse', 'origin/main']);
    const jpeg = await readFile(new URL('../../test/fixtures/assets/photo.jpg', import.meta.url));
    for (const suffix of ['png', 'md', 'html']) {
      const result = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', `![Image](https://uploads.linear.app/file.${suffix})`, new Map(), async () => new Response(jpeg, {headers:{'content-type':'image/png'}}));
      const hash = createHash('sha256').update(jpeg).digest('hex');
      assert.equal(result.body, `![Image](${hash}.jpg)`);
      assert.deepEqual([...result.files], [[`docs/${hash}.jpg`, jpeg]]);
    }
    const url = 'https://uploads.linear.app/existing.png';
    const result = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', `![Image](${url})`, new Map(), async () => new Response(existing));
    assert.equal(result.body, '![Image](../assets/existing.html)');
    const hash = createHash('sha256').update(existing).digest('hex');
    const mapped = await captureAssets(git, resolveStateConfig({}), base, 'docs/plan.md', `![Image](${url})`, new Map([[hash,url]]), async () => {throw new Error('Unexpected download');});
    assert.equal(mapped.body, result.body);
    assert.equal(mapped.files.size, 0);
  } finally {await fixture.cleanup();}
});

it('reports every unsupported image at its original occurrence, including references and linked images', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('unsupported');
    const base = await git.text(['rev-parse', 'origin/main']);
    const url = 'https://uploads.linear.app/page.html';
    const body = `![Good](https://uploads.linear.app/pixel.png)\n\n![Hidden text][page]\n\n[![Again](${url})](https://example.com)\n\n[page]: ${url}\n`;
    await assert.rejects(captureAssets(git, resolveStateConfig({}), base, 'plan.md', body, new Map(), async (input) => new Response(String(input).endsWith('pixel.png') ? png : Buffer.from('<!-- page --><html/>'), {headers:{'content-type':'image/png'}})), (error) => {
      assert.ok(error instanceof ImageBlockedError);
      assert.deepEqual(error.findings, [{image:2,total:3,line:3,reason:'unsupported-type'}, {image:3,total:3,line:5,reason:'unsupported-type'}]);
      assert.ok(!error.message.includes('Hidden'));
      return true;
    });
  } finally {await fixture.cleanup();}
});

it('enforces the size boundary from headers and streamed bytes, and cancels rejected streams', async () => {
  const fixture = await createFixture();
  try {
    const limit = 10 * 1024 * 1024;
    const bytes = Buffer.concat([png, Buffer.alloc(limit - png.length)]);
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('size-limit');
    const base = await git.text(['rev-parse', 'origin/main']);
    const body = '![Image](https://uploads.linear.app/file.png)';
    const read = (fetcher: typeof fetch) => captureAssets(git, resolveStateConfig({}), base, 'plan.md', body, new Map(), fetcher);
    assert.equal((await read(async () => new Response(bytes))).files.values().next().value?.length, limit);
    for (const declared of [undefined, '1', String(limit + 1)]) {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) {controller.enqueue(bytes); controller.enqueue(Buffer.from([0]));},
        cancel() {cancelled = true;},
      });
      await assert.rejects(read(async () => new Response(stream, {headers:declared === undefined ? {} : {'content-length':declared}})), (error) => {
        assert.ok(error instanceof ImageBlockedError);
        assert.deepEqual(error.findings, [{image:1, total:1, line:1, reason:'too-large'}]);
        return true;
      });
      assert.equal(cancelled, true);
    }
  } finally { await fixture.cleanup(); }
});

it('reports all permanent download failures at original image occurrences', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('download-findings');
    const base = await git.text(['rev-parse', 'origin/main']);
    const body = '![Dead](https://uploads.linear.app/dead#fragment)\n\n![Large][asset]\n\n[![Dead again](https://uploads.linear.app/dead)](https://example.com)\n\n[asset]: https://uploads.linear.app/large\n';
    await assert.rejects(captureAssets(git, resolveStateConfig({}), base, 'plan.md', body, new Map(), async (input) => String(input).endsWith('/large') ? new Response(png, {headers:{'content-length':String(10 * 1024 * 1024 + 1)}}) : new Response(null, {status:410})), (error) => {
      assert.ok(error instanceof ImageBlockedError);
      assert.deepEqual(error.findings, [
        {image:1, total:3, line:1, reason:'unreadable'},
        {image:2, total:3, line:3, reason:'too-large'},
        {image:3, total:3, line:5, reason:'unreadable'},
      ]);
      return true;
    });
  } finally { await fixture.cleanup(); }
});

it('keeps permanent image findings when another download needs a retry', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('mixed-answers');
    const base = await git.text(['rev-parse', 'origin/main']);
    for (const statuses of [[404, 503], [503, 404]]) {
      let index = 0;
      await assert.rejects(captureAssets(git, resolveStateConfig({}), base, 'plan.md', '![First](https://uploads.linear.app/first)\n![Second](https://uploads.linear.app/second)', new Map(), async () => new Response(null, {status:statuses[index++]!})), (error) => {
        assert.ok(error instanceof ImageBlockedError);
        assert.deepEqual(error.findings, [{image:statuses.indexOf(404) + 1, total:2, line:statuses.indexOf(404) + 1, reason:'unreadable'}]);
        return true;
      });
    }
  } finally { await fixture.cleanup(); }
});

it('cancels error responses and reuses failures across repeated upload destinations', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('failure-cache');
    const base = await git.text(['rev-parse', 'origin/main']);
    const body = '![First](https://uploads.linear.app/file#first)\n![Second](https://uploads.linear.app/file#second)';
    for (const status of [302, 401, 403, 404, 429, 503]) {
      let requests = 0;
      let cancelled = false;
      const read = createAssetCapture(git, resolveStateConfig({}), base, async () => {
        requests++;
        return new Response(new ReadableStream({cancel() {cancelled = true;}}), {status});
      });
      await assert.rejects(read('plan.md', body, new Map()));
      assert.equal(requests, 1);
      assert.equal(cancelled, true);
      if (status !== 401 && status !== 403) {
        await assert.rejects(read('other.md', body, new Map()));
        assert.equal(requests, 1, 'failures are cached for the rest of this capture');
      }
    }
  } finally { await fixture.cleanup(); }
});

it('classifies oversized attachments and empty upload responses as permanent findings', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'plan.md':'Plan.'});
    const git = await fixture.clone('attachment-findings');
    const base = await git.text(['rev-parse', 'origin/main']);
    for (const reason of ['too-large', 'unreadable'] as const) {
      await assert.rejects(captureAssets(git, resolveStateConfig({}), base, 'plan.md', '[File](https://uploads.linear.app/file)', new Map(), async () => reason === 'too-large' ? new Response(png, {headers:{'content-length':String(10 * 1024 * 1024 + 1)}}) : new Response(null)), (error) => {
        assert.ok(error instanceof ImageBlockedError);
        assert.deepEqual(error.findings, [{file:1, total:1, line:1, reason}]);
        return true;
      });
    }
  } finally { await fixture.cleanup(); }
});
