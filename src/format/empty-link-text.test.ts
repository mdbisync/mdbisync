// Linear drops a link without text, and its URL with it: `lint` reports it,
// and `fix` writes the URL as the link text, with a warning.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runFix, runLint } from './command.ts';
import { fixText } from './fix.ts';
import { lintText } from './lint.ts';

function inFolder(text: string, check: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'empty-link-text-'));
  try {
    writeFileSync(join(dir, 'notes.md'), text);
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const finding = (line: number) => `notes.md:${line}: link-without-text: `;
const warning = (line: number) => `notes.md:${line}: warning: link-text-from-url: `;

describe('links without text', () => {
  for (const [form, text, expected, lines] of [
    ['inline', 'Intro.\n\n[](https://example.com/a)\n', 'Intro.\n\n[https://example.com/a](<https://example.com/a>)', [3]],
    ['next to text', 'text.[](https://example.com/a)more\n', 'text.[https://example.com/a](<https://example.com/a>)more', [1]],
    ['reference', 'See [][guide].\n\n[guide]: https://example.com/guide\n', 'See [https://example.com/guide](<https://example.com/guide>).', [1]],
    ['list item', '- one\n- two [](https://example.com/b)\n', '* one\n* two [https://example.com/b](<https://example.com/b>)', [2]],
    ['quote', '> Quoted [](https://example.com/c) text\n', '> Quoted [https://example.com/c](<https://example.com/c>) text', [1]],
    ['fragment and escaped URL, one line', 'See [](#setup) and [](https://example.com/a_b*c).\n', 'See [#setup](<#setup>) and [https://example.com/a_b\\*c](<https://example.com/a_b*c>).', [1]],
    ['bracket in the URL', 'A [](https://example.com/[x]) link\n', 'A [https://example.com/\\[x\\]](<https://example.com/[x]>) link', [1]],
    ['tilde and shortcode', 'A [](https://example.com/a~b~c/:smile:) link\n', 'A [https://example.com/a\\~b\\~c/\\:smile:](<https://example.com/a~b~c/:smile:>) link', [1]],
    ['after front matter', '---\ntitle: Plan\n---\n\nSee [](https://example.com/a).\n', '---\ntitle: Plan\n---\n\nSee [https://example.com/a](<https://example.com/a>).', [5]],
  ] as const) {
    // One finding and one warning per line.
    it(`lint reports a ${form} link, fix writes its URL as its text and warns`, () => inFolder(text, (dir) => {
      const linted = runLint(['notes.md'], dir);
      assert.equal(linted.exitCode, 1);
      for (const line of lines) assert.ok(linted.stdout.includes(finding(line)), linted.stdout);
      const fixed = runFix(['notes.md'], dir);
      assert.equal(fixed.exitCode, 1);
      assert.equal(fixed.stdout.split('\n')[0], 'notes.md: fixed');
      assert.doesNotMatch(fixed.stdout, /link-without-text/);
      assert.equal(fixed.stdout.split(warning(lines[0])).length - 1, lines.length, fixed.stdout);
      assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), expected);
      const again = runFix(['notes.md'], dir);
      assert.deepEqual([again.exitCode, again.stdout], [0, '']);
      const clean = runLint(['notes.md'], dir);
      assert.deepEqual([clean.exitCode, clean.stdout], [0, '']);
    }));
  }

  it('warns in line order next to the web image warning', () => inFolder('[](https://example.com/a)\n\n![](https://example.com/i.png)\n\n[](https://example.com/b)\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.deepEqual(fixed.stdout.split('\n').slice(1, -1).map((line) => line.split(': ').slice(0, 3).join(': ')), [
      'notes.md:1: warning: link-text-from-url',
      'notes.md:3: warning: image-made-link',
      'notes.md:5: warning: link-text-from-url',
    ]);
    assert.equal(runLint(['notes.md'], dir).exitCode, 0);
  }));

  it('leaves a link with neither text nor URL to its author', () => inFolder('Empty []() link\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.equal(fixed.exitCode, 1);
    assert.match(fixed.stdout, /^notes\.md: fixed\nnotes\.md:1: link-without-text: /);
    assert.doesNotMatch(fixed.stdout, /link-text-from-url/);
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), 'Empty [](<>) link');
    const again = runFix(['notes.md'], dir);
    assert.match(again.stdout, /^notes\.md:1: link-without-text: /);
    assert.doesNotMatch(again.stdout, /fixed|link-text-from-url/);
  }));

  it('still writes the other links and the rest of the file', () => inFolder('- one\n\n[](https://example.com/a)\n\nEmpty []() link\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.equal(fixed.exitCode, 1);
    assert.match(fixed.stdout, /^notes\.md: fixed\nnotes\.md:5: link-without-text: /);
    assert.ok(fixed.stdout.includes(warning(3)), fixed.stdout);
    assert.doesNotMatch(fixed.stdout, /notes\.md:5: warning/);
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), '* one\n\n[https://example.com/a](<https://example.com/a>)\n\nEmpty [](<>) link');
  }));

  it('repairs a link that ending a table exposes', () => {
    const fixed = fixText('| a\n| - |\nrow\n    [](https://example.com/a)');
    assert.equal(fixText(fixed), fixed);
    assert.deepEqual(lintText('notes.md', fixed), []);
  });

  for (const text of ['![](images/logo.png)', '[ ](https://example.com/a)', '[text](https://example.com/a)', '`[](https://example.com/a)`', '<https://example.com/a>', '\\[](https://example.com/a)']) {
    it(`does not report ${JSON.stringify(text)}`, () => {
      assert.deepEqual(lintText('notes.md', text).filter((found) => found.rule === 'link-without-text'), []);
      assert.deepEqual(lintText('notes.md', fixText(text)), []);
    });
  }
});
