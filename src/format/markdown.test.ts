import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Nodes, Root } from 'mdast';
import { MarkdownLimitError, MARKDOWN_MAX_DEPTH, MARKDOWN_MAX_NODES, joinFile, parse, sameMarkdown, splitFile, visit } from './markdown.ts';
import { lintText } from './lint.ts';
import { fixText } from './fix.ts';

describe('Markdown traversal limits', () => {
  it('refuses inline runs that take the parser minutes, counting their work as it goes', () => {
    const inline = (error: unknown): boolean => error instanceof MarkdownLimitError && error.limit === 'inline';
    // Each took from 25 seconds to over four minutes in one paragraph; refused, they take seconds at most.
    for (const text of [
      '[a][r] '.repeat(20_000),
      '\\*a] '.repeat(30_000),
      '*a* '.repeat(60_000),
      'a_b c_d '.repeat(30_000),
      '> [a][r] [a][r]\n'.repeat(10_000),
      // An unclosed bracket, then words: each word start walks back to it.
      '[' + 'a '.repeat(124_000),
      // Hard-wrapped lines merged one splice at a time.
      'a b\n'.repeat(62_000),
    ]) {
      const start = performance.now();
      assert.throws(() => parse(text), inline);
      assert.ok(performance.now() - start < 20_000, 'refused within seconds');
    }
    assert.deepEqual(lintText('doc.md', '[a][r] '.repeat(20_000)).map(({rule}) => rule), ['markdown-complexity']);
  });

  it('keeps long documents of ordinary blocks within the inline budget', () => {
    for (const text of [
      ('A paragraph with [a link](https://example.com), *emphasis* and `code`.\n\n').repeat(3_000),
      '- [a][r] [a][r]\n'.repeat(10_000),
      '| a | b |\n| - | - |\n' + '| [a][r] [a][r] | [a][r] [a][r] |\n'.repeat(5_000),
      '```json\n' + '[1, 2] [3] \\* x]\n'.repeat(12_000) + '```\n',
      // One paragraph at the content limit as plain text, a long one of prose over many lines, a long link title.
      'x'.repeat(250_000),
      'What has happened here, who knows *why*\n'.repeat(2_500),
      `[r]: x "${'a&b; '.repeat(30_000)}"`,
    ]) {
      assert.ok(text.length > 50_000, 'the body is long');
      assert.doesNotThrow(() => parse(text));
    }
  });

  it('rejects excessive reachable blockquote nesting before returning a tree', () => {
    assert.throws(() => parse('> '.repeat(130) + 'nesting-canary'), /Markdown.*depth/);
    const accepted = '> '.repeat(MARKDOWN_MAX_DEPTH - 2) + 'canary';
    let deepest = 0;
    visit(parse(accepted), (_, ancestors) => { deepest = Math.max(deepest, ancestors.length); });
    assert.equal(deepest, MARKDOWN_MAX_DEPTH);
    assert.ok(sameMarkdown(accepted, accepted + '\n'));
  });

  it('bounds synthetic tree depth and node count independently', () => {
    let nested: Nodes = {type: 'text', value: 'canary'};
    for (let i = 0; i < MARKDOWN_MAX_DEPTH; i++) nested = {type: 'blockquote', children: [nested]} as Nodes;
    assert.doesNotThrow(() => visit(nested, () => {}));
    assert.throws(() => visit({type: 'root', children: [nested]} as Root, () => {}), (error) => error instanceof MarkdownLimitError && error.limit === 'depth');
    const wide: Root = {type: 'root', children: Array(MARKDOWN_MAX_NODES - 1).fill({type: 'thematicBreak'})};
    let count = 0;
    visit(wide, () => count++);
    assert.equal(count, MARKDOWN_MAX_NODES);
    wide.children.push({type: 'thematicBreak'});
    count = 0;
    assert.throws(() => visit(wide, () => count++), (error) => error instanceof MarkdownLimitError && error.limit === 'nodes');
    assert.equal(count, MARKDOWN_MAX_NODES);
  });

  it('bounds parsed shallow trees and reports limits without echoing content', () => {
    const children = Array(MARKDOWN_MAX_NODES).fill({type: 'thematicBreak'});
    assert.throws(() => parse('x', [{transforms: [() => ({type: 'root', children})]}]), (error) => error instanceof MarkdownLimitError && error.limit === 'nodes');
    // A normal list well within the text-length limit must remain accepted.
    assert.doesNotThrow(() => parse('- a\n'.repeat(17_000)));
    const body = '> '.repeat(130) + 'nesting-canary';
    const findings = lintText('notes.md', body);
    assert.deepEqual(findings.map(({rule}) => rule), ['markdown-complexity']);
    assert.ok(!JSON.stringify(findings).includes('nesting-canary'));
    assert.equal(fixText(body), body);
  });

  it('keeps preorder and ancestor paths across siblings without mutating supplied ancestors', () => {
    const ancestor: Nodes = {type: 'blockquote', children: []};
    const ancestors = [ancestor];
    const seen: string[] = [];
    visit(parse('> a\n\n---\n\nb'), (node, parents) => {
      seen.push([...parents.map((parent) => parent.type), node.type].join('/'));
    }, ancestors);
    assert.deepEqual(seen, [
      'blockquote/root', 'blockquote/root/blockquote', 'blockquote/root/blockquote/paragraph',
      'blockquote/root/blockquote/paragraph/text', 'blockquote/root/thematicBreak',
      'blockquote/root/paragraph', 'blockquote/root/paragraph/text',
    ]);
    assert.deepEqual(ancestors, [ancestor]);
    assert.throws(() => visit(parse('x'), () => { throw new Error('callback'); }, ancestors), /callback/);
    assert.deepEqual(ancestors, [ancestor]);
  });
});

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
