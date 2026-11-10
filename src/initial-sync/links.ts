// Links between synchronized documents.
//
// In git a document links another by a relative path (`../guide.md#setup`).
// In Linear the same link must open the other document, so it is written as
// that document's URL by id: `https://linear.app/<workspace>/document/<id>`,
// with the fragment kept. Linear stores a link in this form unchanged, also
// before the target exists, so a document created in the same run can be
// linked by the id the run chooses for it, in one pass. (A URL by the
// document's slug is turned into a mention that replaces the link text with
// the title, so it is not used.)
//
// The way back maps such a URL to the relative path the file had, so the
// recorded file equals the tracked one. A link the file did not have (a
// person added it in Linear) gets the shortest relative path.
//
// Only the link destination changes; every other byte stays. Links to files
// that are not synchronized documents, external links, anchors within the
// document, images and code are left as they are.

import { posix } from 'node:path';
import type { Definition, Link, Nodes } from 'mdast';
import { fixText } from '../format/index.ts';
import { parse, visit } from '../format/markdown.ts';
import { type LinearClient } from '../linear/index.ts';
import { type BodyTransform, type TransformContext } from './transform.ts';
import { message } from '../messages.ts';

/** Where a destination sits in the text and what it means. */
interface Destination {
  /** Offsets of the raw destination, angle brackets included. */
  from: number;
  to: number;
  /** The destination as the parser read it (escapes and entities resolved). */
  url: string;
}

/** The prefix of every document URL of a workspace, without a trailing slash. */
export function documentUrlBase(urlKey: string): string {
  return `https://linear.app/${urlKey}/document`;
}

/**
 * The repository path a relative link from `fromPath` points to, with its
 * fragment; undefined for anything that is not a link to a repository file:
 * a URL with a scheme, a protocol-relative URL, an anchor in the same
 * document, a query, or a path above the repository.
 */
