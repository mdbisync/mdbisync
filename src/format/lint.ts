// `lint`: finds Markdown that formatting or sync would lose or alter, with file, line
// and rule. Conflict markers written by the sync are one-line warning
// callouts (bold paragraphs in earlier versions) and pass. Every image must be a file of the repository: Linear
// cannot be trusted to keep, or to reach, an image anywhere else.

import type { Definition, ImageReference, LinkReference, Nodes, PhrasingContent, Root, Table, TableRow } from 'mdast';
import { CONTENT_LIMIT, LINT_RULES, type Finding, type LintRule } from './rules.ts';
import { ASSETS_FOLDER } from '../sync/upload-type.ts';
import { allowedLink, bracketedLabel, listKind, nestsMarkerText, opensWithText, MARKDOWN_MAX_NODES, MarkdownLimitError, end, imageDestination, line, lineCount, linkDestination, parse, resolveTarget, splitFile, start, visit, endingRow } from './markdown.ts';
import { unwritableSectionLine } from './sections.ts';
import { tabReferences } from './tab-reference.ts';

const GIT_MARKER = /^ {0,3}(?:<{7}|>{7})(?: |$)/;
const QUOTE_PREFIX = /^ {0,3}> ?/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const FIX_ONLY_RULES: ReadonlySet<LintRule> = new Set<LintRule>(['hard-break-in-heading', 'list-after-item-text', 'setext-heading-lines', 'table-header-pipe', 'table-list-cell', 'tab-reference-layout', 'space-reference-edge', 'unplaced-link', 'number-paragraph']);
const NUMBER_ONLY = /^\d{1,9}\\[.)]$/;
const LIST_CELL = /^(?:[*+-]|\d{1,9}\))(?:[ \t]|$)/;
const LINK_ATTRIBUTE = /\b(?:src|href)\s*=/i;
const SCHEME_CHARACTER = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
/** Characters `fix` adds for each empty cell that pads a table row: the ` | ` before it (`Writer.table` in fix.ts). */
const PADDING_CELL_LENGTH = 3;

/** What `lint` may know about the file beyond its text. */
export interface LintOptions {
  /**
   * Whether a relative destination names a file of the repository, resolved
   * from the document's place (`linkedFileCheck`). Without it, only what the
   * text and the document's path show is checked: an image that is a URL, an
   * absolute path or a path outside the repository, or that names a
   * Markdown document.
   */
  linkedFileExists?: (url: string) => boolean;
  /**
   * The text is Linear's export, which writes a list that starts an item
   * below the marker line: item text that starts with a marker is text
   * (`fix`'s option of the same name).
   */
  linearExport?: boolean;
}

/**
 * The existence check of `lint`, `fix` and the sync: a link or an image names
 * a file the sync uploads when it resolves to a repository path, as the sync
 * resolves it, and that path is a file. It decides `image-file-missing`.
 */
export function linkedFileCheck(documentPath: string, isFile: (path: string) => boolean): (url: string) => boolean {
  return (url) => {
    const target = resolveTarget(documentPath, url);
    return target !== null && isFile(target);
  };
}

/**
 * Lint findings for a document of a git tree, whose images must be files of
 * that tree: `files` holds the tree's regular files (no symbolic links), by
 * path. The sync lints every document it reads this way.
 */
export function lintInTree(file: string, text: string, files: ReadonlySet<string>): Finding[] {
  const findings = lintText(file, text, { linkedFileExists: linkedFileCheck(file, (path) => files.has(path)) });
  // The heading rules guard the formatter's ATX conversion. The sync can
  // preserve setext text and uses historical versions to verify writes.
  // The setext and table rules report text Linear reads differently from
  // Markdown, but Linear's own export can hold it (a rule, text lines and a
  // rule; a list in a table cell): a document Linear wrote is not left out.
  // `unplaced-link` stops only `fix`: the sync sends the text as it is.
  return findings.filter((finding) => !FIX_ONLY_RULES.has(finding.rule));
}

