import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cell } from './summary.ts';
import { MARKUP_TEXTS, tableRows } from './summary-test-helpers.ts';

const roundTrip = (text: string) => tableRows(`| Head |\n| --- |\n| ${cell(text)} |\n`);

describe('cell', () => {
  it('shows every untrusted text as itself, one row, with only self-describing links', () => {
    for (const text of [...MARKUP_TEXTS, 'line\none\r\ntwo']) {
      assert.deepEqual(roundTrip(text), [['Head'], [text.replace(/[\r\n]+/g, ' ')]], text);
    }
  });

  it('escapes the characters GitHub turns into mentions and references, which the parser above does not model', () => {
    assert.equal(cell('Release :rocket: for @someone in #12'), 'Release :rocket: for \\@someone in \\#12');
  });

  it('leaves a bare URL as written and escapes what follows it', () => {
    assert.equal(cell('see https://example.com/a_b?x=1&y=2 *now*'), 'see https://example.com/a_b?x=1&y=2 \\*now\\*');
    assert.equal(cell('xhttps://example.com/a_b'), 'xhttps://example.com/a\\_b');
  });

  it('keeps a row one row when a URL holds a backslash before a pipe', () => {
    assert.equal(cell('https://example.com/a\\|b'), 'https://example.com/a\\\\\\|b');
    for (const text of ['https://example.com/a\\|b c', 'see www.example.com/x\\\\|y|z']) assert.equal(roundTrip(text)[1]?.length, 1, text);
  });

  it('leaves ordinary paths readable as they are', () => {
    assert.equal(cell('eng/backend/notes-2026.md'), 'eng/backend/notes-2026.md');
  });
});
