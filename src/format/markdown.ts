// Parsing helpers for the format module: the Markdown tree with source
// positions, and the split between front matter and the body.

import { isDeepStrictEqual } from 'node:util';
import type { Nodes, Paragraph, Parent, PhrasingContent, Root, Text } from 'mdast';
import { fromMarkdown, type Extension, type Transform } from 'mdast-util-from-markdown';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { EditMap } from 'micromark-util-edit-map';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { posix } from 'node:path';

type ParserEvent = Parameters<EditMap['consume']>[0][number];

/**
 * The parser applies the edits of each container it closes, such as a block
 * quote that a blank line ends, to the whole event list of the document:
 * `EditMap.consume` copies every event before the first edit and pushes it
 * back. A document of many separate block quotes then takes time that grows
 * with the square of its length, minutes at `CONTENT_LIMIT`.
 *
 * Loading this module replaces `consume` for every parse in the process, not
 * only `parse`. The replacement applies the same edits and gives the same
 * list, but leaves the events before the first edit where they are, so each
 * close costs only the events after it. It is written for
 * micromark-util-edit-map 1.0.0, the version pinned in `package.json`;
 * `markdown.test.ts` checks that pin, that the parser imports this copy, and
 * that the result equals the original's.
 */
EditMap.prototype.consume = function consume(this: EditMap, events: ParserEvent[]): undefined {
  this.map.sort((a, b) => a[0] - b[0]);
  // From the last edit back: keep what follows each edit, then its additions.
  const pieces: ParserEvent[][] = [];
  for (let index = this.map.length - 1; index >= 0; index--) {
    const [at, remove, add] = this.map[index]!;
    pieces.push(events.slice(at + remove), add);
    events.length = at;
  }
  for (let piece = pieces.pop(); piece !== undefined; piece = pieces.pop()) {
    for (const event of piece) events.push(event);
  }
  this.map.length = 0;
  this.index.clear();
};

/** A file split into the part that never goes to Linear and the body that does. */
export interface SplitFile {
  /** Byte order mark, front matter and the blank lines after it; kept as they are. */
  readonly head: string;
  readonly body: string;
}

const BOM = '﻿';
// A leading `---` line, any lines, and a closing `---` line.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[^\n]*\n)*?---[ \t]*(?:\r?\n|$)/;
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

/**
 * Splits off what the sync never sends to Linear: front matter and
 * the blank lines after it. A byte order mark is kept with the head too.
 */
export function splitFile(text: string): SplitFile {
  const bom = text.startsWith(BOM) ? BOM : '';
  const rest = text.slice(bom.length);
  const match = FRONT_MATTER.exec(rest);
  if (!match) return { head: bom, body: rest };
  const afterBlock = rest.slice(match[0].length);
  const blank = LEADING_BLANK_LINES.exec(afterBlock)?.[0] ?? '';
  return { head: bom + match[0] + blank, body: afterBlock.slice(blank.length) };
}

/**
 * Joins a head and a body so that `splitFile` gives the body back as the
 * body. Linear spells a thematic break `---`, so a body that opens with one
 * and has another later would read as front matter under a head without
 * its own block: that text would stop going to Linear, and in a folder's
 * `README.md` it would become the folder's annotation. Such a body opens
 * with `***` instead, the same rule in Markdown, which Linear reads back
 * as `---` and `sameMarkdown` takes as no change.
 */
export function joinFile(head: string, body: string): string {
  if (FRONT_MATTER.test(head.startsWith(BOM) ? head.slice(BOM.length) : head)) {
    // A file that ends right after its closing fence needs a line break before the body, in the head's own style.
    if (body === '' || head.endsWith('\n')) return head + body;
    return head + (head.includes('\r\n') ? '\r\n' : '\n') + body;
  }
  // Without a block of its own the head is empty or a byte order mark: read the text as `splitFile` does.
  const text = head + body;
  const at = text.startsWith(BOM) ? BOM.length : 0;
  if (!FRONT_MATTER.test(text.slice(at))) return text;
  return text.slice(0, at) + '***' + text.slice(at + '---'.length);
}

/** Number of line breaks in a text: the line offset of what follows it. */
export function lineCount(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count++;
  return count;
}

// Keep downstream renderers and structural comparisons within a safe depth,
// and cap work even for a shallow document with many small nodes.
export const MARKDOWN_MAX_DEPTH = 128;
export const MARKDOWN_MAX_NODES = 500_000;

/**
 * The parser's inline step can take time that grows with the square of an
 * inline run (a paragraph, heading or table cell): from each place where
 * the run's text can split (inline punctuation, a line break, the start of
 * a word) some of its steps walk back over the run's tokens so far (a `]`
 * looking for its opener, an autolink check for an unclosed `[`), and the
 * text between other constructs is merged with one array splice of the
 * run's tokens each.
 * `parse` adds up the run's tokens so far at every such place and refuses
 * the body over this budget, which ordinary documents stay far below.
 */
export const INLINE_WORK_LIMIT = 250_000_000;

/**
 * For every lazy line (a line that continues a paragraph in a block quote
 * or list item without the container's prefix), the parser's document step
 * walks back over the events of the open container's blocks (the flow) to
 * the latest token that spans the line's start, usually the paragraph's own
 * (micromark 4.0.3, `writeToChild` in `lib/initialize/document.js`). A list
 * item followed by many lazy lines then takes time that grows with the
 * square of their number, tens of minutes at `CONTENT_LIMIT`. The walk sits
 * inside a closure of the document tokenizer, so it cannot be replaced the
 * way `EditMap.consume` is. `parse` adds up, over the document's lazy lines,
 * the most that walk can visit, and refuses the body over this budget. An
 * ordinary document stays far below it: for a lazy line inside a paragraph
 * that is that paragraph's events so far, and such paragraphs are short.
 */
export const LAZY_WORK_LIMIT = 20_000_000;

export class MarkdownLimitError extends Error {
  readonly limit: 'depth' | 'nodes' | 'inline' | 'lazy' | 'widening' | 'merge-marker' | 'merge-output';
  constructor(limit: MarkdownLimitError['limit']) {
    super(`Markdown exceeds the ${limit} limit.`);
    this.name = 'MarkdownLimitError';
    this.limit = limit;
  }
}

