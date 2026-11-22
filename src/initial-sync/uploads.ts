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
// lists those documents without uploading or downloading anything.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Nodes } from 'mdast';
import type { Handle } from 'mdast-util-from-markdown';
import { imageDestination, linkDestination } from '../format/fix.ts';
import { parse, resolveTarget, splitFile, visit } from '../format/markdown.ts';
import { LinearError, LinearStoppedError } from '../linear/index.ts';
import { MARKDOWN_EXTENSION, isRegularFile } from '../mapping/index.ts';
import {
  type Git,
  type Oid,
  type StateConfig,
  type TreeEntry,
  type UploadMap,
  listTree,
  missingLfsObjects,
  parseLfsPointer,
  readBlobs,
  type LfsRead,
  lfsReader,
  lfsRemote,
} from '../state/index.ts';
import { type InitialSyncPlan } from './plan.ts';
import { type BodyTransform, LeaveOutError, type TransformContext } from './transform.ts';
import { message } from '../messages.ts';
import { type LeftOutAtWriteRule } from '../codes.ts';

export { resolveTarget };

/** Linear's upload limit on the free plan: 10 MB. A larger file leaves its document out. */
export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Rule of a document left out because a file it links is over the upload limit. */
export const UPLOAD_TOO_LARGE = 'upload-too-large' satisfies LeftOutAtWriteRule;
/** Rule of a document left out because a file it links cannot be read (an LFS object that is missing). */
export const UPLOAD_UNREADABLE = 'upload-unreadable' satisfies LeftOutAtWriteRule;
/** Rule of a document Linear holds, left out because it plainly links a repository file and the state that says who wrote the link is lost. */
export const LINK_PROVENANCE_UNKNOWN = 'link-provenance-unknown' satisfies LeftOutAtWriteRule;

/** Bytes of blobs read per git process while hashing linked files. */
const HASH_BATCH_BYTES = 64 * 1024 * 1024;
/** An LFS pointer file is smaller than this (Git LFS spec v1). */
const MAX_POINTER_SIZE = 1024;
/** Maximum count and total bytes of files in one upload request. */
const UPLOAD_BATCH_FILES = 20;
const UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;

export interface UploadsOptions {
  config: StateConfig;
  /** Largest file uploaded, in bytes, up to the upload batch byte limit. */
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
  inTable: boolean;
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
  /** Stored in LFS: the file in git is a pointer, and `hash` and `size` are its object's. */
  lfs: boolean;
  /** An LFS pointer that names LFS extensions: its object cannot be read. */
  extensions: boolean;
  /** An LFS object the remote's LFS server confirmed it does not have. */
  absent: boolean;
}

/** A document the uploads would leave out, found before anything is uploaded. */
export interface UploadLeaveOut {
  path: string;
  rule: LeftOutAtWriteRule;
  /** The linked files that cause it, in the order the document first links them. */
  files: string[];
}

/**
 * The documents of the plan that the uploads would leave out, for the dry
 * run, judged as the write judges them and in its order, by path: a linked
 * file over the upload limit (`upload-too-large`), an LFS object with LFS
 * extensions (`upload-unreadable`, `judgeLinkedFiles`), or then an LFS
 * object the remote does not have (`upload-unreadable`, the first file the
 * upload would read and fail on), whose content is neither in the upload
 * cache nor uploaded by an earlier document. Nothing is uploaded or
 * downloaded: a file in LFS is judged by its pointer, which gives its size
 * and hash, and the remote's LFS server is asked only whether it has the
 * objects (`missingLfsObjects`).
 *
 * @param texts the text of each planned document, by path
 * @param uploads the upload cache the run starts from
 * @param options.remote the remote the run reads LFS objects from
 */
export async function predictUploadLeaveOuts(
  git: Git,
  tracked: Oid,
  plan: InitialSyncPlan,
  texts: ReadonlyMap<string, string>,
  uploads: UploadMap,
  options: { remote: string; limit?: number; plainFiles?: ReadonlyMap<string, ReadonlySet<string>>; unknownProvenance?: ReadonlySet<string> },
): Promise<UploadLeaveOut[]> {
  const { files } = await treeFiles(git, tracked);
  const { planned, unproven } = plannedLinks(plan, files, texts, options.plainFiles, options.unknownProvenance);
  const judged = await predictPlanned(git, files, planned, uploads, { ...options, tracked });
  // The write judges provenance before any file, so its rule comes first.
  const result = [...unproven].map(([path, unprovenFiles]): UploadLeaveOut => ({ path, rule: LINK_PROVENANCE_UNKNOWN, files: unprovenFiles }));
  return [...result, ...judged].sort((a, b) => compare(a.path, b.path));
}