/** Lint findings for one file's text, ordered by line. */
export function lintText(file: string, text: string, options: LintOptions = {}): Finding[] {
  const { head, body } = splitFile(text);
  const offset = lineCount(head);
  const findings: Finding[] = [];
  const reported = new Set<string>();
  const report = (rule: LintRule, bodyLine: number): void => {
    // One finding per rule and line, however many constructs share it.
    const key = `${rule}:${bodyLine}`;
    if (reported.has(key)) return;
    reported.add(key);
    findings.push({ file, line: bodyLine + offset, rule, message: LINT_RULES[rule] });
  };
  const sorted = (): Finding[] => findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  if (inAssetsFolder(file)) report('document-in-assets-folder', 1);
  const content = body.replace(/\r\n?/g, '\n');
  if (overContentLimit(content)) {
    // Linear refuses the whole document, so it is not parsed or linted:
    // content-too-long is reported alone.
    report('content-too-long', 1);
    return sorted();
  }
  let tree: Root;
  try {
    tree = parse(content);
  } catch (error) {
    if (!(error instanceof MarkdownLimitError)) throw error;
    report('markdown-complexity', 1);
    return sorted();
  }
  lintTree(file, tree, content, report, options);
  const { unsafeLine } = tabReferences(content);
  if (unsafeLine !== undefined) report('tab-reference-layout', unsafeLine);
  for (const at of spaceReferenceEdges(tree, content)) report('space-reference-edge', at);
  return sorted();
}

/**
 * The lines of space references (`&#32;`) at the start or end of a
 * paragraph's or heading's text, also just inside bold, italic or
 * strikethrough there, and next to an image, which `fix` writes as a
 * paragraph of its own. Linear stores the space on its first write and
 * drops it on the next: no text `fix` writes reads back the same in both, so
 * `fix` leaves the file to its author. A table cell is left out: Linear can
 * end a table where Markdown reads more rows.
 */
function spaceReferenceEdges(tree: Root, body: string): number[] {
  const lines: number[] = [];
  // Literal spaces or tabs only: a reference to a space is not blank.
  const blank = (node: PhrasingContent): boolean => node.type === 'text' && node.position !== undefined && /^[ \t\n]*$/.test(body.slice(start(node), end(node)));
  const edgeText = (child: PhrasingContent | undefined, side: 'first' | 'last'): PhrasingContent | undefined => {
    while (child !== undefined && (child.type === 'strong' || child.type === 'emphasis' || child.type === 'delete')) child = side === 'first' ? child.children[0] : child.children.at(-1);
    return child?.type === 'text' && child.position !== undefined ? child : undefined;
  };
  const check = (child: PhrasingContent | undefined, side: 'first' | 'last'): void => {
    const text = edgeText(child, side);
    if (text?.type !== 'text') return;
    // Spaces next to an image go when `fix` splits the paragraph there.
    let from = start(text);
    let to = end(text);
    while (from < to && (body[from] === ' ' || body[from] === '\t')) from++;
    while (to > from && (body[to - 1] === ' ' || body[to - 1] === '\t')) to--;
    if (side === 'first' && SPACE_REFERENCE_START.test(body.slice(from, from + 16))) lines.push(line(text));
    if (side === 'last' && SPACE_REFERENCE_END.test(body.slice(Math.max(from, to - 16), to))) lines.push(text.position!.end.line);
  };
  visit(tree, (node) => {
    if (node.type !== 'paragraph' && node.type !== 'heading') return;
    const parts: PhrasingContent[][] = [[]];
    for (const child of node.children) {
      if (node.type === 'paragraph' && (child.type === 'image' || child.type === 'imageReference')) parts.push([]);
      else parts.at(-1)!.push(child);
    }
    for (const part of parts) {
      const kept = part.filter((child, index) => !(blank(child) && (index === 0 || index === part.length - 1)));
      check(kept[0], 'first');
      check(kept.at(-1), 'last');
    }
  });
  return lines;
}

/** A decimal or hexadecimal space reference starting, or ending, a text. */
const SPACE_REFERENCE_START = /^&#(?:0*32|[xX]0*20);/;
const SPACE_REFERENCE_END = /&#(?:0*32|[xX]0*20);$/;

/**
 * The empty cells `fix` adds to a table: it writes every row with as many
 * cells as the header, the form Linear stores. A ragged table can grow far
 * beyond its source then (a long header over many one-cell rows), so lint
 * counts them before anything is written.
 */
/**
 * The line of the table whose padding takes the written text or tree over
 * its limit, or undefined when every table can be padded. Each empty cell
 * `fix` adds is written as ` | ` and is a node of the written tree.
 */
