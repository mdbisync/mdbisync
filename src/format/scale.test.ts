// Inputs at the content limit whose cost once grew with the square of their
// size in lint or fix. Each case runs in a child process with a parent
// timeout, and its time is measured against a parse of the same text, so a
// slow machine scales both.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { fixText, relativeFileBlocksAsLinks } from './fix.ts';
import { lintText } from './lint.ts';
import { parse, sameMarkdown } from './markdown.ts';
import { runScaleScript } from '../scale-test-helpers.ts';

const modules = {
  merge: new URL('../merge/merge.ts', import.meta.url),
  rules: new URL('./rules.ts', import.meta.url),
  fix: new URL('./fix.ts', import.meta.url),
  lint: new URL('./lint.ts', import.meta.url),
  markdown: new URL('./markdown.ts', import.meta.url),
};

type Timing = { parseMs: number; ms: number; length: number };

/** Builds the text in the child from `build` (`unit` repeated to the limit), then times `run` on it after a parse. */
function timed(build: string, run: string): Timing {
  return runScaleScript<Timing>(modules, `
    const fill = (unit, tail = '') => unit.repeat(Math.floor((rules.CONTENT_LIMIT - 20 - tail.length) / unit.length)) + tail;
    const text = ${build};
    let start = performance.now();
    markdown.parse(text);
    const parseMs = performance.now() - start;
    start = performance.now();
    ${run};
    console.log(JSON.stringify({ parseMs, ms: performance.now() - start, length: text.length }));
  `, 150_000);
}

function report({ parseMs, ms }: Timing): string {
  return `parse ${Math.round(parseMs)} ms, run ${Math.round(ms)} ms`;
}

describe('image labels', () => {
  // A code span in a label holds a bracket Markdown does not count; the label
  // search counted it, so it never closed and read the rest of the document
  // for every label.
  it('keep the full label when escaping literal brackets inside the image', () => {
    const source = '![a [b] c](x.png)\n';
    const fixed = fixText(source);
    assert.equal(fixed, '![a \\[b\\] c](x.png)');
    assert.ok(sameMarkdown(fixed, source));
    assert.deepEqual(lintText('a.md', '![a [b] c][r]\n\n[r]: x.png\n'), []);
  });

  it('stop at the end of the image when a code span holds a bracket', () => {
    const fixed = fixText('![`[`](x.png)\n\n![b](y.png)\n');
    assert.ok(fixed.includes('![b](y.png)'), fixed);
    assert.ok(!fixed.includes('![b](y.png)](x.png)'), fixed);
  });

  it('lint image references whose labels hold a bracket in code, at the content limit, in about the time of a parse', { timeout: 160_000 }, () => {
    const timing = timed(`fill('![\`[\`][r]\\n\\n', '[r]: x.png\\n')`, `lint.lintText('a.md', text)`);
    assert.ok(timing.ms < 2 * timing.parseMs + 2_000, report(timing));
  });

  it('fix inline images whose labels hold a bracket in code, at the content limit, in a few times a parse', { timeout: 160_000 }, () => {
    const timing = timed(`fill('![\`[\`](x.png)\\n\\n')`, `fix.fixText(text)`);
    assert.ok(timing.ms < 4 * timing.parseMs + 2_000, report(timing));
  });
});

describe('file blocks', () => {
  it('join each file block onto its item line', () => {
    assert.equal(relativeFileBlocksAsLinks('-\n  [a](a.pdf)\n-\n  [b](b.pdf)\n\ntext\n'), '- [a](a.pdf)\n- [b](b.pdf)\n\ntext\n');
  });
});

describe('nested quotes', () => {
  it('keep the space on a blank code line of the quote that holds the code, at every depth', () => {
    const text = '> ```\n> a\n>\n> b\n> ```\n>\n> > ```\n> > c\n> >\n> > d\n> > ```\n';
    const fixed = fixText(text);
    assert.equal(fixed, '> ```\n> a\n> \n> b\n> ```\n>\n> > ```\n> > c\n> > \n> > d\n> > ```');
    assert.ok(sameMarkdown(fixed, text));
  });

  // Every quote level parsed its written content again to find its code lines.
  it('holding a code block at each of 30 levels are fixed at the content limit in a few times a parse', { timeout: 160_000 }, () => {
    const timing = timed(`(() => {
      let head = '';
      for (let depth = 1; depth <= 30; depth++) head += '> '.repeat(depth) + '\`\`\`\\n' + '> '.repeat(depth) + '\`\`\`\\n';
      const line = '> '.repeat(30) + 'x\\n';
      return head + line.repeat(Math.floor((rules.CONTENT_LIMIT - 20 - head.length) / line.length));
    })()`, `fix.fixText(text)`);
    assert.ok(timing.ms < 4 * timing.parseMs + 2_000, report(timing));
  });
});

describe('lazy continuation lines', () => {
  // Lines that continue a paragraph in a quote or list item without its
  // prefix: the parser walked back over the paragraph for each of them.
  it('keep the trees of quotes and list items with lazy lines', () => {
    const texts = [
      '- a\nb\nc\n',
      '> a\nb\n> c\nd\n',
      '1. a\n   b\nc\n\n   d\n',
      '> - a\nb\n\n> 1. c\n>    d\ne\n',
      '> ```\n> a\nb\n',
      '- a\n' + 'b\n'.repeat(2_000),
      '> a\n' + '> b\nc\n'.repeat(1_000),
    ];
    for (const text of texts) {
      assert.deepEqual(parse(text), fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), JSON.stringify(text.slice(0, 40)));
    }
  });

  // The walk stops at the open paragraph, so only its own events count, not
  // the blocks before it in the same quote or item.
  it('in many short paragraphs of one long quote or list item are accepted', () => {
    const fence = '```';
    const texts = [
      '> p\n> q\nlazy\n>\n'.repeat(12_000),
      '1. a\n\n' + '   p\n  lazy\n\n'.repeat(15_000),
      `- intro\n\n  ${fence}\n${'  a\n'.repeat(15_000)}  ${fence}\n\n${'  first\nsecond\n\n'.repeat(700)}`,
      `- intro\n\n  ${fence}\n${'  a\n'.repeat(15_000)}  ${fence}\n\n${'  first\nsecond\n\n'.repeat(321)}  first\nsecond\n`,
    ];
    for (const text of texts) assert.deepEqual(lintText('a.md', text), [], JSON.stringify(text.slice(0, 20)));
  });

  it('up to the content limit are linted, fixed and merged within a bound', { timeout: 70_000 }, () => {
    const result = runScaleScript<{ rules: string[][]; fixed: boolean; merge: string }>(modules, `
      const fill = (head, unit) => head + unit.repeat(Math.floor((rules.CONTENT_LIMIT - 20 - head.length) / unit.length));
      const texts = [fill('- a\\n', 'b\\n'), fill('> a\\n', '    b\\n'), fill('- a\\n', '  b\\nc\\n'), fill('> - > 1. a\\n', 'b\\n')];
      const lints = texts.map((text) => lint.lintText('a.md', text).map(({ rule }) => rule));
      const fixed = texts.every((text) => fix.fixText(text) === text);
      const merged = await merge.mergeMarkdown(texts[0], 'x\\n\\n' + texts[0], texts[0] + '\\ny\\n').then(() => 'merged', (error) => error.message);
      console.log(JSON.stringify({ rules: lints, fixed, merge: merged }));
    `, 60_000);
    assert.deepEqual(result, { rules: Array(4).fill(['markdown-complexity']), fixed: true, merge: 'Markdown exceeds the lazy limit.' });
  });
});
