import type { Nodes } from 'mdast';
import { parse, splitFile, lineCount, visit } from '../format/markdown.ts';

export const MARKERS = {
  git: '**Sync conflict: git version**',
  linear: '**Sync conflict: Linear version**',
  end: '**Sync conflict: end**',
} as const;

/**
 * A marker as the sync writes it: its own one-line warning callout, which
 * Linear shows with an exclamation icon. The comment directly above the
 * callout gives it the color of a callout made in Linear's editor; Linear
 * and `fix` both write it this way.
 */
export const CALLOUT_COMMENT = '<!-- linear:callout color=#f2c94c -->';

export function markerCallout(marker: string): string {
  return `${CALLOUT_COMMENT}\n> [!WARNING]\n> ${marker}`;
}

/** One-based, inclusive source lines. Incomplete marker sets remain conflicts. */
export interface Conflict {
  startLine: number;
  endLine: number;
  git?: string;
  linear?: string;
}

/**
 * A marker line and the lines its marker block spans: the marker line
 * alone, or for a marker in a callout, the callout and the color comment
 * before it.
 */
export interface MarkerLine {
  value: string;
  startLine: number;
  endLine: number;
  /** For a marker in a callout, the callout's first line. */
  calloutLine?: number;
}

export function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function lineText(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** A line of a top-level quote or callout without its quote prefix. */
export function unquote(text: string): string {
  return text.replace(/^ {0,3}> ?/, '');
}

/** A color comment of Linear's callout syntax. */
function calloutComment(node: Nodes | undefined): boolean {
  return node?.type === 'html' && /^<!--\s*linear:callout\b[^]*?-->$/.test(node.value);
}

/** The first line of a callout, without its quote prefix: `[!WARNING]` or another alert kind. */
export const ALERT = /^\[!\w+\][ \t]*$/;

/**
 * Exact visible marker lines, excluding literal code and quoted examples.
 * A marker counts on a line of its own (the first form of the mark) or as
 * a line of a top-level callout: the one the sync writes, whatever its
 * alert kind or color, so a callout changed in Linear stays a conflict.
 * Markers in code, inline code, HTML, a plain quote, or a callout inside
 * another block are examples.
 */
export function findMarkerLines(text: string): Map<number, MarkerLine> {
  const { head, body } = splitFile(text);
  const offset = lineCount(head);
  const tree = parse(body);
  const source = lines(body);
  const callout = (node: Nodes, ancestors: readonly Nodes[]) => node.type === 'blockquote' && ancestors.length === 1 &&
    ALERT.test(unquote(lineText(source[(node.position?.start.line ?? 0) - 1] ?? '')));
  const excluded: [number, number][] = [];
  visit(tree, (node, ancestors) => {
    if (['code', 'inlineCode', 'html', 'blockquote'].includes(node.type) && !callout(node, ancestors) && node.position) {
      excluded.push([node.position.start.line, node.position.end.line]);
    }
  });
  // Top-level callouts: [first line, last line, first line of the block with its color comment].
  const quotes: [number, number, number][] = [];
  tree.children.forEach((node, index) => {
    if (!callout(node, [tree]) || !node.position) return;
    const previous = tree.children[index - 1];
    const first = node.position.start.line;
    quotes.push([first, node.position.end.line, calloutComment(previous) ? previous!.position!.start.line : first]);
  });
  const values: readonly string[] = Object.values(MARKERS);
  const found = new Map<number, MarkerLine>();
  source.forEach((text, i) => {
    const line = i + 1;
    if (excluded.some(([a, b]) => line >= a && line <= b)) return;
    const quote = quotes.find(([a, b]) => line >= a && line <= b);
    const value = quote ? unquote(lineText(text)) : lineText(text);
    if (!values.includes(value)) return;
    found.set(line + offset, quote
      ? { value, startLine: quote[2] + offset, endLine: quote[1] + offset, calloutLine: quote[0] + offset }
      : { value, startLine: line + offset, endLine: line + offset });
  });
  return found;
}

/** The marker value at each marker line. */
export function markerLines(text: string): Map<number, string> {
  return new Map([...findMarkerLines(text)].map(([number, { value }]) => [number, value]));
}

/** The text between two marker blocks, without the blank lines next to them. */
function arm(source: string[], after: number, before: number): string {
  const content = source.slice(after, before - 1);
  while (content[0] !== undefined && lineText(content[0]) === '') content.shift();
  while (content.at(-1) !== undefined && lineText(content.at(-1)!) === '') content.pop();
  return content.join('').replace(/\r?\n$/, '');
}

/**
 * Conflict state comes only from the text, including partially removed
 * markers. A conflict spans its marker blocks: callouts and color comments
 * included.
 */
export function detectConflicts(text: string): Conflict[] {
  const source = lines(text);
  const found: Conflict[] = [];
  let start: MarkerLine | undefined;
  let middle: MarkerLine | undefined;
  for (const marker of findMarkerLines(text).values()) {
    if (marker.value === MARKERS.git) {
      if (start !== undefined) found.push({ startLine: start.startLine, endLine: marker.startLine - 1 });
      start = marker;
      middle = undefined;
    } else if (marker.value === MARKERS.linear && start !== undefined && middle === undefined) {
      middle = marker;
    } else if (marker.value === MARKERS.end && start !== undefined) {
      found.push(middle === undefined
        ? { startLine: start.startLine, endLine: marker.endLine }
        : { startLine: start.startLine, endLine: marker.endLine, git: arm(source, start.endLine, middle.startLine), linear: arm(source, middle.endLine, marker.startLine) });
      start = undefined;
      middle = undefined;
    } else if (start === undefined) {
      found.push({ startLine: marker.startLine, endLine: marker.endLine });
    }
  }
  if (start !== undefined) found.push({ startLine: start.startLine, endLine: source.length });
  return found.sort((a, b) => a.startLine - b.startLine);
}
