// Files that documents embed or link: images, PDFs, fonts, archives, media.
// Linear cannot reach a relative link into the repository, so before a
// document is written each such file is uploaded to Linear and the link's
// destination is replaced by the upload's URL. The upload cache maps the
// file's SHA-256 to that URL, so a file is uploaded once however many
// documents use it, and again only when its bytes change.
//
// The inverse maps each upload URL back to the link text the file had, so
// the recorded file equals the tracked one when Linear kept the text.
//
// A linked file is any regular file of the tracked tree that is not a
// Markdown file; links to Markdown files, to missing files, to folders and
// to other sites are left as they are. A file over the upload limit, or one
// whose LFS object cannot be read, leaves its document out.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Nodes } from 'mdast';
import { end, parse, splitFile, start, visit } from '../format/markdown.ts';
import { MARKDOWN_EXTENSION } from '../mapping/index.ts';
import {
  type Git,
  type StateConfig,
  type TreeEntry,
  type UploadMap,
  listTree,
  parseLfsPointer,
  readBlobs,
  readFiles,
} from '../state/index.ts';
import { type BodyTransform, LeaveOutError, type TransformContext } from './transform.ts';

/** Linear's upload limit on the free plan: 10 MB. A larger file leaves its document out. */
export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Rule of a document left out because a file it links is over the upload limit. */
export const UPLOAD_TOO_LARGE = 'upload-too-large';
/** Rule of a document left out because a file it links cannot be read (an LFS object that is missing). */
export const UPLOAD_UNREADABLE = 'upload-unreadable';

/** Blobs read per git process while hashing linked files. */
const HASH_BATCH = 100;

export interface UploadsOptions {
  config: StateConfig;
  /** Largest file uploaded, in bytes. */
  limit?: number;
}

/** A link to a file of the repository, found in a document's body. */
export interface FileLink {
  /** Where the destination's text starts and ends in the body, without angle brackets. */
  from: number;
  to: number;
  /** The destination as written. */
  raw: string;
  /** The linked file's path in the repository. */
  target: string;
}

interface LinkedFile {
  /** SHA-256 of the content, lowercase hex. */
  hash: string;
  size: number;
}

/** The transform that uploads linked files and writes their URLs into the document. */
export function uploadsTransform(options: UploadsOptions): BodyTransform {
  const limit = options.limit ?? DEFAULT_UPLOAD_LIMIT;
  let context: TransformContext | undefined;
  /** The tracked tree's regular files that are not Markdown, by path. */
  const files = new Map<string, TreeEntry>();
  const linked = new Map<string, LinkedFile>();
  /** For each document, its file links in order: what each destination said and the file's hash. */
  const links = new Map<string, Array<{ raw: string; hash: string }>>();

  const isFile = (path: string) => files.has(path);

  /** Hashes linked files: an LFS file by its pointer, without downloading it; another by its bytes. */
  const hashFiles = async (git: Git, paths: readonly string[]) => {
    const wanted = paths.filter((path) => !linked.has(path));
    for (let index = 0; index < wanted.length; index += HASH_BATCH) {
      const batch = wanted.slice(index, index + HASH_BATCH);
      const blobs = await readBlobs(git, batch.map((path) => (files.get(path) as TreeEntry).oid));
      for (const path of batch) {
        const blob = blobs.get((files.get(path) as TreeEntry).oid) as Buffer;
        const pointer = parseLfsPointer(blob);
        linked.set(path, pointer !== null ? { hash: pointer.oid, size: pointer.size } : { hash: sha256(blob), size: blob.length });
      }
    }
  };

  const upload = async (target: string, file: LinkedFile): Promise<string> => {
    const { git, tracked, linear, uploads } = context as TransformContext;
    const read = (await readFiles(git, options.config, tracked, [target])).get(target);
    if (read === undefined || !read.ok) {
      throw new LeaveOutError(UPLOAD_UNREADABLE, `${target} cannot be read: ${read?.reason ?? 'unknown'}`);
    }
    const { assetUrl } = await linear.uploadFile({ filename: posix.basename(target), contentType: contentTypeOf(target), bytes: new Uint8Array(read.content) });
    uploads.set(file.hash, assetUrl);
    return assetUrl;
  };

  return {
    name: 'uploads',

    async prepare(ctx) {
      context = ctx;
      for (const entry of await listTree(ctx.git, ctx.tracked)) {
        if (entry.type === 'blob' && entry.mode !== '120000' && !entry.path.endsWith(MARKDOWN_EXTENSION)) files.set(entry.path, entry);
      }
      // The links of every document to be written, from the tracked text, so
      // the inverse also works for documents an earlier run wrote.
      const paths = [...ctx.plan.create, ...ctx.plan.overwrite].map((entry) => entry.path);
      const documents = await readFiles(ctx.git, options.config, ctx.tracked, paths);
      const found = new Map<string, FileLink[]>();
      for (const [path, read] of documents) {
        if (!read.ok) continue;
        const body = splitFile(read.content.toString('utf8')).body;
        const fileLinks = findFileLinks(path, body, isFile);
        if (fileLinks.length > 0) found.set(path, fileLinks);
      }
      await hashFiles(ctx.git, [...new Set([...found.values()].flat().map((link) => link.target))]);
      for (const [path, fileLinks] of found) {
        links.set(path, fileLinks.map((link) => ({ raw: link.raw, hash: (linked.get(link.target) as LinkedFile).hash })));
      }
    },

    async apply({ path, body }) {
      if (context === undefined) throw new Error('the uploads transform was not prepared');
      const fileLinks = findFileLinks(path, body, isFile);
      if (fileLinks.length === 0) return body;
      await hashFiles(context.git, fileLinks.map((link) => link.target));

      // Check every file first, so a document left out uploads nothing.
      for (const link of fileLinks) {
        const file = linked.get(link.target) as LinkedFile;
        if (file.size > limit) {
          throw new LeaveOutError(UPLOAD_TOO_LARGE, `${link.target} has ${file.size} bytes, over the upload limit of ${limit}`);
        }
      }
      const urls: string[] = [];
      for (const link of fileLinks) {
        const file = linked.get(link.target) as LinkedFile;
        urls.push(context.uploads.get(file.hash) ?? (await upload(link.target, file)));
      }
      links.set(path, fileLinks.map((link) => ({ raw: link.raw, hash: (linked.get(link.target) as LinkedFile).hash })));

      let result = body;
      for (let index = fileLinks.length - 1; index >= 0; index -= 1) {
        const link = fileLinks[index] as FileLink;
        result = result.slice(0, link.from) + (urls[index] as string) + result.slice(link.to);
      }
      return result;
    },

    restore({ path, body }) {
      const fileLinks = links.get(path);
      if (fileLinks === undefined || context === undefined) return body;
      return restoreFileLinks(body, fileLinks, context.uploads);
    },
  };
}

