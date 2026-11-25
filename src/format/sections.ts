// A line that opens with three or more `>` signs is a collapsible section in
// Linear, not a nested quote. The rest of the line is the section's title,
// and the section holds the blocks after it in the same container (the
// document, a list item or a quote). Linear writes it as `+++ title`, then
// the section's blocks, then a closing `+++`. A `>>>` line without a title
// closes every section such lines opened in that container, or, when none
// is open, opens one without a title (`+++ `, with the space). A section
// still open at the end of its container closes there. `> > >`, with spaces
// between the signs, stays a nested quote, as does `>>>` continuing a quote
// that a line above opened (its first `>` belongs to that quote).

import type { Nodes } from 'mdast';
import { end, parse, start, visit } from './markdown.ts';

/** `lines`: the section lines the edit writes. */
type Edit = { from: number; to: number; text: string; depth: number; lines?: number };
type Opener = { node: Nodes; parent: Nodes; depth: number };

/** Rounds of splitting: each makes the section lines that nest in quotes the round before split off visible. */
const SPLIT_ROUNDS = 8;

/**
 * The body with each `>>>` section line written as Linear writes the
 * section, or undefined when `fix` cannot write it so: Linear would pair a
 * `+++` line of the text with the section, or a block at the end of the
 * container (an open code fence) would take in the closing line. The file
 * then stays with its author.
 */
export function sectionOpenersAsLinear(body: string): string | undefined {
  if (!body.includes('>>>')) return body;
  let openers = sectionOpeners(body);
  if (openers.length === 0) return body;
  if (hasSectionLine(body, openers)) return undefined;
  // Linear reads a section line alone: the lines after it are blocks of
  // their own, though Markdown reads them as part of the quote it opens.
  for (let round = 0; ; round++) {
    const splits = openers.flatMap((opener) => splitEdits(body, opener.node, opener.depth));
    if (splits.length === 0) break;
    if (round === SPLIT_ROUNDS) return undefined;
    body = applyEdits(body, splits);
    openers = sectionOpeners(body);
  }
  const containers = new Map<Nodes, Opener[]>();
  for (const opener of openers) containers.set(opener.parent, [...(containers.get(opener.parent) ?? []), opener]);
  const edits = [...containers.values()].flatMap((group) => containerEdits(body, group));
  const written = applyEdits(body, edits);
  // Each section line must stay a line of its own, not code or HTML of the block before it.
  const lines = edits.reduce((count, edit) => count + (edit.lines ?? 0), 0);
  return sectionLineCount(written) === lines ? written : undefined;
}

/** The line (1-based) of the first `>>>` section line when `fix` cannot write the sections, else undefined. */
export function unwritableSectionLine(body: string): number | undefined {
  if (!body.includes('>>>') || sectionOpenersAsLinear(body) !== undefined) return undefined;
  const [first] = sectionOpeners(body);
  return first === undefined ? undefined : body.slice(0, start(first.node)).split('\n').length;
}

/** The quotes that open with `>>>`, outermost of each run of signs, in order, with the container each is in. */
function sectionOpeners(body: string): Opener[] {
  const openers: Opener[] = [];
  visit(parse(body), (node, ancestors) => {
    if (node.type !== 'blockquote' || !body.startsWith('>>>', start(node))) return;
    const parent = ancestors.at(-1)!;
    // A later sign of a run that opened at the quote above it is part of that run.
    if (parent.type === 'blockquote' && /^>+$/.test(body.slice(start(parent), start(node)))) return;
    openers.push({ node, parent, depth: ancestors.length });
  });
  return openers;
}

/** The line's prefix of containers, and the same prefix for the lines after it (a list marker as its indent). */
function prefixes(body: string, at: number): { lineStart: number; linePrefix: string; prefix: string } {
  const lineStart = body.lastIndexOf('\n', at - 1) + 1;
  const linePrefix = body.slice(lineStart, at);
  return { lineStart, linePrefix, prefix: linePrefix.replace(/[*+-]|\d{1,9}[.)]/g, (marker) => ' '.repeat(marker.length)) };
}

function lineEndAt(body: string, at: number): number {
  const lineEnd = body.indexOf('\n', at);
  return lineEnd === -1 ? body.length : lineEnd;
}

