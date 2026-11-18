// Git LFS reads. The repository is cloned without smudging, so files stored
// in LFS are pointer files in git. The engine downloads only the objects it
// reads, one `git lfs smudge` per object; objects already in the local LFS
// store are not downloaded again.

import { createHash } from 'node:crypto';
import { message } from '../messages.ts';
import { type Git, GitError, GitOutputLimitError, type Oid } from './git.ts';

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
 * The function never throws for a missing or broken object, but it throws
 * `GitLfsMissingError` when a read fails because git-lfs does not run on
 * this host.
 */
export async function lfsReader(git: Git, remote: string): Promise<LfsRead> {
  // git-lfs prefers the current branch's remote to `remote.lfsdefault`, so
  // both are set to the remote the state is read from.
  const remoteArgs = ['-c', `remote.lfsdefault=${remote}`];
  const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1, 128] });
  if (branch.code === 0) remoteArgs.push('-c', `branch.${branch.stdout.toString('utf8').trim()}.remote=${remote}`);
  // Asked only after a read failed, and once per reader.
  let installed: Promise<boolean> | undefined;
  const runs = () => (installed ??= gitLfsRuns(git));
  return (pointer, path) => readLfsObject(git, remoteArgs, pointer, path, runs);
}

/**
 * git-lfs does not run on this host (not installed, or broken). Without it,
 * every file stored in LFS would read as a missing object, so a document that
 * links one would be left out as unreadable on every run: the sync would then
 * never record the merge with the tracked branch, and its other changes (a
 * conflict among them) would never reach git. A host's missing tool stops the
 * run instead; catch-all handlers for one document's failure rethrow it.
 */
export class GitLfsMissingError extends Error {
  constructor() {
    super(message('lfs.needs-git-lfs'));
    this.name = 'GitLfsMissingError';
  }
}

/** Whether `git lfs version` runs on this host. */
async function gitLfsRuns(git: Git): Promise<boolean> {
  try {
    await git.run(['lfs', 'version']);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/** Throws `GitLfsMissingError` unless git-lfs runs on this host. */
export async function requireGitLfs(git: Git): Promise<void> {
  if (!(await gitLfsRuns(git))) throw new GitLfsMissingError();
}

/**
 * The LFS objects of the pointer files `blobs` that the remote's LFS server
 * will not give, by LFS object id, for the dry run. git-lfs asks the server's
 * batch API whether it can download them (`git lfs fetch --dry-run`) and
 * transfers no content; objects already in the local LFS store are not asked
 * about, since they can be read. The pointer files are put into one tree of
 * their own (a small object in the local repository), so the request names
 * only them; the repository's fetch include, exclude and recent settings are
 * turned off for the request. An object counts as missing when the server
 * answers that it does not have it (404) or no longer has it (410); another
 * error for an object (a rate limit, a server error) may pass, so the
 * object is not counted. When the request fails as a whole (no server, no
 * access), no object is known to be missing: the run's read finds them.
 * When it fails because git-lfs does not run here, it throws
 * `GitLfsMissingError`, as the run's read would.
 *
 * A remote reached as a local path or `file://` URL has no batch API: git-lfs
 * reports nothing for it, so none of its objects counts as missing.
 *
 * @param blobs git blob ids of LFS pointer files
 */
export async function missingLfsObjects(git: Git, remote: string, blobs: readonly Oid[]): Promise<Set<string>> {
  const missing = new Set<string>();
  if (blobs.length === 0) return missing;
  const entries = [...new Set(blobs)].map((blob, index) => `100644 blob ${blob}\t${index}\n`).join('');
  const tree = await git.text(['mktree'], { input: entries });
  const settings = ['-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', '-c', 'lfs.fetchrecentalways=false'];
  let stderr: string;
  try {
    stderr = (await git.run([...settings, 'lfs', 'fetch', '--dry-run', remote, tree], { okCodes: [0, 2] })).stderr;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    await requireGitLfs(git);
    return missing;
  }
  // git-lfs names each object the server refused with its id and the status: `[<oid>] Object does not exist: [404] …`.
  for (const match of stderr.matchAll(/^\[([0-9a-f]{64})\] [^\n]*\[(404|410)\]/gm)) missing.add(match[1] as string);
  return missing;
}

/**
 * @param path the file's path, used only in git-lfs's own messages
 * @param runs whether git-lfs runs on this host, asked after a failed read
 */
async function readLfsObject(git: Git, remoteArgs: readonly string[], pointer: LfsPointer, path: string, runs: () => Promise<boolean>): Promise<LfsReadResult> {
  if (pointer.extensions) {
    return { ok: false, reason: `LFS object ${pointer.oid} uses LFS extensions, which are not supported` };
  }
  const pointerText = `${POINTER_VERSION}\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
  let content: Buffer;
  try {
    const result = await git.run([...remoteArgs, 'lfs', 'smudge', '--', path], {
      input: pointerText,
      env: { GIT_LFS_SKIP_SMUDGE: undefined },
      // A failed smudge may return the pointer itself.
      maxOutputBytes: Math.max(pointer.size, MAX_POINTER_SIZE),
    });
    content = result.stdout;
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      return { ok: false, reason: `LFS object ${pointer.oid} could not be read (output limit exceeded)` };
    }
    if (!(error instanceof GitError)) throw error;
    if (!(await runs())) throw new GitLfsMissingError();
    return { ok: false, reason: `LFS object ${pointer.oid} could not be read (exit code ${error.code})` };
  }
  if (content.length !== pointer.size || createHash('sha256').update(content).digest('hex') !== pointer.oid) {
    return { ok: false, reason: `LFS object ${pointer.oid} is missing or does not match its pointer` };
  }
  return { ok: true, content };
}
