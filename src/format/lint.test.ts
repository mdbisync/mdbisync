// One case per lint rule, with the line it names, and the commands on a
// scratch folder.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { markdownFiles, runFix, runLint } from './command.ts';
import { duplicateTitles, lintText } from './lint.ts';
import { CONTENT_LIMIT, LINT_RULES, type LintRule } from './rules.ts';

const cases: Array<[LintRule, string, number]> = [
  ['footnote', 'Text.\n\nA claim.[^1]\n\n[^1]: Source.', 3],
  ['footnote', 'An inline note.^[Text.]', 1],
  ['subscript', 'H~2~O', 1],
  ['table-escaped-pipe', '| A |\n| -- |\n| a \\| b |', 3],
  ['image-in-link', '[![a](x.png)](https://example.com)', 1],
  ['table-alignment', '| A | B |\n| :-- | --: |\n| 1 | 2 |', 1],
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
  ['block-first-in-list-item', '* ## Heading\n* Plain', 1],
];

describe('lint rules', () => {
  for (const [rule, text, line] of cases) {
    it(`${rule}: ${JSON.stringify(text).slice(0, 40)}`, () => {
      const findings = lintText('doc.md', text);
      assert.ok(findings.some((f) => f.rule === rule && f.line === line && f.file === 'doc.md'), JSON.stringify(findings));
      assert.equal(findings.find((f) => f.rule === rule)?.message, LINT_RULES[rule]);
    });
  }

  it('counts front matter lines', () => {
    const findings = lintText('doc.md', '---\ntitle: x\n---\n\nH~2~O');
    assert.deepEqual(findings.map((f) => [f.rule, f.line]), [['subscript', 5]]);
  });

  it('refuses content over the limit, counted in code points', () => {
    assert.equal(lintText('doc.md', '\u{1F600}'.repeat(CONTENT_LIMIT)).length, 0, 'emoji count once');
    assert.deepEqual(lintText('doc.md', 'a'.repeat(CONTENT_LIMIT + 1)).map((f) => f.rule), ['content-too-long']);
  });

  it('passes what Linear keeps', () => {
    for (const text of [
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
