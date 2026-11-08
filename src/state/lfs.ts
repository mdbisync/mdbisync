// Git LFS reads. The repository is cloned without smudging, so files stored
// in LFS are pointer files in git. The engine downloads only the objects it
// reads, one `git lfs smudge` per object; objects already in the local LFS
// store are not downloaded again.

import { createHash } from 'node:crypto';
import { type Git, GitError } from './git.ts';

export interface LfsPointer {
  /** SHA-256 of the content, lowercase hex. */
  oid: string;
  size: number;
  /** True when the pointer names LFS extensions (`ext-…` keys), which transform the stored content. */
  extensions: boolean;
}

const POINTER_VERSION = 'version https://git-lfs.github.com/spec/v1';
const MAX_POINTER_SIZE = 1024;

/** Parses a Git LFS pointer file (spec v1). Returns null when `blob` is not one. */
export function parseLfsPointer(blob: Buffer): LfsPointer | null {
  if (blob.length >= MAX_POINTER_SIZE || !blob.subarray(0, POINTER_VERSION.length).equals(Buffer.from(POINTER_VERSION))) {
    return null;
  }
  const text = blob.toString('utf8');
  if (!text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== POINTER_VERSION) return null;
  let oid: string | null = null;
  let size: number | null = null;
  let extensions = false;
  for (const line of lines.slice(1)) {
    const space = line.indexOf(' ');
    if (space <= 0) return null;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'oid') {
      const match = /^sha256:([0-9a-f]{64})$/.exec(value);
      if (match === null) return null;
      oid = match[1] as string;
    } else if (key === 'size') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
      size = Number(value);
    } else if (!/^[a-z0-9.-]+$/.test(key)) {
      return null;
    } else if (key.startsWith('ext-')) {
      extensions = true;
    }
  }
  return oid !== null && size !== null ? { oid, size, extensions } : null;
}

export type LfsReadResult = { ok: true; content: Buffer } | { ok: false; reason: string };

export type LfsRead = (pointer: LfsPointer, path: string) => Promise<LfsReadResult>;

/**
 * Returns a function that reads LFS objects from `remote`, downloading an
 * object only when the local LFS store lacks it. Content whose hash or size
 * differs from the pointer is refused, and so are pointers with extensions.
 * The function never throws for a missing or broken object.
 */
export async function lfsReader(git: Git, remote: string): Promise<LfsRead> {
  // git-lfs prefers the current branch's remote to `remote.lfsdefault`, so
  // both are set to the remote the state is read from.
  const remoteArgs = ['-c', `remote.lfsdefault=${remote}`];
  const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1, 128] });
  if (branch.code === 0) remoteArgs.push('-c', `branch.${branch.stdout.toString('utf8').trim()}.remote=${remote}`);
  return (pointer, path) => readLfsObject(git, remoteArgs, pointer, path);
}

/** @param path the file's path, used only in git-lfs's own messages */
async function readLfsObject(git: Git, remoteArgs: readonly string[], pointer: LfsPointer, path: string): Promise<LfsReadResult> {
  if (pointer.extensions) {
    return { ok: false, reason: `LFS object ${pointer.oid} uses LFS extensions, which are not supported` };
  }
  const pointerText = `${POINTER_VERSION}\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
  let content: Buffer;
  try {
    const result = await git.run([...remoteArgs, 'lfs', 'smudge', '--', path], {
      input: pointerText,
      env: { GIT_LFS_SKIP_SMUDGE: undefined },
    });
    content = result.stdout;
  } catch (error) {
    if (error instanceof GitError) {
      return { ok: false, reason: `LFS object ${pointer.oid} could not be read (exit code ${error.code})` };
    }
    throw error;
  }
  if (content.length !== pointer.size || createHash('sha256').update(content).digest('hex') !== pointer.oid) {
    return { ok: false, reason: `LFS object ${pointer.oid} is missing or does not match its pointer` };
  }
  return { ok: true, content };
}
