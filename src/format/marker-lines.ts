// A line of only a plus sign right below a list item's first line, also as
// the paragraph's last line. Markdown reads it as the item's text, as an empty item
// cannot interrupt a paragraph; Linear reads `+` there as an empty list item
// (a code block four or more columns past the item's text) and drops the
// backslash of `\+`. Linear keeps `+` followed by a no-break space at the
// item's text column as text, which `fix` writes.

import type { ListItem, Paragraph, Root } from 'mdast';
import { overContentLimit } from './lint.ts';
import { advanceColumn, end, line, parse, start, visit } from './markdown.ts';

const PLUS_ONLY = /^[ \t]*(\\?\+)([ \t]*)$/;
/** A line that can be such a plus line: only then does `plusLinesAsLinear` parse the body. */
const PLUS_LINE = /\n[ \t]*\\?\+[ \t]*(?:\n|$)/;

/**
 * The body with each lone `+` or `\+` written as `+` and a no-break space
 * at the item's text column, where it is the second line of the first
 * paragraph of a list item (starting on the item's line) and no quote
 * holds it. Spaces after the sign stay
 * (two make a hard break). The body is `fix`'s output, whose item
 * prefixes are spaces; it stays as it is when the added characters would
 * take it over Linear's content limit.
 */
export function plusLinesAsLinear(body: string): string {
  if (!PLUS_LINE.test(body)) return body;
  const edits = plusLineMatches(body, parse(body), false);
  if (edits.length === 0) return body;
  let out = '';
  let at = 0;
  for (const edit of edits) {
    out += body.slice(at, edit.from) + `${' '.repeat(itemTextColumn(body, start(edit.item)))}+\u00a0${edit.trailing}`;
    at = edit.to;
  }
  out += body.slice(at);
  return overContentLimit(out) ? body : out;
}

/**
 * The 1-based lines of the lone `+` or `\+` lines `fix` writes with a
 * no-break space (`plus-line-in-item`): Linear reads each as an empty list
 * item. Here the item's text can also start below its marker: `fix` moves
 * it onto the marker's line before `plusLinesAsLinear` reads it.
 */
export function plusLines(body: string, tree: Root): number[] {
  return plusLineMatches(body, tree, true).map((match) => match.line);
}

/** The lone plus lines in document order; `belowMarker` also takes an item whose text starts below its marker. */
function plusLineMatches(body: string, tree: Root, belowMarker: boolean): Array<{ item: ListItem; from: number; to: number; trailing: string; line: number }> {
  if (!PLUS_LINE.test(body)) return [];
  const found: Array<{ item: ListItem; from: number; to: number; trailing: string; line: number }> = [];
  visit(tree, (node, ancestors) => {
    if (node.type !== 'paragraph') return;
    const item = ancestors.at(-1);
    if (item?.type !== 'listItem' || item.children[0] !== node || (!belowMarker && line(node) !== line(item))) return;
    if (ancestors.some((ancestor) => ancestor.type === 'blockquote')) return;
    const firstEnd = body.indexOf('\n', start(node));
    if (firstEnd === -1 || firstEnd >= end(node)) return;
    const from = firstEnd + 1;
    const newline = Math.min(...[body.indexOf('\n', from), end(node)].filter((at) => at !== -1));
    const plus = PLUS_ONLY.exec(body.slice(from, newline));
    if (plus === null || !inText(node, from + plus[0].indexOf(plus[1]!))) return;
    found.push({ item, from, to: newline, trailing: plus[2]!, line: line(node) + 1 });
  });
  return found.sort((a, b) => a.from - b.from);
}

/**
 * The column where the text of the list item whose marker is at `at`
 * starts, as `fix` writes it: past the marker and its spaces, up to four
 * (a task item's checkbox is part of its text).
 */
function itemTextColumn(body: string, at: number): number {
  const lineStart = body.lastIndexOf('\n', at - 1) + 1;
  const marker = /^(?:\d{1,9}[.)]|[*+-])/.exec(body.slice(at))![0];
  const markerEnd = [...body.slice(lineStart, at)].reduce(advanceColumn, 0) + marker.length;
  const gap = /^[ \t]*/.exec(body.slice(at + marker.length))![0];
  const width = [...gap].reduce(advanceColumn, markerEnd) - markerEnd;
  return markerEnd + (width >= 1 && width <= 4 ? width : 1);
}

/** Whether the offset is in a text node of the paragraph, not in code or HTML. */
function inText(paragraph: Paragraph, offset: number): boolean {
  let found = false;
  visit(paragraph, (node) => {
    if (node.type === 'text' && start(node) <= offset && offset < end(node)) found = true;
  });
  return found;
}
