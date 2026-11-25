// One case per fix rule, plus what fix must leave alone. The fixture bank
// test (test/format/bank.test.ts) checks the same rules against Linear's
// recorded forms.

import type { Blockquote, List, Nodes, Paragraph } from 'mdast';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fixLinearText, fixText, relativeFileBlocksAsLinks } from './fix.ts';
import { linkedFileCheck, lintText } from './lint.ts';
import { parse, sameAsLinear, sameMarkdown, splitFile, visit } from './markdown.ts';

const cases: Array<[string, string, string]> = [
  ['CRLF and CR line endings become LF', 'One.\r\n\r\nTwo.\rThree.', 'One.\n\nTwo.\nThree.'],
  ['final line breaks go', 'Text.\n\n\n', 'Text.'],
  ['a file of blank lines becomes empty', '  \n\t\n', ''],
  ['extra blank lines between blocks collapse', 'One.\n\n\n\nTwo.', 'One.\n\nTwo.'],
  ['setext headings become ATX', 'Title\n=====\n\nSub\n---\n\nText.', '# Title\n\n## Sub\n\nText.'],
  ['closing hashes go', '## Summary ##', '## Summary'],
  ['thematic breaks become ---', 'Text.\n\n***\n\n___\n\n- - -', 'Text.\n\n---\n\n---\n\n---'],
  // An opening rule pair stays `***` first, or the two rules would read as front matter.
  ['an opening rule pair keeps *** first', '***\n\n___\n\n- - -', '***\n\n---\n\n---'],
  ['bullets become *', '- a\n- b', '* a\n* b'],
  ['a + bullet becomes *', '+ a', '* a'],
  ['loose lists become tight', '* a\n\n* b', '* a\n* b'],
  ['ordered lists use dots and count up', '1) a\n1) b\n1) c', '1. a\n2. b\n3. c'],
  ['an empty item keeps a space after its marker', '* a\n*\n\n1. b\n2.\n\n> -\n\n*', '* a\n* \n\n1. b\n2. \n\n> * \n\n* '],
  ['a nested empty item keeps a space after its marker', '* a\n  * b\n  *\n\n1. c\n   1. d\n   2.', '* a\n  * b\n  * \n\n1. c\n   1. d\n   2. '],
  ['an ordered list right-aligns its numbers to the widest one', '1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n10. j', ' 1. a\n 2. b\n 3. c\n 4. d\n 5. e\n 6. f\n 7. g\n 8. h\n 9. i\n10. j'],
  ['an aligned ordered list lines up every item\'s content past its widest number', '8. a\n   * b\n\n   c\n9. d\n10. e\n    * f', ' 8. a\n    * b\n\n    c\n 9. d\n10. e\n    * f'],
  ['an empty item in an aligned ordered list keeps its space', '9.\n10. a', ' 9. \n10. a'],
  ['an ordered list past 100 aligns to three digits', '99. a\n100. b\n     * c', ' 99. a\n100. b\n     * c'],
  ['an aligned ordered list nests under a bullet, in a quote and in another one', '* a\n\n  9. b\n  10. c\n\n> 9. d\n> 10. e\n\n9. f\n10. g\n\n    9. h\n    10. i', '* a\n\n   9. b\n  10. c\n\n>  9. d\n> 10. e\n\n 9. f\n10. g\n\n     9. h\n    10. i'],
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
  ['a nested bullet after its parent’s text keeps the file link on the marker line', '* Parent\n  * [Report](report.csv)', '* Parent\n  * [Report](<report.csv>)'],
  ['a nested numbered item after its parent’s text keeps the file link on the marker line', '* Parent\n  1. [Report](report.csv)', '* Parent\n  1. [Report](<report.csv>)'],
  ['a nested numbered list starting above one keeps its blank line and file block', '* Parent\n\n  3. [Report](report.csv)', '* Parent\n\n  3. \n     [Report](report.csv)'],
  ['a nested attachment after a sibling still becomes a file block', '* Parent\n  * First\n  * [Report](report.csv)', '* Parent\n  * First\n  * \n    [Report](report.csv)'],
  ['a nested list starting with an empty item keeps its blank line after the parent', '* Parent\n\n  *\n  * Next\n\n1. Parent\n\n   1.\n   2. Next', '* Parent\n\n  * \n  * Next\n\n1. Parent\n\n   1. \n   2. Next'],
  ['a nested file block keeps its existing blank line after the parent', '* Parent\n\n  * \n    [Report](report.csv)', '* Parent\n\n  * \n    [Report](report.csv)'],
  ['a task or numbered item with only a video link keeps the file block (the video form is recorded for bullets)', '- [ ] [Demo](demo.mp4)\n\n1. [Demo](demo.mp4)', '- [ ] \n  [Demo](demo.mp4)\n\n1. \n   [Demo](demo.mp4)'],
  ['a bullet item with only an MP3 link keeps the link on its line, in angle brackets', '* \n  [Voice note](media/note.mp3)\n* [Call](<call one.MP3>)\n* [Memo](memo.mp3?v=2)', '* [Voice note](<media/note.mp3>)\n* [Call](<call%20one.MP3>)\n* [Memo](<memo.mp3?v=2>)'],
  ['an MP3 task keeps its break and a numbered MP3 stays on the marker line', '- [ ] [Note](note.mp3)\n\n3. [Note](note.mp3)', '- [ ] \n  [Note](note.mp3)\n\n3. [Note](<note.mp3>)'],
  ['a list item with only a video link becomes a video on its line', '* [Demo](media/demo.mp4)\n* [Clip](<clip one.MOV>)\n* [Loop](loop.webm)', '* [Demo](media/demo.mp4)\n* [Clip](clip%20one.MOV)\n* [Loop](loop.webm)'],
  ['tables get outer pipes and short separators', 'A | B\n--- | ---\n1 | 2', '| A | B |\n| -- | -- |\n| 1 | 2 |\n'],
  ['a hash header cell is escaped', '| # | Customer |\n| --- | --- |\n| 1 | Example |', '| \\# | Customer |\n| -- | -- |\n| 1 | Example |\n'],
  ['a hash header in a quote is escaped', '> | Name | # |\n> | -- | -- |\n> | Example | 1 |', '> | Name | \\# |\n> | -- | -- |\n> | Example | 1 |\n'],
  ['hash escapes keep cell text and inline markup', '| \\# | `#` | **#** | Issue # |\n| -- | -- | -- | -- |\n| \\# | `#` | **#** | Issue # |', '| \\# | `#` | **#** | Issue # |\n| -- | -- | -- | -- |\n| \\# | `#` | **#** | Issue # |\n'],
  ['an escaped hash body cell keeps its escape', '| Name | No. |\n| --- | --- |\n| Example | \\# |', '| Name | No. |\n| -- | -- |\n| Example | \\# |\n'],
  ['a hash inside cell text needs no escape', '| A |\n| -- |\n| Issue \\# |', '| A |\n| -- |\n| Issue # |\n'],
  ['an escaped hash starting a cell keeps its escape', '| \\# 1 | A |\n| -- | -- |\n| \\# 2 | \\## |', '| \\# 1 | A |\n| -- | -- |\n| \\# 2 | \\## |\n'],
  ['a file with a bare hash body cell is left alone', '| Name | No. |\n| --- | --- |\n| Example | # |', '| Name | No. |\n| --- | --- |\n| Example | # |'],
  ['ragged rows fit the header', '| A | B |\n| -- | -- |\n| 1 |\n| 1 | 2 | 3 |', '| A | B |\n| -- | -- |\n| 1 |  |\n| 1 | 2 |\n'],
  ['character references become characters', 'Fish &amp; chips &mdash; &copy;', 'Fish & chips — ©'],
  ['references that would make markup stay', '&lt;b&gt; &amp;amp;', '&lt;b&gt; &amp;amp;'],
  ['emoji shortcodes become emoji', 'Done :tada:, unknown :not_an_emoji:', 'Done \u{1F389}, unknown :not_an_emoji:'],
  ['a backslash before a letter is doubled', '$\\pi$', '$\\\\pi$'],
  ['an escaped # inside a line loses its escape', 'a \\# b', 'a # b'],
];

/**
 * What Markdown reads: the node types, text, code and images, their URLs
 * decoded (`%28` is `(`). A line ending in a code span reads as a space,
 * also in an alt text, which keeps the text of its code spans.
 */
function readMarkdown(markdown: string): string[] {
  const out: string[] = [];
  visit(parse(markdown), (node) => {
    if (node.type === 'text') out.push(node.value);
    else if (node.type === 'inlineCode') out.push(`code ${node.value.replaceAll('\n', ' ')}`);
    else if (node.type === 'image') out.push(`image ${decodeURI(node.url)} ${node.alt?.replaceAll('\n', ' ')}`);
    else out.push(node.type);
  });
  return out;
}

/**
 * The tree Markdown reads, nested: node types, text, list starts and task
 * states. Looseness and source positions are left out, as `fix` changes them.
 */
function readTree(markdown: string): unknown {
  const node = (value: Nodes): unknown => {
    if (value.type === 'text') return value.value;
    const label = value.type === 'list' ? `list ${value.ordered ? value.start ?? 1 : '*'}` : value.type === 'listItem' ? `item ${value.checked ?? ''}` : value.type;
    return 'children' in value ? [label, ...(value.children as Nodes[]).map(node)] : label;
  };
  return node(parse(markdown));
}

describe('fix rules', () => {
  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected, 'the result is a fixed point');
    });
  }
});

describe('blank lines, the final line break and cell breaks as Linear writes them', () => {
  const written: Array<[string, string, string]> = [
    ['a document that ends with a table ends with a line break', 'Stock\n\n| Fruit | Count |\n| -- | -- |\n| Plum | 3 |', 'Stock\n\n| Fruit | Count |\n| -- | -- |\n| Plum | 3 |\n'],
    ['one line break, however many the source has', '| Fruit |\n| -- |\n| Plum |\n\n\n', '| Fruit |\n| -- |\n| Plum |\n'],
    ['also when the table ends a list item', 'Stock\n\n* Shelf\n\n  | Fruit |\n  | -- |\n  | Plum |', 'Stock\n\n* Shelf\n\n  | Fruit |\n  | -- |\n  | Plum |\n'],
    ['also when the table ends a quote', '> | Fruit |\n> | -- |\n> | Plum |', '> | Fruit |\n> | -- |\n> | Plum |\n'],
    ['a table followed by text gets none', '| Fruit |\n| -- |\n| Plum |\n\nTotal.\n', '| Fruit |\n| -- |\n| Plum |\n\nTotal.'],
    ['a top-level code block loses its blank lines before the closing fence', '```\nalpha\n\nbeta\n\n\n```\n\nAfter.', '```\nalpha\n\nbeta\n```\n\nAfter.'],
    ['also at the end of the document and with a language', '```js\nx = 1\n\n```', '```js\nx = 1\n```'],
    ['a code block of blank lines becomes empty', '```\n\n\n```', '```\n```'],
    ['a code block in a quote keeps them', '> ```\n> gamma\n>\n> ```', '> ```\n> gamma\n> \n> ```'],
    ['a code block in a list item keeps them, indented', '* Step\n\n  ```\n  delta\n\n  epsilon\n\n  ```', '* Step\n\n  ```\n  delta\n  \n  epsilon\n  \n  ```'],
    ['also in a nested item', '* Outer\n  * Inner\n\n    ```\n    n\n\n    ```', '* Outer\n  * Inner\n\n    ```\n    n\n    \n    ```'],
    ['a blank line between an item\'s blocks stays empty', '* Step\n\n  ```\n  x\n  ```\n\n  Done.', '* Step\n\n  ```\n  x\n  ```\n\n  Done.'],
    ['a line break tag in a table cell becomes a character reference', '| Step | Note |\n| -- | -- |\n| One | first<br>second |\n| Two | a<br/>b<BR />c |\n\nEnd.', '| Step | Note |\n| -- | -- |\n| One | first&#10;second |\n| Two | a&#10;b&#10;c |\n\nEnd.'],
    ['the character reference stays', '| Note |\n| -- |\n| first&#10;second |\n\nEnd.', '| Note |\n| -- |\n| first&#10;second |\n\nEnd.'],
    ['a tag in a cell\'s code span or outside a table stays', '| Note |\n| -- |\n| `a<br>b` |\n\nFirst<br>second', '| Note |\n| -- |\n| `a<br>b` |\n\nFirst<br>second'],
  ];
  for (const [name, input, expected] of written) {
    it(name, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected, 'the result is a fixed point');
      assert.deepEqual(lintText('doc.md', expected), [], 'lint is clean on the result');
    });
  }
});

