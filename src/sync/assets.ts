import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { destinations, findFileLinks, restoreFileLinks, type WrittenLink } from '../initial-sync/uploads.ts';
import { type LinearReads, uploadReadKey } from '../linear/index.ts';
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
  reason: 'not-uploaded' | 'unsupported-type';
}

export class ImageBlockedError extends Error {
  readonly findings: ImageFinding[];
  constructor(findings: ImageFinding[]) {
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

/** The caller authenticates the allowed upload host. Redirects cannot forward credentials elsewhere. */
async function download(url: string, fetcher: typeof fetch, reads: LinearReads | undefined): Promise<{ bytes: Buffer; type: string }> {
  if (!isUpload(url)) throw new Error(message('assets.not-allowed'));
  const key = uploadReadKey(url);
  const kept = reads?.take(key);
  if (kept !== undefined && kept.body.length <= LIMIT) return { bytes: kept.body, type: kept.type };
  const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status >= 300 && response.status < 400) throw new Error(message('assets.redirect-not-allowed'));
  if (!response.ok || response.body === null || Number(response.headers.get('content-length') ?? 0) > LIMIT) throw new Error(message('assets.download-failed'));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT) throw new Error(message('assets.too-large'));
    chunks.push(Buffer.from(chunk));
  }
  const asset = {bytes: Buffer.concat(chunks), type: response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''};
  reads?.keep(key, { status: response.status, type: asset.type, body: asset.bytes });
  return asset;
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

  return async (path: string, body: string, uploads: ReadonlyMap<string, string>, previousBody?: string, previousPath = path): Promise<CapturedAssets> => {
    const files = new Map<string, Buffer>();
    const additions: UploadMap = new Map();
    const images = imagesOf(body);
    const unsupported = new Set<string>();
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
        if (asset === undefined) { asset = await download(url, fetcher, reads); downloaded.set(url, asset); }
        hash = createHash('sha256').update(asset.bytes).digest('hex');
        assetPath = preferredPaths.get(hash) ?? hashPaths.get(hash);
        if (assetPath === undefined) {
          const extension = uploadExtension(asset.bytes);
          if (extension === null) { unsupported.add(node.url); continue; }
          assetPath = posix.join(posix.dirname(path), `${hash}${extension}`);
          if (pathHashes.has(assetPath)) throw new Error(message('assets.destination-exists'));
        }
        // Each document owns its candidate bytes until its security check passes.
        files.set(assetPath, asset.bytes);
      }
      additions.set(hash!, url);
      replacements.push({...range, text: posix.relative(posix.dirname(path), assetPath).split('/').map(encodeURIComponent).join('/') + suffix});
    }
    if (unsupported.size > 0) {
      const findings = images.flatMap((image, index) => unsupported.has(image.url) ? [{image:index + 1, total:images.length, line:image.line, reason:'unsupported-type' as const}] : []);
      if (findings.length > 0) throw new ImageBlockedError(findings);
      throw new Error(message('assets.not-allowed'));
    }
    let result = body;
    for (const replacement of replacements.sort((a,b) => b.from - a.from)) result = result.slice(0,replacement.from) + replacement.text + result.slice(replacement.to);
    return {body: result, files, uploads: additions};
  };
}

/** Standalone inverse; a full capture reuses createAssetCapture's hash index. */
export async function captureAssets(git: Git, config: StateConfig, base: Oid, path: string, body: string, uploads: ReadonlyMap<string, string>, fetcher: typeof fetch = fetch): Promise<CapturedAssets> {
  return createAssetCapture(git, config, base, fetcher)(path, body, uploads);
}