export function parse(body: string, mdastExtensions: Extension[] = []): Root {
  // GFM's tree transforms (its search for bare URLs inside text) run here,
  // after the parse, so the nodes they make get source positions.
  const gfmExtensions = gfmFromMarkdown();
  const transforms = gfmExtensions.flatMap((extension) => extension.transforms ?? []);
  const untransformed = gfmExtensions.map(({ transforms: _transforms, ...extension }) => extension);
  const tree = fromMarkdown(body, { extensions: [gfm(), inlineBudget(), lazyBudget()], mdastExtensions: [...untransformed, ...mdastExtensions] });
  // The parser counts source offsets after one leading BOM.
  placeTextLinks(tree, body.startsWith('\uFEFF') ? body.slice(1) : body, transforms);
  // Validate before returning the tree to any recursive renderer or comparer.
  visit(tree, () => {});
  return tree;
}

/** What the bare-URL search can find in a text: a URL with a scheme, `www.`, or an email address. */
const TEXT_LINK_HINT = /https?:\/\/|www\.|@/i;

/**
 * Runs `transforms`, the GFM search for bare URLs that the parser did not
 * link (`"www.example.com"` in quotes, `[https://example.com]`), on each text
 * node, and gives the links it makes and the text around them the source
 * offsets they come from. The writer copies text by those offsets; the search
 * itself leaves its nodes without positions. A link that cannot be placed for
 * certain (its URL spelled with an escape or a character reference) keeps its
 * nodes without positions, and lint reports it (`unplaced-link`).
 *
 * The search works on one text node at a time, never inside a link, so
 * running it per node gives the tree it gives on the whole document; text
 * nodes next to each other are merged.
 */
function placeTextLinks(tree: Root, source: string, transforms: readonly Transform[]): void {
  if (transforms.length === 0) return;
  const found = new Map<Parent, Text[]>();
  visit(tree, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (node.type !== 'text' || parent === undefined || !('children' in parent) || !TEXT_LINK_HINT.test(node.value)) return;
    if (ancestors.some((ancestor) => ancestor.type === 'link' || ancestor.type === 'linkReference')) return;
    const texts = found.get(parent);
    if (texts === undefined) found.set(parent, [node]);
    else texts.push(node);
  });
  if (found.size === 0) return;
  const points = new PointIndex(source);
  for (const [parent, texts] of found) {
    const replaced = new Map<Nodes, PhrasingContent[]>();
    for (const node of texts) {
      const paragraph: Paragraph = { type: 'paragraph', children: [{ type: 'text', value: node.value }] };
      for (const transform of transforms) transform({ type: 'root', children: [paragraph] });
      const parts = mergedText(paragraph.children);
      if (parts.length === 1 && parts[0]!.type === 'text') continue;
      placeParts(parts, node, source, points);
      replaced.set(node, parts);
    }
    if (replaced.size > 0) parent.children = parent.children.flatMap((child) => replaced.get(child) ?? [child]) as Parent['children'];
  }
}

/** Adjacent text nodes as one: the search can return a URL's trailing punctuation as a text node of its own. */
function mergedText(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const merged: PhrasingContent[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else merged.push(node);
  }
  return merged;
}