describe('NBSP as Linear stores it', () => {
  const written: Array<[string, string, string]> = [
    ['a heading keeps a trailing NBSP', '### Totals \n\n### **Rates** \n\n## Two  ', '### Totals \n\n### **Rates** \n\n## Two  '],
    ['spaces after it still go', '### Totals  \t', '### Totals '],
    ['a paragraph, item and quote keep one too', 'Plain line \n\n* Item tail \n\n> Quote tail ', 'Plain line \n\n* Item tail \n\n> Quote tail '],
    ['a reference becomes the character', 'Two&nbsp;words, a&#160;b and c&#xA0;d', 'Two words, a b and c d'],
    ['also at the end of a heading or a line, and in a link label', '### Heading&nbsp;\n\nEnds&nbsp;\n\n[a&nbsp;b](https://a.test)', '### Heading \n\nEnds \n\n[a b](<https://a.test>)'],
    ['a reference in a code span or after a backslash stays', '`code&nbsp;span` and \\&nbsp;', '`code&nbsp;span` and \\&nbsp;'],
    ['a body cell keeps an NBSP around its text, in every row', '| x | z |\n| --- | --- |\n| c&nbsp;d | e  |\n| p  |  q |', '| x | z |\n| -- | -- |\n| c d | e  |\n| p  |  q |\n'],
    ['literal asterisks next to it are escaped', 'x**&nbsp;y** and **Bold&nbsp;**after', 'x\\*\\* y\\*\\* and \\*\\*Bold \\*\\*after'],
    ['also next to another decoded character', '**a&eacute;**b', '\\*\\*aé\\*\\*b'],
    ['next to bold whose reading the character keeps', 'a&nbsp;**b** and **c**&nbsp;d', 'a **b** and **c** d'],
  ];
  for (const [name, input, expected] of written) {
    it(name, () => {
      assert.equal(fixText(input), expected);
      assert.ok(sameMarkdown(input, expected), 'the same document');
      assert.equal(fixText(expected), expected, 'the result is a fixed point');
      assert.deepEqual(lintText('doc.md', expected), [], 'lint is clean on the result');
    });
  }

  it('a header cell drops an NBSP around its text, as Linear does', () => {
    assert.equal(fixText('| x | z  |\n| --- | --- |\n| p | q |'), '| x | z |\n| -- | -- |\n| p | q |\n');
  });

  it('a number the character follows is escaped, and the NBSP becomes a space', () => {
    assert.equal(fixText('20.&nbsp;Jars'), '20\\. Jars');
    assert.ok(sameMarkdown('20.&nbsp;Jars', '20\\. Jars', { linearNumberSpacing: true }));
  });

  it('keeps a reference whose character would change what a delimiter run does', () => {
    // As the character, the NBSP would keep the run from opening bold.
    for (const text of ['**&nbsp;a**', '**&nbsp;a** and b&nbsp;c']) {
      const fixed = fixText(text);
      assert.ok(sameMarkdown(fixed, text), text);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
    }
    assert.equal(fixText('**&nbsp;a**'), '**&nbsp;a**');
  });

  it('reads a character outside the Basic Multilingual Plane next to the run as one character', () => {
    // An emoji is a symbol, which flanks like punctuation in CommonMark: as
    // the character, the NBSP would keep the run from opening bold. The
    // parser fix uses reads such a run as text and escapes it; the
    // reference stays either way.
    const fixed = fixText('\u{1F600}**&nbsp;a**');
    assert.ok(fixed.includes('&nbsp;'), fixed);
    assert.ok(sameMarkdown(fixed, '\u{1F600}**&nbsp;a**'));
    assert.equal(fixText(fixed), fixed, 'a second fix changes nothing');
    assert.equal(fixText('a&nbsp;**b**\u{1F600}'), 'a **b**\u{1F600}');
  });

  it('text split off at an image keeps one at its edge', () => {
    assert.equal(fixText('Before&nbsp; ![a](x.png)&nbsp;after'), 'Before \n\n![a](x.png)\n\n after');
  });

  it('other whitespace at a heading\'s or body cell\'s end still goes', () => {
    assert.equal(fixText('### Title　\n\n| a |\n| -- |\n| b  |'), '### Title\n\n| a |\n| -- |\n| b |\n');
  });

  it('keeps a body that is only an NBSP', () => {
    const once = fixText('&nbsp;');
    assert.equal(once, ' ');
    assert.equal(fixText(once), once, 'a second fix keeps it');
  });
});

describe('a code span over lines, as Linear writes it', () => {
  const joined: Array<[string, string, string]> = [
    ['joins its lines with a space', 'See `alpha\nbeta` here.', 'See `alpha beta` here.'],
    ['also three lines', 'Three `alpha\nbeta\ngamma` lines.', 'Three `alpha beta gamma` lines.'],
    ['keeps the spaces at a line end and the next line\'s indentation', 'Spaces `alpha  \n   beta` end.', 'Spaces `alpha      beta` end.'],
    ['and a tab', 'Tab `alpha\n\tbeta` end.', 'Tab `alpha \tbeta` end.'],
    ['keeps a longer fence', 'Double `` `alpha\nbeta` `` end.', 'Double `` `alpha beta` `` end.'],
    ['drops an item\'s prefix', '* Item `alpha\n  beta` end', '* Item `alpha beta` end'],
    ['and keeps the indentation past it', '* Item `alpha\n    beta` end', '* Item `alpha   beta` end'],
    ['also a number\'s', '1. Number `alpha\n   beta` end', '1. Number `alpha beta` end'],
    ['drops a quote\'s prefix, also on a lazy line', '> Quote `alpha\n> beta` end\n\n> Quote `alpha\nbeta` lazy', '> Quote `alpha beta` end\n\n> Quote `alpha beta` lazy'],
    ['in a heading written on one line', 'Title `alpha\n  beta`\n===', '# Title `alpha   beta`'],
    ['in a link label', '[Link `alpha\nbeta`](https://a.test)', '[Link `alpha beta`](<https://a.test>)'],
  ];
  for (const [name, input, expected] of joined) {
    it(name, () => {
      assert.equal(fixText(input), expected);
      assert.ok(sameMarkdown(input, expected), 'the same document: a line ending in a code span reads as a space');
      assert.equal(fixText(expected), expected, 'the result is a fixed point');
      assert.deepEqual(lintText('doc.md', expected), [], 'lint is clean on the result');
    });
  }

  it('keeps the columns of a tab an item\'s prefix takes in part as spaces', () => {
    // The item takes two of the tab's four columns: two stay code text.
    assert.equal(fixText('* Item `alpha\n\tbeta` end'), '* Item `alpha   beta` end');
    assert.equal(fixText('- [`a\n\tb`](report.pdf)'), '* \n  [`a   b`](report.pdf)');
  });

  it('keeps the lines when a joined line would hold a pipe, which could make it a table\'s head row', () => {
    for (const text of ['x | `a\nb`\n|--|--|', '> x | `a\n> b`\n> |--|--|']) {
      assert.equal(fixText(text), text);
      assert.ok(sameMarkdown(fixText(text), text), text);
    }
  });

  it('the comparison reads any line ending in a code span as a space', () => {
    for (const ending of ['\n', '\r\n', '\r']) assert.ok(sameMarkdown(`\`a${ending}b\``, '`a b`'), JSON.stringify(ending));
  });

  it('an image\'s alt text keeps its lines', () => {
    assert.equal(fixText('* ![a `x\n  y` b](x.png)'), '* ![a `x\n  y` b](x.png)');
  });
});

describe('a backslash line break', () => {
  // [input, what fix writes]
  const written: Array<[string, string]> = [
    ['Rain on the roof\\\nand the kettle on', 'Rain on the roof\nand the kettle on'],
    ['> Quiet hours\\\n> begin at nine', '> Quiet hours\n> begin at nine'],
    ['> Quiet hours\\\nbegin at nine', '> Quiet hours\n> begin at nine'],
    ['- Pack the tent\\\n  and the stove\n- Leave early', '* Pack the tent\n  and the stove\n* Leave early'],
    ['- [ ] Water the fern\\\n  on Sunday', '- [ ] Water the fern\n  on Sunday'],
    ['[two\\\nlines](https://example.com)', '[two\nlines](<https://example.com>)'],
    ['Tabs after\\\n\tthe break', 'Tabs after\n\tthe break'],
    // The spaces or tab before the backslash stay, as Linear keeps them.
    ['Spaces before \\\nthe backslash', 'Spaces before \nthe backslash'],
    ['A tab before\t\\\nthe backslash', 'A tab before\t\nthe backslash'],
    ['A break\\\n-- then a dash line', 'A break\n\\-- then a dash line'],
    // Inline HTML cannot interrupt a paragraph, so this line stays text.
    ['Lanterns\n<b>\\\nabove', 'Lanterns\n<b>\nabove'],
    // A list starting at 2 cannot interrupt a paragraph: `2.` is text, not a prefix.
    ['Lanterns\n2. \\\nabove', 'Lanterns\n2. \nabove'],
  ];
  for (const [input, expected] of written) {
    it(`is written as Linear writes it, without the backslash: ${JSON.stringify(input)}`, () => {
      assert.deepEqual([...new Set(lintText('doc.md', input).map((finding) => finding.rule))], ['hard-break-backslash']);
      const fixed = fixText(input);
      assert.equal(fixed, expected);
      assert.equal(fixText(fixed), fixed, 'a second fix changes nothing');
      assert.deepEqual(lintText('doc.md', fixed), [], 'lint reports nothing after fix');
      // Linear holds each line ending of a paragraph as a line break: past the
      // spaces before it, which do not render, the lines are the same.
      const lines = (markdown: string) => readMarkdown(markdown).map((part) => (part === 'break' ? '\n' : part)).join('').replace(/[ \t]+\n/g, '\n');
      assert.deepEqual(lines(fixed), lines(input));
    });
  }

  it('is written next to a setext heading that fix writes on one line', () => {
    assert.equal(fixText('Garden\nplan\n===\n\nRain\\\nand tea'), '# Garden plan\n\nRain\nand tea');
  });

  it('keeps a break written with two spaces, as Linear does', () => {
    for (const input of ['Rain  \nand the kettle on', 'Rain   \nand the kettle on', '> Quiet  \n> hours']) assert.equal(fixText(input), input);
  });

  // A heading is written on one line; two spaces alone on a line would end
  // the paragraph; without its backslash a line can open a block or a checkbox.
  const left = [
    'Lanterns\\\nabove the gate\n===',
    'Intro.\n\nLanterns\\\nabove\n---\n\nAnd a paragraph\\\nwith a break',
    'Lanterns\r\nabove\\\r\nthe gate\r\n===\r\n',
    'Lanterns\n\\\nabove',
    '> Lanterns\n> \\\n> above',
    '- \\\n  above',
    'Lanterns\n#\\\nabove',
    'Lanterns\n=\\\nabove',
    'Lanterns\n***\\\nabove',
    '*\\\nabove*',
    '- [ ]\\\n  above',
    '- #\\\n  above',
    '- ###\\\n  above',
    '| x |\\\n| -- |',
    'Lanterns\\\n![Lamp](lamp.png)',
    '![Lamp](lamp.png)\\\nabove',
    'Start **\\\nbold**',
    '> Lanterns\\\n| x |\n| -- |\n| # Tag |',
    '* [x] \\\n  above',
  ];
  for (const input of left) {
    it(`is left to the author where two spaces cannot hold it: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), input);
      assert.ok(lintText('doc.md', input).some((finding) => finding.rule === 'hard-break-backslash'));
    });
  }

  it('is not a break in a code span, which is written on one line as Linear writes it', () => {
    assert.equal(fixText('`code\\\nspan`'), '`code\\ span`');
  });
});

describe('a backslash at the end of a block', () => {
  // It breaks no line there: a literal backslash, which Linear doubles.
  const written: Array<[string, string]> = [
    ['Ends with a backslash\\', 'Ends with a backslash\\\\'],
    ['Ends with a space and a backslash \\', 'Ends with a space and a backslash \\\\'],
    ['\\', '\\\\'],
    ['* An item \\', '* An item \\\\'],
    ['> A quote \\', '> A quote \\\\'],
    ['# A heading \\', '# A heading \\\\'],
    ['First \\\n\nSecond', 'First \\\\\n\nSecond'],
  ];
  for (const [input, expected] of written) {
    it(`is doubled: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected, 'a second fix changes nothing');
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }

  it('stays single inside a table cell, with or without the closing pipe', () => {
    assert.equal(fixText('| a \\ |\n| -- |\n'), '| a \\ |\n| -- |\n');
    assert.equal(fixText('| a | b \\\n| -- | -- |\n| c | d \\'), '| a | b \\ |\n| -- | -- |\n| c | d \\ |\n');
  });

  it('is doubled before a heading\'s closing hashes, which fix drops', () => {
    assert.equal(fixText('# Path \\ #'), '# Path \\\\');
    assert.equal(fixText('# Path \\\\'), '# Path \\\\');
  });
});

describe('Linear bold forms', () => {
  const forms = [
    ['angle autolink', '**<https://example.com/trails>**', '[**https://example.com/trails**](<https://example.com/trails>)'],
    ['bare URL', '**https://example.com/trails**', '[**https://example.com/trails**](<https://example.com/trails>)'],
    ['explicit label', '__[trail map](https://example.com/trails)__', '[**trail map**](<https://example.com/trails>)'],
    ['partly bold label', '**[trail **map**](https://example.com/trails)**', '[**trail map**](<https://example.com/trails>)'],
    ['italic label', '**[*trail map*](https://example.com/trails)**', '[***trail map***](<https://example.com/trails>)'],
    ['italic around a bold link', '***[trail map](https://example.com/trails)***', '[***trail map***](<https://example.com/trails>)'],
    ['bold around an italic link', '**_[trail map](https://example.com/trails)_**', '[***trail map***](<https://example.com/trails>)'],
    ['italic around a link with a bold label', '*[**trail map**](https://example.com/trails)*', '[***trail map***](<https://example.com/trails>)'],
    ['mixed link and prose', '**Use the [trail map](https://example.com/trails)**', '**Use the [trail map](<https://example.com/trails>)**'],
    ['ordered item link', '1. **[Guide](https://example.test)**', '1. [**Guide**](<https://example.test>)'],
    ['bullet item link with colon', '* **[Guide](https://example.test):**', '* [**Guide**](<https://example.test>)**:**'],
    ['punctuation and prose after a bold link', '**[Guide](https://example.test): Ready**', '[**Guide**](<https://example.test>)**: Ready**'],
    ['spaced prose after a bold link', '**[Guide](https://example.test) now**', '**[Guide](<https://example.test>) now**'],
    ['spaced prose after a bold italic link', '***[Guide](https://example.test) now***', '[***Guide***](<https://example.test>)*** now***'],
    ['escaped punctuation in a spaced bold italic suffix', '***[Guide](https://example.test) a\\*b***', '[***Guide***](<https://example.test>)*** a\\*b***'],
    ['italic suffix does not inherit bold from its link label', '**_guide_** and *[**Guide**](https://example.test) now*', '***guide*** and *[**Guide**](<https://example.test>) now*'],
    ['strong outside a coextensive underscore italic link', '**_[Guide](https://example.test) now_**', '[***Guide***](<https://example.test>)*** now***'],
    ['italic underscore inside bold', '**_guide_**', '***guide***'],
    ['bold inside italic underscore', '_**guide**_', '***guide***'],
    ['bold underscore inside italic', '*__guide__*', '***guide***'],
    ['italic inside bold underscore', '__*guide*__', '***guide***'],
    ['coextensive nested bold and italic', '**_**guide**_**', '***guide***'],
    ['ordinary closing punctuation stays bold', '**(tip)** and **Tip.**', '**(tip)** and **Tip.**'],
    ['three nominally adjacent bold runs', '**a****b****c**', '**ab**c'],
    ['four nominally adjacent bold runs', '**a****b****c****d**', '**ab**c\\*\\*\\*\\*d'],
    ['five nominally adjacent bold runs', '**a****b****c****d****e**', '**ab**c**d**e'],
    ['spaces next to four-star boundaries', '**Note: ****important**** text**', '**Note: important** text'],
    ['adjacent stars that would expose a URL', '**https:****//example.test****end**', '**https:****//example.test****end**'],
    ['adjacent stars that would expose strikethrough', '**a~~****b~~****c**', '**a\\~\\~b\\~\\~c**'],
    ['file label in a list item', '* **[Trail map](trail.pdf)**', '* [**Trail map**](<trail.pdf>)'],
    ['soft breaks', '**Birch\nCedar\nMaple**', '**Birch**\n**Cedar**\n**Maple**'],
    ['hard break', '**Birch  \nCedar**', '**Birch**  \n**Cedar**'],
    ['backslash hard break', '**Birch\\\nCedar**', '**Birch**\n**Cedar**'],
    ['continuation spaces', '**Birch \n  Cedar**', '**Birch** \n  **Cedar**'],
    ['quote and list', '> * **Birch\n>   Cedar**', '> * **Birch**\n>   **Cedar**'],
    ['bold and italic', '***Birch\nCedar***', '***Birch***\n***Cedar***'],
    ['bold inside strikethrough', '~~**Birch\nCedar**~~', '~~**Birch**~~\n~~**Cedar**~~'],
    ['a continuation beginning with NBSP', '**Elm\n\u00a0Ash**', '**Elm**\n\u00a0**Ash**'],
    ['multiline link label', '**[Trail\nmap](https://example.com/trails)**', '[**Trail**](<https://example.com/trails>)\n[**map**](<https://example.com/trails>)'],
    ['link takes up one line', '**Birch\n[Trail map](https://example.com/trails)**', '**Birch**\n[**Trail map**](<https://example.com/trails>)'],
  ] as const;
  for (const [name, input, expected] of forms) {
    it(name, () => {
      const fixed = fixText(input);
      assert.equal(fixed, expected);
      assert.equal(fixText(fixed), fixed);
      assert.deepEqual(lintText('trails.md', fixed), []);
    });
  }

  it('can normalize older read-back forms during sync', () => {
    const content = '**[Trail map](<https://example.com/trails>)**\n\n**Birch\nCedar**\n\n**Use the **[trail map](https://example.com/trails)** today**';
    const expected = '[**Trail map**](<https://example.com/trails>)\n\n**Birch**\n**Cedar**\n\n**Use the [trail map](<https://example.com/trails>) today**';
    assert.equal(fixLinearText(content, content, () => false), expected);
  });

  it('keeps a multiline link when duplicating its destination would exceed the content limit', () => {
    const label = 'Trail\n'.repeat(99) + 'map';
    const url = 'https://example.com/' + 'a'.repeat(6000);
    const fixed = fixText('**Birch\nCedar**\n\n**[' + label + '](' + url + ')**');
    assert.equal(fixed, '**Birch**\n**Cedar**\n\n**[' + label + '](<' + url + '>)**');
    assert.equal(fixText(fixed), fixed);
    assert.deepEqual(lintText('trails.md', fixed), []);
  });
});

