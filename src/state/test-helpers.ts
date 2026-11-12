// Local fixtures for the git state tests: a bare repository reached over a
// file:// URL (git-lfs serves LFS objects from it without a server), a
// seeding working copy, and clones made the way the engine makes them.

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Git } from './index.ts';

export const IDENTITY = { name: 'State Test', email: 'state-test@example.com' };

export interface Fixture {
  root: string;
  url: string;
  /** Clones the remote without checkout and without LFS content. */
  clone(name: string): Promise<Git>;
  /** Commits files in the seeding working copy and pushes them to `branch`. */
  seed(files: Record<string, Buffer | string>, options?: { lfs?: string[]; branch?: string; executable?: string[] }): Promise<void>;
  /** Runs git in the bare remote. */
  remote: Git;
  cleanup(): Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'state-test-'));
  const bare = join(root, 'remote.git');
  const url = pathToFileURL(bare).href;
  const top = new Git(root);
  await top.run(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  const remote = new Git(bare);

  const work = join(root, 'seed');
  await top.run(['init', '--quiet', '--initial-branch=main', work]);
  const seedGit = new Git(work, {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
  });
  await seedGit.run(['lfs', 'install', '--local']);
  await seedGit.run(['config', 'lfs.allowincompletepush', 'true']);
  await seedGit.run(['remote', 'add', 'origin', url]);

  return {
    root,
    url,
    remote,
    async clone(name) {
      const dir = join(root, name);
      await top.run(['clone', '--quiet', '--no-checkout', url, dir]);
      return new Git(dir);
    },
    async seed(files, options = {}) {
      const branch = options.branch ?? 'main';
      if (options.lfs !== undefined) {
        const lines = options.lfs.map((pattern) => `${pattern} filter=lfs diff=lfs merge=lfs -text\n`).join('');
        await writeFile(join(work, '.gitattributes'), lines);
      }
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), content, { mode: options.executable?.includes(path) ? 0o755 : 0o644 });
      }
      await seedGit.run(['add', '--all']);
      await seedGit.run(['commit', '--quiet', '--allow-empty', '-m', 'Seed']);
      await seedGit.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { env: { GIT_LFS_SKIP_SMUDGE: undefined } });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Counts the LFS objects stored locally in a clone. */
export async function countLocalLfsObjects(git: Git): Promise<number> {
  const dir = join(git.dir, '.git', 'lfs', 'objects');
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export interface FakeLfsServer {
  /** The LFS endpoint, for a clone's `lfs.url`. */
  url: string;
  /** Requests received, as `METHOD path`: a download is a `GET`. */
  requests: string[];
  /** The `Authorization` header of each request, empty when it had none. */
  authorizations: string[];
  /** An HTTP status the batch API answers the whole request with, instead of an answer per object. */
  failBatch?: number;
  /** HTTP statuses the batch API answers single objects with, by LFS object id, instead of its usual answer. */
  objectErrors: Map<string, number>;
  close(): Promise<void>;
}

/**
 * A Git LFS server on 127.0.0.1 that holds the objects of `contents`: its
 * batch API offers a download for each of them and answers every other
 * object with a 404 error, and it serves the content of those it holds.
 */
export async function fakeLfsServer(contents: readonly Buffer[]): Promise<FakeLfsServer> {
  const held = new Map(contents.map((content) => [createHash('sha256').update(content).digest('hex'), content]));
  let base = '';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      fake.requests.push(`${request.method} ${request.url}`);
      fake.authorizations.push(request.headers.authorization ?? '');
      if (request.method === 'POST' && request.url === '/info/lfs/objects/batch') {
        if (fake.failBatch !== undefined) {
          response.writeHead(fake.failBatch, { 'content-type': 'application/vnd.git-lfs+json' });
          response.end(JSON.stringify({ message: 'Batch refused' }));
          return;
        }
        const batch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { objects: Array<{ oid: string; size: number }> };
        const objects = batch.objects.map(({ oid, size }) =>
          fake.objectErrors.has(oid)
            ? { oid, size, error: { code: fake.objectErrors.get(oid), message: 'Object refused' } }
            : held.has(oid)
            ? { oid, size, authenticated: true, actions: { download: { href: `${base}/objects/${oid}` } } }
            : { oid, size, error: { code: 404, message: 'Object does not exist' } },
        );
        response.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
        response.end(JSON.stringify({ transfer: 'basic', objects }));
        return;
      }
      const content = request.method === 'GET' ? held.get((request.url ?? '').replace('/objects/', '')) : undefined;
      response.writeHead(content === undefined ? 404 : 200);
      response.end(content);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FakeLfsServer = {
    url: `${base}/info/lfs`,
    requests: [],
    authorizations: [],
    objectErrors: new Map(),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  return fake;
}

/** Reads a ref of the bare remote, or null. */
export async function remoteRef(fixture: Fixture, ref: string): Promise<string | null> {
  const result = await fixture.remote.run(['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] });
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

/** The author and committer of a merge the fake GitHub makes. */
const GITHUB_MERGER = { GIT_AUTHOR_NAME: 'sync-app[bot]', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.com' };

/**
 * Merges a pull request in the bare remote as GitHub does: a merge commit,
 * only while the head is still `sha` (409 otherwise). GitHub's merge does
 * not pair a rename on one side with an edit of the old path on the other:
 * it refuses such a head with "Pull Request has merge conflicts" (405), even
 * where git's own merge detects the rename. So the fake merges without
 * rename detection.
 */
export async function mergeOnGitHub(fixture: Fixture, pr: { head: string; base: string; number: number }, sha: string, message?: string): Promise<{ sha: string } | { status: number; message?: string }> {
  if ((await remoteRef(fixture, `refs/heads/${pr.head}`)) !== sha) return { status: 409 };
  const base = await remoteRef(fixture, `refs/heads/${pr.base}`);
  if (base === null) return { status: 422 };
  const merged = await fixture.remote.run(['-c', 'merge.renames=false', 'merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
  if (merged.code !== 0) return { status: 405, message: 'Pull Request has merge conflicts' };
  const tree = merged.stdout.toString('utf8').split('\n')[0] as string;
  const commit = (await fixture.remote.text(['commit-tree', tree, '-p', base, '-p', sha, '-m', message ?? `Merge pull request #${pr.number} from owner/${pr.head}`], { env: GITHUB_MERGER })).trim();
  await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
  return { sha: commit };
}
