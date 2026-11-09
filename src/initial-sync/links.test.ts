// Links between synchronized documents: relative paths to document URLs and back.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { type LinearClient } from '../linear/index.ts';
import { type LinkSpellings, documentLinks, documentUrlBase, linkDestinations, linksFromLinear, linksToLinear, relativeLink, resolveRelative } from './links.ts';
import { type TransformContext } from './transform.ts';

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

  it('keeps document URLs the file already has, and they do not take the spelling of a rewritten link', () => {
    const map = ids({ 'eng/guide.md': 'id-guide' });
    const body = `Already [a](<${BASE}/id-guide>) and [b](${BASE}/id-guide), then [c](./guide.md).`;
    const seen: LinkSpellings = new Map();
    const written = linksToLinear(body, 'eng/plan.md', map, seen);
    assert.equal(written, `Already [a](<${BASE}/id-guide>) and [b](${BASE}/id-guide), then [c](<${BASE}/id-guide>).`);
    assert.equal(linksFromLinear(written, 'eng/plan.md', map, seen), body);
  });

  it('writes a fragment the parser decoded so that it reads back the same', () => {
    const map = ids({ 'eng/guide.md': 'id-guide' });
    for (const body of ['[x](guide.md#a&amp;copy;)', '[x](<guide.md#a\\>b>)', '[x](guide.md#a&gt;b)', '[x](guide.md#a\\(b)']) {
      const seen: LinkSpellings = new Map();
      const written = linksToLinear(body, 'eng/plan.md', map, seen);
      const [destination] = linkDestinations(written);
      assert.ok(destination !== undefined && destination.url.startsWith(`${BASE}/id-guide#`), `${body} -> ${written}`);
      assert.equal(written.slice(destination.to), ')', `${body}: the link ends early: ${written}`);
      assert.equal(linksFromLinear(written, 'eng/plan.md', map, seen), body);
    }
  });

  it('does not touch what it cannot place exactly: links split over quoted lines, labels with escapes done right', () => {
    const map = ids({ 'eng/guide.md': 'id-guide' });
    const quoted = '> [x](\n> guide.md)';
    assert.equal(linksToLinear(quoted, 'eng/plan.md', map), quoted);
    const definition = '[go][a\\]:b]\n\n[a\\]:b]: guide.md';
    assert.equal(linksToLinear(definition, 'eng/plan.md', map), `[go][a\\]:b]\n\n[a\\]:b]: <${BASE}/id-guide>`);
  });

  it('leaves a definition an image uses as it is', () => {
    const map = ids({ 'eng/guide.md': 'id-guide' });
    const body = '![diagram][d] and [the guide][g]\n\n[d]: ./guide.md\n[g]: ./guide.md';
    assert.equal(linksToLinear(body, 'eng/plan.md', map), `![diagram][d] and [the guide][g]\n\n[d]: ./guide.md\n[g]: <${BASE}/id-guide>`);
  });

  it('reads the workspace URL key only for a document that links another, once per run', async () => {
    let requests = 0;
    const linear = { request: async () => ((requests += 1), { organization: { urlKey: 'example-team' } }) } as unknown as LinearClient;
    const context = { linear, documentIds: new Map([['eng/guide.md', 'id-guide'], ['eng/plan.md', 'id-plan']]) } as unknown as TransformContext;
    const transform = documentLinks();
    await transform.prepare?.(context);
    assert.equal(await transform.apply({ path: 'eng/guide.md', body: 'No links. [site](<https://example.com>)' }), 'No links. [site](<https://example.com>)');
    assert.equal(requests, 0);
    assert.equal(await transform.apply({ path: 'eng/plan.md', body: '[g](guide.md)' }), `[g](<${BASE}/id-guide>)`);
    assert.equal(await transform.apply({ path: 'eng/guide.md', body: '[p](plan.md)' }), `[p](<${BASE}/id-plan>)`);
    assert.equal(requests, 1);
    assert.equal(transform.restore({ path: 'eng/plan.md', body: `[g](<${BASE}/id-guide>)` }), '[g](guide.md)');
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
        const leftRelative = linkDestinations(written).filter((d) => map.ids.has(resolveRelative(file, d.url)?.path ?? ''));
        assert.deepEqual(leftRelative, [], `${variant}: a link to a document is left relative`);
        assert.equal(linksFromLinear(written, file, map, seen), text, variant);
      }
    }
    assert.ok(linked >= 10, `only ${linked} fixtures had document links`);
  });
});
