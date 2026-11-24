// `fix`: rewrites Markdown into the form Linear stores, so a round trip
// through Linear changes nothing. Block structure is written the way Linear
// writes it; inline text is copied from the source with a few targeted
// rewrites. A text with a construct Linear would lose or alter is left as it
// is: the author decides. The image place rules do not stop `fixText` (see
// IMAGE_PLACE_RULES); the `fix` command leaves a file with any finding.

import type { BlockContent, Definition, DefinitionContent, Link, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableRow } from 'mdast';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { nameToEmoji } from 'gemoji';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { lintText, paddingOverLimit, referencesOverLimit } from './lint.ts';
import { IMAGE_PLACE_RULES } from './rules.ts';
import { MarkdownLimitError, bracketedLabel, codeSpans, decodedDestinationPath, end, imageDestination, isCallout, isCalloutComment, joinFile, linkDestination, nestedFileBlocksOnItemLine, parse, quoteLines, sameMarkdown, splitFile, start, visit } from './markdown.ts';

export { imageDestination, linkDestination } from './markdown.ts';

/** What `fix` may know about the file beyond its text. */
export interface FixOptions {
  /**
   * Whether the file a relative link points to exists. The sync uploads a
   * linked file that exists, and Linear stores a link to an uploaded file
   * differently from a link it cannot resolve. Without this, every linked
   * file is taken to exist.
   */
  linkedFileExists?: (url: string) => boolean;
}

/**
 * Returns the text in Linear's form, or the text itself when lint finds a
 * construct Linear would lose or alter. Throws `MarkdownLimitError` when a
 * rewrite takes the text over the Markdown limits, which lint cannot see in
 * the source: an inline image that leaves its paragraph can expose a table
 * or reference links.
 */
export function fixText(text: string, options: FixOptions = {}): string {
  if (lintText('', text).some((finding) => !IMAGE_PLACE_RULES.has(finding.rule))) return text;
  const { head, body } = splitFile(text);
  return joinFile(head, fixBody(body.replace(/\r\n?/g, '\n'), options));
}

function fixBody(body: string, options: FixOptions): string {
  if (body.trim() === '') return '';
  let current = body;
  // A rewrite can expose another (an inline image leaves its paragraph):
  // repeat until the text no longer changes.
  for (let pass = 0; pass < 5; pass++) {
    const tree = parse(current);
    // Lint checked the source; a rewrite may expose a table or references it did not see.
    if (pass > 0 && (paddingOverLimit(tree) !== undefined || referencesOverLimit(tree, current) !== undefined)) throw new MarkdownLimitError('nodes');
    // The writer copies text by source offset. A node the parser left
    // without one (the bare-URL search inside text can, as in
    // `"www.example.com"`) would make it copy the wrong text: leave the
    // body as it came.
    if (hasUnplacedNode(tree)) return body;
    const next = new Writer(current, tree, options).root();
    if (next === current) return next;
    current = next;
  }
  return current;
}

type Edit = { from: number; to: number; text: string };

/** A container whose prefix starts each source line of its content: a quote, or a list item's indentation. */
type Container = { kind: 'quote' } | { kind: 'item'; indent: number };