export function paddingOverLimit(tree: Root): number | undefined {
  let nodes = 0;
  const tables: Table[] = [];
  visit(tree, (node) => {
    nodes++;
    if (node.type === 'table') tables.push(node);
  });
  let added = 0;
  for (const table of tables) {
    added += paddingCells(table);
    if (added * PADDING_CELL_LENGTH > CONTENT_LIMIT || nodes + added > MARKDOWN_MAX_NODES) return line(table);
  }
  return undefined;
}

/**
 * The line of the reference whose expansion takes the written text over
 * `CONTENT_LIMIT`, or undefined when every reference fits. `fix` writes each
 * link or image reference with a fresh copy of its definition's destination
 * and drops the definitions, so a few kilobytes of `[a][r]` over one long
 * definition would be written as gigabytes. The written length is counted as
 * the source without its definitions, plus what each reference grows by:
 * its form in `fix` (`[text](destination)`, `![label](destination)`) with the
 * destination as `fix` writes it, less the reference's own source. Each
 * definition's destination is written once, however many references use it.
 */
export function referencesOverLimit(tree: Root, body: string): number | undefined {
  const definitions = new Map<string, Definition>();
  const dropped: Definition[] = [];
  const references: Array<LinkReference | ImageReference> = [];
  visit(tree, (node) => {
    if (node.type === 'definition') {
      dropped.push(node);
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') references.push(node);
  });
  if (references.length === 0) return undefined;
  // Everything is counted in code points, as `CONTENT_LIMIT` is; each
  // definition's destination is written and counted once.
  const destinations = new Map<string, number>();
  const destinationLength = (reference: LinkReference | ImageReference, url: string): number => {
    const key = `${reference.type}:${reference.identifier}`;
    let length = destinations.get(key);
    if (length === undefined) {
      length = codePoints(reference.type === 'linkReference' ? linkDestination(url) : imageDestination(url));
      destinations.set(key, length);
    }
    return length;
  };
  const length = (from: number, to: number): number => codePoints(body.slice(from, to));
  let written = codePoints(body) - dropped.reduce((sum, node) => sum + length(start(node), end(node)), 0);
  // A later reference can shrink the text again: the whole sum decides, and
  // the reference that last took it over the limit is named.
  let crossing: number | undefined;
  for (const reference of references) {
    const definition = definitions.get(reference.identifier);
    if (definition === undefined) continue;
    // `fix` writes `[text](destination)` from a link's children, `![label](destination)` from an image's label as written.
    const label = reference.type === 'linkReference' ? childrenLength(reference, length) + 4 : codePoints(bracketedLabel(body, start(reference) + 1, end(reference))) + 5;
    const before = written;
    written += label + destinationLength(reference, definition.url) - length(start(reference), end(reference));
    // A text already over the limit (a later pass of `fix`) is named at its first reference.
    if ((before <= CONTENT_LIMIT || crossing === undefined) && written > CONTENT_LIMIT) crossing = line(reference);
  }
  return written > CONTENT_LIMIT ? crossing : undefined;
}

/** The length of a link reference's text as written, between its brackets. */
function childrenLength(reference: LinkReference, length: (from: number, to: number) => number): number {
  const first = reference.children[0];
  const last = reference.children.at(-1);
  return first === undefined || last === undefined ? 0 : length(start(first), end(last));
}

/** Whether Linear ends the table at this row or a row above it (`endingRow`). */
function endedBefore(body: string, table: Table, row: Nodes): boolean {
  let ended = endedRows.get(table);
  if (ended === undefined) {
    // Once per table: a large table has a cell rule check for every cell.
    const ending = endingRow(body, table);
    ended = new Set(ending === undefined ? [] : table.children.slice(table.children.indexOf(ending)));
    endedRows.set(table, ended);
  }
  return ended.has(row as TableRow);
}

/** The rows of each table that Linear reads as a paragraph (`endedBefore`). */
const endedRows = new WeakMap<Table, ReadonlySet<TableRow>>();

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function paddingCells(table: Table): number {
  const width = table.children[0]?.children.length ?? 0;
  let cells = 0;
  for (const row of table.children) cells += Math.max(0, width - row.children.length);
  return cells;
}

/** Whether the text has more Unicode code points than `CONTENT_LIMIT`, counted without copying it. */
export function overContentLimit(text: string): boolean {
  if (text.length <= CONTENT_LIMIT) return false;
  let count = 0;
  for (const _ of text) if (++count > CONTENT_LIMIT) return true;
  return false;
}

function lintTree(file: string, tree: Root, body: string, report: (rule: LintRule, line: number) => void, options: LintOptions): void {
  const definitions = new Map<string, Definition>();
  visit(tree, (node) => {
    // The first definition of a label is the one Markdown uses.
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const image = (url: string, at: number): void => {
    const rule = imageProblem(file, url, options);
    if (rule !== undefined) report(rule, at);
  };
  const codeLines = new Set<number>();
  const padded = paddingOverLimit(tree);
  if (padded !== undefined) report('markdown-complexity', padded);
  const expanded = referencesOverLimit(tree, body);
  if (expanded !== undefined) {
    // The checks below read a definition's destination once for each of its
    // references; within the limit, those reads add up to at most the limit.
    report('markdown-complexity', expanded);
    return;
  }
  visit(tree, (node, ancestors) => {
    // The bare-URL search inside text left a link it could not place in the source (`parse`).
    if (node.type === 'link' && node.position === undefined) report('unplaced-link', unplacedLine(node, ancestors));
    switch (node.type) {
      case 'code':
      case 'inlineCode':
        for (let at = line(node); at <= (node.position?.end.line ?? at); at++) codeLines.add(at);
        if (node.type === 'inlineCode' && ancestors.some((a) => a.type === 'emphasis' || a.type === 'strong' || a.type === 'delete')) {
          report('code-in-emphasis', line(node));
        }
        break;
      case 'footnoteReference':
      case 'footnoteDefinition':
        report('footnote', line(node));
        break;
      case 'delete':
        if (!body.startsWith('~~', start(node))) report('subscript', line(node));
        break;
      case 'break':
        if (body[start(node)] === '\\') report('hard-break-backslash', line(node));
        else if (ancestors.some((a) => a.type === 'heading')) report('hard-break-in-heading', line(node));
        break;
      case 'listItem': {
        // `fix` writes a list that starts an item on the next line, as Linear does.
        const [first] = node.children;
        if (first !== undefined && first.type !== 'paragraph' && first.type !== 'list') report('block-first-in-list-item', line(first));
        // In an item, Linear writes a list on the line below the text or the
        // list of another kind before it. Markdown reads its first marker
        // there as text when it cannot interrupt a paragraph.
        // A first item that starts with another block is block-first-in-list-item.
        node.children.forEach((child, index) => {
          const previous = node.children[index - 1];
          // Text that starts with a marker is a nested list there too (`1. 2. a`).
          if (child.type !== 'list' || (opensWithText(child) && (options.linearExport === true || !nestsMarkerText(body, child.children[0]!))) || !['paragraph', 'list'].includes(child.children[0]?.children[0]?.type ?? 'paragraph')) return;
          const below = previous?.type === 'paragraph'
            || (previous?.type === 'list' && listKind(previous, previous.children.at(-1)) !== listKind(child, child.children[0]));
          if (below && endsWithParagraph(previous)) report('list-after-item-text', line(child));
        });
        // Markdown can hold a task item and a bullet item in one list, which
        // Linear (and `fix`) writes as two lists, the second on the next line.
        for (const list of node.children) {
          if (list.type !== 'list') continue;
          list.children.forEach((item, index) => {
            const previous = list.children[index - 1];
            if (previous === undefined || listKind(list, previous) === listKind(list, item)) return;
            if (item.children[0] !== undefined && item.children[0].type !== 'list') return;
            if (endsWithParagraph(previous)) report('list-after-item-text', line(item));
          });
        }
        break;
      }
      case 'list': {
        // Linear's task list has no numbers: a task item in an ordered list
        // ends up in a bullet task list.
        const task = node.ordered ? node.children.find((item) => item.checked !== null && item.checked !== undefined) : undefined;
        if (task !== undefined) report('ordered-task-list', line(task));
        break;
      }
      case 'heading': {
        // Linear keeps a setext heading's text up to its first line break
        // in text as the heading and reads the rest as a paragraph below
        // it. A line break in a code span is a space there: such a heading
        // stays one heading.
        if (node.children.some((child) => softBreakInText(child, body))) report('setext-heading-lines', line(node));
        break;
      }
      case 'table': {
        if (node.align?.some((align) => align !== null)) report('table-alignment', line(node));
        // Linear needs a pipe in the header row: without one the table is text.
        const lineEnd = body.indexOf('\n', start(node));
        if (!body.slice(start(node), lineEnd === -1 ? undefined : lineEnd).includes('|')) report('table-header-pipe', line(node));
        break;
      }
      case 'tableCell': {
        // Linear reads heading syntax that starts a body cell as a heading:
        // a lone `#` or `##` becomes an empty one, and `# Total` one holding
        // the text. An escaped `\#` stays text, and the header row keeps a
        // bare `#` as text too.
        const [row, table] = ancestors.slice(-2).reverse();
        // Rows from a line without `|` on are a paragraph in Linear, which `fix` writes.
        if (table?.type === 'table' && endedBefore(body, table, row!)) break;
        // Test the whole cell text: a first text node of only `#` may be
        // followed by markup (`#**tag**`), which is no heading.
        const first = node.children[0];
        const last = node.children.at(-1);
        const heading = first?.type === 'text' && last !== undefined && ATX_HEADING.test(body.slice(start(first), end(last)));
        if (heading && table?.type === 'table' && table.children[0] !== row) {
          report('table-hash-cell', line(node));
        }
        // Linear also reads a list marker that starts a body cell as a
        // list, and writes it as `*` or `N.`: `+ fee` comes back `* fee`.
        // A number and a dot keep their text; an escaped marker stays text.
        const list = first?.type === 'text' && last !== undefined && LIST_CELL.test(body.slice(start(first), end(last)));
        if (list && table?.type === 'table' && table.children[0] !== row) report('table-list-cell', line(node));
        break;
      }
      case 'text': {
        const cellAt = ancestors.findIndex((a) => a.type === 'tableCell');
        const table = ancestors[cellAt - 2];
        const inCell = cellAt !== -1 && !(table?.type === 'table' && endedBefore(body, table, ancestors[cellAt - 1]!));
        if (inCell && body.slice(start(node), end(node)).includes('\\|')) {
          report('table-escaped-pipe', line(node));
        }
        if (body.slice(start(node), end(node)).includes('^[')) report('footnote', line(node));
        break;
      }
      case 'link':
        if (!allowedLink(node.url)) report('link-scheme', line(node));
        if (node.title) report('link-title', line(node));
        if (node.children.some((child) => child.type === 'image' || child.type === 'imageReference')) report('image-in-link', line(node));
        break;
      case 'linkReference': {
        const definition = definitions.get(node.identifier);
        if (definition !== undefined && !allowedLink(definition.url)) report('link-scheme', line(node));
        if (definition?.title) report('link-title', line(node));
        if (node.children.some((child) => child.type === 'image' || child.type === 'imageReference')) report('image-in-link', line(node));
        break;
      }
      case 'image':
        if (node.title) report('image-title', line(node));
        image(node.url, line(node));
        break;
      case 'imageReference': {
        const definition = definitions.get(node.identifier);
        if (definition?.title) report('image-title', line(node));
        // Markdown reads a reference without its definition as text, so the definition is there.
        if (definition !== undefined) image(definition.url, line(node));
        break;
      }
      case 'html':
        if (hasUrlOrLinkAttribute(node.value)) report('url-in-html', line(node));
        break;
      case 'paragraph': {
        // Linear writes a paragraph of only a number and a dot or
        // parenthesis without its escape (`7\.` comes back `7.`), which
        // Markdown, and Linear on the next write, read as an empty item.
        // A task item's text follows its checkbox, where Linear keeps the escape.
        const item = ancestors.at(-1);
        const afterCheckbox = item?.type === 'listItem' && item.checked != null && item.children[0] === node;
        const [only] = node.children;
        if (!afterCheckbox && node.children.length === 1 && only!.type === 'text' && NUMBER_ONLY.test(body.slice(start(node), end(node)).trimEnd())) report('number-paragraph', line(node));
        break;
      }
      default:
        break;
    }
  });
  // Git's own conflict markers, outside code: Linear turns them into headings,
  // quotes and collapsible sections.
  // A closing marker `>>>>>>>` looks like quote prefixes: test the line
  // before each quote prefix is taken off.
  body.split('\n').forEach((text, index) => {
    if (codeLines.has(index + 1)) return;
    for (let rest = text; ; ) {
      if (GIT_MARKER.test(rest)) {
        report('git-conflict-marker', index + 1);
        return;
      }
      const prefix = QUOTE_PREFIX.exec(rest);
      if (!prefix) return;
      rest = rest.slice(prefix[0].length);
    }
  });
  const section = unwritableSectionLine(body);
  if (section !== undefined) report('section-opener', section);
}

/**
 * The line of a link the bare-URL search could not place. The text it came
 * from starts at the end of the placed sibling before it, or else at the
 * start of its parent; each line break in the text before the link is one
 * line further.
 */
function unplacedLine(node: Nodes, ancestors: readonly Nodes[]): number {
  const parent = ancestors.at(-1);
  let breaks = 0;
  if (parent !== undefined && 'children' in parent) {
    const siblings: readonly Nodes[] = parent.children;
    for (let index = siblings.indexOf(node) - 1; index >= 0; index--) {
      const sibling = siblings[index]!;
      if (sibling.position !== undefined) return sibling.position.end.line + breaks;
      if (sibling.type === 'text') breaks += sibling.value.split('\n').length - 1;
    }
  }
  const placed = ancestors.findLast((ancestor) => ancestor.position !== undefined);
  return (placed === undefined ? 1 : line(placed)) + breaks;
}

/**
 * The rule an image destination breaks, or undefined for a file of the
 * repository. The destination resolves from the document's place as the
 * sync resolves it.
 */
function imageProblem(file: string, url: string, options: LintOptions): LintRule | undefined {
  const target = resolveTarget(file, url);
  if (target === null) return 'image-not-in-repository';
  if (/\.md$/i.test(target)) return 'image-file-missing';
  if (options.linkedFileExists !== undefined && !options.linkedFileExists(url)) return 'image-file-missing';
  return undefined;
}

/**
 * Whether a document lies inside a folder named `assets`, where the sync
 * writes the files the documents of the folder above embed. The name is
 * matched exactly, as the folder line of `.gitattributes` matches it.
 */
export function inAssetsFolder(file: string): boolean {
  return file.split(/[\\/]/).slice(0, -1).includes(ASSETS_FOLDER);
}

/** The most other paths a `duplicate-title` finding names; the rest are counted. */
const COLLISIONS_NAMED = 3;

/**
 * Paths whose document titles collide: same path apart from case or Unicode
 * normalization. Each finding names the first few other paths of its group
 * and counts the rest, so the findings of n colliding files stay linear in n.
 */
export function duplicateTitles(files: readonly string[]): Finding[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = file.replace(/\.md$/i, '').normalize('NFC').toUpperCase().toLowerCase();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [file]);
    else group.push(file);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => {
      const named = group.slice(0, COLLISIONS_NAMED + 1);
      return group.map((file, index) => {
        const others = named.filter((_, other) => other !== index).slice(0, COLLISIONS_NAMED);
        const more = group.length - 1 - others.length;
        const list = more > 0 ? `${others.join(', ')}, and ${more} more` : others.join(', ');
        return { file, line: 1, rule: 'duplicate-title' as const, message: `${LINT_RULES['duplicate-title']} (${list})` };
      });
    });
}

/**
 * Whether raw HTML holds a link attribute (`src=`, `href=`) or a URL: `://`
 * right after a scheme, a letter followed by letters, digits, `+`, `.` or `-`.
 * The scheme is checked backwards from each `://`, over its own run of scheme
 * characters only, so the time stays linear in the length of the HTML.
 */
function hasUrlOrLinkAttribute(html: string): boolean {
  if (LINK_ATTRIBUTE.test(html)) return true;
  for (let at = html.indexOf('://'); at !== -1; at = html.indexOf('://', at + 1)) {
    for (let i = at - 1; i >= 0 && SCHEME_CHARACTER.test(html[i]!); i--) {
      if (LETTER.test(html[i]!)) return true;
    }
  }
  return false;
}

/** Whether the phrasing content's text runs over a line ending of the source, not in code or HTML (`&#10;` is no line ending). */
function softBreakInText(node: PhrasingContent, body: string): boolean {
  if (node.type === 'text') return body.slice(start(node), end(node)).includes('\n');
  return 'children' in node && (node.children as PhrasingContent[]).some((child) => softBreakInText(child, body));
}

/**
 * Whether a paragraph ends the block: the last block, through lists, items
 * and quotes, a marker on the next line would continue as text.
 */
function endsWithParagraph(node: Nodes | undefined): boolean {
  while (node !== undefined && (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote')) node = node.children.at(-1);
  return node?.type === 'paragraph';
}
