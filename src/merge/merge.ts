import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Nodes } from 'mdast';
import { isCalloutComment, lineCount, MarkdownLimitError, parse, splitFile, visit } from '../format/markdown.ts';
import { Git, GitOutputLimitError } from '../state/git.ts';
import { detectConflicts, findMarkerLines, lines, lineText, markerCallout, MARKERS } from './markers.ts';
import type { Conflict } from './markers.ts';
import { message } from '../messages.ts';
import { widenConflictRanges } from './conflict-ranges.ts';
import type { Range, WideningRange } from './conflict-ranges.ts';

export interface MergeResult {
  text: string;
  /** All conflicts in the resulting text, including existing or partial markers. */
  conflicts: Conflict[];
}

type Token = { kind: 'line'; text: string } | { kind: 'conflict'; ours: string[]; theirs: string[] };
type Side = 'ours' | 'theirs';

const DEFAULT_MARKER_SIZE = 7;
const MAX_MARKER_SIZE = 8_192;
const MAX_MERGE_RESULT_BYTES = 32 * 1024 * 1024;
const MERGE_OK_CODES = Array.from({ length: 128 }, (_, i) => i);

function tokenize(text: string, size: number): Token[] {
  const source = lines(text);
  const tokens: Token[] = [];
  const start = `${'<'.repeat(size)} git`;
  const middle = '='.repeat(size);
  const end = `${'>'.repeat(size)} linear`;
  for (let i = 0; i < source.length; i++) {
    const text = source[i]!;
    if (lineText(text) !== start) {
      tokens.push({ kind: 'line', text });
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    while (++i < source.length && lineText(source[i]!) !== middle) ours.push(source[i]!);
    while (++i < source.length && lineText(source[i]!) !== end) theirs.push(source[i]!);
    if (i === source.length) throw new Error(message('sync.merge-conflict-output'));
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
  const tree = parse(text);
  visit(tree, (node) => {
    if ((['code', 'table', 'blockquote', 'inlineCode', 'html', 'heading'].includes(node.type) ||
      (node.type === 'list' && (node.ordered || nestedList(node)))) && node.position) {
      add(node.position.start.line, node.position.end.line);
    }
  });
  // A callout's color comment belongs to its callout: a conflict takes in both.
  tree.children.forEach((node, index) => {
    const next = tree.children[index + 1];
    if (isCalloutComment(node) && next?.type === 'blockquote' && node.position && next.position) add(node.position.start.line, next.position.end.line);
  });
  for (const conflict of detectConflicts(text)) add(conflict.startLine, conflict.endLine);
  return ranges;
}

function conflictRanges(tokens: Token[]): Range[] {
  // Keep blocks whole in both versions, including existing conflict markers.
  const ranges: WideningRange[] = [...blockRanges(tokens, 'ours'), ...blockRanges(tokens, 'theirs')];
  tokens.forEach((token, i) => {
    if (token.kind === 'conflict') ranges.push({ start: i, end: i + 1, conflict: true });
  });
  return widenConflictRanges(ranges);
}

/**
 * Each token's lines without the marker blocks of an old conflict and the
 * blank line after each: a marker line, or a marker callout's alert line
 * and marker line with its color comment. Any other text typed into a
 * marker callout stays as written, still quoted, so an example in it stays
 * an example. The old versions become ordinary text of the new conflict,
 * never a nested mark.
 */
function withoutMarkers(tokens: Token[], side: Side): string[][] {
  const projection = tokens.flatMap((token) => content(token, side)).join('');
  const source = lines(projection);
  const blank = (line: number) => source[line - 1] !== undefined && lineText(source[line - 1]!) === '';
  const drop = new Set<number>();
  // Classify markers in the complete document, before cutting out an arm:
  // quote and multiline inline-code context may start outside a Git hunk.
  for (const [line, marker] of findMarkerLines(projection)) {
    drop.add(line);
    if (marker.calloutLine !== undefined) for (let header = marker.startLine; header <= marker.calloutLine; header++) drop.add(header);
    // Text typed after the marker inside its callout keeps the blank line that ends its paragraph.
    if (line === marker.endLine && blank(line + 1)) drop.add(line + 1);
  }
  let line = 0;
  return tokens.map((token) => content(token, side).filter(() => !drop.has(++line)));
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
      // A closing fence: container prefixes, then at least as many of the
      // opener's characters, then only spaces or tabs.
      const fence = /^[ >\t]*(`{3,}|~{3,})[ \t]*$/.exec(last)?.[1];
      const closing = fence !== undefined && fence[0] === opener[0] && fence.length >= opener.length;
      // Container prefixes remain in raw source but not in the parsed value.
      // A real closing fence adds a source line beyond the opener and value.
      const valueLines = node.value === '' ? 0 : node.value.split('\n').length;
      if (source.length > valueLines + 1 && closing) return;
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
  // A separate variable, not `text`: the visit above reads `text`, and static
  // analysis that merges a captured variable's assignments would otherwise
  // see the inserted end strings flow into the source it parses.
  // The pieces are joined once: inserting each end into the whole text would
  // copy it once per unclosed block.
  const pieces: string[] = [];
  let at = 0;
  // Ends at one offset go in the reverse of their visit order: inner block first.
  const ordered = insertions.map((insertion, index) => ({ ...insertion, index })).sort((a, b) => a.offset - b.offset || b.index - a.index);
  for (const insertion of ordered) {
    pieces.push(text.slice(at, insertion.offset), insertion.text);
    at = insertion.offset;
  }
  pieces.push(text.slice(at));
  const completed = pieces.join('');
  return completed.replace(/\n$/, '');
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

/** `finalNewline`: whether a conflict block that ends the document ends with a newline. */
function render(tokens: Token[], ranges: Range[], finalNewline: boolean): string {
  let text = '';
  let cursor = 0;
  const lastOursIndex = tokens.findLastIndex((token) => content(token, 'ours').some((line) => line !== ''));
  const armsWithoutMarkers = { ours: withoutMarkers(tokens, 'ours'), theirs: withoutMarkers(tokens, 'theirs') };
  for (const range of ranges) {
    text += tokens.slice(cursor, range.start).map((token) => content(token, 'ours').join('')).join('');
    if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
    const arms = (side: Side) => completeBlocks(armsWithoutMarkers[side].slice(range.start, range.end).flat().join('').replace(/^\n|\n$/g, ''));
    cursor = range.end;
    const last = cursor > lastOursIndex;
    text += `${markerCallout(MARKERS.git)}\n\n${arms('ours')}\n\n${markerCallout(MARKERS.linear)}\n\n${arms('theirs')}\n\n${markerCallout(MARKERS.end)}${last && !finalNewline ? '' : '\n'}`;
    const next = tokens[cursor];
    if (next?.kind === 'line' && lineText(next.text) !== '') text += '\n';
  }
  return text + tokens.slice(cursor).map((token) => content(token, 'ours').join('')).join('');
}

async function runMergeFile(dir: string, inputs: readonly string[], size: number, args: string[]) {
  const inputBytes = inputs.reduce((total, text) => total + Buffer.byteLength(text), 0);
  const frameBytes = 3 * size + 32;
  // Git builds the result in memory before it writes to stdout. Every hunk
  // consumes at least one source line, so one frame and an added newline per
  // input line also cover the worst case before the subprocess starts.
  const sourceLines = inputs.reduce((total, text) => total + lineCount(text) + 1, 0);
  if (inputBytes + sourceLines * (frameBytes + 1) > MAX_MERGE_RESULT_BYTES) {
    throw new MarkdownLimitError('merge-output');
  }
  // Allow output proportional to the input plus framing for 16 hunks. More
  // hunks can fit in the proportional budget, but large markers cannot make
  // the allowance grow with both the number of input lines and marker width.
  const maxOutputBytes = Math.min(MAX_MERGE_RESULT_BYTES, 4 * inputBytes + 16 * frameBytes);
  try {
    return await new Git(dir).run([
      '-c', 'merge.conflictStyle=merge', 'merge-file', '--stdout', `--marker-size=${size}`, ...args,
    ], { okCodes: MERGE_OK_CODES, maxOutputBytes });
  } catch (error) {
    if (error instanceof GitOutputLimitError) throw new MarkdownLimitError('merge-output');
    throw error;
  }
}

/**
 * The front matter of a merge: one side's when only that side changed it,
 * git's line merge when both did and their lines do not overlap, and the
 * git side's when they do. Markers cannot go into front matter. Linear has
 * none, but the Linear side of step 3 keeps the front matter its file had
 * (capture), so only a side that changed its front matter changes the result.
 */
async function mergeHeads(dir: string, withBom: { base: string; ours: string; theirs: string }): Promise<string> {
  // A byte order mark is serialization, not an edit: the git side's stays.
  const bom = withBom.ours.startsWith('﻿') ? '﻿' : '';
  const heads = Object.fromEntries(Object.entries(withBom).map(([name, text]) => [name, text.replace(/^﻿/, '')])) as typeof withBom;
  if (heads.theirs === heads.base || heads.ours === heads.theirs) return bom + heads.ours;
  if (heads.ours === heads.base) return bom + heads.theirs;
  await Promise.all(Object.entries(heads).map(([name, text]) => writeFile(join(dir, `head-${name}`), text, { mode: 0o600 })));
  const merged = await runMergeFile(dir, Object.values(heads), DEFAULT_MARKER_SIZE, ['head-ours', 'head-base', 'head-theirs']);
  return bom + (merged.code === 0 ? merged.stdout.toString('utf8') : heads.ours);
}

/**
 * Three-way Markdown merge. `ours` is the tracked Git version, `theirs` is
 * the Linear version. Front matter is merged apart from the bodies
 * (`mergeHeads`): conflicting front matter keeps ours. Requires Git on PATH; no repository or network is used.
 */
export async function mergeMarkdown(base: string, ours: string, theirs: string): Promise<MergeResult> {
  const gitFile = splitFile(ours);
  const heads = { base: splitFile(base).head, ours: gitFile.head, theirs: splitFile(theirs).head };
  const eol = ours.includes('\r\n') ? '\r\n' : '\n';
  // Newline serialization is not an edit. Merge all bodies as LF, then
  // restore the tracked Git file's newline style for clean and conflicted output.
  base = splitFile(base).body.replaceAll('\r\n', '\n');
  ours = gitFile.body.replaceAll('\r\n', '\n');
  theirs = splitFile(theirs).body.replaceAll('\r\n', '\n');
  // Pick a delimiter wider than any literal run in the body. Front matter
  // uses a fixed size because its conflict markers are never interpreted.
  let size = DEFAULT_MARKER_SIZE;
  for (const text of [base, ours, theirs]) {
    for (const [run] of text.matchAll(/<+|=+|>+/g)) {
      if (run.length >= MAX_MARKER_SIZE) throw new MarkdownLimitError('merge-marker');
      size = Math.max(size, run.length + 1);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'markdown-merge-'));
  try {
    const head = await mergeHeads(dir, heads);
    await Promise.all([['base', base], ['ours', ours], ['theirs', theirs]].map(([name, text]) => writeFile(join(dir, name!), text!, { mode: 0o600 })));
    const result = await runMergeFile(dir, [base, ours, theirs], size, [
      '-L', 'git', '-L', 'base', '-L', 'linear', 'ours', 'base', 'theirs',
    ]);
    const raw = result.stdout.toString('utf8');
    const tokens = tokenize(raw.replaceAll('\r\n', '\n'), size);
    // A conflict that runs to the end of the document closes with a marker line, which ends with a newline only when
    // the git body does (a file in Linear's form has none, and Linear keeps none). With no git body (a document only
    // Linear has), Linear's text decides. A clean merge stays as git made it.
    const ending = ours !== '' ? ours : theirs;
    const finalNewline = ending === '' || ending.endsWith('\n');
    const text = head + (result.code === 0 ? raw : render(tokens, conflictRanges(tokens), finalNewline)).replaceAll('\n', eol);
    return { text, conflicts: detectConflicts(text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
