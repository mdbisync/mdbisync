// Object reads through one long-lived `git cat-file --batch-command`.

import { message } from '../messages.ts';
import { BatchProcess } from './batch.ts';
import type { Oid } from './git.ts';

export interface ObjectInfo {
  oid: Oid;
  type: string;
  size: number;
}

export interface GitObject extends ObjectInfo {
  content: Buffer;
}

interface Request {
  name: string;
  contents: boolean;
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/;

/** True for a name the line-based protocol carries as it is. */
export function batchName(name: string): boolean {
  return name !== '' && !/[\n\r\0]/.test(name) && name.trim() === name;
}

export class ObjectReader {
  private readonly process: BatchProcess<Request, GitObject | ObjectInfo | null>;

  /**
   * @param dir the directory the process runs in
   * @param env the environment of the process
   * @param objectDirectory gives the absolute path of the repository's object directory
   */
  constructor(dir: string, env: () => Record<string, string | undefined>, objectDirectory: () => Promise<string>) {
    this.process = new BatchProcess({ dir, args: ['cat-file', '--batch-command'], env, objectDirectory, parse });
  }

  /** The object a name resolves to, with its content; null when the name resolves to no object. */
  contents(name: string): Promise<GitObject | null> {
    return this.ask(name, true) as Promise<GitObject | null>;
  }

  /** The id, type and size of the object a name resolves to; null when it resolves to no object. */
  info(name: string): Promise<ObjectInfo | null> {
    return this.ask(name, false) as Promise<ObjectInfo | null>;
  }

  private async ask(name: string, contents: boolean): Promise<GitObject | ObjectInfo | null> {
    if (!batchName(name)) throw new Error(message('objects.batch-name', { name: JSON.stringify(name) }));
    return this.process.request(`${contents ? 'contents' : 'info'} ${name}\n`, { name, contents });
  }
}

/** One answer of `cat-file --batch-command`: `<oid> <type> <size>`, then the content and a newline for `contents`; `<name> missing` when there is none. */
function parse(buffer: Buffer, request: Request): { answer: GitObject | ObjectInfo | null; bytes: number } | { need: number } | undefined {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) return undefined;
  const header = buffer.subarray(0, newline).toString('utf8');
  const match = HEADER.exec(header);
  if (match === null) {
    if (header === `${request.name} missing` || header === `${request.name} ambiguous`) return { answer: null, bytes: newline + 1 };
    throw new Error(message('git.unreadable-answer', { command: 'cat-file' }));
  }
  const info: ObjectInfo = { oid: match[1] as Oid, type: match[2] as string, size: Number(match[3]) };
  if (!request.contents) return { answer: info, bytes: newline + 1 };
  const end = newline + 1 + info.size;
  if (buffer.length < end + 1) return { need: end + 1 };
  return { answer: { ...info, content: Buffer.from(buffer.subarray(newline + 1, end)) }, bytes: end + 1 };
}