// Characters that start a block when they open a line (`<` an HTML block).
const BLOCK_START = /^(?:[<>#*+\-=_`~|]|\d{1,9}[.)])/;

// A list marker that opens a text: a bullet or a number with its delimiter,
// followed by a space, a tab or the end of the line.
const LIST_MARKER_START = /^(?:[*+-]|\d{1,9}[.)])(?=[ \t\n]|$)/;

class Writer {
  private readonly definitions = new Map<string, Definition>();
  private readonly containers: Container[] = [];
  private readonly source: string;
  private readonly tree: Root;
  private readonly options: FixOptions;
  /** Where the table cell being written starts its text: an escape there stays. */
  private cellStart: number | undefined;
  /** The indent of the file block whose label is being written: its later lines carry no prefix for it. */
  private fileBlockIndent = 0;
  /** Whether the text being written is an autolink's, where a backslash escapes nothing. */
  private literal = false;
  /** The paragraph that follows a task item's checkbox: it does not start its line. */
  private taskParagraph: Paragraph | undefined;

  constructor(source: string, tree: Root, options: FixOptions) {
    this.source = source;
    this.tree = tree;
    this.options = options;
    visit(tree, (node) => {
      if (node.type === 'definition' && !this.definitions.has(node.identifier)) this.definitions.set(node.identifier, node);
    });
  }

  root(): string {
    return this.blocks(this.tree.children);
  }

  /**
   * Sibling blocks, one blank line apart, except that Linear writes a
   * callout's color comment directly above the callout. Reference
   * definitions are written inline instead.
   */
  private blocks(nodes: readonly (RootContent | BlockContent | DefinitionContent)[]): string {
    return this.writtenBlocks(nodes).text;
  }

  /**
   * The blocks as `blocks` writes them, and the lines (1-based) of the text
   * that belong to a code block among them. A block quote needs those lines
   * to write its blank code lines; taking them from the writer, not from a
   * parse of the written text, keeps nested quotes from parsing their
   * content once per level.
   */
  private writtenBlocks(nodes: readonly (RootContent | BlockContent | DefinitionContent)[]): { text: string; codeLines: Set<number> } {
    const written = nodes
      .filter((node) => node.type !== 'definition')
      .map((node) => ({ node, parts: this.block(node) }))
      .filter(({ parts }) => parts.length > 0);
    const codeLines = new Set<number>();
    // Lines are counted only up to the last code block: no later line is code.
    const lastCode = written.findLastIndex(({ node }) => node.type === 'code');
    let line = 1;
    const text = written
      .map(({ node, parts }, index) => {
        const next = written[index + 1];
        const block = parts.join('\n\n');
        const separator = next === undefined ? '' : isCalloutComment(node) && isCallout(next.node, this.source) ? '\n' : '\n\n';
        if (index <= lastCode) {
          const breaks = lineBreaks(block);
          if (node.type === 'code') for (let at = line; at <= line + breaks; at++) codeLines.add(at);
          line += breaks + separator.length;
        }
        return block + separator;
      })
      .join('');
    return { text, codeLines };
  }

  private block(node: RootContent | BlockContent | DefinitionContent): string[] {
    switch (node.type) {
      case 'paragraph':
        return this.paragraph(node);
      case 'heading':
        // A setext heading can span lines; an ATX heading is one line.
        return [`${'#'.repeat(node.depth)} ${joinLines(this.inline(node.children))}`.trimEnd()];
      case 'thematicBreak':
        return ['---'];
      case 'blockquote': {
        this.containers.push({ kind: 'quote' });
        const { text, codeLines } = this.writtenBlocks(node.children);
        this.containers.pop();
        return [quoteLines(text, codeLines)];
      }
      case 'list':
        return [this.list(node)];
      case 'code': {
        const info = [node.lang, node.meta].filter(Boolean).join(' ');
        // A backtick fence cannot carry a backtick in its info string; keep tildes then.
        const mark = info.includes('`') ? '~' : '`';
        const longest = Math.max(0, ...[...node.value.matchAll(mark === '`' ? /`+/g : /~+/g)].map((m) => m[0].length));
        const fence = mark.repeat(Math.max(3, longest + 1));
        return [`${fence}${info}\n${node.value}${node.value === '' ? '' : '\n'}${fence}`];
      }
      case 'html':
        return [node.value];
      case 'table':
        return [this.table(node)];
      default:
        // Nodes lint refuses (footnote definitions) never reach here; keep any other as written.
        return [this.source.slice(start(node), end(node))];
    }
  }

  /** A paragraph; `$$` math becomes a `math` fence, and an image shares no paragraph with text. */
  private paragraph(node: Paragraph): string[] {
    const raw = this.source.slice(start(node), end(node));
    const math = /^\$\$\n([\s\S]*)\n\$\$$/.exec(raw);
    if (math) return [`\`\`\`math\n${math[1]}\n\`\`\``];
    const isImage = (child: PhrasingContent): boolean => child.type === 'image' || child.type === 'imageReference';
    const images = node.children.filter(isImage).length;
    const hasText = node.children.some((child) => !isImage(child) && !(child.type === 'text' && child.value.trim() === ''));
    if (images === 0 || (!hasText && images === 1)) return [node === this.taskParagraph ? this.inline(node.children, 'continuation') : this.paragraphText(node.children)];
    // Linear holds images as blocks: text before and after an image becomes its own paragraph.
    const parts: PhrasingContent[][] = [[]];
    for (const child of node.children) {
      if (isImage(child)) parts.push([child], []);
      else parts.at(-1)!.push(child);
    }
    // The first part of a task item's paragraph follows its checkbox: it does not start its line.
    return parts
      .map((part, index) => (index === 0 && node === this.taskParagraph ? this.inline(part, 'continuation').trim() : this.paragraphText(part, true)))
      .filter((part) => part !== '');
  }

  /**
   * A paragraph's text, which starts a line. Text that starts like a list
   * marker gets its marker escaped: it was text only because it could not
   * interrupt a paragraph (`Note` / `1. 3. plum`, where `3. plum` stays the
   * item's text), and the blank line `fix` writes before the list would
   * make it a list; Linear reads it as one either way. `trim` drops the
   * spaces around a part split off at an image.
   */
  private paragraphText(children: readonly PhrasingContent[], trim = false): string {
    const text = trim ? this.inline(children, 'all').trim() : this.inline(children, 'all');
    if (children[0]?.type !== 'text') return text;
    const marker = LIST_MARKER_START.exec(text);
    if (marker === null) return text;
    const at = marker[0].length - 1;
    return `${text.slice(0, at)}\\${text.slice(at)}`;
  }

  private list(node: List, interruptsParagraph = false): string {
    return node.children
      .map((item, index) => {
        const marker = item.checked !== null && item.checked !== undefined ? `- [${item.checked ? 'X' : ' '}]` : node.ordered ? `${(node.start ?? 1) + index}.` : '*';
        return this.listItem(item, marker, interruptsParagraph && index === 0);
      })
      .join('\n');
  }

  private listItem(item: ListItem, marker: string, interruptsParagraph: boolean): string {
    // Content lines line up after the bullet or number, not after a checkbox.
    const indent = ' '.repeat(marker.split(' ')[0]!.length + 1);
    const [first] = item.children;
    const attachment = itemAttachment(item);
    // A link to a file that does not exist is not uploaded: Linear keeps it as a link.
    if (attachment && this.options.linkedFileExists?.(attachment.url) !== false) {
      const path = decodedDestinationPath(attachment.url);
      const bullet = marker === '*';
      const task = item.checked != null;
      // Linear puts MP3 links on the bullet or number line and below a
      // task checkbox. The WAV and Ogg inline forms are recorded for bullets.
      const inlineAudio = (!task && MP3.test(path)) || (bullet && WAV_OR_OGG.test(path));
      if (!inlineAudio) {
        this.fileBlockIndent = indent.length;
        this.containers.push({ kind: 'item', indent: (first?.position?.start.column ?? 1) - (item.position?.start.column ?? 1) });
        const label = this.inline(attachment.children);
        this.containers.pop();
        this.fileBlockIndent = 0;
        const destination = imageDestination(attachment.url);
        if (bullet && VIDEO.test(attachment.url.split(/[?#]/)[0]!)) return `${marker} [${label}](${destination})`;
        // An empty marker cannot interrupt the parent paragraph. A task
        // marker already has content, so its file block can stay below it.
        if (!interruptsParagraph || marker.startsWith('- ')) {
          return `${marker} \n${indent}[${label}](${destination})`;
        }
      }
    }
    if (first === undefined) return marker;
    this.containers.push({ kind: 'item', indent: (first.position?.start.column ?? 1) - (item.position?.start.column ?? 1) });
    if (item.checked !== null && item.checked !== undefined && first.type === 'paragraph') this.taskParagraph = first;
    // Blocks of an item are a blank line apart, but a nested list follows
    // its paragraph on the next line when it can interrupt that paragraph.
    // Ordered lists starting above or below 1, lists starting with an empty
    // item and existing file blocks need their blank line to stay separate
    // from the preceding paragraph.
    let content = '';
    item.children.forEach((child, index) => {
      const previous = item.children[index - 1];
      const interrupts = child.type === 'list'
        && previous?.type === 'paragraph'
        && (!child.ordered || (child.start ?? 1) === 1)
        && child.children[0]!.children.length > 0
        && !(child.position!.start.line > previous.position!.end.line + 1 && startsWithFileBlock(child));
      if (index > 0) content += interrupts ? '\n' : '\n\n';
      content += child.type === 'list' ? this.list(child, interrupts) : this.block(child).join('\n\n');
    });
    this.containers.pop();
    return `${marker} ${prefixLines(content, indent, '').slice(indent.length)}`;
  }

  private table(node: Table): string {
    const width = node.children[0]?.children.length ?? 0;
    const row = (cells: TableRow): string => {
      const texts = Array.from({ length: width }, (_, index) => {
        const cell = cells.children[index];
        // Linear reads a hash that starts a body cell as heading syntax, so
        // an escaped one keeps its escape (lint reports a bare one).
        const first = cell?.children[0];
        this.cellStart = first ? start(first) : undefined;
        const text = cell ? this.inline(cell.children).trim() : '';
        this.cellStart = undefined;
        // Linear writes a header cell containing only a hash as `\#`.
        return text === '#' ? '\\#' : text;
      });
      return `| ${texts.join(' | ')} |`;
    };
    const [header, ...rows] = node.children;
    if (!header) return '';
    return [row(header), `| ${Array.from({ length: width }, () => '--').join(' | ')} |`, ...rows.map(row)].join('\n');
  }

  /**
   * Inline content copied from the source with targeted rewrites. The line
   * prefixes of the containers (quote markers, list indentation) are dropped,
   * since the caller writes its own, and so is the insignificant indentation
   * of continuation lines outside code spans.
   *
   * In a paragraph Linear escapes a literal `-` or `*` that starts a line,
   * as in `\--` or `\*note`: `lineStarts` says which lines start one, all
   * of them or only the continuation lines (a task item's first line
   * follows its checkbox).
   */
  private inline(children: readonly PhrasingContent[], lineStarts: 'none' | 'continuation' | 'all' = 'none'): string {
    if (children.length === 0) return '';
    const from = start(children[0]!);
    const to = end(children.at(-1)!);
    const edits: Edit[] = [];
    for (const child of children) this.inlineEdits(child, edits);
    const code: Array<[number, number]> = [];
    const texts: Array<[number, number]> = [];
    const html: Array<[number, number]> = [];
    for (const child of children) {
      visit(child, (node) => {
        if (node.type === 'inlineCode') code.push([start(node), end(node)]);
        if (node.type === 'text') texts.push([start(node), end(node)]);
        if (node.type === 'html') html.push([start(node), end(node)]);
      });
    }
    if (lineStarts === 'none') return this.rewritten(from, to, edits, code);
    return this.rewritten(from, to, edits, code, { texts, html, first: lineStarts === 'all' });
  }

  /**
   * The source from `from` to `to` with `edits` made and each continuation
   * line's container prefixes removed; `code` holds the code spans, where a
   * line keeps its indentation. In paragraph text, `paragraph` holds its text
   * nodes, where a `-` or `*` that starts a line is escaped, its inline HTML,
   * where nothing is escaped, and whether the text's first line starts one.
   */
  private rewritten(
    from: number,
    to: number,
    edits: Edit[],
    code: ReadonlyArray<readonly [number, number]>,
    paragraph?: { texts: ReadonlyArray<readonly [number, number]>; html: ReadonlyArray<readonly [number, number]>; first: boolean },
  ): string {
    const inside = (ranges: ReadonlyArray<readonly [number, number]>, at: number): boolean => ranges.some(([a, b]) => a <= at && at < b);
    if (paragraph?.first) this.escapeLineStart(from, paragraph.texts, edits);
    for (let at = this.source.indexOf('\n', from); at !== -1 && at < to; at = this.source.indexOf('\n', at + 1)) {
      const continuation = this.continuation(at + 1, inside(code, at), paragraph !== undefined && !inside(paragraph.html, at));
      edits.push(continuation);
      if (paragraph === undefined || continuation.text !== '') continue;
      // Indentation kept before a `-` or `*` is not needed once it is escaped.
      const content = continuation.to + /^[ \t]*/.exec(this.source.slice(continuation.to, to))![0].length;
      if (this.escapeLineStart(content, paragraph.texts, edits)) continuation.to = content;
    }
    let out = '';
    let at = from;
    for (const edit of edits.sort((a, b) => a.from - b.from)) {
      if (edit.from < at) continue; // nested in an edit already made
      out += this.source.slice(at, edit.from) + edit.text;
      at = edit.to;
    }
    out += this.source.slice(at, to);
    return out;
  }

  /**
   * Escapes a literal `-` or `*` at `at`, a line's first content character,
   * as Linear does, and says whether it did. A `*` followed by another one
   * is left alone: it shares a delimiter run with emphasis (`***(a)*`), and
   * an escape would change which asterisks pair.
   */
  private escapeLineStart(at: number, texts: ReadonlyArray<readonly [number, number]>, edits: Edit[]): boolean {
    const char = this.source[at];
    if (char !== '-' && (char !== '*' || this.source[at + 1] === '*')) return false;
    if (!texts.some(([a, b]) => a <= at && at < b)) return false;
    edits.push({ from: at, to: at, text: '\\' });
    return true;
  }

  /** The edit that removes a continuation line's container prefixes, starting at `lineStart`; `paragraph` when the line is a paragraph's text. */
  private continuation(lineStart: number, inCode: boolean, paragraph = false): Edit {
    let at = lineStart;
    const line = this.source.slice(lineStart, this.source.indexOf('\n', lineStart) === -1 ? undefined : this.source.indexOf('\n', lineStart));
    for (const container of this.containers) {
      const rest = this.source.slice(at, lineStart + line.length);
      const prefix = container.kind === 'quote' ? /^ {0,3}> ?/.exec(rest) : new RegExp(`^ {0,${container.indent}}`).exec(rest);
      // A lazy line carries no further prefixes. In an item, that is a line
      // indented less than the item's content: its spaces are its own, and
      // in a code span they are code text.
      if (!prefix || (container.kind === 'item' && prefix[0].length < container.indent)) break;
      at += prefix[0].length;
    }
    // A lazy line of only `-` or `=` continues the paragraph text. Under
    // the prefix the caller writes, it would underline the paragraph as a
    // setext heading. In paragraph text Linear escapes it (`\--`, `\==`);
    // in a link label its form is not recorded, and indented four spaces
    // past the content's column, it stays text. Its own indentation goes: a
    // tab after the prefix may span fewer columns. In a code span the
    // indentation would be code text, but a line ending there reads as a
    // space: the line joins the one before. Outside a container no prefix
    // is written: the line stays as it is.
    const underline = /^([ \t]*)(?:-+|=+)[ \t]*$/.exec(this.source.slice(at, lineStart + line.length));
    if (underline && (this.containers.length > 0 || this.fileBlockIndent > 0)) {
      if (inCode) return { from: lineStart - 1, to: at, text: ' ' };
      return { from: lineStart, to: at + underline[1]!.length, text: paragraph ? '\\' : ' '.repeat(4 + this.fileBlockIndent) };
    }
    if (!inCode) {
      const rest = this.source.slice(at, lineStart + line.length);
      const space = /^[ \t]*/.exec(rest)![0];
      // Indentation that keeps `>` or `#` literal stays, so the text does not turn into a block.
      if (!BLOCK_START.test(rest.slice(space.length)) || space.length === 0) at += space.length;
    }
    return { from: lineStart, to: at, text: '' };
  }

  private inlineEdits(node: PhrasingContent, edits: Edit[]): void {
    const from = start(node);
    const to = end(node);
    switch (node.type) {
      case 'emphasis':
      case 'strong': {
        const width = node.type === 'strong' ? 2 : 1;
        if (this.source[from] === '_') {
          const mark = '*'.repeat(width);
          edits.push({ from, to: from + width, text: mark }, { from: to - width, to, text: mark });
        }
        for (const child of node.children) this.inlineEdits(child, edits);
        return;
      }
      case 'delete':
        for (const child of node.children) this.inlineEdits(child, edits);
        return;
      case 'link': {
        // An autolink (`<url>` or a bare URL) has no brackets in the source:
        // its text becomes a label, where a backslash would escape.
        const autolink = this.source[from] !== '[';
        this.literal = autolink;
        edits.push({ from, to, text: this.link(node.children, node.url) });
        this.literal = false;
        return;
      }
      case 'linkReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: this.link(node.children, definition.url) });
        return;
      }
      case 'image':
        edits.push({ from, to, text: `![${this.label(from + 1, to)}](${imageDestination(node.url)})` });
        return;
      case 'imageReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: `![${this.label(from + 1, to)}](${imageDestination(definition.url)})` });
        return;
      }
      case 'text':
        edits.push(...(this.literal ? literalEdits(this.source, from, to) : textEdits(this.source, from, to, this.cellStart)));
        return;
      default:
        return;
    }
  }

  /** Linear writes every link destination in angle brackets, without a title. */
  private link(children: readonly PhrasingContent[], url: string): string {
    return `[${this.inline(children)}](${linkDestination(url)})`;
  }

  /**
   * The bracketed label that opens at `open` (a `[`) and closes before
   * `limit`, without its brackets: as written, except that its continuation
   * lines lose their container prefixes, as in `inline`.
   */
  private label(open: number, limit: number): string {
    const from = open + 1;
    const to = from + bracketedLabel(this.source, open, limit).length;
    return this.rewritten(from, to, [], codeSpans(this.source, from, to));
  }
}

/**
 * Rewrites inside plain text: entities, emoji shortcodes and backslashes
 * Linear spells differently. `keepAt` marks the start of a table cell, where
 * an escaped hash stays.
 */
function textEdits(source: string, from: number, to: number, keepAt?: number): Edit[] {
  const edits: Edit[] = [];
  const raw = source.slice(from, to);
  // Character references become the characters when that cannot make markup:
  // characters outside ASCII, and `&` when no reference follows it. After an
  // escaped `&` there is no reference: the text stays as written.
  for (const match of raw.matchAll(CHARACTER_REFERENCE)) {
    if (escaped(raw, match.index)) continue;
    const char = decodeEntity(match[0]);
    const after = raw.slice(match.index + match[0].length);
    if (char === undefined || char.trim() === '') continue;
    if (char === '&' ? /^[A-Za-z0-9#]+;/.test(after) : char.codePointAt(0)! < 0x80) continue;
    edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: char });
  }
  // `:name:` shortcodes Linear knows become the emoji, unless the first colon is escaped.
  for (const { index, length, emoji } of emojiShortcodes(raw)) {
    if (!escaped(raw, index)) edits.push({ from: from + index, to: from + index + length, text: emoji });
  }
  // A backslash before a letter is a literal backslash; Linear doubles it.
  // An escaped `#` inside a line needs no escape and Linear drops it; at the
  // start of a line's content or a table cell, or at the line's end, it
  // stays (heading syntax).
  for (const match of raw.matchAll(/\\(.)/g)) {
    const at = from + match.index;
    const next = match[1]!;
    if (/[!-/:-@[-`{-~]/.test(next)) {
      if (next === '#' && at !== keepAt && insideLine(source, at)) edits.push({ from: at, to: at + 1, text: '' });
    } else {
      edits.push({ from: at, to: at + 1, text: '\\\\' });
    }
  }
  return edits;
}

/**
 * Rewrites inside an autolink's text written as a link label, so the label
 * reads exactly as the URL. Every backslash is literal there, so each is
 * doubled (as Linear doubles one before a letter). Every character that is
 * inline syntax in a label is escaped: brackets and backticks (a backslash
 * left single at the label's end would escape its closing bracket, and a
 * backtick could open a code span that runs past it; either breaks the
 * link); `*`, `_` and `~`, which would make emphasis or strikethrough; and
 * the `&` of a character reference and the first colon of an emoji
 * shortcode, which would turn into the character or the emoji.
 */
function literalEdits(source: string, from: number, to: number): Edit[] {
  const raw = source.slice(from, to);
  const escape = new Set<number>();
  for (let at = 0; at < raw.length; at++) if (LABEL_SYNTAX.has(raw[at]!)) escape.add(at);
  for (const match of raw.matchAll(CHARACTER_REFERENCE)) escape.add(match.index);
  // Every colon that opens a shortcode is escaped, overlapping ones too
  // (`:x:tada:`), as found in the label the next run reads: an escaped `_`
  // ends a name, so `:a_b:tada:` holds `:tada:` there.
  const rawAt: number[] = [];
  let label = '';
  for (let at = 0; at < raw.length; at++) {
    if (escape.has(at)) label += '\\';
    rawAt[label.length] = at;
    label += raw[at];
  }
  for (const match of label.matchAll(/:(?=([a-z0-9_+-]+):)/g)) {
    if (Object.hasOwn(nameToEmoji, match[1]!)) escape.add(rawAt[match.index]!);
  }
  const edits: Edit[] = [];
  for (const at of [...escape].sort((a, b) => a - b)) edits.push({ from: from + at, to: from + at + 1, text: `\\${raw[at]}` });
  return edits;
}

/** Characters an autolink's label escapes wherever they stand. */
const LABEL_SYNTAX: ReadonlySet<string> = new Set(['\\', '[', ']', '`', '*', '_', '~']);

/** A character reference as Markdown spells one; whether it names a character is decided apart. */
const CHARACTER_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** The `:name:` shortcodes in `raw` that name an emoji Linear knows, with their offsets. */
function* emojiShortcodes(raw: string): Generator<{ index: number; length: number; emoji: string }> {
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = Object.hasOwn(nameToEmoji, match[1]!) ? nameToEmoji[match[1]!] : undefined;
    if (emoji) yield { index: match.index, length: match[0].length, emoji };
  }
}

/** Whether the character at `at` follows an odd run of backslashes, which escapes it. */
function escaped(text: string, at: number): boolean {
  let run = 0;
  while (text[at - 1 - run] === '\\') run++;
  return run % 2 === 1;
}

/** Whether a node below the root has no source position. */
function hasUnplacedNode(tree: Root): boolean {
  let unplaced = false;
  visit(tree, (node) => {
    if (node.position === undefined) unplaced = true;
  });
  return unplaced;
}

/** The character a reference stands for, or undefined when it names none. */
function decodeEntity(reference: string): string | undefined {
  const name = reference.slice(1, -1);
  if (!name.startsWith('#')) {
    const decoded = decodeNamedCharacterReference(name);
    return decoded === false ? undefined : decoded;
  }
  const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  // Like Markdown, an invalid code point stands for nothing we write.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/** Whether the character at `at` has line content before it and after it, ignoring container prefixes. */
function insideLine(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at);
  const before = source.slice(lineStart, at).replace(/^(?:[ \t]*(?:>|[*+-](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/, '');
  const after = source.slice(at + 2, lineEnd);
  return before !== '' && !/^[ \t#]*$/.test(after);
}

/**
 * A text made from a Linear document's `content`, in the form `fix` (and so
 * the `linear-format` hook) leaves unchanged. Linear's own text is not always
 * that form: it can store a table cell with a trailing space (`| a  |`).
 * Pass the whole file, front matter included, as the hook sees it, and
 * `inRepository`, whether a relative destination names a file of the
 * repository the file is written to (`linkedFileCheck`), as the hook checks it.
 *
 * Only a re-spelling is taken: when `fix` would change the document itself
 * (it writes a setext heading's two lines as one), the file would no longer
 * hold what Linear holds, and the text stays as it is.
 */
export function fixLinearText(linearText: string, content: string, inRepository: (url: string) => boolean): string {
  // Read a nested file block as Linear holds it, not as the parent's text.
  const split = splitFile(linearText);
  const text = joinFile(split.head, nestedFileBlocksOnItemLine(split.body));
  // A relative link or image still in Linear's content was not uploaded, so
  // its file is not there: Linear keeps such a link as a link, not as a file
  // block, and so does a repair that turns such an image into a link.
  // Compared as renderers read them: a later pass sees a destination in fix's spelling (`a|b` as `a%7Cb`).
  const notUploaded = relativeUrls(content, new Set(['link', 'image']));
  const notUploadedUris = new Set([...notUploaded].map((url) => normalizeUri(url)));
  const uploaded = (url: string): boolean => !notUploadedUris.has(normalizeUri(url));
  const linear = { linkedFileExists: uploaded };
  const fixed = fixText(text, linear);
  if (fixed !== text && !sameMarkdown(splitFile(fixed).body, splitFile(text).body)) return text;
  // The hook cannot tell which files were uploaded. It can write a list item
  // holding only a link to a repository file as a file block. Linear stores
  // such a block as a link if it holds no upload for the file. Take the
  // hook's form only if sending it back still yields Linear's form.
  if (![...notUploaded].some((url) => !/\.md$/i.test(url.split(/[?#]/)[0]!) && inRepository(url))) return fixed;
  const hooked = fixText(text, { linkedFileExists: (url) => uploaded(url) || inRepository(url) });
  return fixText(hooked, linear) === fixed ? hooked : fixed;
}

/**
 * The body as Linear stores it after a write, for file blocks whose link is
 * still relative: Linear holds no upload of such a file, and stores the
 * block as the link on the item's line (`* [Name](<path>)`), so the text sent
 * reads as the same Markdown as what Linear then holds. Every other text
 * stays as written.
 */
export function relativeFileBlocksAsLinks(body: string): string {
  const joins: Array<{ from: number; to: number }> = [];
  visit(parse(body), (node) => {
    if (node.type !== 'listItem' || node.children.length !== 1) return;
    const [paragraph] = node.children;
    if (paragraph?.type !== 'paragraph' || attachmentLink(paragraph) === undefined) return;
    // A file block: the marker alone on its line, and the link on the next.
    const gap = /[ \t]*\r?\n[ \t>]*$/.exec(body.slice(start(node), start(paragraph)));
    if (gap !== null) joins.push({ from: start(paragraph) - gap[0].length, to: start(paragraph) });
  });
  // One pass over the joins, in text order: cutting each out of the whole
  // result would copy the text once per file block.
  const parts: string[] = [];
  let at = 0;
  for (const { from, to } of joins) {
    parts.push(body.slice(at, from), ' ');
    at = to;
  }
  parts.push(body.slice(at));
  return parts.join('');
}

/** The destinations of relative links in the text (no scheme, not an anchor), as written. */
export function relativeLinkUrls(text: string): Set<string> {
  return relativeUrls(text, new Set(['link']));
}

/** The relative destinations (no scheme, not an anchor) of the given node types in the text, as written. */
function relativeUrls(text: string, types: ReadonlySet<string>): Set<string> {
  const urls = new Set<string>();
  visit(parse(splitFile(text).body), (node) => {
    if ((node.type === 'link' || node.type === 'image') && types.has(node.type) && !/^[a-z][a-z0-9+.-]*:/i.test(node.url) && !node.url.startsWith('#')) urls.add(node.url);
  });
  return urls;
}

/** Video files Linear stores as a video block (recorded for these three; other types are unconfirmed). */
const VIDEO = /\.(?:mp4|mov|webm)$/i;

const MP3 = /\.mp3$/i;
const WAV_OR_OGG = /\.(?:wav|ogg)$/i;

function startsWithFileBlock(list: List): boolean {
  const [item] = list.children;
  if (item === undefined) return false;
  const link = itemAttachment(item);
  return link !== undefined && link.position!.start.line > item.position!.start.line;
}

function itemAttachment(item: ListItem): Link | undefined {
  const [first] = item.children;
  return first?.type === 'paragraph' && item.children.length === 1 ? attachmentLink(first) : undefined;
}

/** A paragraph that holds only a link to a relative file other than Markdown: an attachment. */
function attachmentLink(paragraph: Paragraph): Link | undefined {
  const [only] = paragraph.children;
  if (paragraph.children.length !== 1 || only?.type !== 'link') return undefined;
  const url = only.url.split('#')[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || /\.md$/i.test(url) || url === '') return undefined;
  return only;
}

/** Prefixes every line; empty lines get `empty` instead. */
function prefixLines(text: string, prefix: string, empty: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? empty : prefix + line))
    .join('\n');
}

/**
 * Joins lines with one space, dropping the spaces and tabs around each line
 * break. An index scan keeps it linear: a regular expression that looks for
 * the break after a run of spaces rescans the run from each of its positions.
 */
function joinLines(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      let start = 0;
      let end = line.length;
      if (index > 0) while (start < end && isSpaceOrTab(line[start]!)) start += 1;
      if (index < lines.length - 1) while (end > start && isSpaceOrTab(line[end - 1]!)) end -= 1;
      return line.slice(start, end);
    })
    .join(' ');
}

/** The number of line breaks in the text. */
function lineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

function isSpaceOrTab(char: string): boolean {
  return char === ' ' || char === '\t';
}
