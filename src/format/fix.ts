// `fix`: rewrites Markdown into the form Linear stores, so a round trip
// through Linear changes nothing. Block structure is written the way Linear
// writes it; inline text is copied from the source with a few targeted
// rewrites. A text with a construct Linear would lose or alter is left as it
// is: the author decides. The image place rules do not stop `fixText` (see
// IMAGE_PLACE_RULES); the `fix` command leaves a file with any of their
// findings. Neither stops at a rule whose construct `fix` writes in Linear's
// form (FIXED_RULES).

import type { BlockContent, Definition, DefinitionContent, Delete, Emphasis, Link, List, ListItem, Nodes, Paragraph, PhrasingContent, Root, RootContent, Strong, Table, TableRow, Text } from 'mdast';
import { isDeepStrictEqual } from 'node:util';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { nameToEmoji } from 'gemoji';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { findMarkerLines } from '../merge/markers.ts';
import { lintText, overContentLimit, paddingOverLimit, referencesOverLimit } from './lint.ts';
import { CONTENT_LIMIT, FIXED_RULES, IMAGE_PLACE_RULES } from './rules.ts';
import { plusSectionsAsLinear, sectionOpenersAsLinear } from './sections.ts';
import { tabReferences } from './tab-reference.ts';
import { ALERT, LINKED_BOLD_ITALIC_SUFFIX, MarkdownLimitError, advanceColumn, bracketedLabel, codeSpans, decodedDestinationPath, end, hasOuterStars, imageDestination, isCallout, isCalloutComment, joinFile, linearMarkersAsText, linkDestination, nestedFileBlocksOnItemLine, parse, quoteLines, sameMarkdown, splitFile, start, visit, withoutTrailingNewlines } from './markdown.ts';

export { imageDestination, linkDestination } from './markdown.ts';

/** What `fix` may know about the file beyond its text. */
export interface FixOptions {
  /**
   * Whether the file a relative link points to exists. The sync uploads a
   * linked file that exists, and Linear stores a link to an uploaded file
   * differently from a link it cannot resolve. Without this, every linked
   * file is taken to exist.
   */
  linkedFileExists?: (url: string) => boolean;
}

/**
 * Returns the text in Linear's form, or the text itself when lint finds a
 * construct Linear would lose or alter. Throws `MarkdownLimitError` when a
 * rewrite takes the text over the Markdown limits, which lint cannot see in
 * the source.
 */
export function fixText(text: string, options: FixOptions = {}): string {
  if (lintText('', text).some((finding) => !IMAGE_PLACE_RULES.has(finding.rule) && !FIXED_RULES.has(finding.rule))) return text;
  const { head, body } = splitFile(text);
  const normalized = tabReferences(body.replace(/\r\n?/g, '\n')).text;
  const sections = sectionOpenersAsLinear(normalized);
  const lf = sections === normalized ? plusSectionsAsLinear(sections) : sections;
  if (lf === undefined) return text;
  const unbroken = backslashBreaksAsLinear(lf);
  if (unbroken === undefined) return text;
  const fixed = fixBody(unbroken, options);
  if (fixed === undefined) return text;
  // The writer can still lose a line ending of a former break (text split
  // off at an image is trimmed, a lazy line given its prefix can open a
  // block): such a file stays with its author.
  if (unbroken !== lf && lineEndings(fixed) < lineEndings(unbroken)) return text;
  return joinFile(head, fixed);
}

/**
 * The line endings inside paragraphs: hard breaks and the line endings of
 * text. A heading's are left out: `fix` writes a heading on one line (lint
 * reports one whose text runs over lines; a code span's line ending is a space).
 */
function lineEndings(body: string): number {
  let count = 0;
  visit(parse(body), (node, ancestors) => {
    if (ancestors.some((ancestor) => ancestor.type === 'heading')) return;
    if (node.type === 'break') count++;
    else if (node.type === 'text') count += lineBreaks(node.value);
  });
  return count;
}

/**
 * The body with each backslash line break written as Linear writes it: the
 * line without its backslash, keeping the spaces or tabs before it. Linear
 * holds every line ending of a paragraph as a line break, so the break
 * stays one there. Undefined when that would change what the Markdown says
 * beyond the break, so the file stays with its author: a break in a
 * heading, which `fix` writes on one line, or a line that reads
 * differently without its backslash (`#\`, `=\`, `***\`, a backslash alone
 * on its line).
 */
function backslashBreaksAsLinear(body: string): string | undefined {
  if (!body.includes('\\')) return body;
  const tree = parse(body);
  const breaks: number[] = [];
  let unwritable = false;
  visit(tree, (node, ancestors) => {
    if (node.type !== 'break' || body[start(node)] !== '\\') return;
    // A break that opens its paragraph (after a task checkbox) has no text for the spaces to follow.
    const parent = ancestors.at(-1);
    const siblings = parent !== undefined && 'children' in parent ? (parent.children as Nodes[]) : [];
    const leading = siblings.slice(0, siblings.indexOf(node)).every((sibling) => sibling.type === 'text' && sibling.value.trim() === '');
    if (leading || ancestors.some((a) => a.type === 'heading')) unwritable = true;
    breaks.push(start(node));
  });
  if (breaks.length === 0) return body;
  if (unwritable) return undefined;
  let written = '';
  let at = 0;
  for (const backslash of breaks.sort((a, b) => a - b)) {
    written += body.slice(at, backslash);
    at = backslash + 1;
  }
  written += body.slice(at);
  return isDeepStrictEqual(breakShape(parse(written)), breakShape(tree)) ? written : undefined;
}

/**
 * A tree without positions, where a line break is a line ending of the
 * text around it (Linear holds both as one break), adjacent text is joined,
 * and spaces and tabs before a line ending go (they do not render).
 */
function breakShape(tree: Root): unknown {
  const shape = (node: Nodes): unknown => {
    const { position: _position, ...rest } = node;
    if (!('children' in node)) return rest;
    const children: unknown[] = [];
    let text: string | undefined;
    const flush = () => {
      if (text !== undefined && text !== '') children.push({ type: 'text', value: text.replace(/[ \t]+\n/g, '\n') });
      text = undefined;
    };
    for (const child of node.children as Nodes[]) {
      if (child.type === 'text' || child.type === 'break') {
        text = (text ?? '') + (child.type === 'text' ? child.value : '\n');
      } else {
        flush();
        children.push(shape(child));
      }
    }
    flush();
    return { ...rest, children };
  };
  return shape(tree);
}

function fixBody(body: string, options: FixOptions): string | undefined {
  if (body.trim() === '' && !body.includes(NBSP)) return '';
  let current = body;
  let rewroteSections = false;
  // A rewrite can expose another (an inline image leaves its paragraph):
  // repeat until the text no longer changes.
  for (let pass = 0; pass < 5; pass++) {
    const source = pass === 0 ? current : plusSectionsAsLinear(current);
    rewroteSections ||= source !== current;
    let tree = parse(source, [], true);
    const adjacent = adjacentBoldAsLinear(source, tree);
    if (adjacent !== source) tree = parse(adjacent, [], true);
    // Lint checked the source; a rewrite may expose a table or references it
    // did not see. Text split off at an image is escaped so it exposes none:
    // this guard keeps the limits for any rewrite that still does.
    if ((pass > 0 || adjacent !== source) && (paddingOverLimit(tree) !== undefined || referencesOverLimit(tree, adjacent) !== undefined)) throw new MarkdownLimitError('nodes');
    // The writer copies text by source offset. A node the parser left
    // without one (a link the bare-URL search inside text found but could
    // not place, which lint reports as `unplaced-link`) would make it copy
    // the wrong text: leave the body as it came.
    if (hasUnplacedNode(tree)) return body;
    let writer = new Writer(adjacent, tree, options);
    let next = writer.root();
    let rewriteEscapes = true;
    let rewriteTildeUnderscore = true;
    if (writer.compareEscapes) {
      const fallback = new Writer(adjacent, tree, options, false);
      const withOriginalEscapes = fallback.root();
      // Edits can expose syntax across inline nodes even when an edited
      // character would be safe in its own node or on its own line.
      if (!sameMarkdown(next, withOriginalEscapes)) {
        // An escaped `~` or `_` can move a link's end: give those up first,
        // and the other escapes only if the document still changes.
        const withoutTildeUnderscore = new Writer(adjacent, tree, options, true, true, false);
        const partial = withoutTildeUnderscore.root();
        if (sameMarkdown(partial, withOriginalEscapes)) {
          rewriteTildeUnderscore = false;
          next = partial;
          writer = withoutTildeUnderscore;
        } else {
          rewriteEscapes = false;
          next = withOriginalEscapes;
          writer = fallback;
        }
      }
    }
    if (writer.rewroteAsterisks) {
      // The escapes given up above stay given up there.
      const withOriginalAsterisks = new Writer(adjacent, tree, options, rewriteEscapes, false, rewriteTildeUnderscore).root();
      // A locally equivalent edit can still affect a surrounding block.
      if (!sameMarkdown(next, withOriginalAsterisks)) next = withOriginalAsterisks;
    }
    next = linearBoldForms(next, next === adjacent ? tree : undefined);
    if (next === current) return next;
    current = next;
  }
  // Any section edit still changing after the passes is ambiguous.
  return rewroteSections ? undefined : current;
}

const SPLIT_BOLD_PUNCTUATION = new Set(['()', '[]', '«»', ':!', ':?', '(!']);

/** Linear closes the first bold span at the second boundary. */
function adjacentBoldAsLinear(body: string, tree: Root): string {
  if (!body.includes('**')) return body;
  const groups = new Map<Nodes, Edit[]>();
  visit(tree, (node, ancestors) => {
    if (node.type !== 'strong' || node.position!.start.line !== node.position!.end.line
      || ancestors.some((parent) => parent.type === 'strong' || parent.type === 'emphasis')) return;
    if (body.slice(start(node), start(node) + 2) !== '**') return;
    const [first, ...rest] = node.children;
    if (first?.type !== 'text' || rest.at(-1)?.type !== 'text') return;
    // Linear joins the opening punctuation's span to the next bold text
    // and leaves the closing punctuation outside it.
    const [inner, closing] = rest;
    if (rest.length === 2 && inner?.type === 'strong' && closing?.type === 'text'
      && SPLIT_BOLD_PUNCTUATION.has(first.value + closing.value)
      && body.slice(start(inner), start(inner) + 2) === '**'
      && end(first) === start(inner) && end(inner) === start(closing)) {
      const block = ancestors[1] ?? node;
      const edits = groups.get(block) ?? [];
      edits.push({ from: start(inner), to: start(inner) + 2, text: '' }, { from: end(node) - 2, to: end(node), text: '' });
      groups.set(block, edits);
      return;
    }
    const boundaries = rest.filter((part) => part.type === 'strong');
    if (boundaries.length === 0 || rest.some((part) => part.type !== 'text' && part.type !== 'strong')) return;
    if (boundaries.some((part) =>
      body.slice(start(part), start(part) + 4) !== '****' || body.slice(end(part) - 4, end(part)) !== '****'
      || part.children.length !== 1 || part.children[0]?.type !== 'strong'
      || part.children[0].children.some((child) => child.type !== 'text'))) return;
    const block = ancestors[1] ?? node;
    const edits = groups.get(block) ?? [];
    for (const [index, part] of boundaries.entries()) {
      edits.push(
        { from: start(part), to: start(part) + (index === 0 ? 4 : 2), text: '' },
        { from: end(part) - 2, to: end(part), text: '' },
      );
    }
    edits.push({ from: end(node) - 2, to: end(node), text: '' });
    groups.set(block, edits);
  });
  // Changing these bold marks must leave links, other styles and text intact.
  return reSpellBold(body, groups, true) ?? body;
}

/** Re-spell bold across line breaks and around a single link in the written body. */
function linearBoldForms(body: string, tree?: Root, splitLines = true): string {
  if (!body.includes('**') && !body.includes('__')) return body;
  const blocks = new Map<Nodes, { breaks: Edit[]; links: Edit[]; added: number }>();
  if (tree === undefined) {
    tree = parse(body, [], true);
    if (hasUnplacedNode(tree)) return body;
  }
  visit(tree, (node, ancestors) => {
    const block = ancestors[1] ?? node;
    let edits = blocks.get(block);
    const group = () => {
      if (edits === undefined) {
        edits = { breaks: [], links: [], added: 0 };
        blocks.set(block, edits);
      }
      return edits;
    };
    if (node.type === 'strong' || node.type === 'emphasis') {
      const parent = ancestors.at(-1);
      if (!((parent?.type === 'strong' || parent?.type === 'emphasis') && parent.children.length === 1)) {
        const edit = splitItalicSpans(body, node) ?? boldLinkEdit(body, node) ?? boldItalicEdit(body, node);
        if (edit !== undefined) group().links.push(edit);
      }
    }
    if (!splitLines || (edits?.added ?? 0) > 2 * CONTENT_LIMIT) return;
    if (node.type !== 'break' && (node.type !== 'text' || node.position!.start.line === node.position!.end.line)) return;
    if (!ancestors.some((parent) => parent.type === 'strong')) return;
    // Code, HTML and image labels have no text-node break to rewrite.
    // Only explicit links can be closed and opened with the same destination.
    if (ancestors.some((parent) => parent.type === 'linkReference')) return;
    const split = group();
    const opens: string[] = [];
    const closes: string[] = [];
    let quotes = 0;
    for (const parent of ancestors) {
      if (parent.type === 'blockquote') quotes++;
      if (parent.type === 'strong' || parent.type === 'emphasis' || parent.type === 'delete') {
        const width = parent.type === 'strong' ? 2 : 1;
        const mark = parent.type === 'delete' ? /^~{1,2}/.exec(body.slice(start(parent), start(parent) + 2))![0] : undefined;
        opens.push(mark ?? body.slice(start(parent), start(parent) + width));
        closes.push(mark ?? body.slice(end(parent) - width, end(parent)));
      }
      if (parent.type === 'link') {
        opens.push('[');
        closes.push(body.slice(end(parent.children.at(-1)!), end(parent)));
      }
    }
    const open = opens.join('');
    const close = closes.reverse().join('');
    for (let at = body.indexOf('\n', start(node)); at !== -1 && at < end(node); at = body.indexOf('\n', at + 1)) {
      let left = at;
      while (/[^\S\r\n]/u.test(body[left - 1] ?? '')) left--;
      let right = at + 1;
      // The writer has already supplied explicit quote and item prefixes.
      for (let index = 0; index < quotes; index++) {
        while (isSpaceOrTab(body[right]!)) right++;
        if (body[right] === '>') right++;
      }
      while (/[^\S\r\n]/u.test(body[right] ?? '')) right++;
      if (body[left - 1] === '\n' || body[right] === '\n') continue;
      // Reopening a link repeats its destination. Bound the rewrite before
      // assembling the candidate, even if every character uses two code units.
      split.added += close.length + open.length;
      if (split.added > 2 * CONTENT_LIMIT) break;
      split.breaks.push({ from: left, to: left, text: close }, { from: right, to: right, text: open });
    }
  });
  // Split the lines first. A link can then be the only content of one of
  // the new bold spans, even if it was only part of the original span.
  const breaks = new Map<Nodes, Edit[]>();
  const links = new Map<Nodes, Edit[]>();
  for (const [block, edits] of blocks) {
    if (edits.breaks.length > 0 && edits.added <= 2 * CONTENT_LIMIT) breaks.set(block, edits.breaks);
    if (edits.links.length > 0) links.set(block, edits.links);
  }
  const split = reSpellBold(body, breaks);
  return split === undefined ? reSpellBold(body, links) ?? body : linearBoldForms(split, undefined, false);
}

