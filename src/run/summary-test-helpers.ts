// Reads a job summary's tables as GitHub-flavored Markdown does, for tests
// that require untrusted text in a cell to come back as itself.

import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/** Untrusted texts: Markdown, HTML, GitHub references, and bare URLs whose own characters must not show escapes. */
export const MARKUP_TEXTS = [
  'Weekly [notes](https://example.com/notes)',
  'Status ![badge](https://example.com/badge.png)',
  'Agenda <b>bold</b> <img src="x.png">',
  'Minutes `` a ` run `` and *stars* and _lines_ and ~~gone~~ and $x$',
  'Ref [label][ref] and [ref]: https://example.com',
  'Amp &lt;i&gt; entity \\[ escaped',
  'Release :rocket: for @someone in #12',
  'Mail team_one@example.com and www.example.com/a_b and https://example.com/x_y?a=1&b=2~3',
  'Wrapped (https://example.com/a_b) and https://example.com/end_*! and https://example.com/a[b]`c`\\d then *x*',
  'Pipe a|b and back\\slash',
];

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/**
 * The literal text of a cell; fails on anything but plain text. A bare URL
 * or address that GitHub-flavored Markdown links by itself shows its own
 * target as its text, so it can name nothing else and is allowed.
 */
function plainText(node: Node): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'link') {
    const text = (node.children ?? []).map(plainText).join('');
    assert.ok([text, `http://${text}`, `mailto:${text}`].includes(node.url ?? ''), `a link that does not show its target: ${text} -> ${node.url}`);
    return text;
  }
  assert.equal(node.type, 'tableCell', `markup in a cell: ${node.type}`);
  return (node.children ?? []).map(plainText).join('');
}

/** Every table row of the summary, head rows included, as the cells' literal texts. */
export function tableRows(markdown: string): string[][] {
  const rows: Node[][] = [];
  const walk = (node: Node) => {
    if (node.type === 'tableRow') rows.push(node.children ?? []);
    else for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node);
  return rows.map((row) => row.map(plainText));
}