describe('an empty first nested item after its parent’s text', () => {
  for (const input of ['- Parent\n\n  -\n  - Next\n', '1. Parent\n\n   1.\n   2. Next\n']) {
    it(`stays a list item with its following sibling, and a second run changes nothing: ${JSON.stringify(input)}`, () => {
      const once = fixText(input);
      assert.equal(fixText(once), once, 'the result is a fixed point');
      const [list] = parse(once).children;
      assert.equal(list?.type, 'list');
      const [parent] = (list as List).children;
      assert.deepEqual(parent!.children.map((child) => child.type), ['paragraph', 'list']);
      const nested = (parent!.children[1] as List).children;
      assert.equal(nested.length, 2);
      assert.deepEqual(nested[0]!.children, []);
      assert.equal(nested[1]!.children[0]?.type, 'paragraph');
    });
  }
});

describe('list boundaries as Linear writes them', () => {
  const written: Array<[string, string, string]> = [
    // In an item, a list of another kind follows the list before it on the next line.
    ['a bullet list after a numbered one in an item', '* Plan\n  1. one\n\n  * two', '* Plan\n  1. one\n  * two'],
    ['a numbered list after a bullet one in an item', '1. Plan\n   * one\n\n   1. two', '1. Plan\n   * one\n   1. two'],
    ['a task list after a numbered one in an item', '* Plan\n  1. one\n\n  - [ ] two', '* Plan\n  1. one\n  - [ ] two'],
    ['a numbered list after a task one in an item', '* Plan\n  - [x] one\n\n  1. two', '* Plan\n  - [X] one\n  1. two'],
    ['a task list after a bullet one in an item', '* Plan\n  * one\n\n  - [ ] two', '* Plan\n  * one\n  - [ ] two'],
    ['lists of other kinds in a deeper item and in a quote', '* Plan\n  * Step\n    1. one\n\n    * two\n\n> * Plan\n>   * one\n>\n>   1. two', '* Plan\n  * Step\n    1. one\n    * two\n\n> * Plan\n>   * one\n>   1. two'],
    ['a list after one whose item has more text', '* Plan\n  * one\n    more\n\n  1. two', '* Plan\n  * one\n    more\n  1. two'],
    // Each of these would join the line before it: the blank line stays.
    ['a numbered list from 3 after a bullet one keeps its blank line', '* Plan\n  * one\n\n  3. two', '* Plan\n  * one\n\n  3. two'],
    ['a list opening with an empty item keeps its blank line', '* Plan\n  1. one\n\n  *\n  * two', '* Plan\n  1. one\n\n  * \n  * two'],
    ['a list opening with a file block keeps its blank line', '* Plan\n  1. one\n\n  * [Report](report.csv)', '* Plan\n  1. one\n\n  * \n    [Report](report.csv)'],
    ['a list opening with a nested list keeps its blank line', '* Plan\n  1. one\n\n  * * two', '* Plan\n  1. one\n\n  * \n    * two'],
    // Outside an item, lists of other kinds stay a blank line apart.
    ['top-level lists of other kinds stay a blank line apart', '1. one\n* two\n\n- [ ] three', '1. one\n\n* two\n\n- [ ] three'],
    // Two blank lines after an empty item start a new list in Linear.
    ['two blank lines after an empty item', '1. one\n2.\n\n\n\n3. three', '1. one\n2. \n\n\n3. three'],
    ['two blank lines after an empty bullet, nested and in a quote', '* one\n*\n\n\n* three\n\nText.\n\n* Plan\n  1. one\n  2.\n\n\n  3. three\n\n> 1. one\n> 2.\n>\n>\n> 3. three', '* one\n* \n\n\n* three\n\nText.\n\n* Plan\n  1. one\n  2. \n\n\n  3. three\n\n> 1. one\n> 2. \n>\n>\n> 3. three'],
    ['two blank lines after an empty first item', '1.\n\n\n2. two', '1. \n\n\n2. two'],
    // Each part aligns its numbers on its own, as Linear's separate lists do.
    ['each part of a split list aligns on its own', '9.\n\n\n10. ten\n\nText.\n\n8. eight\n9.\n\n\n10. ten\n11. eleven', '9. \n\n\n10. ten\n\nText.\n\n8. eight\n9. \n\n\n10. ten\n11. eleven'],
    ['one blank line after an empty item goes', '1. one\n2.\n\n3. three', '1. one\n2. \n3. three'],
    ['two blank lines after an item with text go', '* one\n\n\n* two', '* one\n* two'],
    // A list that starts an item goes on the next line.
    ['an item whose text is only a number and a dot', '1. 2.\n\n* 3.\n* next', '1. \n   2. \n\n* \n  3. \n* next'],
    ['an item that starts with a list', '* * one\n  * two\n\n  more\n\nText.\n\n1. 3. three\n\nText.\n\n1. - [ ] four', '* \n  * one\n  * two\n\n  more\n\nText.\n\n1. \n   3. three\n\nText.\n\n1. \n   - [ ] four'],
    ['a list that starts an item stays below its marker line', '* \n  * one\n\n1. \n   12. ', '* \n  * one\n\n1. \n   12. '],
    ['a list in the first item of a nested list after text', '* Plan\n  * * one', '* Plan\n\n  * \n    * one'],
  ];
  for (const [name, input, expected] of written) {
    it(name, () => {
      const fixed = fixText(input);
      assert.equal(fixed, expected);
      assert.equal(fixText(fixed), fixed, 'the result is a fixed point');
      assert.deepEqual(lintText('a.md', fixed), [], 'lint finds nothing');
      assert.deepEqual(readTree(fixed), readTree(input), 'Markdown reads the same document');
    });
  }
  it('a list opening with a section keeps its blank line', () => {
    // The section is written in Linear's form below an empty marker line, which must not follow the list's text.
    const fixed = fixText('* Plan\n  1. one\n\n  * +++ \n\n    words\n\n    +++');
    assert.equal(fixed, '* Plan\n  1. one\n\n  * \n\n    +++ \n\n    words\n\n    +++');
    assert.equal(fixText(fixed), fixed, 'the result is a fixed point');
  });
});

describe('text split off at an image', () => {
  // Each part becomes a paragraph of its own; the fixture bank holds the
  // escapes Linear writes. Linear writes `<`, `2)`, a `|` row and `$$`
  // there without an escape, which Markdown would read as a block.
  const split: Array<[string, string, string]> = [
    ['a hash becomes \\#', 'Before ![a](x.png) # x', 'Before\n\n![a](x.png)\n\n\\# x'],
    ['an escaped hash keeps its escape', 'Before ![a](x.png) \\# x', 'Before\n\n![a](x.png)\n\n\\# x'],
    ['a quote marker', 'Before ![a](x.png) > x', 'Before\n\n![a](x.png)\n\n\\> x'],
    ['a rule of stars', 'Before ![a](x.png) ***', 'Before\n\n![a](x.png)\n\n\\*\\*\\*'],
    ['a plus bullet', 'Before ![a](x.png) + x', 'Before\n\n![a](x.png)\n\n\\+ x'],
    ['a numbered item keeps its number', 'Before ![a](x.png) 1. x', 'Before\n\n![a](x.png)\n\n1\\. x'],
    ['a parenthesis item keeps its number', 'Before ![a](x.png) 2) x', 'Before\n\n![a](x.png)\n\n2\\) x'],
    ['an HTML block start', 'Before ![a](x.png) <div> x', 'Before\n\n![a](x.png)\n\n\\<div> x'],
    ['a fence of four backticks', 'Before ![a](x.png) ````', 'Before\n\n![a](x.png)\n\n\\`\\`\\`\\`'],
    ['a table header and delimiter row', 'Before ![a](x.png) | a |\n| - |\n| 1 |', 'Before\n\n![a](x.png)\n\n| a |\n\\| - |\n| 1 |'],
    ['a table after text, its delimiter row ending in the image', 'Before\n| a |\n| - | ![a](x.png)', 'Before\n| a |\n\\| - |\n\n![a](x.png)'],
    ['$$ math lines', 'Before ![a](x.png) $$\nx\n$$', 'Before\n\n![a](x.png)\n\n\\$$\nx\n$$'],
    ['a setext underline before the image', 'Title\n=== ![a](x.png)', 'Title\n\\===\n\n![a](x.png)'],
    ['an escaped quote that is then a heading', 'Before ![a](x.png) > # x', 'Before\n\n![a](x.png)\n\n\\> # x'],
    ['a definition before the image', '[ref]: /dest ![a](x.png)', '\\[ref\\]: /dest\n\n![a](x.png)'],
    ['a rule before the image', '*** ![a](x.png)', '\\*\\*\\*\n\n![a](x.png)'],
    ['an underline after a task checkbox', '- [ ] # Before\n  === ![a](x.png)', '- [ ] # Before\n  \\===\n\n  ![a](x.png)'],
    ['a task checkbox keeps the hash after it as text', '- [ ] # x ![a](x.png) y', '- [ ] # x\n\n  ![a](x.png)\n\n  y'],
    ['a Linear collapsible section', 'Before ![a](x.png) +++ Details\nBody\n+++', 'Before\n\n![a](x.png)\n\n\\+++ Details\nBody\n\\+++'],
    ['a Git conflict marker', 'Before ![a](x.png) <<<<<<< ours', 'Before\n\n![a](x.png)\n\n\\<<<<<<< ours'],
    ['in a quote', '> Before ![a](x.png) # x', '> Before\n>\n> ![a](x.png)\n>\n> \\# x'],
    ['in a list item', '* Before ![a](x.png) > x', '* Before\n\n  ![a](x.png)\n\n  \\> x'],
  ];
  // The text and images in order. Inline HTML counts as its text: Linear stores `<div>` in a paragraph as text.
  const texts = (markdown: string): string => {
    const out: string[] = [];
    visit(parse(markdown), (node) => {
      if (node.type === 'text' || node.type === 'html') out.push(node.value.trim());
      else if (node.type === 'image') out.push(`image ${node.url}`);
    });
    return out.filter((entry) => entry !== '').join(' ');
  };
  for (const [name, input, expected] of split) {
    it(`stays a paragraph: ${name}`, () => {
      const once = fixText(input);
      assert.equal(once, expected);
      assert.equal(fixText(once), once, 'a second fix changes nothing');
      assert.equal(texts(once), texts(input), 'the same text and image');
      const blocks: string[] = [];
      visit(parse(once), (node) => {
        if (['heading', 'thematicBreak', 'code', 'html', 'table', 'definition'].includes(node.type)) blocks.push(node.type);
      });
      assert.deepEqual(blocks, [], 'no block but paragraphs');
    });
  }

  it('writes a code span that would open a fence on one line, without a backslash', () => {
    // Escaping its backticks would end the span; on one line it opens no fence.
    const once = fixText('Before ![a](x.png) ```js\nfoo``` y');
    assert.equal(once, 'Before\n\n![a](x.png)\n\n```js foo``` y');
    assert.equal(fixText(once), once, 'a second fix changes nothing');
  });
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

  it('text from Linear keeps a relative link or image Linear holds as one: its file was not uploaded', () => {
    const content = '* [Report](report.pdf)\n* ![Chart](chart.png)\n* \n  [Spec](https://uploads.linear.app/a/b/spec.pdf)';
    // The sync writes the upload as a file beside the document, and a repair turns the image into a link.
    const text = '* [Report](report.pdf)\n* [Chart](chart.png)\n* \n  [Spec](assets/spec.pdf)';
    assert.equal(fixLinearText(text, content, () => false), '* [Report](<report.pdf>)\n* [Chart](<chart.png>)\n* \n  [Spec](assets/spec.pdf)');
  });

  it('text from Linear writes a link Linear holds to a file of the repository in the hook\'s form', () => {
    const content = '* [Report](<report.pdf>)\n* [Missing](<missing.pdf>)';
    const inRepository = linkedFileCheck('docs/plan.md', (path) => path === 'docs/report.pdf');
    // The hook finds `report.pdf` in the repository and writes a file block; Linear stores that block as its link again.
    assert.equal(fixLinearText(content, content, inRepository), '* \n  [Report](report.pdf)\n* [Missing](<missing.pdf>)');
    assert.equal(fixText(fixLinearText(content, content, inRepository), { linkedFileExists: inRepository }), '* \n  [Report](report.pdf)\n* [Missing](<missing.pdf>)');
    // A rewrite that would change the document still leaves the text as it is.
    const setext = 'Two\nlines\n---\n\n* [Report](<report.pdf>)';
    assert.equal(fixLinearText(setext, setext, inRepository), setext);
    // The hook also keeps the link on the marker line right after the parent's text.
    const nested = '* Parent\n  * [Report](<report.pdf>)';
    assert.equal(fixLinearText(nested, nested, inRepository), nested);
  });

  it("text from Linear writes a nested file block right after the parent's text on the item's line", () => {
    // Linear writes the uploaded file below the empty marker, which Markdown would read as the parent's text.
    const cases: Array<[string, string]> = [
      ['* Parent\n  * \n    [Report](report.csv)', '* Parent\n  * [Report](<report.csv>)'],
      ['* Parent\n  1. \n     [Report](report.csv)', '* Parent\n  1. [Report](<report.csv>)'],
      ['* Parent\n  * \n    [Report](report.csv)\n  * Next', '* Parent\n  * [Report](<report.csv>)\n  * Next'],
      ['---\ntitle: Plan\n---\n\n* Parent\n  * \n    [Report](report.csv)', '---\ntitle: Plan\n---\n\n* Parent\n  * [Report](<report.csv>)'],
      // The first block goes on its item's line; the second is an item of that list and stays a block.
      ['* Parent\n  * \n    [Report](report.csv)\n  * \n    [Data](report.csv)', '* Parent\n  * [Report](<report.csv>)\n  * \n    [Data](report.csv)'],
      ['> * Parent\n>   * \n>     [Report](report.csv)', '> * Parent\n>   * [Report](<report.csv>)'],
      ['Notes\r\n\r\n * Parent\r\n   * \r\n     [Report](report.csv)', 'Notes\n\n* Parent\n  * [Report](<report.csv>)'],
    ];
    for (const [linear, expected] of cases) {
      const content = splitFile(linear).body.replaceAll('](report.csv)', '](https://uploads.example/report.csv)');
      const captured = fixLinearText(linear, content, () => true);
      assert.equal(captured, expected, JSON.stringify(linear));
      assert.equal(fixText(captured), captured, 'fix leaves the captured text');
    }
    // Literal text inside a code span stays as it is.
    const code = '* Parent `x\n  *\n    [Report](report.csv) y`';
    assert.equal(fixLinearText(code, code, () => true), code);
    // A file block Markdown already reads as an item keeps Linear's form.
    const loose = '* Parent\n\n  * \n    [Report](report.csv)';
    assert.equal(fixLinearText(loose, loose.replace('](report.csv)', '](https://uploads.example/report.csv)'), () => true), loose);
  });

  it('a file block whose link is still relative is sent as Linear stores it, everything else as written', () => {
    const body = '# Plan\n\n* \n  [Report](report.pdf)\n\n1. \n   [Data](data.csv)\n\n> * \n>   [Quoted](q.csv)\n\n'
      + '* \n  [Spec](https://uploads.linear.app/a/spec.pdf)\n* \n  [Guide](guide.md)\n\n- [ ] \n      [Task](task.csv)';
    assert.equal(relativeFileBlocksAsLinks(body), '# Plan\n\n* [Report](report.pdf)\n\n1. [Data](data.csv)\n\n> * [Quoted](q.csv)\n\n'
      + '* \n  [Spec](https://uploads.linear.app/a/spec.pdf)\n* \n  [Guide](guide.md)\n\n- [ ] \n      [Task](task.csv)');
    assert.equal(relativeFileBlocksAsLinks('* [Report](<report.pdf>)'), '* [Report](<report.pdf>)');
  });

  it('text from Linear is only re-spelled: a rewrite that would change the document leaves the text as it is', () => {
    // A table at the end of Linear's export includes a final newline, and so does fix.
    const padded = '| Step | State |\n| -- | -- |\n| Draft  | tbd |\n';
    assert.equal(fixLinearText(padded, padded, () => false), '| Step | State |\n| -- | -- |\n| Draft | tbd |\n');
    // Blank lines before a top-level closing fence are Linear's spelling: the file takes fix's form, and the sync sees no change.
    const fenced = 'Run:\n\n```sh\nmake\n\n\n```';
    assert.equal(fixLinearText(fenced, fenced, () => false), 'Run:\n\n```sh\nmake\n```');
    assert.equal(sameAsLinear(fenced, 'Run:\n\n```sh\nmake\n```'), true);
    assert.equal(sameAsLinear(fenced, 'Run:\n\n```sh\nmake now\n```'), false, 'a real code difference is still one');
    // In a quote they are content.
    assert.equal(sameAsLinear('> ```\n> make\n> \n> ```', '> ```\n> make\n> ```'), false);
    // `fix` writes a setext heading on one line, joining its lines with a space: another text.
    const setext = 'Two\nlines\n---\n\nText.';
    assert.notEqual(fixText(setext), setext);
    assert.equal(fixLinearText(setext, setext, () => false), setext);
  });
});

