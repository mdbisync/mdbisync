// `plus-line-in-item` and `tab-indentation`: lint reports what fix writes in
// Linear's form, fix's output is clean of both, and a text fix leaves as it
// is never has them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixText } from './fix.ts';
import { lintInTree, lintText } from './lint.ts';

const found = (text: string, rule: string): number[] => lintText('doc.md', text).filter((finding) => finding.rule === rule).map((finding) => finding.line);

describe('plus-line-in-item', () => {
  const reported: Array<[string, number[]]> = [
    ['- Water the beds\n  +\n  in the morning', [2]],
    ['1. Order seeds\n   +', [2]],
    ['* Week\n  * Plan\n    +\n    Send the notes', [3]],
    ['- Water\n  \\+\n  daily', [2]],
    ['---\ntitle: Chores\n---\n\n- Water\n  +\n  daily', [6]],
    // The item's text starts below its marker: fix moves it onto the marker's line.
    ['1.\n   Plan\n   +\n   More', [3]],
    ['\uFEFF- Water\n  +\n  daily', [2]],
  ];
  for (const [text, lines] of reported) {
    it(`reports and fix writes it: ${JSON.stringify(text)}`, () => {
      assert.deepEqual(found(text, 'plus-line-in-item'), lines);
      const fixed = fixText(text);
      assert.notEqual(fixed, text);
      assert.match(fixed, /\+\u00a0/);
      assert.deepEqual(lintText('doc.md', fixed), []);
    });
  }

  it('leaves out what fix leaves: a quote, a later line, a paragraph, a no-break space', () => {
    for (const text of ['> - a\n>   +', '- a\n  b\n  +', 'Words\n+', '- a\n  +\u00a0\n  b', '- a\n  `+`']) {
      assert.deepEqual(found(text, 'plus-line-in-item'), [], JSON.stringify(text));
    }
  });

  it('is not reported in Linear\'s export, which fix captures as it is', () => {
    assert.deepEqual(lintText('doc.md', '- a\n  +\n  b', { linearExport: true }).filter((finding) => finding.rule === 'plus-line-in-item'), []);
  });
});

describe('tab-indentation', () => {
  const reported: Array<[string, number[]]> = [
    ['- a\n\t- b', [2]],
    ['- a\n\n\tmore', [3]],
    ['- a\n\tb', [2]],
    ['-  a\n\t\tb', [2]],
    ['1.  a\n\tb', [2]],
    ['-\ta', [1]],
    ['1.\ta', [1]],
    ['- [ ]\ta', [1]],
    ['#\ta', [1]],
    ['>\ta', [1]],
    ['> \tb', [1]],
    ['> a\n>\tb', [2]],
    ['>\t> a', [1]],
    ['\tcode', [1]],
    ['  \tcode', [1]],
    ['\t\tcode', [1]],
    ['- a\n\n\t\tcode', [3]],
    ['* a\n\n  ```\n\tx\n  ```', [4]],
    ['| a | b |\n|---|---|\n\t| c | d |', [3]],
    ['---\ntitle: Plan\n---\n\n- a\n\t- b', [6]],
    ['> > a\n> \t> b', [2]],
    ['\t>', [1]],
    ['\uFEFF- a\n\t- b', [2]],
  ];
  for (const [text, lines] of reported) {
    it(`reports and fix writes spaces: ${JSON.stringify(text)}`, () => {
      assert.deepEqual(found(text, 'tab-indentation'), lines);
      const fixed = fixText(text);
      assert.notEqual(fixed, text);
      assert.deepEqual(found(fixed, 'tab-indentation'), []);
      assert.equal(fixText(fixed), fixed);
    });
  }

  it('leaves the tabs fix keeps: in text, in code, past a line\'s prefix, on blank lines', () => {
    const kept = [
      'a\tb',
      '`a\tb`',
      'a\n\tb',
      'x\n\t- a',
      '* a\n  \tb',
      '> a\n> \tb',
      '```\n\tx\n```',
      '* a\n\n  ```\n  \tx\n  ```',
      '<div>\n\tx\n</div>',
      '| a\t| b |\n|---|---|\n| c\t| d |',
      'a\t',
      '- a\n\t\n- b',
      '> a\n>\t\n> b',
      // Fenced code whose first line repeats the fence keeps its tabs.
      '```js\n```js\n\tb\n```',
      // A lazy line: fix writes the quote's prefix in front of the tab.
      '> a\n\tb',
    ];
    for (const text of kept) assert.deepEqual(found(text, 'tab-indentation'), [], JSON.stringify(text));
    for (const text of kept.slice(0, 9)) assert.equal(fixText(text), text, `fix keeps it: ${JSON.stringify(text)}`);
  });

  it('keeps the document out of the sync until fix writes it', () => {
    assert.deepEqual(lintInTree('doc.md', '- a\n\t- b\n', new Set()).map((finding) => finding.rule), ['tab-indentation']);
    assert.deepEqual(lintInTree('doc.md', '- a\n  +\n  b\n', new Set()).map((finding) => finding.rule), ['plus-line-in-item']);
    assert.deepEqual(lintInTree('doc.md', fixText('- a\n\t- b\n  +\n  b\n'), new Set()), []);
  });
});
