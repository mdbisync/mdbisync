// Tabs in the indentation that gives a line its place in the Markdown
// structure: in the prefix a list item or a quote takes of its lines, after
// a list, heading or quote marker before the text, and in the indentation
// of an indented code block. Linear lays such lines out differently from
// Markdown, so content moves or is lost. `fix` writes these prefixes with
// spaces; a tab it keeps (in the text of a paragraph line past its
// prefixes, or in the code of a fenced block) is not reported.

import type { Blockquote, Code, ListItem, Nodes, Root } from 'mdast';
import { advanceColumn, end, start, visit } from './markdown.ts';

/** Nodes whose own start is not text: their first text or leaf block starts further on. */
const CONTAINER_LIKE: ReadonlySet<Nodes['type']> = new Set(['root', 'list', 'listItem', 'blockquote', 'paragraph', 'heading', 'table', 'tableRow']);
/** Parents whose children are blocks, not inline content. */
const BLOCK_PARENTS: ReadonlySet<Nodes['type']> = new Set(['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow']);
const FENCE = /^(?:`{3}|~{3})/;
const LIST_MARKER = /^(?:\d{1,9}[.)]|[*+-])/;

/**
 * The 1-based body lines with a tab in their structural indentation.
 * `body` is the text the tree was parsed from, without a byte order mark.
 */
export function structuralTabLines(tree: Root, body: string): number[] {
  if (!body.includes('\t')) return [];
  const lineStarts = [0];
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineText = (line: number): string => body.slice(lineStarts[line]!, line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : body.length);
  // 0-based lines with a tab that hold more than spaces and tabs, in order.
  const tabLines = lineStarts.map((_, line) => line).filter((line) => { const text = lineText(line); return text.includes('\t') && !/^[ \t]*$/.test(text); });
  if (tabLines.length === 0) return [];
  const tabLineSet = new Set(tabLines);
  /** The tab lines from `first` to `last`, found by binary search. */
  const linesIn = (first: number, last: number): number[] => {
    let low = 0;
    let high = tabLines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tabLines[middle]! < first) low = middle + 1;
      else high = middle;
    }
    const lines: number[] = [];
    for (let index = low; index < tabLines.length && tabLines[index]! <= last; index++) lines.push(tabLines[index]!);
    return lines;
  };
  const columnOf = (line: number, offset: number): number => [...body.slice(lineStarts[line]!, offset)].reduce(advanceColumn, 0);

  // The prefixes of the list items and quotes each line continues,
  // outermost first: an item's content column, or undefined for a quote.
  const chains = new Map<number, Array<number | undefined>>();
  const blockStarts = new Set<number>();
  const leafStarts = new Map<number, number>();
  const indentedCode = new Set<number>();
  visit(tree, (node, ancestors) => {
    if (node.position === undefined) return;
    const first = node.position.start.line - 1;
    const last = node.position.end.line - 1;
    if (node.type === 'listItem' || node.type === 'blockquote') {
      const lines = linesIn(first + 1, last);
      if (lines.length > 0) {
        const prefix = node.type === 'blockquote' ? undefined : contentColumn(node, body, columnOf(first, start(node)));
        for (const line of lines) chains.set(line, [...chains.get(line) ?? [], prefix]);
      }
    }
    if (node.type === 'code' && isIndented(node, body)) for (const line of linesIn(first, last)) indentedCode.add(line);
    if (!tabLineSet.has(first)) return;
    const parent = ancestors.at(-1);
    if (parent === undefined || BLOCK_PARENTS.has(parent.type)) blockStarts.add(first);
    if (!CONTAINER_LIKE.has(node.type)) leafStarts.set(first, Math.min(leafStarts.get(first) ?? Infinity, start(node)));
  });

  const found: number[] = [];
  for (const line of tabLines) {
    const lineStart = lineStarts[line]!;
    const text = lineText(line);
    const prefix = prefixEnd(text, chains.get(line) ?? []);
    // A line blank past its prefixes (`>` and a tab) holds no text to move.
    if (/^[ \t]*$/.test(text.slice(prefix.at)) && !indentedCode.has(line)) continue;
    let structural = prefix.tab;
    // A line that starts a block: the markers and spaces before its first text.
    const leaf = leafStarts.get(line);
    if (!structural && blockStarts.has(line) && leaf !== undefined) structural = body.slice(lineStart + prefix.at, leaf).includes('\t');
    // An indented code block's own four columns.
    if (!structural && indentedCode.has(line)) {
      let column = prefix.column;
      for (let at = prefix.at; at < text.length && column < prefix.column + 4 && (text[at] === ' ' || text[at] === '\t'); at++) {
        if (text[at] === '\t') structural = true;
        column = advanceColumn(column, text[at]!);
      }
    }
    if (structural) found.push(line + 1);
  }
  return found;
}

/**
 * Where a line's container prefixes end (offset in the line and column),
 * and whether a tab lies in them. `containers` holds each list item's
 * content column, or undefined for a quote. A line without a container's
 * prefix is a lazy line: the prefixes stop there.
 */
function prefixEnd(text: string, containers: ReadonlyArray<number | undefined>): { at: number; column: number; tab: boolean } {
  let at = 0;
  let column = 0;
  let tab = false;
  for (const content of containers) {
    if (content === undefined) {
      // Up to three columns of indentation, spaces or a tab, before `>`.
      let marker = at;
      let markerColumn = column;
      let indentTab = false;
      while ((text[marker] === ' ' || text[marker] === '\t') && advanceColumn(markerColumn, text[marker]!) - column <= 3) {
        indentTab ||= text[marker] === '\t';
        markerColumn = advanceColumn(markerColumn, text[marker]!);
        marker++;
      }
      if (text[marker] !== '>') break;
      tab ||= indentTab;
      at = marker + 1;
      column = markerColumn + 1;
      // The one space a quote marker takes after it; a tab there is
      // taken in part.
      if (text[at] === ' ' || text[at] === '\t') {
        tab ||= text[at] === '\t';
        column = advanceColumn(column, text[at]!);
        at++;
      }
      continue;
    }
    let next = at;
    let nextColumn = column;
    let lazy = false;
    let indentTab = false;
    while (nextColumn < content) {
      if (text[next] !== ' ' && text[next] !== '\t') {
        lazy = true;
        break;
      }
      indentTab ||= text[next] === '\t';
      nextColumn = advanceColumn(nextColumn, text[next]!);
      next++;
    }
    // A lazy line keeps the spaces it has; `fix` still writes a tab in
    // them as the spaces it spanned.
    tab ||= indentTab;
    if (lazy) break;
    at = next;
    column = nextColumn;
  }
  return { at, column, tab };
}

/** The column a list item's content starts at, counted from the start of its line; `markerColumn` is the marker's. */
function contentColumn(item: ListItem, body: string, markerColumn: number): number {
  const marker = LIST_MARKER.exec(body.slice(start(item), start(item) + 11))?.[0] ?? '';
  const markerEnd = markerColumn + marker.length;
  const lineEnd = body.indexOf('\n', start(item));
  const rest = body.slice(start(item) + marker.length, lineEnd === -1 ? end(item) : Math.min(lineEnd, end(item)));
  const gap = /^[ \t]*/.exec(rest)![0];
  if (gap.length === rest.length) return markerEnd + 1;
  const width = [...gap].reduce(advanceColumn, markerEnd) - markerEnd;
  return markerEnd + (width >= 1 && width <= 4 ? width : 1);
}

/** Whether a code block is indented code: a fenced block starts at its fence, indented code at its indentation. */
function isIndented(node: Code, body: string): boolean {
  return !FENCE.test(body.slice(start(node), start(node) + 3));
}