/** `predictUploadLeaveOuts` for the documents whose links the run would upload. */
async function predictPlanned(
  git: Git,
  files: ReadonlyMap<string, TreeEntry>,
  planned: ReadonlyMap<string, string[]>,
  uploads: UploadMap,
  options: { remote: string; tracked: Oid; limit?: number },
): Promise<UploadLeaveOut[]> {
  const limit = Math.min(options.limit ?? DEFAULT_UPLOAD_LIMIT, UPLOAD_BATCH_BYTES);
  // Each file once: several documents may link it.
  const targets = [...new Set([...planned.values()].flat())];
  const linked = new Map<string, LinkedFile>();
  // Only a blob small enough to be a pointer is read: every other file's size is in the tree.
  await hashLinkedFiles(git, files, linked, targets, MAX_POINTER_SIZE);
  const uploaded = new Set(uploads.keys());
  const file = (target: string) => linked.get(target) as LinkedFile;
  // The LFS objects the upload may read: within the limit, without extensions, and not in the cache.
  const asked = targets.filter((target) => file(target).lfs && !file(target).extensions && file(target).size <= limit && !uploaded.has(file(target).hash));
  const absent = await missingLfsObjects(git, { remote: options.remote, tracked: options.tracked }, asked.map((target) => (files.get(target) as TreeEntry).oid));
  for (const target of asked) if (absent.has(file(target).hash)) file(target).absent = true;
  const unreadable = (target: string) => file(target).extensions || file(target).absent;
  if (!targets.some((target) => unreadable(target) && !uploaded.has(file(target).hash))) {
    // Every file the upload reads can be read: only a file over the limit leaves a document out.
    return judgeAll(planned, linked, limit, uploaded);
  }
  // Whether an earlier upload request sends the same content needs the hash of every file the run would upload.
  for (const target of targets) if (file(target).hash === '' && file(target).size <= limit) linked.delete(target);
  await hashLinkedFiles(git, files, linked, targets, Math.max(limit, MAX_POINTER_SIZE));

  const order = [...planned.keys()].sort(compare);
  const result: UploadLeaveOut[] = [];
  for (const [position, path] of order.entries()) {
    const own = planned.get(path) as string[];
    const leaveOut = judgeLinkedFiles(own, linked, limit, uploaded);
    if (leaveOut !== null) {
      result.push({ path, rule: leaveOut.rule, files: leaveOut.files });
      continue;
    }
    const batches = uploadBatches(filesToRead(own, linked, uploaded), linked);
    for (const [index, batch] of batches.entries()) {
      const unread = [...batch.pending.values()].find(unreadable);
      if (unread !== undefined) {
        result.push({ path, rule: UPLOAD_UNREADABLE, files: [unread] });
        break;
      }
      const taken = { hashes: new Set(batch.pending.keys()), bytes: batch.bytes };
      if (index === batches.length - 1) {
        const later = order.slice(position + 1).map((next) => planned.get(next) as string[]);
        await fillBatch(taken, later, linked, limit, uploaded, async () => {}, async (pending) => ![...pending.values()].some(unreadable));
      }
      for (const hash of taken.hashes) uploaded.add(hash);
    }
  }
  return result;
}

/** The documents a file over the limit leaves out, in write order. */
function judgeAll(planned: ReadonlyMap<string, string[]>, linked: ReadonlyMap<string, LinkedFile>, limit: number, uploaded: { has(hash: string): boolean }): UploadLeaveOut[] {
  const result: UploadLeaveOut[] = [];
  for (const path of [...planned.keys()].sort(compare)) {
    const leaveOut = judgeLinkedFiles(planned.get(path) as string[], linked, limit, uploaded);
    if (leaveOut !== null) result.push({ path, rule: leaveOut.rule, files: leaveOut.files });
  }
  return result;
}

