// Where capture puts a file it takes from Linear: the `assets/` folder beside
// the document, a file already in the repository where it is, and a moved
// document's `assets/` files copied into its new folder.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { contentBytes } from '../state/content.ts';
import { resolveStateConfig } from '../state/index.ts';
import { createFixture } from '../state/test-helpers.ts';
import { createAssetCapture, ImageBlockedError } from './assets.ts';

const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));
const pngHash = createHash('sha256').update(png).digest('hex');
const other = Buffer.concat([png, Buffer.from('other')]);
const url = 'https://uploads.linear.app/workspace/pasted.png';
const config = resolveStateConfig({});

async function captured(tree: Record<string, string | Buffer>, path: string, body: string, uploads = new Map<string, string>(), previous?: { body: string; path: string }, lfs?: string[]) {
  const fixture = await createFixture();
  try {
    await fixture.seed(tree, lfs === undefined ? {} : { lfs });
    const git = await fixture.clone('assets-folder');
    const base = await git.text(['rev-parse', 'origin/main']);
    let downloads = 0;
    const capture = createAssetCapture(git, config, base, async () => { downloads++; return new Response(png); });
    try {
      const result = await capture(path, body, uploads, previous?.body, previous?.path);
      return { body: result.body, files: new Map([...result.files].map(([file, content]) => [file, contentBytes(content)])), uploads: result.uploads, downloads };
    } finally { capture.close(); }
  } finally { await fixture.cleanup(); }
}

