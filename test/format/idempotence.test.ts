// `fix` is idempotent over the test corpus: a second run changes nothing.
// The corpus files are already in Linear's form, so each is also checked
// with a bare URL ending in a backslash added at its end, a line that once
// made `fix` copy the document into the link on every run: the first run
// may only turn that URL into one link.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fixText, linkedFileCheck } from '../../src/format/index.ts';
import { buildCorpus } from '../corpus/generate.ts';

const corpus = buildCorpus('0'.repeat(40));
const paths = new Set(corpus.files.map((file) => file.path));
const markdown = corpus.files.filter((file) => file.synced && file.kind === 'markdown');

const URL_LINE = 'https://example.com/a\\\nNext line.';
const LINKED = '[https://example.com/a\\\\](<https://example.com/a%5C>)\nNext line.';

describe('fix is idempotent over the corpus', () => {
  it(`holds for ${markdown.length} corpus files, each also with a bare URL ending in a backslash`, () => {
    for (const file of markdown) {
      const options = { linkedFileExists: linkedFileCheck(file.path, (target) => paths.has(target)) };
      const source = file.content.toString('utf8');
      const once = fixText(source, options);
      assert.equal(fixText(once, options), once, `${file.path}: a second fix changes nothing`);

      const variant = `${source}\n\n${URL_LINE}\n`;
      const fixed = fixText(variant, options);
      assert.equal(fixText(fixed, options), fixed, `${file.path} with the URL: a second fix changes nothing`);
      // Either fix leaves the file (a lint finding), or the URL becomes one link and nothing grows.
      if (fixed !== variant) {
        assert.ok(fixed.endsWith(LINKED), `${file.path} with the URL: the URL becomes one link`);
        assert.ok(fixed.length <= variant.length + LINKED.length, `${file.path} with the URL: fix grew ${variant.length} characters to ${fixed.length}`);
      }
    }
  });
});
