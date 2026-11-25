// Long-lived git processes that answer one request after another
// (`cat-file --batch-command`, `hash-object --stdin-paths`, `mktree --batch`),
// so a run reads and writes objects without starting a git process for each.
// Answers come in the order the requests were written. None of these
// processes keeps anything between requests that could go stale: git
// resolves each name again and finds objects written or fetched after it
// started. A process ends after a moment without requests, and a
// repository made again under the same path gets a new one.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { GitError } from './git.ts';

/** How long a process waits for its next request before it ends. */
const IDLE_MS = 1000;

/**
 * Reads one answer from the start of `buffer`: the answer and the bytes it
 * took; while the answer is not complete, how many bytes it needs if that
 * is known, or undefined.
 */
export type Parse<Request, Answer> = (buffer: Buffer, request: Request) => { answer: Answer; bytes: number } | { need: number } | undefined;

interface Pending<Request, Answer> {
  request: Request;
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
}

/** Requests in the order they were written; taking the first one costs the same however many wait. */
class Queue<T> {
  private items: T[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  first(): T | undefined {
    return this.items[this.head];
  }

  shift(): void {
    this.head++;
    // The answered part is dropped once it is most of the array.
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  drain(): T[] {
    const rest = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    return rest;
  }
}

interface Running<Request, Answer> {
  child: ChildProcessWithoutNullStreams;
  identity: string;
  pending: Queue<Pending<Request, Answer>>;
  /** Output not parsed yet, in the chunks it came in, and their length. */
  chunks: Buffer[];
  length: number;
  /** Bytes the first answer needs before it is worth parsing again. */
  need: number;
  stderr: string;
  idle: NodeJS.Timeout | undefined;
}

export interface BatchOptions<Request, Answer> {
  /** The directory the process runs in. */
  dir: string;
  args: readonly string[];
  env: () => Record<string, string | undefined>;
  /** The absolute path of the repository's object directory. */
  objectDirectory: () => Promise<string>;
  parse: Parse<Request, Answer>;
  /** Called when the process has no request left to answer. */
  onIdle?: () => void;
}

export class BatchProcess<Request, Answer> {
  private readonly options: BatchOptions<Request, Answer>;
  private running: Running<Request, Answer> | undefined;
  private starting: Promise<Running<Request, Answer>> | undefined;
  private directory: string | undefined;

  constructor(options: BatchOptions<Request, Answer>) {
    this.options = options;
  }

  /** Writes `input` and waits for its answer. */
  async request(input: string | Buffer, request: Request): Promise<Answer> {
    let running = this.running;
    if (running === undefined || this.directory === undefined || identityOf(this.directory) !== running.identity) running = await this.start();
    const current = running;
    return new Promise((resolve, reject) => {
      if (current.idle !== undefined) clearTimeout(current.idle);
      current.idle = undefined;
      if (current.pending.size === 0) hold(current.child, true);
      current.pending.push({ request, resolve, reject });
      current.child.stdin.write(input);
    });
  }

  /** Ends the process; the next request starts a new one. */
  close(): void {
    const running = this.running;
    this.running = undefined;
    if (running === undefined) return;
    if (running.idle !== undefined) clearTimeout(running.idle);
    running.child.stdin.end();
  }

  private start(): Promise<Running<Request, Answer>> {
    if (this.starting === undefined) {
      const starting = (async () => {
        this.close();
        // The path stays; what is at the path may be another repository's directory.
        this.directory ??= await this.options.objectDirectory();
        const running = this.spawn(this.directory);
        this.running = running;
        return running;
      })();
      // Cleared once settled, never before it is set: the start may finish without waiting for anything.
      this.starting = starting;
      const clear = () => { if (this.starting === starting) this.starting = undefined; };
      starting.then(clear, clear);
    }
    return this.starting;
  }

  private spawn(directory: string): Running<Request, Answer> {
    const { dir, args, env } = this.options;
    // Each answer must come as soon as it is ready, whatever the caller's GIT_FLUSH says.
    const child = spawn('git', args, { cwd: dir, env: { ...env(), GIT_FLUSH: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const running: Running<Request, Answer> = { child, identity: identityOf(directory), pending: new Queue(), chunks: [], length: 0, need: 0, stderr: '', idle: undefined };
    child.stdout.on('data', (chunk: Buffer) => this.receive(running, chunk));
    child.stderr.on('data', (chunk: Buffer) => { if (running.stderr.length < 64 * 1024) running.stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      if (running.idle !== undefined) clearTimeout(running.idle);
      if (this.running === running) this.running = undefined;
      const error = new GitError(args, code, running.stderr);
      const waiting = running.pending.drain();
      for (const request of waiting) request.reject(error);
      if (waiting.length > 0) this.options.onIdle?.();
    };
    child.on('error', () => end(-1));
    child.on('close', (code) => end(code ?? -1));
    hold(child, false);
    return running;
  }

  private receive(running: Running<Request, Answer>, chunk: Buffer): void {
    running.chunks.push(chunk);
    running.length += chunk.length;
    // A large answer comes in many chunks: they are joined once it is all there.
    if (running.length < running.need) return;
    let buffered = running.chunks.length === 1 ? running.chunks[0] as Buffer : Buffer.concat(running.chunks);
    running.chunks = [buffered];
    while (running.pending.size > 0) {
      const waiting = running.pending.first() as Pending<Request, Answer>;
      let parsed: ReturnType<Parse<Request, Answer>>;
      try {
        parsed = this.options.parse(buffered, waiting.request);
      } catch (error) {
        this.broken(running, error as Error);
        return;
      }
      if (parsed === undefined || 'need' in parsed) {
        running.need = parsed === undefined ? buffered.length + 1 : parsed.need;
        break;
      }
      buffered = buffered.subarray(parsed.bytes);
      running.chunks = buffered.length === 0 ? [] : [buffered];
      running.length = buffered.length;
      running.need = 0;
      running.pending.shift();
      if (running.pending.size === 0) this.rest(running);
      waiting.resolve(parsed.answer);
    }
  }

  /** Nothing waits: the process must not keep the program running, and it ends unless a request comes soon. */
  private rest(running: Running<Request, Answer>): void {
    hold(running.child, false);
    running.idle = setTimeout(() => { if (this.running === running) this.close(); }, IDLE_MS);
    running.idle.unref();
    this.options.onIdle?.();
  }

  private broken(running: Running<Request, Answer>, cause: Error): void {
    if (this.running === running) this.running = undefined;
    const error = new GitError(this.options.args, -1, cause.message);
    for (const waiting of running.pending.drain()) waiting.reject(error);
    running.child.kill('SIGKILL');
    this.options.onIdle?.();
  }
}

/** Reads one line; its text without the line break. */
export function parseLine(buffer: Buffer): { answer: string; bytes: number } | undefined {
  const newline = buffer.indexOf(0x0a);
  return newline < 0 ? undefined : { answer: buffer.subarray(0, newline).toString('utf8'), bytes: newline + 1 };
}

/** While nothing waits for an answer, the process must not keep the program running. */
function hold(child: ChildProcessWithoutNullStreams, waiting: boolean): void {
  // The standard streams of a child are sockets over pipes.
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as { ref(): void; unref(): void }[]) {
    if (waiting) handle.ref();
    else handle.unref();
  }
}

/** The device and inode of a directory: a directory made again under the same path has another. */
function identityOf(directory: string): string {
  try {
    const stat = statSync(directory);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return 'missing';
  }
}