/** Blank lines that set apart each `>>>` line of a quote that runs on past its first line. */
function splitEdits(body: string, node: Nodes, depth: number): Edit[] {
  const at = start(node);
  const firstEnd = lineEndAt(body, at);
  if (end(node) <= firstEnd) return [];
  const { prefix } = prefixes(body, at);
  const blank = prefix.trimEnd();
  const edits: Edit[] = [{ from: firstEnd, to: firstEnd, text: `\n${blank}`, depth }];
  for (let lineStart = firstEnd + 1; lineStart < end(node); lineStart = lineEndAt(body, lineStart) + 1) {
    const line = body.slice(lineStart, lineEndAt(body, lineStart));
    const content = line.startsWith(prefix) ? line.slice(prefix.length) : line.startsWith(blank) ? line.slice(blank.length) : line;
    if (!/^ {0,3}>>>/.test(content)) continue;
    edits.push({ from: lineStart, to: lineStart, text: `${blank}\n`, depth });
    const lineEnd = lineEndAt(body, lineStart);
    if (lineEnd < end(node)) edits.push({ from: lineEnd, to: lineEnd, text: `\n${blank}`, depth });
  }
  return edits;
}

/** The edits that write the section lines of one container as Linear writes them. */
function containerEdits(body: string, openers: readonly Opener[]): Edit[] {
  const edits: Edit[] = [];
  let open = 0;
  let prefix = '';
  const depth = openers[0]!.depth;
  for (const { node } of openers) {
    const at = start(node);
    const line = prefixes(body, at);
    prefix = line.prefix;
    const blank = prefix.trimEnd();
    // A line that interrupts a paragraph gets the blank line before it that Linear writes.
    const before = line.lineStart > 0 && prefix === line.linePrefix ? `${blank}\n` : '';
    const lineEnd = lineEndAt(body, at);
    const title = body.slice(at, lineEnd).replace(/^>+/, '').trim();
    let written: string;
    let lines = 1;
    if (title === '' && open > 0) {
      written = Array.from({ length: open }, () => '+++').join(`\n${blank}\n${prefix}`);
      lines = open;
      open = 0;
    } else {
      open++;
      written = `+++ ${title}`;
    }
    edits.push({ from: line.lineStart, to: lineEnd, text: `${before}${line.linePrefix}${written}\n${blank}`, depth, lines });
  }
  if (open > 0) {
    const parent = openers[0]!.parent;
    // After the container's last line, spaces and tabs included. A list
    // item's own end can run into the next item's marker (after an open
    // fence): its last block ends where its text does.
    const last = 'children' in parent ? (parent.children as Nodes[]).at(-1) : undefined;
    let containerEnd = parent.type === 'root' ? body.length : end(last ?? parent);
    while (body[containerEnd] === ' ' || body[containerEnd] === '\t') containerEnd++;
    edits.push({ from: containerEnd, to: containerEnd, text: `\n${prefix.trimEnd()}\n${prefix}+++`.repeat(open), depth, lines: open });
  }
  return edits;
}

/**
 * Applies edits from the end. Of two at one place, the outer container's
 * goes in first, so the inner one's text comes before it.
 */
function applyEdits(body: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || a.depth - b.depth);
  for (const edit of sorted) body = body.slice(0, edit.from) + edit.text + body.slice(edit.to);
  return body;
}

/** The paragraph lines that start with `+++`: the section lines Linear reads. */
function sectionLineCount(body: string, skip: (at: number) => boolean = () => false): number {
  let count = 0;
  visit(parse(body), (node) => {
    if (node.type !== 'paragraph') return;
    const from = start(node);
    for (const match of body.slice(from, end(node)).matchAll(/(?:^|\n)[ \t>]*\+{3}/g)) if (!skip(from + match.index)) count++;
  });
  return count;
}

/** Whether a paragraph has a line starting with `+++` other than a `>>>` line's title. */
function hasSectionLine(body: string, openers: readonly Opener[]): boolean {
  const titles = openers.map(({ node }) => [start(node), lineEndAt(body, start(node))] as const);
  return sectionLineCount(body, (at) => titles.some(([from, to]) => from <= at && at <= to)) > 0;
}