/** A backslash escape or a character reference: source that can read as other characters. */
const DECODED = /\\[!-/:-@[-`{-~]|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * Gives `parts`, the search's split of `text`, the source offsets they come
 * from, or leaves them all without positions when that is not certain.
 *
 * A link's text is a slice of the text node's value. An occurrence of it in
 * the source that touches no escape or character reference (a literal one)
 * reads as the same characters in the value, in the same order; a link's
 * text holds no line break, so no container prefix falls inside it. When the
 * value holds the text as often as the source holds it literally, the n-th
 * occurrence in the value is therefore the n-th literal one in the source.
 */
function placeParts(parts: PhrasingContent[], text: Text, source: string, points: PointIndex): void {
  const from = start(text);
  const raw = source.slice(from, end(text));
  // decoded[i]: how many of the first i source characters belong to an escape or a reference.
  const decoded = new Uint32Array(raw.length + 1);
  for (const match of raw.matchAll(DECODED)) {
    // A name that is no character reference stays text, as written.
    if (match[1] !== undefined && decodeNamedCharacterReference(match[1]) === false) continue;
    decoded.fill(1, match.index + 1, match.index + match[0].length + 1);
  }
  for (let at = 1; at <= raw.length; at++) decoded[at] = decoded[at - 1]! + decoded[at]!;
  const literal = (at: number, length: number): boolean => decoded[at + length] === decoded[at];
  const labels = new Map<string, { value: number[]; source: number[]; next: number }>();
  const ranges: Array<[number, number]> = [];
  let valueAt = 0;
  for (const part of parts) {
    if (part.type === 'text') {
      valueAt += part.value.length;
      continue;
    }
    if (part.type !== 'link' || part.children.length !== 1 || part.children[0]!.type !== 'text') return;
    const label = part.children[0].value;
    let found = labels.get(label);
    if (found === undefined) {
      found = { value: occurrences(text.value, label), source: occurrences(raw, label).filter((at) => literal(at, label.length)), next: 0 };
      if (found.value.length !== found.source.length) return;
      labels.set(label, found);
    }
    while (found.next < found.value.length && found.value[found.next]! < valueAt) found.next++;
    const at = found.source[found.next];
    if (at === undefined || at < (ranges.at(-1)?.[1] ?? 0)) return;
    ranges.push([at, at + label.length]);
    valueAt += label.length;
  }
  const position = (a: number, b: number) => ({ start: points.at(from + a), end: points.at(from + b) });
  let link = 0;
  let at = 0;
  for (const part of parts) {
    if (part.type === 'link') {
      const [a, b] = ranges[link++]!;
      part.position = position(a, b);
      part.children[0]!.position = position(a, b);
      at = b;
      continue;
    }
    const next = ranges[link]?.[0] ?? raw.length;
    part.position = position(at, next);
    at = next;
  }
}

/** Where `needle` starts in `haystack`, overlapping occurrences included. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

type Point = NonNullable<Text['position']>['start'];

/** Line and column of source offsets, as the parser counts them: a line ends at CR LF, CR or LF. */
class PointIndex {
  private readonly lineStarts: number[] = [0];

  constructor(source: string) {
    for (const match of source.matchAll(/\r\n?|\n/g)) this.lineStarts.push(match.index + match[0].length);
  }

  at(offset: number): Point {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1, offset };
  }
}

// Parser extension types, from the GFM extension's own.
type MicromarkExtension = ReturnType<typeof gfm>;
type Construct = Exclude<NonNullable<MicromarkExtension['text']>[number], unknown[] | undefined | null>;
type TokenizeContext = ThisParameterType<NonNullable<Construct['previous']>>;

const isAsciiAlphanumeric = (code: number | null): boolean =>
  code !== null && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122));
// Where a run's text can split: inline punctuation (`! & * < [ \\ ] _ \` ~`) and
// line breaks (the parser's codes -5 to -3), and the characters an email,
// www or protocol autolink can start with, at the start of a word.
const SPLIT_CODES = [33, 38, 42, 60, 91, 92, 93, 95, 96, 126, -5, -4, -3];
const WORD_CODES = [43, 45, 46];
for (let code = 48; code <= 122; code++) if (isAsciiAlphanumeric(code)) WORD_CODES.push(code);

/**
 * A parser extension that counts the inline work of one parse and throws
 * `MarkdownLimitError` past `INLINE_WORK_LIMIT`. It only watches: its guard
 * runs before the other constructs at each place a run can split, adds the
 * run's tokens so far, and declines, so the parse itself is unchanged.
 */
function inlineBudget(): MicromarkExtension {
  let work = 0;
  // Runs with a `[`: only there can an autolink check walk back further than its previous one.
  const bracketed = new WeakSet<TokenizeContext>();
  const count = function (this: TokenizeContext): boolean {
    work += this.events.length;
    if (work > INLINE_WORK_LIMIT) throw new MarkdownLimitError('inline');
    return false;
  };
  const split: Construct = { name: 'inlineBudget', tokenize: (_effects, _ok, nok) => nok, previous: count };
  const bracket: Construct = {
    ...split,
    previous(this: TokenizeContext): boolean {
      bracketed.add(this);
      return count.call(this);
    },
  };
  const word: Construct = {
    ...split,
    previous(this: TokenizeContext, previous: number | null): boolean {
      return bracketed.has(this) && !isAsciiAlphanumeric(previous) ? count.call(this) : false;
    },
  };
  const text: Record<number, Construct> = {};
  for (const code of SPLIT_CODES) text[code] = split;
  for (const code of WORD_CODES) text[code] = word;
  text[91] = bracket;
  return { text };
}

type Parser = TokenizeContext['parser'];

type FlowTokenizer = ReturnType<Parser['flow']>;

/**
 * A parser extension that counts the lazy-line work of one parse and throws
 * `MarkdownLimitError` past `LAZY_WORK_LIMIT`. It only watches: its
 * constructs read nothing and decline, so the parse itself is unchanged.
 *
 * The document step creates each flow's tokenizer with `parser.flow` once
 * its container checks at the start of a line have failed, so a container
 * construct that every such check tries can wrap `parser.flow` first. The
 * wrapper notes the line of each chunk the document step writes to the flow:
 * `defineSkip` gets the chunk's start right before `write`. Closing a flow
 * writes without one, and no walk follows. A flow construct tried first at
 * the start of every block (except a blank line) notes where the block's
 * events begin.
 *
 * After the write of a lazy line, the walk stops at the latest token that
 * started before the line and is still open or ends after its start. A
 * block that began on an earlier line and is still open (the flow's
 * `currentConstruct`) has such a token at or after its first event, so the
 * walk visits at most the events since then. Otherwise (the block ended or
 * began on this line, or the line is blank) the walk may go back to the
 * flow's first event, so the budget counts them all; that walk then closes
 * the containers the line left out.
 */
function lazyBudget(): MicromarkExtension {
  let work = 0;
  let watching = false;
  // The flow being written, for the block construct.
  let writing: FlowTokenizer | undefined;
  // Where the latest block of each flow began: its first event and its line.
  const blocks = new WeakMap<FlowTokenizer, { from: number; line: number }>();
  const watch = (parser: Parser): void => {
    watching = true;
    const create = parser.flow;
    parser.flow = (from) => {
      const flow = create(from);
      const { defineSkip, write } = flow;
      let line: number | undefined;
      flow.defineSkip = (point) => {
        line = point.line;
        return defineSkip(point);
      };
      flow.write = (slice) => {
        const chunkLine = line;
        line = undefined;
        writing = flow;
        let events;
        try {
          events = write(slice);
        } finally {
          writing = undefined;
        }
        if (chunkLine !== undefined && parser.lazy[chunkLine]) {
          const block = blocks.get(flow);
          const open = flow.currentConstruct !== undefined && block !== undefined && block.line < chunkLine;
          work += flow.events.length - (open ? block.from : 0);
          if (work > LAZY_WORK_LIMIT) throw new MarkdownLimitError('lazy');
        }
        return events;
      };
      return flow;
    };
  };
  const container: Construct = {
    name: 'lazyBudget',
    partial: true,
    tokenize(this: TokenizeContext, _effects, _ok, nok) {
      if (!watching) watch(this.parser);
      return nok;
    },
  };
  const block: Construct = {
    name: 'lazyBudgetBlock',
    partial: true,
    tokenize(this: TokenizeContext, _effects, _ok, nok) {
      if (writing !== undefined) blocks.set(writing, { from: this.events.length, line: this.now().line });
      return nok;
    },
  };
  // Also under the characters indented code is tried for, so it comes before that construct.
  return { document: { null: container }, flowInitial: { null: block, [-2]: block, [-1]: block, [32]: block } };
}

/** An old accepted body can be too complex to use as a comparison baseline. */
export function markdownBaseline(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    parse(body);
    return body;
  } catch (error) {
    if (!(error instanceof MarkdownLimitError)) throw error;
    return undefined;
  }
}

/**
 * Whether two bodies are the same document: equal text, or text that
 * Markdown reads as the same tree. Linear can return a body it stored in a
 * spelling of its own (a final newline, `\-6` for `-6` at the start of a
 * table cell, `*` for `_`), which changes nothing in the document; the sync
 * keeps the file's spelling for those.
 */
export function sameMarkdown(a: string, b: string, options: { linearNumberSpacing?: boolean } = {}): boolean {
  if (a === b) return true;
  return isDeepStrictEqual(comparable(a, options.linearNumberSpacing), comparable(b, options.linearNumberSpacing));
}

/**
 * Whether Linear's `content` is the same document as `body`, a text of the
 * repository: `sameMarkdown` with Linear's content read as Linear holds it
 * (`linearMarkersAsText`).
 */
