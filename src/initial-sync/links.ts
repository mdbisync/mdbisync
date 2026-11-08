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
import { parse, visit } from '../format/markdown.ts';
import { type LinearClient } from '../linear/index.ts';
import { type BodyTransform, type TransformContext } from './transform.ts';

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

/** Every link and link definition destination of a Markdown body, in text order. Images are not links here. */
export function linkDestinations(body: string): Destination[] {
  const found: Destination[] = [];
  visit(parse(body), (node: Nodes) => {
    if (node.type !== 'link' && node.type !== 'definition') return;
    const span = destinationSpan(body, node);
    if (span !== undefined) found.push({ ...span, url: node.url });
  });
  return found.sort((a, b) => a.from - b.from);
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
}

/** Each written URL with the raw destinations it replaced, in text order. */
export type LinkSpellings = Map<string, string[]>;

/**
 * Rewrites relative links to synchronized documents as document URLs.
 * `seen` receives each written URL with the raw destination it replaced, so
 * the way back can restore the exact spelling of each link.
 */
export function linksToLinear(body: string, fromPath: string, map: LinkMap, seen?: LinkSpellings): string {
  return rewrite(body, (destination) => {
    const target = resolveRelative(fromPath, destination.url);
    if (target === undefined) return undefined;
    const id = map.ids.get(target.path);
    if (id === undefined) return undefined;
    const url = `${map.base}/${id}${target.fragment === undefined ? '' : `#${target.fragment}`}`;
    const raw = `<${url}>`;
    if (seen !== undefined) seen.set(url, [...(seen.get(url) ?? []), body.slice(destination.from, destination.to)]);
    return raw;
  });
}

/**
 * Maps document URLs of synchronized documents back to relative links. The
 * n-th link to a URL gets the n-th raw destination the file had for it, when
 * `seen` knows one; otherwise the shortest relative path in angle brackets.
 */
export function linksFromLinear(content: string, fromPath: string, map: LinkMap, seen?: ReadonlyMap<string, readonly string[]>): string {
  const paths = new Map([...map.ids].map(([path, id]) => [id, path]));
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
    const path = paths.get(id);
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
    const colon = body.indexOf(']:', start);
    if (colon === -1 || colon >= end) return undefined;
    at = colon + 2;
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

/** Reads the workspace's URL key; one request. */
export async function workspaceUrlKey(linear: LinearClient): Promise<string> {
  const data = await linear.request<{ organization: { urlKey: string } }>('WorkspaceUrlKey', 'query', 'query WorkspaceUrlKey { organization { urlKey } }');
  return data.organization.urlKey;
}

/** The transform for an initial sync from git to Linear. */
export function documentLinks(): BodyTransform {
  let map: LinkMap | undefined;
  /** By document path: each written URL and the raw destination it replaced. */
  const seen = new Map<string, LinkSpellings>();
  return {
    name: 'document-links',
    async prepare(context: TransformContext) {
      map = context.documentIds.size === 0 ? undefined : { base: documentUrlBase(await workspaceUrlKey(context.linear)), ids: context.documentIds };
    },
    async apply({ path, body }) {
      if (map === undefined) return body;
      const urls: LinkSpellings = new Map();
      seen.set(path, urls);
      return linksToLinear(body, path, map, urls);
    },
    restore({ path, body }) {
      if (map === undefined) return body;
      return linksFromLinear(body, path, map, seen.get(path));
    },
  };
}