/** A pair of outer stars around spaced italic spans adds no visible emphasis. */
function splitItalicSpans(body: string, node: PhrasingContent): Edit | undefined {
  if (!hasOuterStars(body, node)) return;
  return { from: start(node), to: end(node), text: body.slice(start(node) + 1, end(node) - 1) };
}

/** Coextensive bold and italic use one three-star delimiter on each side. */
function boldItalicEdit(body: string, outer: PhrasingContent): Edit | undefined {
  let node = outer;
  let bold = false;
  let italic = false;
  while (node.type === 'strong' || node.type === 'emphasis') {
    bold ||= node.type === 'strong';
    italic ||= node.type === 'emphasis';
    if (node.children.length !== 1 || (node.children[0]?.type !== 'strong' && node.children[0]?.type !== 'emphasis')) break;
    node = node.children[0];
  }
  if (!bold || !italic || (node.type !== 'strong' && node.type !== 'emphasis')) return;
  const width = node.type === 'strong' ? 2 : 1;
  const text = '***' + body.slice(start(node) + width, end(node) - width) + '***';
  if (text === body.slice(start(outer), end(outer))) return;
  return { from: start(outer), to: end(outer), text };
}

/** A leading link can carry the marks in its label, with the remaining text marked separately. */
function boldLinkEdit(body: string, outer: PhrasingContent): Edit | undefined {
  let node = outer;
  let bold = false;
  let italic = false;
  let suffix = '';
  while (node.type === 'strong' || node.type === 'emphasis') {
    bold ||= node.type === 'strong';
    italic ||= node.type === 'emphasis';
    const first = node.children[0];
    if (first === undefined) return;
    if (node.children.length > 1) {
      if (first.type !== 'link' || !node.children.slice(1).every((child) => child.type === 'text')) return;
      suffix = body.slice(end(first), end(node) - (node.type === 'strong' ? 2 : 1));
    }
    node = first;
  }
  if (node.type !== 'link' || body[start(node)] !== '[' || node.position!.start.line !== node.position!.end.line) return;
  if (!bold && (suffix !== '' || node.children.length !== 1 || node.children[0]?.type !== 'strong')) return;
  if (suffix.includes('\n')) return;
  const last = node.children.at(-1);
  if (last === undefined) return;
  const label = body.slice(start(node) + 1, end(last));
  if (label === '' || label !== label.trim()) return;
  const text = node.children.map((child) => child.type === 'strong'
    ? body.slice(start(child) + 2, end(child) - 2) : body.slice(start(child), end(child))).join('');
  const mark = italic ? '***' : '**';
  const markedSuffix = suffix === '' ? '' : mark + suffix + mark;
  if (/^\s/u.test(suffix) && (!italic || !LINKED_BOLD_ITALIC_SUFFIX.test(markedSuffix))) return;
  return { from: start(outer), to: end(outer), text: `[${mark}${text}${mark}${body.slice(end(last), end(node))}${markedSuffix}` };
}

function reSpellBold(body: string, groups: ReadonlyMap<Nodes, Edit[]>, ignoreBold = false): string | undefined {
  if (groups.size === 0) return undefined;
  const equivalent = (from: number, to: number, edits: Edit[]): string | undefined => {
    const candidate = rewriteBoldRange(body, from, to, edits);
    if (candidate === undefined) return;
    try {
      if (sameMarkdown(body.slice(from, to), candidate, { linearBoldForms: !ignoreBold, ignoreBold })) return candidate;
    } catch (error) {
      if (!(error instanceof MarkdownLimitError)) throw error;
    }
  };
  const all = [...groups.values()].flat();
  const full = equivalent(0, body.length, all);
  if (full !== undefined || groups.size === 1) return full;
  // Keep edits in independent blocks even if another block has markup that
  // cannot be split safely. Check the retained edits in the full document too.
  const safe: Edit[] = [];
  for (const [block, edits] of groups) {
    if (equivalent(start(block), end(block), edits) !== undefined) {
      for (const edit of edits) safe.push(edit);
    }
  }
  return equivalent(0, body.length, safe);
}

function rewriteBoldRange(body: string, from: number, to: number, edits: Edit[]): string | undefined {
  if (edits.length === 0) return undefined;
  const length = edits.reduce((size, edit) => size + edit.text.length - (edit.to - edit.from), to - from);
  if (length > 2 * CONTENT_LIMIT) return undefined;
  const parts: string[] = [];
  let at = from;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    if (edit.from < at || edit.to > to) return undefined;
    parts.push(body.slice(at, edit.from), edit.text);
    at = edit.to;
  }
  parts.push(body.slice(at, to));
  const candidate = parts.join('');
  return overContentLimit(candidate) ? undefined : candidate;
}

type Edit = { from: number; to: number; text: string };
type InlineEdits = { edits: Edit[]; rewriteAsterisks: boolean; changedAsterisks: boolean };

/** A container whose prefix starts each source line of its content: a quote, or a list item's indentation. */
/** `content` is the source offset where the container's content starts on its first line. */
type Container = (
  | { kind: 'quote'; content: number }
  | { kind: 'item'; indent: number; content: number; written?: number }
) & { markerBrackets?: readonly [number, number] };

