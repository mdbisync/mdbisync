// A thin runner for the git command line. The engine never prints document
// content: errors carry the git arguments, the exit code and git's own
// error output, never the data passed on standard input or read back.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { message } from '../messages.ts';

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

  private environment(options: RunOptions): Record<string, string | undefined> {
    const env: Record<string, string | undefined> =
      options.onlyEnv !== undefined ? { ...BASE_ENV, ...options.onlyEnv } : { ...process.env, ...BASE_ENV, ...this.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }
    return env;
  }

  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const env = this.environment(options);
    const okCodes = options.okCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let exceededLimit: number | undefined;
      const collector = (chunks: Buffer[], limit?: number) => {
        let bytes = 0;
        return (chunk: Buffer) => {
          if (exceededLimit !== undefined) return;
          bytes += chunk.length;
          if (limit !== undefined && bytes > limit) {
            exceededLimit = limit;
            child.kill('SIGKILL');
            return;
          }
          chunks.push(chunk);
        };
      };
      child.stdout.on('data', collector(out, options.maxOutputBytes));
      child.stderr.on('data', collector(err, options.maxOutputBytes === undefined ? undefined : 64 * 1024));
      child.on('error', reject);
      // A command that exits before reading all its input closes the pipe;
      // the exit code tells what happened.
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        if (exceededLimit !== undefined) {
          reject(new GitOutputLimitError(exceededLimit));
          return;
        }
        const result: RunResult = {
          code: code ?? -1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        };
        if (okCodes.includes(result.code)) resolve(result);
        else reject(new GitError(args, result.code, result.stderr));
      });
      child.stdin.end(options.input ?? '');
    });
  }

  /**
   * Runs git and writes its standard output to a new file at `path` as it
   * arrives, so output of any size is never held in memory. Standard error
   * is capped at 64 KiB. A failing exit is a `GitError`.
   */
  async runToFile(args: readonly string[], path: string, fileMode: number): Promise<void> {
    const child = spawn('git', args, { cwd: this.dir, env: this.environment({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
    // A spawn failure rejects `exited` while the copy below is still running; it is awaited after the copy.
    exited.catch(() => {});
    try {
      await pipeline(child.stdout, createWriteStream(path, { flags: 'wx', mode: fileMode }));
    } catch (error) {
      child.kill('SIGKILL');
      await exited.catch(() => {});
      throw error;
    }
    const code = await exited;
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
