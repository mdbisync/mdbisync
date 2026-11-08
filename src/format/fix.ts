// `fix`: rewrites Markdown into the form Linear stores, so a round trip
// through Linear changes nothing. Block structure is written the way Linear
// writes it; inline text is copied from the source with a few targeted
// rewrites. A file with a lint finding is left as it is: the author decides.

import type { BlockContent, Definition, DefinitionContent, Link, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableRow } from 'mdast';
import { nameToEmoji } from 'gemoji';
import { lintText } from './lint.ts';
import { end, parse, splitFile, start, visit } from './markdown.ts';

/** Returns the text in Linear's form, or the text itself when lint finds a problem. */
export function fixText(text: string): string {
  if (lintText('', text).length > 0) return text;
  const { head, body } = splitFile(text);
  const fixed = fixBody(body.replace(/\r\n?/g, '\n'));
  return head + fixed;
}

function fixBody(body: string): string {
  if (body.trim() === '') return '';
  let current = body;
  // A rewrite can expose another (an inline image leaves its paragraph):
  // repeat until the text no longer changes.
  for (let pass = 0; pass < 5; pass++) {
    const next = new Writer(current, parse(current)).root();
    if (next === current) return next;
    current = next;
  }
  return current;
}

type Edit = { from: number; to: number; text: string };

class Writer {
  private readonly definitions = new Map<string, Definition>();
  private readonly source: string;
  private readonly tree: Root;

  constructor(source: string, tree: Root) {
    this.source = source;
    this.tree = tree;
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
        return [`${'#'.repeat(node.depth)} ${this.inline(node.children)}`.trimEnd()];
      case 'thematicBreak':
        return ['---'];
      case 'blockquote':
        return [prefixLines(this.blocks(node.children), '> ', '>')];
      case 'list':
        return [this.list(node)];
      case 'code': {
        const longest = Math.max(0, ...[...node.value.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        const info = [node.lang, node.meta].filter(Boolean).join(' ');
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
    if (attachment) {
      // Linear turns a list item holding only a link to a file into a file block.
      return `${marker} \n${indent}[${this.inline(attachment.children)}](${attachment.url})`;
    }
    if (first === undefined) return marker;
    // Blocks of an item are a blank line apart, but a nested list follows
    // its paragraph on the next line. Lint refuses an item that starts with
    // another block, so the first block is a paragraph.
    let content = '';
    item.children.forEach((child, index) => {
      if (index > 0) content += child.type === 'list' && item.children[index - 1]?.type === 'paragraph' ? '\n' : '\n\n';
      content += this.block(child).join('\n\n');
    });
    return `${marker} ${prefixLines(content, indent, '').slice(indent.length)}`;
  }

  private table(node: Table): string {
    const width = node.children[0]?.children.length ?? 0;
    const row = (cells: TableRow): string => {
      const texts = Array.from({ length: width }, (_, index) => {
        const cell = cells.children[index];
        return cell ? this.inline(cell.children).trim() : '';
      });
      return `| ${texts.join(' | ')} |`;
    };
    const [header, ...rows] = node.children;
    if (!header) return '';
    return [row(header), `| ${Array.from({ length: width }, () => '--').join(' | ')} |`, ...rows.map(row)].join('\n');
  }

  /**
   * Inline content copied from the source with targeted rewrites. Line
   * prefixes of containers (quote markers, list indentation) and leading
   * spaces of continuation lines are dropped; the caller writes its own.
   */
  private inline(children: readonly PhrasingContent[]): string {
    if (children.length === 0) return '';
    const from = start(children[0]!);
    const to = end(children.at(-1)!);
    const edits: Edit[] = [];
    for (const child of children) this.inlineEdits(child, edits);
    let out = '';
    let at = from;
    for (const edit of edits.sort((a, b) => a.from - b.from)) {
      if (edit.from < at) continue; // nested in an edit already made
      out += this.source.slice(at, edit.from) + edit.text;
      at = edit.to;
    }
    out += this.source.slice(at, to);
    return out
      .split('\n')
      .map((text, index) => (index === 0 ? text : text.replace(/^(?:[ \t]*>)*[ \t]*/, '')))
      .join('\n');
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
        edits.push({ from, to, text: `![${node.alt ?? ''}](${encodeSpaces(node.url)})` });
        return;
      case 'imageReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: `![${node.alt ?? ''}](${encodeSpaces(definition.url)})` });
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
    return `[${this.inline(children)}](<${encodeSpaces(url)}>)`;
  }
}

/** Rewrites inside plain text: entities, emoji shortcodes and backslashes Linear spells differently. */
function textEdits(source: string, from: number, to: number): Edit[] {
  const edits: Edit[] = [];
  const raw = source.slice(from, to);
  // Character references become the characters, unless that would make markup.
  for (const match of raw.matchAll(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g)) {
    const char = decodeEntity(match[0]);
    const after = raw.slice(match.index + match[0].length);
    if (char === undefined || /[\\`*_[\]<>#|~!]/.test(char) || char.trim() === '') continue;
    if (char === '&' && /^[A-Za-z0-9#]+;/.test(after)) continue;
    edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: char });
  }
  // `:name:` shortcodes Linear knows become the emoji.
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = nameToEmoji[match[1]!];
    if (emoji) edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: emoji });
  }
  // A backslash before a letter is a literal backslash; Linear doubles it.
  // An escaped `#` inside a line needs no escape and Linear drops it.
  for (const match of raw.matchAll(/\\(.)/g)) {
    const at = from + match.index;
    const next = match[1]!;
    if (/[!-/:-@[-`{-~]/.test(next)) {
      if (next === '#' && source[at - 1] !== '\n' && at !== 0) edits.push({ from: at, to: at + 1, text: '' });
    } else {
      edits.push({ from: at, to: at + 1, text: '\\\\' });
    }
  }
  return edits;
}

let entityProbe: { decode(text: string): string } | undefined;
function decodeEntity(reference: string): string | undefined {
  entityProbe ??= { decode: (text) => parse(text).children.map((node) => (node.type === 'paragraph' ? node.children.map((c) => (c.type === 'text' ? c.value : '')).join('') : '')).join('') };
  const decoded = entityProbe.decode(reference);
  return decoded === reference ? undefined : decoded;
}

function encodeSpaces(url: string): string {
  return url.replace(/ /g, '%20');
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