/**
 * Replaces each upload URL with the destination its link had in the tracked
 * file. The n-th occurrence of a URL gets the n-th destination written for
 * that file, so two spellings of one link come back as they were.
 */
export function restoreFileLinks(body: string, fileLinks: ReadonlyArray<{ raw: string; hash: string }>, uploads: UploadMap): string {
  const raws = new Map<string, string[]>();
  for (const link of fileLinks) {
    const url = uploads.get(link.hash);
    if (url === undefined) continue;
    const list = raws.get(url) ?? [];
    list.push(link.raw);
    raws.set(url, list);
  }
  if (raws.size === 0) return body;
  // Longest first, so a URL that is a prefix of another does not match inside it.
  const pattern = new RegExp([...raws.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
  const seen = new Map<string, number>();
  return body.replace(pattern, (url) => {
    const list = raws.get(url) as string[];
    const index = seen.get(url) ?? 0;
    seen.set(url, index + 1);
    return list[Math.min(index, list.length - 1)] as string;
  });
}

/** Links, images and link definitions in `body` whose destination is a file of the repository. */
export function findFileLinks(documentPath: string, body: string, isFile: (path: string) => boolean): FileLink[] {
  const result: FileLink[] = [];
  visit(parse(body), (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const target = resolveTarget(documentPath, node.url);
    if (target === null || !isFile(target)) return;
    const range = destinationRange(body, node);
    if (range === null) return;
    const raw = body.slice(range.from, range.to);
    // Only a destination whose text names the same file is rewritten.
    if (resolveTarget(documentPath, unescapeDestination(raw)) !== target) return;
    result.push({ ...range, raw, target });
  });
  return result.sort((a, b) => a.from - b.from);
}

/** The repository path a relative destination points to, or null for anything else. */
export function resolveTarget(documentPath: string, url: string): string | null {
  if (url === '' || url.startsWith('#') || url.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const cut = url.search(/[?#]/);
  let path = cut === -1 ? url : url.slice(0, cut);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded: the destination names the file as it is.
  }
  if (path === '') return null;
  const joined = posix.normalize(posix.join(posix.dirname(documentPath), path));
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.endsWith('/')) return null;
  return joined;
}

/** Where the destination's text is in a link, image or definition node, without angle brackets. */
function destinationRange(body: string, node: Nodes): { from: number; to: number } | null {
  const nodeEnd = end(node);
  let opener: number;
  if (node.type === 'definition') {
    opener = body.indexOf(']:', start(node));
  } else if (node.type === 'link') {
    const last = node.children.at(-1);
    opener = body.indexOf('](', last !== undefined ? end(last) : start(node) + 1);
  } else {
    opener = body.indexOf('](', start(node) + 2);
  }
  if (opener === -1 || opener >= nodeEnd) return null;
  let position = opener + 2;
  while (position < nodeEnd && /[ \t\r\n]/.test(body[position] as string)) position += 1;
  if (body[position] === '<') {
    const close = body.indexOf('>', position + 1);
    return close === -1 || close > nodeEnd ? null : { from: position + 1, to: close };
  }
  const from = position;
  let depth = 0;
  while (position < nodeEnd) {
    const char = body[position] as string;
    if (char === '\\') {
      position += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    position += 1;
  }
  return position > from ? { from, to: Math.min(position, nodeEnd) } : null;
}

/** A destination's text with Markdown's backslash escapes removed, as the parser reads it. */
function unescapeDestination(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** The media type sent with an upload, from the file's extension. */
export function contentTypeOf(path: string): string {
  const base = posix.basename(path);
  const dot = base.lastIndexOf('.');
  const extension = dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
