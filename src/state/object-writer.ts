// Object writes through long-lived git processes: blobs through
// `git hash-object -w --no-filters --stdin-paths`, trees through
// `git mktree -z --batch`. Git checks and stores every object as it does for
// one written by its own command.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message } from '../messages.ts';
import { BatchProcess, parseLine } from './batch.ts';
import { GitError, type Oid } from './git.ts';

export interface NewTreeEntry {
  /** Git file mode: `100644`, `100755`, `120000`, `160000` or `040000`. */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: Oid;
  /** The entry's name, one path part. */
  name: Buffer;
}

export class ObjectWriter {
  private readonly blobs: BatchProcess<string, string>;
  private readonly trees: BatchProcess<null, string>;
  /** Blob content waits in a file here while git reads it; the folder is there only while blobs are being written. */
  private folder: string | undefined;
  private files = 0;
  private writing = 0;
  /** Writes waiting for one of the `BLOBS_AT_ONCE` places, so the folder holds a bounded number of blobs. */
  private readonly waiting: (() => void)[] = [];

  /**
   * @param dir the directory the processes run in
   * @param env the environment of the processes
   * @param objectDirectory gives the absolute path of the repository's object directory
   */
  constructor(dir: string, env: () => Record<string, string | undefined>, objectDirectory: () => Promise<string>) {
    const oid = (buffer: Buffer) => parseLine(buffer);
    // `hash-object` writes all its objects in one transaction that ends when it exits. Two settings would keep a
    // blob out of sight of other git processes until then: batched fsync (objects wait in a temporary directory)
    // and a big-file threshold (large blobs wait in an unfinished pack). With these, each blob is stored as
    // `hash-object -w --stdin` stores it, and other processes see it at once.
    this.blobs = new BatchProcess({
      dir, env, objectDirectory, parse: oid,
      args: ['-c', 'core.fsyncMethod=fsync', '-c', `core.bigFileThreshold=${Number.MAX_SAFE_INTEGER}`, 'hash-object', '-w', '--no-filters', '--stdin-paths'],
    });
    this.trees = new BatchProcess({ dir, env, objectDirectory, parse: oid, args: ['mktree', '-z', '--batch'] });
  }

  /**
   * Stores content as a blob, exactly as given (no clean filters, no LFS).
   * Content given as a function is read only when the blob's turn comes.
   */
  async blob(content: Buffer | (() => Buffer)): Promise<Oid> {
    // A place freed by another write is handed over already counted.
    if (this.writing >= BLOBS_AT_ONCE) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.writing++;
    let path: string | undefined;
    try {
      this.folder ??= mkdtempSync(join(tmpdir(), 'blob-'));
      path = join(this.folder, String(this.files++));
      writeFileSync(path, typeof content === 'function' ? content() : content, { mode: 0o600 });
      return checkOid(await this.blobs.request(`${path}\n`, path), 'hash-object');
    } finally {
      if (path !== undefined) rmSync(path, { force: true });
      // A place freed goes straight to the next waiting write.
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else if (--this.writing === 0) this.clearFolder();
    }
  }

  /** Stores a tree of these entries; git sorts them. */
  async tree(entries: readonly NewTreeEntry[]): Promise<Oid> {
    const records = entries.map((entry) => {
      if (entry.name.length === 0 || entry.name.includes(0) || entry.name.includes(0x2f)) throw new Error(message('objects.invalid-entry-name', { name: JSON.stringify(entry.name.toString('utf8')) }));
      return Buffer.concat([Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t`), entry.name, NUL]);
    });
    // An empty record ends the tree.
    const input = Buffer.concat([...records, NUL]);
    try {
      return checkOid(await this.trees.request(input, null), 'mktree');
    } catch (error) {
      // `mktree` looks for its entries' objects only in the packs there were when it started: one a fetch brought
      // since is unavailable to it. A new process sees every pack; an object missing there is missing indeed.
      if (!(error instanceof GitError && error.stderr.includes('is unavailable'))) throw error;
      return checkOid(await this.trees.request(input, null), 'mktree');
    }
  }

  private clearFolder(): void {
    const folder = this.folder;
    this.folder = undefined;
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
}

const NUL = Buffer.from([0]);

/** The most blobs in the folder at once. */
const BLOBS_AT_ONCE = 8;

function checkOid(line: string, command: string): Oid {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) throw new Error(message('git.unreadable-answer', { command }));
  return line;
}
