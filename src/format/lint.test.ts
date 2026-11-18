// One case per lint rule, with the line it names, and the commands on a
// scratch folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { markdownFiles, runFix, runLint } from './command.ts';
import { fixText } from './fix.ts';
import { duplicateTitles, lintText } from './lint.ts';
import { MarkdownLimitError } from './markdown.ts';
import { CONTENT_LIMIT, LINT_RULES, type LintRule } from './rules.ts';

const cases: Array<[LintRule, string, number]> = [
  ['footnote', 'Text.\n\nA claim.[^1]\n\n[^1]: Source.', 3],
  ['footnote', 'An inline note.^[Text.]', 1],
  ['subscript', 'H~2~O', 1],
  ['table-escaped-pipe', '| A |\n| -- |\n| a \\| b |', 3],
  ['table-hash-cell', '| A | B |\n| -- | -- |\n| 1 | 2 |\n| # | 3 |', 4],
  ['table-hash-cell', 'Intro.\n\n> | Name | No. |\n> | -- | -- |\n> | Example |  # |', 5],
  ['table-hash-cell', '| A |\n| -- |\n| ## |', 3],
  ['table-hash-cell', '| A |\n| -- |\n| # Total **12** |', 3],
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
  ['block-first-in-list-item', '* ## Heading\n* Plain', 1],
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

describe('lint rules', () => {
  it('table-hash-cell spares a header hash, an escaped hash and a hash that is no heading', () => {
    const text = '| # | `#` |\n| -- | -- |\n| \\# | **#** |\n| Issue # | #5 |\n| \\## | ####### |';
    assert.deepEqual(lintText('doc.md', text), []);
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

  it('refuses a table that only a rewrite exposes: fix throws instead of padding it', () => {
    // The image makes the header one cell wider than the delimiter row, so the source has no table; once
    // fix moves the image out of the paragraph, the rest is a 300-column table over 300 one-cell rows.
    const text = `![i](i.png) ${raggedTable(300, 300)}`;
    assert.deepEqual(lintText('doc.md', text), []);
    assert.throws(() => fixText(text), MarkdownLimitError);
  });

  it('keeps padding a ragged table within the limits', () => {
    const text = raggedTable(200, 200);
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.equal(fixed.split('\n').length, 202);
    assert.ok(fixed.split('\n').every((row) => row.split(' | ').length === 200), 'every row has the header width');
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

  it('refuses references that only a rewrite exposes: fix throws instead of expanding them', { timeout: 60_000 }, () => {
    // The definition shares a paragraph with an image, so the source has none and the references are text;
    // once fix moves the image out of the paragraph, the definition applies to all of them.
    const text = `${'[a][r] '.repeat(100)}\n\n![i](i.png) [r]: https://example.com/${'x'.repeat(5_000)}\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    assert.throws(() => fixText(text), MarkdownLimitError);
  });

  it('counts the parentheses fix adds around a shortcut reference', () => {
    // `[r]` is written `[r](<u>)`: 120 KB of source written as about 270 KB.
    const text = `${'[r] '.repeat(30_000)}\n\n[r]: u\n`;
    assert.deepEqual(lintText('doc.md', text).map((f) => f.rule), ['markdown-complexity']);
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
    // 175 KB written as 225 KB: each `[a][r]` becomes `[a](<u>)`.
    const text = `${'[a][r] '.repeat(25_000)}\n\n[r]: u\n`;
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
    const text = `${'[a][r] '.repeat(5_000)}${`[b][${'s'.repeat(25)}] `.repeat(5_000)}\n\n[r]: https://example.com\n[${'s'.repeat(25)}]: u\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    const fixed = fixText(text);
    assert.ok(fixed !== text && fixed.length < CONTENT_LIMIT, 'fix writes them inline within the limit');
  });

  it('counts destinations in code points, as the content limit is counted', () => {
    // 236,000 code points written, though over 400,000 UTF-16 code units.
    const text = `${'[a][r] '.repeat(2_000)}\n\n[r]: https://example.com/${'\u{1F600}'.repeat(90)}\n`;
    assert.deepEqual(lintText('doc.md', text), []);
    assert.notEqual(fixText(text), text);
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
    const source = `${'[a][r] '.repeat(20_000)}\n\n[r]: https://example.com/${'x'.repeat(100_000)}\n`;
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

  it('lint and fix report a table that only a rewrite exposes, and leave the file unchanged', () => {
    const path = join(dir, 'exposed.md');
    const source = `![i](i.png) ${'|a'.repeat(300)}|\n${'|-'.repeat(300)}|\n${'|x|\n'.repeat(300)}`;
    const message = `exposed.md:1: markdown-complexity: ${LINT_RULES['markdown-complexity']}\n`;
    try {
      writeFileSync(path, source);
      writeFileSync(join(dir, 'i.png'), 'png');
      assert.deepEqual(runLint(['exposed.md'], dir), { exitCode: 1, stdout: message, stderr: '' });
      assert.deepEqual(runFix(['exposed.md'], dir), { exitCode: 1, stdout: message, stderr: '' });
      assert.equal(readFileSync(path, 'utf8'), source);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(dir, 'i.png'), { force: true });
    }
  });

  it('lint and fix agree on a hash header without losing cell text', () => {
    const path = join(dir, 'table.md');
    const source = '| # | Customer |\n| -- | -- |\n| 1 | Example |';
    const fixed = '| \\# | Customer |\n| -- | -- |\n| 1 | Example |';
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
