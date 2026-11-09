// `fix`: rewrites Markdown into the form Linear stores, so a round trip
// through Linear changes nothing. Block structure is written the way Linear
// writes it; inline text is copied from the source with a few targeted
// rewrites. A file with a lint finding is left as it is: the author decides.

import type { BlockContent, Definition, DefinitionContent, Link, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableRow } from 'mdast';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { nameToEmoji } from 'gemoji';
import { lintText } from './lint.ts';
import { end, parse, resolveTarget, splitFile, start, visit } from './markdown.ts';

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
 * The existence check `fix` takes, by the sync's own rule: a link names a
 * file the sync uploads when it resolves to a repository path, as the sync
 * resolves it, and that path is a file.
 */
export function linkedFileCheck(documentPath: string, isFile: (path: string) => boolean): (url: string) => boolean {
  return (url) => {
    const target = resolveTarget(documentPath, url);
    return target !== null && isFile(target);
  };
}

/** Returns the text in Linear's form, or the text itself when lint finds a problem. */
export function fixText(text: string, options: FixOptions = {}): string {
  if (lintText('', text).length > 0) return text;
  const { head, body } = splitFile(text);
  const fixed = fixBody(body.replace(/\r\n?/g, '\n'), options);
  return head + fixed;
}

function fixBody(body: string, options: FixOptions): string {
  if (body.trim() === '') return '';
  let current = body;
  // A rewrite can expose another (an inline image leaves its paragraph):
  // repeat until the text no longer changes.
  for (let pass = 0; pass < 5; pass++) {
    const next = new Writer(current, parse(current), options).root();
    if (next === current) return next;
    current = next;
  }
  return current;
}

type Edit = { from: number; to: number; text: string };

/** A container whose prefix starts each source line of its content: a quote, or a list item's indentation. */
type Container = { kind: 'quote' } | { kind: 'item'; indent: number };