export function sameAsLinear(content: string, body: string): boolean {
  if (content === body) return true;
  const restored = linearMarkersAsText(content, body);
  if (sameMarkdown(restored, body)) return true;
  // A bare closing +++ after an escaped title can be exported as its own
  // paragraph. Compare that legacy spelling with the blank line Linear added.
  return body.includes('\\+++') && sameMarkdown(restored, linearSectionEnd(body));
}

function linearSectionEnd(body: string): string {
  const lines = body.split(LINE_END);
  const closing = new Set<number>();
  visit(parse(body), (node) => {
    if (node.type !== 'paragraph') return;
    const first = line(node) - 1;
    const last = (node.position?.end.line ?? first + 1) - 1;
    const column = (node.position?.start.column ?? 1) - 1;
    if (last > first && lines[first]!.slice(column).startsWith('\\+++ ') && linearLineText(lines[last]!) === '+++') {
      closing.add(last);
    }
  });
  return lines.flatMap((row, index) => closing.has(index) ? [LINE_PREFIX.exec(row)![0].trimEnd(), row] : [row]).join('\n');
}

// A bullet or number marker Linear never writes for a list of its own.
const NOT_LINEAR_MARKER = /^(?:\+|\d{1,9}\))/;
const LINEAR_BLOCK_START = /^[ \t>]*(?:(?:[*+-]|\d{1,9}[.)])[ \t]+)*(?:\+{1,3}(?:[ \t\r]|$)|\d{1,9}\)(?:[ \t\r]|$)|\$\$|<|\|)/m;
const LINE_END = /\r\n?|\n/;
const LINE_PREFIX = /^[ \t>]*/;
const CONFLICT_START = /^<{7}(?: |$)/;
const DIV_START = /^<div(?:[ \t][^>\n]*)?>/i;
const DIV_END = /<\/div[ \t]*>/i;
const DIV_END_START = /^<\/div[ \t]*>/i;
const SECTION_TITLE = /^\+{3}[ \t]/;
const ESCAPED_BLOCK_START = /^\\(?=<|\|[- \t:]|\$\$|\+{3}(?:[ \t]|$))/;

function linearLineText(row: string): string {
  return row.replace(LINE_PREFIX, '').trimEnd();
}

function tableKey(header: string, delimiter: string): string {
  const text = linearLineText(header).replace(/^(?:[*+-]|\d{1,9}[.)])[ \t]+/, '');
  return text + '\n' + delimiter;
}

function tableRowsKey(lines: readonly string[], from: number, to: number): string {
  const rows: string[] = [];
  for (let index = from; index < to; index++) {
    const row = linearLineText(lines[index]!);
    if (!row.startsWith('|')) break;
    rows.push(row);
  }
  return rows.join('\n');
}

function blockLineKey(text: string, startsParagraph: boolean): string {
  return (startsParagraph ? 'first:' : 'next:') + text;
}

/** A line of literal text in the accepted body is evidence for an ambiguous export. */
function acceptedBlockStarts(previous: string) {
  const escapes = new Set<string>();
  const tables = new Set<string>();
  const tableHeaders = new Set<string>();
  const html = new Set<string>();
  if (!/\\[<|$+]|<div\b|^[ \t>]*\|/im.test(previous)) return { escapes, tables, tableHeaders, html };
  const lines = previous.split(LINE_END);
  visit(parse(previous), (node, ancestors) => {
    const first = line(node) - 1;
    if (node.type === 'table') {
      const key = tableKey(lines[first]!, linearLineText(lines[first + 1] ?? ''));
      tableHeaders.add(key);
      tables.add(key + '\n' + tableRowsKey(lines, first + 2, node.position?.end.line ?? first + 2));
      return;
    }
    if (node.type === 'html' && ancestors.at(-1)?.type !== 'paragraph') {
      html.add(previous.slice(start(node), end(node)));
      return;
    }
    if (node.type !== 'text' || ancestors.at(-1)?.type !== 'paragraph') return;
    const column = (node.position?.start.column ?? 1) - 1;
    for (let index = first; index < (node.position?.end.line ?? 0); index++) {
      const row = lines[index]!;
      const raw = linearLineText(index === first ? row.slice(column) : row);
      if (!ESCAPED_BLOCK_START.test(raw)) continue;
      const literal = raw.slice(1);
      const paragraph = ancestors.at(-1)!;
      if (literal.startsWith('|')) {
        const key = tableKey(lines[index - 1] ?? '', literal);
        escapes.add(key);
        escapes.add(key + '\n' + tableRowsKey(lines, index + 1, paragraph.position?.end.line ?? index + 1));
      } else {
        escapes.add(blockLineKey(literal, index === line(paragraph) - 1));
        if (SECTION_TITLE.test(literal) && line(paragraph) === index + 1 && paragraph.position?.end.line === index + 1) {
          escapes.add('section:' + literal);
        }
      }
    }
  });
  return { escapes, tables, tableHeaders, html };
}

/** Blank lines can split an HTML div across sibling Markdown nodes. */
function divsClosedInAnotherBlock(tree: Root, source: string): Set<Nodes> {
  const paired = new Set<Nodes>();
  if (!DIV_END.test(source)) return paired;
  const open = new Map<Nodes, Nodes[]>();
  visit(tree, (node, ancestors) => {
    if (node.type !== 'html') return;
    const parent = ancestors.at(-1)!;
    if (parent.type === 'paragraph') return;
    if (DIV_END_START.test(node.value)) {
      const opening = open.get(parent)?.pop();
      if (opening !== undefined) paired.add(opening);
    } else if (DIV_START.test(node.value) && !DIV_END.test(node.value)) {
      const siblings = open.get(parent) ?? [];
      siblings.push(node);
      open.set(parent, siblings);
    }
  });
  return paired;
}

/**
 * Linear's content with the block-start escapes it drops put back. For
 * export forms shared by a block and literal text, an accepted body can
 * supply the escape. A new document uses Linear's canonical block spelling
 * to resolve those cases.
 */
