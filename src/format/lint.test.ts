// One case per lint rule, with the line it names, and the commands on a
// scratch folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { markdownFiles, runFix, runLint } from './command.ts';
import { fixLinearText, fixText } from './fix.ts';
import { duplicateTitles, lintInTree, lintText } from './lint.ts';
import { MarkdownLimitError, parse, visit } from './markdown.ts';
import { CONTENT_LIMIT, LINT_RULES, type LintRule } from './rules.ts';

const cases: Array<[LintRule, string, number]> = [
  ['code-span-padding', 'Intro.\n\nTwo `  alpha  ` end.', 3],
  ['code-span-padding', '* Item `   ` end', 1],
  // A `>` and a tab in the code are code text, not a quote's prefix.
  ['code-span-padding', 'Text `  a>\tb  ` end', 1],
  // A quote's tab Linear keeps inside the code leaves its outer spaces unsafe.
  ['code-span-padding', '> `  a\n>\tb  `', 1],
  ['tab-reference-layout', 'Seed&#9;order\n\n1. &#9;Collect', 3],
  ['space-reference-edge', 'Intro\n\n1. Seed order&#32;', 3],
  ['footnote', 'Text.\n\nA claim.[^1]\n\n[^1]: Source.', 3],
  ['footnote', 'An inline note.^[Text.]', 1],
  ['subscript', 'H~2~O', 1],
  ['table-escaped-pipe', '| A |\n| -- |\n| a \\| b |', 3],
  ['table-escaped-pipe', '| A | B |\n| -- | -- |\n| a &#124; b | 1 |', 3],
  ['table-escaped-pipe', '| A |\n| -- |\n| a&#x7C;b |', 3],
  ['table-escaped-pipe', '| Left &#124; right |\n| -- |\n| a |', 1],
  ['table-escaped-pipe', '| A |\n| -- |\n| **a &#124; b** |', 3],
  ['table-escaped-pipe', '| A |\n| -- |\n| [a &#124; b](https://example.com) |', 3],
  ['table-hash-cell', '| A | B |\n| -- | -- |\n| 1 | 2 |\n| # | 3 |', 4],
  ['table-hash-cell', 'Intro.\n\n> | Name | No. |\n> | -- | -- |\n> | Example |  # |', 5],
  ['table-hash-cell', '| A |\n| -- |\n| ## |', 3],
  ['table-hash-cell', '| A |\n| -- |\n| # Total **12** |', 3],
  ['table-list-cell', '| A | B |\n| -- | -- |\n| 1 | 2 |\n| + fee | 3 |', 4],
  ['table-list-cell', '| A |\n| -- |\n| - |', 3],
  ['table-list-cell', '| A |\n| -- |\n| * fee |', 3],
  ['table-list-cell', '> | A | B |\n> | -- | -- |\n> | x | 3) |', 3],
  ['table-quote-cell', '| A | B |\n| -- | -- |\n| 1 | 2 |\n| > Draft | 3 |', 4],
  ['table-quote-cell', '| A | B |\n| -- | -- |\n| x | >> Review |', 3],
  ['table-quote-cell', '| A |\n| -- |\n| > |', 3],
  ['table-quote-cell', '| A |\n| -- |\n| >**Bold** |', 3],
  ['table-quote-cell', '> | A | B |\n> | -- | -- |\n> | x | > y |', 3],
  ['table-header-pipe', 'Intro.\n\nTotal\n| --- |\n| 5 |', 3],
  ['table-header-pipe', '* Item\n\n  Total\n  |---|\n  |5|', 3],
  ['number-paragraph', 'Text.\n\n7\\.', 3],
  ['number-paragraph', '> 12\\)', 1],
  ['number-paragraph', '* a\n\n  7\\.', 3],
  ['list-after-item-text', '1. Plan\n\n   2.\n      * step', 3],
  ['list-after-item-text', '* Plan\n  * one\n\n  3. two', 4],
  ['setext-heading-lines', 'Intro.\n\nPlan\nfor May\n===', 3],
  ['setext-heading-lines', '> Plan\n> for May\n> ---', 1],
  ['image-in-link', '[![a](x.png)](https://example.com)', 1],
  ['table-alignment', '| A | B |\n| :-- | --: |\n| 1 | 2 |', 1],
  ['link-scheme', '[Remove](javascript:alert%281%29)', 1],
  ['link-scheme', '[Remove](java&#x09;script:alert%281%29)', 1],
  ['link-scheme', '[Remove](&#32;javascript:alert%281%29)', 1],
  ['link-scheme', '[Remove][bad]\n\n[bad]: data:text/plain,hello', 1],
  ['link-title', '[a](https://example.com "Title")', 1],
  ['link-title', 'See [a][r].\n\n[r]: https://example.com "Title"', 1],
  ['image-title', '![a](x.png "Title")', 1],
  ['code-in-emphasis', 'Text.\n\n**Run `npm ci` now**', 3],
  ['hard-break-backslash', 'one\\\ntwo', 1],
  ['git-conflict-marker', 'Intro.\n\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs', 3],
  ['git-conflict-marker', '> <<<<<<< ours', 1],
  ['git-conflict-marker', 'a\n\n>>>>>>> theirs', 3],
  ['git-conflict-marker', '> >>>>>>> theirs', 1],
  ['image-in-link', '[![a][i]](https://example.com)\n\n[i]: x.png', 1],
  ['url-in-html', '<img src="logo.png">', 1],
  ['url-in-html', '<a href="https://example.com">x</a>', 1],
  ['url-in-html', '<div>See HTTPS://example.com</div>', 1],
  ['url-in-html', '<div>1git+ssh://host/repo</div>', 1],
  ['url-in-html', '<img SRC = "logo.png">', 1],
  ['unplaced-link', 'See "www.example.com/a\\_b" now.', 1],
  ['unplaced-link', 'Intro.\n\n> Read "www.example.com/a&amp;b" now.', 3],
  ['unplaced-link', 'Intro.\n\nLine *one*\nline two "www.example.com/a\\_b" end.', 4],
  ['block-first-in-list-item', '* ## Heading\n* Plain', 1],
  ['list-number-too-long', '999999999. Pear\n999999999. Plum', 2],
  ['list-number-too-long', 'Intro.\n\n999999998. Pear\n2. Plum\n3. Fig', 5],
  ['list-number-too-long', '* Note\n\n  999999999. Pear\n  999999999. Plum', 4],
  ['ordered-task-list', '1. [ ] alpha\n2. [x] beta', 1],
  ['ordered-task-list', '1. one\n2. [ ] two', 2],
  ['ordered-task-list', '* a\n\n  3. [X] b', 3],
  ['image-not-in-repository', 'Intro.\n\n![Chart](https://example.com/chart.png)', 3],
  ['image-not-in-repository', '![Chart](https://uploads.linear.app/a/b/chart.png)', 1],
  ['image-not-in-repository', '![Dot](data:image/png;base64,iVBORw0KGgo=)', 1],
  ['image-not-in-repository', '![Logo](/images/logo.png)', 1],
  ['image-not-in-repository', '![Logo](//example.com/logo.png)', 1],
  ['image-not-in-repository', '![Logo](#top)', 1],
  ['image-not-in-repository', '![Logo]()', 1],
  ['image-not-in-repository', 'See ![chart][c].\n\n[c]: https://example.com/chart.png', 1],
  ['image-not-in-repository', '[![status](https://example.com/badge.svg)](https://example.com/build)', 1],
  ['image-not-in-repository', '| A |\n| -- |\n| ![x](https://example.com/x.png) |', 3],
  ['image-file-missing', '![Notes](notes.md)', 1],
  ['image-file-missing', '![Notes](notes/Guide.MD#intro)', 1],
  ['image-not-in-repository', '![Outside](../logo.png)', 1],
  ['image-not-in-repository', '![Folder](img/)', 1],
  ['image-not-in-repository', '![Query](?raw=1)', 1],
];

