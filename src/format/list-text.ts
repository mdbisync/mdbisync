// Lint warnings: a number at the start of a line inside a list item that
// Markdown reads as text, though it looks like a nested numbered list. `fix`
// keeps such text as text (it escapes the number, `2\.`), since only the author
// knows which was meant; the warning says where to look and how to make it a list.

import type { Root } from 'mdast';
import { LINT_WARNINGS, type Warning } from './rules.ts';
import { advanceColumn, end, line, lineCount, MarkdownLimitError, parse, splitFile, start, visit } from './markdown.ts';
import { overContentLimit } from './lint.ts';

/**
 * A number of up to three digits and `.` or `)`, escaped or not, then a space,
 * a tab or the line's end. Longer numbers, such as a year, read as text.
 */
const NUMBERED = /^\d{1,3}\\?[.)](?=[ \t]|$)/;

/**
 * Warnings for one file's text, ordered by line. A paragraph line inside a
 * list item is reported when it starts with a number and:
 *
 * - it is indented as a list nested in the item, but numbered other than 1:
 *   such a list cannot interrupt the item's text (after a doubled marker such
 *   as `14.  13. text`, the item is the deeper one);
 * - or it is indented four or more columns past the item's text, a skipped
 *   level: there even a 1 is text.
 *
 * A numbered line right below another one at the same indentation, or
 * below a paragraph that starts with a number there, is an item of the same
 * list and is judged with its first line. Inline code and text in a quote
 * are not checked.
 */
export function listTextWarnings(file: string, text: string): Warning[] {
  const { head, body } = splitFile(text);
  const content = body.replace(/\r\n?/g, '\n');
  if (overContentLimit(content)) return [];
  let tree: Root;
  try {
    tree = parse(content);
  } catch (error) {
    // Lint reports markdown-complexity for such a file.
    if (error instanceof MarkdownLimitError) return [];
    throw error;
  }
  const lines = content.split('\n');
  const lineStarts: number[] = [];
  for (let at = 0, offset = 0; at < lines.length; offset += lines[at]!.length + 1, at++) lineStarts.push(offset);
  const reported = new Set<number>();
  visit(tree, (node, ancestors) => {
    const item = ancestors.at(-1);
    if (node.type !== 'paragraph' || item?.type !== 'listItem' || ancestors.some((a) => a.type === 'blockquote')) return;
    const textColumn = contentColumn(content, start(item));
    // Inline code spanning lines is literal, whatever starts its lines.
    const code: Array<[number, number]> = [];
    visit(node, (child) => {
      if (child.type === 'inlineCode') code.push([start(child), end(child)]);
    });
    // The indentation of the numbered line above, whose list a numbered line
    // at the same indentation continues: such a line is judged with the
    // list's first line. A paragraph that starts with an escaped 1 starts
    // such a list on purpose; one that starts with another number, such as
    // a doubled marker's, does not.
    let listIndent = /^1\\[.)](?=[ \t]|$)/m.test(content.slice(start(node), start(node) + 4)) ? columnOf(content, start(node)) : undefined;
    for (let at = line(node) + 1; at <= (node.position?.end.line ?? 0); at++) {
      const { indent, rest, width } = indentation(lines[at - 1]!);
      const number = NUMBERED.exec(rest);
      const marker = lineStarts[at - 1]! + width;
      if (number === null || code.some(([from, to]) => marker > from && marker < to)) {
        listIndent = undefined;
        continue;
      }
      const sameList = listIndent === indent;
      listIndent = indent;
      if (sameList || indent < textColumn) continue;
      // A literal 1 nested there would be a list: written escaped, it is text on purpose.
      if (indent < textColumn + 4 && /^1\\?[.)]$/.test(number[0])) continue;
      reported.add(at);
    }
  });
  const offset = lineCount(head);
  return [...reported].sort((a, b) => a - b).map((at) => ({ file, line: at + offset, rule: 'list-number-as-text', message: LINT_WARNINGS['list-number-as-text'] }));
}

/**
 * The content column of the list item whose marker is at `offset`, as
 * CommonMark sets it: after the marker and the one to four columns of
 * spaces or tabs that follow it, or one column past the marker when more
 * follow or nothing does. A task item's checkbox is content.
 */
function contentColumn(text: string, offset: number): number {
  let column = columnOf(text, offset);
  let at = offset + (LIST_MARKER.exec(text.slice(offset, offset + 11))?.[0].length ?? 1);
  for (let from = offset; from < at; from++) column = advanceColumn(column, text[from]!);
  const markerEnd = column;
  while (text[at] === ' ' || text[at] === '\t') column = advanceColumn(column, text[at++]!);
  const blank = at >= text.length || text[at] === '\n';
  return blank || column - markerEnd > 4 ? markerEnd + 1 : column;
}

const LIST_MARKER = /^(?:[*+-]|\d{1,9}[.)])/;

/** The column of `offset` in its line, a tab running to the next multiple of four. */
function columnOf(text: string, offset: number): number {
  let column = 0;
  for (let at = text.lastIndexOf('\n', offset - 1) + 1; at < offset; at++) column = advanceColumn(column, text[at]!);
  return column;
}

/** A line's leading spaces and tabs as a column and as characters, and the text after them. */
function indentation(text: string): { indent: number; rest: string; width: number } {
  let indent = 0;
  let at = 0;
  while (text[at] === ' ' || text[at] === '\t') indent = advanceColumn(indent, text[at++]!);
  return { indent, rest: text.slice(at), width: at };
}
