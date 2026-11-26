// Pull repairs are separate from the record of what Linear actually holds.
import type { Nodes } from 'mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { parse, visit, start, end, line, allowedLink, linkDestination } from '../format/markdown.ts';
import { CONTENT_LIMIT } from '../format/rules.ts';
import { message } from '../messages.ts';

export interface ImageRewrite { image: number; total: number; line: number }

// Allow for two UTF-16 units per code point and for asset localization to grow the body.
export const IMAGE_REPAIR_INPUT_LIMIT = 4 * CONTENT_LIMIT;
const IMAGE_REPAIR_TEXT_LIMIT = IMAGE_REPAIR_INPUT_LIMIT;
const ESCAPE_PASS_LIMIT = 8;

export class ImageRepairBudgetError extends Error {
  constructor() {
    super(message('assets.image-repair-budget'));
    this.name = 'ImageRepairBudgetError';
  }
}

export function checkImageRepairSize(body: string): void {
  if (body.length > IMAGE_REPAIR_INPUT_LIMIT) throw new ImageRepairBudgetError();
}

function text(value: string): string {
  return toMarkdown({type: 'root', children: [{type: 'paragraph', children: [{type: 'text', value}]}]}).trimEnd();
}

/** Text inside the label of the link around an image: a `]` the serializer leaves bare would end that label. */
function linkLabelText(value: string): string {
  return text(value).replace(/(\\*)\]/g, (bracket, backslashes: string) => backslashes.length % 2 === 0 ? `${backslashes}\\]` : bracket);
}

/**
 * A link as Linear stores it: the destination in angle brackets, as `fix` writes it, so the repaired file
 * equals the document Linear holds after the write-back byte for byte. The serializer escapes the label.
 */
function linearLink(label: string, url: string): string {
  const link = (destination: string) => toMarkdown({type: 'root', children: [{type: 'paragraph', children: [{type: 'link', url: destination, children: [{type: 'text', value: label}]}]}]}, {resourceLink: true}).trimEnd();
  const labelled = /^(\[[\s\S]*\])\((?:<>)?\)$/.exec(link(''));
  // A serializer that spells an empty link another way keeps its own (valid) spelling of the whole link.
  return labelled === null ? link(url) : `${labelled[1]}(${linkDestination(url)})`;
}

/** The destination a repaired link resolves to: Linear's spelling encodes some characters of the image's URL. */
function destinationOf(link: string): string {
  let url = '';
  visit(parse(link), node => { if (node.type === 'link' && url === '') url = node.url; });
  return url;
}

/** An image destination on the web: `fix` writes it as a link, as a pull repairs it. */
const WEB_IMAGE = /^https?:/i;

/**
 * `fix`: images whose destination is an HTTP(S) URL become links, as `imageLinks` repairs them on a pull.
 * Nothing else changes: links `lint` refuses stay for their author. Undefined when there is no such image.
 */
export function webImageLinks(body: string): { body: string; lines: number[] } | undefined {
  checkImageRepairSize(body);
  const tree = parse(body);
  const definitions = new Map<string, {url: string; title?: string | null | undefined}>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  const selected = new Set<number>();
  let index = 0;
  visit(tree, node => {
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    index++;
    const definition = node.type === 'image' ? node : definitions.get(node.identifier);
    // A title would be lost: `image-title` leaves it to the author.
    if (definition !== undefined && WEB_IMAGE.test(definition.url) && !definition.title) selected.add(index);
  });
  if (selected.size === 0) return undefined;
  const repair = imageLinks(body, new Set(), selected, 'fix');
  return {body: repair.body, lines: repair.images.map(image => image.line)};
}

/**
 * Rewrites parsed nodes only; code examples and unrelated source spelling stay intact. A pull (`mode` 'pull')
 * also removes links with a refused scheme and keeps live uploads as images; `fix` changes only the selected images.
 */
