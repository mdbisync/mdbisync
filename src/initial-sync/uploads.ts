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
// whose LFS object cannot be read, leaves its document out; the dry run
// lists those documents without uploading anything.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Nodes } from 'mdast';
import { end, parse, splitFile, start, visit } from '../format/markdown.ts';
import { LinearError, LinearStoppedError } from '../linear/index.ts';
import { MARKDOWN_EXTENSION } from '../mapping/index.ts';
import {
  type Git,
  type Oid,
  type StateConfig,
  type TreeEntry,
  type UploadMap,
  listTree,
  parseLfsPointer,
  readBlobs,
  type LfsRead,
  lfsReader,
} from '../state/index.ts';
import { type InitialSyncPlan } from './plan.ts';
import { type BodyTransform, LeaveOutError, type TransformContext } from './transform.ts';

/** Linear's upload limit on the free plan: 10 MB. A larger file leaves its document out. */
export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Rule of a document left out because a file it links is over the upload limit. */
export const UPLOAD_TOO_LARGE = 'upload-too-large';
/** Rule of a document left out because a file it links cannot be read (an LFS object that is missing). */
export const UPLOAD_UNREADABLE = 'upload-unreadable';

/** Bytes of blobs read per git process while hashing linked files. */
const HASH_BATCH_BYTES = 64 * 1024 * 1024;
/** An LFS pointer file is smaller than this (Git LFS spec v1). */
const MAX_POINTER_SIZE = 1024;
/** Files uploaded with one API request before the first write, and their largest total size. */
const UPLOAD_BATCH_FILES = 20;
const UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;

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
  /** The destination as written, with its angle brackets when it has them: what the restore puts back. */
  written: string;
  /** The linked file's path in the repository. */
  target: string;
  /** The destination's query and fragment (`#page=3`), kept after the upload URL. */
  suffix: string;
}

/** What a document's link to a file was before the upload: restored in place of `url + suffix`. */
export interface WrittenLink {
  /** The destination as the file wrote it, angle brackets included, so it stays a destination wherever it lands. */
  written: string;
  hash: string;
  suffix: string;
}

interface LinkedFile {
  /** SHA-256 of the content, lowercase hex. */
  hash: string;
  size: number;
  /** An LFS pointer that names LFS extensions: its object cannot be read. */
  extensions: boolean;
}

/** A document the uploads would leave out, found before anything is uploaded. */
export interface UploadLeaveOut {
  path: string;
  rule: string;
  /** The linked files that cause it, in the order the document first links them. */
  files: string[];
}

/**
 * The documents of the plan that the uploads would leave out, for the dry
 * run, judged as the write judges them (`judgeLinkedFiles`) and in its
 * order, by path: a linked file over the upload limit (`upload-too-large`),
 * or an LFS object with LFS extensions (`upload-unreadable`) whose content
 * is neither in the upload cache nor uploaded by an earlier document.
 * Nothing is uploaded or downloaded: a file in LFS is judged by its pointer,
 * which gives its size and hash. An LFS object missing from the remote is
 * found only when the run reads it.
 *
 * @param texts the text of each planned document, by path
 * @param uploads the upload cache the run starts from
 */
export async function predictUploadLeaveOuts(
  git: Git,
  tracked: Oid,
  plan: InitialSyncPlan,
  texts: ReadonlyMap<string, string>,
  uploads: UploadMap,
  options: { limit?: number } = {},
): Promise<UploadLeaveOut[]> {
  const limit = options.limit ?? DEFAULT_UPLOAD_LIMIT;
  const { files } = await treeFiles(git, tracked);
  const planned = plannedLinks(plan, files, texts);
  const targets = [...planned.values()].flat();
  const linked = new Map<string, LinkedFile>();
  // Only a blob small enough to be a pointer is read: every other file's size is in the tree.
  await hashLinkedFiles(git, files, linked, targets, MAX_POINTER_SIZE);
  const uploaded = new Set(uploads.keys());
  const file = (target: string) => linked.get(target) as LinkedFile;
  if (targets.some((target) => file(target).extensions && !uploaded.has(file(target).hash))) {
    // Whether an earlier document uploads the same content needs the hash of every file the run would upload.
    for (const target of targets) if (file(target).hash === '' && file(target).size <= limit) linked.delete(target);
    await hashLinkedFiles(git, files, linked, targets, Math.max(limit, MAX_POINTER_SIZE));
  }
  const result: UploadLeaveOut[] = [];
  for (const path of [...planned.keys()].sort(compare)) {
    const own = planned.get(path) as string[];
    const leaveOut = judgeLinkedFiles(own, linked, limit, uploaded);
    if (leaveOut !== null) result.push({ path, rule: leaveOut.rule, files: leaveOut.files });
    else for (const target of own) uploaded.add(file(target).hash);
  }
  return result;
}

