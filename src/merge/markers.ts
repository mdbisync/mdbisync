import { parse, splitFile, lineCount, visit } from '../format/markdown.ts';

export const MARKERS = {
  git: '**Sync conflict: git version**',
  linear: '**Sync conflict: Linear version**',
  end: '**Sync conflict: end**',
} as const;

/** One-based, inclusive source lines. Incomplete marker sets remain conflicts. */
export interface Conflict {
  startLine: number;
  endLine: number;
  git?: string;
  linear?: string;
}

export function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function lineText(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Exact visible marker lines, excluding literal code and quoted examples. */
export function markerLines(text: string): Map<number, string> {
  const { head, body } = splitFile(text);
  const offset = lineCount(head);
  const excluded: [number, number][] = [];
  visit(parse(body), (node) => {
    if (['code', 'inlineCode', 'blockquote', 'html'].includes(node.type) && node.position) {
      excluded.push([node.position.start.line + offset, node.position.end.line + offset]);
    }
  });
  const values: readonly string[] = Object.values(MARKERS);
  const found = new Map<number, string>();
  lines(text).forEach((text, i) => {
    const number = i + 1;
    const value = lineText(text);
    if (number > offset && values.includes(value) && !excluded.some(([a, b]) => number >= a && number <= b)) {
      found.set(number, value);
    }
  });
  return found;
}

function arm(source: string[], start: number, end: number): string {
  const content = source.slice(start, end);
  if (content[0] !== undefined && lineText(content[0]) === '') content.shift();
  if (content.at(-1) !== undefined && lineText(content.at(-1)!) === '') content.pop();
  return content.join('').replace(/\r?\n$/, '');
}

/** Conflict state comes only from the text, including partially removed markers. */
export function detectConflicts(text: string): Conflict[] {
  const source = lines(text);
  const found: Conflict[] = [];
  let start: number | undefined;
  let middle: number | undefined;
  for (const [number, value] of markerLines(text)) {
    if (value === MARKERS.git) {
      if (start !== undefined) found.push({ startLine: start, endLine: number - 1 });
      start = number;
      middle = undefined;
    } else if (value === MARKERS.linear && start !== undefined && middle === undefined) {
      middle = number;
    } else if (value === MARKERS.end && start !== undefined) {
      found.push(middle === undefined
        ? { startLine: start, endLine: number }
        : { startLine: start, endLine: number, git: arm(source, start, middle - 1), linear: arm(source, middle, number - 1) });
      start = undefined;
      middle = undefined;
    } else {
      found.push({ startLine: number, endLine: number });
    }
  }
  if (start !== undefined) found.push({ startLine: start, endLine: source.length });
  return found.sort((a, b) => a.startLine - b.startLine);
}
