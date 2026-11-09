// The sandbox repository as the harness uses it: a shared blobless cache of
// its main branch (the corpus), a run's tracked branch built from a slice, a
// working clone for the engine, a clone where "people" commit, and the
// removal of a run's branches and refs. Every push names its refs exactly;
// nothing is force-pushed.

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Git } from '../../../src/state/index.ts';
import { CORPUS_DIR, SLICES_DIR, buildRunTree, parseManifest, parseSlice, type Manifest, type RunTree } from './corpus.ts';
import { gitAuthEnv } from './github.ts';
import { runOfRef, type RunNames } from './isolation.ts';
import { acquireLock } from './locks.ts';

export const PERSON = { name: 'Test Editor', email: 'editor@example.com' };
export const HARNESS = { name: 'Scenario Harness', email: 'harness@example.com' };

function identityEnv(who: { name: string; email: string }): Record<string, string> {
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
}

export class CorpusMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusMissingError';
  }
}

export interface SandboxOptions {
  url: string;
  token: string;
  stateDir: string;
  runId: string;
}

export class Sandbox {
  readonly url: string;
  readonly #token: string;
  readonly #stateDir: string;
  readonly #runId: string;
  readonly cache: Git;

  constructor(options: SandboxOptions) {
    this.url = options.url;
    this.#token = options.token;
    this.#stateDir = options.stateDir;
    this.#runId = options.runId;
    this.cache = new Git(join(options.stateDir, 'cache', 'sandbox.git'), this.env(HARNESS));
  }