/**
 * Why the write leaves out a document that links `targets` (each once, in
 * link order), or null: every file's size is checked first, so a file over
 * the limit is reported before one that cannot be read; then an LFS object
 * with LFS extensions whose content the upload cache does not hold.
 */
function judgeLinkedFiles(
  targets: readonly string[],
  linked: ReadonlyMap<string, LinkedFile>,
  limit: number,
  uploaded: { has(hash: string): boolean },
): { rule: string; files: string[]; message: string } | null {
  const file = (target: string) => linked.get(target) as LinkedFile;
  const oversize = targets.filter((target) => file(target).size > limit);
  if (oversize.length > 0) return { rule: UPLOAD_TOO_LARGE, files: oversize, message: `${oversize.join(', ')}: over the upload limit of ${limit} bytes` };
  const unreadable = targets.filter((target) => file(target).extensions && !uploaded.has(file(target).hash));
  if (unreadable.length > 0) {
    return { rule: UPLOAD_UNREADABLE, files: unreadable, message: `${unreadable.join(', ')}: stored with LFS extensions, which are not supported` };
  }
  return null;
}

/** The tracked tree's regular files, by path: Markdown files, and the others, which documents may link. */
async function treeFiles(git: Git, tracked: Oid): Promise<{ files: Map<string, TreeEntry>; markdown: Map<string, TreeEntry> }> {
  const files = new Map<string, TreeEntry>();
  const markdown = new Map<string, TreeEntry>();
  for (const entry of await listTree(git, tracked)) {
    if (entry.type !== 'blob' || entry.mode === '120000') continue;
    if (entry.path.endsWith(MARKDOWN_EXTENSION)) markdown.set(entry.path, entry);
    else files.set(entry.path, entry);
  }
  return { files, markdown };
}

/** The files each document the plan creates or overwrites links (each once, in link order), from its text; documents without text or links are absent. */
function plannedLinks(plan: InitialSyncPlan, files: ReadonlyMap<string, TreeEntry>, texts: ReadonlyMap<string, string>): Map<string, string[]> {
  const isFile = (path: string) => files.has(path);
  const planned = new Map<string, string[]>();
  for (const { path } of [...plan.create, ...plan.overwrite]) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const targets = [...new Set(findFileLinks(path, splitFile(text).body, isFile).map((link) => link.target))];
    if (targets.length > 0) planned.set(path, targets);
  }
  return planned;
}

/**
 * Hashes linked files into `linked`: an LFS file by its pointer, without
 * downloading it; another by its bytes. A blob over `readUpTo` bytes is not
 * read: only its size is known, and its hash is empty.
 */
async function hashLinkedFiles(git: Git, files: ReadonlyMap<string, TreeEntry>, linked: Map<string, LinkedFile>, paths: readonly string[], readUpTo: number): Promise<void> {
  const toRead: TreeEntry[] = [];
  for (const path of new Set(paths)) {
    if (linked.has(path)) continue;
    const entry = files.get(path) as TreeEntry;
    if (entry.size !== null && entry.size > readUpTo) linked.set(path, { hash: '', size: entry.size, extensions: false });
    else toRead.push(entry);
  }
  let index = 0;
  while (index < toRead.length) {
    // Batches bounded by bytes, so many large files are never held at once.
    const batch: TreeEntry[] = [];
    let bytes = 0;
    while (index < toRead.length && (batch.length === 0 || bytes + ((toRead[index] as TreeEntry).size ?? 0) <= HASH_BATCH_BYTES)) {
      const entry = toRead[index] as TreeEntry;
      batch.push(entry);
      bytes += entry.size ?? 0;
      index += 1;
    }
    const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
    for (const entry of batch) {
      const blob = blobs.get(entry.oid) as Buffer;
      const pointer = parseLfsPointer(blob);
      linked.set(
        entry.path,
        pointer !== null ? { hash: pointer.oid, size: pointer.size, extensions: pointer.extensions } : { hash: sha256(blob), size: blob.length, extensions: false },
      );
    }
  }
}

