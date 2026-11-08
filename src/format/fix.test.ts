// One case per fix rule, plus what fix must leave alone. The fixture bank
// test (test/format/bank.test.ts) checks the same rules against Linear's
// recorded forms.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixText } from './fix.ts';

const cases: Array<[string, string, string]> = [
  ['CRLF and CR line endings become LF', 'One.\r\n\r\nTwo.\rThree.', 'One.\n\nTwo.\nThree.'],
  ['final line breaks go', 'Text.\n\n\n', 'Text.'],
  ['a file of blank lines becomes empty', '  \n\t\n', ''],
  ['extra blank lines between blocks collapse', 'One.\n\n\n\nTwo.', 'One.\n\nTwo.'],
  ['setext headings become ATX', 'Title\n=====\n\nSub\n---\n\nText.', '# Title\n\n## Sub\n\nText.'],
  ['closing hashes go', '## Summary ##', '## Summary'],
  ['thematic breaks become ---', '***\n\n___\n\n- - -', '---\n\n---\n\n---'],
  ['bullets become *', '- a\n- b', '* a\n* b'],
  ['a + bullet becomes *', '+ a', '* a'],
  ['loose lists become tight', '* a\n\n* b', '* a\n* b'],
  ['ordered lists use dots and count up', '1) a\n1) b\n1) c', '1. a\n2. b\n3. c'],
  ['an ordered list keeps its start', '3. a\n4. b', '3. a\n4. b'],
  ['task items use - and an uppercase X', '* [x] done\n* [ ] open', '- [X] done\n- [ ] open'],
  ['nested task items line up after the dash', '* [ ] a\n  * [x] b', '- [ ] a\n  - [X] b'],
  ['a nested list follows its paragraph on the next line', '* a\n\n  * b', '* a\n  * b'],
  ['item paragraphs stay a blank line apart', '* a\n\n  more\n* b', '* a\n\n  more\n* b'],
  ['lazy quote lines get their marker', '> one\ntwo', '> one\n> two'],
  ['tilde fences become backticks', '~~~js\nx\n~~~', '```js\nx\n```'],
  ['indented code becomes a fence', 'Text.\n\n    code', 'Text.\n\n```\ncode\n```'],
  ['a fence grows past backticks inside', '````md\n```\nx\n```\n````', '````md\n```\nx\n```\n````'],
  ['$$ math becomes a math fence', '$$\nx^2\n$$', '```math\nx^2\n```'],
  ['underscore emphasis becomes asterisks', '__bold__ and _em_', '**bold** and *em*'],
  ['link destinations go in angle brackets', '[a](https://example.com/x)', '[a](<https://example.com/x>)'],
  ['spaces in a destination are encoded', '[a](<b c.md>)', '[a](<b%20c.md>)'],
  ['reference links are written inline', '[a][r]\n\n[r]: https://example.com', '[a](<https://example.com>)'],
  ['autolinks become links', '<https://example.com>', '[https://example.com](<https://example.com>)'],
  ['bare URLs become links', 'See https://example.com now.', 'See [https://example.com](<https://example.com>) now.'],
  ['mail autolinks become mailto links', '<help@example.com>', '[help@example.com](<mailto:help@example.com>)'],
  ['reference images are written inline', '![a][i]\n\n[i]: x.png', '![a](x.png)'],
  ['an image leaves a paragraph with text', 'Before ![a](x.png) after.', 'Before\n\n![a](x.png)\n\nafter.'],
  ['a list item with only a file link becomes a file block', '* [Report](report.pdf)', '* \n  [Report](report.pdf)'],
  ['tables get outer pipes and short separators', 'A | B\n--- | ---\n1 | 2', '| A | B |\n| -- | -- |\n| 1 | 2 |'],
  ['ragged rows fit the header', '| A | B |\n| -- | -- |\n| 1 |\n| 1 | 2 | 3 |', '| A | B |\n| -- | -- |\n| 1 |  |\n| 1 | 2 |'],
  ['character references become characters', 'Fish &amp; chips &mdash; &copy;', 'Fish & chips — ©'],
  ['references that would make markup stay', '&lt;b&gt; &amp;amp;', '&lt;b&gt; &amp;amp;'],
  ['emoji shortcodes become emoji', 'Done :tada:, unknown :not_an_emoji:', 'Done \u{1F389}, unknown :not_an_emoji:'],
  ['a backslash before a letter is doubled', '$\\pi$', '$\\\\pi$'],
  ['an escaped # inside a line loses its escape', 'a \\# b', 'a # b'],
];

describe('fix rules', () => {
  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected, 'the result is a fixed point');
    });
  }
});

describe('what fix leaves alone', () => {
  const kept: Array<[string, string]> = [
    ['escapes that matter', 'Literal \\*stars\\* and \\[brackets\\]'],
    ['a two-space line break', 'one  \ntwo'],
    ['a code fence with blank lines', '```text\na\n\n\nb\n```'],
    ['HTML blocks', '<details>\n<summary>More</summary>\n\nText.\n\n</details>'],
    ['a relative image path', '![Logo](../assets/logo.png)'],
    ['front matter, byte for byte', '---\ntitle:   Spaced   \nlist: [a,b]\n---\n\n# Body'],
    ['a byte order mark', '﻿Text.'],
  ];
  for (const [name, text] of kept) {
    it(name, () => assert.equal(fixText(text), text));
  }

  it('fixes the body after front matter and keeps the front matter', () => {
    assert.equal(fixText('---\na: 1\n---\n\n- item\n'), '---\na: 1\n---\n\n* item');
  });

  it('leaves a file with a lint finding untouched', () => {
    const text = '- item with a note[^1]\n\n[^1]: The note.\n';
    assert.equal(fixText(text), text);
  });

  it("keeps the sync's conflict marker paragraphs byte for byte", () => {
    const conflict = [
      '* Item one',
      '',
      '**Sync conflict: git version**',
      '',
      '* Item two, our version',
      '',
      '**Sync conflict: Linear version**',
      '',
      '* Item two, their version',
      '',
      '**Sync conflict: end**',
      '',
      '| A |',
      '| -- |',
      '| 1 |',
      '',
      '**Sync conflict: git version**',
      '',
      '```',
      'code',
      '```',
      '',
      '**Sync conflict: end**',
    ].join('\n');
    assert.equal(fixText(conflict), conflict);
  });
});