it('tab references that change Markdown layout stop fix only', () => {
  const cases = [
    '&#9;', '**&#9;&#9;Tip**', 'Collect&#9;', '1. &#9;Collect', '> &#9;Rest',
    'See **&#9;** today.', 'Before&#9;![Photo](photo.png) after.',
    'Before ![Photo](photo.png) &#9;after.', 'See www.example.com/garden&#9;',
  ];
  for (const input of cases) {
    assert.deepEqual(lintText('doc.md', input).map(({ rule, line }) => [rule, line]), [['tab-reference-layout', 1]], input);
    assert.deepEqual(lintInTree('doc.md', input, new Set(['photo.png'])), [], input);
    assert.equal(fixText(input), input);
  }
});

describe('lint rules', () => {
  it('table-hash-cell spares a header hash, an escaped hash and a hash that is no heading', () => {
    const text = '| # | `#` |\n| -- | -- |\n| \\# | **#** |\n| Issue # | #5 |\n| \\## | ####### |';
    assert.deepEqual(lintText('doc.md', text), []);
  });

  it('table-list-cell spares the header row, escaped markers, markers without a space and a number with a dot', () => {
    const text = '| + head | 1) |\n| -- | -- |\n| \\+ fee | \\- fee |\n| \\* fee | +fee |\n| -5 | 12. |\n| 3. x | **- x** |';
    assert.deepEqual(lintText('doc.md', text), []);
  });

  it('table-quote-cell spares the header row, an escaped or encoded >, a > after the start or inside markup, and a table Linear keeps as text', () => {
    const text = '| > head | >> Aside |\n| -- | -- |\n| \\> Draft | \\>> Note |\n| &gt; Kept | a > b |\n| **> Bold** | `> code` |';
    assert.deepEqual(lintText('doc.md', text), []);
    assert.deepEqual(lintText('doc.md', 'Total\n| --- |\n| > Draft |').map((finding) => finding.rule), ['table-header-pipe']);
  });

  it("table-quote-cell is fixed by fix, and the sync sends Linear's own export, which can start a cell with >", () => {
    const quoted = '| A |\n| -- |\n| > Draft |';
    assert.deepEqual(lintText('doc.md', fixText(quoted)), [], 'fix writes it as Linear keeps it');
    assert.deepEqual(lintInTree('doc.md', quoted, new Set()), []);
    // An empty quote inside a quote, as Linear exports it: a capture keeps it.
    const exported = '| A | B |\n| -- | -- |\n| Plan | > <br><br>Ref |\n';
    assert.equal(fixLinearText(exported, exported, () => false), exported);
    assert.equal(fixText('| A |\n| -- |\n| > Draft |\n', { linearExport: true }), '| A |\n| -- |\n| > Draft |\n');
  });

  it('table-header-pipe spares a table whose header row has a pipe', () => {
    for (const text of ['| Total |\n| --- |\n| 5 |', 'Total |\n--- |\n5 |', '| Total\n| ---\n| 5', '|Total|\n|-|\n|5|']) {
      assert.deepEqual(lintText('doc.md', text), [], text);
    }
  });

  it('number-paragraph ignores trailing spaces', () => {
    assert.deepEqual(lintText('doc.md', '7\\.  ').map((finding) => finding.rule), ['number-paragraph']);
  });

  it('table cell rules spare the rows from a line without a pipe on, which Linear reads as a paragraph', () => {
    for (const text of ['| A | B |\n| -- | -- |\nnote\n| # | C |', '| A | B |\n| -- | -- |\nnote\n| - | C |', '| A | B |\n| -- | -- |\nnote\n| a \\| b | C |']) {
      assert.deepEqual(lintText('doc.md', text), [], text);
    }
  });

  it('number-paragraph spares a number with text, a task item and a number Markdown reads as a list', () => {
    for (const text of ['7\\. Seven', 'Text 7\\.', '- [ ] 7\\.', '7.', '* x\n  1. 2.', '| A |\n| -- |\n| 7. |']) {
      assert.deepEqual(lintText('doc.md', text).filter((finding) => finding.rule === 'number-paragraph'), [], text);
    }
  });

  it('setext-heading-lines spares a heading of one text line and a line break inside a code span', () => {
    // A character reference for a line feed is no line ending in the source.
    for (const text of ['Plan for May\n===', 'Plan `for\nMay`\n---', '# Plan\nfor May', '# One&#10;Two', 'One&#10;Two\n===']) assert.deepEqual(lintText('doc.md', text), [], text);
  });

  it('table-hash-cell spares a hash followed by markup in the same cell', () => {
    for (const cell of ['#**tag**', '#[label](https://example.com)']) {
      assert.deepEqual(lintText('doc.md', `| A |\n| -- |\n| ${cell} |`), [], cell);
    }
  });

  for (const [rule, text, line] of cases) {
    it(`${rule}: ${JSON.stringify(text).slice(0, 40)}`, () => {
      const findings = lintText('doc.md', text);
      assert.ok(findings.some((f) => f.rule === rule && f.line === line && f.file === 'doc.md'), JSON.stringify(findings));
      assert.equal(findings.find((f) => f.rule === rule)?.message, LINT_RULES[rule]);
    });
  }

  it('list-number-too-long spares a list whose numbers stay within nine digits, and stops only fix', () => {
    // A part after an empty item and two blank lines counts from its own number, as Linear and fix do.
    for (const text of ['999999998. Pear\n999999998. Plum', '999999999. Pear', '* Pear\n* Plum\n* Fig', '999999999.\n\n\n5. Pear\n6. Plum']) {
      assert.deepEqual(lintText('doc.md', text), [], text);
    }
    assert.deepEqual(lintInTree('doc.md', '999999999. Pear\n999999999. Plum', new Set()), []);
  });

  it('leaves unplaced-link out of the sync, which sends the text as it is', () => {
    assert.deepEqual(lintInTree('doc.md', 'See "www.example.com/a\\_b" now.', new Set()), []);
  });

  it('allows space breaks in paragraphs and trailing spaces inside heading code spans', () => {
    assert.deepEqual(lintText('doc.md', 'One  \nTwo\n\n`Three  \nFour`\n==='), []);
  });

  it('checks image files only through the existence check, and never plain links', () => {
    const text = '![Here](img/here.png)\n\n![Gone](img/gone.png)\n\n[Gone](img/gone.png) and [site](https://example.com).';
    assert.deepEqual(lintText('doc.md', text), [], 'without the check, a relative image passes');
    const linkedFileExists = (url: string) => url === 'img/here.png';
    assert.deepEqual(lintText('doc.md', text, { linkedFileExists }).map((f) => [f.rule, f.line]), [['image-file-missing', 3]]);
  });

  it('refuses a document inside a folder named assets, by its path alone', () => {
    for (const file of ['assets/notes.md', 'team/assets/notes.md', 'team/assets/deeper/notes.md', 'team\\assets\\notes.md']) {
      assert.deepEqual(lintText(file, 'Text.').map((f) => [f.rule, f.line, f.message]), [['document-in-assets-folder', 1, LINT_RULES['document-in-assets-folder']]], file);
    }
    for (const file of ['assets.md', 'team/assets.md', 'team/Assets/notes.md', 'team/my-assets/notes.md', 'team/assets-old/notes.md']) {
      assert.deepEqual(lintText(file, 'Text.'), [], file);
    }
  });

  it('counts front matter lines', () => {
    const findings = lintText('doc.md', '---\ntitle: x\n---\n\nH~2~O');
    assert.deepEqual(findings.map((f) => [f.rule, f.line]), [['subscript', 5]]);
  });

  it('refuses content over the limit, counted in code points', () => {
    assert.equal(lintText('doc.md', '\u{1F600}'.repeat(CONTENT_LIMIT)).length, 0, 'emoji count once');
    assert.deepEqual(lintText('doc.md', 'a'.repeat(CONTENT_LIMIT + 1)).map((f) => f.rule), ['content-too-long']);
  });

  // A long header over many one-cell rows: `fix` would write every row with the header's width.
  const raggedTable = (width: number, rows: number): string => `${'|a'.repeat(width)}|\n${'|-'.repeat(width)}|\n${'|x|\n'.repeat(rows)}`;

  // The previous code ran out of memory on this input; the timeout bounds lint and fix together.
  it('refuses a table whose padding to the header width would be over the limits, and fix leaves it unchanged', { timeout: 60_000 }, () => {
    const text = `Intro.\n\n${raggedTable(30_000, 30_000)}`;
    assert.ok(text.length < CONTENT_LIMIT, 'the source is within the content limit');
    assert.deepEqual(lintText('doc.md', text).map((f) => [f.rule, f.line]), [['markdown-complexity', 3]]);
    assert.equal(fixText(text), text);
    // Padding that alone adds over 250,000 characters, from a source of a few kilobytes.
    assert.deepEqual(lintText('doc.md', raggedTable(300, 300)).map((f) => f.rule), ['markdown-complexity']);
    // Small tables whose padding adds up over the limit: the table that crosses it is named.
    const tables = Array.from({ length: 3 }, () => raggedTable(170, 170)).join('\n');
    assert.deepEqual(lintText('doc.md', tables).map((f) => [f.rule, f.line]), [['markdown-complexity', 347]]);
  });

  it('keeps the rows around an image text: moving the image out exposes no table to pad', () => {
    // The image makes the header one cell wider than the delimiter row, so the source has no table. Without
    // the image, the rest would be a 300-column table over 300 one-cell rows: fix escapes its delimiter row.
    const text = `![i](i.png) ${raggedTable(300, 300)}`;
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.ok(fixed.startsWith(`![i](i.png)\n\n${'|a'.repeat(300)}|\n\\${'|-'.repeat(300)}|\n`), 'the delimiter row is escaped');
    assert.equal(fixText(fixed), fixed);
    visit(parse(fixed), (node) => assert.notEqual(node.type, 'table'));
  });

  it('keeps padding a ragged table within the limits', () => {
    const text = raggedTable(200, 200);
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    // A document that ends with a table ends with a line break.
    assert.ok(fixed.endsWith(' |\n'));
    const rows = fixed.slice(0, -1).split('\n');
    assert.equal(rows.length, 202);
    assert.ok(rows.every((row) => row.split(' | ').length === 200), 'every row has the header width');
  });

  // Many short references to one long definition: `fix` writes each with its own copy of the destination.
  const references = (count: number, length: number): string => `${'[a][r] '.repeat(count)}\n\n[r]: https://example.com/${'x'.repeat(length)}\n`;

  // The previous code took minutes and gigabytes on far less, then threw a RangeError; the timeout bounds lint and fix together.
  it('refuses references whose destinations, each written in full, would be over the content limit, and fix leaves them unchanged', { timeout: 60_000 }, () => {
    const text = `Intro.\n\n${references(2_000, 1_000)}`;
    assert.ok(text.length < CONTENT_LIMIT, 'the source is within the content limit');
    assert.deepEqual(lintText('doc.md', text).map((f) => [f.rule, f.line]), [['markdown-complexity', 3]]);
    assert.equal(fixText(text), text);
    // Image references grow the same way.
    const images = `${'![a][r] '.repeat(3)}\n\n[r]: i${'x'.repeat(100_000)}.png\n`;
    assert.deepEqual(lintText('doc.md', images).map((f) => f.rule), ['markdown-complexity']);
  });

  it('keeps a definition after an image text: moving the image out exposes no references to expand', { timeout: 60_000 }, () => {
    // The definition shares a paragraph with an image, so the source has none and the references are text;
    // fix escapes its label once the image leaves the paragraph, so they stay text.
    const text = `${'[a][r] '.repeat(100)}\n\n![i](i.png) [r]: https://example.com/${'x'.repeat(5_000)}\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.ok(fixed.includes('\n\n![i](i.png)\n\n\\[r\\]: '), 'the label is escaped');
    assert.ok(fixed.length < 2 * text.length, 'no reference is expanded');
    assert.equal(fixText(fixed), fixed);
  });

  it('counts the parentheses fix adds around a shortcut reference', () => {
    // `[r]` is written `[r](<u>)`: 120 KB of source written as about 270 KB, in paragraphs the parser reads.
    const text = `${`${'[r] '.repeat(100)}\n\n`.repeat(300)}[r]: u\n`;
    const findings = lintText('doc.md', text);
    assert.deepEqual(findings.map((f) => f.rule), ['markdown-complexity']);
    assert.ok(findings[0]!.line > 1, 'named at the reference that crosses the limit');
  });

  it('does not count the definitions fix drops: a large document with many references stays within the limit', () => {
    const definitions = Array.from({ length: 600 }, (_, i) => `[r${i}]: https://example.com/${i}/${'x'.repeat(80)}`).join('\n');
    const links = Array.from({ length: 600 }, (_, i) => `[a][r${i}]`).join(' ');
    const text = `${'Some words here. '.repeat(8_000)}\n\n${links}\n\n${definitions}\n`;
    assert.ok(text.length > 200_000, 'the source is close to the content limit');
    assert.deepEqual(lintText('doc.md', text), []);
    assert.ok(fixText(text).length < CONTENT_LIMIT, 'fix keeps it within the limit');
  });

  it('counts what a reference grows by: many short references that fit stay fixable', () => {
    // 175 KB written as 225 KB: each `[a][r]` becomes `[a](<u>)`. Paragraphs of 100 keep the parser within its budget.
    const text = `${`${'[a][r] '.repeat(100)}\n\n`.repeat(250)}[r]: u\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.ok(fixed !== text && fixed.length < CONTENT_LIMIT, 'fix writes them inline within the limit');
  });

  it('counts only the label of an image reference: many short image references that fit stay fixable', () => {
    // 135 KB written as 195 KB: each `![a][r]` becomes `![a](u.png)`.
    const text = `${'![a][r]\n\n'.repeat(15_000)}[r]: u.png\n`;
    assert.deepEqual(lintText('doc.md', text, { linkedFileExists: () => true }), []);
    const fixed = fixText(text, { linkedFileExists: () => true });
    assert.ok(fixed !== text && fixed.length < CONTENT_LIMIT, 'fix writes them inline within the limit');
  });

  it('sums every reference: references that shrink the text later keep a document that fits', () => {
    // 190 KB written as 180 KB: the first group grows by 100 KB, the second shrinks by 110 KB.
    const grow = `${'[a][r] '.repeat(100)}\n\n`.repeat(50);
    const shrink = `${`[b][${'s'.repeat(25)}] `.repeat(100)}\n\n`.repeat(50);
    const text = `${grow}${shrink}[r]: https://example.com\n[${'s'.repeat(25)}]: u\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.ok(fixed !== text && fixed.length < CONTENT_LIMIT, 'fix writes them inline within the limit');
  });

  it('counts destinations as Linear writes them, with characters outside ASCII percent-encoded', () => {
    // Each emoji is written as 12 characters: 2,000 copies of 5 stay under the limit, of 90 they do not.
    const text = (emoji: number) => `${'[a][r] '.repeat(2_000)}\n\n[r]: https://example.com/${'\u{1F600}'.repeat(emoji)}\n`;
    assert.deepEqual(lintText('doc.md', text(5)), []);
    assert.notEqual(fixText(text(5)), text(5));
    assert.deepEqual(lintText('doc.md', text(90)).map((finding) => finding.rule), ['markdown-complexity']);
  });

  it('keeps writing reference links inline within the limit', () => {
    const text = references(100, 100);
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.equal(fixed.match(/\[a\]\(<https:\/\/example\.com\/x{100}>\)/g)?.length, 100);
    assert.ok(!fixed.includes('[r]'), 'the definition is written inline');
  });

  it('stops at content-too-long: text over the limit is not linted further', () => {
    const text = `H~2~O\n\n<div>${'a'.repeat(CONTENT_LIMIT)} https://example.com</div>`;
    assert.deepEqual(lintText('doc.md', text).map((f) => [f.rule, f.line]), [['content-too-long', 1]]);
    assert.deepEqual(lintText('assets/doc.md', text).map((f) => f.rule), ['content-too-long', 'document-in-assets-folder']);
  });

  it('checks a long HTML block for URLs in linear time', () => {
    // A scheme search that restarts at every letter took seconds here.
    const letters = 'a'.repeat(60_000);
    const started = performance.now();
    assert.deepEqual(lintText('doc.md', `<div>${letters}</div>`), []);
    assert.deepEqual(lintText('doc.md', `<div>${'a1+.-'.repeat(12_000)}</div>`), []);
    assert.deepEqual(lintText('doc.md', `<div>${':/'.repeat(30_000)}:// ${letters}</div>`), []);
    assert.deepEqual(lintText('doc.md', `<div>${letters}://</div>`).map((f) => f.rule), ['url-in-html']);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5_000, `took ${Math.round(elapsed)} ms`);
  });

  it('passes what Linear keeps', () => {
    for (const text of [
      '<div>Not a URL: 1://, -://, :// and ftp:/x</div>',
      '~~struck~~',
      '```\n<<<<<<< ours\n```',
      '`<<<<<<< ours`',
      '<<<<<< six only',
      '**Sync conflict: git version**\n\nText.\n\n**Sync conflict: end**',
      '[`code`](https://example.com)',
      '| `a \\| b` | c |\n| -- | -- |\n| 1 | 2 |',
      'Pick a &#124; b, or c \\| d.',
      '<details>\n<summary>More</summary>\n\nText.\n\n</details>',
    ]) {
      assert.deepEqual(lintText('doc.md', text), [], text);
    }
  });

  it('finds titles that collide by case or Unicode normalization', () => {
    const findings = duplicateTitles(['notes/Guide.md', 'notes/guide.md', 'café.md', 'café.md', 'other.md']);
    assert.deepEqual(findings.map((f) => f.file).sort(), ['café.md', 'café.md', 'notes/Guide.md', 'notes/guide.md'].sort());
    assert.ok(findings.every((f) => f.rule === 'duplicate-title' && f.line === 1));
  });

  it('names at most three other paths of a larger title collision and counts the rest', () => {
    const findings = duplicateTitles(['Guide.md', 'guide.md', 'GUIDE.md', 'gUide.md', 'guIde.md', 'other.md']);
    assert.deepEqual(findings.map((f) => [f.file, f.message]), [
      ['Guide.md', 'Two or more files map to one document title. (guide.md, GUIDE.md, gUide.md, and 1 more)'],
      ['guide.md', 'Two or more files map to one document title. (Guide.md, GUIDE.md, gUide.md, and 1 more)'],
      ['GUIDE.md', 'Two or more files map to one document title. (Guide.md, guide.md, gUide.md, and 1 more)'],
      ['gUide.md', 'Two or more files map to one document title. (Guide.md, guide.md, GUIDE.md, and 1 more)'],
      ['guIde.md', 'Two or more files map to one document title. (Guide.md, guide.md, GUIDE.md, and 1 more)'],
    ]);
    assert.equal(duplicateTitles(['a.md', 'A.md'])[0]?.message, 'Two or more files map to one document title. (A.md)');
  });
});

