import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { destinations, findFileLinks, restoreFileLinks, type WrittenLink } from '../initial-sync/uploads.ts';
import { type Git, type Oid, type UploadMap, readBlobs, listTree, readFiles, parseLfsPointer, type StateConfig } from '../state/index.ts';

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

/** The caller authenticates the allowed upload host. Redirects cannot forward credentials elsewhere. */
async function download(url: string, fetcher: typeof fetch): Promise<{ bytes: Buffer; type: string }> {
  if (!isUpload(url)) throw new Error('asset destination is not allowed');
  const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status >= 300 && response.status < 400) throw new Error('asset redirect destination is not allowed');
  if (!response.ok || response.body === null || Number(response.headers.get('content-length') ?? 0) > LIMIT) throw new Error('asset could not be downloaded');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('asset exceeds the download limit');
    chunks.push(Buffer.from(chunk));
  }
  return {bytes: Buffer.concat(chunks), type: response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''};
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'application/pdf': '.pdf' };

/** One lazily built hash index per capture, read in bounded batches. */
export function createAssetCapture(git: Git, config: StateConfig, base: Oid, fetcher: typeof fetch = fetch) {
  const hashPaths = new Map<string, string>();
  const pathHashes = new Map<string, string>();
  let indexed = false;
  const index = async () => {
    if (indexed) return;
    const entries = (await listTree(git, base)).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
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

  return async (path: string, body: string, uploads: ReadonlyMap<string, string>, previousBody?: string): Promise<CapturedAssets> => {
    const files = new Map<string, Buffer>();
    const additions: UploadMap = new Map();
    // Restore known URLs before restricting new downloads to the upload host.
    const cachedUrls = [...uploads.values()];
    const knownUpload = (url: string) => cachedUrls.some((known) => url === known || url.startsWith(`${known}?`) || url.startsWith(`${known}#`));
    if (!destinations(body).some(({node}) => isUpload(node.url) || knownUpload(node.url))) return {body, files, uploads: additions};
    await index();
    if (previousBody !== undefined) {
      const written: WrittenLink[] = [];
      for (const link of findFileLinks(path, previousBody, (target) => pathHashes.has(target))) {
        if (await canRead(link.target)) written.push({raw: link.raw, hash: pathHashes.get(link.target)!, suffix: link.suffix});
      }
      body = restoreFileLinks(body, written, new Map(uploads));
    }
    const references = destinations(body).filter(({node}) => isUpload(node.url) || knownUpload(node.url));
    const replacements: Array<{from: number; to: number; text: string}> = [];
    for (const {node, range} of references) {
      const cached = cachedUrls.filter((known) => node.url === known || node.url.startsWith(`${known}?`) || node.url.startsWith(`${known}#`)).sort((a,b) => b.length - a.length)[0];
      const hashAt = node.url.indexOf('#');
      const url = cached ?? (hashAt === -1 ? node.url : node.url.slice(0, hashAt));
      const suffix = cached === undefined ? (hashAt === -1 ? '' : node.url.slice(hashAt)) : node.url.slice(cached.length);
      let hash = [...uploads].find(([, known]) => known === url)?.[0];
      let assetPath = hash === undefined ? undefined : hashPaths.get(hash);
      if (assetPath !== undefined) {
        if (!await canRead(assetPath)) assetPath = undefined;
      }
      if (assetPath === undefined) {
        let asset = downloaded.get(url);
        if (asset === undefined) { asset = await download(url, fetcher); downloaded.set(url, asset); }
        hash = createHash('sha256').update(asset.bytes).digest('hex');
        assetPath = hashPaths.get(hash);
        if (assetPath === undefined) {
          const extension = posix.extname(new URL(url).pathname).toLowerCase();
          const suffix = EXTENSIONS[asset.type] ?? (/^\.[a-z0-9]{1,8}$/.test(extension) && extension !== '.md' ? extension : '.bin');
          assetPath = posix.join(posix.dirname(path), `${hash}${suffix}`);
          if (pathHashes.has(assetPath)) throw new Error('asset destination already exists');
        }
        // Each document owns its candidate bytes until its security check passes.
        files.set(assetPath, asset.bytes);
      }
      additions.set(hash!, url);
      replacements.push({...range, text: posix.relative(posix.dirname(path), assetPath).split('/').map(encodeURIComponent).join('/') + suffix});
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
