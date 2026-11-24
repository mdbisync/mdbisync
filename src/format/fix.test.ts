// One case per fix rule, plus what fix must leave alone. The fixture bank
// test (test/format/bank.test.ts) checks the same rules against Linear's
// recorded forms.

import type { Blockquote, List, Paragraph } from 'mdast';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fixLinearText, fixText, relativeFileBlocksAsLinks } from './fix.ts';
import { linkedFileCheck, lintText } from './lint.ts';
import { parse, sameMarkdown, splitFile, visit } from './markdown.ts';

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
  ['a nested list starting with an empty item keeps its blank line after the parent', '* Parent\n\n  *\n  * Next\n\n1. Parent\n\n   1.\n   2. Next', '* Parent\n\n  *\n  * Next\n\n1. Parent\n\n   1.\n   2. Next'],
  ['a nested file block keeps its existing blank line after the parent', '* Parent\n\n  * \n    [Report](report.csv)', '* Parent\n\n  * \n    [Report](report.csv)'],
  ['a task or numbered item with only a video link keeps the file block (the video form is recorded for bullets)', '- [ ] [Demo](demo.mp4)\n\n1. [Demo](demo.mp4)', '- [ ] \n  [Demo](demo.mp4)\n\n1. \n   [Demo](demo.mp4)'],
  ['a bullet item with only an MP3 link keeps the link on its line, in angle brackets', '* \n  [Voice note](media/note.mp3)\n* [Call](<call one.MP3>)\n* [Memo](memo.mp3?v=2)', '* [Voice note](<media/note.mp3>)\n* [Call](<call%20one.MP3>)\n* [Memo](<memo.mp3?v=2>)'],
  ['an MP3 task keeps its break and a numbered MP3 stays on the marker line', '- [ ] [Note](note.mp3)\n\n3. [Note](note.mp3)', '- [ ] \n  [Note](note.mp3)\n\n3. [Note](<note.mp3>)'],
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
    const padded = '| Step | State |\n| -- | -- |\n| Draft  | tbd |';
    assert.equal(fixLinearText(padded, padded, () => false), '| Step | State |\n| -- | -- |\n| Draft | tbd |');
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
    // The text Markdown reads, line breaks included, and the node types around it.
    const read = (markdown: string): string[] => {
      const out: string[] = [];
      visit(parse(markdown), (node) => {
        out.push(node.type === 'text' ? node.value : node.type);
      });
      return out;
    };
    for (const [text, expected] of lazy) {
      const fixed = fixText(text);
      assert.equal(fixed, expected, text);
      // `sameMarkdown` keeps a file block's empty marker line apart, so compare what Markdown reads.
      assert.deepEqual(read(fixed), read(text), `same document: ${text}`);
      assert.equal(fixText(fixed), fixed, `a second fix changes nothing: ${text}`);
      assert.deepEqual(lintText('a.md', fixed), lintText('a.md', text), `lint finds nothing new: ${text}`);
    }
  });

  it('escapes a lone -- line between blank lines, and reads one under a paragraph as Markdown does: a heading', () => {
    assert.equal(fixText('Text.\n\n--\n\nMore.'), 'Text.\n\n\\--\n\nMore.');
    assert.equal(fixText('--'), '\\--');
    assert.equal(fixText('Text\n--\n\nMore.'), '## Text\n\nMore.');
    // Outside a container nothing is written before the line: a code span keeps its tab.
    assert.equal(fixText('`a\n\t--\nb`'), '`a\n\t--\nb`');
  });

  it('escapes a literal - or * that starts a paragraph line, as Linear writes it', () => {
    const cases: Array<[string, string]> = [
      ['-x marks it', '\\-x marks it'],
      ['*x star', '\\*x star'],
      ['First\n-- second\n-x third', 'First\n\\-- second\n\\-x third'],
      ['* item\n  -- remark', '* item\n  \\-- remark'],
      ['> words\n> -x remark', '> words\n> \\-x remark'],
      // Already escaped, not a line start, or not text: nothing to add.
      ['\\-x and \\*y', '\\-x and \\*y'],
      ['a -x and *b', 'a -x and *b'],
      ['+x plus', '+x plus'],
      ['*x* emphasis', '*x* emphasis'],
      ['`a\n-x`', '`a\n-x`'],
      ['# -x heading', '# -x heading'],
    ];
    for (const [input, expected] of cases) {
      const once = fixText(input);
      assert.equal(once, expected, JSON.stringify(input));
      assert.equal(fixText(once), once, `${JSON.stringify(input)}: a second fix changes nothing`);
      assert.ok(sameMarkdown(once, input), `${JSON.stringify(input)}: the document stays`);
    }
  });

  it('keeps a code span whose lazy line holds only dashes in a quote: the padding stops the underline', () => {
    // Under a bare `> ` the line would underline `` `a `` as a heading and split the code span.
    const fixed = fixText('> `a\n--\n> b`');
    assert.equal(fixed, '> `a\n>     --\n> b`');
    assert.equal(fixText(fixed), fixed, 'a second fix changes nothing');
    const [quote] = parse(fixed).children;
    assert.equal(quote?.type, 'blockquote');
    const [paragraph] = (quote as Blockquote).children;
    assert.equal(paragraph?.type, 'paragraph');
    assert.deepEqual((paragraph as Paragraph).children.map((child) => child.type), ['inlineCode']);
  });

  it('keeps spaces that belong to a code span across lines', () => {
    assert.equal(fixText('`a\n  b`'), '`a\n  b`');
    assert.equal(fixText('> `a\n>   b`'), '> `a\n>   b`');
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
      ['See https://example.com/\\* now.', 'See [https://example.com/\\\\](<https://example.com/%5C>)* now.'],
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

  it('keeps a document whose parse holds a node without a source position, rather than copying the wrong text', () => {
    // The bare-URL search inside this broken label yields a link with no position.
    const text = 'Before.\n\n[https://example.com/\\](<https://example.com/\\\\>)\nafter\n';
    assert.equal(fixText(text), text);
    // So does a quoted domain, which the parser does not link but the search does.
    const quoted = 'Intro.\n\n"www.example.com" and _more_.\n\nEnd.\n';
    assert.equal(fixText(quoted), quoted);
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
