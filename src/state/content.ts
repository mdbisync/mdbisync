import { message } from '../messages.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A private temporary file; candidate maps retain metadata rather than bytes. */
export interface SpooledFile { readonly file: string; readonly hash: string; readonly size: number }
export type FileContent = Buffer | string | SpooledFile;
export const isSpooled = (content: FileContent): content is SpooledFile => typeof content === 'object' && !Buffer.isBuffer(content);
export function contentBytes(content: FileContent): Buffer {
  if (!isSpooled(content)) return Buffer.from(content);
  const bytes = readFileSync(content.file);
  if (bytes.length !== content.size || createHash('sha256').update(bytes).digest('hex') !== content.hash) throw new Error(message('assets.spool-changed'));
  return bytes;
}

/** Lazily allocated; all files are removed by the owning operation's finally block. */
export class ContentSpool {
  #dir: string | undefined;
  #size = 0;
  #count = 0;
  readonly maxBytes: number;
  readonly maxFiles: number;
  constructor(maxBytes = 256 * 1024 * 1024, maxFiles = 256) { this.maxBytes = maxBytes; this.maxFiles = maxFiles; }
  put(bytes: Buffer): SpooledFile {
    if (this.#size + bytes.length > this.maxBytes || this.#count >= this.maxFiles) throw new Error(message('assets.spool-budget'));
    this.#dir ??= mkdtempSync(join(tmpdir(), 'capture-files-'));
    const file = join(this.#dir, String(this.#count));
    writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'});
    this.#count++;
    this.#size += bytes.length;
    return {file, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length};
  }
  close(): void {
    if (this.#dir !== undefined) rmSync(this.#dir, {recursive: true, force: true});
    this.#dir = undefined;
  }
}
