// The text of a Markdown body without its formatting, for tests that check
// what Linear keeps of a document.

import { parse, visit } from '../../src/format/markdown.ts';

const PLACES: ReadonlySet<string> = new Set(['list', 'listItem', 'blockquote', 'table', 'tableRow', 'tableCell', 'code']);
const INDEXED: ReadonlySet<string> = new Set(['listItem', 'tableRow', 'tableCell']);

/**
 * The words, URLs and raw HTML of a body, each with its place: the lists,
 * items, quotes, table rows and cells it is in. Formatting (emphasis,
 * headings, alignment, titles, list markers, breaks) is not part of it.
 */
export function textAndPlaces(body: string): string[] {
  const tree = parse(body);
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
  });
  const out: string[] = [];
  visit(tree, (node, ancestors) => {
    const place = ancestors.flatMap((parent, at) => {
      if (!PLACES.has(parent.type)) return [];
      const index = INDEXED.has(parent.type) ? (ancestors[at - 1] as { children: unknown[] }).children.indexOf(parent) : '';
      return [`${parent.type}${index}`];
    }).join('/');
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code' || node.type === 'html') {
      for (const word of node.value.match(/[\p{L}\p{N}]+/gu) ?? []) out.push(`${place} ${word}`);
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      for (const word of node.alt?.match(/[\p{L}\p{N}]+/gu) ?? []) out.push(`${place} alt ${word}`);
    }
    if (node.type === 'listItem' && typeof node.checked === 'boolean') out.push(`${place} checked ${node.checked}`);
    const url = node.type === 'link' || node.type === 'image' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
    if (url !== undefined) out.push(`${place} <${url}>`);
  });
  return out;
}

/** Whether two bodies hold the same text in the same places, whatever their formatting. */
export function sameText(a: string, b: string): boolean {
  return JSON.stringify(textAndPlaces(a)) === JSON.stringify(textAndPlaces(b));
}
