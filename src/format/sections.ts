// A line that opens with three or more `>` signs is a collapsible section in
// Linear, not a nested quote. The rest of the line is the section's title,
// and the section holds the blocks after it in the same container (the
// document, a list item or a quote). Linear writes it as `+++ title`, then
// the section's blocks, then a closing `+++`. A `>>>` line without a title
// closes every section such lines opened in that container, or, when none
// is open, opens one without a title (`+++ `, with the space). A section
// still open at the end of its container closes there. `> > >`, with spaces
// between the signs, stays a nested quote, as does `>>>` continuing a quote
// that a line above opened (its first `>` belongs to that quote).

import type { Blockquote, Code, ListItem, Nodes, Root } from 'mdast';
import { advanceColumn, end, parse, start, visit, type MicromarkExtension } from './markdown.ts';

/** `lines`: the section lines the edit writes; `marks`: where each starts in `text`, and what it is. */
type Edit = { from: number; to: number; text: string; depth: number; lines?: number; marks?: { at: number[]; role: OpenerLine['role'] } };
type Opener = { node: Nodes; parent: Nodes; depth: number };
/**
 * A triple-plus line `fix` wrote for a `>>>` section: an opening line, one
 * of the closing lines of a title-less `>>>` line, or one of the closing
 * lines at its container's end. `run`: the `>>>` line or end it stands for.
 */
type OpenerLine = { role: 'open' | 'close' | 'end'; run: number };

/** Rounds of splitting: each makes the section lines that nest in quotes the round before split off visible. */
const SPLIT_ROUNDS = 8;
const PLUS_MARKER = /^\+{3}(?!\+)(.*)$/;

// For this scan only, give a +++ line a block node so it can interrupt a
// paragraph or end a lazy list/quote continuation. Fences and HTML blocks
// still own their content. The ordinary Markdown parser writes the result.
function plusSectionSyntax(ignored: ReadonlySet<number>): MicromarkExtension {
  return { flow: {
    43: {
      tokenize(effects, ok, nok) {
        if (ignored.has(this.now().offset)) return nok;
        let signs = 0;
        return opening;

        function opening(code: Parameters<typeof ok>[0]): ReturnType<typeof ok> {
          if (signs === 0) effects.enter('thematicBreak');
          if (code === 43 && signs < 3) {
            signs++;
            effects.consume(code);
            return opening;
          }
          return signs === 3 && code !== 43 ? rest(code) : nok(code);
        }

        function rest(code: Parameters<typeof ok>[0]): ReturnType<typeof ok> {
          if (code === null || (code >= -5 && code <= -3)) {
            effects.exit('thematicBreak');
            return ok(code);
          }
          effects.consume(code);
          return rest;
        }
      },
    },
  } };
}

