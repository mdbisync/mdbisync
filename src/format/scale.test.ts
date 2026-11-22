// Inputs at the content limit whose cost once grew with the square of their
// size in lint or fix. Each case runs in a child process with a parent
// timeout, and its time is measured against a parse of the same text, so a
// slow machine scales both.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixText, relativeFileBlocksAsLinks } from './fix.ts';
import { lintText } from './lint.ts';
import { sameMarkdown } from './markdown.ts';
import { runScaleScript } from '../scale-test-helpers.ts';

const modules = {
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
  it('take the label as written when it closes inside the image', () => {
    assert.equal(fixText('![a [b] c](x.png)\n'), '![a [b] c](x.png)');
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