export function linearMarkersAsText(content: string, previous = ''): string {
  if (!LINEAR_BLOCK_START.test(content)) return content;
  const accepted = acceptedBlockStarts(previous);
  let text = content;
  // Restoring an escape can expose another block. Bound the reparses as
  // for Markdown's nested containers.
  for (let pass = 0; pass <= MARKDOWN_MAX_DEPTH; pass++) {
    const escapes = new Set<number>();
    const escapedItems = new Set<Nodes>();
    const lines = text.split(LINE_END);
    const offsets = [0];
    for (const match of text.matchAll(/\r\n?|\n/g)) offsets.push(match.index + match[0].length);
    const lineEnd = (index: number) => offsets[index]! + lines[index]!.length;
    const rowAt = (index: number) => linearLineText(lines[index] ?? '');
    const sections = new Map<Nodes, Array<{ at: number; literal: boolean }>>();
    const rowStart = (index: number) => offsets[index]! + LINE_PREFIX.exec(lines[index]!)![0].length;
    const tree = parse(text);
    const pairedDivs = divsClosedInAnotherBlock(tree, text);
    visit(tree, (node, ancestors) => {
      if (ancestors.some((ancestor) => escapedItems.has(ancestor))) return;
      const at = start(node);
      const index = line(node) - 1;
      if (node.type === 'listItem') {
        const marker = NOT_LINEAR_MARKER.exec(text.slice(at, at + 11));
        if (marker === null) return;
        escapedItems.add(node);
        escapes.add(at + marker[0].length - 1);
      } else if (node.type === 'table') {
        const delimiter = rowAt(index + 1);
        if (!delimiter.startsWith('|')) return;
        // A real table gets a canonical delimiter and a final newline.
        // Inside a document its export can also be identical to paragraph text.
        const canonical = /^\|(?: -- \|)+$/.test(delimiter);
        const key = tableKey(lines[index]!, delimiter);
        const table = key + '\n' + tableRowsKey(lines, index + 2, node.position?.end.line ?? index + 2);
        if (accepted.tables.has(table)) return;
        const knownLiteral = accepted.tableHeaders.has(key) ? accepted.escapes.has(table) : accepted.escapes.has(key);
        const literal = knownLiteral ||
          !canonical || end(node) === text.length ||
          ancestors.at(-1)?.type === 'listItem' && at > rowStart(index);
        if (literal) escapes.add(rowStart(index + 1));
      } else if (node.type === 'html' && ancestors.at(-1)?.type !== 'paragraph') {
        // Linear can export an HTML block as text. Preserve complete HTML
        // when the export and a file containing HTML share the same spelling.
        const raw = text.slice(at, end(node));
        const first = text.slice(at, lineEnd(index)).trimEnd();
        if (pairedDivs.has(node) || accepted.html.has(raw) && !CONFLICT_START.test(raw)) return;
        const completeDiv = DIV_START.test(first) && DIV_END.test(raw);
        const literal = accepted.escapes.has(blockLineKey(first, true)) || accepted.escapes.has(blockLineKey(first, false));
        const incompleteDiv = DIV_START.test(first) && !completeDiv;
        if (CONFLICT_START.test(raw) || literal || incompleteDiv) {
          escapes.add(at);
          // Several tag starts can be parsed as a single HTML node. Restore
          // its literal starts together, skipping apparent starts in code.
          const spans = codeSpans(text, at, end(node));
          let span = 0;
          const last = (node.position?.end.line ?? index + 1) - 1;
          for (let row = index + 1; row <= last; row++) {
            const offset = rowStart(row);
            while (span < spans.length && spans[span]![1] <= offset) span++;
            if (span < spans.length && spans[span]![0] <= offset) continue;
            const rowText = rowAt(row);
            if (accepted.escapes.has(blockLineKey(rowText, false)) || incompleteDiv && DIV_START.test(rowText)) escapes.add(offset);
          }
        }
      } else if (node.type === 'paragraph') {
        const rawFirst = text.slice(at, lineEnd(index));
        const first = rawFirst.trimEnd();
        const last = (node.position?.end.line ?? index + 1) - 1;
        const literal = accepted.escapes.has(blockLineKey(first, true));
        if (CONFLICT_START.test(first) || literal && first !== '+++' && !SECTION_TITLE.test(rawFirst)) escapes.add(at);
        if (first === '$$' && last > index + 1 && rowAt(last) === '$$') escapes.add(at);
        // Linear writes a blank line after a real section's title. Pair
        // standalone markers within their container to keep its closer.
        const parent = ancestors.at(-1)!;
        if (SECTION_TITLE.test(rawFirst)) {
          if (last > index) {
            escapes.add(at);
            if (rowAt(last) === '+++') escapes.add(rowStart(last));
          } else {
            const open = sections.get(parent) ?? [];
            open.push({ at, literal: accepted.escapes.has('section:' + first) && accepted.escapes.has(blockLineKey('+++', true)) });
            sections.set(parent, open);
          }
        } else if (first === '+++' && last === index) {
          const open = sections.get(parent)?.pop();
          if (open?.literal) {
            escapes.add(open.at);
            escapes.add(at);
          } else if (open === undefined && literal) {
            escapes.add(at);
          }
        }
      } else if (node.type === 'text' && ancestors.at(-1)?.type === 'paragraph') {
        for (let row = index; row < (node.position?.end.line ?? 0); row++) {
          const offset = rowStart(row);
          if (offset < at || offset >= end(node)) continue;
          const raw = rowAt(row);
          if (row === line(ancestors.at(-1)!) - 1) continue;
          if (CONFLICT_START.test(raw) || accepted.escapes.has(blockLineKey(raw, false))) escapes.add(offset);
        }
      }
    });
    for (const open of sections.values()) for (const section of open) escapes.add(section.at);
    if (escapes.size === 0) return text;
    const parts: string[] = [];
    let at = 0;
    for (const escape of [...escapes].sort((a, b) => a - b)) {
      parts.push(text.slice(at, escape), '\\');
      at = escape;
    }
    parts.push(text.slice(at));
    text = parts.join('');
  }
  throw new MarkdownLimitError('depth');
}

// Escapes of characters that open Linear's own syntax, which Markdown reads
// as text either way: `$$` math and `+++` collapsible sections.
const LINEAR_SYNTAX_ESCAPES: Readonly<Record<string, string>> = { '\\$': '', '\\+': '' };

/** Whether the `\+` at `at` is separate from a run of plus signs. */
function isLonePlus(text: string, at: number): boolean {
  const after = text[at + 2];
  return text[at - 1] !== '+' && after !== '+' && (after !== '\\' || text[at + 3] !== '+');
}

