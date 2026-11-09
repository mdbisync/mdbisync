import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { destinations } from '../initial-sync/uploads.ts';
import { type Git, type Oid, type UploadMap, readBlobs, listTree, readFiles, type StateConfig } from '../state/index.ts';

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

/** Only Linear's asset host is fetched, without credentials and without off-host redirects. */
async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  let current = url;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (!isUpload(current)) throw new Error('asset destination is not allowed');
    const response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = new URL(response.headers.get('location') ?? '', current).href;
      continue;
    }
    if (!response.ok || response.body === null || Number(response.headers.get('content-length') ?? 0) > LIMIT) throw new Error('asset could not be downloaded');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) { await response.body.cancel().catch(() => undefined); throw new Error('asset exceeds the download limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('asset redirect limit exceeded');
}

/** Reuses content hashes and existing file paths; only unknown upload URLs cost a GET. */
export async function captureAssets(
  git: Git, config: StateConfig, base: Oid, path: string, body: string, uploads: ReadonlyMap<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<CapturedAssets> {
  const references: Array<{ url: string; from: number; to: number }> = [];
  for (const { node, range } of destinations(body)) {
    if (isUpload(node.url)) references.push({ url: node.url, from: range.from, to: range.to });
  }
  const files = new Map<string, Buffer>();
  const additions: UploadMap = new Map();
  if (references.length === 0) return { body, files, uploads: additions };
  const entries = (await listTree(git, base)).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
  const blobs = await readBlobs(git, entries.map((entry) => entry.oid));
  const hashPaths = new Map<string, string>();
  for (const entry of entries) {
    const blob = blobs.get(entry.oid)!;
    const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\n/.exec(blob.toString('utf8'));
    hashPaths.set(pointer?.[1] ?? createHash('sha256').update(blob).digest('hex'), entry.path);
  }
  const replacements = new Map<string, string>();
  for (const { url } of references) {
    if (replacements.has(url)) continue;
    let hash = [...uploads].find(([, known]) => known === url)?.[0];
    let assetPath = hash === undefined ? undefined : hashPaths.get(hash);
    if (assetPath !== undefined) {
      // Verify cached LFS objects too; a missing object must not yield a broken relative link.
      const read = (await readFiles(git, config, base, [assetPath])).get(assetPath)!;
      if (!read.ok) assetPath = undefined;
    }
    if (assetPath === undefined) {
      const bytes = await download(url, fetcher);
      hash = createHash('sha256').update(bytes).digest('hex');
      assetPath = hashPaths.get(hash);
      if (assetPath === undefined) {
        const extension = posix.extname(new URL(url).pathname).toLowerCase();
        const suffix = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
        assetPath = posix.join(posix.dirname(path), `${hash}${suffix}`);
        if (entries.some((entry) => entry.path === assetPath)) throw new Error('asset destination already exists');
        files.set(assetPath, bytes);
        hashPaths.set(hash, assetPath);
      }
    }
    additions.set(hash!, url);
    const relative = posix.relative(posix.dirname(path), assetPath);
    replacements.set(url, relative.split('/').map(encodeURIComponent).join('/'));
  }
  let result = body;
  for (const reference of references.sort((a, b) => b.from - a.from)) result = result.slice(0, reference.from) + replacements.get(reference.url)! + result.slice(reference.to);
  return { body: result, files, uploads: additions };
}
