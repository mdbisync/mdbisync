// One case per fix rule, plus what fix must leave alone. The fixture bank
// test (test/format/bank.test.ts) checks the same rules against Linear's
// recorded forms.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixText } from './fix.ts';
import { linkedFileCheck } from './lint.ts';

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
  ['a task or numbered item with only a video link keeps the file block (the video form is recorded for bullets)', '- [ ] [Demo](demo.mp4)\n\n1. [Demo](demo.mp4)', '- [ ] \n  [Demo](demo.mp4)\n\n1. \n   [Demo](demo.mp4)'],
  ['a bullet item with only an MP3 link keeps the link on its line, in angle brackets', '* \n  [Voice note](media/note.mp3)\n* [Call](<call one.MP3>)\n* [Memo](memo.mp3?v=2)', '* [Voice note](<media/note.mp3>)\n* [Call](<call%20one.MP3>)\n* [Memo](<memo.mp3?v=2>)'],
  ['a task or numbered item with only an MP3 link keeps the file block (the MP3 form is recorded for bullets)', '- [ ] [Note](note.mp3)\n\n1. [Note](note.mp3)', '- [ ] \n  [Note](note.mp3)\n\n1. \n   [Note](note.mp3)'],
  ['a list item with only a video link becomes a video on its line', '* [Demo](media/demo.mp4)\n* [Clip](<clip one.MOV>)\n* [Loop](loop.webm)', '* [Demo](media/demo.mp4)\n* [Clip](clip%20one.MOV)\n* [Loop](loop.webm)'],
  ['tables get outer pipes and short separators', 'A | B\n--- | ---\n1 | 2', '| A | B |\n| -- | -- |\n| 1 | 2 |'],
  ['a hash header cell is escaped', '| # | Customer |\n| --- | --- |\n| 1 | Example |', '| \\# | Customer |\n| -- | -- |\n| 1 | Example |'],
  ['a hash header in a quote is escaped', '> | Name | # |\n> | -- | -- |\n> | Example | 1 |', '> | Name | \\# |\n> | -- | -- |\n> | Example | 1 |'],
  ['hash escapes keep cell text and inline markup', '| \\# | `#` | **#** | Issue # |\n| -- | -- | -- | -- |\n| \\# | `#` | **#** | Issue # |', '| \\# | `#` | **#** | Issue # |\n| -- | -- | -- | -- |\n| \\# | `#` | **#** | Issue # |'],
  ['an escaped hash body cell keeps its escape', '| Name | No. |\n| --- | --- |\n| Example | \\# |', '| Name | No. |\n| -- | -- |\n| Example | \\# |'],
  ['a hash inside cell text needs no escape', '| A |\n| -- |\n| Issue \\# |', '| A |\n| -- |\n| Issue # |'],
  ['an escaped hash starting a cell keeps its escape', '| \\# 1 | A |\n| -- | -- |\n| \\# 2 | \\## |', '| \\# 1 | A |\n| -- | -- |\n| \\# 2 | \\## |'],
  ['a file with a bare hash body cell is left alone', '| Name | No. |\n| --- | --- |\n| Example | # |', '| Name | No. |\n| --- | --- |\n| Example | # |'],
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