/** The ordinary parser already owns these markers inside another construct. */
function parseForSections(body: string): Root {
  const ignored = new Set<number>();
  if (/[`$[|]/.test(body)) {
    visit(parse(body), (node) => {
      const enclosed = node.type === 'link' || node.type === 'linkReference' || node.type === 'image'
        || node.type === 'imageReference' || node.type === 'definition' || node.type === 'inlineCode' || node.type === 'table';
      if (!enclosed && node.type !== 'paragraph') return;
      const raw = body.slice(start(node), end(node));
      if (!enclosed && !/^\$\$\n[\s\S]*\n\$\$$/.test(raw)) return;
      for (const match of raw.matchAll(/\n[ \t>]*\+{3}/g)) ignored.add(start(node) + match.index + match[0].length - 3);
    });
  }
  return parse(body, [], false, [plusSectionSyntax(ignored)]);
}

/**
 * Pairs triple-plus lines within each Markdown container. A title always
 * starts a new section. A title-less line closes the innermost open one
 * even if it carries whitespace. Without a section to close, it opens
 * one if the container has a body or a closing line for it.
 */
export function plusSectionsAsLinear(body: string): string {
  return pairSections(body, new Map())!;
}

/**
 * `plusSectionsAsLinear` for a body in which `fix` wrote `>>>` section
 * lines as triple-plus lines (`fromOpeners`: where each written line
 * starts). Linear pairs the two kinds apart: a title-less `+++` line closes
 * the innermost open `+++` section, a title-less `>>>` line every open
 * `>>>` section, and closing a section closes the sections nested in it.
 * The `>>>` pass counted only its own sections, so each of its closing
 * lines and each run of closing lines at a container's end is written
 * again here. Undefined where Linear's form reads differently: a title-less
 * section opened inside a section (Linear writes `+++ `, which reads as a
 * closing line), or a title-less `>>>` line after a `+++` line closed its
 * sections (Linear opens a section there).
 */
function pairSections(body: string, fromOpeners: ReadonlyMap<number, OpenerLine>): string | undefined {
  if (!body.includes('+++')) return body;
  let tree = parseForSections(body);
  const joins: Edit[] = [];
  const joined = joinSectionItemLines(body, tree, joins);
  if (joined !== body) {
    const lines = [...fromOpeners];
    const moved = applyTrackedEdits(body, joins, lines.map(([at]) => at)).points;
    fromOpeners = new Map(lines.map(([, line], index) => [moved[index]!, line]));
    body = joined;
    tree = parseForSections(body);
  }
  let unwritable = false;
  const edits: Edit[] = [];
  // Where each paragraph of the ordinary parse ends, by its start: a marker
  // whose paragraph runs past its line has a lazy line after it.
  let paragraphEnds: Map<number, number> | undefined;
  const lazyAfter = (marker: Nodes): boolean => {
    if (paragraphEnds === undefined) {
      const ends = new Map<number, number>();
      visit(parse(body), (node) => { if (node.type === 'paragraph') ends.set(start(node), end(node)); });
      paragraphEnds = ends;
    }
    const paragraphEnd = paragraphEnds.get(start(marker));
    return paragraphEnd !== undefined && paragraphEnd > lineEndAt(body, start(marker));
  };
  visit(tree, (parent, ancestors) => {
    if (parent.type !== 'root' && parent.type !== 'blockquote' && parent.type !== 'listItem') return;
    const blocks = parent.children;
    const markers = blocks.map((node) => node.type === 'thematicBreak' ? PLUS_MARKER.exec(body.slice(start(node), end(node))) : null);
    if (markers.every((marker) => marker === null)) return;
    const opener = (index: number) => fromOpeners.get(start(blocks[index]!));
    const mixed = markers.some((marker, index) => marker !== null && opener(index) !== undefined);
    // Longer delimiters pair by their own width. Their stored spelling
    // also uses three signs, so leave mixed-width containers to the author.
    if (blocks.some((node) => node.type === 'paragraph' && /(?:^|\n)[ \t>]*\+{4}/.test(body.slice(start(node), end(node))))) {
      unwritable ||= mixed;
      return;
    }
    const depth = ancestors.length;
    const lastContent = markers.findLastIndex((marker, index) => marker === null && blocks[index]!.type !== 'definition');
    const open: number[] = [];
    const roles = new Map<number, string>();
    // Closing lines that also close the sections nested in the one they close.
    const alsoCloses = new Map<number, number>();
    // Closing lines of the `>>>` pass that Linear does not write: the run's
    // other lines, or the whole run when a `+++` line closed its sections.
    const dropped = new Set<number>();
    const closingRuns = new Set<number>();
    let closedAfterContent = 0;
    const close = (index: number, from: number) => {
      const closed = open.splice(from);
      for (const other of closed) {
        // Only a +++ line of the text can be a final title-like paragraph.
        if (other > lastContent && opener(other) === undefined) closedAfterContent++;
        roles.set(other, `+++ ${markers[other]![1]!.trim()}`);
      }
      roles.set(index, '+++');
      if (closed.length > 1) alsoCloses.set(index, closed.length - 1);
    };
    for (const [index, marker] of markers.entries()) {
      if (marker === null) continue;
      const title = marker[1]!.trim();
      const line = opener(index);
      if (line !== undefined && line.role !== 'open') {
        if (closingRuns.has(line.run)) {
          dropped.add(index);
          continue;
        }
        // The pairing parse can end a container elsewhere than the one the
        // `>>>` pass read (a lazy line): leave such a file to its author.
        if (index === 0) {
          unwritable = true;
          return;
        }
        closingRuns.add(line.run);
        const outermost = open.findIndex((other) => opener(other) !== undefined);
        if (outermost !== -1) close(index, outermost);
        else if (line.role === 'end') dropped.add(index);
        else {
          unwritable = true;
          return;
        }
      } else if (title === '' && open.length > 0) {
        const innermost = mixed ? open.findLastIndex((other) => opener(other) === undefined) : open.length - 1;
        if (line !== undefined || innermost === -1) {
          unwritable = true;
          return;
        }
        close(index, innermost);
      } else if (index < blocks.length - 1) {
        // A final +++ title with only the `>>>` pass's closing lines after
        // it has no body: Linear's form would not tell it from text.
        if (mixed && line === undefined && blocks.slice(index + 1).every((_, after) => opener(index + 1 + after)?.role === 'end')) {
          unwritable = true;
          return;
        }
        open.push(index);
      }
    }
    // Each `>>>` section has its closing line: one still open is in another container.
    if (open.some((index) => opener(index) !== undefined)) {
      unwritable = true;
      return;
    }
    const lastKept = blocks.findLastIndex((_, index) => !dropped.has(index));
    // An opener with blocks after it in its container opens a section
    // there, also as the first line of a list item or quote with the next
    // line right below it.
    const implicit = open.filter((index) => index < lastContent);
    // Linear keeps a marker that a lazy line continues (no prefix) as
    // text. This parse ends the container at that line, but the writer
    // gives the line its prefix, which reads as a section: escape the
    // marker so it stays text.
    if (parent.type !== 'root' && blocks.length === 1 && markers[0] !== null && lazyAfter(blocks[0]!)) {
      edits.push({ from: start(blocks[0]!), to: start(blocks[0]!), text: '\\', depth: ancestors.length });
      return;
    }
    for (const index of implicit) roles.set(index, `+++ ${markers[index]![1]!.trim()}`);
    // A final title-like paragraph exports just like the header of an empty
    // inner section. Keep an already written outer opener in that case.
    const closes = implicit.filter((index) => {
      if (closedAfterContent === 0 || markers[index]![0] !== roles.get(index)) return true;
      closedAfterContent--;
      return false;
    });
    const last = blocks[lastKept]!;
    if (closes.length > 0 && last.type === 'html' && parse(`${last.value}\n\n+++`).children.at(-1)?.type !== 'paragraph') {
      unwritable ||= mixed;
      return;
    }

    for (const [index, marker] of markers.entries()) {
      if (marker === null) continue;
      const node = blocks[index]!;
      const at = start(node);
      if (dropped.has(index)) {
        // From the end of the block before it: that block is kept, or dropped with it.
        const previous = blocks[index - 1]!;
        edits.push({ from: lineEndAt(body, Math.max(start(previous), end(previous) - 1)), to: lineEndAt(body, at), text: '', depth });
        continue;
      }
      if (!roles.has(index) && parent.type !== 'root' && index === 0 && index === blocks.length - 1) continue;
      const previous = blocks[index - 1];
      // The image writer can split off a literal section title and escape
      // its final marker. Keep those lines together for that rewrite.
      if (!roles.has(index) && previous?.type === 'paragraph'
        && previous.position!.end.line + 1 === node.position!.start.line
        && (body.startsWith('\\+++', start(previous))
          || previous.children.some((child) => child.type === 'image' || child.type === 'imageReference'))) continue;
      const line = prefixes(body, at);
      const blank = line.prefix.trimEnd();
      const before = index > 0 || line.linePrefix === line.prefix && parent.type === 'root' && line.lineStart > 0;
      const written = [roles.get(index) ?? marker[0].trimEnd(), ...Array<string>(alsoCloses.get(index) ?? 0).fill('+++')].join(`\n${blank}\n${line.prefix}`);
      const to = lineEndAt(body, at);
      // The marker ends a paragraph even when the next line is lazy.
      // Keep any enclosing quote that the next line continues.
      const next = body.slice(to + 1, lineEndAt(body, to + 1));
      const after = index < lastKept ? `\n${blank}`
        : next.trim() === '' ? '' : `\n${sharedQuotePrefix(blank, next)}`;
      edits.push({
        from: line.lineStart, to,
        text: `${before ? `${blank}\n` : ''}${line.linePrefix}${written}${after}`,
        depth,
      });
    }
    if (closes.length > 0) {
      const prefix = sectionPrefix(body, parent, start(blocks[closes[0]!]!));
      const blank = prefix.trimEnd();
      // An unclosed fence can end at the start of the next item's line.
      // Insert after its own last line and supply its fence first.
      const at = lineEndAt(body, Math.max(start(last), end(last) - 1));
      const fence = last.type === 'code' ? unclosedFence(body, last) : '';
      const markers = `\n${blank}\n${prefix}+++`.repeat(closes.length);
      edits.push({ from: at, to: at, text: (fence === '' ? '' : `\n${prefix}${fence}`) + markers, depth });
    }
  });
  return unwritable ? undefined : applyEdits(body, edits);
}

/** The explicit quote markers the two lines share, through the last `>`. */
function sharedQuotePrefix(first: string, next: string): string {
  let lastQuote = -1;
  for (let index = 0; index < first.length && first[index] === next[index]; index++) {
    if (first[index] === '>') lastQuote = index;
  }
  return first.slice(0, lastQuote + 1);
}

/** Read Linear's empty item paragraph and section below it as a single list item. */
function joinSectionItemLines(body: string, tree: Nodes, edits: Edit[]): string {
  if (!/(?:[*+.-]|\)) \n[ >]*\n[ >]*\+{3} /.test(body)) return body;
  visit(tree, (node, ancestors) => {
    if (node.type !== 'thematicBreak' || !body.startsWith('+++ ', start(node))) return;
    const { lineStart, linePrefix } = prefixes(body, start(node));
    if (lineStart === 0) return;
    const blankStart = body.lastIndexOf('\n', lineStart - 2) + 1;
    if (blankStart === 0) return;
    const itemStart = body.lastIndexOf('\n', blankStart - 2) + 1;
    const item = /^([ >]*)([*+-]|\d{1,9}[.)]) $/.exec(body.slice(itemStart, blankStart - 1));
    if (item === null || body.slice(blankStart, lineStart - 1) !== item[1]!.trimEnd()) return;
    if (linePrefix !== item[1] + ' '.repeat(item[2]!.length + 1)) return;
    edits.push({ from: blankStart - 1, to: start(node), text: '', depth: ancestors.length });
  });
  return applyEdits(body, edits);
}

function sectionPrefix(body: string, parent: Root | Blockquote | ListItem, at: number): string {
  if (parent.type === 'root') return '';
  const { prefix } = prefixes(body, at);
  if (parent.type === 'blockquote') return prefix.slice(0, prefix.lastIndexOf('>') + 1) + ' ';
  // Use the item's content indent, excluding optional indent on this marker.
  const itemStart = start(parent);
  const marker = /^([*+-]|\d{1,9}[.)])([ \t]+)/.exec(body.slice(itemStart, itemStart + 15));
  if (marker === null) return prefix;
  const item = prefixes(body, itemStart);
  const markerColumn = [...item.linePrefix].reduce(advanceColumn, 0) + marker[1]!.length;
  const gap = [...marker[2]!].reduce(advanceColumn, markerColumn) - markerColumn;
  return item.prefix + ' '.repeat(marker[1]!.length + (gap <= 4 ? gap : 1));
}

function unclosedFence(body: string, code: Code): string {
  const opening = /^(`{3,}|~{3,})/.exec(body.slice(start(code), lineEndAt(body, start(code))))?.[1];
  if (opening === undefined) return '';
  const position = code.position!;
  const trailingBreak = body[end(code) - 1] === '\n';
  const rows = position.end.line - position.start.line - Number(trailingBreak);
  // The parser's literal has no closing line. Reading just the last
  // source line as a fence would mistake indented code text for one.
  const emptyClosed = code.value === '' && rows === 1 && !trailingBreak && body.slice(start(code), end(code)).trimEnd().endsWith(opening);
  return emptyClosed || rows > code.value.split('\n').length ? '' : opening;
}

/**
 * The body with each `>>>` section line written as Linear writes the
 * section, or undefined when `fix` cannot write it so: a title-less
 * section line opens a section inside one of the other kind (`>>>` and
 * `+++` lines pair apart), or a block at the end of the container (an open
 * code fence) would take in the closing line. The file then stays with its
 * author. With `+++` lines in the body, they are written as Linear writes
 * them too.
 */
export function sectionOpenersAsLinear(body: string): string | undefined {
  if (!body.includes('>>>')) return body;
  let openers = sectionOpeners(body);
  if (openers.length === 0) return body;
  // Linear reads a section line alone: the lines after it are blocks of
  // their own, though Markdown reads them as part of the quote it opens.
  for (let round = 0; ; round++) {
    const splits = openers.flatMap((opener) => splitEdits(body, opener.node, opener.depth));
    if (splits.length === 0) break;
    if (round === SPLIT_ROUNDS) return undefined;
    body = applyEdits(body, splits);
    openers = sectionOpeners(body);
  }
  const containers = new Map<Nodes, Opener[]>();
  for (const opener of openers) containers.set(opener.parent, [...(containers.get(opener.parent) ?? []), opener]);
  const edits = [...containers.values()].flatMap((group) => containerEdits(body, group));
  const { body: written, marks } = applyTrackedEdits(body, edits);
  // Each section line must stay a line of its own, not code or HTML of the block before it.
  const lines = edits.reduce((count, edit) => count + (edit.lines ?? 0), 0);
  const plusLines = plusLineCount(body, openers);
  if (sectionLineCount(written) !== lines + plusLines) return undefined;
  return plusLines === 0 ? written : pairSections(written, marks);
}

/** The line (1-based) of the first `>>>` section line when `fix` cannot write the sections, else undefined. */
export function unwritableSectionLine(body: string): number | undefined {
  if (!body.includes('>>>') || sectionOpenersAsLinear(body) !== undefined) return undefined;
  const [first] = sectionOpeners(body);
  return first === undefined ? undefined : body.slice(0, start(first.node)).split('\n').length;
}

/** The quotes that open with `>>>`, outermost of each run of signs, in order, with the container each is in. */
function sectionOpeners(body: string): Opener[] {
  const openers: Opener[] = [];
  visit(parse(body), (node, ancestors) => {
    if (node.type !== 'blockquote' || !body.startsWith('>>>', start(node))) return;
    const parent = ancestors.at(-1)!;
    // A later sign of a run that opened at the quote above it is part of that run.
    if (parent.type === 'blockquote' && /^>+$/.test(body.slice(start(parent), start(node)))) return;
    openers.push({ node, parent, depth: ancestors.length });
  });
  return openers;
}

/** The line's prefix of containers, and the same prefix for the lines after it (a list marker as its indent). */
function prefixes(body: string, at: number): { lineStart: number; linePrefix: string; prefix: string } {
  const lineStart = body.lastIndexOf('\n', at - 1) + 1;
  const linePrefix = body.slice(lineStart, at);
  return { lineStart, linePrefix, prefix: linePrefix.replace(/[*+-]|\d{1,9}[.)]/g, (marker) => ' '.repeat(marker.length)) };
}