/**
 * Adds to an upload request (`batch`, the content hashes it sends and their
 * size) the files of the documents written after its own (`later`, each
 * document's linked files, in write order), so the run spends far fewer
 * requests than one per file: up to UPLOAD_BATCH_FILES files and
 * UPLOAD_BATCH_BYTES. A later document joins when none of its files is over
 * the limit, it has files that neither `uploaded` nor the batch holds, they
 * fit, and `read` can read them all (it gets them by hash); a document that
 * does not fit ends the request.
 *
 * @param prepare called with a document's files before they are judged, to hash them
 */
async function fillBatch(
  batch: { hashes: Set<string>; bytes: number },
  later: Iterable<readonly string[]>,
  linked: ReadonlyMap<string, LinkedFile>,
  limit: number,
  uploaded: { has(hash: string): boolean },
  prepare: (targets: readonly string[]) => Promise<void>,
  read: (pending: ReadonlyMap<string, string>) => Promise<boolean>,
): Promise<void> {
  const file = (target: string) => linked.get(target) as LinkedFile;
  for (const targets of later) {
    if (batch.hashes.size >= UPLOAD_BATCH_FILES) break;
    await prepare(targets);
    if (targets.some((target) => file(target).size > limit)) continue;
    const pending = new Map([...filesToRead(targets, linked, uploaded)].filter(([hash]) => !batch.hashes.has(hash)));
    if (pending.size === 0) continue;
    const pendingBytes = [...pending.values()].reduce((sum, target) => sum + uploadBytes(file(target)), 0);
    if (batch.hashes.size + pending.size > UPLOAD_BATCH_FILES || batch.bytes + pendingBytes > UPLOAD_BATCH_BYTES) break;
    if (!(await read(pending))) continue;
    for (const hash of pending.keys()) batch.hashes.add(hash);
    batch.bytes += pendingBytes;
  }
}

/**
 * Why the write leaves out a document that links `targets` (each once, in
 * link order), or null: every file's size is checked first, so a file over
 * the limit is reported before one that cannot be read; then an LFS object
 * with LFS extensions whose content neither the upload cache holds nor
 * another file of the document provides (the upload sends that file).
 */
function judgeLinkedFiles(
  targets: readonly string[],
  linked: ReadonlyMap<string, LinkedFile>,
  limit: number,
  uploaded: { has(hash: string): boolean },
): { rule: LeftOutAtWriteRule; files: string[]; message: string } | null {
  const file = (target: string) => linked.get(target) as LinkedFile;
  const oversize = targets.filter((target) => file(target).size > limit);
  if (oversize.length > 0) return { rule: UPLOAD_TOO_LARGE, files: oversize, message: message('initial-sync.over-upload-limit', { files: oversize.join(', '), limit }) };
  const readable = new Set(targets.filter((target) => !file(target).extensions).map((target) => file(target).hash));
  const unreadable = targets.filter((target) => file(target).extensions && !uploaded.has(file(target).hash) && !readable.has(file(target).hash));
  if (unreadable.length > 0) {
    return { rule: UPLOAD_UNREADABLE, files: unreadable, message: message('initial-sync.lfs-extensions', { files: unreadable.join(', ') }) };
  }
  return null;
}

/**
 * The files of `targets` the upload reads, in order: those whose content is
 * not in `uploaded`, one path per content hash, a readable one when the
 * content has one (an LFS pointer with LFS extensions is not).
 */
function filesToRead(targets: Iterable<string>, linked: ReadonlyMap<string, LinkedFile>, uploaded: { has(hash: string): boolean }): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const target of targets) {
    const { hash, extensions } = linked.get(target) as LinkedFile;
    if (uploaded.has(hash)) continue;
    const chosen = byHash.get(hash);
    if (chosen === undefined || ((linked.get(chosen) as LinkedFile).extensions && !extensions)) byHash.set(hash, target);
  }
  return byHash;
}

/** Account for both the Git blob read and the file sent to storage. */
function uploadBytes(file: LinkedFile): number {
  return file.lfs ? Math.max(file.size, MAX_POINTER_SIZE) : file.size;
}

/** Partitions a document's uncached files in link order, after checking each file's limit. */
function uploadBatches(files: ReadonlyMap<string, string>, linked: ReadonlyMap<string, LinkedFile>) {
  const batches: { pending: Map<string, string>; bytes: number }[] = [];
  let batch = { pending: new Map<string, string>(), bytes: 0 };
  for (const [hash, target] of files) {
    const bytes = uploadBytes(linked.get(target) as LinkedFile);
    if (batch.pending.size === UPLOAD_BATCH_FILES || batch.bytes + bytes > UPLOAD_BATCH_BYTES) {
      batches.push(batch);
      batch = { pending: new Map(), bytes: 0 };
    }
    batch.pending.set(hash, target);
    batch.bytes += bytes;
  }
  if (batch.pending.size > 0) batches.push(batch);
  return batches;
}