describe('the assets folder beside the documents', () => {
  it('writes a new file into the assets folder of the document and links it there', async () => {
    const nested = await captured({ 'docs/guides/plan.md': 'Plan.\n' }, 'docs/guides/plan.md', `![Pasted](${url})\n`);
    assert.deepEqual([...nested.files.keys()], [`docs/guides/assets/${pngHash}.png`]);
    assert.deepEqual(nested.files.get(`docs/guides/assets/${pngHash}.png`), png);
    assert.equal(nested.body, `![Pasted](assets/${pngHash}.png)\n`);
    assert.equal(nested.uploads.get(pngHash), url);

    const root = await captured({ 'plan.md': 'Plan.\n' }, 'plan.md', `![Pasted](${url})\n`);
    assert.deepEqual([...root.files.keys()], [`assets/${pngHash}.png`]);
    assert.equal(root.body, `![Pasted](assets/${pngHash}.png)\n`);
  });

  it('writes into an assets folder the repository already has, beside its files', async () => {
    const tree = { 'docs/plan.md': 'Plan.\n', 'docs/assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'docs/assets/notes.txt': 'Kept.\n' };
    const result = await captured(tree, 'docs/plan.md', `![Pasted](${url})\n`);
    assert.deepEqual([...result.files.keys()], [`docs/assets/${pngHash}.png`]);
    assert.equal(result.body, `![Pasted](assets/${pngHash}.png)\n`);
  });

  it('links a file from git where its author put it, preferring the copy in the document folder', async () => {
    const elsewhere = await captured({ 'docs/plan.md': 'Plan.\n', 'docs/images/chart.png': png }, 'docs/plan.md', `![Chart](${url})\n`);
    assert.deepEqual([...elsewhere.files.keys()], ['docs/images/chart.png'], 'the same bytes, at the place git has them');
    assert.equal(elsewhere.body, '![Chart](images/chart.png)\n');

    const tree = { 'docs/plan.md': 'Plan.\n', 'docs/assets/chart.png': png, 'other/assets/chart.png': png, 'zeta/chart.png': png };
    const own = await captured(tree, 'docs/plan.md', `![Chart](${url})\n`);
    assert.deepEqual([...own.files.keys()], ['docs/assets/chart.png']);
    assert.equal(own.body, '![Chart](assets/chart.png)\n');

    const mapped = await captured(tree, 'docs/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]));
    assert.equal(mapped.downloads, 0);
    assert.equal(mapped.body, '![Chart](assets/chart.png)\n');
  });

  it('copies the files a moved document linked in its old assets folder into the new one', async () => {
    const tree = {
      'old/plan.md': `![Chart](assets/chart.png)\n\n![Photo](images/photo.png)\n`,
      'old/assets/chart.png': png,
      'old/images/photo.png': other,
    };
    const otherHash = createHash('sha256').update(other).digest('hex');
    const uploads = new Map([[pngHash, url], [otherHash, 'https://uploads.linear.app/workspace/photo.png']]);
    const body = `![Chart](${url})\n\n![Photo](https://uploads.linear.app/workspace/photo.png)\n`;
    const moved = await captured(tree, 'new/plan.md', body, uploads, { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.equal(moved.downloads, 0);
    assert.deepEqual([...moved.files.keys()], ['new/assets/chart.png']);
    assert.deepEqual(moved.files.get('new/assets/chart.png'), png);
    assert.equal(moved.body, '![Chart](assets/chart.png)\n\n![Photo](../old/images/photo.png)\n');

    const renamed = await captured(tree, 'old/renamed.md', body, uploads, { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.equal(renamed.files.size, 0, 'a rename in the same folder copies nothing');
    assert.equal(renamed.body, tree['old/plan.md']);
  });

  it('names the copy by its hash when the new folder holds other bytes under that name, and reuses an equal one', async () => {
    const tree = { 'old/plan.md': '![Chart](assets/chart.png)\n', 'old/assets/chart.png': png, 'new/assets/chart.png': other };
    const previous = { body: tree['old/plan.md'], path: 'old/plan.md' };
    const taken = await captured(tree, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), previous);
    assert.deepEqual([...taken.files.keys()], [`new/assets/${pngHash}.png`]);
    assert.equal(taken.body, `![Chart](assets/${pngHash}.png)\n`);

    const equal = await captured({ ...tree, 'new/assets/chart.png': png }, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), previous);
    assert.equal(equal.files.size, 0);
    assert.equal(equal.body, '![Chart](assets/chart.png)\n');
  });

  it('copies a moved document file stored in Git LFS by its content, not its pointer', async () => {
    const tree = { 'old/plan.md': '![Chart](assets/chart.png)\n', 'old/assets/chart.png': png };
    const moved = await captured(tree, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), { body: tree['old/plan.md'], path: 'old/plan.md' }, ['**/assets/**']);
    assert.equal(moved.downloads, 0);
    assert.deepEqual(moved.files.get('new/assets/chart.png'), png);
    assert.equal(moved.body, '![Chart](assets/chart.png)\n');
  });

  it('gives two documents moved into one folder in one run their own copies of equally named files', async () => {
    const fixture = await createFixture();
    try {
      const tree = { 'a/plan.md': '![Chart](assets/chart.png)\n', 'a/assets/chart.png': png, 'b/spec.md': '![Chart](assets/chart.png)\n', 'b/assets/chart.png': other };
      await fixture.seed(tree);
      const git = await fixture.clone('assets-folder-run');
      const base = await git.text(['rev-parse', 'origin/main']);
      const otherHash = createHash('sha256').update(other).digest('hex');
      const otherUrl = 'https://uploads.linear.app/workspace/other.png';
      const uploads = new Map([[pngHash, url], [otherHash, otherUrl]]);
      const capture = createAssetCapture(git, config, base, async () => assert.fail('no download'));
      try {
        const first = await capture('new/plan.md', `![Chart](${url})\n`, uploads, tree['a/plan.md'], 'a/plan.md');
        const second = await capture('new/spec.md', `![Chart](${otherUrl})\n`, uploads, tree['b/spec.md'], 'b/spec.md');
        assert.deepEqual([...first.files.keys()], ['new/assets/chart.png']);
        assert.deepEqual([...second.files.keys()], [`new/assets/${otherHash}.png`]);
        assert.equal(second.body, `![Chart](assets/${otherHash}.png)\n`);
      } finally { capture.close(); }
    } finally { await fixture.cleanup(); }
  });

  it('copies equal bytes linked under two old names once, and every link names the copy', async () => {
    const tree = { 'old/plan.md': '![A](assets/a.png)\n\n![B](assets/b.png)\n', 'old/assets/a.png': png, 'old/assets/b.png': png };
    const moved = await captured(tree, 'new/plan.md', `![A](${url})\n\n![B](${url})\n`, new Map([[pngHash, url]]), { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.deepEqual([...moved.files.keys()], ['new/assets/a.png']);
    assert.equal(moved.body, '![A](assets/a.png)\n\n![B](assets/a.png)\n');
  });

  it('links equal bytes the new folder already has instead of copying them', async () => {
    const tree = { 'old/plan.md': '![Chart](assets/chart.png)\n', 'old/assets/chart.png': png, 'new/assets/logo.png': png };
    const moved = await captured(tree, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.equal(moved.files.size, 0);
    assert.equal(moved.body, '![Chart](assets/logo.png)\n');
  });

  it('keeps linking the old file when every name in the new folder holds other bytes', async () => {
    const tree = { 'old/plan.md': '![Chart](assets/chart.png)\n', 'old/assets/chart.png': png, 'new/assets/chart.png': other, [`new/assets/${pngHash}.png`]: Buffer.concat([other, other]) };
    const moved = await captured(tree, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.equal(moved.files.size, 0);
    assert.equal(moved.body, '![Chart](../old/assets/chart.png)\n');
  });

  it('checks a copy named by its hash as a captured upload', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svgHash = createHash('sha256').update(svg).digest('hex');
    const svgUrl = 'https://uploads.linear.app/workspace/diagram.svg';
    const tree = { 'old/plan.md': '![Diagram](assets/diagram.svg)\n', 'old/assets/diagram.svg': svg, 'new/assets/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' };
    await assert.rejects(captured(tree, 'new/plan.md', `![Diagram](${svgUrl})\n`, new Map([[svgHash, svgUrl]]), { body: tree['old/plan.md'], path: 'old/plan.md' }),
      (error: unknown) => error instanceof ImageBlockedError && error.findings.some((finding) => finding.reason === 'unsupported-type'));
  });

  it('refuses to write through an assets entry that is a file, and a move keeps linking the old file', async () => {
    await assert.rejects(captured({ 'docs/plan.md': 'Plan.\n', 'docs/assets': 'not a folder\n' }, 'docs/plan.md', `![Pasted](${url})\n`), /asset destination already exists/);
    const tree = { 'old/plan.md': '![Chart](assets/chart.png)\n', 'old/assets/chart.png': png, 'new/assets': 'not a folder\n' };
    const moved = await captured(tree, 'new/plan.md', `![Chart](${url})\n`, new Map([[pngHash, url]]), { body: tree['old/plan.md'], path: 'old/plan.md' });
    assert.equal(moved.files.size, 0);
    assert.equal(moved.body, '![Chart](../old/assets/chart.png)\n');
  });
});
