import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Nodes } from 'mdast';
import { parse, visit } from '../format/markdown.ts';
import { Git } from '../state/git.ts';
import { detectConflicts, lines, lineText, markerLines, MARKERS } from './markers.ts';
import type { Conflict } from './markers.ts';

export interface MergeResult {
  text: string;
  /** All conflicts in the resulting text, including existing or partial markers. */
  conflicts: Conflict[];
}

type Token = { kind: 'line'; text: string } | { kind: 'conflict'; ours: string[]; theirs: string[] };
type Range = { start: number; end: number };
type Side = 'ours' | 'theirs';

function tokenize(text: string, size: number): Token[] {
  const source = lines(text);
  const tokens: Token[] = [];
  for (let i = 0; i < source.length; i++) {
    const text = source[i]!;
    if (lineText(text) !== `${'<'.repeat(size)} git`) {
      tokens.push({ kind: 'line', text });
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    while (++i < source.length && lineText(source[i]!) !== '='.repeat(size)) ours.push(source[i]!);
    while (++i < source.length && lineText(source[i]!) !== `${'>'.repeat(size)} linear`) theirs.push(source[i]!);
    if (i === source.length) throw new Error('Invalid merge-file conflict output');
    tokens.push({ kind: 'conflict', ours, theirs });
  }
  return tokens;
}

function content(token: Token, side: Side): string[] {
  return token.kind === 'line' ? [token.text] : token[side];
}

function nestedList(node: Nodes): boolean {
  return 'children' in node && node.children.some((child) => child.type === 'list' || nestedList(child));
}

/**
 * Project each arm into a valid document. Source positions in these documents
 * map back to token positions, so widening needs no fuzzy matching of lines.
 * Clean edits from either side remain in both projections.
 */
function blockRanges(tokens: Token[], side: Side): Range[] {
  const source: string[] = [];
  const tokenAtLine: number[] = [];
  tokens.forEach((token, i) => {
    for (const line of content(token, side)) {
      source.push(line);
      tokenAtLine.push(i);
    }
  });
  const text = source.join('');
  const ranges: Range[] = [];
  const add = (startLine: number, endLine: number) => {
    const start = tokenAtLine[startLine - 1];
    const end = tokenAtLine[endLine - 1];
    if (start !== undefined && end !== undefined) ranges.push({ start, end: end + 1 });
  };
  visit(parse(text), (node) => {
    if ((node.type === 'code' || node.type === 'table' ||
      (node.type === 'list' && (node.ordered || nestedList(node)))) && node.position) {
      add(node.position.start.line, node.position.end.line);
    }
  });
  for (const conflict of detectConflicts(text)) add(conflict.startLine, conflict.endLine);
  return ranges;
}

function conflictRanges(tokens: Token[]): Range[] {
  const blocks = [...blockRanges(tokens, 'ours'), ...blockRanges(tokens, 'theirs')];
  const ranges = tokens.flatMap((token, i) => token.kind === 'conflict' ? [{ start: i, end: i + 1 }] : []);
  // Widen until both projections' blocks are complete; overlapping hunks then
  // become a single conflict, including multiple changes inside an old marker set.
  let changed: boolean;
  do {
    changed = false;
    for (const range of ranges) {
      for (const block of blocks) {
        if (block.start < range.end && block.end > range.start) {
          const start = Math.min(range.start, block.start);
          const end = Math.max(range.end, block.end);
          if (start !== range.start || end !== range.end) changed = true;
          range.start = start;
          range.end = end;
        }
      }
    }
  } while (changed);
  const merged: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function flatten(text: string): string {
  const markers = markerLines(text);
  return lines(text).filter((_, i) => !markers.has(i + 1)).join('').replace(/^\n|\n$/g, '');
}

function render(tokens: Token[], ranges: Range[]): string {
  let text = '';
  let cursor = 0;
  for (const range of ranges) {
    text += tokens.slice(cursor, range.start).map((token) => content(token, 'ours').join('')).join('');
    if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
    const arms = (side: Side) => flatten(tokens.slice(range.start, range.end).flatMap((token) => content(token, side)).join(''));
    text += `${MARKERS.git}\n\n${arms('ours')}\n\n${MARKERS.linear}\n\n${arms('theirs')}\n\n${MARKERS.end}\n`;
    cursor = range.end;
    const next = tokens[cursor];
    if (next?.kind === 'line' && lineText(next.text) !== '') text += '\n';
  }
  return text + tokens.slice(cursor).map((token) => content(token, 'ours').join('')).join('');
}

/**
 * Three-way Markdown merge. `ours` is the tracked Git version, `theirs` is
 * the Linear version. Requires Git on PATH; no repository or network is used.
 */
export async function mergeMarkdown(base: string, ours: string, theirs: string): Promise<MergeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'markdown-merge-'));
  try {
    await Promise.all([['base', base], ['ours', ours], ['theirs', theirs]].map(([name, text]) => writeFile(join(dir, name!), text!, { mode: 0o600 })));
    // Pick a delimiter wider than any run in the input, so literal git markers
    // and labels can never be mistaken for merge-file's framing.
    let size = 7;
    while ([base, ours, theirs].some((text) => ['<', '=', '>'].some((char) => text.includes(char.repeat(size))))) size++;
    const result = await new Git(dir).run([
      '-c', 'merge.conflictStyle=merge', 'merge-file', '--stdout', `--marker-size=${size}`,
      '-L', 'git', '-L', 'base', '-L', 'linear', 'ours', 'base', 'theirs',
    ], { okCodes: Array.from({ length: 128 }, (_, i) => i) });
    const raw = result.stdout.toString('utf8');
    const tokens = tokenize(raw, size);
    const text = result.code === 0 ? raw : render(tokens, conflictRanges(tokens));
    return { text, conflicts: detectConflicts(text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
