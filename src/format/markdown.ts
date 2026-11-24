// Parsing helpers for the format module: the Markdown tree with source
// positions, and the split between front matter and the body.

import { isDeepStrictEqual } from 'node:util';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown, type Extension } from 'mdast-util-from-markdown';
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
  const tree = fromMarkdown(body, { extensions: [gfm(), inlineBudget(), lazyBudget()], mdastExtensions: [gfmFromMarkdown(), ...mdastExtensions] });
  // Validate before returning the tree to any recursive renderer or comparer.
  visit(tree, () => {});
  return tree;
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
export function sameMarkdown(a: string, b: string): boolean {
  if (a === b) return true;
  return isDeepStrictEqual(comparable(a), comparable(b));
}

// Escapes of characters that open Linear's own syntax, which Markdown reads
// as text either way: `$$` math and `+++` collapsible sections.
const LINEAR_SYNTAX_ESCAPES: Readonly<Record<string, string>> = { '\\$': '', '\\+': '' };

/** The tree without source positions, destinations as Markdown renders them (`<a b.png>` is `a%20b.png`). */
function comparable(body: string): unknown {
  // Keep those escapes apart from the plain characters, so `\$$` and `$$` differ.
  // A list marker (with a task checkbox, if any) alone on its line opens a file block
  // in Linear (`* \n  [a](a.pdf)`), which Markdown reads as `* [a](a.pdf)`: keep that line apart too.
  const marked = nestedFileBlocksOnItemLine(body)
    .replace(/\\[$+]/g, (escape) => LINEAR_SYNTAX_ESCAPES[escape]!)
    .replace(/^([ \t>]*(?:[*+-]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?)[ \t]*$/gm, '$1 ');
  const tree = parse(marked);
  const strip = (node: Nodes): unknown => {
    const { position: _position, ...rest } = node;
    if ('url' in rest) rest.url = normalizeUri(rest.url);
    if ('children' in node) return { ...rest, children: node.children.map(strip) };
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
 * A link destination as Linear writes it: in angle brackets, with characters that would end it encoded, and a
 * backslash at its end doubled, so it cannot escape the closing bracket.
 */
export function linkDestination(url: string): string {
  const inner = destination(url.replace(/[<>\r\n]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`));
  return `<${inner}${trailingBackslashes(inner) % 2 === 1 ? '\\' : ''}>`;
}

/**
 * The number of backslashes that end `text`, counted from its end. A regular
 * expression for the run rescans it from each of its positions when another
 * character follows it.
 */
function trailingBackslashes(text: string): number {
  let at = text.length;
  while (at > 0 && text[at - 1] === '\\') at -= 1;
  return text.length - at;
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
