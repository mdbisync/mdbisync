import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { joinFile, sameMarkdown, splitFile } from './markdown.ts';

describe('sameMarkdown', () => {
  it("takes Linear's spellings of the same document as the same", () => {
    assert.ok(sameMarkdown('# Notes\n\nText.', '# Notes\n\nText.\n'));
    assert.ok(sameMarkdown('| Day | Change |\n| -- | -- |\n| Monday | -6 |', '| Day | Change |\n| -- | -- |\n| Monday | \\-6 |\n'));
    assert.ok(sameMarkdown('-6 degrees', '\\-6 degrees'));
    assert.ok(sameMarkdown('An _aside_.', 'An *aside*.'));
    assert.ok(sameMarkdown('![Chart](<../media/chart copy.png>)', '![Chart](../media/chart%20copy.png)'));
    assert.ok(sameMarkdown('[Site](<https://example.com/a>)', '[Site](https://example.com/a)'));
    assert.ok(sameMarkdown('![x](<a[1].png>)', '![x](a%5B1%5D.png)'));
    assert.ok(sameMarkdown('+++ Details\n\nInside.', '+++ Details\n\nInside.\n'));
    // An empty heading at the very end, with or without a final newline.
    assert.ok(sameMarkdown('# Test\n\nThis is test change\n\n# ', '# Test\n\nThis is test change\n\n#\n'));
  });

  it('tells a changed document apart', () => {
    assert.ok(!sameMarkdown('| Day | Change |\n| -- | -- |\n| Monday | -6 |', '| Day | Change |\n| -- | -- |\n| Monday | -7 |'));
    assert.ok(!sameMarkdown('* -6', '-6'));
    assert.ok(!sameMarkdown('Text.', 'Text.\n\nMore.'));
    assert.ok(!sameMarkdown('[a](b.md)', '[a](c.md)'));
    assert.ok(!sameMarkdown('![Chart](a%2Fb.png)', '![Chart](a/b.png)'));
    assert.ok(!sameMarkdown('# Test', '# Test\n\n# '));
    assert.ok(!sameMarkdown('![x](a%zz)', '![x](a%25zz)'));
    // `+++` opens a collapsible section in Linear; escaped, it is text.
    assert.ok(!sameMarkdown('\\+++ Details', '+++ Details'));
    assert.ok(!sameMarkdown('> \\+++ Details', '> +++ Details'));
    // `$$` lines are math in Linear; escaped, they are text.
    assert.ok(!sameMarkdown('\\$$\nx^2\n\\$$', '$$\nx^2\n$$'));
    // A list item that opens with a line break is a file block in Linear.
    assert.ok(!sameMarkdown('* \n  [Summary](a.pdf)', '* [Summary](a.pdf)'));
    assert.ok(!sameMarkdown('- [ ] \n  [Demo](demo.mp4)', '- [ ] [Demo](demo.mp4)'));
    assert.ok(!sameMarkdown('- [X] \n  [Demo](demo.mp4)', '- [X] [Demo](demo.mp4)'));
    assert.ok(!sameMarkdown('1. \n   [Demo](demo.mp4)', '1. [Demo](demo.mp4)'));
    assert.ok(sameMarkdown('* \n  [Summary](a.pdf)', '* \n  [Summary](a.pdf)\n'));
  });

  it('compares a destination holding a lone surrogate without throwing', () => {
    assert.ok(!sameMarkdown('[a](x\uD800)', '[a](y\uD800)'));
    assert.ok(sameMarkdown('[a](x\uD800)', '[a](<x\uD800>)'));
  });
});

describe('joinFile', () => {
  // Linear spells every thematic break `---`, so a body can start with a block that reads as front matter.
  const blockFirst = '---\nlinear-team: Other\n---\n\nText.\n';

  it('keeps a body that opens with a front matter block as the body', () => {
    for (const head of ['', '\uFEFF']) {
      const text = joinFile(head, blockFirst);
      assert.equal(splitFile(text).head, head);
      assert.ok(sameMarkdown(splitFile(text).body, blockFirst));
      assert.ok(!text.replace(/^\uFEFF/, '').startsWith('---'));
    }
    // A byte order mark at the start of the body would hide the block from a check of the body alone.
    const text = joinFile('', `\uFEFF${blockFirst}`);
    assert.equal(splitFile(text).head, '\uFEFF');
    assert.ok(sameMarkdown(splitFile(text).body, blockFirst));
  });

  it('keeps a rule with trailing spaces and an empty block as the body', () => {
    for (const body of ['---  \nA.\n---\n', '---\n---\n', '---\r\nA.\r\n---\r\nB.']) {
      const text = joinFile('', body);
      assert.equal(splitFile(text).head, '');
      assert.ok(sameMarkdown(splitFile(text).body, body), body);
    }
  });

  it('writes other bodies as they are', () => {
    assert.equal(joinFile('', 'Text.\n\n---\n\nMore.\n---\n'), 'Text.\n\n---\n\nMore.\n---\n');
    assert.equal(joinFile('', '---\nNo closing rule.\n'), '---\nNo closing rule.\n');
    assert.equal(joinFile('---\nowner: ops\n---\n\n', blockFirst), `---\nowner: ops\n---\n\n${blockFirst}`);
  });

  it('starts the body on a new line after a front matter block that ends the file, in its line ending', () => {
    const text = joinFile('---\nowner: ops\n---', 'Text.');
    assert.deepEqual(splitFile(text), {head: '---\nowner: ops\n---\n', body: 'Text.'});
    assert.equal(joinFile('---\nowner: ops\n---', ''), '---\nowner: ops\n---');
    assert.equal(joinFile('---\r\nowner: ops\r\n---', 'Text.'), '---\r\nowner: ops\r\n---\r\nText.');
  });

  it('gives back any file it was split from', () => {
    for (const text of ['', 'Text.', '\uFEFF', '\uFEFF\uFEFF---\nA.\n---\n', '---\nowner: ops\n---', '---\nowner: ops\n---\n\n---\nA.\n---\n', '\uFEFF---\r\nowner: ops\r\n---\r\n\r\nText.']) {
      const {head, body} = splitFile(text);
      assert.equal(joinFile(head, body), text, JSON.stringify(text));
    }
  });
});
