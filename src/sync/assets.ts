import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { destinations, findFileLinks, restoreFileLinks, type WrittenLink } from '../initial-sync/uploads.ts';
import { type LinearReads, uploadReadKey, LinearError, LinearHttpError } from '../linear/index.ts';
import { type Git, type Oid, type UploadMap, readBlobs, listTree, readFiles, parseLfsPointer, type StateConfig } from '../state/index.ts';
import { parse, visit, line } from '../format/markdown.ts';
import { message } from '../messages.ts';
import { uploadExtension } from './upload-type.ts';

export interface CapturedAssets {
  body: string;
  files: Map<string, Buffer>;
  uploads: UploadMap;
}

const LIMIT = 10 * 1024 * 1024;
function isUpload(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.username === '' && parsed.password === '' && parsed.port === ''; }
  catch { return false; }
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
  reason: Exclude<ImageFinding['reason'], 'not-uploaded'>;
}

export class ImageBlockedError extends Error {
  readonly findings: Array<ImageFinding | FileFinding>;
  constructor(findings: Array<ImageFinding | FileFinding>) {
    super(message('assets.not-allowed'));
    this.findings = findings;
  }
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

export function imageFindings(body: string): ImageFinding[] {
  const images = imagesOf(body);
  return images.flatMap((image, index) => isUpload(image.url) ? [] : [{image: index + 1, total: images.length, line: image.line, reason: 'not-uploaded' as const}]);
}

/** A download that can succeed on a later run; never expose the URL or response body. */
export class DownloadRetryError extends Error {
  constructor(cause?: unknown) { super(message('assets.download-failed'), {cause}); }
}

class DownloadBlockedError extends Error {
  readonly reason: 'unreadable' | 'too-large';
  constructor(reason: 'unreadable' | 'too-large') {
    super(message('assets.download-failed'));
    this.reason = reason;
  }
}

/** The caller authenticates the allowed upload host. Redirects cannot forward credentials elsewhere. */
async function download(url: string, fetcher: typeof fetch, reads: LinearReads | undefined): Promise<{ bytes: Buffer; type: string }> {
  if (!isUpload(url)) throw new Error(message('assets.not-allowed'));
  const key = uploadReadKey(url);
  const kept = reads?.take(key);
  if (kept !== undefined && kept.body.length <= LIMIT) return { bytes: kept.body, type: kept.type };
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    // Access failures belong to the client, never to an individual document.
    if (response.status !== 200) await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new LinearHttpError('DownloadUpload', response.status);
    if (response.status === 429 || response.status >= 500) throw new DownloadRetryError();
    if (response.status !== 200 || response.body === null) throw new DownloadBlockedError('unreadable');
    if (Number(response.headers.get('content-length') ?? 0) > LIMIT) {
      await response.body.cancel().catch(() => {});
      throw new DownloadBlockedError('too-large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) throw new DownloadBlockedError('too-large');
      chunks.push(Buffer.from(chunk));
    }
    const asset = {bytes: Buffer.concat(chunks), type: response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''};
    reads?.keep(key, { status: response.status, type: asset.type, body: asset.bytes });
    return asset;
  } catch (error) {
    if (error instanceof LinearError || error instanceof DownloadBlockedError || error instanceof DownloadRetryError) throw error;
    // Fetch failures and interrupted response streams are retried without quoting their messages.
    throw new DownloadRetryError(error);
  }
}

/** One lazily built hash index per capture, read in bounded batches. */
export function createAssetCapture(git: Git, config: StateConfig, base: Oid, fetcher: typeof fetch = fetch, reads?: LinearReads) {
  const hashPaths = new Map<string, string>();
  const pathHashes = new Map<string, string>();
  let indexed = false;
  const index = async () => {
    if (indexed) return;
    // Markdown files are documents the same run may rewrite or remove, never a downloaded file's home.
    const entries = (await listTree(git, base)).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && !entry.path.toLowerCase().endsWith('.md'));
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
        hashPaths.set(hash, entry.path);
        pathHashes.set(entry.path, hash);
      }
    }
    indexed = true;
  };
  const readable = new Map<string, boolean>();
  const canRead = async (path: string) => {
    if (!readable.has(path)) readable.set(path, (await readFiles(git, config, base, [path])).get(path)?.ok === true);
    return readable.get(path)!;
  };
  const downloaded = new Map<string, {bytes: Buffer; type: string}>();
  const failed = new Map<string, DownloadBlockedError | DownloadRetryError>();

  return async (path: string, body: string, uploads: ReadonlyMap<string, string>, previousBody?: string, previousPath = path): Promise<CapturedAssets> => {
    const files = new Map<string, Buffer>();
    const additions: UploadMap = new Map();
    const originalBody = body;
    const rejected = new Map<string, ImageFinding['reason']>();
    let retry: DownloadRetryError | undefined;
    // Restore known URLs before restricting new downloads to the upload host.
    const cachedUrls = [...uploads.values()];
    const knownUpload = (url: string) => cachedUrls.some((known) => url === known || url.startsWith(`${known}?`) || url.startsWith(`${known}#`));
    if (!destinations(body).some(({node}) => isUpload(node.url) || knownUpload(node.url))) return {body, files, uploads: additions};
    await index();
    const preferredPaths = new Map<string, string>();
    if (previousBody !== undefined) {
      const written: WrittenLink[] = [];
      for (const link of findFileLinks(previousPath, previousBody, (target) => pathHashes.has(target))) {
        if (!await canRead(link.target)) continue;
        const hash = pathHashes.get(link.target)!;
        if (!preferredPaths.has(hash)) preferredPaths.set(hash, link.target);
        const raw = previousPath === path ? link.written : posix.relative(posix.dirname(path), link.target).split('/').map(encodeURIComponent).join('/') + link.suffix;
        written.push({written: previousPath !== path && link.written.startsWith('<') ? `<${raw}>` : raw, hash, suffix: link.suffix});
      }
      // Capture keeps the brackets Linear returned; the shared inverse now
      // replaces the whole destination, so give it that occurrence's brackets.
      const spellings = new Map<string, WrittenLink[]>();
      for (const link of written) {
        const url = uploads.get(link.hash);
        if (url === undefined) continue;
        const key = url + link.suffix;
        spellings.set(key, [...(spellings.get(key) ?? []), link]);
      }
      const occurrences = new Map<string, number>();
      const shaped: WrittenLink[] = [];
      for (const {node, outer} of destinations(body)) {
        const choices = spellings.get(node.url);
        if (choices === undefined) continue;
        const index = occurrences.get(node.url) ?? 0;
        occurrences.set(node.url, index + 1);
        const link = choices[Math.min(index, choices.length - 1)]!;
        const inner = link.written.startsWith('<') ? link.written.slice(1, -1) : link.written;
        shaped.push({...link, written:body[outer.from] === '<' ? `<${inner}>` : inner.replace(/\s/g, encodeURIComponent)});
      }
      body = restoreFileLinks(body, shaped, new Map(uploads));
    }
    const references = destinations(body).filter(({node}) => isUpload(node.url) || knownUpload(node.url));
    const replacements: Array<{from: number; to: number; text: string}> = [];
    for (const {node, range} of references) {
      const cached = cachedUrls.filter((known) => node.url === known || node.url.startsWith(`${known}?`) || node.url.startsWith(`${known}#`)).sort((a,b) => b.length - a.length)[0];
      const hashAt = node.url.indexOf('#');
      const url = cached ?? (hashAt === -1 ? node.url : node.url.slice(0, hashAt));
      const suffix = cached === undefined ? (hashAt === -1 ? '' : node.url.slice(hashAt)) : node.url.slice(cached.length);
      let hash = [...uploads].find(([, known]) => known === url)?.[0];
      let assetPath = hash === undefined ? undefined : preferredPaths.get(hash) ?? hashPaths.get(hash);
      if (assetPath !== undefined) {
        if (!await canRead(assetPath)) assetPath = undefined;
      }
      if (assetPath === undefined) {
        let asset = downloaded.get(url);
        if (asset === undefined) {
          try {
            const failure = failed.get(url);
            if (failure !== undefined) throw failure;
            asset = await download(url, fetcher, reads);
          }
          catch (error) {
            if (error instanceof DownloadBlockedError || error instanceof DownloadRetryError) failed.set(url, error);
            if (error instanceof DownloadRetryError) { retry = error; continue; }
            if (!(error instanceof DownloadBlockedError)) throw error;
            rejected.set(node.url, error.reason);
            continue;
          }
          downloaded.set(url, asset);
        }
        hash = createHash('sha256').update(asset.bytes).digest('hex');
        assetPath = preferredPaths.get(hash) ?? hashPaths.get(hash);
        if (assetPath === undefined) {
          const extension = uploadExtension(asset.bytes);
          if (extension === null) { rejected.set(node.url, 'unsupported-type'); continue; }
          assetPath = posix.join(posix.dirname(path), `${hash}${extension}`);
          if (pathHashes.has(assetPath)) throw new Error(message('assets.destination-exists'));
        }
        // Each document owns its candidate bytes until its security check passes.
        files.set(assetPath, asset.bytes);
      }
      additions.set(hash!, url);
      replacements.push({...range, text: posix.relative(posix.dirname(path), assetPath).split('/').map(encodeURIComponent).join('/') + suffix});
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
        if (url !== undefined && isUpload(url)) files.push({url, line:line(node)});
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
    return {body: result, files, uploads: additions};
  };
}

/** Standalone inverse; a full capture reuses createAssetCapture's hash index. */
export async function captureAssets(git: Git, config: StateConfig, base: Oid, path: string, body: string, uploads: ReadonlyMap<string, string>, fetcher: typeof fetch = fetch): Promise<CapturedAssets> {
  return createAssetCapture(git, config, base, fetcher)(path, body, uploads);
}
