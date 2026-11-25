// A thin runner for the git command line. Commands start from a small helper
// process (spawner.ts), and objects are read and written through long-lived
// git processes (object-reader.ts, object-writer.ts) instead of one process
// each. The engine never prints document content: errors carry the git
// arguments, the exit code and git's own error output, never the data passed
// on standard input or read back.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { message } from '../messages.ts';
import { type GitObject, type ObjectInfo, ObjectReader, batchName } from './object-reader.ts';
import { ObjectWriter } from './object-writer.ts';
import { spawnGit } from './spawner.ts';
import { type TreeEntry, readBlobBatch, readTreeListing } from './objects.ts';

export type Oid = string;

export interface RunOptions {
  /** Data written to the command's standard input. */
  input?: Buffer | string;
  /** Extra environment; a value of `undefined` removes the variable. */
  env?: Record<string, string | undefined>;
  /**
   * The whole environment of this call, with only the runner's base settings
   * under it: neither the process's environment nor the runner's own is
   * inherited. For commands that run code which must not see them (hooks).
   */
  onlyEnv?: Record<string, string>;
  /** Exit codes that are not an error (default: only 0). */
  okCodes?: readonly number[];
  /** Maximum stdout bytes to collect. Bounded calls cap stderr separately. */
  maxOutputBytes?: number | undefined;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: readonly string[], code: number, stderr: string) {
    super(message('git.failed', { args: args.join(' '), code, stderr: stderr.trim() }));
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export class GitOutputLimitError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(message('git.output-limit', { bytes }));
    this.name = 'GitOutputLimitError';
    this.bytes = bytes;
  }
}

/** Environment every git call gets: no prompts, no LFS download on checkout, stable messages. */
const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  LC_ALL: 'C',
};

/**
 * Git commands in one repository. What it learns of the repository once
 * (its object format, folders and message encoding) holds for the life of
 * the instance: an instance belongs to one repository, not to a path.
 */
export class Git {
  readonly dir: string;
  private readonly env: Record<string, string | undefined>;

  /**
   * @param dir a directory inside the repository (a working tree or a bare repository)
   * @param env environment added to every call
   */
  constructor(dir: string, env: Record<string, string | undefined> = {}) {
    this.dir = dir;
    this.env = env;
  }

  private environment(options: RunOptions): Record<string, string> {
    const env: Record<string, string | undefined> =
      options.onlyEnv !== undefined ? { ...BASE_ENV, ...options.onlyEnv } : { ...process.env, ...BASE_ENV, ...this.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }
    return env as Record<string, string>;
  }

  private reader: ObjectReader | undefined;
  private writer: ObjectWriter | undefined;
  private format: Promise<string> | undefined;

  /** The absolute path of the repository's object directory, for the long-lived processes to notice a repository made again. */
  private readonly objectDirectory = (): Promise<string> => {
    this.objectPath ??= this.text(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).catch((error: unknown) => {
      this.objectPath = undefined;
      throw error;
    });
    return this.objectPath;
  };
  private objectPath: Promise<string> | undefined;

  /**
   * Reads objects through one long-lived git process instead of a process
   * per read. Names are revisions as `git cat-file` takes them (`<oid>`,
   * `<commit>:<path>`, `<ref>^{commit}`).
   */
  private objects(): ObjectReader {
    this.reader ??= new ObjectReader(this.dir, () => this.environment({}), this.objectDirectory);
    return this.reader;
  }

  /** Writes blobs and trees through long-lived git processes instead of a process per object. */
  objectWriter(): ObjectWriter {
    this.writer ??= new ObjectWriter(this.dir, () => this.environment({}), this.objectDirectory);
    return this.writer;
  }

  /** The object a name resolves to, with its content; null when it resolves to none. */
  async readObject(name: string): Promise<GitObject | null> {
    if (batchName(name)) return this.objects().contents(name);
    const found = await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', name], { okCodes: [0, 1, 128] });
    if (found.code !== 0) return null;
    const oid = found.stdout.toString('utf8').trim();
    return this.objects().contents(oid);
  }

  /**
   * Every file of a commit or tree, recursively, as `git ls-tree -r -l`
   * lists them (see `listTree` in objects.ts).
   */
  listTree(treeish: string, maxOutputBytes?: number): Promise<TreeEntry[]> {
    return readTreeListing(this, treeish, maxOutputBytes);
  }

  /** Blobs by id, one batch (see `readBlobs` in objects.ts). */
  readBlobs(oids: readonly Oid[], maxOutputBytes?: number): Promise<Map<Oid, Buffer>> {
    return readBlobBatch(this, oids, maxOutputBytes);
  }

