import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sameMarkdown } from './markdown.ts';

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
  });

  it('compares a destination holding a lone surrogate without throwing', () => {
    assert.ok(!sameMarkdown('[a](x\uD800)', '[a](y\uD800)'));
    assert.ok(sameMarkdown('[a](x\uD800)', '[a](<x\uD800>)'));
  });
});