function lineEndAt(body: string, at: number): number {
  const lineEnd = body.indexOf('\n', at);
  return lineEnd === -1 ? body.length : lineEnd;
}

/** Blank lines that set apart each `>>>` line of a quote that runs on past its first line. */
function splitEdits(body: string, node: Nodes, depth: number): Edit[] {
  const at = start(node);
  const firstEnd = lineEndAt(body, at);
  if (end(node) <= firstEnd) return [];
  const { prefix } = prefixes(body, at);
  const blank = prefix.trimEnd();
  const edits: Edit[] = [{ from: firstEnd, to: firstEnd, text: `\n${blank}`, depth }];
  for (let lineStart = firstEnd + 1; lineStart < end(node); lineStart = lineEndAt(body, lineStart) + 1) {
    const line = body.slice(lineStart, lineEndAt(body, lineStart));
    const content = line.startsWith(prefix) ? line.slice(prefix.length) : line.startsWith(blank) ? line.slice(blank.length) : line;
    if (!/^ {0,3}>>>/.test(content)) continue;
    edits.push({ from: lineStart, to: lineStart, text: `${blank}\n`, depth });
    const lineEnd = lineEndAt(body, lineStart);
    if (lineEnd < end(node)) edits.push({ from: lineEnd, to: lineEnd, text: `\n${blank}`, depth });
  }
  return edits;
}

