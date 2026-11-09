// Parsing helpers for the format module: the Markdown tree with source
// positions, and the split between front matter and the body.

import { isDeepStrictEqual } from 'node:util';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

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
  return isDeepStrictEqual(withoutPositions(parse(a)), withoutPositions(parse(b)));
}

function withoutPositions(node: Nodes): unknown {
  const { position: _position, ...rest } = node;
  if ('url' in rest) rest.url = renderedUrl(rest.url);
  if ('children' in node) return { ...rest, children: node.children.map(withoutPositions) };
  return rest;
}

/**
 * A destination as Markdown renders it: characters a URL cannot hold
 * percent-encoded, escapes in upper case. `<a b.png>` and `a%20b.png` are
 * the same destination.
 */
function renderedUrl(url: string): string {
  return url
    .replace(/%(?![0-9A-Fa-f]{2})|[^!#$%&'()*+,\-./0-9:;=?@A-Z[\]_a-z~]/gu, (char) => encodeURIComponent(char))
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
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
