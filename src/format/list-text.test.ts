// The list-number-as-text warning: numbers in a list item that Markdown reads
// as text though they look like a nested numbered list, in the source form
// and in the escaped form `fix` writes, and the commands' exit codes with it.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runFix, runLint } from './command.ts';
import { fixText } from './fix.ts';
import { lintText } from './lint.ts';
import { listTextWarnings } from './list-text.ts';

const lines = (text: string): number[] => listTextWarnings('notes.md', text).map((warning) => warning.line);

describe('list-number-as-text', () => {
  const warned: Array<[string, string, number[]]> = [
    ['a nested list numbered from 2 right below the item text', '1. Plan\n   2. Call\n   3. Write', [2]],
    ['the same list escaped by fix', '1. Plan\n   2\\. Call\n   3\\. Write', [2]],
    ['a parenthesis marker', '- Plan\n  4) Call', [2]],
    ['a list under a later line of the item text', '- Plan\n  the week\n  2. Call', [3]],
    ['a skipped level, numbered from 1', '1. Plan\n       1. Deep\n       2. Deeper', [2]],
    ['a skipped level, escaped', '1. Plan\n       1\\. Deep\n       2\\. Deeper', [2]],
    ['a deeper list below a reported one', '1. Plan\n   2. Call\n      3. Deep', [2, 3]],
    ['the deeper item after a doubled marker', '1. Plan\n14.  13. Text\n         2. Under\n         3. More', [3]],
    ['the deeper item after a doubled marker, escaped', '1. Plan\n2. 13\\. Text\n   2\\. Under', [3]],
    ['a tab to the next four-column stop', '- Plan\n\t2. Call', [2]],
    ['a tab past a skipped level', '- Plan\n\t\t1. Deep', [2]],
    ['a marker with no text', '- Plan\n  2.', [2]],
    ['a number with a leading zero, which cannot interrupt the text', '- Plan\n  01. Call', [2]],
    ['a list below a task item, at its checkbox', '- [ ] Plan\n  2. Call', [2]],
    ['a skipped level below a task item', '- [ ] Plan\n      1. Deep', [2]],
    ['a list below an item whose text starts on the next line', '1.\n   Plan\n   2. Call', [3]],
  ];
  for (const [name, text, expected] of warned) {
    it(`reports ${name}`, () => assert.deepEqual(lines(text), expected));
  }

  const quiet: Array<[string, string]> = [
    ['a correctly nested list', '1. Plan\n   1. Call\n   2. Write'],
    ['a nested list below a blank line', '1. Plan\n\n   2. Call'],
    ['an escaped 1 at the nested place, written on purpose', '- Plan\n  1\\. Call'],
    ['the items below an escaped 1', '- Plan\n  1\\. Call\n  2\\. Write'],
    ['an escaped list that starts a paragraph of its own', '- Plan\n\n  1\\. Call\n  2\\. Write'],
    ['an escaped list that starts on the item line', '- 1\\. Call\n  2\\. Write'],
    ['a correctly nested list below a task item', '- [ ] Plan\n  1. Call\n  2. Write'],
    ['a number inside inline code across lines', '- Plan `a\n  2. b` end'],
    ['escaped numbers outside a list item', 'Steps\n2\\. Call\n3\\. Write'],
    ['a year in a paragraph', 'Intro\n2024. A year'],
    ['a year in a list item', '- Review\n  2024. A year'],
    ['a number less indented than the item text', '- Plan\n2. Call'],
    ['a number inside text', '- Plan\n  call 2. Write'],
    ['a quote', '> - Plan\n>   2. Call'],
    ['code in an item', '- Plan\n\n  ```\n  2. Call\n  ```'],
    ['a number without a space after it', '- Plan\n  2.5 hours'],
  ];
  for (const [name, text] of quiet) {
    it(`leaves ${name}`, () => assert.deepEqual(lines(text), []));
  }

  it('counts lines from the top of the file, front matter included', () => {
    assert.deepEqual(lines('---\ntitle: Plan\n---\n\n1. Plan\n   2. Call'), [6]);
  });

  it('finds the same place before and after fix, which keeps the text as text', () => {
    const text = '1. Plan\n   2. Call\n   3. Write';
    const fixed = fixText(text);
    assert.equal(fixed, '1. Plan\n   2\\. Call\n   3\\. Write');
    assert.deepEqual(lines(fixed), lines(text));
  });

  it('is no lint finding', () => {
    assert.deepEqual(lintText('notes.md', '1. Plan\n   2\\. Call'), []);
  });

  it('is printed by lint and fix without failing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'list-text-'));
    try {
      writeFileSync(join(dir, 'notes.md'), '1. Plan\n   2. Call');
      const fixed = runFix(['notes.md'], dir);
      assert.equal(fixed.exitCode, 1);
      assert.match(fixed.stdout, /^notes\.md: fixed\nnotes\.md:2: warning: list-number-as-text: /);
      assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), '1. Plan\n   2\\. Call');
      const again = runFix(['notes.md'], dir);
      assert.equal(again.exitCode, 0);
      assert.match(again.stdout, /^notes\.md:2: warning: list-number-as-text: .*renumber its first item to 1\./);
      const linted = runLint(['notes.md'], dir);
      assert.equal(linted.exitCode, 0);
      assert.equal(linted.stdout, again.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