// Characters that start a block when they open a line.
const BLOCK_START = /^(?:[>#*+\-=_`~|]|\d{1,9}[.)])/;

class Writer {
  private readonly definitions = new Map<string, Definition>();
  private readonly containers: Container[] = [];
  private readonly source: string;
  private readonly tree: Root;
  private readonly options: FixOptions;

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

  /** Sibling blocks, one blank line apart. Reference definitions are written inline instead. */
  private blocks(nodes: readonly (RootContent | BlockContent | DefinitionContent)[]): string {
    return nodes
      .filter((node) => node.type !== 'definition')
      .flatMap((node) => this.block(node))
      .join('\n\n');
  }

  private block(node: RootContent | BlockContent | DefinitionContent): string[] {
    switch (node.type) {
      case 'paragraph':
        return this.paragraph(node);
      case 'heading':
        // A setext heading can span lines; an ATX heading is one line.
        return [`${'#'.repeat(node.depth)} ${this.inline(node.children).replace(/[ \t]*\n[ \t]*/g, ' ')}`.trimEnd()];
      case 'thematicBreak':
        return ['---'];
      case 'blockquote': {
        this.containers.push({ kind: 'quote' });
        const content = this.blocks(node.children);
        this.containers.pop();
        return [prefixLines(content, '> ', '>')];
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
    if (images === 0 || (!hasText && images === 1)) return [this.inline(node.children)];
    // Linear holds images as blocks: text before and after an image becomes its own paragraph.
    const parts: PhrasingContent[][] = [[]];
    for (const child of node.children) {
      if (isImage(child)) parts.push([child], []);
      else parts.at(-1)!.push(child);
    }
    return parts.map((part) => this.inline(part).trim()).filter((part) => part !== '');
  }

  private list(node: List): string {
    return node.children
      .map((item, index) => {
        const marker = item.checked !== null && item.checked !== undefined ? `- [${item.checked ? 'X' : ' '}]` : node.ordered ? `${(node.start ?? 1) + index}.` : '*';
        return this.listItem(item, marker);
      })
      .join('\n');
  }

  private listItem(item: ListItem, marker: string): string {
    // Content lines line up after the bullet or number, not after a checkbox.
    const indent = ' '.repeat(marker.split(' ')[0]!.length + 1);
    const [first] = item.children;
    const attachment = first?.type === 'paragraph' && item.children.length === 1 ? attachmentLink(first) : undefined;
    // A link to a file that does not exist is not uploaded: Linear keeps it as a link.
    if (attachment && this.options.linkedFileExists?.(attachment.url) !== false) {
      const label = this.inline(attachment.children);
      const destination = imageDestination(attachment.url);
      // Linear turns a list item holding only a link to an uploaded file into
      // a block: a video player for a video, which it writes on the item's
      // line, and a file block for any other file, which it writes below.
      // The video form is recorded for bullet items only.
      if (marker === '*' && VIDEO.test(attachment.url.split(/[?#]/)[0]!)) return `${marker} [${label}](${destination})`;
      return `${marker} \n${indent}[${label}](${destination})`;
    }
    if (first === undefined) return marker;
    this.containers.push({ kind: 'item', indent: (first.position?.start.column ?? 1) - (item.position?.start.column ?? 1) });
    // Blocks of an item are a blank line apart, but a nested list follows
    // its paragraph on the next line. Lint refuses an item that starts with
    // another block, so the first block is a paragraph.
    let content = '';
    item.children.forEach((child, index) => {
      if (index > 0) content += child.type === 'list' && item.children[index - 1]?.type === 'paragraph' ? '\n' : '\n\n';
      content += this.block(child).join('\n\n');
    });
    this.containers.pop();
    return `${marker} ${prefixLines(content, indent, '').slice(indent.length)}`;
  }

  private table(node: Table): string {
    const width = node.children[0]?.children.length ?? 0;
    const row = (cells: TableRow, isHeader: boolean): string => {
      const texts = Array.from({ length: width }, (_, index) => {
        const cell = cells.children[index];
        const text = cell ? this.inline(cell.children).trim() : '';
        // Linear escapes a header cell containing only a hash. Apply this
        // after inline rewrites, which drop an unnecessary hash escape.
        return isHeader && text === '#' ? '\\#' : text;
      });
      return `| ${texts.join(' | ')} |`;
    };
    const [header, ...rows] = node.children;
    if (!header) return '';
    return [row(header, true), `| ${Array.from({ length: width }, () => '--').join(' | ')} |`, ...rows.map((cells) => row(cells, false))].join('\n');
  }

  /**
   * Inline content copied from the source with targeted rewrites. The line
   * prefixes of the containers (quote markers, list indentation) are dropped,
   * since the caller writes its own, and so is the insignificant indentation
   * of continuation lines outside code spans.
   */
  private inline(children: readonly PhrasingContent[]): string {
    if (children.length === 0) return '';
    const from = start(children[0]!);
    const to = end(children.at(-1)!);
    const edits: Edit[] = [];
    for (const child of children) this.inlineEdits(child, edits);
    const code: Array<[number, number]> = [];
    for (const child of children) {
      visit(child, (node) => {
        if (node.type === 'inlineCode') code.push([start(node), end(node)]);
      });
    }
    for (let at = this.source.indexOf('\n', from); at !== -1 && at < to; at = this.source.indexOf('\n', at + 1)) {
      edits.push(this.continuation(at + 1, code.some(([a, b]) => a <= at && at < b)));
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

  /** The edit that removes a continuation line's container prefixes, starting at `lineStart`. */
  private continuation(lineStart: number, inCode: boolean): Edit {
    let at = lineStart;
    const line = this.source.slice(lineStart, this.source.indexOf('\n', lineStart) === -1 ? undefined : this.source.indexOf('\n', lineStart));
    for (const container of this.containers) {
      const rest = this.source.slice(at, lineStart + line.length);
      const prefix = container.kind === 'quote' ? /^ {0,3}> ?/.exec(rest) : new RegExp(`^ {0,${container.indent}}`).exec(rest);
      if (!prefix) break; // a lazy line carries no further prefixes
      at += prefix[0].length;
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
      case 'link':
        edits.push({ from, to, text: this.link(node.children, node.url) });
        return;
      case 'linkReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: this.link(node.children, definition.url) });
        return;
      }
      case 'image':
        edits.push({ from, to, text: `![${this.label(from + 1)}](${imageDestination(node.url)})` });
        return;
      case 'imageReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: `![${this.label(from + 1)}](${imageDestination(definition.url)})` });
        return;
      }
      case 'text':
        edits.push(...textEdits(this.source, from, to));
        return;
      default:
        return;
    }
  }

  /** Linear writes every link destination in angle brackets, without a title. */
  private link(children: readonly PhrasingContent[], url: string): string {
    return `[${this.inline(children)}](<${destination(url).replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
  }

  /** The bracketed label that opens at `open` (a `[`), as written, without its brackets. */
  private label(open: number): string {
    let depth = 0;
    for (let at = open; at < this.source.length; at++) {
      const char = this.source[at];
      if (char === '\\') at++;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) return this.source.slice(open + 1, at);
    }
    return '';
  }
}

/** Rewrites inside plain text: entities, emoji shortcodes and backslashes Linear spells differently. */
function textEdits(source: string, from: number, to: number): Edit[] {
  const edits: Edit[] = [];
  const raw = source.slice(from, to);
  // Character references become the characters when that cannot make markup:
  // characters outside ASCII, and `&` when no reference follows it.
  for (const match of raw.matchAll(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g)) {
    const char = decodeEntity(match[0]);
    const after = raw.slice(match.index + match[0].length);
    if (char === undefined || char.trim() === '') continue;
    if (char === '&' ? /^[A-Za-z0-9#]+;/.test(after) : char.codePointAt(0)! < 0x80) continue;
    edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: char });
  }
  // `:name:` shortcodes Linear knows become the emoji.
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = Object.hasOwn(nameToEmoji, match[1]!) ? nameToEmoji[match[1]!] : undefined;
    if (emoji) edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: emoji });
  }
  // A backslash before a letter is a literal backslash; Linear doubles it.
  // An escaped `#` inside a line needs no escape and Linear drops it; at the
  // start of a line's content or at its end it stays (heading syntax).
  for (const match of raw.matchAll(/\\(.)/g)) {
    const at = from + match.index;
    const next = match[1]!;
    if (/[!-/:-@[-`{-~]/.test(next)) {
      if (next === '#' && insideLine(source, at)) edits.push({ from: at, to: at + 1, text: '' });
    } else {
      edits.push({ from: at, to: at + 1, text: '\\\\' });
    }
  }
  return edits;
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

/** Linear writes image and file destinations without angle brackets: characters that would end one are encoded. */
function imageDestination(url: string): string {
  return destination(url).replace(/[<>()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The destinations of relative links in the text (no scheme, not an anchor), as written. */
export function relativeLinkUrls(text: string): Set<string> {
  const urls = new Set<string>();
  visit(parse(splitFile(text).body), (node) => {
    if (node.type === 'link' && !/^[a-z][a-z0-9+.-]*:/i.test(node.url) && !node.url.startsWith('#')) urls.add(node.url);
  });
  return urls;
}

/** Video files Linear stores as a video block (recorded for these three; other types are unconfirmed). */
const VIDEO = /\.(?:mp4|mov|webm)$/i;

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
