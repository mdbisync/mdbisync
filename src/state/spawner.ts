// Git commands start from one small helper process instead of from this
// one. Starting a process copies the starting process's memory map, and a
// large program (the engine with a whole repository's documents loaded, or
// a test run) spends milliseconds of its own time on every git command that
// way; the helper is small, so the same start costs it a fraction of that
// and the program does not wait. The helper starts each command with
// exactly the arguments, environment, folder and input given, and collects
// its output under the same limits as before.

import { type ChildProcess, spawn } from 'node:child_process';
import { message } from '../messages.ts';

export interface SpawnRequest {
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Standard input; for `file`, standard input is closed. */
  input?: Buffer | string;
  /** Maximum stdout bytes to collect; past it the command is killed. Standard error is then capped at 64 KiB. */
  maxOutputBytes?: number;
  /** Writes standard output to a new file here instead of collecting it; only the first 64 KiB of standard error are kept. */
  file?: { path: string; mode: number };
}

export interface SpawnResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** Set when stdout passed `maxOutputBytes`. */
  exceeded?: number;
}

/** An error the helper met, rebuilt with its message and system error fields. */
interface SpawnFailure {
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

type Reply = { id: number; result: SpawnResult } | { id: number; failure: SpawnFailure };

// The helper, run with `node -e` so that it needs no file of its own next to the bundles.
const HELPER = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const failure = (error) => ({ message: String(error && error.message), code: error && error.code, errno: error && error.errno, syscall: error && error.syscall, path: error && error.path });
const reply = (message) => { if (process.connected) process.send(message); };
function run(id, request) {
  const child = spawn('git', request.args, { cwd: request.cwd, env: request.env, stdio: [request.file ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  let exceeded;
  const collector = (chunks, limit) => {
    let bytes = 0;
    return (chunk) => {
      if (exceeded !== undefined) return;
      bytes += chunk.length;
      if (limit !== undefined && bytes > limit) {
        exceeded = limit;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
  };
  // A bounded call stops the command when its standard error passes 64 KiB as well; a call that streams to a file
  // keeps the first 64 KiB of it and lets the command finish.
  let kept = 0;
  const firstPart = (chunk) => { if (kept < 64 * 1024) { kept += chunk.length; err.push(chunk); } };
  if (!request.file) child.stdout.on('data', collector(out, request.maxOutputBytes));
  child.stderr.on('data', request.file ? firstPart : collector(err, request.maxOutputBytes !== undefined ? 64 * 1024 : undefined));
  let failed;
  const exited = new Promise((resolve) => {
    child.on('error', (error) => { failed = error; resolve(-1); });
    child.on('close', (code) => resolve(code === null ? -1 : code));
  });
  if (!request.file) {
    child.stdin.on('error', () => {});
    child.stdin.end(request.input === undefined ? '' : request.input);
  }
  const copied = request.file
    ? pipeline(child.stdout, createWriteStream(request.file.path, { flags: 'wx', mode: request.file.mode })).catch((error) => { child.kill('SIGKILL'); throw error; })
    : Promise.resolve();
  copied.then(() => exited).then((code) => {
    if (failed !== undefined) return reply({ id, failure: failure(failed) });
    reply({ id, result: { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), exceeded } });
  }, (error) => exited.then(() => reply({ id, failure: failure(failed === undefined ? error : failed) })));
}
process.on('message', ({ id, request }) => {
  // A command that cannot even start (an argument with a NUL in it) fails alone.
  try { run(id, request); } catch (error) { reply({ id, failure: failure(error) }); }
});
process.on('disconnect', () => process.exit(0));
`;

interface Pending {
  resolve: (result: SpawnResult) => void;
  reject: (error: Error) => void;
}

let helper: ChildProcess | undefined;
const pending = new Map<number, Pending>();
let nextId = 0;

function start(): ChildProcess {
  // Options meant for this program (an inspector port, a preloaded module) are not the helper's.
  const { NODE_OPTIONS: _options, ...env } = process.env;
  const child = spawn(process.execPath, ['-e', HELPER], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', env });
  child.on('message', (message: Reply) => {
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (pending.size === 0) hold(child, false);
    if ('result' in message) waiting.resolve({ ...message.result, stdout: Buffer.from(message.result.stdout) });
    else waiting.reject(Object.assign(new Error(message.failure.message), withoutUndefined(message.failure)));
  });
  const end = (error: Error) => {
    if (helper === child) helper = undefined;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(error);
    }
  };
  child.on('error', end);
  child.on('exit', (code, signal) => end(new Error(message('git.starter-ended', { reason: String(signal ?? code) }))));
  hold(child, false);
  return child;
}

/** While no command runs, the helper must not keep the program running. */
function hold(child: ChildProcess, waiting: boolean): void {
  const channel = child.channel as { ref(): void; unref(): void } | null | undefined;
  if (waiting) {
    child.ref();
    channel?.ref();
  } else {
    child.unref();
    channel?.unref();
  }
}

function withoutUndefined(failure: SpawnFailure): Partial<SpawnFailure> {
  return Object.fromEntries(Object.entries(failure).filter(([key, value]) => key !== 'message' && value !== undefined && value !== null));
}

/** Runs git through the helper; a command that cannot start rejects with the system error. */
export function spawnGit(request: SpawnRequest): Promise<SpawnResult> {
  helper ??= start();
  const child = helper;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (pending.size === 0) hold(child, true);
    pending.set(id, { resolve, reject });
    child.send({ id, request });
  });
}
