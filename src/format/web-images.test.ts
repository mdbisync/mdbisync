// `fix` writes an image from an HTTP(S) URL as a link to it, with a warning;
// other images outside the repository stay lint findings.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runFix, runLint } from './command.ts';

function inFolder(text: string, check: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'web-images-'));
  try {
    writeFileSync(join(dir, 'notes.md'), text);
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const warning = (line: number) => `notes.md:${line}: warning: image-made-link: `;

describe('fix and web images', () => {
  for (const [form, text, expected, line] of [
    ['inline', 'Intro.\n\n![Chart](https://example.com/chart.png)\n', 'Intro.\n\n[Chart](<https://example.com/chart.png>)', 3],
    ['empty alt', '![](http://example.com/a.png)\n', '[http://example.com/a.png](<http://example.com/a.png>)', 1],
    ['reference', 'See ![Chart][c].\n\n[c]: https://example.com/c.png\n', 'See [Chart](<https://example.com/c.png>).', 1],
    ['inside a link', '[![Build](https://example.com/badge.svg)](https://example.com/build)\n', '[Build](<https://example.com/build>)', 1],
    ['table cell', '| A |\n| -- |\n| ![Cell](https://example.com/x.png) |\n', '| A |\n| -- |\n| [Cell](<https://example.com/x.png>) |\n', 3],
    ['after front matter', '---\ntitle: Plan\n---\n\n![Chart](https://example.com/chart.png)\n', '---\ntitle: Plan\n---\n\n[Chart](<https://example.com/chart.png>)', 5],
  ] as const) {
    it(`writes a ${form} image as a link, warns, and then passes lint`, () => inFolder(text, (dir) => {
      const fixed = runFix(['notes.md'], dir);
      assert.equal(fixed.exitCode, 1);
      assert.equal(fixed.stdout.split('\n')[0], 'notes.md: fixed');
      assert.ok(fixed.stdout.includes(warning(line)), fixed.stdout);
      assert.match(fixed.stdout, /add the file to the repository and link it by its relative path/);
      assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), expected);
      const again = runFix(['notes.md'], dir);
      assert.deepEqual([again.exitCode, again.stdout], [0, '']);
      assert.deepEqual([runLint(['notes.md'], dir).exitCode, runLint(['notes.md'], dir).stdout], [0, '']);
    }));
  }

  for (const [form, text, rule] of [
    ['data', '![Dot](data:image/png;base64,iVBORw0KGgo=)\n', 'image-not-in-repository'],
    ['absolute path', '![Logo](/images/logo.png)\n', 'image-not-in-repository'],
    ['protocol-relative', '![Logo](//example.com/logo.png)\n', 'image-not-in-repository'],
    ['outside the repository', '![Outside](../logo.png)\n', 'image-not-in-repository'],
    ['missing file', '![Gone](gone.png)\n', 'image-file-missing'],
  ] as const) {
    it(`leaves a ${form} image and its file to the author`, () => inFolder(text, (dir) => {
      const fixed = runFix(['notes.md'], dir);
      assert.equal(fixed.exitCode, 1);
      assert.match(fixed.stdout, new RegExp(`^notes\\.md:1: ${rule}: `));
      assert.doesNotMatch(fixed.stdout, /image-made-link/);
      assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), text);
    }));
  }

  it('leaves a web image in a file with another finding, as written', () => inFolder('![Web](https://example.com/w.png)\n\n![Dot](data:image/png;base64,iVBORw0KGgo=)\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.equal(fixed.stdout, runLint(['notes.md'], dir).stdout);
    assert.match(fixed.stdout, /^notes\.md:1: image-not-in-repository: .*\nnotes\.md:3: image-not-in-repository: /);
  }));

  it('leaves a table cell image whose alt text holds a pipe: its link label would not survive Linear', () => inFolder('| A |\n| -- |\n| ![x\\|y](https://example.com/x.png) |\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.match(fixed.stdout, /^notes\.md:3: image-not-in-repository: .*\nnotes\.md:3: table-escaped-pipe: /);
    assert.doesNotMatch(fixed.stdout, /fixed|image-made-link/);
  }));

  it('leaves a file whose rest fix cannot write in Linear\'s form, images and all', () => inFolder('Title\\\nmore\n===\n\n![A](https://example.com/a.png)\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.doesNotMatch(fixed.stdout, /fixed|image-made-link/);
    assert.match(fixed.stdout, /notes\.md:5: image-not-in-repository: /);
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), 'Title\\\nmore\n===\n\n![A](https://example.com/a.png)\n');
  }));

  it('leaves a titled web image to image-title', () => inFolder('![Build](https://example.com/badge.svg "Release status")\n', (dir) => {
    const fixed = runFix(['notes.md'], dir);
    assert.match(fixed.stdout, /^notes\.md:1: image-title: /m);
    assert.match(fixed.stdout, /^notes\.md:1: image-not-in-repository: /m);
    assert.doesNotMatch(fixed.stdout, /fixed|image-made-link/);
  }));

  it('writes a linked web image as the text of its link, and a file without web images as before', () => inFolder('[![Build](https://example.com/badge.svg)](https://example.com/build)\n', (dir) => {
    writeFileSync(join(dir, 'other.md'), '*one*\n');
    const fixed = runFix(['.'], dir);
    assert.match(fixed.stdout, /^notes\.md: fixed\nother\.md: fixed\nnotes\.md:1: warning: image-made-link: .*or as the text of the link around it/);
    assert.equal(readFileSync(join(dir, 'other.md'), 'utf8'), '*one*');
  }));
});