/** The tracked tree's regular files, by path: Markdown files, and the others, which documents may link. */
async function treeFiles(git: Git, tracked: Oid): Promise<{ files: Map<string, TreeEntry>; markdown: Map<string, TreeEntry> }> {
  const files = new Map<string, TreeEntry>();
  const markdown = new Map<string, TreeEntry>();
  for (const entry of await listTree(git, tracked)) {
    if (!isRegularFile(entry)) continue;
    if (entry.path.endsWith(MARKDOWN_EXTENSION)) markdown.set(entry.path, entry);
    else files.set(entry.path, entry);
  }
  return { files, markdown };
}

/**
 * The files each document the plan creates or overwrites links (each once, in
 * link order), from its text; documents without text or links are absent. A
 * document the write leaves out for unknown provenance is in `unproven`
 * instead, with the files that cause it, so no batch uploads its files.
 */
function plannedLinks(
  plan: InitialSyncPlan,
  files: ReadonlyMap<string, TreeEntry>,
  texts: ReadonlyMap<string, string>,
  plainFiles?: ReadonlyMap<string, ReadonlySet<string>>,
  unknownProvenance?: ReadonlySet<string>,
): { planned: Map<string, string[]>; unproven: Map<string, string[]> } {
  const isFile = (path: string) => files.has(path);
  const planned = new Map<string, string[]>();
  const unproven = new Map<string, string[]>();
  for (const { path } of [...plan.create, ...plan.overwrite]) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const links = uploadableLinks(path, splitFile(text).body, isFile, plainFiles?.get(path), unknownProvenance?.has(path) === true);
    if (links.unproven.length > 0) {
      unproven.set(path, links.unproven);
      continue;
    }
    const targets = [...new Set(links.links.map((link) => link.target))];
    if (targets.length > 0) planned.set(path, targets);
  }
  return { planned, unproven };
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
    if (entry.size !== null && entry.size > readUpTo) linked.set(path, { hash: '', size: entry.size, lfs: false, extensions: false, absent: false });
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
        pointer !== null
          ? { hash: pointer.oid, size: pointer.size, lfs: true, extensions: pointer.extensions, absent: false }
          : { hash: sha256(blob), size: blob.length, lfs: false, extensions: false, absent: false },
      );
    }
  }
}

