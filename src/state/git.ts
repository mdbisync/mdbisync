// A thin runner for the git command line. The engine never prints document
// content: errors carry the git arguments, the exit code and git's own
// error output, never the data passed on standard input or read back.

import { spawn } from 'node:child_process';
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

  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const env: Record<string, string | undefined> =
      options.onlyEnv !== undefined ? { ...BASE_ENV, ...options.onlyEnv } : { ...process.env, ...BASE_ENV, ...this.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }
    const okCodes = options.okCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', reject);
      // A command that exits before reading all its input closes the pipe;
      // the exit code tells what happened.
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
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
