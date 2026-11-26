// A line of only a plus sign right below a list item's first line, also as
// the paragraph's last line. Markdown reads it as the item's text, as an empty item
// cannot interrupt a paragraph; Linear reads `+` there as an empty list item
// (a code block four or more columns past the item's text) and drops the
// backslash of `\+`. Linear keeps `+` followed by a no-break space at the
// item's text column as text, which `fix` writes.

import type { Paragraph } from 'mdast';
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
  const edits: Array<{ from: number; to: number; text: string }> = [];
  visit(parse(body), (node, ancestors) => {
    if (node.type !== 'paragraph') return;
    const item = ancestors.at(-1);
    if (item?.type !== 'listItem' || item.children[0] !== node || line(node) !== line(item)) return;
    if (ancestors.some((ancestor) => ancestor.type === 'blockquote')) return;
    const firstEnd = body.indexOf('\n', start(node));
    if (firstEnd === -1 || firstEnd >= end(node)) return;
    const from = firstEnd + 1;
    const newline = Math.min(...[body.indexOf('\n', from), end(node)].filter((at) => at !== -1));
    const plus = PLUS_ONLY.exec(body.slice(from, newline));
    if (plus === null || !inText(node, from + plus[0].indexOf(plus[1]!))) return;
    edits.push({ from, to: newline, text: `${' '.repeat(itemTextColumn(body, start(item)))}+\u00a0${plus[2]}` });
  });
  if (edits.length === 0) return body;
  let out = '';
  let at = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    out += body.slice(at, edit.from) + edit.text;
    at = edit.to;
  }
  out += body.slice(at);
  return overContentLimit(out) ? body : out;
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
