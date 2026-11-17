// Pull repairs are separate from the record of what Linear actually holds.
import { toMarkdown } from 'mdast-util-to-markdown';
import { parse, visit, start, end, line, allowedLink } from '../format/markdown.ts';

export interface ImageRewrite { image: number; total: number; line: number }

function text(value: string): string {
  return toMarkdown({type: 'root', children: [{type: 'paragraph', children: [{type: 'text', value}]}]}).trimEnd();
}

/** Rewrites parsed nodes only; code examples and unrelated source spelling stay intact. */
export function imageLinks(body: string, deadUploads: ReadonlySet<string> = new Set(), onlyImages?: ReadonlySet<number>) {
  const tree = parse(body);
  const offset = body.startsWith('\uFEFF') ? 1 : 0;
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const images: ImageRewrite[] = [];
  const edits: Edit[] = [];
  let count = 0;
  visit(tree, node => { if (node.type === 'image' || node.type === 'imageReference') count++; });
  let index = 0;
  visit(tree, (node, ancestors) => {
    const enclosingRemoved = ancestors.some(parent => (parent.type === 'link' && !allowedLink(parent.url)) || (parent.type === 'linkReference' && !allowedLink(definitions.get(parent.identifier) ?? '')));
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.type === 'link' ? node.url : definitions.get(node.identifier) ?? '';
      if (!allowedLink(url) && !enclosingRemoved) edits.push({from: start(node) + offset, to: end(node) + offset, text: ''});
      return;
    }
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    index++;
    const url = node.type === 'image' ? node.url : definitions.get(node.identifier);
    // Undefined reference images are plain Markdown, rather than resolved images.
    if (url === undefined) return;
    if (onlyImages !== undefined && !onlyImages.has(index)) return;
    let upload = false;
    try { const parsed = new URL(url); upload = parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.port === '' && parsed.username === '' && parsed.password === ''; } catch {}
    if (upload && !deadUploads.has(url.split('#')[0]!) && !deadUploads.has(url) && !ancestors.some(parent => parent.type === 'link' || parent.type === 'linkReference')) return;
    images.push({image: index, total: count, line: line(node)});
    if (enclosingRemoved) return;
    let replacement = '';
    if (url !== '' && allowedLink(url)) {
      const label = node.alt || url;
      replacement = ancestors.some(parent => parent.type === 'link' || parent.type === 'linkReference')
        ? text(label)
        : toMarkdown({type: 'root', children: [{type: 'paragraph', children: [{type: 'link', url, children: [{type: 'text', value: label}]}]}]}, {resourceLink: true}).trimEnd();
    }
    if (ancestors.some(parent => parent.type === 'tableCell')) replacement = replacement.replace(/\|/g, '&#124;');
    edits.push({from: start(node) + offset, to: end(node) + offset, text: replacement, ...(replacement.startsWith('[') ? {url} : {})});
  });
  // Remove unused dangerous definitions too: they must not survive as file-upload inputs.
  visit(tree, node => { if (node.type === 'definition' && !allowedLink(node.url)) edits.push({from: start(node) + offset, to: end(node) + offset, text: ''}); });
  // Only some callers need the text; the check below parses it once more.
  let repaired: string | undefined;
  return {images, get body() { return repaired ??= rewrite(body, tree, offset, edits); }};
}

type Edit = {from: number; to: number; text: string; url?: string};

/** Where links, images and definitions start, with the destinations they resolve to. */
function destinationsOf(tree: ReturnType<typeof parse>, offset: number): Map<number, string> {
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const found = new Map<number, string>();
  visit(tree, node => {
    const url = node.type === 'link' || node.type === 'image' || node.type === 'definition' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
    if (url !== undefined) found.set(start(node) + offset, url);
  });
  return found;
}

/**
 * Applies the edits, then checks the result. The edits splice text without parsing it again, so a literal `!`
 * before a repaired image (`!![x](path)`), or text a removal joins, can read as a new image, link or
 * definition. Linear's text never named it, so no check saw it; an image there would even pass as one
 * written in the repository and upload the file it names. Escaping the first character of every such
 * construct leaves plain text, or the link the repair meant.
 */
function rewrite(body: string, tree: ReturnType<typeof parse>, offset: number, edits: Edit[]): string {
  // What the result may hold: the constructs the edits leave alone, at their new places, and the repair's links.
  let expected = [...destinationsOf(tree, offset)];
  let result = body;
  for (const edit of edits.sort((a,b) => b.from - a.from)) {
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
    const shift = edit.text.length - (edit.to - edit.from);
    expected = expected.flatMap(([at, url]) => at < edit.from ? [[at, url] as [number, string]] : at < edit.to ? [] : [[at + shift, url] as [number, string]]);
    if (edit.url !== undefined) expected.push([edit.from, edit.url]);
  }
  let allowed = new Map(expected);
  const resultOffset = result.startsWith('\uFEFF') ? 1 : 0;
  // Each pass escapes at least one unescaped `!`, `[` or `<`, and adding a backslash before one never
  // unescapes another, so the loop ends. An escape can expose a construct nested inside; the next pass sees it.
  for (;;) {
    const added = [...destinationsOf(parse(result), resultOffset)]
      .filter(([at, url]) => allowed.get(at) !== url && '![<'.includes(result[at]!))
      .map(([at]) => at);
    if (added.length === 0) return result;
    for (const at of added.sort((a, b) => b - a)) {
      result = result.slice(0, at) + '\\' + result.slice(at);
      allowed = new Map([...allowed].map(([place, url]) => [place >= at ? place + 1 : place, url]));
    }
  }
}