/** The transform that uploads linked files and writes their URLs into the document. */
export function uploadsTransform(options: UploadsOptions): BodyTransform {
  const limit = Math.min(options.limit ?? DEFAULT_UPLOAD_LIMIT, UPLOAD_BATCH_BYTES);
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
      lfs ??= await lfsReader(git, lfsRemote(options.config));
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
      bytes: content.buffer instanceof ArrayBuffer
        ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
        : new Uint8Array(content),
    }));
    const results = await linear.uploadFiles(inputs);
    items.forEach(({ hash }, index) => uploads.set(hash, (results[index] as { assetUrl: string }).assetUrl));
  };

  type Upload = { hash: string; target: string; content: Buffer };

  /** Files to upload, by hash, read; the first that cannot be read instead. */
  const readFiles = async (byHash: ReadonlyMap<string, string>): Promise<Upload[] | { unreadable: string; target: string }> => {
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
   * Reads and uploads one bounded batch at a time, caching each response.
   * The last batch also carries missing files of the documents written
   * next, saving requests. A later document joins the batch as `fillBatch`
   * says: only when it is within the limit and all its files can be read,
   * which the dry run predicts the same way. When the batch fails for
   * a reason other than a stop, the document's own files are sent alone, so
   * another document's file never fails this one.
   */
  const uploadMissing = async (path: string, targets: readonly string[]) => {
    const { git, linear, uploads } = context as TransformContext;
    const batches = uploadBatches(filesToRead(targets, linked, uploads), linked);
    for (const [index, batch] of batches.entries()) {
      if (linear.stopped !== undefined) throw new LinearStoppedError('FileUploads', linear.stopped);
      const own = await readFiles(batch.pending);
      if (!Array.isArray(own)) {
        // A failed read alone can be transient. Only the batch API's 404/410 confirms that the remote lacks it.
        const entry = files.get(own.target) as TreeEntry;
        const file = linked.get(own.target) as LinkedFile;
        if (!file.absent) file.absent = (await missingLfsObjects(git, lfsRemote(options.config), [entry.oid])).has(file.hash);
        throw new LeaveOutError(UPLOAD_UNREADABLE, message('initial-sync.upload-unreadable', { file: own.target, reason: own.unreadable }), [own.target], { missingLfsObject: file.absent });
      }
      if (index === batches.length - 1) await uploadLastBatch(path, own, batch.bytes);
      else await uploadAll(own);
    }
  };

  const uploadLastBatch = async (path: string, own: Upload[], bytes: number) => {
    const { git, uploads } = context as TransformContext;
    const batch = [...own];
    const position = order.indexOf(path);
    const later = (position === -1 ? [] : order.slice(position + 1)).map((next) => planned.get(next) as string[]);
    const taken = { hashes: new Set(own.map((item) => item.hash)), bytes };
    await fillBatch(taken, later, linked, limit, uploads, (next) => hashFiles(git, next), async (pending) => {
      const files = await readFiles(pending);
      if (!Array.isArray(files)) return false;
      batch.push(...files);
      return true;
    });

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
      for (const [path, targets] of plannedLinks(ctx.plan, files, texts, ctx.plainFiles, ctx.unknownProvenance).planned) planned.set(path, targets);
      order.push(...[...planned.keys()].sort(compare));
    },

    async apply({ path, body }) {
      if (context === undefined) throw new Error(message('initial-sync.uploads-not-prepared'));
      const uploadable = uploadableLinks(path, body, isFile, context.plainFiles?.get(path), context.unknownProvenance?.has(path) === true);
      if (uploadable.unproven.length > 0) {
        throw new LeaveOutError(LINK_PROVENANCE_UNKNOWN, message('initial-sync.link-provenance-unknown', { files: uploadable.unproven.join(', ') }), uploadable.unproven);
      }
      const fileLinks = uploadable.links;
      if (fileLinks.length === 0) return body;
      const targets = [...new Set(fileLinks.map((link) => link.target))];
      await hashFiles(context.git, targets);

      // Check every file for size and LFS extensions before uploading.
      const leaveOut = judgeLinkedFiles(targets, linked, limit, context.uploads);
      if (leaveOut !== null) throw new LeaveOutError(leaveOut.rule, leaveOut.message, leaveOut.files);
      await uploadMissing(path, targets);
      const { uploads } = context;
      const urls = fileLinks.map((link) => uploads.get((linked.get(link.target) as LinkedFile).hash) as string);
      links.set(path, fileLinks.map((link) => ({ written: link.written, hash: (linked.get(link.target) as LinkedFile).hash, suffix: link.suffix })));
      return replaceRanges(body, fileLinks.map((link, index) => {
        const url = withUploadSuffix(urls[index] as string, link.suffix);
        const bracketed = link.written.startsWith('<');
        const text = bracketed || /[()\\]/.test(url) ? linkDestination(url) : imageDestination(url);
        return {
          from: link.from - Number(bracketed),
          to: link.to + Number(bracketed),
          text: link.inTable ? text.replaceAll('|', '&#124;') : text,
        };
      }));
    },

    restore({ path, body }) {
      const fileLinks = links.get(path);
      if (fileLinks === undefined || context === undefined) return body;
      return restoreFileLinks(body, fileLinks, context.uploads);
    },
  };
}

/** Encode URL characters that a Markdown parser might strip or treat as delimiters. */
export function uploadDestinationUrl(url: string): string {
  return url.replace(/[\s<>\x00-\x1f\x7f]/gu, (character) => encodeURIComponent(character));
}