describe('lint and fix commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'format-command-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'docs', 'fixable.md'), '- a\n- b\n');
  writeFileSync(join(dir, 'docs', 'kept.md'), '* a\n* b');
  writeFileSync(join(dir, 'docs', 'loss.md'), 'H~2~O\n');
  writeFileSync(join(dir, 'docs', 'notes.txt'), '- not markdown\n');
  writeFileSync(join(dir, 'node_modules', 'skip.md'), '- skipped\n');

  it('lint reports findings and files not in form, and changes nothing', () => {
    const result = runLint(['docs'], dir);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, `docs/loss.md:1: subscript: ${LINT_RULES.subscript}\ndocs/fixable.md: not in Linear's form; run fix\n`);
    assert.equal(readFileSync(join(dir, 'docs', 'fixable.md'), 'utf8'), '- a\n- b\n');
  });

  it('takes absolute paths and refuses options and missing paths', () => {
    assert.equal(runLint([join(dir, 'docs', 'kept.md')], dir).exitCode, 0);
    assert.deepEqual(runLint(['--help'], dir), { exitCode: 2, stdout: '', stderr: 'unknown option: --help\n' });
    assert.deepEqual(runFix(['nowhere'], dir), { exitCode: 2, stdout: '', stderr: 'no such file or folder: nowhere\n' });
  });

  it('fix writes a backslash break in a paragraph as Linear does and reports one it leaves', (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'backslash-break-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, 'walk.md'), '- Boots\\\n  and a map\n');
    writeFileSync(join(folder, 'mixed.md'), 'Boots\\\nand a map\n\nH~2~O\n');
    writeFileSync(join(folder, 'heading.md'), 'Boots\\\nand a map\n===\n');
    const finding = (file: string, line: number, rule: LintRule) => `${file}:${line}: ${rule}: ${LINT_RULES[rule]}\n`;
    const lintBefore = finding('heading.md', 1, 'hard-break-backslash')
      + finding('mixed.md', 1, 'hard-break-backslash') + finding('mixed.md', 4, 'subscript')
      + finding('walk.md', 1, 'hard-break-backslash');
    assert.deepEqual(runLint([], folder), { exitCode: 1, stdout: lintBefore, stderr: '' });
    // A file with another finding is left as it is; the heading has no form for the break.
    const left = finding('heading.md', 1, 'hard-break-backslash') + finding('mixed.md', 1, 'hard-break-backslash') + finding('mixed.md', 4, 'subscript');
    assert.deepEqual(runFix([], folder), { exitCode: 1, stdout: `walk.md: fixed\n${left}`, stderr: '' });
    assert.equal(readFileSync(join(folder, 'walk.md'), 'utf8'), '* Boots\n  and a map');
    assert.equal(readFileSync(join(folder, 'mixed.md'), 'utf8'), 'Boots\\\nand a map\n\nH~2~O\n');
    assert.equal(readFileSync(join(folder, 'heading.md'), 'utf8'), 'Boots\\\nand a map\n===\n');
    assert.deepEqual(runFix([], folder), { exitCode: 1, stdout: left, stderr: '' });
    assert.deepEqual(runLint(['walk.md'], folder), { exitCode: 0, stdout: '', stderr: '' });
  });

  it('reports a chain of thousands of tables that ending exposes as markdown-complexity and keeps the file', (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'table-chain-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const text = '| A |\n| -- |\ntext\n'.repeat(2_000);
    writeFileSync(join(folder, 'chain.md'), text);
    const finding = `chain.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    assert.deepEqual(runLint([], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.deepEqual(runFix([], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.equal(readFileSync(join(folder, 'chain.md'), 'utf8'), text);
  });

  it('reports a paragraph whose many space references at mark edges cannot all move as markdown-complexity and keeps the file', (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'edge-spaces-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    // The first reference would make a hard line break: every other one is then checked by itself.
    const text = 'a&#32;&#32;\nb ' + ('word '.repeat(20) + '**&#32;x** ').repeat(200) + 'end.\n';
    writeFileSync(join(folder, 'spaces.md'), text);
    const finding = `spaces.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    assert.deepEqual(runLint([], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.deepEqual(runFix([], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.equal(readFileSync(join(folder, 'spaces.md'), 'utf8'), text);
  });

  it('bounds reference-definition work across nested list items and keeps the file', (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'nested-list-links-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const guide = 'https://example.test/guide';
    const definitions = [
      `[guide]: ${guide}`,
      ...Array.from({ length: 150 }, (_, index) =>
        `[entry-${index}]: https://example.test/library/${index}/${'archive/'.repeat(18)}guide`),
    ].join('\n');
    const document = (count: number): string => {
      const items = Array.from({ length: count }, (_, index) => `Inventory ${index + 1}\n1. 2. [Guide][guide]`);
      return `${items.join('\n\n')}\n\n${definitions}\n`;
    };

    writeFileSync(join(folder, 'guide.md'), document(1));
    assert.deepEqual(runFix(['guide.md'], folder), { exitCode: 1, stdout: 'guide.md: fixed\n', stderr: '' });
    assert.match(readFileSync(join(folder, 'guide.md'), 'utf8'), /2\. \[Guide\]\(<https:\/\/example\.test\/guide>\)/);

    const text = document(50);
    assert.throws(() => fixText(text), (error) => error instanceof MarkdownLimitError && error.limit === 'nested-list-definitions');
    writeFileSync(join(folder, 'catalog.md'), text);
    const finding = `catalog.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    assert.deepEqual(runLint(['catalog.md'], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.deepEqual(runFix(['catalog.md'], folder), { exitCode: 1, stdout: finding, stderr: '' });
    assert.equal(readFileSync(join(folder, 'catalog.md'), 'utf8'), text);
  });

  it('formats an operations handbook with many nested references and a procedure index', () => {
    const procedures = Array.from({ length: 200 }, (_, index) => ({
      name: `procedure-${index + 1}`,
      url: `https://example.test/operations/${index + 1}`,
    }));
    const chapters = procedures.slice(0, 60).map(({ name }) => [
      `## ${name}`,
      '',
      'Contents for the next shift:',
      `1. 2. [Read the procedure][${name}]`,
      '2. Confirm the new owner and update the shift report.',
    ].join('\n'));
    const index = procedures.map(({ name }) => `- [${name}][${name}]`).join('\n');
    const definitions = procedures.map(({ name, url }) => `[${name}]: ${url}`).join('\n');
    const text = ['# Operations handbook', '_Shift notes_ and \\_archived notes.', ...chapters, index, definitions].join('\n\n');
    const fixed = fixText(text);
    for (const { url } of procedures.slice(0, 60)) assert.ok(fixed.includes(`[Read the procedure](<${url}>)`));
    assert.equal(fixText(fixed), fixed);
  });

  it('reports hard breaks in setext headings and keeps the file through two fixes', (t) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'heading-hard-break-'));
    t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
    // The first also breaks its heading's text with a soft break, which Linear splits off.
    const cases = [
      ['heading-setext-break-spaces.md', 'hard-break-in-heading', 2, [[1, 'setext-heading-lines']]],
      ['heading-setext-break-backslash.md', 'hard-break-backslash', 1, []],
    ] as const;
    for (const [file, rule, line, others] of cases) {
      const source = readFileSync(new URL(`../../test/fixtures/lint-errors/${file}`, import.meta.url), 'utf8');
      const path = join(fixtureDir, file);
      writeFileSync(path, source);
      const findings: Array<readonly [number, LintRule]> = [...others, [line, rule]];
      const stdout = findings.map(([at, name]) => `${file}:${at}: ${name}: ${LINT_RULES[name]}\n`).join('');
      const result = { exitCode: 1, stdout, stderr: '' };
      assert.deepEqual(runLint([file], fixtureDir), result);
      assert.equal(fixText(source), source);
      for (let pass = 0; pass < 2; pass++) {
        assert.deepEqual(runFix([file], fixtureDir), result);
        const fixed = readFileSync(path, 'utf8');
        assert.equal(fixed, source);
        const breaks: number[] = [];
        visit(parse(fixed), (node, ancestors) => {
          if (node.type === 'break' && ancestors.some((a) => a.type === 'heading')) {
            breaks.push(node.position!.start.line);
          }
        });
        assert.deepEqual(breaks, [line]);
      }
    }
  });

  it('lint and fix refuse a document inside an assets folder and leave it unchanged', () => {
    const folder = join(dir, 'team');
    try {
      mkdirSync(join(folder, 'assets'), { recursive: true });
      writeFileSync(join(folder, 'assets', 'notes.md'), '- a\n');
      writeFileSync(join(folder, 'assets', 'chart.png'), 'png');
      writeFileSync(join(folder, 'doc.md'), '![Chart](assets/chart.png)');
      const message = `team/assets/notes.md:1: document-in-assets-folder: ${LINT_RULES['document-in-assets-folder']}\n`;
      assert.deepEqual(runLint(['team'], dir), { exitCode: 1, stdout: message, stderr: '' });
      assert.equal(runFix(['team'], dir).exitCode, 1);
      assert.equal(readFileSync(join(folder, 'assets', 'notes.md'), 'utf8'), '- a\n');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('lint and fix report a table too large to pad and leave it unchanged', () => {
    const path = join(dir, 'ragged.md');
    const source = `${'|a'.repeat(30_000)}|\n${'|-'.repeat(30_000)}|\n${'|x|\n'.repeat(30_000)}`;
    const message = `ragged.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    try {
      writeFileSync(path, source);
      assert.deepEqual(runLint(['ragged.md'], dir), { exitCode: 1, stdout: message, stderr: '' });
      assert.deepEqual(runFix(['ragged.md'], dir), { exitCode: 1, stdout: message, stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), source);
    } finally {
      rmSync(path, { force: true });
    }
  });

  // The source is 240 KB; written inline, its references would be 2 GB. The timeout bounds lint and fix together.
  // Through the command line in a child process: the parent's timeout stops a stalled lint or fix, which a
  // test timeout cannot interrupt.
  it('lint and fix report references too large to write inline and leave the file unchanged', { timeout: 300_000 }, () => {
    const path = join(dir, 'references.md');
    // 20,000 references in paragraphs of 100, which the parser reads within its budget.
    const source = `${`${'[a][r] '.repeat(100)}\n\n`.repeat(200)}[r]: https://example.com/${'x'.repeat(100_000)}\n`;
    const message = `references.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const run = (command: string) => {
      const child = spawnSync(process.execPath, [cli, command, 'references.md'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
      return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
    };
    try {
      writeFileSync(path, source);
      assert.deepEqual(run('lint'), { exitCode: 1, stdout: message, stderr: '' });
      assert.deepEqual(run('fix'), { exitCode: 1, stdout: message, stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), source);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('lint and fix report many unresolved references in one paragraph within seconds, and leave the file unchanged', () => {
    // The parser took minutes on this 140 KB paragraph; the commands run in a child the test can stop.
    const path = join(dir, 'brackets.md');
    const source = '[a][r] '.repeat(20_000);
    const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const message = `brackets.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    try {
      writeFileSync(path, source);
      for (const command of ['lint', 'fix']) {
        const child = spawnSync(process.execPath, [cli, command, 'brackets.md'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.signal, null, `${command} finished within the timeout`);
        assert.deepEqual([child.status, child.stdout, child.stderr], [1, message, ''], command);
      }
      assert.equal(readFileSync(path, 'utf8'), source);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('lint and fix keep rows around an image text, without exposing a table', () => {
    const path = join(dir, 'exposed.md');
    const source = `![i](i.png) ${'|a'.repeat(300)}|\n${'|-'.repeat(300)}|\n${'|x|\n'.repeat(300)}`;
    try {
      writeFileSync(path, source);
      writeFileSync(join(dir, 'i.png'), 'png');
      assert.deepEqual(runLint(['exposed.md'], dir), { exitCode: 1, stdout: "exposed.md: not in Linear's form; run fix\n", stderr: '' });
      assert.deepEqual(runFix(['exposed.md'], dir), { exitCode: 1, stdout: 'exposed.md: fixed\n', stderr: '' });
      assert.ok(readFileSync(path, 'utf8').includes(`\n\\${'|-'.repeat(300)}|\n`), 'the delimiter row is escaped');
      assert.deepEqual(runLint(['exposed.md'], dir), { exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(path, { force: true });
      rmSync(join(dir, 'i.png'), { force: true });
    }
  });

  it('lint and fix agree on a hash header without losing cell text', () => {
    const path = join(dir, 'table.md');
    const source = '| # | Customer |\n| -- | -- |\n| 1 | Example |';
    const fixed = '| \\# | Customer |\n| -- | -- |\n| 1 | Example |\n';
    try {
      writeFileSync(path, source);
      assert.deepEqual(runLint(['table.md'], dir), { exitCode: 1, stdout: "table.md: not in Linear's form; run fix\n", stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), source);
      assert.deepEqual(runFix(['table.md'], dir), { exitCode: 1, stdout: 'table.md: fixed\n', stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), fixed);
      assert.deepEqual(runLint(['table.md'], dir), { exitCode: 0, stdout: '', stderr: '' });
      assert.deepEqual(runFix(['table.md'], dir), { exitCode: 0, stdout: '', stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), fixed);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('fix leaves files whose titles collide', () => {
    const folder = join(dir, 'titles');
    mkdirSync(folder);
    try {
      writeFileSync(join(folder, 'Guide.md'), '- a\n');
      writeFileSync(join(folder, 'guide.md'), '- b\n');
      const result = runFix(['titles'], dir);
      assert.equal(result.exitCode, 1);
      assert.equal(readFileSync(join(folder, 'Guide.md'), 'utf8'), '- a\n');
      assert.equal(readFileSync(join(folder, 'guide.md'), 'utf8'), '- b\n');
      assert.match(result.stdout, /titles\/Guide\.md:1: duplicate-title/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('fix writes a list item linking a missing file as a link, and one linking a present file as a block', () => {
    const folder = join(dir, 'links');
    mkdirSync(join(folder, 'media'), { recursive: true });
    try {
      writeFileSync(join(folder, 'media', 'demo one.mp4'), 'video');
      writeFileSync(join(folder, 'media', 'summary.pdf'), '%PDF');
      writeFileSync(join(folder, 'notes.md'), '* [Demo](media/demo%20one.mp4)\n* [Summary](media/summary.pdf)\n* [Gone](media/gone.pdf)\n* [Folder](media)\n* [Nul](media/gone%00.pdf)\n');
      assert.equal(runFix(['links'], dir).exitCode, 1);
      assert.equal(readFileSync(join(folder, 'notes.md'), 'utf8'), '* [Demo](media/demo%20one.mp4)\n* \n  [Summary](media/summary.pdf)\n* [Gone](<media/gone.pdf>)\n* [Folder](<media>)\n* [Nul](<media/gone%00.pdf>)');
      assert.deepEqual(runLint(['links'], dir), { exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('fix preserves a nested list item linking an existing file immediately after its parent’s text', () => {
    const folder = join(dir, 'nested-link');
    mkdirSync(folder);
    try {
      const path = join(folder, 'notes.md');
      const fixed = '* Parent\n  * [Report](<report.csv>)';
      writeFileSync(path, '- Parent\n  - [Report](report.csv)\n');
      writeFileSync(join(folder, 'report.csv'), 'name,total\nExample,3\n');
      assert.deepEqual(runFix(['nested-link'], dir), { exitCode: 1, stdout: 'nested-link/notes.md: fixed\n', stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), fixed);
      assert.deepEqual(runFix(['nested-link'], dir), { exitCode: 0, stdout: '', stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), fixed);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('accepts only images that are files of the repository, and fix leaves the others', () => {
    const folder = join(dir, 'pictures');
    mkdirSync(join(folder, 'img', 'set'), { recursive: true });
    const lfsPointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12345\n';
    const good = '* Plan\n\n![Here](img/here.png)\n\n![Stored in LFS](img/large.png)\n\n![Spaced](img/two%20words.png)\n\n[Site](<https://example.com>)';
    const bad = [
      '![Here](img/here.png)',
      '![Remote](https://example.com/chart.png)',
      '![Gone](img/gone.png)',
      '![Folder](img/set)',
      '![Outside](../../outside.png)',
      '![Document](good.md)',
      '[![Badge](https://example.com/badge.svg)](https://example.com/build)',
      '* Item\n\n  ![Gone](img/gone.png)',
      '![Linked](img/link.png)',
      '![Case](IMG/here.png)',
      '![First definition][r]\n\n[r]: https://example.com/x.png\n[r]: img/here.png',
    ].join('\n\n');
    try {
      writeFileSync(join(folder, 'img', 'here.png'), 'png');
      writeFileSync(join(folder, 'img', 'large.png'), lfsPointer);
      writeFileSync(join(folder, 'img', 'two words.png'), 'png');
      symlinkSync('here.png', join(folder, 'img', 'link.png'));
      writeFileSync(join(folder, 'good.md'), good);
      writeFileSync(join(folder, 'bad.md'), bad);
      const expected = [
        'pictures/bad.md:3: image-not-in-repository',
        'pictures/bad.md:5: image-file-missing',
        'pictures/bad.md:7: image-file-missing',
        'pictures/bad.md:9: image-not-in-repository',
        'pictures/bad.md:11: image-file-missing',
        'pictures/bad.md:13: image-in-link',
        'pictures/bad.md:13: image-not-in-repository',
        'pictures/bad.md:17: image-file-missing',
        'pictures/bad.md:19: image-file-missing',
        'pictures/bad.md:21: image-file-missing',
        'pictures/bad.md:23: image-not-in-repository',
      ];
      const lint = runLint(['pictures'], dir);
      assert.equal(lint.exitCode, 1);
      assert.deepEqual(lint.stdout.trimEnd().split('\n').map((row) => row.split(': ').slice(0, 2).join(': ')), expected);
      const fix = runFix(['pictures'], dir);
      assert.equal(fix.exitCode, 1);
      assert.equal(readFileSync(join(folder, 'bad.md'), 'utf8'), bad, 'fix leaves a file with a broken or outside image as it is');
      assert.equal(readFileSync(join(folder, 'good.md'), 'utf8'), good);
      assert.doesNotMatch(fix.stdout, /good\.md/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('does not follow symbolic links', () => {
    const outside = mkdtempSync(join(tmpdir(), 'format-outside-'));
    try {
      writeFileSync(join(outside, 'other.md'), '- outside\n');
      symlinkSync(outside, join(dir, 'docs', 'link'));
      symlinkSync(dir, join(dir, 'docs', 'loop'));
      assert.deepEqual(markdownFiles(['docs'], dir), ['docs/fixable.md', 'docs/kept.md', 'docs/loss.md']);
      runFix(['docs'], dir);
      assert.equal(readFileSync(join(outside, 'other.md'), 'utf8'), '- outside\n');
      writeFileSync(join(dir, 'docs', 'fixable.md'), '- a\n- b\n'); // as the next test expects
    } finally {
      rmSync(join(dir, 'docs', 'link'));
      rmSync(join(dir, 'docs', 'loop'));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a path whose folder is a symbolic link and leaves the file it leads to unchanged', () => {
    const outside = mkdtempSync(join(tmpdir(), 'format-outside-'));
    const linked = join(dir, 'linked');
    try {
      writeFileSync(join(outside, 'guide.md'), '- outside\n');
      symlinkSync(outside, linked);
      const refused = { exitCode: 2, stdout: '', stderr: 'path passes through a symbolic link or differs in case: linked/guide.md\n' };
      assert.deepEqual(runFix(['linked/guide.md'], dir), refused);
      assert.deepEqual(runLint(['linked/guide.md'], dir), refused);
      assert.deepEqual(runFix([join(linked, 'guide.md')], dir).exitCode, 2);
      assert.deepEqual(runLint(['linked'], dir), { exitCode: 2, stdout: '', stderr: 'path passes through a symbolic link or differs in case: linked\n' }, 'a path that is itself a link is refused, not skipped');
      assert.equal(readFileSync(join(outside, 'guide.md'), 'utf8'), '- outside\n');
      assert.deepEqual(runLint(['docs/kept.md'], dir), { exitCode: 0, stdout: '', stderr: '' }, 'a path through real folders passes');
    } finally {
      rmSync(linked);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prints file names and paths with their control characters escaped, one line per finding', () => {
    const folder = join(dir, 'names');
    mkdirSync(folder);
    const forged = 'a\n::error file=x::forged\u001b[2J\u009b.md';
    const shown = 'names/a\\u000a::error file=x::forged\\u001b[2J\\u009b.md';
    try {
      writeFileSync(join(folder, forged), '- a\n- b\n');
      writeFileSync(join(folder, 'loss\r.md'), 'H~2~O\n');
      const lint = runLint(['names'], dir);
      assert.equal(lint.stdout, `names/loss\\u000d.md:1: subscript: ${LINT_RULES.subscript}\n${shown}: not in Linear's form; run fix\n`);
      assert.equal(lint.stdout.split('\n').length, 3);
      const fix = runFix(['names'], dir);
      assert.equal(fix.stdout, `${shown}: fixed\nnames/loss\\u000d.md:1: subscript: ${LINT_RULES.subscript}\n`);
      assert.equal(readFileSync(join(folder, forged), 'utf8'), '* a\n* b');
      assert.deepEqual(runLint([`names/b\u001b]0;x\u0007.md`], dir), { exitCode: 2, stdout: '', stderr: 'no such file or folder: names/b\\u001b]0;x\\u0007.md\n' });
      assert.deepEqual(runFix(['-\nx'], dir), { exitCode: 2, stdout: '', stderr: 'unknown option: -\\u000ax\n' });
      writeFileSync(join(folder, 'text\\u000a.md'), '- a\n');
      assert.match(runLint(['names'], dir).stdout, /^names\/text\\u005cu000a\.md: not in Linear's form; run fix$/m, 'a literal backslash prints apart from an escape');
      if (process.getuid?.() !== 0) {
        chmodSync(join(folder, forged), 0o000);
        assert.throws(() => runLint(['names'], dir), (error: Error) => error.message.includes(shown.slice('names/'.length)) && !/[\u0000-\u001f]/.test(error.message));
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('fix only reads a read-only file that needs no change', () => {
    const folder = join(dir, 'read-only');
    mkdirSync(folder);
    try {
      writeFileSync(join(folder, 'done.md'), '* a\n* b');
      chmodSync(join(folder, 'done.md'), 0o444);
      assert.deepEqual(runFix(['read-only'], dir), { exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('escapes control characters in the names a duplicate title lists', () => {
    const folder = join(dir, 'twins');
    mkdirSync(folder);
    try {
      // Names a case-insensitive volume keeps apart: the ligature only matches once upper-cased.
      writeFileSync(join(folder, '\ufb01le\u0085.md'), 'Text.\n');
      writeFileSync(join(folder, 'file\u0085.md'), 'Text.\n');
      const lint = runLint(['twins'], dir);
      assert.equal(lint.stdout.split('\n').length, 3);
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(lint.stdout.replaceAll('\n', '')), lint.stdout);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('fix rewrites, reports what it leaves, and passes on the second run', () => {
    const first = runFix([], dir);
    assert.equal(first.exitCode, 1);
    assert.equal(first.stdout, `docs/fixable.md: fixed\ndocs/loss.md:1: subscript: ${LINT_RULES.subscript}\n`);
    assert.equal(readFileSync(join(dir, 'docs', 'fixable.md'), 'utf8'), '* a\n* b');
    assert.equal(readFileSync(join(dir, 'docs', 'loss.md'), 'utf8'), 'H~2~O\n');
    assert.equal(readFileSync(join(dir, 'node_modules', 'skip.md'), 'utf8'), '- skipped\n');
    writeFileSync(join(dir, 'docs', 'loss.md'), 'H2O');
    assert.deepEqual(runFix([], dir), { exitCode: 0, stdout: '', stderr: '' });
    assert.deepEqual(runLint([], dir), { exitCode: 0, stdout: '', stderr: '' });
  });
});

describe('upload-file-refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'format-uploads-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const hash = (char: string) => char.repeat(64);
  mkdirSync(join(dir, 'docs'));
  // Admitted by the earlier check: XHTML inside an SVG root.
  writeFileSync(join(dir, 'docs', `${hash('a')}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/></svg>');
  writeFileSync(join(dir, 'docs', `${hash('b')}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  writeFileSync(join(dir, 'docs', `${hash('c')}.png`), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'docs', `${hash('d')}.svg`), `version https://git-lfs.github.com/spec/v1\noid sha256:${hash('d')}\nsize 12\n`);
  writeFileSync(join(dir, 'docs', 'logo.svg'), '<svg><script/></svg>');
  writeFileSync(join(dir, 'docs', 'plan.md'), `![Image](${hash('a')}.svg)`);

  it('names captured files the upload check refuses, and no file a person named or an LFS pointer', () => {
    const message = LINT_RULES['upload-file-refused'];
    const expected = `docs/${hash('a')}.svg:1: upload-file-refused: ${message}\ndocs/${hash('c')}.png:1: upload-file-refused: ${message}\n`;
    assert.deepEqual(runLint([], dir), { exitCode: 1, stdout: expected, stderr: '' });
    assert.deepEqual(runLint(['docs/plan.md'], dir), { exitCode: 0, stdout: '', stderr: '' }, 'the hooks pass Markdown files only');
    assert.deepEqual(runFix(['docs'], dir), { exitCode: 1, stdout: expected, stderr: '' });
  });
});