/** The edits that write the section lines of one container as Linear writes them. */
function containerEdits(body: string, openers: readonly Opener[]): Edit[] {
  const edits: Edit[] = [];
  let open = 0;
  let prefix = '';
  const depth = openers[0]!.depth;
  for (const { node } of openers) {
    const at = start(node);
    const line = prefixes(body, at);
    prefix = line.prefix;
    const blank = prefix.trimEnd();
    // A line that interrupts a paragraph gets the blank line before it that Linear writes.
    const before = line.lineStart > 0 && prefix === line.linePrefix ? `${blank}\n` : '';
    const lineEnd = lineEndAt(body, at);
    const title = body.slice(at, lineEnd).replace(/^>+/, '').trim();
    const lead = `${before}${line.linePrefix}`;
    const between = `\n${blank}\n${prefix}`;
    let written: string;
    let lines = 1;
    if (title === '' && open > 0) {
      written = Array.from({ length: open }, () => '+++').join(between);
      lines = open;
      open = 0;
    } else {
      open++;
      written = `+++ ${title}`;
    }
    const starts = Array.from({ length: lines }, (_, index) => lead.length + index * ('+++'.length + between.length));
    const role = written.startsWith('+++ ') ? 'open' : 'close';
    edits.push({ from: line.lineStart, to: lineEnd, text: `${lead}${written}\n${blank}`, depth, lines, marks: { at: starts, role } });
  }
  if (open > 0) {
    const parent = openers[0]!.parent;
    // After the container's last line, spaces and tabs included. A list
    // item's own end can run into the next item's marker (after an open
    // fence): its last block ends where its text does.
    const last = 'children' in parent ? (parent.children as Nodes[]).at(-1) : undefined;
    let containerEnd = parent.type === 'root' ? body.length : end(last ?? parent);
    while (body[containerEnd] === ' ' || body[containerEnd] === '\t') containerEnd++;
    const closer = `\n${prefix.trimEnd()}\n${prefix}+++`;
    const starts = Array.from({ length: open }, (_, index) => (index + 1) * closer.length - '+++'.length);
    edits.push({ from: containerEnd, to: containerEnd, text: closer.repeat(open), depth, lines: open, marks: { at: starts, role: 'end' } });
  }
  return edits;
}