/** Preserve the query on a captured upload when the repository link carries the same query. */
export function withUploadSuffix(url: string, suffix: string): string {
  const destination = uploadDestinationUrl(url);
  if (suffix === '') return destination;
  const base = destination.split('#')[0]!;
  const trailing = uploadDestinationUrl(suffix);
  const searchAt = base.indexOf('?');
  if (!trailing.startsWith('?') || searchAt === -1) return base + trailing;
  const search = trailing.split('#')[0]!;
  if (base.slice(searchAt) === search) return base + trailing.slice(search.length);
  return base + '&' + trailing.slice(1);
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
    const key = withUploadSuffix(url, link.suffix);
    const list = raws.get(key);
    if (list === undefined) raws.set(key, [link.written]);
    else list.push(link.written);
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

/**
 * The repository-file links of a document the run may upload. A repaired
 * path is a plain link: only a repository-authored image can authorize its
 * upload. When the document's provenance is unknown, every other non-image
 * link is `unproven` (each target once): it may be a Linear member's.
 */
function uploadableLinks(path: string, body: string, isFile: (path: string) => boolean, plain?: ReadonlySet<string>, unknown = false): { links: FileLink[]; unproven: string[] } {
  const links = findFileLinks(path, body, isFile);
  if (links.length === 0 || ((plain === undefined || plain.size === 0) && !unknown)) return { links, unproven: [] };
  const imageUrls = new Set<string>();
  const labels = new Set<string>();
  const definitions = new Map<string, string>();
  visit(parse(body), node => {
    if (node.type === 'image') imageUrls.add(node.url);
    if (node.type === 'imageReference') labels.add(node.identifier);
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  for (const label of labels) { const url = definitions.get(label); if (url !== undefined) imageUrls.add(url); }
  const images = new Set([...imageUrls].flatMap(url => { const target = resolveTarget(path, url); return target === null ? [] : [target]; }));
  const kept = links.filter(link => plain?.has(link.target) !== true || images.has(link.target));
  return { links: kept, unproven: unknown ? [...new Set(kept.filter(link => !images.has(link.target)).map(link => link.target))] : [] };
}

/** Links, images and link definitions in `body` whose destination is a file of the repository. */
export function findFileLinks(documentPath: string, body: string, isFile: (path: string) => boolean): FileLink[] {
  const result: FileLink[] = [];
  for (const { node, range, outer, inTable } of destinations(body)) {
    const target = resolveTarget(documentPath, node.url);
    if (target === null || !isFile(target)) continue;
    const cut = node.url.search(/[?#]/);
    result.push({ ...range, written: body.slice(outer.from, outer.to), target, suffix: cut === -1 ? '' : node.url.slice(cut), inTable });
  }
  return result;
}

type DestinationNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>;

type Range = { from: number; to: number };

/**
 * Explicit link, image and definition destinations, without (`range`) and
 * with (`outer`) their angle brackets, in document order. Reference uses,
 * autolinks and empty destinations without brackets have no range of their own.
 */
export function destinations(body: string): Array<{ node: DestinationNode; range: Range; outer: Range; inTable: boolean }> {
  const result: Array<{ node: DestinationNode; range: Range; outer: Range; inTable: boolean }> = [];
  const ranges = new Map<DestinationNode, { range: Range; outer: Range }>();
  // The parser skips one leading BOM before counting source offsets.
  const offset = body.startsWith('\uFEFF') ? 1 : 0;
  // These tokens belong to the current link, image or definition. Taking their
  // positions during the document parse avoids searching or reparsing labels.
  const destination: Handle = function (token) {
    const node = this.stack.at(-1);
    if (node?.type !== 'link' && node?.type !== 'image' && node?.type !== 'definition') return;
    const from = token.start.offset + offset;
    const to = token.end.offset + offset;
    const angle = body[from] === '<';
    ranges.set(node, { range: { from: from + Number(angle), to: to - Number(angle) }, outer: { from, to } });
  };
  const tree = parse(body, [{ enter: { resourceDestination: destination, definitionDestination: destination } }]);
  visit(tree, (node, ancestors) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const found = ranges.get(node);
    if (found !== undefined) result.push({ node, ...found, inTable: ancestors.some(parent => parent.type === 'tableCell') });
  });
  return result.sort((a, b) => a.range.from - b.range.from);
}

/** Replaces non-overlapping ranges of `text`. */
export function replaceRanges(text: string, replacements: ReadonlyArray<{ from: number; to: number; text: string }>): string {
  // One pass in text order, joined once: replacing each range in the whole
  // result would copy the text once per replacement.
  const parts: string[] = [];
  let at = 0;
  // An insertion (an empty range) goes before a replacement that starts at the same place.
  for (const replacement of [...replacements].sort((a, b) => a.from - b.from || a.to - b.to)) {
    parts.push(text.slice(at, replacement.from), replacement.text);
    at = replacement.to;
  }
  parts.push(text.slice(at));
  return parts.join('');
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