export function imageLinks(body: string, deadUploads: ReadonlySet<string> = new Set(), onlyImages?: ReadonlySet<number>, mode: 'pull' | 'fix' = 'pull') {
  checkImageRepairSize(body);
  const simple = simpleImageParagraph(body, onlyImages);
  if (simple !== undefined) return simple;
  const tree = parse(body);
  const offset = body.startsWith('\uFEFF') ? 1 : 0;
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const linkChecks = new Map<string, boolean>();
  const permitted = (url: string) => {
    if (mode === 'fix') return true;
    const cached = linkChecks.get(url);
    if (cached !== undefined) return cached;
    const allowed = allowedLink(url);
    linkChecks.set(url, allowed);
    return allowed;
  };
  const images: ImageRewrite[] = [];
  const edits: Edit[] = [];
  const replacements = new Map<string, Pick<Edit, 'text' | 'url'>>();
  let replacementSize = 0;
  let destinationSize = 0;
  const checkDestination = (url: string) => {
    // Reference links can repeatedly resolve a long destination even when their edits are empty.
    destinationSize += url.length;
    if (destinationSize > IMAGE_REPAIR_TEXT_LIMIT) throw new ImageRepairBudgetError();
  };
  let count = 0;
  visit(tree, node => { if (node.type === 'image' || node.type === 'imageReference') count++; });
  let index = 0;
  visit(tree, (node, ancestors) => {
    const enclosingRemoved = ancestors.some(parent => (parent.type === 'link' && !permitted(parent.url)) || (parent.type === 'linkReference' && !permitted(definitions.get(parent.identifier) ?? '')));
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.type === 'link' ? node.url : definitions.get(node.identifier) ?? '';
      checkDestination(url);
      if (!permitted(url) && !enclosingRemoved) edits.push({from: start(node) + offset, to: end(node) + offset, text: ''});
      return;
    }
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    index++;
    const url = node.type === 'image' ? node.url : definitions.get(node.identifier);
    // Undefined reference images are plain Markdown, rather than resolved images.
    if (url === undefined) return;
    checkDestination(url);
    if (onlyImages !== undefined && !onlyImages.has(index)) return;
    let upload = false;
    try { const parsed = new URL(url); upload = parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.port === '' && parsed.username === '' && parsed.password === ''; } catch {}
    if (mode === 'pull' && upload && !deadUploads.has(url.split('#')[0]!) && !deadUploads.has(url) && !ancestors.some(parent => parent.type === 'link' || parent.type === 'linkReference')) return;
    images.push({image: index, total: count, line: line(node)});
    if (enclosingRemoved) return;
    let replacement: Pick<Edit, 'text' | 'url'> = {text: ''};
    if (url !== '' && permitted(url)) {
      const label = node.alt || url;
      const inLink = ancestors.some(parent => parent.type === 'link' || parent.type === 'linkReference');
      const inTable = ancestors.some(parent => parent.type === 'tableCell');
      const key = JSON.stringify([label, url, inLink, inTable]);
      const cached = replacements.get(key);
      if (cached !== undefined) replacement = cached;
      else {
        const rendered = inLink ? linkLabelText(label) : linearLink(label, url);
        const value = inTable ? rendered.replace(/\|/g, '&#124;') : rendered;
        replacement = {text: value, ...(value.startsWith('[') ? {url: destinationOf(value)} : {})};
        replacements.set(key, replacement);
      }
    } else {
      // Linear drops a link left without text, and its URL with it: the first removed image's
      // alt text, or else the link's URL, becomes its text, as `fix` writes a link without text.
      const link = ancestors.at(-1);
      const linkUrl = link?.type === 'link' ? link.url : link?.type === 'linkReference' ? definitions.get(link.identifier) : undefined;
      const removed = (child: Nodes) => {
        if (child.type !== 'image' && child.type !== 'imageReference') return false;
        const source = child.type === 'image' ? child.url : definitions.get(child.identifier);
        return source !== undefined && (source === '' || !permitted(source));
      };
      const children: Nodes[] = link !== undefined && 'children' in link ? link.children : [];
      if (linkUrl && children.every(child => removed(child) || (child.type === 'text' && child.value.trim() === '')) && children.find(removed) === node) {
        const label = linkLabelText(node.alt || linkUrl);
        // A table row is one line.
        replacement = {text: ancestors.some(parent => parent.type === 'tableCell') ? label.replace(/\|/g, '&#124;').replace(/\n/g, ' ') : label};
      }
    }
    // A long definition can be expanded by many references to it.
    replacementSize += replacement.text.length;
    if (replacementSize > IMAGE_REPAIR_TEXT_LIMIT) throw new ImageRepairBudgetError();
    edits.push({from: start(node) + offset, to: end(node) + offset, ...replacement});
  });
  // Remove unused dangerous definitions too: they must not survive as file-upload inputs.
  if (mode === 'pull') visit(tree, node => { if (node.type === 'definition' && !permitted(node.url)) edits.push({from: start(node) + offset, to: end(node) + offset, text: ''}); });
  // Only some callers need the text; the check below parses it once more.
  let repaired: string | undefined;
  return {images, get body() { return repaired ??= rewrite(body, tree, offset, edits); }};
}

