import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { Nodes, Paragraph, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { EditMap } from 'micromark-util-edit-map';
import { MarkdownLimitError, MARKDOWN_MAX_DEPTH, MARKDOWN_MAX_NODES, bracketedLabel, codeSpans, decodedDestinationPath, joinFile, linearMarkersAsText, linkDestination, nestedFileBlocksOnItemLine, parse, sameAsLinear, sameMarkdown, splitFile, visit } from './markdown.ts';
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

// `markdown.ts` counts the parser's walk over lazy lines through its document
// and flow tokenizers, which a new parser version may change.
describe('the parser for the lazy-line budget', () => {
  it('is the version the budget was written for', () => {
    const fromMarkdown = createRequire(import.meta.url).resolve('mdast-util-from-markdown');
    const micromark = createRequire(fromMarkdown).resolve('micromark');
    const installed = JSON.parse(readFileSync(join(dirname(micromark), 'package.json'), 'utf8')).version;
    // A new version needs `lazyBudget` in markdown.ts reviewed against `writeToChild` in its `lib/initialize/document.js`.
    assert.equal(installed, '4.0.3');
  });
});

// `markdown.ts` replaces the parser's `EditMap.consume` so that closing a
// container costs only the events after it. The replacement must reach the
// copy the parser uses and must do exactly what the original does.
describe('the parser edit map', () => {
  it('is the pinned version, the one copy that the parser imports', () => {
    const require = createRequire(import.meta.url);
    const ours = require.resolve('micromark-util-edit-map');
    for (const parser of ['micromark', 'micromark-core-commonmark']) {
      assert.equal(createRequire(require.resolve(parser)).resolve('micromark-util-edit-map'), ours, parser);
    }
    const pinned = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).dependencies['micromark-util-edit-map'];
    const installed = JSON.parse(readFileSync(join(dirname(ours), 'package.json'), 'utf8')).version;
    // A new version needs the replacement in markdown.ts reviewed against its `consume`.
    assert.deepEqual([pinned, installed], ['1.0.0', '1.0.0']);
  });

  it('applies edits exactly as the original consume', async () => {
    // A second instance of the module, loaded under another URL, keeps the original.
    const { EditMap: Original } = await import(`${import.meta.resolve('micromark-util-edit-map')}?original`) as { EditMap: typeof EditMap };
    assert.notEqual(Original.prototype.consume, EditMap.prototype.consume);
    let seed = 1;
    const random = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n;
    for (let round = 0; round < 2_000; round++) {
      const length = random(40);
      // Edits that do not overlap, some at the end and some sharing an index, added out of order.
      const edits: [number, number, string[], boolean][] = [];
      for (let at = random(4); at <= length; at += 1 + random(5)) {
        const remove = random(Math.min(3, length - at) + 1);
        edits.push([at, remove, Array.from({ length: random(3) }, (_, i) => `${at}.${i}`), random(2) === 0]);
        if (random(4) === 0) edits.push([at, 0, [`${at}.again`], random(2) === 0]);
        at += remove;
      }
      edits.sort(() => random(3) - 1);
      const apply = (map: EditMap) => {
        for (const [at, remove, add, before] of edits) (before ? map.addBefore : map.add).call(map, at, remove, add.map((event) => [event]) as never);
        const events = Array.from({ length }, (_, i) => [i]) as never[];
        map.consume(events);
        return events;
      };
      assert.deepEqual(apply(new EditMap()), apply(new Original()), `round ${round}`);
    }
  });
});