/** Mark file block openings without treating a lone plus in paragraph text as an item. */
function markFileBlockStarts(body: string): string {
  let plusItems: Set<number> | undefined;
  return body.replace(/^([ \t>]*(?:[*+-]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?)[ \t]*$/gm, (line, marker: string, at: number) => {
    if (marker.endsWith('+')) {
      if (plusItems === undefined) {
        const starts = new Set<number>();
        const bom = body.startsWith(BOM) ? 1 : 0;
        visit(parse(body), (node) => {
          if (node.type !== 'listItem' || body[start(node) + bom] !== '+') return;
          starts.add(body.lastIndexOf('\n', start(node) + bom - 1) + 1);
        });
        plusItems = starts;
      }
      if (!plusItems.has(at)) return line;
    }
    return marker + ' ';
  });
}

type ComparableNode = { type: Nodes['type']; value?: string; children?: ComparableNode[] };

/** Consecutive spans of the same style render as one. */
function appendComparable(children: ComparableNode[], child: ComparableNode): void {
  const previous = children.at(-1);
  if (child.type === 'text' && previous?.type === 'text') {
    previous.value += child.value!;
  } else if ((child.type === 'strong' || child.type === 'emphasis') && previous?.type === child.type) {
    for (const part of child.children!) appendComparable(previous.children!, part);
  } else {
    children.push(child);
  }
}

/** The text without its trailing line breaks, scanned from the end so a long run inside costs nothing. */
export function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return end === text.length ? text : text.slice(0, end);
}

/** The tree without source positions, destinations as Markdown renders them (`<a b.png>` is `a%20b.png`). */
function comparable(body: string, linearNumberSpacing = false): unknown {
  // Keep those escapes apart from the plain characters, so `\$$` and `$$` differ.
  // A lone `\+`, as `fix` writes for item text that is a bare `+`, cannot
  // be part of `+++`. Markdown reads it as a regular escape.
  // A list marker (with a task checkbox, if any) alone on its line opens a file block
  // in Linear (`* \n  [a](a.pdf)`), which Markdown reads as `* [a](a.pdf)`: keep that line apart too.
  const marked = markFileBlockStarts(nestedFileBlocksOnItemLine(body)
    .replace(/\\[$+]/g, (escape, at: number, text: string) => (escape === '\\+' && isLonePlus(text, at) ? escape : LINEAR_SYNTAX_ESCAPES[escape]!)));
  const tree = parse(marked);
  // Linear returns a top-level code block with one blank line fewer before
  // its closing fence each time it is written, and `fix` writes none: those
  // blank lines are a spelling, not content the sync compares.
  for (const child of tree.children) if (child.type === 'code') child.value = withoutTrailingNewlines(child.value);
  const strip = (node: Nodes, paragraphLine?: boolean): ComparableNode => {
    const { position: _position, ...rest } = node;
    if ('url' in rest) rest.url = normalizeUri(rest.url);
    if (linearNumberSpacing && node.type === 'text' && paragraphLine !== undefined) {
      // Linear substitutes one space after a literal number's dot. This is
      // only a re-spelling in a paragraph, after the parser resolved blocks.
      const separator = paragraphLine ? /(^|\n)([ \t]*\d+\.)[\t\u00a0]/g : /(\n)([ \t]*\d+\.)[\t\u00a0]/g;
      return { ...rest, value: node.value.replace(separator, '$1$2 ') };
    }
    if ('children' in node) {
      const children: ComparableNode[] = [];
      for (const [index, child] of node.children.entries()) {
        const startsLine = node.type === 'paragraph' ? index === 0 || node.children[index - 1]?.type === 'break' : undefined;
        const part = strip(child, startsLine);
        // A strong span immediately inside another one adds no formatting.
        if (node.type === 'strong' && part.type === 'strong') {
          for (const nested of part.children!) appendComparable(children, nested);
        } else {
          appendComparable(children, part);
        }
      }
      return { ...rest, children };
    }
    return rest;
  };
  return strip(tree);
}

/**
 * The quote prefix of a line, ` {0,3}>[ ]?` repeated: `end` is where it
 * ends, with the one space after its last `>`, and `lastQuote` is where that
 * last `>` ends (0 without one). One pass: a regular expression for the
 * prefix can give the space between two `>` to either of them, and on a
 * line of many `> ` that does not match it tries every split.
 */
function quotePrefix(line: string): { end: number; lastQuote: number } {
  let end = 0;
  let lastQuote = 0;
  for (;;) {
    let at = end;
    while (at - end < 3 && line[at] === ' ') at++;
    if (line[at] !== '>') return { end, lastQuote };
    lastQuote = at + 1;
    end = line[lastQuote] === ' ' ? lastQuote + 1 : lastQuote;
  }
}

// A bullet or number marker alone on the rest of its line, after spaces.
const MARKER_REST = /^( *)([*+-]|\d{1,9}[.)])[ \t]*\r?$/;

/** A bullet or number marker alone on its line, after any quote prefix: its prefix, spaces and marker, or null. */
function bareMarker(line: string): { prefix: string; spaces: string; bullet: string } | null {
  const { end } = quotePrefix(line);
  const marker = MARKER_REST.exec(line.slice(end));
  return marker === null ? null : { prefix: line.slice(0, end), spaces: marker[1]!, bullet: marker[2]! };
}

/** Whether a line holds any quote prefix, at least one space, then `[`. */
function opensIndentedBracket(line: string): boolean {
  let at = quotePrefix(line).lastQuote;
  if (line[at] !== ' ') return false;
  while (line[at] === ' ') at++;
  return line[at] === '[';
}

/** Whether a nonblank line is followed by a bare marker line, then by an indented line opening with `[`. */
function maybeNestedBlock(lines: readonly string[]): boolean {
  for (let index = 1; index + 1 < lines.length; index++) {
    if (/\S/.test(lines[index - 1]!) && opensIndentedBracket(lines[index + 1]!) && bareMarker(lines[index]!) !== null) return true;
  }
  return false;
}

