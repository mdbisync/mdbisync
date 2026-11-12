// The sandbox repository as the harness uses it: a shared blobless cache of
// its main branch (the corpus), a run's tracked branch built from a slice, a
// working clone for the engine, a clone where "people" commit through the
// repository's pre-commit hooks, and the removal of a run's branches and
// refs. Every push names its refs exactly; nothing is force-pushed.

import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { validateSha } from '../../../src/release/package.ts';
import { CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { LOCAL_REPOS, PRE_COMMIT_CONFIG } from '../../../src/setup/hooks.ts';
import { Git, GitError } from '../../../src/state/index.ts';
import type { RunOptions, RunResult } from '../../../src/state/git.ts';
import { CORPUS_DIR, SLICES_DIR, buildRunTree, selectTeams, parseManifest, parseSlice, type Manifest, type RunTree, type SliceList } from './corpus.ts';
import { gitAuthEnv } from './github.ts';
import { relinkRunTree } from './run-links.ts';
import { runOfRef, type RunNames } from './isolation.ts';
import { acquireLock } from './locks.ts';
import { EnvBlockedError, ProductError } from './results.ts';

const execFileAsync = promisify(execFile);

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
  getToken?: () => Promise<string>;
  stateDir: string;
  runId: string;
}

/** Refresh before every Git operation; isolated hook environments never inherit credentials. */
export class CredentialGit extends Git {
  readonly #load: () => Promise<string>;
  constructor(dir: string, env: Record<string, string>, load: () => Promise<string>) {
    super(dir, env);
    this.#load = load;
  }
  override async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    if (options.onlyEnv !== undefined) return super.run(args, options);
    return super.run(args, { ...options, env: { ...gitAuthEnv(await this.#load()), ...options.env } });
  }
}

export class Sandbox {
  readonly url: string;
  readonly #token: string;
  readonly #getToken: (() => Promise<string>) | undefined;
  readonly #stateDir: string;
  readonly #runId: string;
  readonly cache: Git;

  constructor(options: SandboxOptions) {
    this.url = options.url;
    this.#token = options.token;
    this.#getToken = options.getToken;
    this.#stateDir = options.stateDir;
    this.#runId = options.runId;
    this.cache = this.git(join(options.stateDir, 'cache', 'sandbox.git'), HARNESS);
  }

  env(who: { name: string; email: string } = HARNESS): Record<string, string> {
    // A stalled transfer (under 1 KB/s for a minute) fails instead of hanging the run.
    return { ...gitAuthEnv(this.#token), ...identityEnv(who), GIT_LFS_SKIP_SMUDGE: '1', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };
  }

  private git(dir: string, who = HARNESS): Git {
    const load = this.#getToken;
    const base = this.env(who);
    return load === undefined ? new Git(dir, base) : new CredentialGit(dir, base, load);
  }

  /** Brings the shared cache up to date with the sandbox's main branch. */
  async refreshCache(): Promise<string> {
    const lock = await acquireLock('sandbox-cache', { stateDir: this.#stateDir, runId: this.#runId, timeoutMs: 10 * 60_000 });
    try {
      if (!existsSync(join(this.cache.dir, 'HEAD'))) {
        mkdirSync(dirname(this.cache.dir), { recursive: true });
        await this.git(dirname(this.cache.dir)).run(['clone', '--quiet', '--bare', '--filter=blob:none', '--single-branch', '--branch', 'main', this.url, this.cache.dir]);
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
  async createTrackedBranch(slice: string, names: RunNames, options: { checks?: boolean; teams?: readonly string[]; validate?: (selected: SliceList) => Promise<void> } = {}): Promise<{ tree: RunTree; commit: string }> {
    const sliceText = await this.readMain(`${SLICES_DIR}/${slice}.json`);
    if (sliceText === null) throw new CorpusMissingError(`the sandbox's main has no ${SLICES_DIR}/${slice}.json (the corpus is not there yet)`);
    const list = parseSlice(sliceText, slice);
    const entries = new Map<string, { mode: string; oid: string }>();
    const listing = await this.cache.text(['ls-tree', '-r', '-z', '--full-tree', `refs/heads/main:${CORPUS_DIR}`]);
    for (const record of listing.split('\0')) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (match !== null) entries.set(match[3] as string, { mode: match[1] as string, oid: match[2] as string });
    }
    for (const path of list.paths) {
      if (!entries.has(path)) throw new CorpusMissingError(`slice ${slice} names ${path}, which is not in ${CORPUS_DIR}/`);
    }
    // Markdown texts, for the annotations and for the links the run tree relinks.
    const markdown = list.paths.filter((path) => path.endsWith('.md'));
    const read = await this.blobTexts(markdown.map((path) => (entries.get(path) as { oid: string }).oid));
    const texts = new Map<string, string>();
    markdown.forEach((path, index) => {
      const text = read[index];
      if (text !== undefined) texts.set(path, text);
    });
    const readmes = new Map(markdown.filter((path) => /(^|\/)README\.md$/.test(path)).map((path) => [path, texts.get(path) ?? '']));
    const selected = options.teams === undefined ? list : selectTeams(list, readmes, options.teams);
    await options.validate?.(selected);
    const selectedReadmes = new Map([...readmes].filter(([path]) => selected.paths.includes(path)));
    const tree = relinkRunTree(buildRunTree(selected, selectedReadmes, names), texts);
    // Only check-fault scenarios opt into runner jobs. Other scenarios keep
    // their workflow-free starting tree.
    if (options.checks !== true) tree.paths.delete(CHECK_WORKFLOW_PATH);
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

  /** The text of each blob, in order, read from the cache in one call; undefined for bytes that are not valid UTF-8. */
  async blobTexts(oids: readonly string[]): Promise<Array<string | undefined>> {
    if (oids.length === 0) return [];
    const { stdout } = await this.cache.run(['cat-file', '--batch'], { input: `${oids.join('\n')}\n` });
    const texts: Array<string | undefined> = [];
    let at = 0;
    for (const oid of oids) {
      const end = stdout.indexOf(0x0a, at);
      const header = /^([0-9a-f]+) blob (\d+)$/.exec(stdout.subarray(at, end).toString('utf8'));
      if (header === null || header[1] !== oid) throw new Error(`the sandbox cache has no blob ${oid}`);
      const size = Number(header[2]);
      const bytes = stdout.subarray(end + 1, end + 1 + size);
      const text = bytes.toString('utf8');
      texts.push(Buffer.from(text, 'utf8').equals(bytes) ? text : undefined);
      at = end + 1 + size + 1;
    }
    return texts;
  }

  /** A working clone of the run's tracked branch (no LFS content), for the engine or for a person. */
  async clone(names: RunNames, dir: string): Promise<Git> {
    mkdirSync(dirname(dir), { recursive: true });
    await this.git(dirname(dir)).run([
      'clone', '--quiet', '--reference-if-able', this.cache.dir, '--single-branch', '--branch', names.trackedBranch, this.url, dir,
    ]);
    return this.git(dir, PERSON);
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

/** A pre-commit hook refused a person's commit; nothing was committed and the clone is back at its last commit. */
export class HookRejectedError extends ProductError {
  /** The ids of the hooks that failed, in pre-commit's order. */
  readonly hooks: string[];
  constructor(hooks: string[]) {
    super(`a pre-commit hook refused the commit (${hooks.length === 0 ? 'no hook id reported' : hooks.join(', ')})`);
    this.name = 'HookRejectedError';
    this.hooks = hooks;
  }
}

/**
 * Installs the repository's pre-commit hooks in a person's clone, as a person
 * does after cloning: `pre-commit install`, with the hook environments built
 * now so the first commit does not pay for them. Every remote hook repository
 * must be pinned to a full commit SHA (the released hook), not a placeholder.
 * A clone without a pre-commit configuration has no hooks to install.
 *
 * The installation sees only `hookEnv(options.from)`: npm and the hooks' own
 * install code run here, and they never get the harness's secrets. An npm
 * that refuses pre-commit's Git package (older than 11.16.0), a network,
 * registry or host failure, a missing pre-commit or a timeout blocks the run;
 * any other npm failure is the released hook's own defect.
 */
export async function installHooks(git: Git, options: { from?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  const text = existsSync(join(git.dir, PRE_COMMIT_CONFIG)) ? readFileSync(join(git.dir, PRE_COMMIT_CONFIG), 'utf8') : null;
  if (text === null) return;
  let config: unknown;
  try {
    config = parse(text);
  } catch {
    throw new EnvBlockedError(`the repository's ${PRE_COMMIT_CONFIG} is not valid YAML`);
  }
  const repos = (config as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) throw new EnvBlockedError(`the repository's ${PRE_COMMIT_CONFIG} has no "repos" list`);
  for (const entry of repos as Array<{ repo?: unknown; rev?: unknown }>) {
    if (typeof entry.repo === 'string' && LOCAL_REPOS.has(entry.repo)) continue;
    try {
      validateSha(String(entry.rev));
    } catch {
      throw new EnvBlockedError(`the repository's pre-commit configuration pins a hook to "${String(entry.rev)}", not a released commit SHA`);
    }
  }
  try {
    // Building a Node hook's environment runs npm, which can take minutes; the run's other work goes on meanwhile.
    await execFileAsync('pre-commit', ['install', '--install-hooks'], {
      cwd: git.dir,
      env: hookEnv(options.from),
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? 15 * 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const failure = error as { code?: unknown; name?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    if (failure.name === 'AbortError') throw error;
    if (failure.code === 'ENOENT') throw new EnvBlockedError('pre-commit is not installed on this host');
    if (failure.killed === true) throw new EnvBlockedError("installing the repository's pre-commit hooks timed out");
    throw installFailure(`${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

/**
 * Variables the hook installer and the hooks see: tool discovery, locale,
 * temporary and cache folders, and the network settings a host may need to
 * reach GitHub and the npm registry (proxies, extra CA certificates). Never
 * the harness's secrets, and no git or npm configuration from the
 * environment, which can carry credentials.
 */
export const HOOK_ENV_KEYS: readonly string[] = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CACHE_HOME', 'PRE_COMMIT_HOME',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** The allowlisted environment for pre-commit and what it starts (as engineEnv is for the engine). */
export function hookEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // No prompt: a hook repository that asks for credentials fails at once instead of waiting on the terminal.
  const allowed: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of HOOK_ENV_KEYS) {
    const value = from[key];
    if (value !== undefined) allowed[key] = value;
  }
  return allowed;
}

/** A clone's commit identity, as git resolves it there; the hooks' commit keeps it. */
async function commitIdentity(git: Git): Promise<Record<string, string>> {
  const identity: Record<string, string> = {};
  for (const role of ['AUTHOR', 'COMMITTER'] as const) {
    const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(await git.text(['var', `GIT_${role}_IDENT`]));
    if (match === null) throw new Error(`git reports no ${role.toLowerCase()} identity`);
    identity[`GIT_${role}_NAME`] = match[1] as string;
    identity[`GIT_${role}_EMAIL`] = match[2] as string;
  }
  return identity;
}

/** npm's failures of the network, the registry or the host, not of the hook. */
const NPM_HOST_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'EPIPE', 'ERR_SOCKET_TIMEOUT', 'EPROTO', 'FETCH_ERROR', 'E429',
  'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENOMEM',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** What a failed hook installation means, from pre-commit's output; the reason names npm's error code, never paths or output. */
export function installFailure(output: string): Error {
  const code = /npm error code (\w+)/.exec(output)?.[1];
  if (code === undefined) return new EnvBlockedError("the repository's pre-commit hooks could not be installed");
  if (code === 'EALLOWGIT') return new EnvBlockedError("the repository's Node hooks need npm 11.16.0 or newer (npm EALLOWGIT)");
  // A registry outage answers with a 5xx status.
  if (NPM_HOST_CODES.has(code) || /^E5\d\d$/.test(code)) return new EnvBlockedError(`the repository's pre-commit hooks could not be fetched or installed on this host (npm ${code})`);
  return new ProductError(`the repository's released pre-commit hooks could not be installed (npm ${code})`);
}

/** The ids of the hooks pre-commit reports as failed. */
export function failedHooks(output: string): string[] {
  return [...output.matchAll(/^- hook id: (\S+)$/gm)].map((match) => match[1] as string);
}

/**
 * Writes or removes files in a person's clone, commits and pushes to the
 * tracked branch. With `verify`, the commit goes through the clone's installed
 * hooks: when a hook fixes the files, the fixed files are staged and committed
 * again, as a person does; when a hook refuses them, nothing is committed, the
 * clone goes back to its last commit and HookRejectedError names the hooks.
 */
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
  await commitStaged(git, [...changes.keys()], message, options.verify);
  // Objects first, so a pushed pointer never names an object the server lacks (a bypassed pre-push hook would skip it).
  if (binary) await git.run(['lfs', 'push', 'origin', 'HEAD']);
  await git.run(['push', '--quiet', ...(options.verify ? [] : ['--no-verify']), 'origin', `HEAD:refs/heads/${options.branch ?? names.trackedBranch}`]);
  return (await git.text(['rev-parse', 'HEAD'])).trim();
}

/**
 * Commits what is staged in a person's clone. With `verify`, through the
 * clone's installed hooks: what a hook fixed among `paths` is staged and
 * committed again, as a person does. A commit that still fails puts the
 * clone back at its last commit; a hook's refusal is HookRejectedError, any
 * other failure is git's own error.
 */
export async function commitStaged(git: Git, paths: readonly string[], message: string, verify: boolean): Promise<void> {
  if (!verify) {
    await git.run(['commit', '--quiet', '--no-verify', '-m', message]);
    return;
  }
  // The hooks run inside the commit and may build a hook environment: they see only the allowlist and the identity.
  const env = { ...hookEnv(), ...(await commitIdentity(git)) };
  let failure: GitError | undefined;
  // The second try commits what the hooks fixed; a hook that fails again then refuses the files.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await git.run(['commit', '--quiet', '-m', message], { onlyEnv: env });
      return;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      failure = error;
    }
    if (failedHooks(failure.stderr).length === 0) break;
    const fixed = (await git.text(['diff', '--name-only', '-z', '--', ...paths])).split('\0').filter((path) => path !== '');
    if (fixed.length === 0) break;
    await git.run(['add', '--', ...fixed]);
  }
  await git.run(['reset', '--quiet', '--hard', 'HEAD']);
  const hooks = failedHooks(failure?.stderr ?? '');
  throw hooks.length === 0 ? failure : new HookRejectedError(hooks);
}