describe('the bare-URL search inside text', () => {
  const withoutPositions = (tree: Root): unknown => JSON.parse(JSON.stringify(tree, (key, value: unknown) => (key === 'position' ? undefined : value)));
  const upstream = (text: string): Root => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const unplaced = (tree: Root): Nodes[] => {
    const found: Nodes[] = [];
    visit(tree, (node) => {
      if (node.position === undefined) found.push(node);
    });
    return found;
  };

  it('is the one tree transform of GFM, the one parse runs per text node', () => {
    const transforms = gfmFromMarkdown().flatMap((extension) => extension.transforms ?? []);
    assert.equal(transforms.length, 1);
    const tree = upstream('"www.example.com"');
    assert.equal((tree.children[0] as Paragraph).children[1]?.type, 'link');
  });

  it('gives the tree GFM gives, with a source position on every node it can place', () => {
    const texts = [
      'See "www.example.com" now.',
      'Host:www.example.com and [https://example.com] and "team@example.com".',
      '> Quote "www.example.com/a_b".\n> *Next* "https://example.com/x." line',
      '- a "www.example.com", "www.example.com" www.example.com\n  b (www.example.com).',
      '| a | b |\n| - | - |\n| "www.example.com" | x |',
      '# Notes on "www.example.com"\n\n**"www.example.com"** ~~"www.example.com"~~ *"www.example.com/*x*"*',
      'Skip xwww.example.com, then "www.example.com". Mail "a&#46;b@example.com".',
      '[a "www.example.com"](https://example.com) [b][r]\n\n[r]: https://example.com',
      '\uFEFFSee "www.example.com" now.\n\n\uFEFF"www.example.com"',
    ];
    const fixtures = new URL('../../test/fixtures/', import.meta.url);
    for (const file of readdirSync(fixtures, { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('.md')) texts.push(readFileSync(new URL(file, fixtures), 'utf8'));
    }
    for (const text of texts) {
      const tree = parse(text);
      assert.deepEqual(withoutPositions(tree), withoutPositions(upstream(text)), JSON.stringify(text.slice(0, 80)));
      assert.deepEqual(unplaced(tree), [], JSON.stringify(text.slice(0, 80)));
    }
  });

  it('places each link at the text it comes from', () => {
    const text = 'Skip xwww.example.com, then\n> "www.example.com" and (www.example.com/a).';
    const links: string[] = [];
    visit(parse(text), (node) => {
      if (node.type === 'link') links.push(`${text.slice(node.position!.start.offset, node.position!.end.offset)}@${node.position!.start.line}:${node.position!.start.column}`);
    });
    assert.deepEqual(links, ['www.example.com@2:4', 'www.example.com/a@2:26']);
    // A line ends at CR LF, CR or LF, as the parser counts lines.
    const lines = (body: string): number[] => {
      const found: number[] = [];
      visit(parse(body), (node) => {
        if (node.type === 'link') found.push(node.position!.start.line);
      });
      return found;
    };
    assert.deepEqual(lines('First\rThen <https://example.com> and "www.example.com"'), [2, 2]);
    assert.deepEqual(lines('First\r\nThen\r\n"www.example.com"'), [3]);
    // The parser counts offsets after a leading BOM.
    const [link] = (parse('\uFEFF"www.example.com"').children[0] as Paragraph).children.filter((node) => node.type === 'link');
    assert.deepEqual([link?.position?.start.offset, link?.position?.start.column], [1, 2]);
  });

  it('leaves a link without a position when the source spells its text differently', () => {
    for (const text of ['See "www.example.com/a\\_b" now.', 'See "www.example.com/a&amp;b" now.', 'Mail "\\+first@example.com".', 'See "www.example.com/&amp;amp".']) {
      const tree = parse(text);
      assert.deepEqual(withoutPositions(tree), withoutPositions(upstream(text)));
      assert.deepEqual(unplaced(tree).map((node) => node.type), ['text', 'link', 'text', 'text'], text);
    }
  });

  it('places many links in one text in time that grows with the text', () => {
    const text = '"www.example.com" '.repeat(13_000);
    const started = performance.now();
    const tree = parse(text);
    assert.ok(performance.now() - started < 10_000, `took ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(unplaced(tree), []);
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

  it("takes Linear's nested file block right after the parent's text as the item on one line", () => {
    // Markdown reads Linear's form as the parent's text; Linear holds a nested item with the file.
    assert.ok(sameMarkdown('* Parent\n  * [Report](<report.csv>)', '* Parent\n  * \n    [Report](report.csv)'));
    assert.ok(sameMarkdown('* Parent\n  1. [Report](<report.csv>)', '* Parent\n  1. \n     [Report](report.csv)\n'));
    assert.ok(sameMarkdown('* Parent\n  * [Report](<report.csv>)\n  * Next', '* Parent\n  * \n    [Report](report.csv)\n  * Next'));
    assert.ok(sameMarkdown('1. Parent\n   * [A](<a.pdf>)\n2. Other\n   * [B](<b.pdf>)', '1. Parent\n   * \n     [A](a.pdf)\n2. Other\n   * \n     [B](b.pdf)'));
    // The link at the parent's indent, or other text after the marker, stays the parent's text.
    assert.ok(!sameMarkdown('* Parent\n  * [Report](<report.csv>)', '* Parent\n  * \n  [Report](report.csv)'));
    assert.ok(!sameMarkdown('* Parent\n  * Report', '* Parent\n  * \n    Report'));
    assert.ok(!sameMarkdown('* Parent\n  * [Report](<report.csv>) here', '* Parent\n  * \n    [Report](report.csv) here'));
    // A second file block is an item of the list the first one starts.
    assert.ok(sameMarkdown('* Parent\n  * [A](<a.csv>)\n  * \n    [B](b.csv)', '* Parent\n  * \n    [A](a.csv)\n  * \n    [B](b.csv)'));
    // A destination with parentheses, in a quote, and with CRLF line breaks.
    assert.ok(sameMarkdown('* Parent\n  * [A](<a%20(final).pdf>)', '* Parent\n  * \n    [A](<a%20(final).pdf>)'));
    assert.ok(sameMarkdown('> * Parent\n>   * [A](<a.csv>)', '> * Parent\n>   * \n>     [A](a.csv)'));
    assert.ok(sameMarkdown('* Parent\n  * [A](<a.csv>)', '* Parent\r\n  * \r\n    [A](a.csv)\r\n'));
    // Text inside a code span, and a line with more than the link, stay text.
    assert.ok(!sameMarkdown('* Parent `x\n  *\n    [A](a.csv) y`', '* Parent `x\n  * [A](a.csv) y`'));
    assert.ok(!sameMarkdown('* Parent\n  * [A](<a.csv>) and [B](<b.csv>)', '* Parent\n  * \n    [A](a.csv) and [B](b.csv)'));
    // A file block Markdown already reads as an item stays a file block.
    assert.ok(!sameMarkdown('* Parent\n\n  * \n    [Report](report.csv)', '* Parent\n\n  * [Report](report.csv)'));
  });

  it('joins a nested file block under any quote prefix and keeps the marker line apart otherwise', () => {
    // Quote markers with and without a space after them, indented up to three spaces.
    assert.equal(nestedFileBlocksOnItemLine('> > * Parent\n> >   * \t\n> >     [A](a.csv)'), '> > * Parent\n> >   * [A](a.csv)');
    assert.equal(nestedFileBlocksOnItemLine('>> * Parent\n>>   *\n>>     [A](a.csv)'), '>> * Parent\n>>   * [A](a.csv)');
    assert.equal(nestedFileBlocksOnItemLine('>    > * Parent\n>    >   *\n>    >     [A](a.csv)'), '>    > * Parent\n>    >   * [A](a.csv)');
    // Four spaces before a `>` make it text, not a quote marker.
    const indented = '> * Parent\n>   *\n>     > [A](a.csv)';
    assert.equal(nestedFileBlocksOnItemLine(indented), indented);
    // A line of quote markers with no marker or link after it.
    for (const body of ['a\n> > > x', 'a\n> > > -\n> > > x', 'a\n> > > -\n> > >[x']) assert.equal(nestedFileBlocksOnItemLine(body), body);
  });

  // Each `> ` is a quote marker whose space a regular expression could also
  // give to the next marker's indent: a line of many of them that did not
  // match tried every split, about 2^k for k markers, so 40 took hours. A
  // child process runs the check, so the parent's timeout stops a stall that
  // a test timeout could not interrupt. The comparison and `fix` run on the
  // short bodies too; the bounds are loose, as a stall takes far longer.
  it('stays fast on lines of many quote markers', { timeout: 120_000 }, () => {
    // Each body's text after the check: null when the check leaves it as it is.
    const expected = {
      noMarker: null,
      markerWithoutLink: null,
      markerThenBracket: null,
      joinAfterTrailingBlanks: '> * Parent\n>   * [A](a.csv)',
      document: null,
    };
    // The child builds the bodies: a document of the content limit is longer than one command line argument may be.
    const script = `
      import { CONTENT_LIMIT } from ${JSON.stringify(new URL('./rules.ts', import.meta.url).href)};
      import { MarkdownLimitError, nestedFileBlocksOnItemLine, sameMarkdown } from ${JSON.stringify(new URL('./markdown.ts', import.meta.url).href)};
      import { fixText } from ${JSON.stringify(new URL('./fix.ts', import.meta.url).href)};
      const units = '> '.repeat(128);
      // Below the parser's depth limit, so the check goes on to parse the body.
      const shallow = '> '.repeat(100);
      const bodies = {
        noMarker: 'a\\n' + units + 'x',
        markerWithoutLink: 'a\\n' + units + '-\\n' + units + 'x',
        markerThenBracket: 'a\\n' + shallow + '-' + ' '.repeat(10_000) + '\\n' + shallow + ' [x',
        // Tabs: two trailing spaces would make a hard line break.
        joinAfterTrailingBlanks: '> * Parent\\n>   *' + '\\t'.repeat(100_000) + '\\n>     [A](a.csv)',
        document: ('a\\n' + units + 'x\\n').repeat(Math.floor(CONTENT_LIMIT / (units.length + 4))),
      };
      const timed = (run) => {
        const start = performance.now();
        try {
          run();
        } catch (error) {
          if (!(error instanceof MarkdownLimitError)) throw error;
        }
        return performance.now() - start;
      };
      const result = {};
      for (const [name, body] of Object.entries(bodies)) {
        let text;
        const times = { check: timed(() => { text = nestedFileBlocksOnItemLine(body); }) };
        if (name !== 'document') {
          times.compare = timed(() => sameMarkdown(body, body + '\\n'));
          times.fix = timed(() => fixText(body));
        }
        result[name] = { text: text === body ? null : text, times };
      }
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 100_000 });
    assert.equal(child.signal, null, 'the check did not finish within the parent timeout');
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as Record<string, { text: string | null; times: Record<string, number> }>;
    assert.deepEqual(Object.fromEntries(Object.entries(result).map(([name, { text }]) => [name, text])), expected);
    for (const [name, { times }] of Object.entries(result)) {
      for (const [step, ms] of Object.entries(times)) assert.ok(ms < 10_000, `${name} ${step}: ${Math.round(ms)} ms`);
    }
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

describe('linearMarkersAsText', () => {
  it('puts back the escape Linear drops from text that starts like a `)` number or a `+` bullet', () => {
    const cases: Array<[string, string]> = [
      ['1. 4) pear', '1. 4\\) pear'],
      ['1. +', '1. \\+'],
      ['* 1) fig\n* +', '* 1\\) fig\n* \\+'],
      ['4) pear\n\n+\n\n1) fig', '4\\) pear\n\n\\+\n\n1\\) fig'],
      ['> 4) pear\n\n> +', '> 4\\) pear\n\n> \\+'],
      ['Note\n\n1. 4) pear\n2. Next\n\n   4) pear', 'Note\n\n1. 4\\) pear\n2. Next\n\n   4\\) pear'],
      // Only the outer marker: the text after it is no list.
      ['1. 4) + pear', '1. 4\\) + pear'],
    ];
    for (const [linear, file] of cases) {
      assert.equal(linearMarkersAsText(linear), file, JSON.stringify(linear));
      assert.ok(sameAsLinear(linear, file), JSON.stringify(linear));
      assert.ok(!sameMarkdown(linear, file), `read alone, ${JSON.stringify(linear)} is another document`);
      assert.equal(fixText(file), file, `fix keeps ${JSON.stringify(file)}`);
    }
  });

  it('keeps block starts that Linear exports as paragraph text', () => {
    const cases: Array<[string, string]> = [
      ['<div> Shelf', '\\<div> Shelf'],
      ['<<<<<<< draft', '\\<<<<<<< draft'],
      ['Notes\n<<<<<<< draft', 'Notes\n\\<<<<<<< draft'],
      ['$$\na + b\n$$', '\\$$\na + b\n$$'],
      ['+++ Supplies', '\\+++ Supplies'],
      ['+++\tSupplies', '\\+++\tSupplies'],
      ['+++ Supplies\n\n```\n+++\n```', '\\+++ Supplies\n\n```\n+++\n```'],
      ['+++ Supplies\nPaper\n+++', '\\+++ Supplies\nPaper\n\\+++'],
      ['| Color | Size |\n| -- | -- |\n| Blue | Large |', '| Color | Size |\n\\| -- | -- |\n| Blue | Large |'],
      ['> | Color | Size |\n> | --- | --- |\n> | Blue | Large |', '> | Color | Size |\n> \\| --- | --- |\n> | Blue | Large |'],
    ];
    for (const [linear, file] of cases) {
      assert.equal(linearMarkersAsText(linear), file);
      assert.ok(sameAsLinear(linear, file), JSON.stringify(linear));
      assert.equal(fixText(file), file);
    }
    assert.ok(sameAsLinear('+++ Supplies\nPaper\n\n+++', '\\+++ Supplies\nPaper\n+++'));
    assert.ok(sameAsLinear('$$\na + b\n$$', '\\$$\na + b\n\\$$'));
    assert.ok(sameAsLinear('Intro\n\n<div> Shelf', 'Intro\r\r\\<div> Shelf'));
    assert.equal(linearMarkersAsText('Intro\r\r<div> Shelf'), 'Intro\r\r\\<div> Shelf');
  });

  it('uses the accepted spelling for an ambiguous export', () => {
    const rows = '| Color | Size |\n| -- | -- |\n| Blue | Large |';
    const section = '+++ Supplies\n\nPaper\n\n+++';
    const linear = `${rows}\n\n${section}`;
    const literal = linear.replace('\n| --', '\n\\| --').replaceAll('+++', '\\+++');
    assert.equal(linearMarkersAsText(linear), linear);
    assert.equal(linearMarkersAsText(linear, literal), literal);
    assert.ok(sameAsLinear(linear, literal));
    assert.ok(!sameAsLinear(linear.replace('Large', 'Small'), literal));
    assert.equal(linearMarkersAsText(section, '\\+++ Supplies\nPaper\n\\+++'), section);
    assert.ok(sameAsLinear('<p> Shelf\n<p> Tray', '\\<p> Shelf\n\\<p> Tray'));
    assert.ok(sameAsLinear('* <p> Shelf', '* \\<p> Shelf'));
  });

  it('keeps genuine blocks alongside examples with the same opening lines', () => {
    const literal = [
      '\\<div> Shelf\nSome notes',
      '| Color | Size |\n\\| -- | -- |\n| Blue | Large |\n| Red | Large |',
      '\\+++ Supplies\n\nPaper\n\n\\+++',
    ].join('\n\n');
    const blocks = [
      '<div> Shelf\n</div>',
      '| Color | Size |\n| -- | -- |\n| Blue | Large |\n| Green | Small |',
      '+++ Purchase\n\nLabels\n\n+++',
    ].join('\n\n');
    const linear = `${literal.replaceAll('\\', '')}\n\n${blocks}`;
    const file = `${literal}\n\n${blocks}`;
    assert.equal(linearMarkersAsText(linear, file), file);
    assert.ok(sameAsLinear(linear, file));
  });

  it('keeps Linear\'s own lists, code and other text as they are', () => {
    for (const text of [
      '* pear\n* fig',
      '- [ ] pear\n- [X] fig',
      '1. pear\n2. fig',
      '1. \n   3. plum',
      '- [ ] 4) pear',
      '+++ Details\n\nHidden.\n\n+++',
      '```\n+ pear\n4) fig\n```',
      '    + pear',
      'Pears + figs, 4) and more.',
      '1. 4\\) pear\n2. \\+',
      '+pear and 4)pear',
    ]) assert.equal(linearMarkersAsText(text), text, JSON.stringify(text));
  });

  it('takes a text as the same as itself, and tells a changed document apart', () => {
    // The initial import compares Linear's content with itself.
    assert.ok(sameAsLinear('1. 4) pear\n2. +', '1. 4) pear\n2. +'));
    assert.ok(!sameAsLinear('1. 4) pear', '1. 4\\) plum'));
    assert.ok(!sameAsLinear('4) pear', '4. pear'));
    assert.ok(!sameAsLinear('+ pear', '* pear'));
    assert.ok(!sameAsLinear('1. +', '1. \\-'));
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

describe('codeSpans and bracketedLabel', () => {
  const spans = (text: string): string[] => codeSpans(text, 0, text.length).map(([from, to]) => text.slice(from, to));

  it('finds a run of backticks up to the next run of the same length', () => {
    assert.deepEqual(spans('a `b` c ``d`e`` f'), ['`b`', '``d`e``']);
    assert.deepEqual(spans('a ``b` c` d'), ['` c`']);
    assert.deepEqual(spans('a \\`b` c`'), ['` c`']);
    assert.deepEqual(spans('`a\\` b'), ['`a\\`']);
    assert.deepEqual(spans('``a ` b'), []);
  });

  it('leaves the backticks of an autolink or inline HTML that starts first', () => {
    assert.deepEqual(spans('<https://a/`> b `c`'), ['`c`']);
    assert.deepEqual(spans('<a@b.c> `d`'), ['`d`']);
    assert.deepEqual(spans('<b title="`"> `c`'), ['`c`']);
    assert.deepEqual(spans('</b> <!-- ` --> <? ` ?> <!X `> <![CDATA[ ` ]]> `c`'), ['`c`']);
    assert.deepEqual(spans('<!--> `c` <!---> `d`'), ['`c`', '`d`']);
    // A code span that starts first holds the `<`.
    assert.deepEqual(spans('`a <https://b/` c`>'), ['`a <https://b/`']);
    // A `<` that opens nothing, or an HTML comment that does not close in the range, is text.
    assert.deepEqual(spans('a < `b` <!-- `c`'), ['`b`', '`c`']);
  });

  it('reads many unclosed HTML openings in about the time of their length', { timeout: 60_000 }, () => {
    const text = '<!-- <? <!X <![CDATA[ <a b="'.repeat(20_000) + '`c`';
    const started = performance.now();
    assert.deepEqual(codeSpans(text, 0, text.length), [[text.length - 3, text.length]]);
    assert.ok(performance.now() - started < 3_000, `${performance.now() - started} ms`);
  });

  it('does not count a bracket in a code span of a label', () => {
    assert.equal(bracketedLabel('![a `]` b](x.png)', 1, 17), 'a `]` b');
    assert.equal(bracketedLabel('[a `[` b]', 0, 9), 'a `[` b');
    assert.equal(bracketedLabel('[a ` b] c`', 0, 7), 'a ` b');
    // A backtick in an autolink and one in the destination open no code span.
    assert.equal(bracketedLabel('![a <urn:a`>](x`.png)', 1, 21), 'a <urn:a`>');
    assert.equal(bracketedLabel('![a <span title="`">](x.png "t`")', 1, 33), 'a <span title="`">');
    assert.equal(bracketedLabel('![<https://a/`>](x`](y).png)', 1, 28), '<https://a/`>');
  });

  // Each label is searched up to its node's end, not to the next backtick
  // of the document: a scan to the end per label made many labels quadratic.
  it('reads many labels before a long text in about the time of their length', { timeout: 60_000 }, () => {
    const text = '![a `b`](x.png)' + 'c'.repeat(4_000_000) + '`';
    const started = performance.now();
    for (let count = 0; count < 200_000; count++) assert.equal(bracketedLabel(text, 1, 15), 'a `b`');
    assert.ok(performance.now() - started < 3_000, `${performance.now() - started} ms`);
  });

  it('scans many unclosed runs of different lengths in linear time', { timeout: 60_000 }, () => {
    const text = Array.from({ length: 2_000 }, (_, index) => '`'.repeat(index + 1)).join('a');
    const started = performance.now();
    assert.deepEqual(codeSpans(text, 0, text.length), []);
    assert.ok(performance.now() - started < 5_000);
  });
});

describe('linkDestination', () => {
  it('percent-encodes a backslash, |, ^, { and } as Linear writes them, and keeps where the link goes', () => {
    assert.equal(linkDestination('a\\'), '<a%5C>');
    assert.equal(linkDestination('a\\x'), '<a%5Cx>');
    assert.equal(linkDestination('a|b^c{d}'), '<a%7Cb%5Ec%7Bd%7D>');
    assert.equal(linkDestination('a b<c>'), '<a%20b%3Cc%3E>');
    // A `%` that starts no escape is written `%25`, so a file name holding one still decodes next to an encoded character.
    assert.equal(linkDestination('100%|.pdf'), '<100%25%7C.pdf>');
    assert.equal(decodedDestinationPath('100%25%7C.pdf'), '100%|.pdf');
    // A relative path that does not decode names its file as written: every `%` in it is literal.
    assert.equal(linkDestination('a%20b%zz.pdf'), '<a%2520b%25zz.pdf>');
    assert.equal(decodedDestinationPath('a%2520b%25zz.pdf'), 'a%20b%zz.pdf');
    assert.equal(linkDestination('a%20b|c.pdf?q=1%zz'), '<a%20b%7Cc.pdf?q=1%25zz>');
    assert.equal(decodedDestinationPath('a%20b%7Cc.pdf'), 'a b|c.pdf');
    // An absolute URL keeps its escapes; only a `%` that starts none becomes `%25`, as renderers write it.
    assert.equal(linkDestination('https://example.com/a%20b%zz'), '<https://example.com/a%20b%25zz>');
    // Every relative destination still resolves to the file it named before.
    for (const url of ['a%20b%zz.pdf', '100%|.pdf', 'a%20b.pdf', 'a|b.pdf', '%FF.pdf', 'x%2Fy%.md', 'n\\o{t}e.md?x=%zz']) {
      const written = linkDestination(url).slice(1, -1).replace(/\\(.)/g, '$1');
      assert.equal(decodedDestinationPath(written), decodedDestinationPath(url), url);
    }
    // Every short destination over these characters reads back as the same link.
    let urls = [''];
    for (let length = 1; length <= 6; length++) {
      urls = urls.flatMap((url) => ['\\', 'x', '(', '|', '{'].map((char) => url + char));
      for (const url of urls) {
        assert.ok(sameMarkdown(`[a](${linkDestination(url)})`, `[a](<${url.replace(/\\/g, '\\\\')}>)`), JSON.stringify(url));
      }
    }
  });

  // The run of backslashes that ends a destination was once counted by a
  // regular expression that rescanned the run from each of its positions
  // when another character followed it: a run near the content limit took
  // minutes. The run is half the limit, since each backslash it stands for
  // is written as `%5C`, three characters. fix
  // writes every link destination; lint writes one only for a reference link,
  // to size its expansion. A child process runs lint and fix on an inline and
  // a reference link holding such a run, so the parent's timeout stops a stall
  // that a test timeout could not interrupt; each run is measured against a
  // parse of the same text.
  it('lints and fixes a destination holding a backslash run of the content limit in about the time of its parse', { timeout: 120_000 }, () => {
    const script = `
      import { CONTENT_LIMIT } from ${JSON.stringify(new URL('./rules.ts', import.meta.url).href)};
      import { fixText } from ${JSON.stringify(new URL('./fix.ts', import.meta.url).href)};
      import { lintText } from ${JSON.stringify(new URL('./lint.ts', import.meta.url).href)};
      import { parse, sameMarkdown } from ${JSON.stringify(new URL('./markdown.ts', import.meta.url).href)};
      const run = '\\\\'.repeat(Math.floor(CONTENT_LIMIT / 2));
      const cases = { inline: '[a](' + run + 'x)', reference: '[a][r]\\n\\n[r]: ' + run + 'x' };
      const result = {};
      for (const [name, text] of Object.entries(cases)) {
        let start = performance.now();
        parse(text);
        const parseMs = performance.now() - start;
        start = performance.now();
        const findings = lintText('a.md', text);
        const lintMs = performance.now() - start;
        start = performance.now();
        const fixed = fixText(text);
        const fixMs = performance.now() - start;
        result[name] = { parseMs, lintMs, fixMs, findings: findings.length, kept: sameMarkdown(fixed, '[a](' + run + 'x)') };
      }
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 100_000 });
    assert.equal(child.signal, null, 'lint and fix did not finish within the parent timeout');
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as Record<string, { parseMs: number; lintMs: number; fixMs: number; findings: number; kept: boolean }>;
    assert.deepEqual(Object.keys(result), ['inline', 'reference']);
    for (const [name, { parseMs, lintMs, fixMs, findings, kept }] of Object.entries(result)) {
      assert.equal(findings, 0, `${name}: lint finds nothing to report`);
      assert.ok(kept, `${name}: fix keeps the destination`);
      const times = `${name}: parse ${Math.round(parseMs)} ms, lint ${Math.round(lintMs)} ms, fix ${Math.round(fixMs)} ms`;
      // lint and fix parse the text a few times; the destination adds little beside that.
      assert.ok(lintMs < 10 * parseMs + 5_000, times);
      assert.ok(fixMs < 10 * parseMs + 5_000, times);
    }
  });
});
