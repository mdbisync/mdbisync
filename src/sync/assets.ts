import { ContentSpool, contentBytes, type FileContent, type SpooledFile } from '../state/content.ts';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Definition, Link } from 'mdast';
import { destinations, findFileLinks, resolveTarget } from '../initial-sync/uploads.ts';
import { MARKDOWN_EXTENSION } from '../mapping/index.ts';
import { encodeFragment } from '../initial-sync/links.ts';
import { type LinearReads, uploadReadKey, LinearError, LinearHttpError } from '../linear/index.ts';
import { type Git, type Oid, type UploadMap, readBlobs, listTree, readFiles, parseLfsPointer, type StateConfig } from '../state/index.ts';
import { parse, visit, line } from '../format/markdown.ts';
import { message } from '../messages.ts';
import { imageLinks } from './image-links.ts';
import { ASSETS_FOLDER, admitsCapturedFile, isCaptureName, uploadExtension } from './upload-type.ts';

export interface CapturedAssets {
  body: string;
  /** Localized text as Linear holds it, before pull repairs. */
  observedBody?: string;
  deadUploads?: string[];
  /** Repository targets mentioned by repaired path images, never upload authorizations. */
  plainFiles?: string[];
  files: Map<string, FileContent>;
  uploads: UploadMap;
}

export class AttachmentBudgetError extends Error {
  constructor() { super(message('assets.budget')); }
}
export const ATTACHMENT_LIMITS = Object.freeze({documentCount: 32, documentBytes: 32 * 1024 * 1024, runCount: 256, runBytes: 256 * 1024 * 1024});
const LIMIT = 10 * 1024 * 1024;
/** Whether `url` is on Linear's upload host, the only destination the sync downloads. */
export function isUpload(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.username === '' && parsed.password === '' && parsed.port === ''; }
  catch { return false; }
}

/**
 * Linear's text as the security hooks check it for upload URLs: the text,
 * then every URL the upload cache gains from it, as the cache stores it.
 * The parser decodes escapes and character references, so the stored URL
 * can be spelled differently from the text.
 */
export function withNewUploadUrls(text: string, added: ReadonlyMap<string, string>, cache: ReadonlyMap<string, string>): string {
  const urls = [...new Set([...added].filter(([hash, url]) => cache.get(hash) !== url).map(([, url]) => url))];
  return urls.length === 0 ? text : `${text}\n${urls.join('\n')}\n`;
}

/** Only positions are retained: a finding must never disclose a destination or alt text. */
export interface ImageFinding {
  image: number;
  total: number;
  line: number;
  reason: 'not-uploaded' | 'unsupported-type' | 'unreadable' | 'too-large';
}

export interface FileFinding {
  file: number;
  total: number;
  line: number;
  reason: ImageFinding['reason'];
}

export class ImageBlockedError extends Error {
  readonly findings: Array<ImageFinding | FileFinding>;
  constructor(findings: Array<ImageFinding | FileFinding>) {
    super(message('assets.not-allowed'));
    this.findings = findings;
  }
}

/**
 * Links typed in Linear that name a file of the repository by its relative
 * path (a link or definition). Repaired image paths keep separate plain-link provenance.
 * The sync uploads the file a document's relative link names when it writes
 * the document, so such a link reaching git would let anyone who can edit
 * the document in Linear publish any repository file there. A link to a
 * file the document's previous text already linked was written in the
 * repository and stays; links to Markdown documents upload
 * nothing and stay too.
 */
export function typedFileLinkFindings(path: string, body: string, previousBody?: string, previousPath = path): FileFinding[] {
  const known = new Set<string>();
  if (previousBody !== undefined) {
    visit(parse(previousBody), (node) => {
      if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
      const target = resolveTarget(previousPath, node.url);
      if (target !== null) known.add(target);
    });
  }
  // Only the first definition resolves an image reference and is checked by
  // the image gate. Shadowed definitions still reach the file upload writer.
  const imageLabels = new Set<string>();
  const definitions = new Map<string, Definition>();
  const candidates: Array<Link | Definition> = [];
  visit(parse(body), (node) => {
    if (node.type === 'imageReference') imageLabels.add(node.identifier);
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'link' || node.type === 'definition') candidates.push(node);
  });
  // Validate parsed URLs even when their source ranges cannot be rewritten:
  // formatting can turn a multiline destination into an ordinary file link.
  const links = candidates.filter((node) => {
    if (node.type === 'definition' && imageLabels.has(node.identifier) && definitions.get(node.identifier) === node) return false;
    const target = resolveTarget(path, node.url);
    return target !== null && !target.endsWith(MARKDOWN_EXTENSION);
  });
  const findings: FileFinding[] = [];
  links.forEach((node, index) => {
    if (!known.has(resolveTarget(path, node.url) as string)) findings.push({ file: index + 1, total: links.length, line: line(node), reason: 'not-uploaded' });
  });
  return findings;
}

