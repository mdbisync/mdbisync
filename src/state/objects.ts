// Reading and writing git objects without a working tree: trees are listed,
// blobs are read in one `cat-file --batch` call, and new commits are built in
// a private index file, so the repository's own index and files are never
// touched.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Git, type Oid, mapLimit } from './git.ts';
import { message } from '../messages.ts';

export interface TreeEntry {
  path: string;
  /** Git file mode: `100644`, `100755`, `120000` (symlink) or `160000` (submodule). */
  mode: string;
  type: 'blob' | 'commit';
  oid: Oid;
  /** Size in bytes for blobs, null for submodules. */
  size: number | null;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * Who the sync's commits are by when the run has no App slug (the command
 * line run by hand): a name that is no person's and an address that cannot
 * receive mail. With an App slug they are by the App's bot account.
 */
export const NEUTRAL_IDENTITY: CommitIdentity = Object.freeze({ name: 'mdbisync', email: 'mdbisync@sync.invalid' });

/** Lists every file of a commit or tree, recursively. */
export async function listTree(git: Git, treeish: string): Promise<TreeEntry[]> {
  const { stdout } = await git.run(['ls-tree', '-r', '-z', '-l', '--full-tree', treeish]);
  const entries: TreeEntry[] = [];
  for (const record of stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/);
    if (type !== 'blob' && type !== 'commit') continue;
    entries.push({
      path: record.slice(tab + 1),
      mode: mode as string,
      type,
      oid: oid as string,
      size: size === '-' || size === undefined ? null : Number(size),
    });
  }
  return entries;
}

/** Reads blobs by id in one git process. A missing id is an error. */
export async function readBlobs(git: Git, oids: readonly Oid[]): Promise<Map<Oid, Buffer>> {
  const unique = [...new Set(oids)];
  const result = new Map<Oid, Buffer>();
  if (unique.length === 0) return result;
  const { stdout } = await git.run(['cat-file', '--batch'], { input: unique.join('\n') + '\n' });
  let offset = 0;
  for (const oid of unique) {
    const end = stdout.indexOf(0x0a, offset);
    const header = stdout.subarray(offset, end).toString('utf8');
    const [, type, size] = header.split(' ');
    if (type === 'missing' || type === undefined || size === undefined) {
      throw new Error(message('objects.missing', { oid }));
    }
    if (type !== 'blob') throw new Error(message('objects.not-blob', { oid, type: String(type) }));
    const start = end + 1;
    const length = Number(size);
    result.set(oid, stdout.subarray(start, start + length));
    offset = start + length + 1; // content is followed by a newline
  }
  return result;
}

/** Stores content as a blob, exactly as given (no clean filters, no LFS). */
export async function writeBlob(git: Git, content: Buffer | string): Promise<Oid> {
  return git.text(['hash-object', '-w', '--no-filters', '--stdin'], { input: content });
}

/**
 * True for a path part that opens the Git directory on some file system:
 * `.git` or a numbered NTFS short name `git~<n>`, in any case, followed only
 * by the dots and spaces Windows drops from a name or by an NTFS stream
 * suffix (`:...`), and with the code points HFS+ ignores in names left out.
 * This covers what Git itself refuses under `core.protectNTFS` (`.git` and
 * `git~1`) and `core.protectHFS`, and also `git~2`, `git~3`, ..., which
 * Windows gives `.git` when an earlier `git~<n>` name is taken.
 */
export function isGitDirectoryName(part: string): boolean {
  return /^(?:\.git|git~[0-9]+)[. ]*(?::|$)/i.test(part.replace(HFS_IGNORED, ''));
}

/** The code points HFS+ ignores when it compares names, as Git's `core.protectHFS` lists them. */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Checks a repository path: relative, `/`-separated, no empty, `.` or `..`
 * parts and no part that names the Git directory (`isGitDirectoryName`).
 * With `removal`, a part that names the Git directory is allowed: a tree
 * built before this rule may hold such a path (Git accepts `git~2`), and
 * removing it only takes it out of the tree.
 */