type Edit = {from: number; to: number; text: string; url?: string};

/** A whole paragraph of space-separated images with plain labels and paths needs no Markdown reparse. */
function simpleImageParagraph(body: string, onlyImages: ReadonlySet<number> | undefined) {
  if (!body.startsWith('![')) return;
  const pattern = /!\[([a-z0-9 ]*)\]\(([a-z0-9./-]+)\)(?= |$)( *)/iy;
  const edits: Edit[] = [];
  const links = new Map<string, string>();
  let count = 0;
  const selected: number[] = [];
  while (pattern.lastIndex < body.length) {
    const match = pattern.exec(body);
    if (match === null) return;
    count++;
    if (onlyImages !== undefined && !onlyImages.has(count)) continue;
    const url = match[2]!;
    const label = match[1] || url;
    const key = `${label}\0${url}`;
    const replacement = links.get(key) ?? linearLink(label, url);
    links.set(key, replacement);
    const to = pattern.lastIndex - match[3]!.length;
    edits.push({from: match.index, to, text: replacement});
    selected.push(count);
  }
  const images = selected.map(image => ({image, total: count, line: 1}));
  let repaired: string | undefined;
  return {images, get body() { return repaired ??= spliceEdits(body, edits, new Map()).body; }};
}

/** Where links, images and definitions start, with the destinations they resolve to. */
function destinationsOf(tree: ReturnType<typeof parse>, offset: number): Map<number, string> {
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const found = new Map<number, string>();
  let destinationSize = 0;
  visit(tree, node => {
    const url = node.type === 'link' || node.type === 'image' || node.type === 'definition' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
    if (url === undefined) return;
    destinationSize += url.length;
    if (destinationSize > IMAGE_REPAIR_TEXT_LIMIT) throw new ImageRepairBudgetError();
    found.set(start(node) + offset, url);
  });
  return found;
}

/** Apply edits and move untouched destinations by the same displacement as their source text. */
function spliceEdits(body: string, edits: Edit[], destinations: Map<number, string>) {
  const parts: string[] = [];
  const allowed = new Map<number, string>();
  const places = [...destinations].sort(([a], [b]) => a - b);
  let next = 0;
  let cursor = 0;
  let shift = 0;
  for (const {from, to, text, url} of edits.sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (from < cursor) continue; // An outer edit has already replaced this node.
    while (next < places.length && places[next]![0] < from) {
      const [at, url] = places[next++]!;
      allowed.set(at + shift, url);
    }
    while (next < places.length && places[next]![0] < to) next++;
    if (url !== undefined) allowed.set(from + shift, url);
    parts.push(body.slice(cursor, from), text);
    shift += text.length - (to - from);
    cursor = to;
  }
  if (body.length + shift > IMAGE_REPAIR_TEXT_LIMIT) throw new ImageRepairBudgetError();
  while (next < places.length) {
    const [at, url] = places[next++]!;
    allowed.set(at + shift, url);
  }
  parts.push(body.slice(cursor));
  return {body: parts.join(''), allowed};
}

/**
 * Applies the edits, then checks the result. The edits splice text without parsing it again, so a literal `!`
 * before a repaired image (`!![x](path)`), or text a removal joins, can read as a new image, link or
 * definition. Linear's text never named it, so no check saw it; an image there would even pass as one
 * written in the repository and upload the file it names. Escaping the first character of every such
 * construct leaves plain text, or the link the repair meant.
 */
function rewrite(body: string, tree: ReturnType<typeof parse>, offset: number, edits: Edit[]): string {
  if (edits.length === 0) return body;
  let {body: result, allowed} = spliceEdits(body, edits, destinationsOf(tree, offset));
  const resultOffset = result.startsWith('\uFEFF') ? 1 : 0;
  // An escape can expose a construct nested inside, so check again after each pass.
  // If unsafe destinations remain after the last allowed pass, withhold the document.
  for (let pass = 0; ; pass++) {
    const added = [...destinationsOf(parse(result), resultOffset)]
      .filter(([at, url]) => allowed.get(at) !== url && '![<'.includes(result[at]!))
      .map(([at]) => ({from: at, to: at, text: '\\'}));
    if (added.length === 0) return result;
    if (pass === ESCAPE_PASS_LIMIT) throw new ImageRepairBudgetError();
    ({body: result, allowed} = spliceEdits(result, added, allowed));
  }
}
