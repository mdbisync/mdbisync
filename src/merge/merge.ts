import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Nodes } from 'mdast';
import { parse, splitFile, visit } from '../format/markdown.ts';
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
    // An unclosed fence can end at column 1 of the virtual line after EOF.
    const end = tokenAtLine[Math.min(endLine, source.length) - 1];
    if (start !== undefined && end !== undefined) ranges.push({ start, end: end + 1 });
  };
  visit(parse(text), (node) => {
    if ((['code', 'table', 'blockquote', 'inlineCode', 'html', 'heading'].includes(node.type) ||
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

function withoutMarkers(tokens: Token[], side: Side): string[][] {
  const projection = tokens.flatMap((token) => content(token, side)).join('');
  const markers = markerLines(projection);
  let line = 0;
  // Classify markers in the complete document, before cutting out an arm:
  // quote and multiline inline-code context may start outside a Git hunk.
  return tokens.map((token) => content(token, side).filter((text) => {
    line++;
    return !markers.has(line) && !(markers.has(line - 1) && lineText(text) === '');
  }));
}

/** EOF-terminated literal blocks must end before the following marker paragraph. */
function completeBlocks(text: string): string {
  const insertions: { offset: number; text: string }[] = [];
  visit(parse(text), (node) => {
    if ((node.type !== 'code' && node.type !== 'html') || !node.position) return;
    const { start, end } = node.position;
    const raw = text.slice(start.offset, end.offset);
    let close: string;
    if (node.type === 'code') {
      const opener = /^(?: {0,3})(`{3,}|~{3,})/.exec(raw)?.[1];
      if (!opener) return; // Indented code ends at a blank marker boundary.
      const source = lines(raw);
      const last = lineText(source.at(-1) ?? '');
      const closing = new RegExp(`^[ >\\t]*${opener[0]}{${opener.length},}[ \\t]*$`);
      // Container prefixes remain in raw source but not in the parsed value.
      // A real closing fence adds a source line beyond the opener and value.
      const valueLines = node.value === '' ? 0 : node.value.split('\n').length;
      if (source.length > valueLines + 1 && closing.test(last)) return;
      close = opener;
    } else {
      const tag = /^<(script|pre|style|textarea)(?:\s|>)/i.exec(raw)?.[1];
      const terminator = raw.startsWith('<!--') ? '-->' : raw.startsWith('<?') ? '?>'
        : raw.startsWith('<![CDATA[') ? ']]>' : /^<![A-Z]/.test(raw) ? '>'
        : tag ? `</${tag}>` : undefined;
      if (!terminator || closedHtmlBlock(node.value)) return;
      close = terminator;
    }
    const lineStart = text.lastIndexOf('\n', start.offset! - 1) + 1;
    const prefix = text.slice(lineStart, start.offset).replace(/[^ >\t]/g, ' ');
    insertions.push({ offset: end.offset!, text: `${raw.endsWith('\n') ? '' : '\n'}${prefix}${close}\n` });
  });
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, insertion.offset) + insertion.text + text.slice(insertion.offset);
  }
  return text.replace(/\n$/, '');
}

/**
 * Whether the parser itself ended this HTML block. A line after a closed block
 * is new content; an open block takes it in. Asking the parser, not searching
 * for an end string, keeps the rule CommonMark's: a comment ends only at
 * `-->` (not at the `--!>` browsers also accept), a `<script>` only at its
 * end tag, whatever the case. The block's value, not its source, is asked:
 * a container's `>` prefixes stay out of it, so they cannot end a
 * `<!DOCTYPE` block that ends at any `>`.
 */
function closedHtmlBlock(value: string): boolean {
  return parse(`${value}\nx`).children.length > 1;
}

function render(tokens: Token[], ranges: Range[]): string {
  let text = '';
  let cursor = 0;
  const armsWithoutMarkers = { ours: withoutMarkers(tokens, 'ours'), theirs: withoutMarkers(tokens, 'theirs') };
  for (const range of ranges) {
    text += tokens.slice(cursor, range.start).map((token) => content(token, 'ours').join('')).join('');
    if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
    const arms = (side: Side) => completeBlocks(armsWithoutMarkers[side].slice(range.start, range.end).flat().join('').replace(/^\n|\n$/g, ''));
    text += `${MARKERS.git}\n\n${arms('ours')}\n\n${MARKERS.linear}\n\n${arms('theirs')}\n\n${MARKERS.end}\n`;
    cursor = range.end;
    const next = tokens[cursor];
    if (next?.kind === 'line' && lineText(next.text) !== '') text += '\n';
  }
  return text + tokens.slice(cursor).map((token) => content(token, 'ours').join('')).join('');
}

/**
 * Three-way Markdown merge. `ours` is the tracked Git version, `theirs` is
 * the Linear version. Front matter belongs to Git: preserve ours and merge
 * only the bodies. Requires Git on PATH; no repository or network is used.
 */
export async function mergeMarkdown(base: string, ours: string, theirs: string): Promise<MergeResult> {
  const gitFile = splitFile(ours);
  const eol = ours.includes('\r\n') ? '\r\n' : '\n';
  // Newline serialization is not an edit. Merge all bodies as LF, then
  // restore the tracked Git file's newline style for clean and conflicted output.
  base = splitFile(base).body.replaceAll('\r\n', '\n');
  ours = gitFile.body.replaceAll('\r\n', '\n');
  theirs = splitFile(theirs).body.replaceAll('\r\n', '\n');
  const dir = await mkdtemp(join(tmpdir(), 'markdown-merge-'));
  try {
    await Promise.all([['base', base], ['ours', ours], ['theirs', theirs]].map(([name, text]) => writeFile(join(dir, name!), text!, { mode: 0o600 })));
    // Pick a delimiter wider than any run in the input, so literal git markers
    // and labels can never be mistaken for merge-file's framing.
    let size = 7;
    for (const text of [base, ours, theirs]) {
      for (const run of text.matchAll(/<+|=+|>+/g)) size = Math.max(size, run[0].length + 1);
    }
    const result = await new Git(dir).run([
      '-c', 'merge.conflictStyle=merge', 'merge-file', '--stdout', `--marker-size=${size}`,
      '-L', 'git', '-L', 'base', '-L', 'linear', 'ours', 'base', 'theirs',
    ], { okCodes: Array.from({ length: 128 }, (_, i) => i) });
    const raw = result.stdout.toString('utf8');
    const tokens = tokenize(raw.replaceAll('\r\n', '\n'), size);
    const text = gitFile.head + (result.code === 0 ? raw : render(tokens, conflictRanges(tokens))).replaceAll('\n', eol);
    return { text, conflicts: detectConflicts(text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