export function checkRepoPath(path: string, { removal = false }: { removal?: boolean } = {}): void {
  const parts = path.split('/');
  if (path === '' || path.includes('\0') || path.includes('\\')) throw new Error(message('objects.invalid-path', { path: JSON.stringify(path) }));
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || (!removal && isGitDirectoryName(part))) {
      throw new Error(message('objects.invalid-path', { path: JSON.stringify(path) }));
    }
  }
}

export interface CommitSpec {
  /** Parent commits, in order. Empty for a root commit. */
  parents: readonly Oid[];
  /** The tree the changes apply to (a commit or tree id); null starts from an empty tree. */
  base: string | null;
  /** New content by path; null removes the path. Other paths keep the base's version. */
  changes: ReadonlyMap<string, Buffer | string | null>;
  message: string;
  identity: CommitIdentity;
  /**
   * When true (the default) and the new tree equals the tree of the single
   * parent, no commit is made and the parent is returned.
   */
  skipIfUnchanged?: boolean;
}

/** Builds a tree from `base` plus `changes` and commits it. Returns the commit id. */
export async function commitTree(git: Git, spec: CommitSpec): Promise<Oid> {
  for (const [path, content] of spec.changes) checkRepoPath(path, { removal: content === null });
  const tree = await buildTree(git, spec.base, spec.changes);

  if ((spec.skipIfUnchanged ?? true) && spec.parents.length === 1) {
    const parentTree = await git.text(['rev-parse', `${spec.parents[0]}^{tree}`]);
    if (parentTree === tree) return spec.parents[0] as Oid;
  }

  // State commits are never signed, whatever the machine's commit.gpgSign says.
  const args = ['commit-tree', '--no-gpg-sign', tree];
  for (const parent of spec.parents) args.push('-p', parent);
  args.push('-F', '-');
  return git.text(args, {
    input: spec.message.endsWith('\n') ? spec.message : `${spec.message}\n`,
    env: {
      GIT_AUTHOR_NAME: spec.identity.name,
      GIT_AUTHOR_EMAIL: spec.identity.email,
      GIT_COMMITTER_NAME: spec.identity.name,
      GIT_COMMITTER_EMAIL: spec.identity.email,
    },
  });
}

/** Builds a tree from `base` (a commit or tree id; null for an empty tree) plus `changes`, without a commit. */
export async function buildTree(git: Git, base: string | null, changes: ReadonlyMap<string, Buffer | string | null>): Promise<Oid> {
  const dir = await mkdtemp(join(tmpdir(), 'state-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (base === null) await git.run(['read-tree', '--empty'], { env });
    else await git.run(['read-tree', `${base}^{tree}`], { env });

    const modes = base !== null && changes.size > 0 ? await listModes(git, base) : new Map<string, string>();

    // `--index-info` takes paths from the repository root and needs no
    // working tree; mode 0 with the null id removes a path.
    const nullOid = '0'.repeat((await git.text(['rev-parse', '--show-object-format'])) === 'sha256' ? 64 : 40);
    const lines = await mapLimit([...changes.entries()], 8, async ([path, content]) => {
      if (content === null) return `0 ${nullOid}\t${path}\0`;
      const oid = await writeBlob(git, content);
      const mode = modes.get(path) === '100755' ? '100755' : '100644';
      return `${mode} ${oid}\t${path}\0`;
    });
    if (lines.length > 0) await git.run(['update-index', '-z', '--index-info'], { input: lines.join(''), env });
    return await git.text(['write-tree'], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** File modes by path, without reading blob sizes. */
async function listModes(git: Git, treeish: string): Promise<Map<string, string>> {
  const { stdout } = await git.run(['ls-tree', '-r', '-z', '--full-tree', treeish]);
  const modes = new Map<string, string>();
  for (const record of stdout.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0) modes.set(record.slice(tab + 1), record.slice(0, record.indexOf(' ')));
  }
  return modes;
}
