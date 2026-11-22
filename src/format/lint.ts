// `lint`: finds the Markdown that Linear would lose or alter, with file, line
// and rule. Conflict markers written by the sync are one-line warning
// callouts (bold paragraphs in earlier versions) and pass. Every image must be a file of the repository: Linear
// cannot be trusted to keep, or to reach, an image anywhere else.

import type { Definition, ImageReference, LinkReference, Root, Table } from 'mdast';
import { CONTENT_LIMIT, LINT_RULES, type Finding, type LintRule } from './rules.ts';
import { ASSETS_FOLDER } from '../sync/upload-type.ts';
import { allowedLink, bracketedLabel, MARKDOWN_MAX_NODES, MarkdownLimitError, end, imageDestination, line, lineCount, linkDestination, parse, resolveTarget, splitFile, start, visit } from './markdown.ts';

const GIT_MARKER = /^ {0,3}(?:<{7}|>{7})(?: |$)/;
const QUOTE_PREFIX = /^ {0,3}> ?/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
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
  return lintText(file, text, { linkedFileExists: linkedFileCheck(file, (path) => files.has(path)) });
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
  return sorted();
}

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
    const label = reference.type === 'linkReference' ? childrenLength(reference, length) + 4 : codePoints(bracketedLabel(body, start(reference) + 1)) + 5;
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
function overContentLimit(text: string): boolean {
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
        break;
      case 'listItem': {
        const [first] = node.children;
        if (first !== undefined && first.type !== 'paragraph') report('block-first-in-list-item', line(first));
        break;
      }
      case 'table':
        if (node.align?.some((align) => align !== null)) report('table-alignment', line(node));
        break;
      case 'tableCell': {
        // Linear reads heading syntax that starts a body cell as a heading:
        // a lone `#` or `##` becomes an empty one, and `# Total` one holding
        // the text. An escaped `\#` stays text, and the header row keeps a
        // bare `#` as text too.
        const [row, table] = ancestors.slice(-2).reverse();
        // Test the whole cell text: a first text node of only `#` may be
        // followed by markup (`#**tag**`), which is no heading.
        const first = node.children[0];
        const last = node.children.at(-1);
        const heading = first?.type === 'text' && last !== undefined && ATX_HEADING.test(body.slice(start(first), end(last)));
        if (heading && table?.type === 'table' && table.children[0] !== row) {
          report('table-hash-cell', line(node));
        }
        break;
      }
      case 'text':
        if (ancestors.some((a) => a.type === 'tableCell') && body.slice(start(node), end(node)).includes('\\|')) {
          report('table-escaped-pipe', line(node));
        }
        if (body.slice(start(node), end(node)).includes('^[')) report('footnote', line(node));
        break;
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