describe('a body that opens with a rule pair', () => {
  it('keeps its opening rule from reading as front matter', () => {
    // Fix writes every rule `---`; the opening one stays `***`, or the pair would become the file's front matter.
    assert.equal(fixText('***\n\nIntro.\n\n---\n\nText.'), '***\n\nIntro.\n\n---\n\nText.');
    // Under front matter of its own the body's rules are plain `---`.
    const fenced = '---\nowner: ops\n---\n\n---\n\nIntro.\n\n---\n\nText.';
    assert.equal(fixText(fenced.replace('\n\n---\n\nIntro', '\n\n***\n\nIntro')), fenced);
    assert.equal(fixText('***\n\nText.'), '---\n\nText.');
  });
});

describe('what fix leaves alone', () => {
  it('links bare domains Linear recognizes and keeps the other text', () => {
    const cases = [
      ['See example.com in the guide.', 'See [example.com](<http://example.com>) in the guide.'],
      ['(EXAMPLE.ORG), example.net', '([EXAMPLE.ORG](<http://EXAMPLE.ORG>)), [example.net](<http://example.net>)'],
      ['[example.com] and #example.org', '\\[[example.com](<http://example.com>)\\] and #[example.org](<http://example.org>)'],
      ['> example.com\n> archive.example.co.uk/page', '> [example.com](<http://example.com>)\n> [archive.example.co.uk/page](<http://archive.example.co.uk/page>)'],
      ['example.com:8080/path(foo)?view=list#parts.', '[example.com:8080/path(foo)?view=list#parts](<http://example.com:8080/path(foo)?view=list#parts>).'],
      ['example.com/one(two(three)four)five', '[example.com/one(two(three)four](<http://example.com/one(two(three)four>))five'],
      ['example.com/a)example.net', '[example.com/a](<http://example.com/a>))[example.net](<http://example.net>)'],
      ['example.com/guide?.', '[example.com/guide?](<http://example.com/guide?>).'],
      ['example.com/a%20b and example.com/a%zz', '[example.com/a%20b](<http://example.com/a%20b>) and [example.com/a%zz](<http://example.com/a%25zz>)'],
      ['example.com/guide[public]/café', '[example.com/guide\\[public\\]/café](<http://example.com/guide%5Bpublic%5D/caf%C3%A9>)'],
      ['café.com and example.中国', '[café.com](<http://xn--caf-dma.com>) and [example.中国](<http://example.xn--fiqs8s>)'],
      ['EXAMplé.COM and Café.com', '[EXAMplé.COM](<http://xn--EXAMpl-gva.COM>) and [Café.com](<http://xn--Cafe-yvc.com>)'],
      ['Café.com', '[Café.com](<http://xn--Cafe-yvc.com>)'],
      ['catalog.测试 and catalog.xn--0zwm56d', 'catalog.测试 and [catalog.xn--0zwm56d](<http://catalog.xn--0zwm56d>)'],
      ['archive.md and archive.md/page', 'archive.md and [archive.md/page](<http://archive.md/page>)'],
      ['example.com&copy; and example.com/a\\b', '[example.com](<http://example.com>)© and [example.com/a](<http://example.com/a>)\\\\b'],
      ['!example.com, `example.org` and [example.net](https://example.com)', '\\![example.com](<http://example.com>), `example.org` and [example.net](<https://example.com>)'],
      ['example\\.com beside example.com', 'example\\.com beside [example.com](<http://example.com>)'],
      ['exam&#112;le.com beside example.com', 'exam&#112;le.com beside [example.com](<http://example.com>)'],
      ['&#91;www.example.com_', '\\[www.example.com_'],
      ['See www.example.invalid/guide] here.', 'See www.example.invalid/guide\\] here.'],
      ['> Notice\n> www.example.invalid/guide] here.', '> Notice\n> www.example.invalid/guide\\] here.'],
      ['www.example.test/foo,example.com', 'www.example.test/foo,[example.com](<http://example.com>)'],
      ['www.person@example.com', '[www.person@example.com](<mailto:www.person@example.com>)'],
      ['example.com/?contact=team@example.net', '[example.com/?contact=team@example.net](<http://example.com/?contact=team@example.net>)'],
      ['example.com/path?next=https://example.net/', '[example.com/path?next=](<http://example.com/path?next=>)[https://example.net/](<https://example.net/>)'],
      ['url=example.com and foo+example.org', '[url=example.com](<http://url=example.com>) and [foo+example.org](<http://foo+example.org>)'],
      ['example.com/?x=1&notanentity;=2', '[example.com/?x=1&notanentity;=2](<http://example.com/?x=1&notanentity;=2>)'],
    ] as const;
    for (const [input, expected] of cases) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.ok(sameMarkdown(input, expected), input);
      assert.deepEqual(lintText('inventory.md', expected), [], input);
    }

    const text = 'example.test, www.example.test, example.invalid, x.example.com.md, www.archive.md, config.json, ./example.com, /example.org, src/example.net, example.com:00080, example.net:65536 and -x.example.org.';
    assert.equal(fixText(text), text);
  });

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

  it('keeps a literal > or # at the start of a continuation line, with the escape Linear writes before #', () => {
    assert.equal(fixText('a\n    > b'), 'a\n    > b');
    assert.equal(fixText('a\n    # b'), 'a\n    \\# b');
  });

  it('keeps a lazy line of dashes or equals signs as text, not a heading underline: escaped as Linear writes it', () => {
    const lazy: Array<[string, string]> = [
      ['- item\n--', '* item\n  \\--'],
      ['- item\n=', '* item\n  \\='],
      ['1. item\n==', '1. item\n   \\=='],
      ['- [ ] task\n--', '- [ ] task\n  \\--'],
      ['- a\n  - b\n--', '* a\n  * b\n    \\--'],
      ['> quote\n--', '> quote\n> \\--'],
      ['> quote\n\t==', '> quote\n> \\=='],
      ['100. item\n\t--', '100. item\n     \\--'],
      ['> - item\n  --', '> * item\n>   \\--'],
      // In a link label Linear's form is not recorded: four spaces of padding keep the line text.
      ['> [link\n--\n](https://example.com)', '> [link\n>     --\n> ](<https://example.com>)'],
      // A file block writes its label's later lines without the item's indent.
      ['- [Report\n--\nsummary](report.pdf)', '* \n  [Report\n      --\nsummary](report.pdf)'],
      ['> - [Report\n--\nsummary](report.pdf)', '> * \n>   [Report\n>       --\n> summary](report.pdf)'],
    ];
    for (const [text, expected] of lazy) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      // `sameMarkdown` keeps a file block's empty marker line apart, so compare what Markdown reads.
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), lintText('a.md', text), `lint finds nothing new: ${text}`);
    }
  });

  it('keeps an item\'s continuation line in the item from its content column', () => {
    // An item's content starts past its own indentation and its marker, and a
    // task item's at its checkbox. A line indented that far is not lazy: its
    // indentation past the item's prefix is its own.
    const continued: Array<[string, string]> = [
      ['- [ ] Pack the tent\n  3. pegs', '- [ ] Pack the tent\n  3\\. pegs'],
      ['- [ ] Pack the tent\n    3. pegs', '- [ ] Pack the tent\n    3\\. pegs'],
      ['- [ ] Pack the tent\n      3. pegs', '- [ ] Pack the tent\n      3\\. pegs'],
      ['* [x] Pack the tent\n  3. pegs', '- [X] Pack the tent\n  3\\. pegs'],
      ['-   [ ] Pack the tent\n    3. pegs', '- [ ] Pack the tent\n  3\\. pegs'],
      ['-\n  [ ] Pack the tent\n  3. pegs', '- [ ] Pack the tent\n  3\\. pegs'],
      ['> - [ ] Pack the tent\n>   3. pegs', '> - [ ] Pack the tent\n>   3\\. pegs'],
      ['- [ ] Pack\n  - [ ] the tent\n    3. pegs', '- [ ] Pack\n  - [ ] the tent\n    3\\. pegs'],
      ['- [ ] Pack the tent\n\n  and\n  3. pegs', '- [ ] Pack the tent\n\n  and\n  3\\. pegs'],
      // Four columns past the content, `>` and `#` are paragraph text: they keep that distance.
      ['- [ ] Pack the tent\n      > pegs', '- [ ] Pack the tent\n      > pegs'],
      ['- [ ] Pack the tent\n      # pegs', '- [ ] Pack the tent\n      \\# pegs'],
      ['-\t[ ] Pack the tent\n        > pegs', '- [ ] Pack the tent\n      > pegs'],
      ['-\t[ ] Pack\n  \t-\t[ ] the tent\n            > pegs', '- [ ] Pack\n  - [ ] the tent\n        > pegs'],
      // In a code span, spaces past the item's prefix are code text, kept
      // when the line joins the one before; the prefix counts the spaces
      // before the marker.
      ['  - [ ] Pack `the\n      tent`', '- [ ] Pack `the   tent`'],
      ['  - Pack `the\n    tent`', '* Pack `the tent`'],
      ['  - Pack `the\n   tent`', '* Pack `the    tent`'],
      ['> - [ ] Pack `the\n>     tent`', '> - [ ] Pack `the   tent`'],
      // A parent's prefix is measured on the item's own line, not on the parent's first line.
      ['> Pack\n>\n  > - `the\n  >   tent`', '> Pack\n>\n> * `the tent`'],
      ['- Pack\n\n    - [ ] `the\n      tent`', '* Pack\n  - [ ] `the tent`'],
    ];
    for (const [text, expected] of continued) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), lintText('a.md', text), `lint finds nothing new: ${text}`);
    }
  });

  it('writes empty items and aligned numbers that lint finds nothing in', () => {
    for (const text of ['* a\n*\n\n1. b\n2.', '9.\n10. a\n    * b', '* a\n\n  9. b\n  10. c', '> 99. a\n> 100.']) {
      const fixed = fixText(text);
      assert.notEqual(fixed, text, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${text}`);
    }
  });

  it('leaves the numbers unaligned where the padding would change what Markdown reads', () => {
    const items = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, index) => `${from + index}. x`).join('\n');
    // Two spaces put the first items into the bullet list written before; one does not.
    const afterBullet = `* Intro\n\n${items(1, 100)}`;
    assert.equal(fixText(afterBullet), afterBullet);
    assert.equal(fixText(`* Intro\n\n${items(1, 10)}`), `* Intro\n\n${items(1, 10).replace(/^(\d\.)/gm, ' $1')}`);
    // Four spaces would open indented code.
    const long = items(1, 10000);
    assert.equal(fixText(long), long);
    // A list that starts an item goes below its marker line and aligns there.
    for (const [text, fixed] of [['* 9. a\n  10. b', '* \n   9. a\n  10. b'], ['1. 9. a\n   10. b', '1. \n    9. a\n   10. b']] as const) {
      assert.equal(fixText(text), fixed, text);
      assert.deepEqual(readTree(fixed), readTree(text), text);
    }
    for (const text of [afterBullet, `* Intro\n\n${items(1, 10)}`, `> - [ ] a\n\n${items(8, 10)}`]) {
      assert.deepEqual(readMarkdown(fixText(text)), readMarkdown(text), `same document: ${text.slice(0, 20)}`);
    }
  });

  it('keeps a continuation line\'s own indentation past its container, as Linear does', () => {
    // An item takes up to its content indent in columns; a tab it takes in
    // part leaves its other columns as spaces. A quote takes `> `, and a
    // lazy line keeps its indentation for the quote.
    const continued: Array<[string, string]> = [
      ['Fern\n  two spaces\n\ta tab\n    four spaces', 'Fern\n  two spaces\n\ta tab\n    four spaces'],
      ['> Fern\n>   two spaces', '> Fern\n>   two spaces'],
      ['> Fern\n  lazy two\n\tlazy tab', '> Fern\n>   lazy two\n> \tlazy tab'],
      ['- fern\nlazy', '* fern\n  lazy'],
      ['- fern\n  at the content', '* fern\n  at the content'],
      ['- fern\n    two past it', '* fern\n    two past it'],
      ['- fern\n\ta tab', '* fern\n    a tab'],
      ['- fern\n  \ta tab past the prefix', '* fern\n  \ta tab past the prefix'],
      ['1. fern\n  lazy two', '1. fern\n   lazy two'],
      ['1. fern\n     two past it', '1. fern\n     two past it'],
      ['1. fern\n\ta tab', '1. fern\n    a tab'],
      ['- a\n  - b\n      two past b\n  lazy for b', '* a\n  * b\n      two past b\n    lazy for b'],
      ['> - fern\n  lazy two\n\n> - moss\nlazy', '> * fern\n>   lazy two\n\n> * moss\n>   lazy'],
      ['9. a\n10. fern\n    at the content\nlazy', ' 9. a\n10. fern\n    at the content\n    lazy'],
    ];
    for (const [text, expected] of continued) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${text}`);
    }
  });

  it('writes a bare number or bullet on an item\'s second line as the empty item Linear reads there', () => {
    // An empty marker cannot interrupt a paragraph: it is the item's text.
    // Linear reads an empty item nested in the item and writes it at the
    // item's content with a space after it; four or more columns past the
    // content Linear reads indented code, and `fix` writes the same form.
    const cases: Array<[string, string]> = [
      ['1. Plan\n   2.', '1. Plan\n   2. '],
      ['1. Plan\n   1. Sub\n      2.', '1. Plan\n   1. Sub\n      2. '],
      ['1. Trip\n    1. Plan\n        2.', '1. Trip\n   1. Plan\n      2. '],
      ['* Trip\n    1. Plan\n        2.', '* Trip\n  1. Plan\n     2. '],
      ['1. Trip\n   1. Plan\n      1. Pack\n         2.', '1. Trip\n   1. Plan\n      1. Pack\n         2. '],
      ['1. Trip\n   1. Plan\n         2.', '1. Trip\n   1. Plan\n      2. '],
      ['1. Trip\n   * Plan\n     2.', '1. Trip\n   * Plan\n     2. '],
      ['* Trip\n  * Plan\n    *', '* Trip\n  * Plan\n    * '],
      ['1. Plan\n\t2.', '1. Plan\n   2. '],
      ['1. Trip\n   1. Plan\n\t\t2.', '1. Trip\n   1. Plan\n      2. '],
      ['- [ ] Pack\n  2.', '- [ ] Pack\n  2. '],
      ['10. Plan\n    2.', '10. Plan\n    2. '],
      ['1. Plan\n   2.\n\n   Note', '1. Plan\n   2. \n\n   Note'],
      // Past the content Linear makes the line indented code.
      ['1. Plan\n\t\t2.', '1. Plan\n   2. '],
      ['1. Plan\n        2.', '1. Plan\n   2. '],
      ['1. Plan\n\t\t\t2.', '1. Plan\n   2. '],
      ['- [ ] Pack\n      2.', '- [ ] Pack\n  2. '],
      // Linear reads text: under a quote, after other lines, before more text,
      // or with a delimiter or bullet Linear would write another way.
      ['> 1. Plan\n>    2.', '> 1. Plan\n>    2.'],
      ['1. Plan\n   Note\n   2.', '1. Plan\n   Note\n   2.'],
      ['1. Plan\n\n   Note\n   2.', '1. Plan\n\n   Note\n   2.'],
      ['1. Plan\n   2.\n   more', '1. Plan\n   2.\n   more'],
      ['* Plan\n  Note\n  *', '* Plan\n  Note\n  \\*'],
      ['1. Trip\n   1. Plan\n      3)', '1. Trip\n   1. Plan\n      3)'],
      ['1. Plan\n   +', '1. Plan\n   +'],
      // An ordered list after it would continue Linear's empty item and be renumbered; a bullet list does not.
      ['1. Plan\n   2.\n   1. x', '1. Plan\n   2.\n   1. x'],
      ['* Plan\n  *\n  * x', '* Plan\n  * \n  * x'],
    ];
    for (const [text, expected] of cases) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, JSON.stringify(text));
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${JSON.stringify(text)}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${JSON.stringify(text)}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${JSON.stringify(text)}`);
    }
  });

  it('keeps a literal asterisk before an image on an item\'s second line', () => {
    const text = '1. Plan\n   *![Diagram](d.png)';
    const fixed = fixText(text, { linkedFileExists: () => true });
    assert.equal(fixed, '1. Plan\n   \\*\n\n   ![Diagram](d.png)');
    assert.equal(fixText(fixed, { linkedFileExists: () => true }), fixed);
  });

  it('keeps the tabs of a numbered continuation line after the columns its item takes, as Linear does', () => {
    // The item's prefix takes its columns of the first tab; the others stay
    // as spaces and the later tabs stay tabs. Escaped, the number is text
    // at any column, also where the written prefix is shorter than the source's.
    const cases: Array<[string, string]> = [
      ['1. Plan\n\t\t2. step', '1. Plan\n    \t2\\. step'],
      ['1. Plan\n\t\t2\\. step', '1. Plan\n    \t2\\. step'],
      ['1. Plan\n\t\t\t2. step', '1. Plan\n    \t\t2\\. step'],
      ['1. Plan\n\t\t\t\t2. step', '1. Plan\n    \t\t\t2\\. step'],
      ['* Plan\n\t\t2. step', '* Plan\n    \t2\\. step'],
      ['1. Plan\n\t\t- step', '1. Plan\n    \t- step'],
      ['1. Trip\n   1. Plan\n\t\t\t2. step', '1. Trip\n   1. Plan\n        \t2\\. step'],
      ['-   Plan\n    \t2. step', '* Plan\n  \t2\\. step'],
      ['1. Trip\n    1. Plan\n\t\t\t2. step', '1. Trip\n   1. Plan\n       \t2\\. step'],
      // Where the written prefix ends at the source's column, tabs before other block starts stay too.
      ['* a\n  \t\t# b', '* a\n  \t\t\\# b'],
      ['* a\n\t\t> b', '* a\n    \t> b'],
      // Spaces stay as they are.
      ['1. Plan\n        2. step', '1. Plan\n        2\\. step'],
      ['1. Trip\n    1. Plan\n            2. step', '1. Trip\n   1. Plan\n           2\\. step'],
      // Before other text that could open a block, a tab under a shorter prefix still becomes spaces.
      ['-   a\n    \t- b', '* a\n      - b'],
    ];
    for (const [text, expected] of cases) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, JSON.stringify(text));
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${JSON.stringify(text)}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${JSON.stringify(text)}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${JSON.stringify(text)}`);
    }
  });

  it('keeps a continuation line text where its indentation kept it from opening a block', () => {
    const kept: Array<[string, string]> = [
      // A lazy line: the item takes none of the spaces that kept it text.
      ['> - fern\n    # x', '> * fern\n>       \\# x'],
      ['> - fern\n    - x', '> * fern\n>       - x'],
      ['10.  fern\n    # x', '10. fern\n        \\# x'],
      ['*    a\n\n     > b\n    > c', '* a\n\n  > b\n  >     > c'],
      // A tab before such text becomes the spaces it spanned in the source.
      ['> foo\n\t- bar', '> foo\n>     - bar'],
      ['-   a\n    \t- b', '* a\n      - b'],
      // A nested item indented with a tab, a tab after `>` and after a marker count in columns.
      ['* a\n\t* b\n\t\t  - x', '* a\n  * b\n        - x'],
      ['* a\n\t* b\n\t\tc', '* a\n  * b\n      c'],
      ['> - a\n>\tb', '> * a\n>   b'],
      // An item after a tab that follows `>`: the quote takes one column of the tab.
      ['>\t- a\n>\t      # b', '> * a\n>       \\# b'],
      ['>\t- a\n>\t    b', '> * a\n>     b'],
      ['> - a\n>\t-x', '> * a\n>   \\-x'],
      ['*\ta\n    b', '* a\n  b'],
      // A file block label's later lines carry no prefix for their item: their indentation goes.
      ['* [Doc\n            end](file.mp4)', '* [Doc\nend](file.mp4)'],
    ];
    for (const [text, expected] of kept) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), lintText('a.md', text), `lint finds nothing new: ${text}`);
    }
  });

  it('escapes a literal ~ or _ in text as Linear writes it', () => {
    const cases: Array<[string, string]> = [
      ['Price ~$5\n\nRange 5~10\n\nA lone ~ here', 'Price \\~$5\n\nRange 5\\~10\n\nA lone \\~ here'],
      ['~ starts\n\nEnds ~\n\nTwo ~~ here', '\\~ starts\n\nEnds \\~\n\nTwo \\~\\~ here'],
      ['# Heading ~3\n\n* item ~2\n\n| a~b |\n| -- |\n| c ~ d |', '# Heading \\~3\n\n* item \\~2\n\n| a\\~b |\n| -- |\n| c \\~ d |\n'],
      // Strikethrough and code keep their tildes.
      ['~~struck~~ and `code ~x`', '~~struck~~ and `code ~x`'],
      // Between ASCII letters or digits an underscore run stays plain.
      ['snake_case_name, 2_000, a__b and x_y', 'snake_case_name, 2_000, a__b and x_y'],
      ['_lead word\n\ntrail_ word\n\nA lone _ here', '\\_lead word\n\ntrail\\_ word\n\nA lone \\_ here'],
      ['under_score_ and _under_score', 'under_score\\_ and \\_under_score'],
      // Next to a letter outside ASCII it is escaped.
      ['word\u00e9_\u00e9 and \u00e9~', 'word\u00e9\\_\u00e9 and \u00e9\\~'],
      // An escape the rule does not need goes, as Linear writes the text; one it needs stays.
      ['a_\\_b', 'a__b'],
      // Where an escape would change what Markdown reads, the text keeps its escapes as written.
      ['cost**~$5**', 'cost**~$5**'],
      // Still when another paragraph's emphasis is rewritten.
      ['cost**~$5**\n\n_italic_', 'cost**~$5**\n\n*italic*'],
      ['mail alice@example.com_', 'mail alice@example.com_'],
      ['Already \\_escaped and \\~too, a\\_b', 'Already \\_escaped and \\~too, a_b'],
    ];
    for (const [input, expected] of cases) {
      const fixed = fixText(input);
      assert.equal(fixed, expected, JSON.stringify(input));
      assert.equal(fixText(fixed), fixed, `${JSON.stringify(input)}: a second fix changes nothing`);
      assert.ok(sameMarkdown(fixed, input), `${JSON.stringify(input)}: the document stays`);
      assert.deepEqual(lintText('a.md', fixed), [], `${JSON.stringify(input)}: lint finds nothing`);
    }
  });

  it('escapes a # that starts a continuation line four or more columns in, as Linear writes it', () => {
    const cases: Array<[string, string]> = [
      ['First\n    # four', 'First\n    \\# four'],
      ['* item\n      # four past the item', '* item\n      \\# four past the item'],
      ['> quoted\n>     # four past the marker', '> quoted\n>     \\# four past the marker'],
      // Not a heading start: no escape.
      ['First\n    #tag', 'First\n    #tag'],
    ];
    for (const [input, expected] of cases) {
      const fixed = fixText(input);
      assert.equal(fixed, expected, JSON.stringify(input));
      assert.equal(fixText(fixed), fixed, `${JSON.stringify(input)}: a second fix changes nothing`);
      assert.ok(sameMarkdown(fixed, input), `${JSON.stringify(input)}: the document stays`);
    }
  });

  it('leaves an ordered task list to its author: Linear would drop its numbers', () => {
    for (const text of ['1. [ ] alpha\n2. [x] beta', '1. one\n2. [ ] two', '* a\n\n  3. [x] b']) {
      assert.equal(fixText(text), text, text);
      assert.ok(lintText('a.md', text).some((finding) => finding.rule === 'ordered-task-list'), text);
    }
  });

  it('keeps item text that starts like a list marker as text when it writes the blank line before the list', () => {
    // A list that interrupts a paragraph cannot open a nested list on its
    // first line with a number other than 1 or an empty item: that stays
    // the item's text, and needs an escape once the list stands apart.
    const marked: Array<[string, string]> = [
      ['Note\n1. 3. plum', 'Note\n\n1. 3\\. plum'],
      ['Note\n1. 3) plum\n2. pear', 'Note\n\n1. 3\\) plum\n2. pear'],
      ['Note\n1. -', 'Note\n\n1. \\-'],
      ['Note\n1. *', 'Note\n\n1. \\*'],
      ['Note\n- 2. fig', 'Note\n\n* 2\\. fig'],
      ['> Note\n> 1. 3. plum', '> Note\n>\n> 1. 3\\. plum'],
      // Inside an item the list still follows its paragraph; Linear reads the text as a list there too.
      ['- Note\n  1. 3. plum', '* Note\n  1. 3\\. plum'],
      // After a task checkbox the text does not start its line: no escape.
      ['- [ ] 1. Draft\n- [x] - pear', '- [ ] 1. Draft\n- [X] - pear'],
    ];
    const read = (markdown: string): string[] => {
      const out: string[] = [];
      visit(parse(markdown), (node) => {
        out.push(node.type === 'text' ? node.value : node.type);
      });
      return out;
    };
    for (const [text, expected] of marked) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(read(fixed), read(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${text}`);
    }
  });

  it("takes the escaped marker when it captures Linear's text: a lone \\+ is no +++ delimiter", () => {
    // Linear writes a bare `+` item text without the escape fix writes.
    const linear = '* Note\n  1. +';
    assert.equal(fixLinearText(linear, linear, () => false), '* Note\n  1. \\+');
    assert.ok(!sameMarkdown('\\+++ Title', '+++ Title'), 'an escaped +++ delimiter stays apart');
  });

  it('keeps text split off at an image as text when it starts like a list marker', () => {
    assert.equal(fixText('Before ![a](x.png) 3. plum'), 'Before\n\n![a](x.png)\n\n3\\. plum');
    assert.equal(fixText('Before ![a](x.png) - pear'), 'Before\n\n![a](x.png)\n\n\\- pear');
    // The part before the image still follows a task checkbox: no escape there.
    assert.equal(fixText('- [ ] 1. Draft ![a](x.png) 2. more'), '- [ ] 1. Draft\n\n  ![a](x.png)\n\n  2\\. more');
  });

  it('escapes a lone -- line between blank lines, and reads one under a paragraph as Markdown does: a heading', () => {
    assert.equal(fixText('Text.\n\n--\n\nMore.'), 'Text.\n\n\\--\n\nMore.');
    assert.equal(fixText('--'), '\\--');
    assert.equal(fixText('Text\n--\n\nMore.'), '## Text\n\nMore.');
    // In a code span the line joins the one before and keeps its tab.
    assert.equal(fixText('`a\n\t--\nb`'), '`a \t-- b`');
  });

  it('escapes a literal - or * that starts a paragraph line, as Linear writes it', () => {
    const cases: Array<[string, string]> = [
      ['-x marks it', '\\-x marks it'],
      ['*x star', '\\*x star'],
      ['First\n-- second\n-x third', 'First\n\\-- second\n\\-x third'],
      ['* item\n  -- remark', '* item\n  \\-- remark'],
      ['> words\n> -x remark', '> words\n> \\-x remark'],
      // A continuation line keeps its indentation; after it Linear escapes a `*` but not a `-`.
      ['First\n  -x third', 'First\n  -x third'],
      ['First\n\t*x third', 'First\n\t\\*x third'],
      ['> a\n>   -x', '> a\n>   -x'],
      ['* item\n    -x four', '* item\n    -x four'],
      // Only the two literal stars of the run are escaped.
      ['***(important)*', '\\*\\**(important)*'],
      ['**x', '\\*\\*x'],
      // Asterisks can be escaped anywhere in text. A dash is escaped at the line start.
      ['\\-x and \\*y', '\\-x and \\*y'],
      ['a -x and *b', 'a -x and \\*b'],
      ['+x plus', '+x plus'],
      ['*x* emphasis', '*x* emphasis'],
      ['`a\n-x`', '`a -x`'],
      ['# -x heading', '# -x heading'],
    ];
    for (const [input, expected] of cases) {
      const once = fixText(input);
      assert.equal(once, expected, JSON.stringify(input));
      assert.equal(fixText(once), once, `${JSON.stringify(input)}: a second fix changes nothing`);
      assert.ok(sameMarkdown(once, input), `${JSON.stringify(input)}: the document stays`);
    }
  });

  it('matches Linear on literal asterisks and adjacent or nested bold', () => {
    const cases = [
      ['**Birch****Pine**', '**Birch\\*\\*\\*\\*Pine**'],
      ['**Birch*****Pine**', '**Birch**\\***Pine**'],
      ['**Birch***', '**Birch**\\*'],
      ['***Birch**', '\\***Birch**'],
      ['** Inventory', '\\*\\* Inventory'],
      ['Birch ** Pine', 'Birch \\*\\* Pine'],
      ['Birch &ast; &#42; &#x2A; Pine', 'Birch \\* \\* \\* Pine'],
      ['Birch\\\\*Pine', 'Birch\\\\\\*Pine'],
      ['**Birch**__Pine__', '**BirchPine**'],
      ['__Birch__**Pine**__Cedar__', '**BirchPineCedar**'],
      ['**Birch *shelves***__*Pine* racks__', '**Birch *shelvesPine* racks**'],
      ['**Birch _shelves_**__*Pine* racks__', '**Birch *shelvesPine* racks**'],
      ['__Birch **Pine**__', '**Birch Pine**'],
      ['_Birch_*pine', '*Birch*\\*pine'],
      ['_Birch_*pine*', '_Birch_*pine*'],
      ['****Birch****', '**Birch**'],
      ['**Birch** **Pine**', '**Birch** **Pine**'],
      ['***Birch***', '***Birch***'],
      ['[**Inventory](https://example.com)', '[\\*\\*Inventory](<https://example.com>)'],
      ['| Shelf |\n| -- |\n| **Birch |', '| Shelf |\n| -- |\n| \\*\\*Birch |\n'],
      ['> **Inventory', '> \\*\\*Inventory'],
      ['`**Inventory`', '`**Inventory`'],
    ] as const;
    for (const [input, expected] of cases) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.deepEqual(lintText('inventory.md', expected), [], input);
      assert.ok(sameMarkdown(input, expected), input);
    }
  });

  it('preserves links and enclosing italics while still fixing other paragraphs', () => {
    const splitUrl = '**https**__://example.com__';
    assert.ok(!sameMarkdown(splitUrl, '**https://example.com**'));
    for (const [first, formatted] of [[splitUrl, splitUrl], ['*Oak*___**Pine**___', '*Oak****Pine***']]) {
      const input = [first, 'Birch ** Pine', '**Oak**__Elm__', '[https://example.com_', '[Shelf]'].join('\n\n');
      const expected = [formatted, 'Birch \\*\\* Pine', '**OakElm**', '[https://example.com\\_', '\\[Shelf\\]'].join('\n\n');
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected);
      assert.ok(sameMarkdown(input, expected));
      assert.deepEqual(lintText('inventory.md', expected), []);
    }
  });

  it('removes redundant line escapes while keeping escapes that protect blocks', () => {
    for (const [input, expected] of [
      ['**\\-44 jars**', '**-44 jars**'],
      ['**\\=====**', '**=====**'],
      ['*\\-44 jars*', '*-44 jars*'],
      ['**\\> shelf**', '**> shelf**'],
      ['**\\+ shelf**', '**+ shelf**'],
      ['**\\* shelf**', '**\\* shelf**'],
      ['Mark :\\+1:, :\\-1:, :e\\-mail: and &\\#65;.', 'Mark :\\+1:, :\\-1:, :e\\-mail: and &\\#65;.'],
      ['Write &amp;\\#65; literally.', 'Write &\\#65; literally.'],
      ['Guide <rack data\\=blue> and <rack\\-label\\>.', 'Guide <rack data\\=blue> and <rack\\-label\\>.'],
      ['Guide <rack\ndata\\=blue>.', 'Guide <rack\ndata\\=blue>.'],
      ['Guide <rack title="*blue*"\ndata="wide"\\> ends.', 'Guide <rack title="*blue*"\ndata="wide"\\> ends.'],
      ['Plan\n\\+spare', 'Plan\n+spare'],
      ['Plan\n\\+\u00a0spare', 'Plan\n+\u00a0spare'],
      ['Plan\n\\##shelf', 'Plan\n##shelf'],
      ['Plan\n\\+ spare', 'Plan\n\\+ spare'],
      ['Plan\n\\>spare', 'Plan\n\\>spare'],
      ['Plan\n\\# spare', 'Plan\n\\# spare'],
      ['Plan\n\\+++ shelf', 'Plan\n\\+++ shelf'],
      ['\\+\\+\\+ shelf', '\\+\\+\\+ shelf'],
      ['\\#\\# Shelf', '\\#\\# Shelf'],
      ['#\\# Shelf', '#\\# Shelf'],
      ['Plan\n\\=====', 'Plan\n\\====='],
      ['Plan\n=\\==', 'Plan\n=\\=='],
      ['| A | B |\n| \\--- | --- |', '| A | B |\n| \\--- | --- |'],
    ] as const) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.ok(sameMarkdown(input, expected), input);
      assert.deepEqual(lintText('inventory.md', expected), [], input);
    }
  });

  it('removes line-start escapes of = and of indented - and + where no block can start, as Linear does', () => {
    for (const [input, expected] of [
      // A run of `=` that opens a paragraph, an item or a quote cannot underline anything.
      ['Plan\n\n\\=====', 'Plan\n\n====='],
      ['\\=== Shelves', '=== Shelves'],
      ['Plan\n\\=== and jars', 'Plan\n=== and jars'],
      ['1. \\====\n2. \\=== a step', '1. ====\n2. === a step'],
      ['* \\====', '* ===='],
      ['- [ ] \\====', '- [ ] ===='],
      ['> \\=====', '> ====='],
      // Past four columns of indentation, no list item or underline starts.
      ['Prices:\n          \\- 5 euro\n          \\+ 7 euro\n          \\= 9 euro\n          \\=====', 'Prices:\n          - 5 euro\n          + 7 euro\n          = 9 euro\n          ====='],
      ['Plan\n    \\- spare', 'Plan\n    - spare'],
      ['Plan\n\t\\+ spare', 'Plan\n\t+ spare'],
      ['* Plan\n      \\- spare\n      \\+ spare', '* Plan\n      - spare\n      + spare'],
      ['> Plan\n>     \\- spare', '> Plan\n>     - spare'],
      ['> Plan\n    \\- spare', '> Plan\n>     - spare'],
      ['* Plan\n      \\====', '* Plan\n      ===='],
      ['* Plan\n      ====', '* Plan\n      ===='],
      ['> Plan\n>     \\====', '> Plan\n>     ===='],
      ['* Plan\n      ----', '* Plan\n      ----'],
      ['Plan\n    \\---', 'Plan\n    ---'],
      // After any indentation a dash that no space follows opens nothing.
      ['Plan\n  \\-x spare', 'Plan\n  -x spare'],
      ['* Plan\n    \\-x spare', '* Plan\n    -x spare'],
      // Kept: these would underline the paragraph or start a list item.
      ['Plan\n\\=====', 'Plan\n\\====='],
      ['Plan\n   \\====', 'Plan\n   \\===='],
      ['Plan\n\\=\\=\\=', 'Plan\n\\=\\=\\='],
      ['* Plan\n  \\===', '* Plan\n  \\==='],
      ['Plan\n  \\- spare', 'Plan\n  \\- spare'],
      ['Plan\n  \\+ spare', 'Plan\n  \\+ spare'],
      ['* Plan\n    \\- spare', '* Plan\n    \\- spare'],
      ['Plan\n\\-x spare', 'Plan\n\\-x spare'],
      ['Plan\n  \\---', 'Plan\n  \\---'],
      ['* Plan\n \\- spare', '* Plan\n  \\- spare'],
      // A tab can span fewer columns under the shorter prefix fix writes.
      ['-   Plan\n    \t\\- spare', '* Plan\n  \t\\- spare'],
      ['1.  Plan\n    \t\\=====', '1. Plan\n   \t\\====='],
      ['* Plan\n\t  ====', '* Plan\n  \\===='],
    ] as const) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.ok(sameMarkdown(input, expected), input);
      assert.deepEqual(lintText('inventory.md', expected), [], input);
    }
  });

  it('writes a bare plus on a paragraph continuation without creating an item', () => {
    for (const output of ['Plan\n+', '* Plan\n  +', '> Plan\n> +']) {
      const input = output.slice(0, -1) + '\\+';
      assert.equal(fixText(input), output);
      assert.equal(fixText(output), output);
      assert.deepEqual(lintText('inventory.md', output), []);
      assert.ok(sameMarkdown(input, output));
      assert.equal(fixLinearText(input, input, () => false), output);
    }
    const withLink = 'Plan\n\\+\n  [Inventory](inventory.csv)';
    assert.ok(sameMarkdown(withLink, fixText(withLink)));
    assert.ok(!sameMarkdown('+ \n  [Inventory](inventory.csv)', '+ [Inventory](inventory.csv)'));
  });

  it('escapes dots of literal numbers at the start of a paragraph line', () => {
    for (const [input, expected] of [
      ['20.\u00a0Jars', '20\\. Jars'],
      ['1.\u00a0Jars', '1\\. Jars'],
      ['Plan\n4. Jars', 'Plan\n4\\. Jars'],
      ['Plan\n4.\tJars', 'Plan\n4\\. Jars'],
      ['Plan\n4\\.\tJars', 'Plan\n4\\. Jars'],
      ['Plan\n4\\.\u00a0Jars', 'Plan\n4\\. Jars'],
      ['Plan\n4.    Jars', 'Plan\n4\\.    Jars'],
      ['Plan\n\t2. Jars', 'Plan\n\t2\\. Jars'],
      ['Plan\n    5. Jars', 'Plan\n    5\\. Jars'],
      ['Plan\n1234567890. Jars', 'Plan\n1234567890\\. Jars'],
      ['> Plan\n> 12. Jars', '> Plan\n> 12\\. Jars'],
      ['* Plan\n  13. Jars', '* Plan\n  13\\. Jars'],
      ['Plan\n4.', 'Plan\n4.'],
      ['Plan\n7.5 Jars', 'Plan\n7.5 Jars'],
      ['## 10. Jars', '## 10. Jars'],
      ['**11. Jars**', '**11. Jars**'],
      ['Plan\n1. Jars', 'Plan\n\n1. Jars'],
    ] as const) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.deepEqual(lintText('inventory.md', expected), [], input);
    }
  });

  it('keeps captured literal numbers in hook form and skips a number alone before an image', () => {
    for (const text of ['4.\u00a0Jars', 'Plan\n4.\tJars', 'Plan\n4\\.\u00a0Jars', 'Plan  \n4.\tJars']) {
      assert.equal(fixLinearText(text, text, () => false), fixText(text), text);
    }
    assert.equal(fixText('Plan\n4. ![Rack](rack.png)'), 'Plan\n4.\n\n![Rack](rack.png)');
  });

  it('adds no escape inside inline HTML: a lazy dash line there keeps its padding', () => {
    const text = '> <span title="a\n--\nb">x</span>';
    const once = fixText(text);
    assert.equal(once, '> <span title="a\n>     --\n> b">x</span>');
    assert.equal(fixText(once), once, 'a second fix changes nothing');
  });

  it('takes Linear\'s text with a relative link it did not upload whose destination fix encodes', () => {
    const linear = '* [Report](<name|a.pdf>)';
    assert.equal(fixLinearText(linear, linear, () => false), '* [Report](<name%7Ca.pdf>)');
  });

  it('joins a lazy line of dashes or equals signs in a code span in a container to the line before it', () => {
    // Under a bare `> ` the line would underline `` `a `` as a heading and
    // split the code span; padding it would put spaces into the code. A line
    // ending in a code span reads as a space, so joining keeps the code.
    const lazy: Array<[string, string]> = [
      ['> `a\n--\n> b`', '> `a -- b`'],
      ['- `a\n--\n  b`', '* `a -- b`'],
      ['> text `a\n\t==\n> b` end', '> text `a \t== b` end'],
      ['> [`a\n--\nb`](https://example.com)', '> [`a -- b`](<https://example.com>)'],
      ['- [`a\n--\nb`](report.pdf)', '* \n  [`a -- b`](report.pdf)'],
      // The item's own indent goes, also in a file block's label; the spaces of a lazy line stay.
      ['- [`a\n      ==\n  b`](report.pdf)', '* \n  [`a     == b`](report.pdf)'],
      ['- [`a\n ==\n  b`](report.pdf)', '* \n  [`a  == b`](report.pdf)'],
      ['- `a\n --\n  b`', '* `a  -- b`'],
    ];
    for (const [text, expected] of lazy) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), lintText('a.md', text), `lint finds nothing new: ${text}`);
    }
    const [quote] = parse(fixText('> `a\n--\n> b`')).children;
    const [paragraph] = (quote as Blockquote).children;
    assert.deepEqual((paragraph as Paragraph).children.map((child) => child.type), ['inlineCode']);
  });

  it('writes an image alt text that runs over lines in a container without the container prefixes', () => {
    const images: Array<[string, string]> = [
      ['> ![a\n> b](x.png)', '> ![a\n> b](x.png)'],
      ['> ![a\nb](x.png)', '> ![a\n> b](x.png)'],
      ['> ![a\n>     b](x.png)', '> ![a\n>     b](x.png)'],
      ['- ![a\n  b](x.png)', '* ![a\n  b](x.png)'],
      ['> - ![a\n>   b](x.png)', '> * ![a\n>   b](x.png)'],
      ['> > ![a\n> b](x.png)', '> > ![a\n> > b](x.png)'],
      // A lazy dash line in the alt text stays text, as in a paragraph.
      ['- ![a\n--\n](x.png)', '* ![a\n      --\n  ](x.png)'],
      ['> ![a\n--\nb](x.png)', '> ![a\n>     --\n> b](x.png)'],
      // A code span in the alt text keeps its spaces; a lazy dash line in it joins the line before.
      ['- ![a `x\n    y` b](x.png)', '* ![a `x\n    y` b](x.png)'],
      ['> ![a `x\n--\n> y` b](x.png)', '> ![a `x --\n> y` b](x.png)'],
      ['> ![a\n> b][r]\n\n[r]: x.png', '> ![a\n> b](x.png)'],
      // A `]` in a code span does not close the alt text.
      ['![a `]` b](x.png)', '![a `]` b](x.png)'],
      ['> ![a `]`\n> b](x.png)', '> ![a `]`\n> b](x.png)'],
      ['![a ``x`]`` b](x.png)', '![a ``x`]`` b](x.png)'],
      // A backtick in an autolink or a destination opens no code span.
      ['![a <urn:a`>](x`.png)', '![a <urn:a`>](x`.png)'],
      ['![<https://a/`>](x`](y).png)', '![<https://a/`>](x`]%28y%29.png)'],
      ['![a <b title="`">](x`](y).png)', '![a <b title="`">](x`]%28y%29.png)'],
      // A line indented less than the item's content is lazy: in a code span its spaces are code.
      ['- ![a `x\n y` b](x.png)', '* ![a `x\n   y` b](x.png)'],
      ['> - ![a `x\n>  y` b](x.png)', '> * ![a `x\n>    y` b](x.png)'],
      // Indentation that keeps HTML from opening a block stays.
      ['![a\n    <div> b](x.png)', '![a\n    <div> b](x.png)'],
      ['- ![a\n      <!-- c --> d](x.png)', '* ![a\n      <!-- c --> d](x.png)'],
    ];
    for (const [text, expected] of images) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      assert.deepEqual(readMarkdown(fixed), readMarkdown(text.replace(/\]\[r\]\n\n\[r\]: x\.png$/, '](x.png)')), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), [], `lint finds nothing: ${text}`);
    }
  });

  it('keeps spaces that belong to a code span across lines when it joins them', () => {
    assert.equal(fixText('`a\n  b`'), '`a   b`');
    assert.equal(fixText('> `a\n>   b`'), '> `a   b`');
  });

  it('writes a setext heading of two lines as one ATX line', () => {
    assert.equal(fixText('Title\nmore\n====='), '# Title more');
  });

  it('drops the spaces and tabs around each line break of a setext heading and keeps the others', () => {
    assert.equal(fixText('Title \t\n\t more\n====='), '# Title more');
    assert.equal(fixText('a\t\t\n\t\tb\n---'), '## a b');
    assert.equal(fixText('a \n  b\n==='), '# a b');
    assert.equal(fixText('# a     b'), '# a     b');
    assert.equal(fixText('a \t b\nc\n==='), '# a \t b c');
  });

  // The heading's lines were joined by a regular expression that rescanned a
  // run of spaces or tabs from each of its positions: a heading holding a run
  // of the content limit took over a minute. The ATX headings are one line;
  // the setext headings span lines and hold the run inside a line or right
  // before a line break. A child process runs them, so the parent's timeout
  // stops a stall that a test timeout could not interrupt; each run is
  // measured against a parse of the same text.
  it('fixes a heading holding a run of spaces or tabs of the content limit in about the time of its parse', { timeout: 120_000 }, () => {
    const script = `
      import { CONTENT_LIMIT } from ${JSON.stringify(new URL('./rules.ts', import.meta.url).href)};
      import { fixText } from ${JSON.stringify(new URL('./fix.ts', import.meta.url).href)};
      import { parse } from ${JSON.stringify(new URL('./markdown.ts', import.meta.url).href)};
      const spaces = ' '.repeat(CONTENT_LIMIT - 10);
      const tabs = '\\t'.repeat(CONTENT_LIMIT - 10);
      const hardBreakHeading = 'a' + spaces + '\\nb\\n===';
      const cases = {
        'ATX, spaces': ['# a' + spaces + 'b', '# a' + spaces + 'b'],
        'ATX, tabs': ['# a' + tabs + 'b', '# a' + tabs + 'b'],
        'setext, run inside a line': ['a' + spaces + 'x\\nb\\n===', '# a' + spaces + 'x b'],
        'setext, run before a soft break': ['a' + tabs + '\\nb\\n===', '# a b'],
        'setext, run before a hard break': [hardBreakHeading, hardBreakHeading],
      };
      const result = {};
      for (const [name, [text, expected]] of Object.entries(cases)) {
        let start = performance.now();
        parse(text);
        const parseMs = performance.now() - start;
        start = performance.now();
        const fixed = fixText(text);
        result[name] = { parseMs, fixMs: performance.now() - start, expected: fixed === expected };
      }
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 100_000 });
    assert.equal(child.signal, null, 'fix did not finish within the parent timeout');
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as Record<string, { parseMs: number; fixMs: number; expected: boolean }>;
    assert.deepEqual(Object.keys(result), [
      'ATX, spaces', 'ATX, tabs', 'setext, run inside a line',
      'setext, run before a soft break', 'setext, run before a hard break',
    ]);
    for (const [name, { parseMs, fixMs, expected }] of Object.entries(result)) {
      assert.ok(expected, `${name}: fix produces the expected text`);
      const times = `${name}: parse ${Math.round(parseMs)} ms, fix ${Math.round(fixMs)} ms`;
      // fix lints and parses the text a few times; the join adds little beside that.
      assert.ok(fixMs < 10 * parseMs + 5_000, times);
    }
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

  it('keeps what a destination means: references stay escaped, and a backslash is percent-encoded as Linear writes it', () => {
    const once = fixText('[a](<https://example.com/?q=&amp;copy;>)');
    assert.equal(once, '[a](<https://example.com/?q=&amp;copy;>)');
    assert.equal(fixText('[a](https://example.com/?a=1&b=2)'), '[a](<https://example.com/?a=1&b=2>)');
    assert.equal(fixText('[a](<x\\\\*y>)'), '[a](<x%5C*y>)');
    assert.equal(fixText('[a](<https://example.com/a|b^c{d}>)'), '[a](<https://example.com/a%7Cb%5Ec%7Bd%7D>)');
    assert.equal(fixText('[a](<https://example.com/a%5Cb>)'), '[a](<https://example.com/a%5Cb>)');
  });

  it('writes an autolink\'s backslashes and brackets literally in its label', () => {
    const cases: Array<[string, string]> = [
      ['https://example.com/\\\nNext.', '[https://example.com/\\\\](<https://example.com/%5C>)\nNext.'],
      ['<https://example.com/\\>', '[https://example.com/\\\\](<https://example.com/%5C>)'],
      ['See https://example.com/\\* now.', 'See [https://example.com/\\\\](<https://example.com/%5C>)\\* now.'],
      ['See https://example.com/a\\b now.', 'See [https://example.com/a\\\\b](<https://example.com/a%5Cb>) now.'],
      ['<https://example.com/a]b[c>', '[https://example.com/a\\]b\\[c](<https://example.com/a]b[c>)'],
      ['a <https://example.com/a\\`> b `c`', 'a [https://example.com/a\\\\\\`](<https://example.com/a%5C`>) b `c`'],
    ];
    for (const [input, expected] of cases) {
      const once = fixText(input);
      assert.equal(once, expected, JSON.stringify(input));
      assert.equal(fixText(once), once, `${JSON.stringify(input)}: the result is a fixed point`);
      assert.ok(sameMarkdown(once, input), `${JSON.stringify(input)}: the link and its text stay`);
    }
  });

  it('writes an autolink\'s label so its text reads exactly as the URL', () => {
    const cases: Array<[string, string, string]> = [
      // Escaped underscores: the backslashes are literal, the underscores must not become emphasis.
      ['https://example.org/p?k=1\\_2\\_\\_3&z=4', '[https://example.org/p?k=1\\\\\\_2\\\\\\_\\\\\\_3&z=4](<https://example.org/p?k=1%5C_2%5C_%5C_3&z=4>)', 'https://example.org/p?k=1\\_2\\_\\_3&z=4'],
      // Plain underscores after punctuation must not become emphasis either.
      ['https://example.org/p?a=x._one_.two_three_.z', '[https://example.org/p?a=x.\\_one\\_.two_three\\_.z](<https://example.org/p?a=x._one_.two_three_.z>)', 'https://example.org/p?a=x._one_.two_three_.z'],
      // Tilde pairs must not become strikethrough (and a `subscript` finding).
      ['https://example.org/track?id=10~20~30&view=on', '[https://example.org/track?id=10\\~20\\~30&view=on](<https://example.org/track?id=10~20~30&view=on>)', 'https://example.org/track?id=10~20~30&view=on'],
      ['<https://example.org/~~a~~>', '[https://example.org/\\~\\~a\\~\\~](<https://example.org/~~a~~>)', 'https://example.org/~~a~~'],
      ['<https://example.org/a*b*/c_d_>', '[https://example.org/a\\*b\\*/c_d\\_](<https://example.org/a*b*/c_d_>)', 'https://example.org/a*b*/c_d_'],
      // A character reference or an emoji shortcode in the URL stays as written.
      ['https://example.org/x?a=1&amp;b=&#42;2', '[https://example.org/x?a=1\\&amp;b=\\&#42;2](<https://example.org/x?a=1&amp;amp;b=&amp;#42;2>)', 'https://example.org/x?a=1&amp;b=&#42;2'],
      ['https://example.org/:tada:/x', '[https://example.org/\\:tada:/x](<https://example.org/:tada:/x>)', 'https://example.org/:tada:/x'],
      // A colon can also open a shortcode after an unknown name.
      ['https://example.org/:not_emoji:tada:/x', '[https://example.org/:not_emoji\\:tada:/x](<https://example.org/:not_emoji:tada:/x>)', 'https://example.org/:not_emoji:tada:/x'],
      // Shortcodes that share a colon are each escaped.
      ['https://example.org/:fire:tada:/x', '[https://example.org/\\:fire\\:tada:/x](<https://example.org/:fire:tada:/x>)', 'https://example.org/:fire:tada:/x'],
    ];
    for (const [input, expected, text] of cases) {
      const once = fixText(input);
      assert.equal(once, expected, JSON.stringify(input));
      assert.equal(fixText(once), once, `${JSON.stringify(input)}: the result is a fixed point`);
      assert.deepEqual(lintText('a.md', once), lintText('a.md', input), `${JSON.stringify(input)}: lint finds nothing new`);
      const paragraph = parse(once).children[0] as Paragraph;
      assert.equal(paragraph.children.length, 1, `${JSON.stringify(input)}: one link`);
      const link = paragraph.children[0];
      assert.ok(link?.type === 'link', `${JSON.stringify(input)}: a link`);
      assert.deepEqual(link.children.map((child) => [child.type, 'value' in child ? child.value : undefined]), [['text', text]], `${JSON.stringify(input)}: the link text is one text node equal to the URL`);
      // A backslash in the destination is percent-encoded, as Linear writes it: the link goes where the URL goes.
      assert.equal(normalizeUri(link.url), normalizeUri(text));
    }
  });

  it("puts bare URL punctuation on Linear's side of the link boundary", () => {
    const cases = [
      ['https://example.test/p#tip_', '[https://example.test/p#tip\\_](<https://example.test/p#tip_>)'],
      ['https://example.test?_', '[https://example.test?\\_](<https://example.test?_>)'],
      ['https://example.test/p__~', '[https://example.test/p_\\_\\~](<https://example.test/p__~>)'],
      ['https://example.test/p(foo', '[https://example.test/p](<https://example.test/p>)(foo'],
      ['https://example.test/p(x~y~z', '[https://example.test/p](<https://example.test/p>)(x\\~y\\~z'],
      ['https://example.test/p(x~~y~~z', '[https://example.test/p](<https://example.test/p>)(x~~y~~z'],
      ["https://example.test/o'reilly/notes", "[https://example.test/o'reilly/notes](<https://example.test/o'reilly/notes>)"],
      ["https://example.test/p'", "[https://example.test/p](<https://example.test/p>)'"],
      ['https://example.test/p(foo)more', '[https://example.test/p(foo)more](<https://example.test/p(foo)more>)'],
      ['(https://example.test/p)', '([https://example.test/p](<https://example.test/p>))'],
      ['https://example.test/p(a(b)c)d', '[https://example.test/p(a(b)c](<https://example.test/p(a(b)c>))d'],
      ['https://example.test/p[2]', '[https://example.test/p\\[2\\]](<https://example.test/p%5B2%5D>)'],
      ['https://example.test/p?!', '[https://example.test/p?](<https://example.test/p?>)!'],
      ['https://example.test/p:', '[https://example.test/p:](<https://example.test/p:>)'],
      ['https://example.com_', 'https://example.com\\_'],
      ['**https://example.test/p_**', '[**https://example.test/p\\_**](<https://example.test/p_>)'],
      ['[Guide](<https://example.test/p(foo>)', '[Guide](<https://example.test/p(foo>)'],
      ['`https://example.test/p_`', '`https://example.test/p_`'],
    ] as const;
    for (const [input, expected] of cases) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
      assert.deepEqual(lintText('guide.md', expected), [], input);
    }
  });

  it('percent-encodes characters outside ASCII in a destination and writes the host in ASCII, as Linear does', () => {
    const cases: Array<[string, string]> = [
      ['[a](https://a.test/café)', '[a](<https://a.test/caf%C3%A9>)'],
      ['[b](<https://a.test/caf é>)', '[b](<https://a.test/caf%20%C3%A9>)'],
      ['<https://a.test/naïve>', '[https://a.test/naïve](<https://a.test/na%C3%AFve>)'],
      ['https://a.test/über', '[https://a.test/über](<https://a.test/%C3%BCber>)'],
      ['[c](https://a.test/x?q=ü#ß)', '[c](<https://a.test/x?q=%C3%BC#%C3%9F>)'],
      ['[d](https://a.test/caf%C3%A9)', '[d](<https://a.test/caf%C3%A9>)'],
      ['[e](https://a.test/日本)', '[e](<https://a.test/%E6%97%A5%E6%9C%AC>)'],
      ['[f](https://a.test/😀)', '[f](<https://a.test/%F0%9F%98%80>)'],
      ['[g](https://café.test/x)', '[g](<https://xn--caf-dma.test/x>)'],
      ['[n](café)', '[n](<caf%C3%A9>)'],
      ['[m](<docs/naïve plan>)', '[m](<docs/na%C3%AFve%20plan>)'],
      // A backslash ends the host, as it does in a browser: the path after it stays.
      ['[p](<https://café.test\\folder?q=2>)', '[p](<https://xn--caf-dma.test%5Cfolder?q=2>)'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(fixText(input), expected, input);
      assert.equal(fixText(expected), expected, input);
    }
  });

  it('writes intraword underscores plain in URL labels', () => {
    const url = 'https://example.org/blue__jars/café_menu/shelf_4';
    const escapedUrl = 'https://example.org/blue\\_\\_jars/café\\_menu/shelf\\_4';
    const inline = `[${escapedUrl}](${url})`;
    // Next to a letter outside ASCII the underscore keeps its escape in the label, and the
    // destination is percent-encoded, as Linear writes them.
    const expected = '[https://example.org/blue__jars/café\\_menu/shelf_4](<https://example.org/blue__jars/caf%C3%A9_menu/shelf_4>)';
    for (const input of [url, `<${url}>`, inline, `[${escapedUrl}][stock]\n\n[stock]: ${url}`]) {
      const fixed = fixText(input);
      assert.equal(fixed, expected, input);
      assert.equal(fixText(fixed), fixed, input);
      assert.deepEqual(lintText('stock.md', fixed), [], input);
    }
    assert.ok(sameMarkdown(expected, inline));
    // Between ASCII letters Linear writes the underscore plain in any label.
    assert.equal(fixText('[blue\\_jars](<https://example.org>)'), '[blue_jars](<https://example.org>)');
  });

  it('keeps shortcode names literal when unescaping URL underscores', () => {
    for (const prefix of ['', ':unknown']) {
      const url = `https://example.org/${prefix}:open_file_folder:/shelf_4`;
      const oldLabel = `https://example.org/${prefix}:open\\_file\\_folder:/shelf\\_4`;
      const label = `https://example.org/${prefix}\\:open_file_folder:/shelf_4`;
      const expected = `[${label}](<${url}>)`;
      for (const input of [`<${url}>`, `[${oldLabel}](<${url}>)`, expected]) {
        assert.equal(fixText(input), expected, input);
        assert.deepEqual(lintText('stock.md', expected), [], input);
        assert.ok(sameMarkdown(expected, input), input);
      }
    }
  });

  it('keeps an escaped character reference or emoji shortcode in text as written', () => {
    for (const text of ['Plain \\&amp; text.', 'Plain \\:tada: text.']) assert.equal(fixText(text), text);
    // After an escaped backslash, the reference and the shortcode are read and rewritten.
    assert.equal(fixText('Plain \\\\&eacute; and \\\\:tada: text.'), 'Plain \\\\é and \\\\🎉 text.');
  });

  it('escapes literal brackets and keeps link, image, code, task and callout syntax', () => {
    const cases: Array<[string, string]> = [
      ['# [Shelf] Inventory', '# \\[Shelf\\] Inventory'],
      ['Marked &#91;winter&rbrack; on the shelf.', 'Marked \\[winter\\] on the shelf.'],
      ['![[Stock/diagram.png]]', '!\\[\\[Stock/diagram.png\\]\\]'],
      ['* [ ] Check [blue] jars', '- [ ] Check \\[blue\\] jars'],
      ['* [ ]\n* [x]\n* [ ] Wash the jars', '- [ ] \n- [X] \n- [ ] Wash the jars'],
      ['See [[stock]] and [schedule](schedule.md)', 'See \\[\\[stock\\]\\] and [schedule](<schedule.md>)'],
      ['[Read [later]](schedule.md)', '[Read \\[later\\]](<schedule.md>)'],
      [String.raw`Keep \\[here] and \[there\].`, String.raw`Keep \\\[here\] and \[there\].`],
      ['Use `items[0]`.', 'Use `items[0]`.'],
      ['> [!TIP]\n> Check [blue] jars.', '> [!TIP]\n> Check \\[blue\\] jars.'],
      ['>  [!TIP]\n> Check [blue] jars.', '> [!TIP]\n> Check \\[blue\\] jars.'],
      ['> Inventory\n> [!TIP]', '> Inventory\n> \\[!TIP\\]'],
      ['> > [!TIP]\n> > Check [blue] jars.', '> > [!TIP]\n> > Check \\[blue\\] jars.'],
      ['* Supplies\n\n  > [!NOTE]\n  > Count [blue] jars.', '* Supplies\n\n  > [!NOTE]\n  > Count \\[blue\\] jars.'],
      ['> [!BARN]\n> Check the crates.', '> \\[!BARN\\]\n> Check the crates.'],
      ['> [!NOTE] Spare shelf\n> Check the crates.', '> \\[!NOTE\\] Spare shelf\n> Check the crates.'],
      ['> [!TIP]-\n> Check the crates.', '> \\[!TIP\\]-\n> Check the crates.'],
      ['> &#91;!TIP&#93;\n> Check the crates.', '> \\[!TIP\\]\n> Check the crates.'],
      ['> [!TIP]\n> ---', '> ## \\[!TIP\\]'],
    ];
    for (const [input, expected] of cases) {
      const fixed = fixText(input);
      assert.equal(fixed, expected, input);
      assert.equal(fixText(fixed), fixed, input);
      assert.deepEqual(lintText('stock.md', fixed), [], input);
      assert.ok(sameMarkdown(input, fixed), input);
    }
    const image = '![Rack [west] and `x]`](rack.png)';
    const fixedImage = '![Rack \\[west\\] and `x]`](rack.png)';
    assert.equal(fixText(image), fixedImage);
    assert.equal(fixText(fixedImage), fixedImage);
    assert.ok(sameMarkdown(fixedImage, image));
    assert.equal(fixText('> [!tip]\n> Check the crates.'), '> [!TIP]\n> Check the crates.');
    assert.equal(fixText('> [!tip]\n\n[!tip]: https://example.com/tips'), '> [!tip](<https://example.com/tips>)');
    const conflict = '> [!CUSTOM]\n> **Sync conflict: git version**';
    assert.equal(fixText(conflict), conflict);
  });

  it('keeps brackets where escaping them would create a link from plain text', () => {
    // A literal `_` at the end of the text still gets Linear's escape.
    for (const [input, written] of [
      ['[https://example.com_', '[https://example.com\\_'],
      ['[https://example.com_ *shelf* blue] *jars* ](stock.md) [https://example.com_', '[https://example.com_ *shelf* blue] *jars* ](stock.md) [https://example.com_'],
    ]) {
      const body = `# Supplies ###\n\n${input}`;
      const fixed = fixText(body);
      assert.equal(fixed, `# Supplies\n\n${written}`);
      assert.equal(fixText(fixed), fixed);
      assert.deepEqual(lintText('stock.md', fixed), []);
      assert.ok(sameMarkdown(body, fixed));
    }
  });

  it('keeps the alt text of an image whose label has a link or image', () => {
    const images = [
      '![Stock [schedule](https://example.com/stock)](rack.png)',
      '![Stock ![diagram](diagram.png)](rack.png)',
    ];
    for (const image of images) {
      const reference = image.replace('(rack.png)', '[rack]') + '\n\n[rack]: rack.png';
      assert.equal(fixText(reference), image);
      assert.equal(fixText(image), image);
    }
  });

  it('writes the links the bare-URL search finds inside text, and formats the rest of the file', () => {
    // The parser links none of these; Markdown's search for URLs inside text does.
    const cases: Array<[string, string]> = [
      ['Intro _a_.\n\nSee "www.example.com" and _more_.\n', 'Intro *a*.\n\nSee "[www.example.com](<http://www.example.com>)" and *more*.'],
      ['Host:www.example.com and _more_.\n', 'Host:www.example.com and *more*.'],
      ['Open [https://example.com] and _more_.\n', 'Open \\[[https://example.com](<https://example.com>)\\] and *more*.'],
      ['> Quote "www.example.com/a_b".\n> _Next_ line\n', '> Quote "[www.example.com/a_b](<http://www.example.com/a_b>)".\n> *Next* line'],
      ['- Mail "team@example.com" or "www.example.com", "www.example.com".\n', '* Mail "[team@example.com](<mailto:team@example.com>)" or "[www.example.com](<http://www.example.com>)", "[www.example.com](<http://www.example.com>)".'],
      ['| Site | Note |\n| - | - |\n| "www.example.com" | _x_ |\n', '| Site | Note |\n| -- | -- |\n| "[www.example.com](<http://www.example.com>)" | *x* |\n'],
      ['# Notes on "www.example.com"\n', '# Notes on "[www.example.com](<http://www.example.com>)"'],
      ['Skip xwww.example.com, then "www.example.com".\n', 'Skip [xwww.example.com](<http://xwww.example.com>), then "[www.example.com](<http://www.example.com>)".'],
      ['Mail "&amp;team@example.com" now.\n', 'Mail "&[team@example.com](<mailto:team@example.com>)" now.'],
      // `&notanentity;` names no character, so it is text as written.
      ['See "www.example.com/?x=1&notanentity;=2" and _more_.\n', 'See "[www.example.com/?x=1&notanentity;=2](<http://www.example.com/?x=1&notanentity;=2>)" and *more*.'],
      // A `!` before the address stays text: written as is, it would make an image.
      ['See "!www.example.com" and _more_.\n', 'See "\\![www.example.com](<http://www.example.com>)" and *more*.'],
      ['See !https://example.com and _more_.\n', 'See \\![https://example.com](<https://example.com>) and *more*.'],
    ];
    for (const [text, expected] of cases) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, JSON.stringify(text));
      assert.ok(sameMarkdown(text, fixed), `meaning of ${JSON.stringify(text)}`);
      assert.equal(fixText(fixed), fixed, `second fix of ${JSON.stringify(text)}`);
      assert.deepEqual(lintText('', fixed), [], `lint of ${JSON.stringify(fixed)}`);
    }
  });

  it('keeps a document with a link the bare-URL search finds but the source spells differently', () => {
    // An escape or a reference inside the URL: lint reports it, and fix leaves the file to its author.
    for (const text of [
      'Intro _a_.\n\nSee "www.example.com/a\\_b" now.\n',
      'See "www.example.com/a&amp;b" and _x_.\n',
      // The match would start after an escape, or end inside a reference.
      'Mail "\\+first@example.com" and _x_.\n',
      'See "www.example.com/&amp;amp" and _x_.\n',
      // A broken label, where the search once returned a link that made fix copy the document into it.
      'Before.\n\n[https://example.com/\\](<https://example.com/\\\\>)\nafter\n',
      // The source holds the text literally only in an address the search does not link.
      'See "www.example.com/a&amp;amp;b" xwww.example.com/a&amp;b and _x_.\n',
    ]) {
      assert.deepEqual(lintText('', text).map((finding) => finding.rule), ['unplaced-link']);
      assert.equal(fixText(text), text);
    }
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
