// Parsing helpers for the format module: the Markdown tree with source
// positions, and the split between front matter and the body.

import { isDeepStrictEqual } from 'node:util';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { posix } from 'node:path';

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

export function parse(body: string): Root {
  return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
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
  const marked = body
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
  enter(node, ancestors);
  if ('children' in node) {
    ancestors.push(node);
    for (const child of node.children) visit(child, enter, ancestors);
    ancestors.pop();
  }
}

/** The repository path a relative destination points to, or null for anything else. */
export function resolveTarget(documentPath: string, url: string): string | null {
  if (url === '' || url.startsWith('#') || url.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const cut = url.search(/[?#]/);
  let path = cut === -1 ? url : url.slice(0, cut);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded: the destination names the file as it is.
  }
  if (path === '') return null;
  const joined = posix.normalize(posix.join(posix.dirname(documentPath), path));
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.endsWith('/')) return null;
  return joined;
}
