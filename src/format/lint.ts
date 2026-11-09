// `lint`: finds the Markdown that Linear would lose or alter, with file, line
// and rule. Conflict marker paragraphs written by the sync are ordinary bold
// text and pass.

import type { Definition, Root } from 'mdast';
import { CONTENT_LIMIT, LINT_RULES, type Finding, type LintRule } from './rules.ts';
import { end, line, lineCount, parse, splitFile, start, visit } from './markdown.ts';

const GIT_MARKER = /^ {0,3}(?:<{7}|>{7})(?: |$)/;
const QUOTE_PREFIX = /^ {0,3}> ?/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const URL_OR_LINK_ATTRIBUTE = /[a-z][a-z0-9+.-]*:\/\/|\b(?:src|href)\s*=/i;

/** Lint findings for one file's text, ordered by line. */
export function lintText(file: string, text: string): Finding[] {
  const { head, body } = splitFile(text);
  const offset = lineCount(head);
  const findings: Finding[] = [];
  const report = (rule: LintRule, bodyLine: number): void => {
    // One finding per rule and line, however many constructs share it.
    if (findings.some((f) => f.rule === rule && f.line === bodyLine + offset)) return;
    findings.push({ file, line: bodyLine + offset, rule, message: LINT_RULES[rule] });
  };
  const content = body.replace(/\r\n?/g, '\n');
  if ([...content].length > CONTENT_LIMIT) report('content-too-long', 1);
  const tree = parse(content);
  lintTree(tree, content, report);
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function lintTree(tree: Root, body: string, report: (rule: LintRule, line: number) => void): void {
  const definitions = new Map<string, Definition>();
  visit(tree, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node);
  });
  const codeLines = new Set<number>();
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
        // a lone `#` becomes an empty one. The header row keeps it as text.
        const [row, table] = ancestors.slice(-2).reverse();
        const [first] = node.children;
        const heading = first?.type === 'text' && ATX_HEADING.test(body.slice(start(first), end(first)));
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
        if (node.title) report('link-title', line(node));
        if (node.children.some((child) => child.type === 'image' || child.type === 'imageReference')) report('image-in-link', line(node));
        break;
      case 'linkReference': {
        const definition = definitions.get(node.identifier);
        if (definition?.title) report('link-title', line(node));
        if (node.children.some((child) => child.type === 'image' || child.type === 'imageReference')) report('image-in-link', line(node));
        break;
      }
      case 'image':
        if (node.title) report('image-title', line(node));
        break;
      case 'imageReference':
        if (definitions.get(node.identifier)?.title) report('image-title', line(node));
        break;
      case 'html':
        if (URL_OR_LINK_ATTRIBUTE.test(node.value)) report('url-in-html', line(node));
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

/** Paths whose document titles collide: same path apart from case or Unicode normalization. */
export function duplicateTitles(files: readonly string[]): Finding[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = file.replace(/\.md$/i, '').normalize('NFC').toUpperCase().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => group.map((file) => ({ file, line: 1, rule: 'duplicate-title' as const, message: `${LINT_RULES['duplicate-title']} (${group.filter((other) => other !== file).join(', ')})` })));
}