  env(who: { name: string; email: string } = HARNESS): Record<string, string> {
    // A stalled transfer (under 1 KB/s for a minute) fails instead of hanging the run.
    return { ...gitAuthEnv(this.#token), ...identityEnv(who), GIT_LFS_SKIP_SMUDGE: '1', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };
  }

  /** Brings the shared cache up to date with the sandbox's main branch. */
  async refreshCache(): Promise<string> {
    const lock = await acquireLock('sandbox-cache', { stateDir: this.#stateDir, runId: this.#runId, timeoutMs: 10 * 60_000 });
    try {
      if (!existsSync(join(this.cache.dir, 'HEAD'))) {
        mkdirSync(dirname(this.cache.dir), { recursive: true });
        await new Git(dirname(this.cache.dir), this.env()).run(['clone', '--quiet', '--bare', '--filter=blob:none', '--single-branch', '--branch', 'main', this.url, this.cache.dir]);
      } else {
        await this.cache.run(['fetch', '--quiet', '--filter=blob:none', this.url, '+refs/heads/main:refs/heads/main']);
      }
      return (await this.cache.text(['rev-parse', 'refs/heads/main'])).trim();
    } finally {
      lock.release();
    }
  }

  async readMain(path: string): Promise<string | null> {
    try {
      return await this.cache.text(['cat-file', 'blob', `refs/heads/main:${path}`]);
    } catch {
      return null;
    }
  }

  async manifest(): Promise<Manifest> {
    const text = await this.readMain(`${SLICES_DIR}/manifest.json`);
    if (text === null) throw new CorpusMissingError(`the sandbox's main has no ${SLICES_DIR}/manifest.json (the corpus is not there yet)`);
    return parseManifest(text);
  }

  /** Builds the run's tree from a slice and pushes it as the run's tracked branch (a new root commit). */
  async createTrackedBranch(slice: string, names: RunNames): Promise<{ tree: RunTree; commit: string }> {
    const sliceText = await this.readMain(`${SLICES_DIR}/${slice}.json`);
    if (sliceText === null) throw new CorpusMissingError(`the sandbox's main has no ${SLICES_DIR}/${slice}.json (the corpus is not there yet)`);
    const list = parseSlice(sliceText, slice);
    const entries = new Map<string, { mode: string; oid: string }>();
    const listing = await this.cache.text(['ls-tree', '-r', '-z', '--full-tree', `refs/heads/main:${CORPUS_DIR}`]);
    for (const record of listing.split('\0')) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (match !== null) entries.set(match[3] as string, { mode: match[1] as string, oid: match[2] as string });
    }
    const readmes = new Map<string, string>();
    for (const path of list.paths) {
      if (!entries.has(path)) throw new CorpusMissingError(`slice ${slice} names ${path}, which is not in ${CORPUS_DIR}/`);
      if (/(^|\/)README\.md$/.test(path)) readmes.set(path, (await this.readMain(`${CORPUS_DIR}/${path}`)) ?? '');
    }
    const tree = buildRunTree(list, readmes, names);
    const lines: string[] = [];
    for (const [target, source] of tree.paths) {
      const entry = entries.get(source) as { mode: string; oid: string };
      const text = tree.rewritten.get(target);
      const oid = text === undefined ? entry.oid : (await this.cache.text(['hash-object', '-w', '--stdin'], { input: text })).trim();
      lines.push(`${entry.mode} ${oid}\t${target}`);
    }
    const index = join(this.#stateDir, 'cache', `index-${names.runId}`);
    const indexEnv = { GIT_INDEX_FILE: index };
    await this.cache.run(['read-tree', '--empty'], { env: indexEnv });
    await this.cache.run(['update-index', '--index-info'], { env: indexEnv, input: `${lines.join('\n')}\n` });
    const treeOid = (await this.cache.text(['write-tree'], { env: indexEnv })).trim();
    const commit = (await this.cache.text(['commit-tree', treeOid, '-m', 'Starting tree'])).trim();
    await this.cache.run(['push', '--quiet', '--no-verify', this.url, `${commit}:refs/heads/${names.trackedBranch}`]);
    return { tree, commit };
  }

  /** A working clone of the run's tracked branch (no LFS content), for the engine or for a person. */
  async clone(names: RunNames, dir: string): Promise<Git> {
    mkdirSync(dirname(dir), { recursive: true });
    await new Git(dirname(dir), this.env()).run([
      'clone', '--quiet', '--reference-if-able', this.cache.dir, '--single-branch', '--branch', names.trackedBranch, this.url, dir,
    ]);
    return new Git(dir, this.env(PERSON));
  }

  /** All run branches and state refs on the sandbox, with their run ids. */
  async runRefs(): Promise<Array<{ ref: string; oid: string; runId: string }>> {
    const text = await this.cache.text(['ls-remote', '--refs', this.url, 'refs/heads/t/*', 'refs/mdbisync-t/*']);
    const refs: Array<{ ref: string; oid: string; runId: string }> = [];
    for (const line of text.split('\n')) {
      const [oid, ref] = line.split('\t');
      if (oid === undefined || ref === undefined) continue;
      const runId = runOfRef(ref);
      if (runId !== null) refs.push({ ref, oid, runId });
    }
    return refs;
  }

  /** The committer time of a commit on the sandbox, fetching it into the cache when needed. */
  async commitTime(oid: string): Promise<number | null> {
    try {
      // Never shallow: a shallow cache cannot serve as a clone reference.
      await this.cache.run(['fetch', '--quiet', '--filter=blob:none', this.url, oid]);
      return Number((await this.cache.text(['show', '-s', '--format=%ct', oid])).trim()) * 1000;
    } catch {
      return null;
    }
  }

  /** Deletes refs of one run in one push. Refuses any ref that is not a run's. */
  async deleteRunRefs(runId: string, refs: readonly string[]): Promise<void> {
    if (refs.length === 0) return;
    for (const ref of refs) if (runOfRef(ref) !== runId) throw new Error(`refusing to delete ${ref}: not a ref of run ${runId}`);
    await this.cache.run(['push', '--quiet', '--no-verify', this.url, ...refs.map((ref) => `:${ref}`)]);
  }
}

/** Writes or removes files in a person's clone, commits and pushes to the tracked branch. */
export async function personCommit(
  git: Git,
  names: RunNames,
  changes: ReadonlyMap<string, string | Buffer | null>,
  message: string,
  options: { verify: boolean; branch?: string },
): Promise<string> {
  const binary = [...changes.values()].some((content) => Buffer.isBuffer(content));
  // Binary files go through the LFS filters the repository's .gitattributes names, as on a person's machine.
  if (binary) await git.run(['lfs', 'install', '--local', '--skip-smudge']);
  for (const [path, content] of changes) {
    const file = join(git.dir, path);
    if (content === null) {
      await git.run(['rm', '--quiet', '--', path]);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      await git.run(['add', '--', path]);
    }
  }
  await git.run(['commit', '--quiet', ...(options.verify ? [] : ['--no-verify']), '-m', message]);
  // Objects first, so a pushed pointer never names an object the server lacks (a bypassed pre-push hook would skip it).
  if (binary) await git.run(['lfs', 'push', 'origin', 'HEAD']);
  await git.run(['push', '--quiet', ...(options.verify ? [] : ['--no-verify']), 'origin', `HEAD:refs/heads/${options.branch ?? names.trackedBranch}`]);
  return (await git.text(['rev-parse', 'HEAD'])).trim();
}