/**
 * A link's query and fragment (`?a=1&b=2#c`), as the parser decoded them, in
 * a form a bare destination holds: each part percent-encoded on its own, the
 * parentheses too, so the text cannot end the destination and spell another;
 * the query's `&` separators stay.
 */
function encodeSuffix(suffix: string): string {
  const encodePiece = (piece: string) => encodeFragment(piece).replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'));
  // `&` separates query parameters and stays, except where it would start a character reference the parser decodes.
  const encode = (part: string) => part.split('&').map((piece, index) => (index === 0 ? '' : /^#?[A-Za-z0-9]+;/.test(piece) ? '%26' : '&') + encodePiece(piece)).join('');
  const hashAt = suffix.indexOf('#');
  const query = hashAt === -1 ? suffix : suffix.slice(0, hashAt);
  const fragment = hashAt === -1 ? undefined : suffix.slice(hashAt + 1);
  return (query === '' ? '' : `?${encode(query.slice(1))}`) + (fragment === undefined ? '' : `#${encode(fragment)}`);
}

/** Inspect the original Linear text, before localization or any download. */
function imagesOf(body: string): Array<{ url: string; line: number }> {
  const tree = parse(body);
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const images: Array<{ url: string; line: number }> = [];
  visit(tree, (node) => {
    if (node.type === 'image') images.push({url: node.url, line: line(node)});
    else if (node.type === 'imageReference') images.push({url: definitions.get(node.identifier) ?? '', line: line(node)});
  });
  return images;
}

/** A download that can succeed on a later run; never expose the URL or response body. */
export class DownloadRetryError extends Error {
  constructor(cause?: unknown) { super(message('assets.download-failed'), {cause}); }
}

class DownloadBlockedError extends Error {
  readonly reason: 'unreadable' | 'too-large' | 'dead';
  constructor(reason: 'unreadable' | 'too-large' | 'dead') {
    super(message('assets.download-failed'));
    this.reason = reason;
  }
}

/** The caller authenticates the allowed upload host. Redirects cannot forward credentials elsewhere. */
async function download(url: string, fetcher: typeof fetch, reads: LinearReads | undefined, budget: number, consume: (size: number) => void): Promise<{ bytes: Buffer; type: string }> {
  if (!isUpload(url)) throw new Error(message('assets.not-allowed'));
  const key = uploadReadKey(url);
  const kept = reads?.take(key);
  if (kept !== undefined) consume(kept.body.length);
  if (kept !== undefined && kept.body.length > budget) throw new AttachmentBudgetError();
  if (kept !== undefined && kept.body.length <= LIMIT) return { bytes: kept.body, type: kept.type };
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    // Access failures belong to the client, never to an individual document.
    if (response.status !== 200) await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new LinearHttpError('DownloadUpload', response.status);
    if (response.status === 429 || response.status >= 500) throw new DownloadRetryError();
    if (response.status === 404 || response.status === 410) throw new DownloadBlockedError('dead');
    if (response.status !== 200 || response.body === null) throw new DownloadBlockedError('unreadable');
    if (Number(response.headers.get('content-length') ?? 0) > LIMIT) {
      await response.body.cancel().catch(() => {});
      throw new DownloadBlockedError('too-large');
    }
    if (Number(response.headers.get('content-length') ?? 0) > budget) {
      await response.body.cancel().catch(() => {});
      throw new AttachmentBudgetError();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      consume(chunk.length);
      size += chunk.length;
      if (size > LIMIT) throw new DownloadBlockedError('too-large');
      if (size > budget) throw new AttachmentBudgetError();
      chunks.push(Buffer.from(chunk));
    }
    const asset = {bytes: Buffer.concat(chunks), type: response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''};
    reads?.keep(key, { status: response.status, type: asset.type, body: asset.bytes });
    return asset;
  } catch (error) {
    if (error instanceof AttachmentBudgetError || error instanceof LinearError || error instanceof DownloadBlockedError || error instanceof DownloadRetryError) throw error;
    // Fetch failures and interrupted response streams are retried without quoting their messages.
    throw new DownloadRetryError(error);
  }
}

/** One lazily built hash index per capture, read in bounded batches. */
export function createAssetCapture(git: Git, config: StateConfig, base: Oid, fetcher: typeof fetch = fetch, reads?: LinearReads, spool = new ContentSpool(), limits: {documentCount: number; documentBytes: number; runCount: number; runBytes: number} = ATTACHMENT_LIMITS) {
  // Every file of the tree with each content hash, in tree order.
  const hashPaths = new Map<string, string[]>();
  const pathHashes = new Map<string, string>();
  // Every path of the tree that is not a folder: an `assets` entry that is a file or a symbolic link is no folder to write into.
  const notFolders = new Set<string>();
  // Every folder of the tree: a copy never replaces one.
  const folders = new Set<string>();
  // Copies this run chose, by path, as soon as it chose them: two copies must not take one name for different bytes.
  const placed = new Map<string, string>();
  let indexed = false;
  const index = async () => {
    if (indexed) return;
    const tree = await listTree(git, base);
    for (const entry of tree) {
      notFolders.add(entry.path);
      for (let folder = posix.dirname(entry.path); folder !== '.' && !folders.has(folder); folder = posix.dirname(folder)) folders.add(folder);
    }
    // Markdown files are documents the same run may rewrite or remove, never a downloaded file's home.
    const entries = tree.filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && !entry.path.toLowerCase().endsWith('.md'));
    for (let at = 0; at < entries.length;) {
      const batch = [];
      let bytes = 0;
      while (at < entries.length && (batch.length === 0 || bytes + (entries[at]!.size ?? 0) <= 32 * 1024 * 1024)) {
        const entry = entries[at++]!;
        bytes += entry.size ?? 0;
        batch.push(entry);
      }
      const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
      for (const entry of batch) {
        const blob = blobs.get(entry.oid)!;
        const hash = parseLfsPointer(blob)?.oid ?? createHash('sha256').update(blob).digest('hex');
        hashPaths.set(hash, [...hashPaths.get(hash) ?? [], entry.path]);
        pathHashes.set(entry.path, hash);
      }
    }
    indexed = true;
  };
  // A repository file an upload maps to is reused only when readable, and, if a capture named it, when its
  // bytes still pass the upload check: an earlier, weaker check may have admitted them.
  const reuse = new Map<string, 'unreadable' | 'admitted' | 'refused'>();
  const reusable = async (path: string) => {
    if (!reuse.has(path)) {
      const read = (await readFiles(git, config, base, [path])).get(path);
      reuse.set(path, read?.ok !== true ? 'unreadable' : admitsCapturedFile(path, read.content) ? 'admitted' : 'refused');
    }
    return reuse.get(path)!;
  };
  const downloaded = new Map<string, {file: SpooledFile; type: string}>();
  let runCount = 0;
  let runBytes = 0;
  const failed = new Map<string, DownloadBlockedError | DownloadRetryError>();

  const capture = async (path: string, body: string, uploads: ReadonlyMap<string, string>, previousBody?: string, previousPath = path): Promise<CapturedAssets> => {
    // Repository-file links typed in Linear retain their separate gate. Images are repaired after upload checks.
    const notUploaded = typedFileLinkFindings(path, body, previousBody, previousPath);
    if (notUploaded.length > 0) throw new ImageBlockedError(notUploaded);
    const sourceImages = imagesOf(body);
    const sourceDestinations = destinations(body);
    const ordinaryUrls = new Set(sourceDestinations.filter(({node}) => node.type === 'link').map(({node}) => node.url));
    const definitions = new Map<string, string>();
    for (const {node} of sourceDestinations) if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    visit(parse(body), node => { if (node.type === 'linkReference') { const url = definitions.get(node.identifier); if (url !== undefined) ordinaryUrls.add(url); } });
    const deadUploads = new Set<string>();
    const finish = (observedBody: string, files: Map<string, FileContent>, uploads: UploadMap): CapturedAssets => {
      const changed = new Set(imageLinks(body, deadUploads).images.map(image => image.image));
      const rewritten = imageLinks(observedBody, deadUploads, changed).body;
      const plainFiles = sourceImages.flatMap(image => { const target = !isUpload(image.url) ? resolveTarget(path, image.url) : null; return target === null ? [] : [target]; });
      return {body: rewritten, plainFiles, ...(rewritten === observedBody ? {} : {observedBody, deadUploads: [...deadUploads]}), files, uploads};
    };
    const files = new Map<string, FileContent>();
    const additions: UploadMap = new Map();
    const originalBody = body;
    const rejected = new Map<string, ImageFinding['reason']>();
    let retry: DownloadRetryError | undefined;
    // Restore known URLs before restricting new downloads to the upload host.
    const cachedUrls = [...uploads.values()];
    const knownUpload = (url: string) => cachedUrls.some((known) => url === known || url.startsWith(`${known}?`) || url.startsWith(`${known}#`));
    if (!sourceDestinations.some(({node}) => isUpload(node.url) || knownUpload(node.url))) return finish(body, files, additions);
    await index();
    // Files the sync takes from Linear live in an `assets/` folder beside the documents that embed them.
    const assetsFolder = posix.join(posix.dirname(path), ASSETS_FOLDER);
    const assetsUsable = !notFolders.has(assetsFolder);
    /**
     * The repository file holding these bytes: the one the previous text linked, else one in the
     * document's own `assets/` folder, else the last in tree order. A file from git stays where it is.
     */
    const place = (hash: string): string | undefined => {
      const paths = hashPaths.get(hash) ?? [];
      return preferredPaths.get(hash) ?? paths.find((candidate) => posix.dirname(candidate) === assetsFolder) ?? paths.at(-1);
    };
    // A document moved to another folder takes copies of the files it linked in its old `assets/` folder,
    // by their path in the new one; the old file stays for the documents that still link it.
    const copies = new Map<string, string>();
    const oldAssetsFolder = posix.join(posix.dirname(previousPath), ASSETS_FOLDER);
    /**
     * Where the copy of `source` goes in the new `assets/`: a file there with the same bytes, else its own name,
     * else its hash with its extension; none when every name holds other bytes, and the old file stays linked.
     */
    const copyTarget = (source: string, hash: string): string | undefined => {
      if (!assetsUsable) return undefined;
      const same = (hashPaths.get(hash) ?? []).find((candidate) => posix.dirname(candidate) === assetsFolder);
      if (same !== undefined) return same;
      // A name in the capture form names its content: a file edited in git since its capture is copied under its new hash,
      // so a later download of the original bytes can take the original name.
      const own = posix.basename(source);
      const names = isCaptureName(own) && !own.startsWith(hash) ? [] : [own];
      for (const name of [...names, `${hash}${posix.extname(source)}`]) {
        const target = posix.join(assetsFolder, name);
        // Any other entry at that path (a symbolic link, a Markdown file, a folder) holds other content.
        const existing = pathHashes.get(target) ?? placed.get(target) ?? (notFolders.has(target) || folders.has(target) ? '' : undefined);
        if (existing === hash) return target;
        if (existing === undefined) { placed.set(target, hash); return target; }
      }
      return undefined;
    };
    const preferredPaths = new Map<string, string>();
    // How the previous text wrote each link to a file of the repository, by the file's hash and the link's
    // query and fragment: a link to the same file keeps that spelling. Every upload takes it alike, whether the
    // cache knew its URL or it was downloaded, so the text never depends on the cache (a first initial sync
    // starts with an empty one; a replacement after its pull request was abandoned does not).
    const spellings = new Map<string, string[]>();
    if (previousBody !== undefined) {
      for (const link of findFileLinks(previousPath, previousBody, (target) => pathHashes.has(target))) {
        if (await reusable(link.target) === 'unreadable') continue;
        const hash = pathHashes.get(link.target)!;
        const moved = assetsFolder !== oldAssetsFolder && posix.dirname(link.target) === oldAssetsFolder;
        // Equal bytes under two old names share one copy, so every link names a file that is written.
        const copy = moved ? preferredPaths.get(hash) ?? copyTarget(link.target, hash) : undefined;
        const target = copy ?? link.target;
        if (copy !== undefined && !pathHashes.has(copy) && !copies.has(copy)) copies.set(copy, link.target);
        if (!preferredPaths.has(hash)) preferredPaths.set(hash, target);
        const raw = previousPath === path ? link.written : posix.relative(posix.dirname(path), target).split('/').map(encodeURIComponent).join('/') + link.suffix;
        const key = hash + link.suffix;
        if (!spellings.has(key)) spellings.set(key, []);
        spellings.get(key)!.push(previousPath !== path && link.written.startsWith('<') ? `<${raw}>` : raw);
      }
    }
    const occurrences = new Map<string, number>();
    /**
     * The previous text's spelling of the next link to this file with this query and fragment, in the
     * brackets Linear returned (`opener` is the destination's first character). Without Linear's brackets
     * a space is encoded; a parenthesis keeps the brackets, since it could end the destination early.
     * Brackets are never added around an angle bracket, which they cannot hold.
     */
    const spelling = (key: string, opener: string | undefined): string | undefined => {
      const choices = spellings.get(key);
      if (choices === undefined) return undefined;
      const index = occurrences.get(key) ?? 0;
      occurrences.set(key, index + 1);
      const written = choices[Math.min(index, choices.length - 1)]!;
      const inner = written.startsWith('<') ? written.slice(1, -1) : written;
      // Only a bare destination can hold an angle bracket: it stays as the previous text wrote it.
      if (/[<>]/.test(inner)) return written;
      if (opener === '<' || (written.startsWith('<') && /[()]/.test(inner))) return `<${inner}>`;
      return inner.replace(/\s/g, encodeURIComponent);
    };
    // A repaired dead upload is now an ordinary URL link in the accepted
    // record. Later edits must not turn it back into an attachment download.
    const previousLinks = new Set<string>();
    if (previousBody !== undefined) visit(parse(previousBody), node => { if (node.type === 'link' && isUpload(node.url)) previousLinks.add(node.url); });
    const externalImages = new Set(sourceImages.filter(image => !isUpload(image.url)).map(image => image.url));
    const references = sourceDestinations.filter(({node}) => (isUpload(node.url) || knownUpload(node.url)) && !(node.type !== 'link' && externalImages.has(node.url)) && !(node.type === 'link' && previousLinks.has(node.url) && !knownUpload(node.url)));
    const canonical = (url: string) => cachedUrls.filter((known) => url === known || url.startsWith(`${known}?`) || url.startsWith(`${known}#`)).sort((a,b) => b.length - a.length)[0] ?? url.split('#')[0]!;
    const unique = new Set(references.map(({node}) => canonical(node.url)));
    if (unique.size > limits.documentCount) throw new AttachmentBudgetError();
    let documentBytes = 0;
    const counted = new Set<string>();
    const replacements: Array<{from: number; to: number; text: string}> = [];
    for (const {node, range, outer} of references) {
      const cached = cachedUrls.filter((known) => node.url === known || node.url.startsWith(`${known}?`) || node.url.startsWith(`${known}#`)).sort((a,b) => b.length - a.length)[0];
      const hashAt = node.url.indexOf('#');
      const url = cached ?? (hashAt === -1 ? node.url : node.url.slice(0, hashAt));
      const suffix = cached === undefined ? (hashAt === -1 ? '' : node.url.slice(hashAt)) : node.url.slice(cached.length);
      let hash = [...uploads].find(([, known]) => known === url)?.[0];
      let assetPath = hash === undefined ? undefined : place(hash);
      if (assetPath !== undefined) {
        const source = copies.get(assetPath);
        const state = await reusable(source ?? assetPath);
        if (state === 'refused') { rejected.set(node.url, 'unsupported-type'); continue; }
        if (state === 'unreadable') assetPath = undefined;
        else if (source !== undefined) {
          const read = (await readFiles(git, config, base, [source])).get(source);
          if (read?.ok !== true) throw new Error(message('assets.not-allowed'));
          // A copy named by its hash is checked as a captured upload, as every later capture checks it.
          if (!admitsCapturedFile(assetPath, read.content)) { rejected.set(node.url, 'unsupported-type'); continue; }
          if (!counted.has(assetPath)) { documentBytes += read.content.length; counted.add(assetPath); }
          if (documentBytes > limits.documentBytes) throw new AttachmentBudgetError();
          files.set(assetPath, read.content);
        }
      }
      if (assetPath === undefined) {
        let asset = downloaded.get(url);
        if (asset === undefined) {
          try {
            const failure = failed.get(url);
            if (failure !== undefined) throw failure;
            if (runCount >= limits.runCount || runBytes >= limits.runBytes || documentBytes >= limits.documentBytes) throw new AttachmentBudgetError();
            runCount++;
            const fresh = await download(url, fetcher, reads, Math.min(limits.runBytes - runBytes, limits.documentBytes - documentBytes), (size) => { runBytes += size; documentBytes += size; });
            counted.add(url);
            asset = {file: spool.put(fresh.bytes), type: fresh.type};
          }
          catch (error) {
            if (error instanceof DownloadBlockedError || error instanceof DownloadRetryError) failed.set(url, error);
            if (error instanceof DownloadRetryError) { retry = error; continue; }
            if (!(error instanceof DownloadBlockedError)) throw error;
            if (error.reason === 'dead' && sourceImages.some(image => image.url === node.url) && !ordinaryUrls.has(node.url)) { deadUploads.add(url); deadUploads.add(node.url); continue; }
            rejected.set(node.url, error.reason === 'dead' ? 'unreadable' : error.reason);
            continue;
          }
          downloaded.set(url, asset);
        }
        if (!counted.has(url)) { documentBytes += asset.file.size; counted.add(url); }
        if (documentBytes > limits.documentBytes) throw new AttachmentBudgetError();
        hash = asset.file.hash;
        assetPath = place(hash);
        // The downloaded bytes are the file's bytes (same hash), so they are checked in its place.
        if (assetPath !== undefined && !admitsCapturedFile(assetPath, contentBytes(asset.file))) { rejected.set(node.url, 'unsupported-type'); continue; }
        if (assetPath === undefined) {
          const extension = uploadExtension(contentBytes(asset.file));
          if (extension === null) { rejected.set(node.url, 'unsupported-type'); continue; }
          assetPath = posix.join(assetsFolder, `${hash}${extension}`);
          // A file or symbolic link named `assets` stays: the document waits until its author moves it.
          const chosen = placed.get(assetPath);
          if (!assetsUsable || notFolders.has(assetPath) || folders.has(assetPath) || (chosen !== undefined && chosen !== hash)) throw new Error(message('assets.destination-exists'));
          placed.set(assetPath, hash);
        }
        // Each document owns its candidate bytes until its security check passes.
        files.set(assetPath, asset.file);
      }
      additions.set(hash!, url);
      // The link's query and fragment as Linear wrote them, whatever part of the URL the cache holds.
      const cut = node.url.search(/[?#]/);
      const spelled = preferredPaths.get(hash!) === assetPath ? spelling(hash! + (cut === -1 ? '' : node.url.slice(cut)), body[outer.from]) : undefined;
      if (spelled !== undefined) {
        replacements.push({...outer, text: spelled});
        continue;
      }
      // The query and fragment as the parser decoded them, encoded again: a space, `>` or a parenthesis would end
      // the bare destination early and could spell another link.
      replacements.push({...range, text: posix.relative(posix.dirname(path), assetPath).split('/').map(encodeURIComponent).join('/') + encodeSuffix(suffix)});
    }
    if (rejected.size > 0) {
      const images = imagesOf(originalBody);
      const findings: Array<ImageFinding | FileFinding> = images.flatMap((image, index) => rejected.has(image.url) ? [{image:index + 1, total:images.length, line:image.line, reason:rejected.get(image.url)!}] : []);
      // Ordinary upload links are attachments, and need the same actionable
      // download findings without calling them images or quoting destinations.
      const tree = parse(originalBody);
      const definitions = new Map<string, string>();
      visit(tree, (node) => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
      const files: Array<{url:string; line:number}> = [];
      visit(tree, (node) => {
        const url = node.type === 'link' ? node.url : node.type === 'linkReference' ? definitions.get(node.identifier) : undefined;
        if (url !== undefined && (isUpload(url) || knownUpload(url))) files.push({url, line:line(node)});
      });
      files.forEach((file, index) => {
        const reason = rejected.get(file.url);
        if (reason !== undefined && reason !== 'not-uploaded') findings.push({file:index + 1, total:files.length, line:file.line, reason});
      });
      if (findings.length > 0) throw new ImageBlockedError(findings);
      throw new Error(message('assets.not-allowed'));
    }
    if (retry !== undefined) throw retry;
    let result = body;
    for (const replacement of replacements.sort((a,b) => b.from - a.from)) result = result.slice(0,replacement.from) + replacement.text + result.slice(replacement.to);
    return finish(result, files, additions);
  };
  return Object.assign(capture, {close: () => spool.close()});
}

/** Standalone inverse; a full capture reuses createAssetCapture's hash index. */
export async function captureAssets(git: Git, config: StateConfig, base: Oid, path: string, body: string, uploads: ReadonlyMap<string, string>, fetcher: typeof fetch = fetch): Promise<Omit<CapturedAssets, 'files'> & {files: Map<string, Buffer>}> {
  const capture = createAssetCapture(git, config, base, fetcher);
  try {
    const result = await capture(path, body, uploads);
    return {...result, files: new Map([...result.files].map(([path, content]) => [path, contentBytes(content)]))};
  } finally { capture.close(); }
}