// Characters that start a block when they open a line (`<` an HTML block).
const BLOCK_START = /^(?:[<>#*+\-=_`~|]|\d{1,9}[.)]|\d+\\?\.(?=[ \t\u00a0]))/;

// A number with a dot and text after it, which `fix` escapes where it starts a paragraph line.
const NUMBER_TEXT = /^\d+\\?\.[ \t\u00a0]+[^ \t\u00a0]/;

// A paragraph of `$$` lines around math, which `fix` writes as a `math` fence.
const MATH_PARAGRAPH = /^\$\$\n([\s\S]*)\n\$\$$/;

// A list marker that opens a text: a bullet or a number with its delimiter,
// followed by a space, a tab or the end of the line.
const LIST_MARKER_START = /^(?:[*+-]|\d{1,9}[.)])(?=[ \t\n]|$)/;

const LINEAR_ALERT = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

// A `<br>` tag, in any case and with or without its slash.
const CELL_BREAK = /^<br[ \t]*\/?>$/i;

class Writer {
  private readonly definitions = new Map<string, Definition>();
  private readonly containers: Container[] = [];
  private readonly source: string;
  private readonly tree: Root;
  private readonly options: FixOptions;
  private readonly rewriteEscapes: boolean;
  private readonly rewriteAsterisks: boolean;
  /** Whether literal `~` and `_` get Linear's escapes; the first part of the text's escapes to give up when they change the document. */
  private readonly rewriteTildeUnderscore: boolean;
  compareEscapes = false;
  rewroteAsterisks = false;
  private conflictCallouts: Set<number> | undefined;
  private textLine: { from: number; to: number; first: number; last: number; delimiter: boolean; equalsOnly: boolean; indent?: number; unicodeLead?: number } | undefined;
  /** Where the table cell being written starts its text: an escape there stays. */
  private cellStart: number | undefined;
  /** Whether the text being written is a table cell's. */
  private inCell = false;
  /** The indent of the file block whose label is being written: its later lines carry no prefix for it. */
  private fileBlockIndent = 0;
  /** Whether the text being written is an autolink's, where a backslash escapes nothing. */
  private literal = false;
  /** Where the inline text being written starts: its line is no continuation line. */
  private inlineFrom = -1;
  /** The bounds of the block's inline text being written (a paragraph's, heading's or cell's), not a link label's. */
  private blockInline: [number, number] | undefined;
  /** The space references `edgeSpaceEdits` has moved, by offset: an inner run of marks leaves them. */
  private readonly movedSpaces = new Set<number>();
  /** The space edits made so far in the block being written, which a later one is checked with. */
  private spaceEdits: Edit[] = [];
  /** The paragraph that follows a task item's checkbox: it does not start its line. */
  private taskParagraph: Paragraph | undefined;
  /** A list's sibling block written right before it, when that is a list. */
  private readonly listBefore = new Map<List, List>();

  constructor(source: string, tree: Root, options: FixOptions, rewriteEscapes = true, rewriteAsterisks = true, rewriteTildeUnderscore = true) {
    this.source = source;
    this.tree = tree;
    this.options = options;
    this.rewriteEscapes = rewriteEscapes;
    this.rewriteAsterisks = rewriteAsterisks;
    this.rewriteTildeUnderscore = rewriteTildeUnderscore;
    visit(tree, (node) => {
      if (node.type === 'definition' && !this.definitions.has(node.identifier)) this.definitions.set(node.identifier, node);
      if (!('children' in node)) return;
      // Definitions are not written in place: the block before is the one written before.
      const written = (node.children as Nodes[]).filter((child) => child.type !== 'definition');
      written.forEach((child, index) => {
        const before = written[index - 1];
        if (child.type === 'list' && before?.type === 'list') this.listBefore.set(child, before);
      });
    });
  }

  /** Linear ends a document whose last block is a table, also in a quote or list item, with a line break. */
  root(): string {
    const text = this.blocks(this.tree.children);
    return endsWithTable(this.tree) ? `${text}\n` : text;
  }

  /**
   * Sibling blocks, one blank line apart, except that Linear writes a
   * callout's color comment directly above the callout. Reference
   * definitions are written inline instead.
   */
  private blocks(nodes: readonly (RootContent | BlockContent | DefinitionContent)[]): string {
    return this.writtenBlocks(nodes).text;
  }

  /**
   * The blocks as `blocks` writes them, and the lines (1-based) of the text
   * that belong to a code block among them. A block quote needs those lines
   * to write its blank code lines; taking them from the writer, not from a
   * parse of the written text, keeps nested quotes from parsing their
   * content once per level.
   */
  private writtenBlocks(nodes: readonly (RootContent | BlockContent | DefinitionContent)[]): { text: string; codeLines: Set<number> } {
    const written = nodes
      .filter((node) => node.type !== 'definition')
      .map((node) => ({ node, parts: this.block(node) }))
      .filter(({ parts }) => parts.length > 0);
    const codeLines = new Set<number>();
    // Lines are counted only up to the last code block: no later line is code.
    const lastCode = written.findLastIndex(({ node }) => node.type === 'code');
    let line = 1;
    const text = written
      .map(({ node, parts }, index) => {
        const next = written[index + 1];
        const block = parts.join('\n\n');
        const separator = next === undefined ? '' : isCalloutComment(node) && isCallout(next.node, this.source) ? '\n' : '\n\n';
        if (index <= lastCode) {
          const breaks = lineBreaks(block);
          if (node.type === 'code') for (let at = line; at <= line + breaks; at++) codeLines.add(at);
          line += breaks + separator.length;
        }
        return block + separator;
      })
      .join('');
    return { text, codeLines };
  }

  private block(node: RootContent | BlockContent | DefinitionContent): string[] {
    switch (node.type) {
      case 'paragraph':
        return this.paragraph(node);
      case 'heading': {
        // A setext heading can span lines; an ATX heading is one line.
        // Linear keeps a trailing NBSP, and the space after an empty heading's hashes.
        const hashes = '#'.repeat(node.depth);
        const heading = trimEndKeepingNbsp(`${hashes} ${joinLines(this.inline(node.children))}`);
        return [heading === hashes ? `${hashes} ` : heading];
      }
      case 'thematicBreak':
        return ['---'];
      case 'blockquote': {
        // Linear writes an empty quote with the space after its sign.
        if (node.children.length === 0) return ['> '];
        const marker = this.source.indexOf('>', start(node));
        const content = marker + (this.source[marker + 1] === ' ' ? 2 : 1);
        const container: Container = { kind: 'quote', content };
        const first = node.children[0];
        let canonicalAlert: string | undefined;
        if (first?.type === 'paragraph' && first.children[0]?.type === 'text' && first.position!.start.line === node.position!.start.line) {
          const alert = start(first);
          const lineEnd = this.source.indexOf('\n', alert);
          const firstLine = this.source.slice(alert, lineEnd === -1 ? undefined : lineEnd);
          if (LINEAR_ALERT.test(firstLine)) {
            canonicalAlert = firstLine.trimEnd().toUpperCase();
            container.markerBrackets = [alert, alert + canonicalAlert.length - 1];
          } else if (this.containers.length === 0 && ALERT.test(firstLine) && this.isConflictCallout(node.position!.start.line)) {
            container.markerBrackets = [alert, alert + firstLine.indexOf(']')];
          }
        }
        this.containers.push(container);
        const { text, codeLines } = this.writtenBlocks(node.children);
        this.containers.pop();
        return [quoteLines(canonicalAlert === undefined ? text : canonicalAlert + text.slice(canonicalAlert.length), codeLines)];
      }
      case 'list':
        return [this.list(node)];
      case 'code': {
        // Linear writes a top-level code block with one line break fewer
        // than it holds, so blank lines before its closing fence shrink on
        // every new document: only none of them comes back as written. In a
        // quote or list item they come back as written.
        const value = this.containers.length === 0 ? withoutTrailingNewlines(node.value) : node.value;
        const info = [node.lang, node.meta].filter(Boolean).join(' ');
        // A backtick fence cannot carry a backtick in its info string; keep tildes then.
        const mark = info.includes('`') ? '~' : '`';
        const longest = Math.max(0, ...[...value.matchAll(mark === '`' ? /`+/g : /~+/g)].map((m) => m[0].length));
        const fence = mark.repeat(Math.max(3, longest + 1));
        return [`${fence}${info}\n${value}${value === '' ? '' : '\n'}${fence}`];
      }
      case 'html':
        return [node.value];
      case 'table':
        return [this.table(node)];
      default:
        // Nodes lint refuses (footnote definitions) never reach here; keep any other as written.
        return [this.source.slice(start(node), end(node))];
    }
  }

  /** The merge detector accepts an edited alert kind on a sync conflict. */
  private isConflictCallout(line: number): boolean {
    this.conflictCallouts ??= new Set([...findMarkerLines(this.source).values()].flatMap((marker) => marker.calloutLine === undefined ? [] : [marker.calloutLine]));
    return this.conflictCallouts.has(line);
  }

  /** A paragraph; `$$` math becomes a `math` fence, and an image shares no paragraph with text. */
  private paragraph(node: Paragraph): string[] {
    const raw = this.source.slice(start(node), end(node));
    const math = MATH_PARAGRAPH.exec(raw);
    if (math) return [`\`\`\`math\n${math[1]}\n\`\`\``];
    // A section without a title: Linear writes its opener with the space.
    if (/^\+{3}[ \t]+$/.test(raw)) return ['+++ '];
    const isImage = (child: PhrasingContent): boolean => child.type === 'image' || child.type === 'imageReference';
    const images = node.children.filter(isImage).length;
    const hasText = node.children.some((child) => !isImage(child) && !(child.type === 'text' && child.value.trim() === ''));
    if (images === 0 || (!hasText && images === 1)) {
      this.wholeParagraphEnd = node.children.length > 0 ? end(node.children.at(-1)!) : undefined;
      const text = node === this.taskParagraph ? this.inline(node.children, 'continuation') : this.paragraphText(node.children);
      this.wholeParagraphEnd = undefined;
      return [escapeLiteralSectionEnd(text)];
    }
    // Linear holds images as blocks: text before and after an image becomes its own paragraph.
    const parts: PhrasingContent[][] = [[]];
    for (const child of node.children) {
      if (isImage(child)) parts.push([child], []);
      else parts.at(-1)!.push(child);
    }
    // The first part of a task item's paragraph follows its checkbox: it does not start its line.
    return parts
      .map((part, index) => {
        const afterCheckbox = index === 0 && node === this.taskParagraph;
        const text = afterCheckbox ? trimKeepingNbsp(this.inline(part, 'continuation')) : this.paragraphText(part, true);
        return escapeLiteralSectionEnd(paragraphPart(text, !afterCheckbox));
      })
      .filter((part) => part !== '');
  }

  /**
   * A paragraph's text, which starts a line. Text that starts like a list
   * marker gets its marker escaped: it was text only because it could not
   * interrupt a paragraph (`Note` / `1. 3. plum`, where `3. plum` stays the
   * item's text), and the blank line `fix` writes before the list would
   * make it a list; Linear reads it as one either way. `trim` drops the
   * spaces around a part split off at an image.
   */
  private paragraphText(children: readonly PhrasingContent[], trim = false): string {
    const text = trim ? trimKeepingNbsp(this.inline(children, 'all')) : this.inline(children, 'all');
    if (children[0]?.type !== 'text') return text;
    const marker = LIST_MARKER_START.exec(text);
    if (marker === null) return text;
    const at = marker[0].length - 1;
    return `${text.slice(0, at)}\\${text.slice(at)}`;
  }

  /**
   * A list. Linear right-aligns the numbers of an ordered list to its
   * widest one (` 9.` above `10.`), and every item's content lines up past
   * that widest number. Where the padding would change what Markdown reads
   * (four spaces open indented code; as many as the content indent of a
   * list written just before put the item into that list), the numbers
   * stay unaligned.
   */
  private list(node: List, interruptsParagraph = false): string {
    const start = node.start ?? 1;
    // Linear holds the parts that two blank lines after an empty item split off as lists of their own.
    const parts: ListItem[][] = [];
    node.children.forEach((item, index) => {
      if (index === 0 || splitsAfter(node.children[index - 1]!, item)) parts.push([item]);
      else parts.at(-1)!.push(item);
    });
    const before = this.listBefore.get(node);
    let beforeIndent = before === undefined ? Infinity : itemIndent(before);
    let index = 0;
    return parts
      .map((items) => {
        const first = start + index;
        const last = first + items.length - 1;
        const padding = `${last}.`.length - `${first}.`.length;
        const width = node.ordered && padding <= 3 && padding < beforeIndent ? `${last}.`.length : 0;
        const written = items.map((item) => {
          const number = start + index++;
          const marker = item.checked !== null && item.checked !== undefined ? `- [${item.checked ? 'X' : ' '}]` : node.ordered ? `${number}.`.padStart(width) : '*';
          return this.listItem(item, marker, interruptsParagraph && number === start);
        });
        beforeIndent = !node.ordered || items.at(-1)!.checked != null ? 2 : `${last}.`.length + 1;
        return written.join('\n');
      })
      .join('\n\n\n');
  }

  /**
   * Whether an item's first line holds its text: not a file block or a
   * section below an empty marker line. The marker line of a list that
   * follows another without a blank line must not be empty.
   */
  private textOnMarkerLine(item: ListItem): boolean {
    const [first] = item.children;
    return first?.type === 'paragraph' && itemAttachment(item) === undefined && !/^\+{3}[ \t]*$/.test(this.source.slice(start(first), end(first)));
  }

  private listItem(item: ListItem, marker: string, interruptsParagraph: boolean): string {
    // Content lines line up after the bullet or number, not after a checkbox.
    const indent = ' '.repeat(/^ *[^ ]+/.exec(marker)![0].length + 1);
    const [first] = item.children;
    const bareCheckbox = item.checked == null && first?.type === 'paragraph' && first.children.length === 1 && first.children[0]?.type === 'text'
      && first.position!.start.line === item.position!.start.line
      ? /^\[([ xX])\]$/.exec(this.source.slice(start(first), end(first.children[0]))) : null;
    if (bareCheckbox && marker === '*' && item.children.length === 1) return `- [${bareCheckbox[1]!.toUpperCase()}] `;
    const attachment = itemAttachment(item);
    // A link to a file that does not exist is not uploaded: Linear keeps it as a link.
    if (attachment && this.options.linkedFileExists?.(attachment.url) !== false) {
      const path = decodedDestinationPath(attachment.url);
      const bullet = marker === '*';
      const task = item.checked != null;
      // Linear puts MP3 links on the bullet or number line and below a
      // task checkbox. The WAV and Ogg inline forms are recorded for bullets.
      const inlineAudio = (!task && MP3.test(path)) || (bullet && WAV_OR_OGG.test(path));
      if (!inlineAudio) {
        this.fileBlockIndent = indent.length;
        this.containers.push(this.itemContainer(item));
        const label = this.inline(attachment.children);
        this.containers.pop();
        this.fileBlockIndent = 0;
        const destination = imageDestination(attachment.url);
        if (bullet && VIDEO.test(attachment.url.split(/[?#]/)[0]!)) return `${marker} [${label}](${destination})`;
        // An empty marker cannot interrupt the parent paragraph. A task
        // marker already has content, so its file block can stay below it.
        if (!interruptsParagraph || marker.startsWith('- ')) {
          return `${marker} \n${indent}[${label}](${destination})`;
        }
      }
    }
    // Linear writes an empty item's marker with the space that would precede its text.
    if (first === undefined) return `${marker} `;
    const container = this.itemContainer(item);
    // The columns `fix` writes before the item's content lines.
    if (container.kind === 'item') container.written = indent.length;
    if (bareCheckbox) container.markerBrackets = [start(first!), start(first!) + 2];
    this.containers.push(container);
    if (item.checked !== null && item.checked !== undefined && first.type === 'paragraph') this.taskParagraph = first;
    // Blocks of an item are a blank line apart, but a nested list follows
    // its paragraph on the next line when it can interrupt that paragraph.
    // Ordered lists starting above or below 1, lists starting with an empty
    // item and existing file blocks need their blank line to stay separate
    // from the preceding paragraph.
    let content = '';
    // Lines (0-based) of the item's own code blocks: Linear indents their blank lines too.
    const codeLines = new Set<number>();
    let line = 0;
    item.children.forEach((child, index) => {
      const previous = item.children[index - 1];
      const interrupts = child.type === 'list'
        && previous?.type === 'paragraph'
        && opensWithText(child)
        && !(child.position!.start.line > previous.position!.end.line + 1 && startsWithFileBlock(child));
      // Linear writes a list of another kind (bullet, numbered, task) right
      // below the list before it in the same item. A marker that cannot
      // interrupt a paragraph keeps its blank line: the previous list's
      // last line would take it in.
      const followsList = child.type === 'list' && previous?.type === 'list'
        && listKind(previous, previous.children.at(-1)!) !== listKind(child, child.children[0]!)
        && opensWithText(child) && this.textOnMarkerLine(child.children[0]!);
      const separator = index === 0 ? '' : interrupts || followsList ? '\n' : '\n\n';
      const written = child.type === 'list' ? this.list(child, interrupts) : this.block(child).join('\n\n');
      line += separator.length;
      const breaks = lineBreaks(written);
      if (child.type === 'code') for (let at = line; at <= line + breaks; at++) codeLines.add(at);
      line += breaks;
      content += separator + written;
    });
    this.containers.pop();
    const lines = content.split('\n').map((text, at) => (text === '' && !codeLines.has(at) ? '' : indent + text));
    // A section can be the first block of an item. Linear keeps an empty
    // paragraph on the marker line and puts the section on its own line.
    if (item.checked == null && first?.type === 'paragraph'
      && /^\+{3} [^\n]*$/.test(this.source.slice(start(first), end(first)))
      && item.children.slice(1).some((child) => child.type === 'paragraph' && this.source.slice(start(child), end(child)) === '+++')
      && !/(?:^|\n)[ \t>]*\+{4}/.test(this.source.slice(start(first), end(item)))) {
      return `${marker} \n\n${lines.join('\n')}`;
    }
    // Linear writes a list that starts an item below an empty marker line
    // (`1. 2.` becomes `1. ` and `   2. `), which Markdown reads as the
    // same nested list.
    if (first.type === 'list') return `${marker} \n${lines.join('\n')}`;
    return `${marker} ${lines.join('\n').slice(indent.length)}`;
  }

  /**
   * An item's container. A continuation line belongs to the item's content
   * when indented past the parent's content by the item's own indentation
   * and its content indent: in a code span, spaces beyond that are code text.
   */
  private itemContainer(item: ListItem): Container {
    // The parents' prefixes on the item's own line: a parent that starts on
    // that line ends there at its content, any other at its prefix, which
    // may be indented differently from the parent's first line.
    // Columns count tabs to the next multiple of four.
    const line = lineStartOf(this.source, start(item));
    const columnAt = (offset: number): number => [...this.source.slice(line, offset)].reduce(advanceColumn, 0);
    let at = line;
    // Where a parent's prefix ends inside a tab it takes only in part: an
    // item's indent, or the one column a quote's `>` takes of a tab after it.
    let partial: number | undefined;
    for (const container of this.containers) {
      if (container.kind === 'item' && lineStartOf(this.source, container.content) !== line) {
        const end = (partial ?? columnAt(at)) + container.indent;
        while (at < start(item) && isSpaceOrTab(this.source[at]!) && advanceColumn(columnAt(at), this.source[at]!) <= end) at++;
        partial = at < start(item) && this.source[at] === '\t' && columnAt(at) < end ? end : undefined;
        continue;
      }
      if (lineStartOf(this.source, container.content) === line) at = container.content;
      else at += prefixOf(container, this.source.slice(at, start(item)))?.[0].length ?? 0;
      partial = container.kind === 'quote' && this.source[at - 1] === '>' && this.source[at] === '\t' ? columnAt(at) + 1 : undefined;
    }
    const content = this.contentIndent(item);
    // Past the marker the indent counts columns: a tab after it runs to the next multiple of four.
    const [first] = item.children;
    const sameLine = first !== undefined && item.checked == null && lineStartOf(this.source, start(first)) === line;
    const columns = sameLine ? columnAt(start(first)) - columnAt(start(item)) : content;
    return { kind: 'item', indent: Math.max(0, columnAt(start(item)) - (partial ?? columnAt(at))) + columns, content: start(item) + content };
  }

  /**
   * The columns a line needs past the item's marker to belong to its
   * content: where its first block starts. A task item's content starts at
   * its checkbox, not at the text after it; an item whose first line holds
   * only its marker takes its content one column past the marker.
   */
  private contentIndent(item: ListItem): number {
    const [first] = item.children;
    if (item.checked !== null && item.checked !== undefined) {
      const lineEnd = this.source.indexOf('\n', start(item));
      const line = this.source.slice(start(item), lineEnd === -1 ? undefined : lineEnd);
      const [, marker = '', gap = '', rest = ''] = /^([*+-]|\d{1,9}[.)])([ \t]*)(.*)$/.exec(line) ?? [];
      if (marker !== '' && rest === '') return marker.length + 1;
      // A tab runs to the next multiple of four columns, counted from the
      // start of the source line: tabs before the marker move it too.
      const from = [...this.source.slice(lineStartOf(this.source, start(item)), start(item)) + marker].reduce(advanceColumn, 0);
      const column = [...gap].reduce(advanceColumn, from);
      if (marker !== '' && rest.startsWith('[') && column > from && column - from <= 4) return marker.length + column - from;
    }
    return (first?.position?.start.column ?? 1) - (item.position?.start.column ?? 1);
  }

  private table(node: Table): string {
    const width = node.children[0]?.children.length ?? 0;
    // Linear drops an NBSP around a header cell's text but keeps one around a body cell's.
    const row = (cells: TableRow, header = false): string => {
      const texts = Array.from({ length: width }, (_, index) => {
        const cell = cells.children[index];
        // Linear reads a hash that starts a body cell as heading syntax, so
        // an escaped one keeps its escape (lint reports a bare one).
        const first = cell?.children[0];
        this.cellStart = first ? start(first) : undefined;
        this.inCell = true;
        const inline = cell ? this.inline(cell.children) : '';
        let text = header ? inline.trim() : trimKeepingNbsp(inline);
        // The trim can take leading whitespace past which Linear escapes: look past what is left.
        const lead = text.length - text.trimStart().length;
        const escape = header || unicodeSpaceLead(inline.replace(/^[ \t]+/, '')) === 0 ? undefined : headingOrNumberEscape(text.slice(lead));
        if (escape !== undefined) text = `${text.slice(0, lead + escape)}\\${text.slice(lead + escape)}`;
        // Linear holds a body cell of only a number and a dot as an empty
        // ordered list and writes the space after its marker.
        if (!header && /^\d{1,9}\.$/.test(text)) text += ' ';
        this.inCell = false;
        this.cellStart = undefined;
        // Linear writes a header cell containing only a hash as `\#`.
        return text === '#' ? '\\#' : text;
      });
      return `| ${texts.join(' | ')} |`;
    };
    const [header, ...rows] = node.children;
    if (!header) return '';
    return [row(header, true), `| ${Array.from({ length: width }, () => '--').join(' | ')} |`, ...rows.map((cells) => row(cells))].join('\n');
  }

  /**
   * Inline content copied from the source with targeted rewrites. The line
   * prefixes of the containers (quote markers, list indentation) are dropped,
   * since the caller writes its own; a continuation line keeps the rest of
   * its indentation, as Linear does.
   *
   * In a paragraph Linear escapes a literal `-` or `*` that starts a line,
   * as in `\--` or `\*note`: `lineStarts` says which lines start one, all
   * of them or only the continuation lines (a task item's first line
   * follows its checkbox).
   */
  private inline(children: readonly PhrasingContent[], lineStarts: 'none' | 'continuation' | 'all' = 'none'): string {
    if (children.length === 0) return '';
    const from = start(children[0]!);
    const to = end(children.at(-1)!);
    const code: Array<[number, number]> = [];
    const texts: Array<[number, number]> = [];
    const html: Array<[number, number]> = [];
    for (const child of children) {
      visit(child, (node) => {
        if (node.type === 'inlineCode') code.push([start(node), end(node)]);
        if (node.type === 'text') texts.push([start(node), end(node)]);
        if (node.type === 'html') html.push([start(node), end(node)]);
      });
    }
    const paragraph = lineStarts === 'none' ? undefined : { texts, html, first: lineStarts === 'all' };
    // A render can be dropped (the other asterisk candidate, a link join
    // that does not read the same): each starts from the spaces moved before it.
    const moved = [...this.movedSpaces];
    const spaceEdits = [...this.spaceEdits];
    const render = (rewriteAsterisks: boolean) => {
      const inline: InlineEdits = { edits: [], rewriteAsterisks, changedAsterisks: false };
      const outer = this.inlineFrom;
      const block = this.blockInline;
      this.inlineFrom = from;
      this.blockInline ??= [from, to];
      this.movedSpaces.clear();
      for (const at of block === undefined ? [] : moved) this.movedSpaces.add(at);
      this.spaceEdits = block === undefined ? [] : [...spaceEdits];
      this.inlineChildrenEdits(children, inline);
      this.inlineFrom = outer;
      this.blockInline = block;
      this.movedSpaces.clear();
      for (const at of moved) this.movedSpaces.add(at);
      // A nested render's edits stay in the block's text: keep them for the checks that follow.
      if (block === undefined) this.spaceEdits = spaceEdits;
      return { text: this.rewritten(from, to, inline.edits, code, paragraph), changedAsterisks: inline.changedAsterisks };
    };
    const candidate = render(this.rewriteAsterisks);
    if (!candidate.changedAsterisks) return candidate.text;
    const original = render(false);
    // A table or heading can begin with characters that would open a block
    // if the same inline text was parsed by itself.
    if (!sameMarkdown('Text ' + candidate.text, 'Text ' + original.text)) return original.text;
    this.rewroteAsterisks = true;
    return candidate.text;
  }

  /**
   * The source from `from` to `to` with `edits` made and each continuation
   * line's container prefixes removed; `code` holds the code spans, where a
   * line keeps its indentation. In paragraph text, `paragraph` holds its text
   * nodes, where a `-` or `*` that starts a line is escaped, its inline HTML,
   * where nothing is escaped, and whether the text's first line starts one.
   */
  private rewritten(
    from: number,
    to: number,
    edits: Edit[],
    code: ReadonlyArray<readonly [number, number]>,
    paragraph?: { texts: ReadonlyArray<readonly [number, number]>; html: ReadonlyArray<readonly [number, number]>; first: boolean },
  ): string {
    const inside = (ranges: ReadonlyArray<readonly [number, number]>, at: number): boolean => ranges.some(([a, b]) => a <= at && at < b);
    if (paragraph?.first) this.escapeLineStart(from, to, paragraph.texts, edits);
    for (let at = this.source.indexOf('\n', from); at !== -1 && at < to; at = this.source.indexOf('\n', at + 1)) {
      const marker = paragraph === undefined || inside(code, at) || inside(paragraph.html, at) ? undefined : this.bareMarkerLine(from, at + 1, to);
      if (marker !== undefined) {
        edits.push(...marker);
        continue;
      }
      const continuation = this.continuation(at + 1, inside(code, at), paragraph !== undefined && !inside(paragraph.html, at));
      edits.push(continuation);
      if (paragraph === undefined || continuation.underline) continue;
      // After indentation Linear escapes a `*` but leaves a `-` plain.
      const indented = continuation.text !== '' || /^[ \t]/.test(this.source.slice(continuation.to, to));
      const content = continuation.to + /^[ \t]*/.exec(this.source.slice(continuation.to, to))![0].length;
      this.escapeLineStart(content, to, paragraph.texts, edits, true, indented);
    }
    let out = '';
    let at = from;
    for (const edit of edits.sort((a, b) => a.from - b.from)) {
      if (edit.from < at) continue; // nested in an edit already made
      out += this.source.slice(at, edit.from) + edit.text;
      at = edit.to;
    }
    out += this.source.slice(at, to);
    return out;
  }

  /**
   * Rewrites the first content of a paragraph line as Linear writes it,
   * and says whether it escaped a `-` or `*`. Inline edits handle runs of
   * asterisks because they can include both literal text and delimiters.
   * After the line's own indentation (`indented`) Linear leaves a `-` plain.
   */
  private escapeLineStart(at: number, limit: number, texts: ReadonlyArray<readonly [number, number]>, edits: Edit[], continuation = false, indented = false): boolean {
    const char = this.source[at];
    if (char !== undefined && char !== ' ' && char !== '\t' && /\s/.test(char)) {
      this.escapeAfterUnicodeSpace(at, limit, texts, edits);
      return false;
    }
    if (this.rewriteEscapes && continuation && char === '\\' && this.source[at + 1] === '+'
      && /^[ \t]*$/.test(this.source.slice(at + 2, this.textLineAt(at).to))
      && texts.some(([a, b]) => a <= at && at + 1 < b)) {
      // A bare plus without item text cannot interrupt a paragraph.
      edits.push({ from: at, to: at + 1, text: '' });
      this.compareEscapes = true;
      return false;
    }
    if (char !== undefined && char >= '0' && char <= '9') {
      const end = Math.min(limit, this.textLineAt(at).to);
      const number = /^(\d+)(\\?)\.([ \t\u00a0])(?=[ \t\u00a0]*[^ \t\u00a0])/.exec(this.source.slice(at, end));
      if (number) {
        const from = at + number[1]!.length;
        const dot = from + number[2]!.length;
        if ((from === dot || number[3] !== ' ') && texts.some(([a, b]) => a <= at && dot < b)) {
          edits.push({ from, to: dot + 2, text: '\\. ' });
        }
      }
      return false; // Preserve the indentation Linear keeps before a literal number.
    }
    // A `#` that reads like a heading start (four columns in, or before a
    // no-break space) cannot open one, but Linear escapes it there.
    if (char === '#' && /^#{1,6}(?:\s|$)/.test(this.source.slice(at, this.textLineAt(at).to)) && texts.some(([a, b]) => a <= at && at < b)) {
      edits.push({ from: at, to: at, text: '\\' });
      return true;
    }
    if ((char !== '-' || indented) && (char !== '*' || this.source[at + 1] === '*')) return false;
    if (!texts.some(([a, b]) => a <= at && at < b)) return false;
    edits.push({ from: at, to: at, text: '\\' });
    return true;
  }

  /** Linear's escape in a paragraph line that starts with whitespace outside ASCII (`unicodeSpaceEscape`). */
  private escapeAfterUnicodeSpace(at: number, limit: number, texts: ReadonlyArray<readonly [number, number]>, edits: Edit[]): void {
    const offset = unicodeSpaceEscape(this.source.slice(at, Math.min(limit, this.textLineAt(at).to)));
    if (offset !== undefined && texts.some(([a, b]) => a <= at + offset && at + offset < b)) edits.push({ from: at + offset, to: at + offset, text: '\\' });
  }

  /**
   * The edits for the second and last line of an item's first paragraph,
   * starting on the item's line, when that line holds only `N.` or `*`
   * inside list items: an empty marker cannot interrupt a paragraph, so it
   * is text, but Linear reads it as an empty item nested in the item and
   * writes it at the item's content with a space after it (four or more
   * columns past the content, it reads indented code there, which `fix`
   * cannot write without changing the text: the same form keeps the text
   * and is what Linear keeps of it). Under a quote, on a line that does not
   * reach the item's content, with other lines before or after it, Linear
   * reads the text: `undefined`, the line is written as before.
   */
  private bareMarkerLine(from: number, lineStart: number, to: number): Edit[] | undefined {
    const item = this.containers.at(-1);
    // Only a paragraph written whole: text split off at an image does not end its paragraph.
    if (to !== this.wholeParagraphEnd) return undefined;
    if (this.fileBlockIndent > 0 || item === undefined || this.containers.some((container) => container.kind !== 'item')) return undefined;
    if (lineStartOf(this.source, item.content) !== lineStartOf(this.source, from) || this.source.indexOf('\n', from) !== lineStart - 1) return undefined;
    const next = this.source.indexOf('\n', lineStart);
    if (next !== -1 && next < to) return undefined;
    const bare = /^[ \t]*(?:\d{1,9}\.|\*)$/.exec(this.source.slice(lineStart, to));
    if (bare === null) return undefined;
    const line = this.source.slice(lineStart, next === -1 ? undefined : next);
    if (this.prefixEnd(lineStart, line).lazy) return undefined;
    // An ordered list on the next line inside the item would continue
    // Linear's empty item and be renumbered.
    if (next !== -1) {
      const after = this.source.indexOf('\n', next + 1);
      const nextLine = this.source.slice(next + 1, after === -1 ? undefined : after);
      if (/^[ \t]*\d{1,9}[.)](?:[ \t]|$)/.test(nextLine) && !this.prefixEnd(next + 1, nextLine).lazy) return undefined;
    }
    const marker = lineStart + /^[ \t]*/.exec(line)![0].length;
    return [{ from: lineStart, to: marker, text: '' }, { from: to, to, text: ' ' }];
  }

  /** The end of the paragraph being written whole, which `bareMarkerLine` needs. */
  private wholeParagraphEnd: number | undefined;

  /** The edit that removes a continuation line's container prefixes, starting at `lineStart`; `paragraph` when the line is a paragraph's text. */
  private continuation(lineStart: number, inCode: boolean, paragraph = false): Edit & { underline?: true } {
    const line = this.source.slice(lineStart, this.source.indexOf('\n', lineStart) === -1 ? undefined : this.source.indexOf('\n', lineStart));
    const lineEnd = lineStart + line.length;
    // Up to the first container the line does not match: where a lazy line's own text starts.
    const matched = this.codePrefixEnd(lineStart, line);
    const ownText = matched + /^[ \t]*/.exec(this.source.slice(matched, lineEnd))![0].length;
    const startsBlock = BLOCK_START.test(this.source.slice(ownText, lineEnd));
    let { at, pad, lazy } = inCode ? { at: matched, pad: 0, lazy: false } : this.prefixEnd(lineStart, line);
    // A lazy line's indentation can be what keeps its text from opening a
    // block (four spaces before `#`), and so can a file block label's,
    // whose later lines carry no prefix for their item: such a line keeps
    // all of its indentation past the prefixes it matches.
    if (!inCode && (lazy || this.fileBlockIndent > 0) && startsBlock) ({ at, pad } = { at: matched, pad: 0 });
    // A lazy line of only `-` or `=` continues the paragraph text. Under
    // the prefix the caller writes, it would underline the paragraph as a
    // setext heading. In paragraph text Linear escapes it (`\--`, `\==`);
    // in a link label its form is not recorded, and indented four spaces
    // past the content's column, it stays text. Its own indentation goes: a
    // tab after the prefix may span fewer columns. In a code span the
    // indentation would be code text, but a line ending there reads as a
    // space: the line joins the one before. Outside a container no prefix
    // is written: the line stays as it is.
    const underline = /^([ \t]*)(?:-+|=+)[ \t]*$/.exec(this.source.slice(at, lineStart + line.length));
    // Four spaces past the prefixes, the line is no underline; the writer
    // keeps spaces as they are (a tab's width can change).
    const deep = underline !== null && pad === 0 && this.fileBlockIndent === 0 && /^ {4}/.test(underline[1]!);
    if (underline && !deep && (this.containers.length > 0 || this.fileBlockIndent > 0)) {
      if (inCode) return { from: lineStart - 1, to: at, text: ' ', underline: true };
      return { from: lineStart, to: at + underline[1]!.length, text: paragraph ? '\\' : ' '.repeat(4 + this.fileBlockIndent), underline: true };
    }
    // A file block label's later lines are written without the item's
    // prefix: their indentation goes, as before.
    if (!inCode && this.fileBlockIndent > 0 && !startsBlock) return { from: lineStart, to: ownText, text: '' };
    // The rest of the line's indentation is its own: Linear keeps it, and
    // the columns of a tab the prefixes took only in part stay as spaces.
    // Under a written prefix that ends at another column than the source's
    // prefixes, a tab can span other columns than in the source; before
    // text that could open a block it becomes the spaces it spanned there.
    // Where the prefixes end at the source's column, the tabs span the same
    // columns and stay, as Linear keeps them. A number with a dot that
    // starts paragraph text is escaped, so it reads as text at any column:
    // its tabs stay too.
    const escapedNumber = paragraph && NUMBER_TEXT.test(this.source.slice(ownText, lineEnd));
    if (!inCode && startsBlock && this.containers.length > 0 && this.source.slice(at, ownText).includes('\t') && !escapedNumber && !this.samePrefixColumns(lineStart, at, pad)) {
      const column = (offset: number): number => [...this.source.slice(lineStart, offset)].reduce(advanceColumn, 0);
      return { from: lineStart, to: ownText, text: ' '.repeat(pad + column(ownText) - column(at)) };
    }
    return { from: lineStart, to: at, text: ' '.repeat(pad) };
  }

  /**
   * Whether the prefixes `fix` writes for the item containers end at the
   * column where the source's prefixes end on the line (`at`, less the
   * `pad` columns of a tab they took in part): then every tab after them
   * spans the same columns. Under a quote it is not worked out: `false`.
   */
  private samePrefixColumns(lineStart: number, at: number, pad: number): boolean {
    let written = 0;
    for (const container of this.containers) {
      if (container.kind !== 'item' || container.written === undefined) return false;
      written += container.written;
    }
    return written === [...this.source.slice(lineStart, at)].reduce(advanceColumn, 0) - pad;
  }

  /**
   * Where a continuation line's container prefixes end, outside a code
   * span, as Linear reads them: a quote takes its `>` and one space, and
   * a line without one (a lazy line) keeps its indentation for the quote;
   * an item takes up to its content indent in columns, so a lazy line
   * indented less loses all of it. A tab counts to the next multiple of
   * four columns; `pad` is the columns of a tab past the last prefix, and
   * `lazy` whether a container found no prefix of its own on the line.
   */
  private prefixEnd(lineStart: number, line: string): { at: number; pad: number; lazy: boolean } {
    const lineEnd = lineStart + line.length;
    let at = lineStart;
    let column = 0;
    let pad = 0;
    let lazy = false;
    const take = (): number => {
      const before = column;
      column = advanceColumn(column, this.source[at]!);
      at++;
      return column - before;
    };
    for (const container of this.containers) {
      if (container.kind === 'quote') {
        // Columns left of a tab count as indentation before the `>`.
        const marker = pad <= 3 ? new RegExp(`^ {0,${3 - pad}}>`).exec(this.source.slice(at, lineEnd)) : null;
        if (marker === null) {
          lazy = true;
          continue;
        }
        pad = 0;
        for (let index = 0; index < marker[0].length; index++) take();
        // The `>` takes one space after it, or one column of a tab.
        if (this.source[at] === ' ') take();
        else if (this.source[at] === '\t') pad = take() - 1;
        continue;
      }
      let need = container.indent;
      const taken = Math.min(pad, need);
      pad -= taken;
      need -= taken;
      while (need > 0 && at < lineEnd && isSpaceOrTab(this.source[at]!)) {
        const width = take();
        if (width > need) pad = width - need;
        need = Math.max(0, need - width);
      }
      if (need > 0) lazy = true;
    }
    return { at, pad, lazy };
  }

  /**
   * The code span from `from` to `to` on one line, as Linear writes one that
   * runs over lines: each line ending becomes a space, and a line's
   * container prefixes go. The indentation past them is code text and
   * stays; the columns of a tab a prefix takes in part stay as spaces.
   */
  private codeSpanOnOneLine(from: number, to: number): string {
    let out = '';
    let at = from;
    for (let lineEnd = this.source.indexOf('\n', from); lineEnd !== -1 && lineEnd < to; lineEnd = this.source.indexOf('\n', lineEnd + 1)) {
      out += this.source.slice(at, lineEnd);
      const lineStart = lineEnd + 1;
      const next = this.source.indexOf('\n', lineStart);
      const line = this.source.slice(lineStart, next === -1 ? undefined : next);
      const prefix = this.prefixEnd(lineStart, line);
      // A lazy line carries no further prefixes and keeps its spaces.
      const rest = prefix.lazy ? { at: this.codePrefixEnd(lineStart, line), pad: 0 } : prefix;
      out += ' '.repeat(1 + rest.pad);
      at = rest.at;
    }
    return out + this.source.slice(at, to);
  }

  /**
   * Where a continuation line's container prefixes end inside a code span,
   * where spaces are code text: a lazy line (no `>`, or indented less than
   * its item's content) carries no further prefixes, and keeps its spaces.
   */
  private codePrefixEnd(lineStart: number, line: string): number {
    let at = lineStart;
    for (const container of this.containers) {
      const prefix = prefixOf(container, this.source.slice(at, lineStart + line.length));
      if (!prefix || (container.kind === 'item' && prefix[0].length < container.indent)) break;
      at += prefix[0].length;
    }
    return at;
  }

  private inlineChildrenEdits(children: readonly PhrasingContent[], inline: InlineEdits, insideStrong = false): void {
    const merged = this.adjacentLinkEdits(children, inline.edits);
    for (const [index, child] of children.entries()) {
      if (merged.has(index)) continue;
      if (child.type !== 'strong') {
        this.inlineEdits(child, inline);
        continue;
      }
      const previous = children[index - 1];
      const next = children[index + 1];
      const joinLeft = insideStrong || (previous?.type === 'strong' && end(previous) === start(child));
      const joinsNext = next?.type === 'strong' && end(child) === start(next);
      if (inline.rewriteAsterisks && joinsNext) {
        // Join the italic text across the bold boundary too, without
        // creating a new delimiter run between the two italic words.
        const last = child.children.at(-1);
        const first = next.children[0];
        if (last?.type === 'emphasis' && first?.type === 'emphasis'
          && end(last) === end(child) - 2 && start(first) === start(next) + 2) {
          inline.edits.push({ from: end(last) - 1, to: end(last), text: '' }, { from: start(first), to: start(first) + 1, text: '' });
        }
      }
      const joinRight = insideStrong || joinsNext;
      this.inlineEdits(child, inline, joinLeft, joinRight);
    }
  }

  /**
   * Linear holds a link as a mark on its text, so links to the same
   * destination with nothing between them become one link, with the marks
   * around each part inside it: `[a](u)**[b](u)**` is `[a**b**](u)`. Edits
   * write each such run of `children` as one link; returns the indexes they
   * cover. A run whose joined link would read differently stays as it is.
   */
  private adjacentLinkEdits(children: readonly PhrasingContent[], edits: Edit[]): Set<number> {
    const covered = new Set<number>();
    if (this.literal) return covered;
    let index = 0;
    while (index < children.length) {
      const first = this.wrappedLink(children[index]!);
      let last = index;
      while (first !== undefined && last + 1 < children.length && end(children[last]!) === start(children[last + 1]!)
        && this.wrappedLink(children[last + 1]!)?.url === first.url) last++;
      // A `!` right before the joined link would make it an image.
      const bang = this.source[start(children[index]!) - 1] === '!' && !escaped(this.source, start(children[index]!) - 1);
      if (first !== undefined && last > index && !bang) {
        const parts = children.slice(index, last + 1);
        const text = this.joinedLink(parts, first.url);
        if (text !== undefined) {
          edits.push({ from: start(parts[0]!), to: end(parts.at(-1)!), text });
          for (let at = index; at <= last; at++) covered.add(at);
        }
      }
      index = last + 1;
    }
    return covered;
  }

  /** The link inside `node` and its destination, when `node` is a link with only bold, italic or strikethrough around it. */
  private wrappedLink(node: PhrasingContent): { url: string } | undefined {
    while ((node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') && node.children.length === 1) node = node.children[0]!;
    if (node.type === 'link') return { url: node.url };
    if (node.type === 'linkReference') {
      const definition = this.definitions.get(node.identifier);
      return definition ? { url: definition.url } : undefined;
    }
    return undefined;
  }

  /** `parts` (wrapped links to `url`) written as one link, or undefined when that link would not read as their joined text and marks. */
  private joinedLink(parts: readonly PhrasingContent[], url: string): string | undefined {
    // A join not made leaves its labels' space edits unmade.
    const spaceEdits = [...this.spaceEdits];
    const text = this.joinedLinkText(parts, url);
    if (text === undefined) this.spaceEdits = spaceEdits;
    return text;
  }

  private joinedLinkText(parts: readonly PhrasingContent[], url: string): string | undefined {
    const labels: string[] = [];
    const expected: PhrasingContent[] = [];
    for (const part of parts) {
      const opens: string[] = [];
      const closes: string[] = [];
      const wrap = (node: PhrasingContent): PhrasingContent[] => {
        if (node.type === 'link' || node.type === 'linkReference') {
          // An autolink's text is its address, where a backslash would escape.
          this.literal = node.type === 'link' && this.source[start(node)] !== '[';
          labels.push(opens.join('') + this.linkLabel(node.children) + closes.reverse().join(''));
          this.literal = false;
          return node.children;
        }
        if (node.type !== 'strong' && node.type !== 'emphasis' && node.type !== 'delete') return [node];
        const mark = node.type === 'strong' ? '**' : node.type === 'emphasis' ? '*' : /^~{1,2}/.exec(this.source.slice(start(node), start(node) + 2))![0];
        opens.push(mark);
        closes.push(mark);
        return [{ ...node, children: wrap(node.children[0]!) } as PhrasingContent];
      };
      expected.push(...wrap(part));
    }
    // Labels joined can spell a shortcode neither held, which a later fix would turn into an emoji.
    const shortcodes = (label: string) => [...emojiShortcodes(label)].length;
    if (shortcodes(labels.join('')) > labels.reduce((sum, label) => sum + shortcodes(label), 0)) return undefined;
    const text = `[${labels.join('')}](${linkDestination(url)})`;
    const [paragraph, ...others] = parse(text).children;
    const [link, ...rest] = paragraph?.type === 'paragraph' ? paragraph.children : [];
    if (others.length > 0 || rest.length > 0 || link?.type !== 'link' || link.url !== url) return undefined;
    const shape = (node: Nodes) => breakShape({ type: 'root', children: [{ type: 'paragraph', children: [node as PhrasingContent] }] });
    return isDeepStrictEqual(shape({ ...link, title: null }), shape({ type: 'link', url, title: null, children: expected })) ? text : undefined;
  }

  private inlineEdits(node: PhrasingContent, inline: InlineEdits, joinLeft = false, joinRight = false): void {
    const { edits, rewriteAsterisks } = inline;
    const from = start(node);
    const to = end(node);
    if ((node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') && !this.literal) this.edgeSpaceEdits(node, edits);
    switch (node.type) {
      case 'emphasis':
      case 'strong': {
        const width = node.type === 'strong' ? 2 : 1;
        if (rewriteAsterisks) {
          const mark = '*'.repeat(width);
          const underscore = this.source[from] === '_';
          if (joinLeft || underscore) edits.push({ from, to: from + width, text: joinLeft ? '' : mark });
          if (joinRight || underscore) edits.push({ from: to - width, to, text: joinRight ? '' : mark });
          if (joinLeft || joinRight || underscore) inline.changedAsterisks = true;
        }
        this.inlineChildrenEdits(node.children, inline, node.type === 'strong');
        return;
      }
      case 'delete':
        this.inlineChildrenEdits(node.children, inline);
        return;
      case 'link': {
        // An autolink (`<url>` or a bare URL) has no brackets in the source:
        // its text becomes a label, where a backslash would escape.
        const autolink = this.source[from] !== '[';
        // A `!` right before it would turn the written link into an image.
        if (autolink && this.source[from - 1] === '!' && !escaped(this.source, from - 1)) edits.push({ from: from - 1, to: from, text: '\\!' });
        this.literal = autolink;
        edits.push({ from, to, text: this.link(node.children, node.url) });
        this.literal = false;
        return;
      }
      case 'linkReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: this.link(node.children, definition.url) });
        return;
      }
      case 'image':
        edits.push({ from, to, text: `![${this.imageLabel(from + 1, to, node.alt)}](${imageDestination(node.url)})` });
        return;
      case 'imageReference': {
        const definition = this.definitions.get(node.identifier);
        if (definition) edits.push({ from, to, text: `![${this.imageLabel(from + 1, to, node.alt)}](${imageDestination(definition.url)})` });
        return;
      }
      case 'text': {
        const text = this.literal ? literalEdits(this.source, from, to) : textEdits(this.source, from, to, (at, char) => {
          if (!this.rewriteEscapes || !this.redundantLineEscape(at, char)) return false;
          this.compareEscapes = true;
          return true;
        }, !this.inCell);
        for (const edit of text) edits.push(edit);
        if (!this.literal) {
          this.spaceReferenceEdits(from, to, edits);
          // Linear escapes a backtick that opens no code span.
          for (const at of loneBackticks(this.source, from, to)) edits.push({ from: at, to: at, text: '\\' });
        }
        if (!this.literal && this.rewriteEscapes && this.rewriteTildeUnderscore) {
          const escapes = tildeUnderscoreEdits(this.source.slice(from, to), from);
          for (const edit of escapes) edits.push(edit);
          // An escape changes flanking and autolink boundaries: the writer checks the document.
          if (escapes.length > 0) this.compareEscapes = true;
        }
        if (!this.literal && rewriteAsterisks) {
          const asterisks = literalAsteriskEdits(this.source.slice(from, to), from);
          for (const edit of asterisks) edits.push(edit);
          if (asterisks.length > 0) inline.changedAsterisks = true;
        }
        if (!this.literal && this.rewriteEscapes) this.escapeTextBrackets(from, to, edits);
        return;
      }
      case 'inlineCode':
        // Linear writes a code span that runs over lines on one line. A
        // joined line that holds a `|` could become a table's head row: such
        // a span keeps its lines.
        if (this.source.slice(from, to).includes('\n')) {
          const joined = this.codeSpanOnOneLine(from, to);
          const before = this.source.slice(lineStartOf(this.source, from), from);
          const lineEnd = this.source.indexOf('\n', to);
          const after = this.source.slice(to, lineEnd === -1 ? undefined : lineEnd);
          if (!`${before}${joined}${after}`.includes('|')) edits.push({ from, to, text: joined });
        }
        return;
      case 'html':
        // Linear writes a line break in a table cell as a character reference.
        if (this.inCell && CELL_BREAK.test(node.value)) edits.push({ from, to, text: '&#10;' });
        return;
      default:
        return;
    }
  }

  private redundantLineEscape(at: number, char: string): boolean {
    if (at === this.cellStart || !'#-=+>'.includes(char)) return false;
    if (char === '#' && this.source[at - 1] === '&') return false;
    if (char === '#') {
      // Past a no-break space at the line's start Linear escapes a heading-like run.
      const line = this.textLineAt(at);
      line.unicodeLead ??= unicodeSpaceLead(this.source.slice(line.first, line.to));
      if (at === line.first + line.unicodeLead && headingOrNumberEscape(this.source.slice(at + 1, line.to)) === 0) return false;
    }
    // Removing several escapes must not assemble a heading or section opener.
    if ((char === '#' || char === '+') && (this.source[at - 1] === char || this.source.startsWith(`\\${char}`, at + 2))) return false;
    if (char === '+' && this.source[at + 2] === '+') return false;
    const line = this.textLineAt(at);
    // A run of `=` is a setext underline only alone on a continuation line
    // indented less than four columns past its containers.
    const continuation = line.from > this.inlineFrom;
    if (char === '=') return !line.equalsOnly || !continuation || this.indentPastContainers(line) >= 4;
    // Past four columns no list item, underline or rule can interrupt the
    // paragraph; after less indentation a dash that no space follows
    // opens nothing either.
    const indent = continuation && at === line.first && (char === '-' || char === '+') ? this.indentPastContainers(line) : 0;
    if (indent >= 4 && !this.source.slice(line.first, line.to).includes('|')) return true;
    if (line.delimiter && char === '-') return false;
    if (line.first < at && at + 2 <= line.last) return true;
    if (char === '-' && indent > 0 && !/^[ \t]|^$/.test(this.source.slice(at + 2, line.to))) return true;
    // Hashtags and +words cannot open blocks. A plus sign before whitespace
    // or a run of plus signs can still need its escape at a block boundary.
    // Linear escapes a `#` before any whitespace, a no-break space too.
    if (char === '#') return /^#{1,6}[^#\s]/.test(this.source.slice(at + 1, at + 8));
    return char === '+' && /^\+[^+ \t\r\n]/.test(this.source.slice(at + 1, at + 3));
  }

  /** The columns of whitespace a continuation line has before its text, past its containers' prefixes. */
  private indentPastContainers(line: NonNullable<Writer['textLine']>): number {
    if (line.indent !== undefined) return line.indent;
    const { at, pad } = this.prefixEnd(line.from, this.source.slice(line.from, line.to));
    // The writer can change a tab's width (under a shorter item prefix)
    // and drops a file block label's indentation: count those as none.
    if (at > line.first || this.fileBlockIndent > 0 || pad > 0
      || (this.containers.length > 0 && this.source.slice(line.from, line.first).includes('\t'))) return line.indent = 0;
    let column = 0;
    let prefix = 0;
    for (let offset = line.from; offset < line.first; offset++) {
      if (offset === at) prefix = column;
      column = advanceColumn(column, this.source[offset]!);
    }
    return line.indent = pad + column - (at === line.first ? column : prefix);
  }

  /** Significant line bounds, cached so many escapes do not rescan the line. */
  private textLineAt(at: number): NonNullable<Writer['textLine']> {
    if (this.textLine && at >= this.textLine.from && at < this.textLine.to) return this.textLine;
    const from = lineStartOf(this.source, at);
    const newline = this.source.indexOf('\n', at);
    const to = newline === -1 ? this.source.length : newline;
    const line = this.source.slice(from, to);
    const prefix = /^(?:[ \t]*(?:>|[*+-](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/.exec(line)![0];
    let last = to - 1;
    while (last >= from && /[ \t#]/.test(this.source[last]!)) last--;
    // A delimiter line may still need its escape to stay paragraph text.
    const delimiter = /^[ \t|:\\=-]+$/.test(line.slice(prefix.length));
    // A line of only `=` (escaped or not) may underline the paragraph above.
    const equalsOnly = /^(?:\\?=)+[ \t]*$/.test(line.slice(prefix.length));
    return this.textLine = { from, to, first: from + prefix.length, last, delimiter, equalsOnly };
  }

  private escapeTextBrackets(from: number, to: number, edits: Edit[]): void {
    const raw = this.source.slice(from, to);
    const brackets = squareBracketEdits(raw, from, this.containers.at(-1)?.markerBrackets);
    if (brackets.length !== 0 && /https?:\/\/|www\.|@/i.test(raw)) {
      // Escaping a preceding bracket can expose a shorter autolink that
      // the source treated as text, as in `[https://example.com_`.
      let escaped = '';
      let at = from;
      for (const edit of brackets) {
        escaped += this.source.slice(at, edit.from) + edit.text;
        at = edit.to;
      }
      escaped += this.source.slice(at, to);
      if (!sameMarkdown(raw, escaped)) {
        this.compareEscapes = true;
        return;
      }
    }
    for (const edit of brackets) edits.push(edit);
  }

  /**
   * Linear stores a space reference (`&#32;`) as a space. At the start or
   * end of a block's text it stores the space until the next write, which
   * drops it: there it goes. A reference next to a `*`, `_` or `~` run is
   * left to `edgeSpaceEdits`. A reference keeps its spelling where the
   * space would change what the block says (`keepsBlock`): a line break, a
   * list item, a heading's closing hashes, an autolink.
   */
  private spaceReferenceEdits(from: number, to: number, edits: Edit[]): void {
    const [blockFrom, blockTo] = this.blockInline ?? [-1, -1];
    const groups: Edit[][] = [];
    for (const run of spaceReferenceRuns(this.source, from, to)) {
      if (!sameFlanking(this.source, run.from, run.to, ' ')) continue;
      if (run.from === blockFrom && run.to === blockTo) continue;
      const edge = run.from === blockFrom || run.to === blockTo;
      groups.push([{ from: run.from, to: run.to, text: edge ? '' : ' '.repeat(run.count) }]);
    }
    this.pushIfKept(groups, edits);
  }

  /**
   * Linear moves a space at the inner edge of bold, italic or strikethrough
   * out of it: `**&#32;Tip**` is ` **Tip**`. At the start or end of a
   * block's text the space then goes, as `spaceReferenceEdits` says.
   */
  private edgeSpaceEdits(node: Emphasis | Strong | Delete, edits: Edit[]): void {
    const [blockFrom, blockTo] = this.blockInline ?? [-1, -1];
    const edge = (side: 'first' | 'last'): Text | undefined => {
      let child: PhrasingContent | undefined = node;
      while (child !== undefined && (child.type === 'strong' || child.type === 'emphasis' || child.type === 'delete')) child = side === 'first' ? child.children[0] : child.children.at(-1);
      return child?.type === 'text' ? child : undefined;
    };
    const groups: Edit[][] = [];
    const first = edge('first');
    const lead = first && spaceReferenceRuns(this.source, start(first), end(first)).find((run) => run.from === start(first));
    if (lead && !this.movedSpaces.has(lead.from) && lead.to < end(first) && !/\s/u.test(this.source[lead.to]!)) {
      this.movedSpaces.add(lead.from);
      groups.push([{ from: start(node), to: start(node), text: start(node) === blockFrom ? '' : ' '.repeat(lead.count) }, { from: lead.from, to: lead.to, text: '' }]);
    }
    const last = edge('last');
    const tail = last && spaceReferenceRuns(this.source, start(last), end(last)).find((run) => run.to === end(last));
    if (tail && !this.movedSpaces.has(tail.from) && tail.from > start(last) && !/\s/u.test(this.source[tail.from - 1]!)) {
      this.movedSpaces.add(tail.from);
      groups.push([{ from: tail.from, to: tail.to, text: '' }, { from: end(node), to: end(node), text: end(node) === blockTo ? '' : ' '.repeat(tail.count) }]);
    }
    this.pushIfKept(groups, edits);
  }

  /**
   * Pushes the groups of space edits whose block still says the same
   * together with the space edits already made in it: all of them when
   * they keep it together, else each group in turn that keeps it with
   * those before, up to a bound, so a long block is not read again and again.
   */
  private pushIfKept(groups: readonly Edit[][], edits: Edit[]): void {
    if (groups.length === 0) return;
    const accept = (group: readonly Edit[]) => {
      edits.push(...group);
      this.spaceEdits.push(...group);
    };
    if (this.keepsBlock([...this.spaceEdits, ...groups.flat()])) {
      for (const group of groups) accept(group);
      return;
    }
    if (groups.length === 1 || groups.length > 16) return;
    for (const group of groups) if (this.keepsBlock([...this.spaceEdits, ...group])) accept(group);
  }

  /**
   * Whether the block being written reads the same with `edits` made,
   * apart from what Linear does with a space (`spaceShape`). The block is
   * read with its first line's prefixes, so a heading's closing hashes
   * count; a cell is read alone.
   */
  private keepsBlock(edits: readonly Edit[]): boolean {
    if (this.blockInline === undefined) return false;
    const [blockFrom, blockTo] = this.blockInline;
    const lineEnd = this.source.indexOf('\n', blockTo);
    const from = this.inCell ? blockFrom : lineStartOf(this.source, blockFrom);
    const to = this.inCell ? blockTo : lineEnd === -1 ? this.source.length : lineEnd;
    let edited = '';
    let at = from;
    for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
      edited += this.source.slice(at, edit.from) + edit.text;
      at = edit.to;
    }
    edited += this.source.slice(at, to);
    return isDeepStrictEqual(spaceShape(parse(edited)), spaceShape(parse(this.source.slice(from, to))));
  }

  /** Linear writes every link destination in angle brackets, without a title. */
  private link(children: readonly PhrasingContent[], url: string): string {
    return `[${this.linkLabel(children)}](${linkDestination(url)})`;
  }

  private linkLabel(children: readonly PhrasingContent[]): string {
    const label = this.inline(children);
    const [child] = children;
    if (!this.literal && label.includes('\\_') && children.length === 1 && child?.type === 'text' && URL_LABEL.test(child.value)) {
      return plainUrlUnderscores(label);
    }
    return label;
  }

  /**
   * The bracketed label that opens at `open` (a `[`) and closes before
   * `limit`, without its brackets. Continuation lines lose their container
   * prefixes. Literal brackets are escaped when the alt text stays the same.
   */
  private imageLabel(open: number, limit: number, alt: string | null | undefined): string {
    const from = open + 1;
    const to = from + bracketedLabel(this.source, open, limit).length;
    const code = codeSpans(this.source, from, to);
    if (!this.rewriteEscapes) return this.rewritten(from, to, [], code);
    let span = 0;
    const edits = squareBracketEdits(this.source.slice(from, to), from).filter(({ from: at }) => {
      while (code[span] && code[span]![1] <= at) span++;
      return code[span] === undefined || at < code[span]![0];
    });
    if (edits.length > 0) {
      const label = this.rewritten(from, to, edits, code);
      // An image node exposes its flattened alt text, so brackets in its
      // source can still belong to a nested link or image.
      const blocks = parse(`![${label}](image.png)`).children;
      const [paragraph] = blocks;
      if (blocks.length === 1 && paragraph?.type === 'paragraph' && paragraph.children.length === 1) {
        const [image] = paragraph.children;
        if (image?.type === 'image' && image.alt === alt) return label;
      }
    }
    return this.rewritten(from, to, [], code);
  }
}

/**
 * Rewrites inside plain text: entities, emoji shortcodes and backslashes
 * Linear spells differently. The writer decides which line escapes can go.
 */
function textEdits(source: string, from: number, to: number, redundantEscape: (at: number, char: string) => boolean, inBlock = true): Edit[] {
  const edits: Edit[] = [];
  const raw = source.slice(from, to);
  // Character references become the characters when that cannot make markup:
  // characters outside ASCII (NBSP among them, as Linear stores `&nbsp;`)
  // and `&` when no reference follows it. Other whitespace stays a reference.
  for (const match of raw.matchAll(CHARACTER_REFERENCE)) {
    if (escaped(raw, match.index)) continue;
    const char = decodeEntity(match[0]);
    const at = from + match.index;
    const after = raw.slice(match.index + match[0].length);
    if (char === undefined || (char.trim() === '' && char !== NBSP)) continue;
    if (char === '&' ? /^[A-Za-z0-9#]+;/.test(after) : char.codePointAt(0)! < 0x80) continue;
    // Next to a delimiter run, the character could decide whether the run
    // opens or closes emphasis where the reference's `;` or `&` did not.
    if (!sameFlanking(source, at, at + match[0].length, char)) continue;
    edits.push({ from: at, to: at + match[0].length, text: char });
  }
  // `:name:` shortcodes Linear knows become the emoji, unless the first colon is escaped.
  for (const { index, length, emoji } of emojiShortcodes(raw)) {
    if (!escaped(raw, index)) edits.push({ from: from + index, to: from + index + length, text: emoji });
  }
  // Keep escapes that would expose a shortcode on the next formatting pass.
  const shortcodeEscapes = new Set<number>();
  for (const match of raw.matchAll(/:(?=([a-z0-9_+-]*)\\([+-][a-z0-9_+-]*):)/g)) {
    if (Object.hasOwn(nameToEmoji, match[1]! + match[2]!)) shortcodeEscapes.add(match.index + 1 + match[1]!.length);
  }
  // A backslash before a letter is a literal backslash; Linear doubles it,
  // as it does one that ends its line (where it breaks no line: a block's
  // end). A table cell's goes on to the cell's pipe, which `fix` writes.
  for (const match of raw.matchAll(/\\(.|$)/g)) {
    const at = from + match.index;
    const next = match[1]!;
    // A heading's closing hashes, which `fix` drops, follow its text as plain characters.
    if (next === '' && (!inBlock || !/^[ \t]*(?:#+[ \t]*)?(?:\n|$)/.test(source.slice(to)))) continue;
    if (/[!-/:-@[-`{-~]/.test(next)) {
      if (!shortcodeEscapes.has(match.index) && redundantEscape(at, next)) {
        edits.push({ from: at, to: at + 1, text: '' });
      }
    } else {
      edits.push({ from: at, to: at + 1, text: '\\\\' });
    }
  }
  return edits;
}

/**
 * Linear's escapes for a literal `~` or `_` in text, character by
 * character: every `~` gets one, and a `_` gets one unless the characters
 * on both sides of it in the text are ASCII letters, digits or `_`
 * (`snake_case` and `a__b` stay, `value__ end` becomes `value_\_ end`,
 * `é_é` becomes `é\_é`). The text's own start and end count as no such
 * character. An escape the rule does not need goes: `file\_name` becomes
 * `file_name`.
 */
function tildeUnderscoreEdits(raw: string, from: number): Edit[] {
  if (!/[~_]/.test(raw)) return [];
  // The text as it reads: a backslash before ASCII punctuation escapes it.
  const chars: Array<{ char: string; at: number; backslash?: number }> = [];
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] === '\\' && at + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[at + 1]!)) {
      chars.push({ char: raw[at + 1]!, at: at + 1, backslash: at });
      at++;
    } else {
      chars.push({ char: raw[at]!, at });
    }
  }
  const word = (index: number): boolean => index >= 0 && index < chars.length && UNDERSCORE_NEIGHBOUR.test(chars[index]!.char);
  // An escape inside an emoji shortcode's name keeps the shortcode text.
  const text = chars.map(({ char }) => char).join('');
  const shortcode = new Set<number>();
  for (const match of text.matchAll(/:(?=([a-z0-9_+-]+):)/g)) {
    if (Object.hasOwn(nameToEmoji, match[1]!)) for (let index = match.index; index < match.index + match[1]!.length + 2; index++) shortcode.add(index);
  }
  const edits: Edit[] = [];
  chars.forEach(({ char, at, backslash }, index) => {
    if (char !== '~' && char !== '_') return;
    const plain = char === '_' && word(index - 1) && word(index + 1);
    if (!plain && backslash === undefined) edits.push({ from: from + at, to: from + at, text: '\\' });
    if (plain && backslash !== undefined && !shortcode.has(index)) edits.push({ from: from + backslash, to: from + backslash + 1, text: '' });
  });
  return edits;
}

/** The characters around a `_` that keep it plain in Linear's text. */
const UNDERSCORE_NEIGHBOUR = /^[A-Za-z0-9_]$/;

/** Escape literal brackets, including character references, outside marker syntax. */
function squareBracketEdits(raw: string, from: number, markerBrackets?: readonly [number, number]): Edit[] {
  if (!/[\[\]&]/.test(raw)) return [];
  const edits: Edit[] = [];
  for (const match of raw.matchAll(/\\.|[\[\]]|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g)) {
    const at = from + match.index;
    if (at === markerBrackets?.[0] || at === markerBrackets?.[1]) continue;
    const char = match[0].startsWith('&') ? decodeEntity(match[0]) : match[0];
    if (char === '[' || char === ']') edits.push({ from: at, to: at + match[0].length, text: `\\${char}` });
  }
  return edits;
}

/** Match escapes first, so an existing asterisk escape stays intact. */
function literalAsteriskEdits(raw: string, from: number): Edit[] {
  if (!/[*&]/.test(raw)) return [];
  const edits: Edit[] = [];
  for (const match of raw.matchAll(ASTERISK_SPELLING)) {
    const spelling = match[0];
    if (spelling !== '*' && (spelling[0] !== '&' || decodeEntity(spelling) !== '*')) continue;
    const at = from + match.index;
    edits.push({ from: at, to: at + spelling.length, text: '\\*' });
  }
  return edits;
}

/**
 * Rewrites inside an autolink's text written as a link label, so the label
 * reads exactly as the URL. Every backslash is literal there, so each is
 * doubled (as Linear doubles one before a letter). Every character that is
 * inline syntax in a label is escaped: brackets and backticks (a backslash
 * left single at the label's end would escape its closing bracket, and a
 * backtick could open a code span that runs past it; either breaks the
 * link); `*`, `_` and `~`, which would make emphasis or strikethrough; and
 * the `&` of a character reference and the first colon of an emoji
 * shortcode, which would turn into the character or the emoji. Underscore
 * runs between letters or digits stay plain.
 */
function literalEdits(source: string, from: number, to: number): Edit[] {
  const raw = source.slice(from, to);
  const escape = new Set<number>();
  for (let at = 0; at < raw.length; at++) if (LABEL_SYNTAX.has(raw[at]!)) escape.add(at);
  // An underscore between ASCII letters, digits or underscores stays plain, as Linear writes it.
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] === '_' && UNDERSCORE_NEIGHBOUR.test(raw[at - 1] ?? '') && UNDERSCORE_NEIGHBOUR.test(raw[at + 1] ?? '')) escape.delete(at);
  }
  for (const match of raw.matchAll(CHARACTER_REFERENCE)) {
    if (match[0][1] === '#' || decodeEntity(match[0]) !== undefined) escape.add(match.index);
  }
  // Find shortcodes in the label the next run reads, after the edits above.
  const rawAt: number[] = [];
  let label = '';
  for (let at = 0; at < raw.length; at++) {
    if (escape.has(at)) label += '\\';
    rawAt[label.length] = at;
    label += raw[at];
  }
  for (const at of emojiShortcodeStarts(label)) escape.add(rawAt[at]!);
  const edits: Edit[] = [];
  for (const at of [...escape].sort((a, b) => a - b)) edits.push({ from: from + at, to: from + at + 1, text: `\\${raw[at]}` });
  return edits;
}

/** Characters that can be inline syntax in an autolink label. */
const LABEL_SYNTAX: ReadonlySet<string> = new Set(['\\', '[', ']', '`', '*', '_', '~']);

const URL_LABEL = /^(?:(?:https?:\/\/|www\.)\S+|[^\s@]+@[^.\s@]+(?:\.[^.\s@]+)+)$/i;

/** Remove redundant escapes in an existing plain URL label. */
function plainUrlUnderscores(label: string): string {
  const plain = label.replace(/(?<=[A-Za-z0-9])(?:\\?_)+(?=[A-Za-z0-9])/g, (run) => run.replaceAll('\\', ''));
  if (plain === label) return label;
  const shortcodes = new Set(emojiShortcodeStarts(plain));
  return plain.replace(/:/g, (colon, at: number) => shortcodes.has(at) && !escaped(plain, at) ? '\\:' : colon);
}

/** Label shortcodes can share a colon, as in `:fire:tada:`. */
function* emojiShortcodeStarts(label: string): Generator<number> {
  for (const match of label.matchAll(/:(?=([a-z0-9_+-]+):)/g)) {
    if (Object.hasOwn(nameToEmoji, match[1]!)) yield match.index;
  }
}

const NBSP = '\u00a0';
/**
 * The offsets of the backticks in the text from `from` to `to` that open no
 * code span. The parser leaves only those in text, except in the tail it
 * splits off a bare URL at Linear's end, which is read again on the next
 * pass: there a run with a partner of the same length is a code span, as
 * Linear reads it.
 */
function loneBackticks(source: string, from: number, to: number): number[] {
  const runs: Array<{ at: number; length: number }> = [];
  const raw = source.slice(from, to);
  for (let index = raw.indexOf('`'); index !== -1; index = raw.indexOf('`', index)) {
    let at = from + index;
    let end = at;
    while (end < to && source[end] === '`') end++;
    // An escaped first backtick is text; the rest of the run is a run of its own.
    if (escaped(source, at)) at++;
    if (end > at) runs.push({ at, length: end - at });
    index = end - from;
  }
  const lone: number[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    const partner = runs.findIndex((other, later) => later > index && other.length === run.length);
    if (partner !== -1) {
      runs.splice(partner, 1);
      continue;
    }
    for (let at = run.at; at < run.at + run.length; at++) lone.push(at);
  }
  return lone;
}

type Shape = { type: string; value?: string; children?: Shape[] };

/**
 * A tree without positions, read as Linear reads the space a reference
 * stands for: a space at the inner edge of bold, italic or strikethrough
 * is outside it, spaces at the edges of a paragraph's, heading's or cell's
 * text go, adjacent text is joined, and spaces around a line ending go.
 */
function spaceShape(tree: Root): Shape {
  const phrasing = (children: readonly PhrasingContent[]): Shape[] => {
    const out: Shape[] = [];
    const text = (value: string) => {
      if (value === '') return;
      const previous = out.at(-1);
      if (previous?.type === 'text') previous.value += value;
      else out.push({ type: 'text', value });
    };
    for (const child of children) {
      if (child.type === 'text') {
        text(child.value);
      } else if (child.type === 'strong' || child.type === 'emphasis' || child.type === 'delete') {
        const inner = phrasing(child.children);
        const lead = trimSpaces(inner, 'start');
        const tail = trimSpaces(inner, 'end');
        text(lead);
        out.push({ type: child.type, children: inner });
        text(tail);
      } else {
        out.push(shape(child));
      }
    }
    for (const item of out) if (item.type === 'text') item.value = item.value!.replace(/[ \t]*\n[ \t]*/g, '\n');
    return out;
  };
  const shape = (node: Nodes): Shape => {
    const { position: _position, ...rest } = node;
    if (!('children' in node)) return rest;
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      const children = phrasing(node.children);
      trimSpaces(children, 'start');
      trimSpaces(children, 'end');
      return { ...rest, children };
    }
    const children = node.children as Nodes[];
    const inline = node.type === 'link' || node.type === 'linkReference' || node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete';
    return { ...rest, children: inline ? phrasing(children as PhrasingContent[]) : children.map(shape) };
  };
  return shape(tree);
}

/** Removes the spaces at one edge of `shapes` (and a text left empty) and returns them. */
function trimSpaces(shapes: Shape[], side: 'start' | 'end'): string {
  const index = side === 'start' ? 0 : shapes.length - 1;
  const edge = shapes[index];
  if (edge?.type !== 'text') return '';
  const value = edge.value!;
  let at = side === 'start' ? 0 : value.length;
  if (side === 'start') while (value[at] === ' ') at++;
  else while (value[at - 1] === ' ') at--;
  edge.value = side === 'start' ? value.slice(at) : value.slice(0, at);
  if (edge.value === '') shapes.splice(index, 1);
  return side === 'start' ? value.slice(0, at) : value.slice(at);
}

/** The runs of space references (`&#32;`, `&#x20;`) in the text from `from` to `to`, with how many each holds. */
function spaceReferenceRuns(source: string, from: number, to: number): Array<{ from: number; to: number; count: number }> {
  const runs: Array<{ from: number; to: number; count: number }> = [];
  if (!source.slice(from, to).includes('&#')) return runs;
  for (const match of source.slice(from, to).matchAll(CHARACTER_REFERENCE)) {
    const at = from + match.index;
    if (escaped(source, at) || decodeEntity(match[0]) !== ' ') continue;
    const last = runs.at(-1);
    if (last?.to === at) {
      last.to += match[0].length;
      last.count++;
    } else {
      runs.push({ from: at, to: at + match[0].length, count: 1 });
    }
  }
  return runs;
}
const DELIMITER = /^[*_~]$/;
const UNICODE_WHITESPACE = /^[\t\n\f\r\p{Zs}]$/u;
const UNICODE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * Whether the delimiter runs right before `from` and right after `to` (a
 * reference) can open and close the same way when the reference is `char`.
 */
function sameFlanking(source: string, from: number, to: number, char: string): boolean {
  const kind = (c: string | undefined) => (c === undefined || UNICODE_WHITESPACE.test(c) ? 'space' : UNICODE_PUNCTUATION.test(c) ? 'punctuation' : 'other');
  // Whether a run of `delimiter` between `before` and `after` can open and close.
  const reads = (delimiter: string, before: string | undefined, after: string | undefined): string => {
    const b = kind(before);
    const a = kind(after);
    const left = a !== 'space' && (a !== 'punctuation' || b !== 'other');
    const right = b !== 'space' && (b !== 'punctuation' || a !== 'other');
    if (delimiter !== '_') return `${left} ${right}`;
    return `${left && (!right || b === 'punctuation')} ${right && (!left || a === 'punctuation')}`;
  };
  const delimiterBefore = source[from - 1];
  if (delimiterBefore !== undefined && DELIMITER.test(delimiterBefore)) {
    let start = from - 1;
    while (start > 0 && source[start - 1] === delimiterBefore) start--;
    if (reads(delimiterBefore, codePointBefore(source, start), source[from]) !== reads(delimiterBefore, codePointBefore(source, start), char)) return false;
  }
  const delimiterAfter = source[to];
  if (delimiterAfter !== undefined && DELIMITER.test(delimiterAfter)) {
    let end = to + 1;
    while (end < source.length && source[end] === delimiterAfter) end++;
    if (reads(delimiterAfter, source[to - 1], codePointAt(source, end)) !== reads(delimiterAfter, char, codePointAt(source, end))) return false;
  }
  return true;
}

/** The whole character that ends right before `at`: an emoji is two UTF-16 units. */
function codePointBefore(source: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = source.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = source.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return source.slice(at - 2, at);
  }
  return source[at - 1];
}

/** The whole character that starts at `at`. */
function codePointAt(source: string, at: number): string | undefined {
  const code = source.codePointAt(at);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** A character reference as Markdown spells one; whether it names a character is decided apart. */
const CHARACTER_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const ASTERISK_SPELLING = new RegExp(String.raw`\\.|[*]|` + CHARACTER_REFERENCE.source, 'g');

/** The `:name:` shortcodes in `raw` that name an emoji Linear knows, with their offsets. */
function* emojiShortcodes(raw: string): Generator<{ index: number; length: number; emoji: string }> {
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = Object.hasOwn(nameToEmoji, match[1]!) ? nameToEmoji[match[1]!] : undefined;
    if (emoji) yield { index: match.index, length: match[0].length, emoji };
  }
}

/** Whether the character at `at` follows an odd run of backslashes, which escapes it. */
function escaped(text: string, at: number): boolean {
  let run = 0;
  while (text[at - 1 - run] === '\\') run++;
  return run % 2 === 1;
}

/**
 * A part of a paragraph split off at an image, which becomes a paragraph of
 * its own. Where it would read as another block alone (a heading, quote,
 * rule, list, code fence, HTML block, definition, table, `$$` math, a
 * `+++` collapsible section or a Git conflict marker), it gets the escape
 * that keeps it text. The
 * escapes are Linear's where Linear writes one: `\#`, `\>`, `\---`, `\-`,
 * every fence character, `\[label\]:`, a setext underline's first character
 * and a table delimiter row's. Linear writes `<`, `2)`, `|` and `$$` there
 * without an escape, so those get the plain one. The first part of a task
 * item's paragraph follows its checkbox (`startsLine` false): only its later
 * lines can turn it into a block (a setext underline, a delimiter row).
 */
function paragraphPart(text: string, startsLine: boolean): string {
  // An escape can expose another block (`> # x` once the quote is escaped
  // is text; a heading with an underline needs two). Each round escapes a
  // construct of its own line, so the lines bound the rounds.
  for (let round = 0; round <= lineBreaks(text) + 2; round++) {
    // A backslash in a code span is code text, and its backticks would end the span.
    const spans = codeSpans(text, 0, text.length);
    const at = blockStartEscapes(text, startsLine).filter((offset) => !spans.some(([from, to]) => from <= offset && offset < to));
    if (at.length === 0) break;
    for (const offset of [...at].sort((a, b) => b - a)) text = `${text.slice(0, offset)}\\${text.slice(offset)}`;
  }
  return text;
}

/** An unescaped closing marker can open a section after a literal title. */
function escapeLiteralSectionEnd(text: string): string {
  if (!/^\\\+{3}(?:[ \t]|\n)/.test(text)) return text;
  return text.replace(/\n\+{3}$/, '\n\\+++');
}

/** Where `text` needs a backslash to stay a paragraph on its own; empty when it is one. */
function blockStartEscapes(text: string, startsLine: boolean): number[] {
  // Linear's collapsible section, and a line `lint` reads as a Git conflict marker.
  if (startsLine && /^(?:\+\+\+|<{7}(?: |$))/.test(text)) return [0];
  // After a checkbox the first line is item text: a letter in the
  // checkbox's place keeps that line from opening a block, as it does.
  const shift = startsLine ? 0 : 1;
  const source = startsLine ? text : `x${text}`;
  const blocks = parse(source).children;
  // Where the line after `at` starts its text, in `text`.
  const lineAfter = (at: number): number => {
    const row = source.indexOf('\n', at) + 1;
    return row + /^[ \t]*/.exec(source.slice(row))![0].length - shift;
  };
  // A table can also interrupt the part's first lines: its delimiter row
  // held the image, which kept it from being one.
  const tables = blocks.filter((block) => block.type === 'table').map((table) => lineAfter(start(table)));
  if (tables.length > 0) return tables;
  const [block] = blocks;
  if (block === undefined) return [];
  const raw = source.slice(start(block), end(block));
  // Past here only a part that starts its line opens a block on its first
  // line; with the letter in front, `start(block)` is its offset in `text`.
  switch (block.type) {
    case 'paragraph':
      return MATH_PARAGRAPH.test(text) ? [0] : [];
    case 'heading':
      // A setext underline, or an ATX heading's hash.
      return [raw.includes('\n') ? lineAfter(start(block) + raw.lastIndexOf('\n')) : start(block)];
    case 'thematicBreak':
      // Linear escapes every star or underscore of a rule, and only the first dash.
      return raw[0] === '-' ? [start(block)] : [...raw].flatMap((char, index) => (char === raw[0] ? [start(block) + index] : []));
    case 'blockquote':
    case 'html':
      return [start(block)];
    case 'list': {
      const ordered = /^\d{1,9}(?=[.)])/.exec(raw);
      return [start(block) + (ordered?.[0].length ?? 0)];
    }
    case 'code': {
      const fence = /^(?:`{3,}|~{3,})/.exec(raw);
      return fence === null ? [] : Array.from(fence[0], (_, index) => start(block) + index);
    }
    case 'definition':
    case 'footnoteDefinition': {
      let close = start(block) + 1;
      while (close < text.length && (text[close] !== ']' || escaped(text, close))) close++;
      return [start(block), close];
    }
    default:
      return [];
  }
}

/** Whether a node below the root has no source position. */
function hasUnplacedNode(tree: Root): boolean {
  let unplaced = false;
  visit(tree, (node) => {
    if (node.position === undefined) unplaced = true;
  });
  return unplaced;
}

/** The character a reference stands for, or undefined when it names none. */
function decodeEntity(reference: string): string | undefined {
  const name = reference.slice(1, -1);
  if (!name.startsWith('#')) {
    const decoded = decodeNamedCharacterReference(name);
    return decoded === false ? undefined : decoded;
  }
  const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  // Like Markdown, an invalid code point stands for nothing we write.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/**
 * A text made from a Linear document's `content`, in the form `fix` (and so
 * the `linear-format` hook) leaves unchanged. Linear's own text is not always
 * that form: it can store a table cell with a trailing space (`| a  |`).
 * Pass the whole file, front matter included, as the hook sees it, and
 * `inRepository`, whether a relative destination names a file of the
 * repository the file is written to (`linkedFileCheck`), as the hook checks it.
 *
 * Only a re-spelling is taken: when `fix` would change the document itself,
 * the file would no longer hold what Linear holds, and the text stays as it
 * is.
 */
export function fixLinearText(linearText: string, content: string, inRepository: (url: string) => boolean, previousBody?: string): string {
  // Read a nested file block as Linear holds it, not as the parent's text,
  // and text Linear wrote back without its escape as text.
  const split = splitFile(linearText);
  const text = joinFile(split.head, nestedFileBlocksOnItemLine(linearMarkersAsText(split.body, previousBody)));
  // A relative link or image still in Linear's content was not uploaded, so
  // its file is not there: Linear keeps such a link as a link, not as a file
  // block, and so does a repair that turns such an image into a link.
  // Compared as renderers read them: a later pass sees a destination in fix's spelling (`a|b` as `a%7Cb`).
  const notUploaded = relativeUrls(content, new Set(['link', 'image']));
  const notUploadedUris = new Set([...notUploaded].map((url) => normalizeUri(url)));
  const uploaded = (url: string): boolean => !notUploadedUris.has(normalizeUri(url));
  const linear = { linkedFileExists: uploaded };
  const fixed = fixText(text, linear);
  if (fixed !== text && !sameMarkdown(splitFile(fixed).body, splitFile(text).body, { linearNumberSpacing: true, linearBoldForms: true })) return text;
  // The hook cannot tell which files were uploaded. It can write a list item
  // holding only a link to a repository file as a file block. Linear stores
  // such a block as a link if it holds no upload for the file. Take the
  // hook's form only if sending it back still yields Linear's form.
  if (![...notUploaded].some((url) => !/\.md$/i.test(url.split(/[?#]/)[0]!) && inRepository(url))) return fixed;
  const hooked = fixText(text, { linkedFileExists: (url) => uploaded(url) || inRepository(url) });
  return fixText(hooked, linear) === fixed ? hooked : fixed;
}

/**
 * The body as Linear stores it after a write, for file blocks whose link is
 * still relative: Linear holds no upload of such a file, and stores the
 * block as the link on the item's line (`* [Name](<path>)`), so the text sent
 * reads as the same Markdown as what Linear then holds. Every other text
 * stays as written.
 */
export function relativeFileBlocksAsLinks(body: string): string {
  const joins: Array<{ from: number; to: number }> = [];
  visit(parse(body), (node) => {
    if (node.type !== 'listItem' || node.children.length !== 1) return;
    const [paragraph] = node.children;
    if (paragraph?.type !== 'paragraph' || attachmentLink(paragraph) === undefined) return;
    // A file block: the marker alone on its line, and the link on the next.
    const gap = /[ \t]*\r?\n[ \t>]*$/.exec(body.slice(start(node), start(paragraph)));
    if (gap !== null) joins.push({ from: start(paragraph) - gap[0].length, to: start(paragraph) });
  });
  // One pass over the joins, in text order: cutting each out of the whole
  // result would copy the text once per file block.
  const parts: string[] = [];
  let at = 0;
  for (const { from, to } of joins) {
    parts.push(body.slice(at, from), ' ');
    at = to;
  }
  parts.push(body.slice(at));
  return parts.join('');
}

/** The destinations of relative links in the text (no scheme, not an anchor), as written. */
export function relativeLinkUrls(text: string): Set<string> {
  return relativeUrls(text, new Set(['link']));
}

/** The relative destinations (no scheme, not an anchor) of the given node types in the text, as written. */
function relativeUrls(text: string, types: ReadonlySet<string>): Set<string> {
  const urls = new Set<string>();
  visit(parse(splitFile(text).body), (node) => {
    if ((node.type === 'link' || node.type === 'image') && types.has(node.type) && !/^[a-z][a-z0-9+.-]*:/i.test(node.url) && !node.url.startsWith('#')) urls.add(node.url);
  });
  return urls;
}

/** Video files Linear stores as a video block (recorded for these three; other types are unconfirmed). */
const VIDEO = /\.(?:mp4|mov|webm)$/i;

const MP3 = /\.mp3$/i;
const WAV_OR_OGG = /\.(?:wav|ogg)$/i;

/** The content indent `fix` writes for a list's last item: past its bullet, or past its widest number. */
function itemIndent(list: List): number {
  if (!list.ordered || list.children.at(-1)?.checked != null) return 2;
  return `${(list.start ?? 1) + list.children.length - 1}.`.length + 1;
}

/** Whether the last block written, inside the last quote or list item that ends the document, is a table. */
function endsWithTable(tree: Root): boolean {
  let node: Nodes | undefined = tree;
  while (node !== undefined && (node.type === 'root' || node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem')) {
    node = (node.children as Nodes[]).findLast((child) => child.type !== 'definition');
  }
  return node?.type === 'table';
}

/**
 * Whether Linear ends the list after an item: two blank lines after an
 * empty item start a new list, which Linear writes two blank lines below
 * it. Markdown reads the same list either way.
 */
function splitsAfter(item: ListItem, next: ListItem): boolean {
  return item.children.length === 0 && next.position!.start.line - item.position!.end.line > 2;
}

/** The kind of list Linear holds an item in: task items have their own list, without numbers. */
function listKind(list: List, item: ListItem): 'task' | 'ordered' | 'bullet' {
  return item.checked != null ? 'task' : list.ordered ? 'ordered' : 'bullet';
}

/**
 * Whether the list's first line, as `fix` writes it, can interrupt a
 * paragraph: its first item starts with text, and a number that starts it is 1.
 */
function opensWithText(list: List): boolean {
  const [item] = list.children;
  return item !== undefined && item.children[0]?.type === 'paragraph' && (listKind(list, item) !== 'ordered' || (list.start ?? 1) === 1);
}

function startsWithFileBlock(list: List): boolean {
  const [item] = list.children;
  if (item === undefined) return false;
  const link = itemAttachment(item);
  return link !== undefined && link.position!.start.line > item.position!.start.line;
}

function itemAttachment(item: ListItem): Link | undefined {
  const [first] = item.children;
  const link = first?.type === 'paragraph' && item.children.length === 1 ? attachmentLink(first) : undefined;
  if (link?.position!.start.line === item.position!.start.line) {
    // Linear keeps a bold inline file label as a link on its item's line.
    let label = link.children.length === 1 ? link.children[0] : undefined;
    while (label?.type === 'emphasis' && label.children.length === 1) label = label.children[0];
    if (label?.type === 'strong') return undefined;
  }
  return link;
}

/** A paragraph that holds only a link to a relative file other than Markdown: an attachment. */
function attachmentLink(paragraph: Paragraph): Link | undefined {
  const [only] = paragraph.children;
  if (paragraph.children.length !== 1 || only?.type !== 'link') return undefined;
  const url = only.url.split('#')[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || /\.md$/i.test(url) || url === '') return undefined;
  return only;
}

/** The prefix `container` takes at the start of `rest`: a quote marker or up to its item's indent in spaces. */
function prefixOf(container: Container, rest: string): RegExpExecArray | null {
  return container.kind === 'quote' ? /^ {0,3}> ?/.exec(rest) : new RegExp(`^ {0,${container.indent}}`).exec(rest);
}

/** Where the line holding `at` starts. */
function lineStartOf(source: string, at: number): number {
  return source.lastIndexOf('\n', at - 1) + 1;
}

/**
 * Joins lines with one space, dropping the spaces and tabs around each line
 * break. An index scan keeps it linear: a regular expression that looks for
 * the break after a run of spaces rescans the run from each of its positions.
 */
function joinLines(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      let start = 0;
      let end = line.length;
      if (index > 0) while (start < end && isSpaceOrTab(line[start]!)) start += 1;
      if (index < lines.length - 1) while (end > start && isSpaceOrTab(line[end - 1]!)) end -= 1;
      return line.slice(start, end);
    })
    .join(' ');
}

/** `text.trim()`, except that an NBSP stays: Linear keeps one around a paragraph's, heading's or body cell's text. */
function trimKeepingNbsp(text: string): string {
  let start = 0;
  while (start < text.length && trimmed(text[start]!)) start += 1;
  return trimEndKeepingNbsp(text.slice(start));
}

/** `text.trimEnd()`, except that an NBSP stays; one scan (a regular expression rescans a long run from each position). */
function trimEndKeepingNbsp(text: string): string {
  let end = text.length;
  while (end > 0 && trimmed(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

function trimmed(char: string): boolean {
  return char !== NBSP && char.trim() === '';
}

/**
 * Where Linear puts a backslash in a line of text that starts with a
 * no-break space or other whitespace outside ASCII: it looks past all the
 * whitespace and escapes a `#` run that reads as a heading (one to six
 * signs before whitespace or the line end) and the dot of a number before
 * whitespace. Markdown opens no block there; `-`, `+`, `>` and `N)` stay
 * plain.
 */
function unicodeSpaceEscape(line: string): number | undefined {
  const lead = unicodeSpaceLead(line);
  if (lead === 0) return undefined;
  const escape = headingOrNumberEscape(line.slice(lead));
  return escape === undefined ? undefined : lead + escape;
}

/** The length of the whitespace that starts the line when it starts with whitespace outside ASCII, else 0. */
function unicodeSpaceLead(line: string): number {
  return line === '' || line[0] === ' ' || line[0] === '\t' || !/^\s/.test(line) ? 0 : /^\s*/.exec(line)![0].length;
}

/** Where Linear escapes the start of text past that whitespace: a heading-like `#` run (0) or a number's dot. */
function headingOrNumberEscape(rest: string): number | undefined {
  if (/^#{1,6}(?:\s|$)/.test(rest)) return 0;
  const number = /^\d+(?=\.\s+\S)/.exec(rest);
  return number === null ? undefined : number[0].length;
}

/** The number of line breaks in the text. */
function lineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

function isSpaceOrTab(char: string): boolean {
  return char === ' ' || char === '\t';
}