describe('links to files that are not there', () => {
  const missing = { linkedFileExists: (url: string) => !url.includes('missing') };
  it('a list item with only a link to a missing file stays a link, as Linear keeps it', () => {
    const text = '* [Report](missing/report.pdf)\n* [Demo](missing/demo.mp4)\n* \n  [Note](missing/note.mp3)\n* [Here](report.pdf)';
    const expected = '* [Report](<missing/report.pdf>)\n* [Demo](<missing/demo.mp4>)\n* [Note](<missing/note.mp3>)\n* \n  [Here](report.pdf)';
    assert.equal(fixText(text, missing), expected);
    assert.equal(fixText(expected, missing), expected, 'the result is a fixed point');
  });
  it('the check resolves links as the sync does: rooted, outside and folder links are not uploaded', () => {
    const check = linkedFileCheck('docs/notes.md', (path) => path === 'docs/media/demo one.mp4' || path === 'top.pdf');
    assert.equal(check('media/demo%20one.mp4'), true);
    assert.equal(check('../top.pdf'), true);
    assert.equal(check('/top.pdf'), false);
    assert.equal(check('../../outside.pdf'), false);
    assert.equal(check('media/'), false);
    assert.equal(fixText('* [Spec](/top.pdf)', { linkedFileExists: check }), '* [Spec](</top.pdf>)');
  });
  it('rewrites a text whose images are not repository files: the sync fixes bodies after it maps images to uploads', () => {
    const body = '- Plan\n\n![Chart](https://uploads.linear.app/a/b/chart.png)\n\n![Gone](gone.png)';
    const fixed = '* Plan\n\n![Chart](https://uploads.linear.app/a/b/chart.png)\n\n![Gone](gone.png)';
    assert.equal(fixText(body, { linkedFileExists: () => false }), fixed);
  });

  it('without the check every linked file is taken to exist', () => {
    assert.equal(fixText('* [Report](<missing/report.pdf>)'), '* \n  [Report](missing/report.pdf)');
  });
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

  it('keeps text that would turn into markup', () => {
    for (const text of [
      '* \\# not a heading',
      '> \\# not a heading',
      'a\n\\# b',
      '## Issue \\#',
      '&#45; not a list',
      'Text\n&#61;&#61;&#61;',
      '&#36;&#36;',
      '&#58;tada&#58;',
      ':constructor: :toString:',
    ]) {
      assert.equal(fixText(text), text, text);
    }
  });

  it('keeps a literal > or # at the start of a continuation line', () => {
    assert.equal(fixText('a\n    > b'), 'a\n    > b');
    assert.equal(fixText('a\n    # b'), 'a\n    # b');
  });

  it('keeps spaces that belong to a code span across lines', () => {
    assert.equal(fixText('`a\n  b`'), '`a\n  b`');
    assert.equal(fixText('> `a\n>   b`'), '> `a\n>   b`');
  });

  it('writes a setext heading of two lines as one ATX line', () => {
    assert.equal(fixText('Title\nmore\n====='), '# Title more');
  });

  it('keeps image alt text and destinations valid', () => {
    assert.equal(fixText('![a\\]b](x.png)'), '![a\\]b](x.png)');
    assert.equal(fixText('![a](<a)b.png>)'), '![a](a%29b.png)');
  });

  it('encodes characters that would end an angle-bracket destination', () => {
    assert.equal(fixText('[a](https://example.com/?q=a&gt;b)'), '[a](<https://example.com/?q=a%3Eb>)');
  });

  it('encodes spaces and parentheses in a file block destination', () => {
    assert.equal(fixText('* [Report](<my report.pdf>)'), '* \n  [Report](my%20report.pdf)');
    assert.equal(fixText('* [Report](<a)b.pdf>)'), '* \n  [Report](a%29b.pdf)');
  });

  it('keeps what a destination means: references and escapes stay escaped', () => {
    const once = fixText('[a](<https://example.com/?q=&amp;copy;>)');
    assert.equal(once, '[a](<https://example.com/?q=&amp;copy;>)');
    assert.equal(fixText('[a](https://example.com/?a=1&b=2)'), '[a](<https://example.com/?a=1&b=2>)');
    assert.equal(fixText('[a](<x\\\\*y>)'), '[a](<x\\\\*y>)');
  });

  it('keeps a tilde fence whose info string holds a backtick', () => {
    assert.equal(fixText('~~~ foo`bar\nx\n~~~'), '~~~foo`bar\nx\n~~~');
  });

  it('settles a list that mixes task and plain items', () => {
    const once = fixText('* [ ] a\n* b');
    assert.equal(once, '- [ ] a\n\n* b');
    assert.equal(fixText(once), once);
  });

  it('treats an opening line with trailing spaces as front matter', () => {
    assert.equal(fixText('--- \ntitle: x\n---\n\n- a'), '--- \ntitle: x\n---\n\n* a');
  });

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
