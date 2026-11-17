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
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const images: ImageRewrite[] = [];
  const edits: Array<{from: number; to: number; text: string}> = [];
  let count = 0;
  visit(tree, node => { if (node.type === 'image' || node.type === 'imageReference') count++; });
  let index = 0;
  visit(tree, (node, ancestors) => {
    const enclosingRemoved = ancestors.some(parent => (parent.type === 'link' && !allowedLink(parent.url)) || (parent.type === 'linkReference' && !allowedLink(definitions.get(parent.identifier) ?? '')));
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.type === 'link' ? node.url : definitions.get(node.identifier) ?? '';
      if (!allowedLink(url) && !enclosingRemoved) edits.push({from: start(node), to: end(node), text: ''});
      return;
    }
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    index++;
    if (onlyImages !== undefined && !onlyImages.has(index)) return;
    const url = node.type === 'image' ? node.url : definitions.get(node.identifier);
    // Undefined reference images are plain Markdown, rather than resolved images.
    if (url === undefined) return;
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
    edits.push({from: start(node), to: end(node), text: replacement});
  });
  // Remove unused dangerous definitions too: they must not survive as file-upload inputs.
  visit(tree, node => { if (node.type === 'definition' && !allowedLink(node.url)) edits.push({from: start(node), to: end(node), text: ''}); });
  let result = body;
  for (const edit of edits.sort((a,b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return {body: result, images};
}
