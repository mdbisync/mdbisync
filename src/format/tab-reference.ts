import type { Nodes, Paragraph } from 'mdast';
import { isDeepStrictEqual } from 'node:util';
import { MarkdownLimitError, end, line, parse, start, visit } from './markdown.ts';

const TAB_REFERENCE = /&#(?:0{0,6}9|[xX]0{0,5}9);/;
const ESCAPE_OR_TAB_REFERENCE = new RegExp(String.raw`\\[^\r\n]|` + TAB_REFERENCE.source, 'g');

type TabEdit = { from: number; to: number; at: number; count: number; line: number };

/**
 * Linear writes numeric tab references as literal tabs and moves them out
 * of the edges of inline marks. In Markdown a literal tab can disappear
 * into a list prefix or become code indentation. Reparse the candidate
 * and check that its text and formatting survive.
 */
export function tabReferences(body: string): { text: string; unsafeLine?: number } {
  if (!TAB_REFERENCE.test(body)) return { text: body };
  let original;
  try {
    original = parse(body, [], true);
  } catch (error) {
    if (!(error instanceof MarkdownLimitError)) throw error;
    return { text: body };
  }
  const edits: TabEdit[] = [];
  let imageEdgeLine: number | undefined;
  const imageEdges = new Map<Paragraph, Set<number>>();
  visit(original, (node, ancestors) => {
    if (node.type === 'paragraph') {
      const edges = imageTrimEdges(body, node);
      if (edges.size !== 0) imageEdges.set(node, edges);
    }
    if (node.type !== 'text' || node.position === undefined) return;
    if (ancestors.some((parent) => parent.type === 'link' && body[start(parent)] !== '[')) return;
    const from = start(node);
    const raw = body.slice(from, end(node));
    const runs: TabEdit[] = [];
    let row = line(node);
    let newline = raw.indexOf('\n');
    for (const match of raw.matchAll(ESCAPE_OR_TAB_REFERENCE)) {
      if (match[0][0] === '\\') continue;
      while (newline !== -1 && newline < match.index) {
        row++;
        newline = raw.indexOf('\n', newline + 1);
      }
      const at = from + match.index;
      const last = runs.at(-1);
      if (last?.to === at) {
        last.to += match[0].length;
        last.count++;
      } else {
        runs.push({ from: at, to: at + match[0].length, at, count: 1, line: row });
      }
    }
    for (const run of runs) {
      const leading = run.from === from;
      const trailing = run.to === end(node);
      let child: Nodes = node;
      for (let index = ancestors.length - 1; index >= 0; index--) {
        const parent = ancestors[index]!;
        if (parent.type !== 'strong' && parent.type !== 'emphasis' && parent.type !== 'delete') break;
        if (leading && parent.children[0] === child) run.at = start(parent);
        else if (trailing && parent.children.at(-1) === child) run.at = end(parent);
        else break;
        child = parent;
      }
      const paragraph = ancestors.find((parent) => parent.type === 'paragraph');
      const edges = paragraph && imageEdges.get(paragraph);
      if (edges?.has(run.at) || edges?.has(run.to)) imageEdgeLine ??= run.line;
      edits.push(run);
    }
  });
  if (edits.length === 0) return { text: body };
  if (imageEdgeLine !== undefined) return { text: body, unsafeLine: imageEdgeLine };
  const candidate = applyTabs(body, edits);
  try {
    const originalBlocks = original.children;
    const written = parse(candidate, [], true).children;
    const changed = originalBlocks.findIndex((node, index) =>
      written[index] === undefined || !isDeepStrictEqual(tabShape(node), tabShape(written[index]!)));
    if (changed === -1 && originalBlocks.length === written.length) return { text: candidate };
    const block = originalBlocks[changed];
    const unsafe = block && edits.find(({ from, to }) => from >= start(block) && to <= end(block));
    if (unsafe !== undefined) return { text: body, unsafeLine: unsafe.line };
  } catch (error) {
    if (!(error instanceof MarkdownLimitError)) throw error;
  }
  return { text: body, unsafeLine: edits[0]!.line };
}

/** Where the writer trims the two text paragraphs split off from an image. */
function imageTrimEdges(body: string, node: Paragraph): Set<number> {
  const edges = new Set<number>();
  const trim = (char: string | undefined): boolean => char !== undefined && char !== '\u00a0' && char.trim() === '';
  for (const child of node.children) {
    if (child.type !== 'image' && child.type !== 'imageReference') continue;
    let before = start(child);
    let after = end(child);
    while (before > start(node) && trim(body[before - 1])) before--;
    while (after < end(node) && trim(body[after])) after++;
    edges.add(before);
    edges.add(after);
  }
  return edges;
}

function applyTabs(body: string, edits: readonly TabEdit[]): string {
  const changes = edits.flatMap(({ from, to, at, count }) => at === from
    ? [{ from, to, text: '\t'.repeat(count) }]
    : [{ from, to, text: '' }, { from: at, to: at, text: '\t'.repeat(count) }]);
  const parts: string[] = [];
  let offset = 0;
  for (const { from, to, text } of changes.sort((a, b) => a.from - b.from || a.to - b.to)) {
    parts.push(body.slice(offset, from), text);
    offset = to;
  }
  return parts.join('') + body.slice(offset);
}

type Shape = { type: string; value?: string; children?: Shape[] };

/** Compare trees without positions, with tabs moved outside their marks. */
function tabShape(node: Nodes): Shape[] {
  const { position: _position, ...fields } = node;
  if (!('children' in node)) return [fields];
  const children: Shape[] = [];
  for (const child of node.children) {
    for (const part of tabShape(child)) {
      const previous = children.at(-1);
      if (previous?.type === 'text' && part.type === 'text') previous.value += part.value!;
      else children.push(part);
    }
  }
  const shape = { ...fields, children };
  if (node.type !== 'strong' && node.type !== 'emphasis' && node.type !== 'delete') return [shape];
  const lead = extractTabs(children, true);
  const tail = extractTabs(children, false);
  return [...lead, ...(children.length === 0 ? [] : [shape]), ...tail];
}

function extractTabs(children: Shape[], leading: boolean): Shape[] {
  const index = leading ? 0 : children.length - 1;
  const text = children[index];
  if (text?.type !== 'text') return [];
  const value = text.value!;
  let length = 0;
  while (value[leading ? length : value.length - 1 - length] === '\t') length++;
  if (length === 0) return [];
  text.value = leading ? value.slice(length) : value.slice(0, -length);
  if (text.value === '') children.splice(index, 1);
  return [{ type: 'text', value: '\t'.repeat(length) }];
}