/** The line without the spaces, tabs and carriage returns at its end. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t' || line[end - 1] === '\r')) end--;
  return line.slice(0, end);
}

/**
 * The body with each file block Markdown reads as text written on its
 * item's line. Linear writes a nested item holding an uploaded file right
 * after its parent's text as the marker alone, then the link at the item's
 * content indent (`* Parent\n  * \n    [a](a.csv)`). An empty item cannot
 * interrupt a paragraph, so Markdown reads both lines as the parent's text
 * (`Parent\n*\n[a](a.csv)`), while Linear holds a nested item with the
 * file: the same document as `* Parent\n  * [a](a.csv)`, the form `fix`
 * writes. Only the first such block of a paragraph is joined: once it is an
 * item, the blocks after it are items of its list, which Markdown reads as
 * file blocks already. A file block Markdown reads as an item stays as it is.
 */
export function nestedFileBlocksOnItemLine(body: string): string {
  const lines = body.split('\n');
  if (!maybeNestedBlock(lines)) return body;
  // Line indexes (0-based) of the marker lines to join with the link line after them.
  const joins = new Map<number, number>();
  visit(parse(body), (node) => {
    if (node.type !== 'paragraph') return;
    for (const [index, link] of node.children.entries()) {
      const before = node.children[index - 1];
      if (link.type !== 'link' || before?.type !== 'text') continue;
      const linkLine = link.position!.start.line - 1;
      const markerLine = linkLine - 1;
      // The marker line is the paragraph's own text, not its first line.
      if (markerLine < node.position!.start.line || before.position!.start.line - 1 > markerLine) continue;
      const marker = bareMarker(lines[markerLine]!);
      if (marker === null) continue;
      const { prefix, spaces, bullet } = marker;
      const column = prefix.length + spaces.length + bullet.length + 1;
      const line = lines[linkLine]!;
      // The link alone on its line, at the item's content indent.
      if (link.position!.start.column - 1 !== column || line.slice(0, column) !== prefix + ' '.repeat(column - prefix.length)) continue;
      if (link.position!.end.line - 1 !== linkLine || line.slice(link.position!.end.column - 1).trim() !== '') continue;
      joins.set(markerLine, column);
      break;
    }
  });
  if (joins.size === 0) return body;
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const column = joins.get(index);
    if (column === undefined) {
      result.push(lines[index]!);
      continue;
    }
    result.push(`${trimLineEnd(lines[index]!)} ${lines[index + 1]!.slice(column)}`);
    index++;
  }
  return result.join('\n');
}

/** A color comment Linear writes directly above a callout whose color is not its alert's default. */
export function isCalloutComment(node: Nodes | undefined): boolean {
  return node?.type === 'html' && /^<!--\s*linear:callout\b[^]*?-->$/.test(node.value);
}

/** The first line of a callout, without its quote prefix: `[!WARNING]` or another alert kind. */
export const ALERT = /^\[!\w+\][ \t]*$/;

// The lines of the last source `isCallout` read: callers ask about every
// quote of one document in turn, and a document can hold many quotes.
let calloutSource: { source: string; lines: string[] } | undefined;

/** Whether a top-level block quote of `source` is a callout: its first line is an alert. */
export function isCallout(node: Nodes, source: string): boolean {
  if (node.type !== 'blockquote' || !node.position) return false;
  if (calloutSource?.source !== source) calloutSource = { source, lines: source.split('\n') };
  const first = calloutSource.lines[node.position.start.line - 1] ?? '';
  return ALERT.test(first.replace(/\r$/, '').replace(/^ {0,3}> ?/, ''));
}

/**
 * The text as the content of a block quote, the way Linear writes one: each
 * line after `> `, a blank line as a bare `>`, except a blank line of a
 * code block's content, which keeps the space (`> `). `codeLines` holds the
 * lines (1-based) of the code blocks directly in the quote; a nested quote
 * has already written its blank code lines as `> `, and Linear's form of
 * code in a list is unrecorded.
 */
export function quoteLines(text: string, codeLines: ReadonlySet<number>): string {
  return text
    .split('\n')
    .map((line, index) => (line === '' && !codeLines.has(index + 1) ? '>' : `> ${line}`))
    .join('\n');
}

export function start(node: Nodes): number {
  return node.position?.start.offset ?? 0;
}

export function end(node: Nodes): number {
  return node.position?.end.offset ?? 0;
}

export function line(node: Nodes): number {
  return node.position?.start.line ?? 1;
}

/** Visits a node and all its descendants, parents before children, with their ancestors. */
export function visit(node: Nodes, enter: (node: Nodes, ancestors: readonly Nodes[]) => void, ancestors: Nodes[] = []): void {
  const parents = [...ancestors];
  const stack: Array<{ node: Nodes; next: number }> = [];
  let count = 0;
  for (;;) {
    if (parents.length > MARKDOWN_MAX_DEPTH) throw new MarkdownLimitError('depth');
    if (++count > MARKDOWN_MAX_NODES) throw new MarkdownLimitError('nodes');
    enter(node, parents);
    if ('children' in node && node.children.length > 0) {
      stack.push({ node, next: 1 });
      parents.push(node);
      node = node.children[0]!;
      continue;
    }
    // Keep one frame per ancestor, rather than queueing every sibling.
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if ('children' in frame.node && frame.next < frame.node.children.length) {
        node = frame.node.children[frame.next++]!;
        break;
      }
      stack.pop();
      parents.pop();
    }
    if (stack.length === 0) return;
  }
}

/** The path in a Markdown destination, decoded as a repository file name. */
export function decodedDestinationPath(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  try {
    return decodeURIComponent(path);
  } catch {
    // Not percent-encoded: the destination names the file as it is.
    return path;
  }
}

/** The repository path a relative destination points to, or null for anything else. */
export function resolveTarget(documentPath: string, url: string): string | null {
  if (url === '' || url.startsWith('#') || url.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const path = decodedDestinationPath(url);
  if (path === '') return null;
  const joined = posix.normalize(posix.join(posix.dirname(documentPath), path));
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.endsWith('/')) return null;
  return joined;
}

/** Schemes accepted by synchronized links; paths and fragments have no scheme. */
export function allowedLink(url: string): boolean {
  // URL readers ignore ASCII whitespace and control characters in schemes.
  const normalized = url.replace(/[\u0000-\u0020\u007f]/g, '');
  return !/^[a-z][a-z\d+.-]*:/i.test(normalized) || /^(?:https?|mailto):/i.test(normalized);
}

/**
 * A destination as Markdown source for a decoded URL: spaces encoded, and
 * what Markdown would read back differently escaped (a backslash before
 * punctuation, an `&` that starts a character reference).
 */
