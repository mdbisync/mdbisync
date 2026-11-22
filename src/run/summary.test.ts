import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cell } from './summary.ts';
import { MARKUP_TEXTS, tableRows } from './summary-test-helpers.ts';
import { runScaleScript } from '../scale-test-helpers.ts';

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

  // The linked part as it was cut while the whole URL was cut and recounted
  // for each trailing character.
  const previousLinkedPart = (url: string): string => {
    for (;;) {
      const entity = /&[A-Za-z0-9]+;$/.exec(url);
      if (entity !== null) url = url.slice(0, entity.index);
      else if (/[?!.,:*_~'"]$/.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1);
      else return url;
    }
  };

  it('ends a URL where it did, for every short ending of parentheses, punctuation, entities and letters', () => {
    let endings = [''];
    for (let length = 1; length <= 6; length++) {
      endings = endings.flatMap((ending) => [')', '(', '.', '&', ';', 'a', '"'].map((char) => ending + char));
      for (const ending of endings) {
        const url = `www.a.b${ending}`;
        const linked = previousLinkedPart(url);
        const expected = linked.replace(/[\\|]/g, (char) => `\\${char}`) + url.slice(linked.length).replace(/[\\&]/g, (char) => `\\${char}`);
        assert.equal(cell(url), expected, url);
      }
    }
  });

  // A long run of `)` after a bare URL was cut one character at a time, each
  // cut recounting the whole URL: minutes for a long path or team name. A
  // child process with a timeout runs it.
  it('ends a URL followed by a long run of parentheses in linear time', () => {
    const result = runScaleScript<{ length: number }>({ summary: new URL('./summary.ts', import.meta.url) }, `
      console.log(JSON.stringify({ length: summary.cell('www.a.b' + ')'.repeat(500_000) + '.'.repeat(500_000) + ' x').length }));
    `, 30_000);
    assert.ok(result.length > 1_000_000);
  });
});
