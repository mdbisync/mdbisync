// Local fixtures for the git state tests: a bare repository reached over a
// file:// URL (git-lfs serves LFS objects from it without a server), a
// seeding working copy, and clones made the way the engine makes them.

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

/** Reads a ref of the bare remote, or null. */
export async function remoteRef(fixture: Fixture, ref: string): Promise<string | null> {
  const result = await fixture.remote.run(['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] });
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}
