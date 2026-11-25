// `fix` is idempotent over the test corpus: a second run changes nothing.
// The corpus files are already in Linear's form, so each is also checked
// with a bare URL added at its end: one ending in a backslash, a line that
// once made `fix` copy the document into the link on every run, and one
// holding characters that are inline syntax in a link's text, which once
// turned part of the link text into emphasis or strikethrough, and URLs
// the parser does not link but Markdown's search inside text does, which
// once made `fix` leave the whole file unformatted. The first run may only
// turn each such URL into one link whose text reads as the URL, with any
// surrounding literal brackets escaped.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fixText, linkedFileCheck, lintText } from '../../src/format/index.ts';
import { buildCorpus } from '../corpus/generate.ts';

const corpus = buildCorpus('0'.repeat(40));
const paths = new Set(corpus.files.map((file) => file.path));
const markdown = corpus.files.filter((file) => file.synced && file.kind === 'markdown');

const URL_LINES: ReadonlyArray<readonly [string, string]> = [
  ['https://example.com/a\\\nNext line.', '[https://example.com/a\\\\](<https://example.com/a%5C>)\nNext line.'],
  ['https://example.com/a?k=1\\_2\\_\\_3&t=4~5~6*7*8', '[https://example.com/a?k=1\\\\\\_2\\\\\\_\\\\\\_3&t=4\\~5\\~6\\*7\\*8](<https://example.com/a?k=1%5C_2%5C_%5C_3&t=4~5~6*7*8>)'],
  ['Site:www.example.com, "www.example.com" and [https://example.com].', 'Site:www.example.com, "[www.example.com](<http://www.example.com>)" and \\[[https://example.com](<https://example.com>)\\].'],
];

describe('fix is idempotent over the corpus', () => {
  it(`holds for ${markdown.length} corpus files, each also with bare URLs that end in a backslash, hold inline syntax or sit inside other text`, () => {
    for (const file of markdown) {
      const options = { linkedFileExists: linkedFileCheck(file.path, (target) => paths.has(target)) };
      const source = file.content.toString('utf8');
      const once = fixText(source, options);
      assert.equal(fixText(once, options), once, `${file.path}: a second fix changes nothing`);

      for (const [line, linked] of URL_LINES) {
        const variant = `${source}\n\n${line}\n`;
        const fixed = fixText(variant, options);
        const name = `${file.path} with ${JSON.stringify(line)}`;
        assert.equal(fixText(fixed, options), fixed, `${name}: a second fix changes nothing`);
        // Either fix leaves the file (a lint finding), or the URL becomes one link and nothing grows.
        if (lintText(file.path, variant, options).length === 0) assert.notEqual(fixed, variant, `${name}: fix writes the link`);
        if (fixed !== variant) {
          assert.ok(fixed.endsWith(linked), `${name}: the URL becomes one link`);
          assert.ok(fixed.length <= variant.length + linked.length, `${name}: fix grew ${variant.length} characters to ${fixed.length}`);
          const count = (text: string): Map<string, number> => {
            const counts = new Map<string, number>();
            for (const { rule } of lintText(file.path, text, options)) counts.set(rule, (counts.get(rule) ?? 0) + 1);
            return counts;
          };
          const before = count(variant);
          const added = [...count(fixed)].filter(([rule, n]) => n > (before.get(rule) ?? 0));
          assert.deepEqual(added, [], `${name}: lint finds nothing new after fix`);
        }
      }
    }
  });
});