export function resolveRelative(fromPath: string, url: string): { path: string; fragment: string | undefined } | undefined {
  if (url === '' || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  const hash = url.indexOf('#');
  const target = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? undefined : url.slice(hash + 1);
  if (target === '' || target.includes('?')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(fromPath), decoded);
  const path = posix.normalize(joined);
  if (path === '.' || path.startsWith('../') || path === '..' || path.endsWith('/')) return undefined;
  return { path, fragment };
}

/** The shortest relative link from `fromPath` to `toPath`, percent-encoded where a link needs it. */
export function relativeLink(fromPath: string, toPath: string): string {
  const relative = posix.relative(posix.dirname(fromPath), toPath);
  return relative.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Every link and link definition destination of a Markdown body, in text
 * order. Images are not links here, nor is a definition an image uses.
 */
export function linkDestinations(body: string): Destination[] {
  const tree = parse(body);
  const imageLabels = new Set<string>();
  visit(tree, (node: Nodes) => {
    if (node.type === 'imageReference') imageLabels.add(node.identifier);
  });
  const found: Destination[] = [];
  visit(tree, (node: Nodes) => {
    if (node.type !== 'link' && node.type !== 'definition') return;
    if (node.type === 'definition' && imageLabels.has(node.identifier)) return;
    const span = destinationSpan(body, node);
    // A span is used only when it reads back as the parser's destination; anything else (a link split over
    // quoted lines, say) stays as it is rather than being rewritten in the wrong place.
    if (span !== undefined && destinationUrl(body.slice(span.from, span.to)) === node.url) found.push({ ...span, url: node.url });
  });
  return found.sort((a, b) => a.from - b.from);
}

/** The URL the parser reads from a raw destination, or undefined when it is not one. */
function destinationUrl(raw: string): string | undefined {
  const paragraph = parse(`[x](${raw})`).children[0];
  const link = paragraph?.type === 'paragraph' && paragraph.children.length === 1 ? paragraph.children[0] : undefined;
  return link?.type === 'link' ? link.url : undefined;
}

/** Percent-encodes what a fragment cannot hold as it is in a link destination (the parser has resolved escapes and entities). */
function encodeFragment(fragment: string): string {
  // By code point (`u`): a character outside the Basic Multilingual Plane is one match, not two lone surrogates.
  return fragment.replace(/[^A-Za-z0-9\-._~!$'*+,;=:@/?%]/gu, (char) => encodeURIComponent(char));
}

/** Replaces destinations by offset; `replace` returns the new raw destination, or undefined to keep it. */
function rewrite(body: string, replace: (destination: Destination) => string | undefined): string {
  let result = '';
  let at = 0;
  for (const destination of linkDestinations(body)) {
    const next = replace(destination);
    if (next === undefined) continue;
    result += body.slice(at, destination.from) + next;
    at = destination.to;
  }
  return result + body.slice(at);
}

export interface LinkMap {
  /** The URL prefix of the workspace's documents. */
  base: string;
  /** Path → id of every document the run synchronizes. */
  ids: ReadonlyMap<string, string>;
  /** Id → path of ids a document did not get (superseded), which earlier text may still link; read back only. */
  aliases?: ReadonlyMap<string, string> | undefined;
}

/**
 * By document URL, the raw destinations the file had for it, in text order:
 * the relative links it replaced, and the document URLs the file already had.
 */
export type LinkSpellings = Map<string, string[]>;

/**
 * Rewrites relative links to synchronized documents as document URLs.
 * `seen` receives each written URL with the raw destination it replaced, so
 * the way back can restore the exact spelling of each link.
 */
export function linksToLinear(body: string, fromPath: string, map: LinkMap, seen?: LinkSpellings): string {
  const remember = (url: string, raw: string) => seen?.set(url, [...(seen.get(url) ?? []), raw]);
  /** Path → the superseded ids that name it: a link by one of them comes back with the same spelling. */
  const aliasesOf = new Map<string, string[]>();
  for (const [id, path] of map.aliases ?? []) aliasesOf.set(path, [...(aliasesOf.get(path) ?? []), id]);
  const urlOf = (id: string, fragment: string | undefined) => {
    const raw = `<${map.base}/${id}${fragment === undefined ? '' : `#${encodeFragment(fragment)}`}>`;
    return { raw, url: destinationUrl(raw) ?? raw.slice(1, -1) };
  };
  return rewrite(body, (destination) => {
    const original = body.slice(destination.from, destination.to);
    // A document URL the file already has comes back as it is.
    if (destination.url.startsWith(`${map.base}/`)) {
      remember(destination.url, original);
      return undefined;
    }
    const target = resolveRelative(fromPath, destination.url);
    if (target === undefined) return undefined;
    const id = map.ids.get(target.path);
    if (id === undefined) return undefined;
    const { raw, url } = urlOf(id, target.fragment);
    remember(url, original);
    for (const alias of aliasesOf.get(target.path) ?? []) remember(urlOf(alias, target.fragment).url, original);
    return raw;
  });
}

const reversed = new WeakMap<ReadonlyMap<string, string>, ReadonlyMap<string, string>>();

/** Id → path, built once per map: a run restores every document with the same one. */
function pathsById(ids: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  let paths = reversed.get(ids);
  if (paths === undefined) {
    paths = new Map([...ids].map(([path, id]) => [id, path]));
    reversed.set(ids, paths);
  }
  return paths;
}

/** Whether a body has a relative link to one of the documents. */
export function hasDocumentLinks(body: string, fromPath: string, ids: ReadonlyMap<string, string>): boolean {
  return linkDestinations(body).some((destination) => {
    const target = resolveRelative(fromPath, destination.url);
    return target !== undefined && ids.has(target.path);
  });
}

/**
 * Maps document URLs of synchronized documents back to relative links. The
 * n-th link to a URL gets the n-th raw destination the file had for it, when
 * `seen` knows one; otherwise the shortest relative path in angle brackets.
 */
export function linksFromLinear(content: string, fromPath: string, map: LinkMap, seen?: ReadonlyMap<string, readonly string[]>): string {
  const paths = pathsById(map.ids);
  const prefix = `${map.base}/`;
  const used = new Map<string, number>();
  return rewrite(content, (destination) => {
    if (!destination.url.startsWith(prefix)) return undefined;
    const index = used.get(destination.url) ?? 0;
    used.set(destination.url, index + 1);
    const known = seen?.get(destination.url)?.[index];
    if (known !== undefined) return known;
    const rest = destination.url.slice(prefix.length);
    const hash = rest.indexOf('#');
    const id = hash === -1 ? rest : rest.slice(0, hash);
    const path = paths.get(id) ?? map.aliases?.get(id);
    if (path === undefined) return undefined;
    return `<${relativeLink(fromPath, path)}${hash === -1 ? '' : rest.slice(hash)}>`;
  });
}

/**
 * The offsets of a link's or definition's destination in the source. For an
 * inline link it follows the `](` after the link text; for a definition, the
 * `]:` after the label. Reference links have no destination of their own.
 */
function destinationSpan(body: string, node: Link | Definition): { from: number; to: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  let at: number;
  if (node.type === 'link') {
    // Autolinks and literal URLs have no `](`; they never hold a relative path.
    if (body[end - 1] !== ')') return undefined;
    const last = node.children.at(-1);
    const textEnd = last?.position?.end.offset ?? start + 1;
    const open = body.indexOf('](', textEnd);
    if (open === -1 || open >= end) return undefined;
    at = open + 2;
  } else {
    // The label ends at the first unescaped `]`.
    let close = start + 1;
    while (close < end && body[close] !== ']') close += body[close] === '\\' ? 2 : 1;
    if (body[close + 1] !== ':') return undefined;
    at = close + 2;
  }
  while (at < end && /[ \t\r\n]/.test(body[at] as string)) at += 1;
  if (body[at] === '<') {
    let close = at + 1;
    while (close < end && body[close] !== '>') close += body[close] === '\\' ? 2 : 1;
    return close < end ? { from: at, to: close + 1 } : undefined;
  }
  let to = at;
  let depth = 0;
  while (to < end) {
    const char = body[to] as string;
    if (char === '\\') {
      to += 2;
      continue;
    }
    if (/[ \t\r\n]/.test(char)) break;
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    to += 1;
  }
  return to > at ? { from: at, to } : undefined;
}


/**
 * Whether Linear content links a Linear document: one of the destinations
 * `linksFromLinear` can rewrite is an https URL on the host `linear.app` with
 * a `/<workspace>/document/` path. Without one, nothing maps back to a
 * relative link, so a run skips the request for the URL key.
 */
export function linksLinearDocuments(content: string): boolean {
  return linkDestinations(content).some((destination) => isLinearDocumentUrl(destination.url));
}

function isLinearDocumentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === 'linear.app' && /^\/[^/]+\/document\//.test(parsed.pathname);
}

/** Reads the workspace's URL key; one request. */
export async function workspaceUrlKey(linear: LinearClient): Promise<string> {
  const data = await linear.request<{ organization: { urlKey: string } }>('WorkspaceUrlKey', 'query', 'query WorkspaceUrlKey { organization { urlKey } }');
  return data.organization.urlKey;
}

/**
 * The transform for an initial sync from git to Linear. The workspace's URL
 * key is read with the first document that links another, so a run without
 * such links makes no request for it; a stop on that request stops the run
 * like any other write.
 */
export function documentLinks(): BodyTransform {
  let context: TransformContext | undefined;
  let map: LinkMap | undefined;
  /**
   * By document path, for the documents rewritten: what the transform wrote,
   * and for each document URL the destinations the file had, as written and
   * in Linear's form.
   */
  const rewritten = new Map<string, { asWritten: LinkSpellings; inLinearForm: LinkSpellings }>();
  return {
    name: 'document-links',
    async prepare(run: TransformContext) {
      context = run;
    },
    async apply({ path, body }) {
      if (context === undefined) throw new Error(message('initial-sync.links-not-prepared'));
      if (map === undefined) {
        if (!hasDocumentLinks(body, path, context.documentIds)) return body;
        map = { base: documentUrlBase(await workspaceUrlKey(context.linear)), ids: context.documentIds };
      }
      const asWritten: LinkSpellings = new Map();
      const written = linksToLinear(body, path, map, asWritten);
      if (written === body) {
        rewritten.delete(path);
        return body;
      }
      // Spellings in Linear's form come from Linear's form of the whole body: it can expand a reference into
      // several inline links, which changes how many links there are and in what order.
      const inLinearForm: LinkSpellings = new Map();
      linksToLinear(fixText(body), path, map, inLinearForm);
      rewritten.set(path, { asWritten, inLinearForm });
      return written;
    },
    restore({ path, body, kept }) {
      // In an initial sync only what this transform wrote comes back; a document it did not rewrite stays as it is.
      const entry = rewritten.get(path);
      if (map === undefined || entry === undefined) return body;
      // Linear kept the text: each link comes back exactly as the file had it. Linear reformatted it: the links
      // come back in Linear's form too, so the restored text is Linear's form of the file, not a mix of both. Spellings
      // matter here because Linear can change how many links there are; the initial sync then puts the whole restored
      // text in Linear's form (`restoreBody`), which settles the spellings of every other transform too.
      return linksFromLinear(body, path, map, kept ? entry.asWritten : entry.inLinearForm);
    },
  };
}