function destination(url: string): string {
  return url
    .replace(/ /g, '%20')
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/g, '&amp;');
}

/**
 * A link destination as Linear writes it: in angle brackets, with characters that would end it encoded. Linear also
 * percent-encodes a backslash, `|`, `^`, `{` and `}` (recorded in the fixture bank); so does every renderer that
 * writes the link as HTML, so the link goes to the same place. A `%` that starts no escape is written `%25`, as those
 * renderers write it. A relative path that does not decode names its file as written (`decodedDestinationPath`), so
 * there every `%` is written `%25`: the destination decodes to that same file name.
 */
export function linkDestination(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? '' : url.slice(cut);
  const literal = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !decodes(path);
  const encode = (text: string, percent: RegExp): string =>
    text.replace(new RegExp(`[<>\\r\\n\\\\|^{}]|${percent.source}`, 'g'), (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const lone = /%(?![0-9A-Fa-f]{2})/;
  return `<${destination(encode(path, literal ? /%/ : lone) + encode(rest, lone))}>`;
}

/** Whether `text` is valid percent-encoding: `decodeURIComponent` accepts it. */
function decodes(text: string): boolean {
  try {
    decodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

/** Linear writes image and file destinations without angle brackets: characters that would end one are encoded. */
export function imageDestination(url: string): string {
  return destination(url).replace(/[<>()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The bracketed label that opens at `open` (a `[`) in `source`, as written,
 * without its brackets, or an empty string when it does not close before
 * `limit`, the end of its node. The search stays inside the node: brackets in
 * a code span of the label are not counted by Markdown, and an unclosed count
 * would otherwise scan the rest of the document for every label.
 */
export function bracketedLabel(source: string, open: number, limit: number): string {
  const end = Math.min(limit, source.length);
  const closing = (spans: ReadonlyMap<number, number>): number => {
    let depth = 0;
    for (let at = open; at < end; at++) {
      const char = source[at];
      if (char === '\\') at++;
      else if (spans.has(at)) at = spans.get(at)! - 1;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) return at;
    }
    return -1;
  };
  // A backtick in the destination of a link inside the label opens no code
  // span either. When skipping the code spans found no bracket that the node
  // goes on from (with its destination or reference, or at its end), every
  // bracket counts.
  let close = closing(new Map(codeSpans(source, open, end)));
  if (!(close !== -1 && (close === end - 1 || source[close + 1] === '(' || source[close + 1] === '['))) close = closing(new Map());
  return close === -1 ? '' : source.slice(open + 1, close);
}

/**
 * The code spans in `source` from `from` to `to`, as `[start, end)` pairs: a
 * run of backticks up to the next run of the same length. A backslash outside
 * a code span escapes the next character; inside one it is text. An autolink
 * or inline HTML that starts first holds its backticks: they open no code
 * span. The runs are indexed by length first, so each opening run finds its
 * closing run by a binary search instead of a scan.
 */
export function codeSpans(source: string, from: number, to: number): Array<[number, number]> {
  const htmlEnd = inlineHtmlEnds(source, from, to);
  const runEnd = (at: number): number => {
    while (at < to && source[at] === '`') at++;
    return at;
  };
  // The start of every run of backticks, by its length, in order.
  const runs = new Map<number, number[]>();
  for (let at = from; at < to;) {
    if (source[at] !== '`') {
      at++;
      continue;
    }
    const after = runEnd(at);
    const starts = runs.get(after - at) ?? [];
    starts.push(at);
    runs.set(after - at, starts);
    at = after;
  }
  const spans: Array<[number, number]> = [];
  for (let at = from; at < to;) {
    if (source[at] === '\\') {
      at += 2;
      continue;
    }
    if (source[at] === '<') {
      at = htmlEnd(at) ?? at + 1;
      continue;
    }
    if (source[at] !== '`') {
      at++;
      continue;
    }
    const open = runEnd(at);
    const width = open - at;
    const close = firstAtOrAfter(runs.get(width) ?? [], open);
    if (close === undefined) {
      at = open;
    } else {
      spans.push([at, close + width]);
      at = close + width;
    }
  }
  return spans;
}

// The autolinks and the inline HTML that has no closing marker to search
// for, matched at a `<`: a URI or email autolink, an opening or closing tag.
const AUTOLINK_OR_TAG = new RegExp([
  /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.source,
  /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.source,
  /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.source,
  /<\/[A-Za-z][A-Za-z0-9-]*\s*>/.source,
].join('|'), 'y');

// Inline HTML that runs to a closing marker: a comment, a processing
// instruction, a declaration and a CDATA section.
const HTML_UNTIL: ReadonlyArray<readonly [RegExp, string]> = [
  [/<!--(?:-?>)?/y, '-->'],
  [/<\?/y, '?>'],
  [/<![A-Za-z]/y, '>'],
  [/<!\[CDATA\[/y, ']]>'],
];

/**
 * Where the autolink or inline HTML that starts at a `<` of `source`
 * between `from` and `to` ends, before `to`; undefined when none starts
 * there. The search reads only that range, and each closing marker is
 * searched for once per position it can be found from, so many openings
 * before one marker, or with none, cost no rescans.
 */
function inlineHtmlEnds(source: string, from: number, to: number): (at: number) => number | undefined {
  let text: string | undefined;
  const next = new Map<string, number>();
  const closer = (marker: string, start: number): number => {
    let found = next.get(marker);
    if (found === undefined || (found !== -1 && found < start)) {
      found = text!.indexOf(marker, start);
      next.set(marker, found);
    }
    return found;
  };
  return (at) => {
    text ??= source.slice(from, to);
    const offset = at - from;
    for (const [open, marker] of HTML_UNTIL) {
      open.lastIndex = offset;
      const opened = open.exec(text);
      if (!opened) continue;
      // `<!-->` and `<!--->` are whole comments.
      if (opened[0].endsWith('>')) return at + opened[0].length;
      const close = closer(marker, offset + opened[0].length);
      return close === -1 ? undefined : from + close + marker.length;
    }
    AUTOLINK_OR_TAG.lastIndex = offset;
    const match = AUTOLINK_OR_TAG.exec(text);
    return match ? at + match[0].length : undefined;
  };
}

/** The first of the ascending `values` that is at least `min`. */
function firstAtOrAfter(values: readonly number[], min: number): number | undefined {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < min) low = middle + 1;
    else high = middle;
  }
  return values[low];
}
