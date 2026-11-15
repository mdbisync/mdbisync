import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parse, visit } from '../format/markdown.ts';
import { destinations, findFileLinks } from './uploads.ts';

it('locates one hyperlink without repeatedly slicing overlapping label suffixes', () => {
  for (const repeats of [16, 32]) {
    const body = `[${'\\]('.repeat(repeats)}\`code ](sample)\`](https://example.com/guide)`;
    const slice = String.prototype.slice;
    let sliced = 0;
    String.prototype.slice = function (from?: number, to?: number): string {
      const result = slice.call(this, from, to);
      if (this === body) sliced += result.length;
      return result;
    };
    let found: ReturnType<typeof destinations>;
    let parsing: number;
    try {
      let links = 0;
      visit(parse(body), (node) => { if (node.type === 'link') links++; });
      assert.equal(links, 1, 'the synthetic input is one valid ordinary hyperlink');
      parsing = sliced;
      sliced = 0;
      found = destinations(body);
    } finally {
      String.prototype.slice = slice;
    }
    assert.equal(found.length, 1);
    assert.equal(body.slice(found[0]!.outer.from, found[0]!.outer.to), 'https://example.com/guide');
    // Exclude the Markdown parser's own slicing; bound the locator's extra work.
    assert.ok(sliced - parsing <= body.length * 2, `${repeats} repeats: locator sliced ${sliced - parsing} extra characters for ${body.length} input characters`);
    assert.deepEqual(findFileLinks('guide.md', body, () => true), []);
  }
});

it('uses destination tokens for escaped labels, images, definitions and inline code', () => {
  const body = [
    '[a\\](label) `](code)`](<file\\>name.png> "title ](ignored)")',
    '![outer [inner](same.png) `](code)`](same.png)',
    '[ref][a\\]:label]',
    '',
    '[a\\]:label]: <a&amp;b.png> "title"',
    '',
    '`[code](ignored.png)` and <https://example.com/auto>',
    '[empty]() and ![empty](<>)',
  ].join('\n');
  const found = destinations(body);
  assert.deepEqual(found.map(({ node }) => node.url), ['file>name.png', 'same.png', 'a&b.png', '']);
  assert.deepEqual(found.map(({ outer }) => body.slice(outer.from, outer.to)), ['<file\\>name.png>', 'same.png', '<a&amp;b.png>', '<>']);
  assert.deepEqual(found.map(({ range }) => body.slice(range.from, range.to)), ['file\\>name.png', 'same.png', 'a&amp;b.png', '']);
});

it('keeps destination offsets in the original body when parsing skips a leading BOM', () => {
  for (const prefix of ['\uFEFF', '\uFEFF\uFEFF', '']) {
    const body = `${prefix}[a](file.png) and ![b](<other.png>)\n\n[r]: ref.png`;
    const found = destinations(body);
    assert.deepEqual(found.map(({ outer }) => body.slice(outer.from, outer.to)), ['file.png', '<other.png>', 'ref.png']);
    assert.deepEqual(findFileLinks('guide.md', body, () => true).map(({ written }) => written), ['file.png', '<other.png>', 'ref.png']);
  }
});