/** The transform that uploads linked files and writes their URLs into the document. */
export function uploadsTransform(options: UploadsOptions): BodyTransform {
  const limit = options.limit ?? DEFAULT_UPLOAD_LIMIT;
  let context: TransformContext | undefined;
  /** The tracked tree's regular files that are not Markdown, by path. */
  const files = new Map<string, TreeEntry>();
  const linked = new Map<string, LinkedFile>();
  /** For each document, its file links in order: what each destination said and the file's hash. */
  const links = new Map<string, WrittenLink[]>();
  /** The files each document to be written links, from the tracked text, and those documents in write order. */
  const planned = new Map<string, string[]>();
  const order: string[] = [];
  /** Reads LFS objects; made on the first one needed. */
  let lfs: LfsRead | undefined;

  const isFile = (path: string) => files.has(path);
  // A blob over the limit is too large to be a pointer and is never read: only its size matters, since its document is left out.
  const hashFiles = (git: Git, paths: readonly string[]) => hashLinkedFiles(git, files, linked, paths, Math.max(limit, MAX_POINTER_SIZE));

  /** The files of `targets` not in the cache, one path per content hash. */
  const missing = (targets: Iterable<string>): Map<string, string> => {
    const { uploads } = context as TransformContext;
    const byHash = new Map<string, string>();
    for (const target of targets) {
      const { hash } = linked.get(target) as LinkedFile;
      if (!uploads.has(hash) && !byHash.has(hash)) byHash.set(hash, target);
    }
    return byHash;
  };

  /** Reads files by hash, from LFS when they are stored there; an unreadable one gets its reason. */
  const readContents = async (byHash: ReadonlyMap<string, string>): Promise<Map<string, Buffer | { unreadable: string }>> => {
    const { git } = context as TransformContext;
    const blobs = await readBlobs(git, [...byHash.values()].map((target) => (files.get(target) as TreeEntry).oid));
    const contents = new Map<string, Buffer | { unreadable: string }>();
    for (const [hash, target] of byHash) {
      const blob = blobs.get((files.get(target) as TreeEntry).oid) as Buffer;
      const pointer = parseLfsPointer(blob);
      if (pointer === null) {
        contents.set(hash, blob);
        continue;
      }
      lfs ??= await lfsReader(git, options.config.remote);
      const read = await lfs(pointer, target);
      contents.set(hash, read.ok ? read.content : { unreadable: read.reason });
    }
    return contents;
  };

  /** Uploads files with one API request and caches their URLs. */
  const uploadAll = async (items: ReadonlyArray<{ hash: string; target: string; content: Buffer }>) => {
    const { linear, uploads } = context as TransformContext;
    const inputs = items.map(({ target, content }) => ({
      filename: posix.basename(target),
      contentType: contentTypeOf(target),
      // A copy, so the bytes sent are a whole ArrayBuffer of their own, as the client's type requires.
      bytes: new Uint8Array(content),
    }));
    const results = await linear.uploadFiles(inputs);
    items.forEach(({ hash }, index) => uploads.set(hash, (results[index] as { assetUrl: string }).assetUrl));
  };

  type Upload = { hash: string; target: string; content: Buffer };

  /** A document's files not in the cache and not already in `batch`, read; null when one cannot be read. */
  const readDocumentFiles = async (targets: readonly string[], batch: readonly Upload[]): Promise<Upload[] | { unreadable: string; target: string }> => {
    const taken = new Set(batch.map((item) => item.hash));
    const byHash = new Map([...missing(targets)].filter(([hash]) => !taken.has(hash)));
    if (byHash.size === 0) return [];
    const contents = await readContents(byHash);
    const result: Upload[] = [];
    for (const [hash, target] of byHash) {
      const content = contents.get(hash) as Buffer | { unreadable: string };
      if (!Buffer.isBuffer(content)) return { unreadable: content.unreadable, target };
      result.push({ hash, target, content });
    }
    return result;
  };

  /**
   * Uploads a document's files not in the cache, with one API request that
   * also carries the missing files of the documents written next (up to
   * UPLOAD_BATCH_FILES files and UPLOAD_BATCH_BYTES), so the run spends far
   * fewer requests than one per file: the budget is 1.5 requests per written
   * document. The uploads land between writes, so the run's progress pushes
   * record them as it goes. A later document joins the batch only when it is
   * within the limit and all its files can be read. When the batch fails for
   * a reason other than a stop, the document's own files are sent alone, so
   * another document's file never fails this one.
   */
  const uploadMissing = async (path: string, targets: readonly string[]) => {
    const own = await readDocumentFiles(targets, []);
    if (!Array.isArray(own)) throw new LeaveOutError(UPLOAD_UNREADABLE, `${own.target} cannot be read: ${own.unreadable}`, [own.target]);
    if (own.length === 0) return;

    const batch = [...own];
    let bytes = batch.reduce((sum, item) => sum + item.content.length, 0);
    const position = order.indexOf(path);
    for (const next of position === -1 ? [] : order.slice(position + 1)) {
      if (batch.length >= UPLOAD_BATCH_FILES) break;
      const nextTargets = planned.get(next) as string[];
      await hashFiles((context as TransformContext).git, nextTargets);
      if (nextTargets.some((target) => (linked.get(target) as LinkedFile).size > limit)) continue;
      const pending = [...missing(nextTargets)].filter(([hash]) => !batch.some((item) => item.hash === hash));
      const pendingBytes = pending.reduce((sum, [, target]) => sum + (linked.get(target) as LinkedFile).size, 0);
      if (pending.length === 0) continue;
      if (batch.length + pending.length > UPLOAD_BATCH_FILES || bytes + pendingBytes > UPLOAD_BATCH_BYTES) break;
      const files = await readDocumentFiles(nextTargets, batch);
      if (!Array.isArray(files)) continue;
      batch.push(...files);
      bytes += pendingBytes;
    }

    try {
      await uploadAll(batch);
    } catch (error) {
      if (batch.length === own.length || !(error instanceof LinearError) || error instanceof LinearStoppedError) throw error;
      await uploadAll(own);
    }
  };

  return {
    name: 'uploads',

    async prepare(ctx) {
      context = ctx;
      const tree = await treeFiles(ctx.git, ctx.tracked);
      for (const [path, entry] of tree.files) files.set(path, entry);
      const paths = [...ctx.plan.create, ...ctx.plan.overwrite].map((entry) => entry.path).filter((path) => tree.markdown.has(path));
      const blobs = await readBlobs(ctx.git, paths.map((path) => (tree.markdown.get(path) as TreeEntry).oid));
      const texts = new Map<string, string>();
      for (const path of paths) {
        const blob = blobs.get((tree.markdown.get(path) as TreeEntry).oid) as Buffer;
        // A Markdown file stored in LFS links nothing.
        if (parseLfsPointer(blob) === null) texts.set(path, blob.toString('utf8'));
      }
      // The files each document to be written links, in the run's write order (by path), for the look-ahead batches.
      for (const [path, targets] of plannedLinks(ctx.plan, files, texts)) planned.set(path, targets);
      order.push(...[...planned.keys()].sort(compare));
    },

    async apply({ path, body }) {
      if (context === undefined) throw new Error('the uploads transform was not prepared');
      const fileLinks = findFileLinks(path, body, isFile);
      if (fileLinks.length === 0) return body;
      const targets = [...new Set(fileLinks.map((link) => link.target))];
      await hashFiles(context.git, targets);

      // Check every file first, so a document left out uploads nothing.
      const leaveOut = judgeLinkedFiles(targets, linked, limit, context.uploads);
      if (leaveOut !== null) throw new LeaveOutError(leaveOut.rule, leaveOut.message, leaveOut.files);
      await uploadMissing(path, targets);
      const { uploads } = context;
      const urls = fileLinks.map((link) => uploads.get((linked.get(link.target) as LinkedFile).hash) as string);
      links.set(path, fileLinks.map((link) => ({ written: link.written, hash: (linked.get(link.target) as LinkedFile).hash, suffix: link.suffix })));
      return replaceRanges(body, fileLinks.map((link, index) => ({ from: link.from, to: link.to, text: (urls[index] as string) + link.suffix })));
    },

    restore({ path, body }) {
      const fileLinks = links.get(path);
      if (fileLinks === undefined || context === undefined) return body;
      return restoreFileLinks(body, fileLinks, context.uploads);
    },
  };
}