  /** The content of the blob a name resolves to, as `git cat-file blob` gives it; null when it resolves to no blob. */
  async readBlob(name: string, maxBytes?: number): Promise<Buffer | null> {
    if (maxBytes === undefined) {
      const found = await this.readObject(name);
      return found?.type === 'blob' ? found.content : null;
    }
    const info = await this.objectInfo(name);
    if (info?.type !== 'blob') return null;
    if (info.size > maxBytes) throw new GitOutputLimitError(maxBytes);
    return (await this.objects().contents(info.oid))?.content ?? null;
  }

  /**
   * The id a name resolves to, as `git rev-parse <name>` gives it: read
   * through the object reader, and from `rev-parse` itself (with its error)
   * when the reader finds no object.
   */
  async revParse(name: string): Promise<Oid> {
    return (await this.objectInfo(name))?.oid ?? this.text(['rev-parse', name]);
  }

  /**
   * What `git show <name>` gives: for a blob its content, read through the
   * object reader; anything else, and a name that resolves to nothing, is
   * left to `git show` itself.
   */
  async showBlob(name: string, options: RunOptions = {}): Promise<RunResult> {
    const found = await this.readObject(name);
    if (found?.type === 'blob') return { code: 0, stdout: found.content, stderr: '' };
    return this.run(['show', name], options);
  }

  /** The id, type and size of the object a name resolves to; null when it resolves to none. */
  async objectInfo(name: string): Promise<ObjectInfo | null> {
    if (batchName(name)) return this.objects().info(name);
    const found = await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', name], { okCodes: [0, 1, 128] });
    if (found.code !== 0) return null;
    return this.objects().info(found.stdout.toString('utf8').trim());
  }

  private plain: Promise<boolean> | undefined;

  /**
   * True when git prints commit messages as stored, without re-encoding:
   * the repository sets no message encoding other than UTF-8
   * (`i18n.commitEncoding`, `i18n.logOutputEncoding`).
   */
  plainMessages(): Promise<boolean> {
    this.plain ??= this.run(['config', '--get-regexp', '^i18n\\.(commitencoding|logoutputencoding)$'], { okCodes: [0, 1] }).then(
      ({ stdout }) => stdout.toString('utf8').split('\n').filter(Boolean).every((line) => /^\S+ utf-?8$/i.test(line)),
      (error: unknown) => {
        this.plain = undefined;
        throw error;
      },
    );
    return this.plain;
  }

  private common: Promise<string> | undefined;

  /**
   * True when git reads some commits' parents other than as stored: a
   * shallow repository cuts history at its boundary, and grafts replace
   * parents. Checked on every call, as a fetch can make a repository shallow.
   */
  async rewritesHistory(): Promise<boolean> {
    this.common ??= this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']).catch((error: unknown) => {
      this.common = undefined;
      throw error;
    });
    const common = await this.common;
    return existsSync(join(common, 'shallow')) || existsSync(join(common, 'info', 'grafts'));
  }

  /** The repository's object format, `sha1` or `sha256`; it does not change while the repository exists. */
  objectFormat(): Promise<string> {
    this.format ??= this.text(['rev-parse', '--show-object-format']).catch((error: unknown) => {
      this.format = undefined;
      throw error;
    });
    return this.format;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const okCodes = options.okCodes ?? [0];
    // A command that exits before reading all its input closes the pipe; the exit code tells what happened.
    const result = await spawnGit({ args, cwd: this.dir, env: this.environment(options), input: options.input ?? '', ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }) });
    if (result.exceeded !== undefined) throw new GitOutputLimitError(result.exceeded);
    const { code, stdout, stderr } = result;
    if (!okCodes.includes(code)) throw new GitError(args, code, stderr);
    return { code, stdout, stderr };
  }

  /**
   * Runs git and writes its standard output to a new file at `path` as it
   * arrives, so output of any size is never held in memory. Standard error
   * is capped at 64 KiB. A failing exit is a `GitError`.
   */
  async runToFile(args: readonly string[], path: string, fileMode: number): Promise<void> {
    const { code, stderr } = await spawnGit({ args, cwd: this.dir, env: this.environment({}), file: { path, mode: fileMode } });
    if (code !== 0) throw new GitError(args, code, stderr);
  }

  /** Runs git and returns standard output as text without the final newline. */
  async text(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const { stdout } = await this.run(args, options);
    return stdout.toString('utf8').replace(/\n$/, '');
  }
}

/** Runs `fn` over `items` with at most `limit` calls at a time, keeping the order of results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