/**
 * Applies edits from the end. Of two at one place, the outer container's
 * goes in first, so the inner one's text comes before it.
 */
function applyEdits(body: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || a.depth - b.depth);
  for (const edit of sorted) body = body.slice(0, edit.from) + edit.text + body.slice(edit.to);
  return body;
}

/**
 * `applyEdits`, also giving where the edits' marks start in the result and
 * where the given points of the body moved to (a point at the end of an
 * edit, or where one inserts, moves past its text). The edits must not overlap.
 */
function applyTrackedEdits(body: string, edits: readonly Edit[], points: readonly number[] = []): { body: string; marks: Map<number, OpenerLine>; points: number[] } {
  // The order `applyEdits` leaves them in: of two at one place, the inner one's text first.
  const sorted = [...edits].sort((a, b) => a.from - b.from || b.depth - a.depth);
  let result = '';
  let cursor = 0;
  const marks = new Map<number, OpenerLine>();
  const moved: Array<{ to: number; shift: number }> = [];
  for (const [run, edit] of sorted.entries()) {
    result += body.slice(cursor, edit.from);
    for (const at of edit.marks?.at ?? []) marks.set(result.length + at, { role: edit.marks!.role, run });
    result += edit.text;
    cursor = edit.to;
    moved.push({ to: edit.to, shift: result.length - edit.to });
  }
  result += body.slice(cursor);
  const shifted = points.map((point) => point + (moved.findLast((edit) => edit.to <= point)?.shift ?? 0));
  return { body: result, marks, points: shifted };
}

/** The paragraph lines that start with `+++`: the section lines Linear reads. */
function sectionLineCount(body: string, skip: (at: number) => boolean = () => false): number {
  let count = 0;
  visit(parse(body), (node) => {
    if (node.type !== 'paragraph') return;
    const from = start(node);
    for (const match of body.slice(from, end(node)).matchAll(/(?:^|\n)[ \t>]*\+{3}/g)) if (!skip(from + match.index)) count++;
  });
  return count;
}

/** The paragraph lines that start with `+++`, other than a `>>>` line's title. */
function plusLineCount(body: string, openers: readonly Opener[]): number {
  const titles = openers.map(({ node }) => [start(node), lineEndAt(body, start(node))] as const);
  return sectionLineCount(body, (at) => titles.some(([from, to]) => from <= at && at <= to));
}