/**
 * Puts back the destination each written link had in the tracked file. Only
 * link, image and definition destinations equal to an upload URL (with the
 * link's query and fragment) are touched; the same URL in code or prose
 * stays. The n-th such destination of a file gets the n-th spelling written
 * for it, so two spellings of one link come back as they were. The whole
 * destination is replaced, angle brackets included, so a spelling that needs
 * them (a space) keeps them when Linear dropped them around the URL.
 */
export function restoreFileLinks(body: string, written: readonly WrittenLink[], uploads: UploadMap): string {
  const raws = new Map<string, string[]>();
  for (const link of written) {
    const url = uploads.get(link.hash);
    if (url === undefined) continue;
    const key = url + link.suffix;
    raws.set(key, [...(raws.get(key) ?? []), link.written]);
  }
  if (raws.size === 0) return body;
  const seen = new Map<string, number>();
  const replacements: Array<{ from: number; to: number; text: string }> = [];
  for (const { node, outer } of destinations(body)) {
    const list = raws.get(node.url);
    if (list === undefined) continue;
    const index = seen.get(node.url) ?? 0;
    seen.set(node.url, index + 1);
    replacements.push({ ...outer, text: list[Math.min(index, list.length - 1)] as string });
  }
  return replaceRanges(body, replacements);
}

