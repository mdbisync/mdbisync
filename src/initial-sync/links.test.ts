// Links between synchronized documents: relative paths to document URLs and back.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { type LinkSpellings, documentUrlBase, linkDestinations, linksFromLinear, linksToLinear, relativeLink, resolveRelative } from './links.ts';

const BASE = documentUrlBase('example-team');
const ids = (paths: Record<string, string>) => ({ base: BASE, ids: new Map(Object.entries(paths)) });

describe('document links', () => {
  it('resolves relative links against the linking file, and only those', () => {
    assert.deepEqual(resolveRelative('eng/notes/plan.md', '../guide.md#setup'), { path: 'eng/guide.md', fragment: 'setup' });
    assert.deepEqual(resolveRelative('eng/notes/plan.md', './faq.md'), { path: 'eng/notes/faq.md', fragment: undefined });
    assert.deepEqual(resolveRelative('eng/notes/plan.md', 'target%20with%20spaces.md'), { path: 'eng/notes/target with spaces.md', fragment: undefined });
    assert.deepEqual(resolveRelative('eng/notes/plan.md', '/docs/start.md'), { path: 'docs/start.md', fragment: undefined });
    for (const url of ['https://example.com/a.md', 'mailto:help@example.com', '#details', '//example.com/a.md', '../../../a.md', 'a.md?x=1', '', '../notes/']) {
      assert.equal(resolveRelative('eng/notes/plan.md', url), undefined, url);
    }
  });

  it('writes a link to a synchronized document as its URL by id, keeping the fragment and every other byte', () => {
    const body = 'See [the guide](<../guide.md#setup>) and [faq](faq.md "Questions").\n\n[ref]: ./faq.md\n';
    const written = linksToLinear(body, 'eng/notes/plan.md', ids({ 'eng/guide.md': 'id-guide', 'eng/notes/faq.md': 'id-faq' }));
    assert.equal(
      written,
      `See [the guide](<${BASE}/id-guide#setup>) and [faq](<${BASE}/id-faq> "Questions").\n\n[ref]: <${BASE}/id-faq>\n`,
    );
  });

  it('leaves links to unsynchronized files, external links, images and code as they are', () => {
    const body = [
      'Raw data is in [data.csv](<../unsynced/data.csv>) and [notes](unsynced.md).',
      '',
      '![diagram](guide.md)',
      '',
      '`[code](guide.md)`',
      '',
      '```',
      '[fenced](guide.md)',
      '```',
      '',
      'Visit [https://example.com](<https://example.com>) or [here](#guide).',
    ].join('\n');
    assert.equal(linksToLinear(body, 'eng/plan.md', ids({ 'eng/guide.md': 'id-guide' })), body);
  });

  it('maps document URLs back to the exact destination the file had', () => {
    const map = ids({ 'eng/guide.md': 'id-guide', 'eng/notes/faq.md': 'id-faq', 'eng/notes/target with spaces.md': 'id-spaces' });
    const body = [
      'Angle [a](<../guide.md#setup>), plain [b](../guide.md), dotted [c](./faq.md), encoded [d](target%20with%20spaces.md),',
      'spaced [e](<target with spaces.md>), same target twice [f](faq.md) and [g](./faq.md).',
    ].join('\n');
    const seen: LinkSpellings = new Map();
    const written = linksToLinear(body, 'eng/notes/plan.md', map, seen);
    assert.ok(!written.includes('.md'), written);
    assert.equal(linksFromLinear(written, 'eng/notes/plan.md', map, seen), body);
  });

  it('gives a link added in Linear the shortest relative path', () => {
    const map = ids({ 'eng/guide.md': 'id-guide', 'docs/a b.md': 'id-ab' });
    const content = `Read [it](<${BASE}/id-guide#setup>), [that](${BASE}/id-ab) and [other](<${BASE}/id-unknown>).`;
    assert.equal(linksFromLinear(content, 'eng/notes/plan.md', map), `Read [it](<../guide.md#setup>), [that](<../../docs/a%20b.md>) and [other](<${BASE}/id-unknown>).`);
    assert.equal(relativeLink('eng/plan.md', 'eng/guide.md'), 'guide.md');
  });

  it('finds destinations in links with nested parentheses, escapes and titles', () => {
    const body = 'A [x](a_(b).md) B [y](<c\\>d.md> "t") C [z](e\\)f.md)';
    assert.deepEqual(linkDestinations(body).map((d) => body.slice(d.from, d.to)), ['a_(b).md', '<c\\>d.md>', 'e\\)f.md']);
  });

  it('round-trips every bank fixture exactly, with every bank document synchronized', () => {
    const root = join(import.meta.dirname, '../../test/fixtures');
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.md') && !file.endsWith('.linear.md') && !file.startsWith('unsynced/') && file !== 'README.md')
      .map((file) => relative(root, join(root, file)).split('\\').join('/'));
    const map = ids(Object.fromEntries(files.map((file, index) => [file, `id-${index}`])));
    let linked = 0;
    for (const file of files) {
      for (const variant of [file, file.replace(/\.md$/, '.linear.md')]) {
        let text: string;
        try {
          text = readFileSync(join(root, variant), 'utf8');
        } catch {
          continue;
        }
        const seen: LinkSpellings = new Map();
        const written = linksToLinear(text, file, map, seen);
        if (written !== text) linked += 1;
        assert.ok(!/\]\(<?(?:\.\.\/)*[^):]*\.md/.test(written) || written.includes('unsynced'), `${variant}: a link to a document is left relative`);
        assert.equal(linksFromLinear(written, file, map, seen), text, variant);
      }
    }
    assert.ok(linked >= 10, `only ${linked} fixtures had document links`);
  });
});