/** Links, images and link definitions in `body` whose destination is a file of the repository. */
export function findFileLinks(documentPath: string, body: string, isFile: (path: string) => boolean): FileLink[] {
  const result: FileLink[] = [];
  for (const { node, range, outer } of destinations(body)) {
    const target = resolveTarget(documentPath, node.url);
    if (target === null || !isFile(target)) continue;
    const cut = node.url.search(/[?#]/);
    result.push({ ...range, written: body.slice(outer.from, outer.to), target, suffix: cut === -1 ? '' : node.url.slice(cut) });
  }
  return result;
}

type DestinationNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>;

type Range = { from: number; to: number };

/**
 * Every link, image and definition with the place of its destination's text,
 * without (`range`) and with (`outer`) its angle brackets, in document order.
 */
function destinations(body: string): Array<{ node: DestinationNode; range: Range; outer: Range }> {
  const result: Array<{ node: DestinationNode; range: Range; outer: Range }> = [];
  visit(parse(body), (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const found = destinationRange(body, node);
    if (found !== null) result.push({ node, range: { from: found.from, to: found.to }, outer: { from: found.outerFrom, to: found.outerTo } });
  });
  return result.sort((a, b) => a.range.from - b.range.from);
}

/** Replaces non-overlapping ranges of `text`. */
function replaceRanges(text: string, replacements: ReadonlyArray<{ from: number; to: number; text: string }>): string {
  let result = text;
  for (const replacement of [...replacements].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, replacement.from) + replacement.text + result.slice(replacement.to);
  }
  return result;
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

/**
 * Where the destination's text is in a link, image or definition node,
 * without and with its angle brackets. Each `](` (or `]:`) in the node is tried in turn,
 * and a candidate counts only when the parser reads it as the node's own
 * destination, escapes and character references included; so brackets in
 * the link text or alt text cannot misplace it. Null when none matches
 * (a reference link, whose destination is in its definition).
 */
function destinationRange(body: string, node: DestinationNode): { from: number; to: number; outerFrom: number; outerTo: number } | null {
  const nodeEnd = end(node);
  const opener = node.type === 'definition' ? ']:' : '](';
  let found: { from: number; to: number; outerFrom: number; outerTo: number } | null = null;
  for (let at = body.indexOf(opener, start(node)); at !== -1 && at < nodeEnd; at = body.indexOf(opener, at + 1)) {
    const range = destinationAt(body, at + 2, nodeEnd);
    if (range === null || parsedDestination(body.slice(range.outerFrom, range.outerTo)) !== node.url) continue;
    // A definition's label holds no `]:`, so its first match is its destination. A link's or
    // image's text comes before its destination and may hold a link to the same file, so the
    // last match is the node's own.
    found = range;
    if (node.type === 'definition') break;
  }
  return found;
}

/** The destination text starting at `position` (after optional spaces), with and without angle brackets. */
function destinationAt(body: string, position: number, limit: number): { from: number; to: number; outerFrom: number; outerTo: number } | null {
  while (position < limit && /[ \t\r\n]/.test(body[position] as string)) position += 1;
  if (body[position] === '<') {
    const close = body.indexOf('>', position + 1);
    return close === -1 || close > limit ? null : { from: position + 1, to: close, outerFrom: position, outerTo: close + 1 };
  }
  const from = position;
  let depth = 0;
  while (position < limit) {
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
  const to = Math.min(position, limit);
  return to > from ? { from, to, outerFrom: from, outerTo: to } : null;
}

/** The URL the parser reads from a destination's text. */
function parsedDestination(destination: string): string | undefined {
  const paragraph = parse(`[x](${destination})`).children[0];
  const link = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
  return link?.type === 'link' ? link.url : undefined;
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
