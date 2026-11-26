// Reading and writing git objects without a working tree: trees are listed,
// blobs are read in one `cat-file --batch` call, and new commits are built in
// a private index file, so the repository's own index and files are never
// touched.

import { type FileContent, contentBytes } from './content.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Git, GitError, GitOutputLimitError, type Oid, mapLimit } from './git.ts';
import type { GitObject } from './object-reader.ts';
import { message } from '../messages.ts';
import type { NewTreeEntry } from './object-writer.ts';

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

/**
 * Lists every file of a commit or tree, recursively, as `git ls-tree -r -l`
 * does, through the repository's object reader. With `maxOutputBytes`, a
 * listing longer than that in `ls-tree -r -z -l` form is a `GitOutputLimitError`.
 */
export function listTree(git: Git, treeish: string, maxOutputBytes?: number): Promise<TreeEntry[]> {
  return git.listTree(treeish, maxOutputBytes);
}

/**
 * `listTree` itself; `Git.listTree` calls it, so a test can watch or limit
 * each listing there. A bounded listing that meets a tree object larger than
 * what is left of its limit goes to `git ls-tree`, whose output stops at the
 * limit: no tree object larger than the limit is read here.
 */
export async function readTreeListing(git: Git, treeish: string, maxOutputBytes?: number): Promise<TreeEntry[]> {
  let files: WalkedFile[];
  try {
    files = await walkTree(git, treeish, maxOutputBytes === undefined ? undefined : { maxOutputBytes, sized: true });
  } catch (error) {
    if (!(error instanceof TreeOverLimit)) throw error;
    const { stdout } = await git.run(['ls-tree', '-r', '-z', '-l', '--full-tree', treeish], { maxOutputBytes });
    return parseTreeListing(stdout);
  }
  const sizes = await Promise.all(files.map((file) => file.type === 'blob' ? git.objectInfo(file.oid) : null));
  let bytes = 0;
  return files.map((file, index) => {
    // `ls-tree -l` prints `BAD` for a blob it cannot find.
    const size = file.type === 'blob' ? sizes[index]?.size ?? Number.NaN : null;
    if (maxOutputBytes !== undefined) {
      bytes += file.bytes + Math.max(7, size === null ? 1 : Number.isNaN(size) ? 3 : String(size).length);
      if (bytes > maxOutputBytes) throw new GitOutputLimitError(maxOutputBytes);
    }
    return { path: file.path, mode: file.mode, type: file.type, oid: file.oid, size };
  });
}

/**
 * The files and submodules at these paths of a commit or tree, as
 * `git --literal-pathspecs ls-tree -l --full-tree <treeish> -- <paths>`
 * lists them: in tree order, each once, and a path that is a folder or not
 * there left out (a folder asked for together with a path inside it is
 * listed by `ls-tree` itself). With `maxOutputBytes`, a listing longer than that in
 * `ls-tree -z -l` form (folders included) is a `GitOutputLimitError`.
 */
export async function listPaths(git: Git, treeish: string, paths: readonly string[], maxOutputBytes?: number): Promise<TreeEntry[]> {
  const unique = [...new Set(paths)];
  // `ls-tree` lists every entry of a folder that is asked for when it also opens it for a path inside.
  const inside = (path: string) => unique.some((other) => other.startsWith(`${path}/`));
  if (unique.some((path) => inside(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', treeish, '--', ...paths], { maxOutputBytes });
    return parseTreeListing(stdout);
  }
  try {
    return await listPathsInTrees(git, treeish, unique, maxOutputBytes);
  } catch (error) {
    // A tree object larger than the limit is not read here: `ls-tree` stops at the limit.
    if (!(error instanceof TreeOverLimit)) throw error;
    const { stdout } = await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', treeish, '--', ...paths], { maxOutputBytes });
    return parseTreeListing(stdout);
  }
}

/** `listPaths` for ordinary paths, through the object reader. */
async function listPathsInTrees(git: Git, treeish: string, unique: readonly string[], maxOutputBytes: number | undefined): Promise<TreeEntry[]> {
  const root = await readTree(git, `${treeish}^{tree}`, maxOutputBytes);
  if (root === null || root.type !== 'tree') throw new GitError(['ls-tree', '--full-tree', treeish], 128, `fatal: not a tree object: ${treeish}`);
  const rawLength = root.oid.length / 2;
  const folders = new Map<string, Promise<RawTreeEntry[] | null>>([['', Promise.resolve(parseTree(root.content, rawLength))]]);
  const folder = (path: string): Promise<RawTreeEntry[] | null> => {
    let found = folders.get(path);
    if (found === undefined) {
      const slash = path.lastIndexOf('/');
      found = (async () => {
        const entry = await entryIn(folder(slash < 0 ? '' : path.slice(0, slash)), path.slice(slash + 1));
        if (entry?.mode !== '040000') return null;
        const tree = await readTree(git, entry.oid, maxOutputBytes);
        return tree?.type === 'tree' ? parseTree(tree.content, rawLength) : null;
      })();
      folders.set(path, found);
    }
    return found;
  };
  const entryIn = async (entries: Promise<RawTreeEntry[] | null>, name: string) => {
    const bytes = Buffer.from(name, 'utf8');
    return (await entries)?.find((entry) => entry.name.equals(bytes));
  };
  const found = await Promise.all(unique.map(async (path) => {
    const slash = path.lastIndexOf('/');
    const entry = await entryIn(folder(slash < 0 ? '' : path.slice(0, slash)), path.slice(slash + 1));
    if (entry === undefined) return undefined;
    const type: 'tree' | 'blob' | 'commit' = entry.mode === '040000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob';
    const size = type === 'blob' ? (await git.objectInfo(entry.oid))?.size ?? Number.NaN : null;
    return { path, bytes: Buffer.from(path, 'utf8'), mode: entry.mode, type, oid: entry.oid, size };
  }));
  const listed = found.filter((entry) => entry !== undefined).sort((a, b) => a.bytes.compare(b.bytes));
  if (maxOutputBytes !== undefined) {
    let bytes = 0;
    for (const entry of listed) {
      bytes += entry.mode.length + entry.type.length + entry.oid.length + entry.bytes.length + 5
        + Math.max(7, entry.size === null ? 1 : Number.isNaN(entry.size) ? 3 : String(entry.size).length);
    }
    if (bytes > maxOutputBytes) throw new GitOutputLimitError(maxOutputBytes);
  }
  return listed.flatMap(({ path, mode, type, oid, size }): TreeEntry[] => type === 'tree' ? [] : [{ path, mode, type, oid, size }]);
}

interface WalkedFile {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  oid: Oid;
  /** Bytes of this record in `ls-tree -r -z` output without its size field. */
  bytes: number;
}

/**
 * The files of a tree, recursively, in `git ls-tree -r` order, with modes as
 * git reads them (`canon_mode`). With `limit`, stops with a
 * `GitOutputLimitError` once the records alone pass `maxOutputBytes`
 * (counting the size field's least width when `sized`).
 */
async function walkTree(git: Git, treeish: string, limit?: { maxOutputBytes: number; sized: boolean }): Promise<WalkedFile[]> {
  const root = await readTree(git, `${treeish}^{tree}`, limit?.maxOutputBytes);
  if (root === null || root.type !== 'tree') throw new GitError(['ls-tree', '-r', '--full-tree', treeish], 128, `fatal: not a tree object: ${treeish}`);
  const rawLength = root.oid.length / 2;
  const files: WalkedFile[] = [];
  let bytes = 0;
  const walk = async (content: Buffer, prefix: Buffer): Promise<void> => {
    const entries = parseTree(content, rawLength);
    // Without a limit, subtrees are read ahead, all at once, and walked in order. With one, each is read only when
    // its turn comes, so a listing over the limit stops reading.
    const subtrees = entries.map((entry) => limit === undefined && entry.mode === '040000' ? git.readObject(entry.oid) : undefined);
    // A read not reached after an error must not fail on its own.
    for (const read of subtrees) read?.catch(() => {});
    for (const [index, entry] of entries.entries()) {
      const path = prefix.length === 0 ? entry.name : Buffer.concat([prefix, SLASH, entry.name]);
      if (entry.mode === '040000') {
        const tree = await (subtrees[index] ?? readTree(git, entry.oid, limit === undefined ? undefined : limit.maxOutputBytes - bytes));
        if (tree === null || tree === undefined || tree.type !== 'tree') throw new GitError(['ls-tree', '-r', '--full-tree', treeish], 128, `fatal: not a tree object: ${entry.oid}`);
        await walk(tree.content, path);
        continue;
      }
      const type = entry.mode === '160000' ? 'commit' : 'blob';
      // `<mode> <type> <oid> <size>\t<path>\0`, the size counted by the caller.
      const record = entry.mode.length + type.length + entry.oid.length + path.length + 5;
      if (limit !== undefined) {
        bytes += record + (limit.sized ? 7 : -1);
        if (bytes > limit.maxOutputBytes) throw new GitOutputLimitError(limit.maxOutputBytes);
      }
      files.push({ path: path.toString('utf8'), mode: entry.mode, type, oid: entry.oid, bytes: record });
    }
  };
  await walk(root.content, Buffer.alloc(0));
  return files;
}

const SLASH = Buffer.from('/');

/** A bounded listing met a tree object larger than what is left of its limit. */
class TreeOverLimit extends Error {}

/**
 * Reads a tree object; with a budget, only one no larger than that
 * (`TreeOverLimit` otherwise), so a bounded listing never holds a tree
 * object larger than its limit.
 */
async function readTree(git: Git, name: string, budget: number | undefined): Promise<GitObject | null> {
  if (budget === undefined) return git.readObject(name);
  const info = await git.objectInfo(name);
  if (info === null) return null;
  if (info.type === 'tree' && info.size > budget) throw new TreeOverLimit();
  return git.readObject(info.oid);
}

interface RawTreeEntry {
  /** The mode as `ls-tree` prints it: git's canonical mode, six octal digits. */
  mode: string;
  name: Buffer;
  oid: Oid;
}

/** Parses a tree object: `<octal mode> <name>\0<raw id>` records. */
function parseTree(content: Buffer, rawLength: number): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    const nul = content.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + rawLength > content.length) throw new Error(message('objects.bad-tree'));
    const mode = canonicalMode(Number.parseInt(content.subarray(offset, space).toString('latin1'), 8));
    entries.push({ mode, name: content.subarray(space + 1, nul), oid: content.subarray(nul + 1, nul + 1 + rawLength).toString('hex') });
    offset = nul + 1 + rawLength;
  }
  return entries;
}

/** Git's `canon_mode`: the file mode a tree entry is read as, printed as `ls-tree` prints it. */
function canonicalMode(mode: number): string {
  const kind = mode & 0o170000;
  const canonical = kind === 0o100000 ? 0o100000 | (mode & 0o100 ? 0o755 : 0o644)
    : kind === 0o120000 ? 0o120000
      : kind === 0o040000 ? 0o040000
        : 0o160000;
  return canonical.toString(8).padStart(6, '0');
}

/** Parses the NUL-delimited records from `ls-tree -z -l`. */
export function parseTreeListing(stdout: Buffer): TreeEntry[] {
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

/**
 * Reads blobs by id through the repository's object reader. A missing id or
 * an object of another type is an error. With `maxOutputBytes`, ids whose
 * `git cat-file --batch` output would be longer than that are a
 * `GitOutputLimitError`, and no content is read.
 */
export function readBlobs(git: Git, oids: readonly Oid[], maxOutputBytes?: number): Promise<Map<Oid, Buffer>> {
  return git.readBlobs(oids, maxOutputBytes);
}

/** `readBlobs` itself; `Git.readBlobs` calls it, so a test can watch each batch there. */
export async function readBlobBatch(git: Git, oids: readonly Oid[], maxOutputBytes?: number): Promise<Map<Oid, Buffer>> {
  const unique = [...new Set(oids)];
  const result = new Map<Oid, Buffer>();
  if (unique.length === 0) return result;
  if (maxOutputBytes !== undefined) {
    const infos = await Promise.all(unique.map((oid) => git.objectInfo(oid)));
    let bytes = 0;
    infos.forEach((info, index) => {
      bytes += info === null ? `${unique[index]} missing\n`.length : `${info.oid} ${info.type} ${info.size}\n`.length + info.size + 1;
    });
    if (bytes > maxOutputBytes) throw new GitOutputLimitError(maxOutputBytes);
  }
  const objects = await Promise.all(unique.map((oid) => git.readObject(oid)));
  unique.forEach((oid, index) => {
    const found = objects[index];
    if (found === null || found === undefined) throw new Error(message('objects.missing', { oid }));
    if (found.type !== 'blob') throw new Error(message('objects.not-blob', { oid, type: found.type }));
    result.set(oid, found.content);
  });
  return result;
}

/** Stores content as a blob, exactly as given (no clean filters, no LFS). */
export async function writeBlob(git: Git, content: FileContent): Promise<Oid> {
  return git.objectWriter().blob(() => contentBytes(content));
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
  changes: ReadonlyMap<string, FileContent | null>;
  message: string;
  identity: CommitIdentity;
  /**
   * When true (the default) and the new tree equals the tree of the single
   * parent, no commit is made and the parent is returned.
   */
  skipIfUnchanged?: boolean;
  /** Gives the message to commit in place of `message`, from the tree and parents the commit gets: a signed one. */
  sign?: (tree: Oid, parents: readonly Oid[], message: string) => string;
}

/** Builds a tree from `base` plus `changes` and commits it. Returns the commit id. */
export async function commitTree(git: Git, spec: CommitSpec): Promise<Oid> {
  for (const [path, content] of spec.changes) checkRepoPath(path, { removal: content === null });
  const tree = await buildTree(git, spec.base, spec.changes);

  if ((spec.skipIfUnchanged ?? true) && spec.parents.length === 1) {
    const parentTree = await git.revParse(`${spec.parents[0]}^{tree}`);
    if (parentTree === tree) return spec.parents[0] as Oid;
  }

  // State commits are never GPG-signed, whatever the machine's commit.gpgSign says, and are UTF-8 without an encoding
  // header, whatever its i18n.commitEncoding says: a signed record with that header does not verify.
  const args = ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', '--no-gpg-sign', tree];
  // Git stores a parent given twice once: a signature covers the parents as stored.
  const parents = [...new Set(spec.parents)];
  for (const parent of parents) args.push('-p', parent);
  args.push('-F', '-');
  const text = spec.sign === undefined ? spec.message : spec.sign(tree, parents, spec.message);
  return git.text(args, {
    input: text.endsWith('\n') ? text : `${text}\n`,
    env: {
      GIT_AUTHOR_NAME: spec.identity.name,
      GIT_AUTHOR_EMAIL: spec.identity.email,
      GIT_COMMITTER_NAME: spec.identity.name,
      GIT_COMMITTER_EMAIL: spec.identity.email,
    },
  });
}

/**
 * Builds a tree from `base` (a commit or tree id; null for an empty tree)
 * plus `changes`, without a commit. The tree is the one `git read-tree`,
 * `git update-index --index-info` and `git write-tree` give in a private
 * index: it is built from the base's tree objects as that index would build
 * it (`placeInTrees`), and in such an index when it cannot be.
 */
export async function buildTree(git: Git, base: string | null, changes: ReadonlyMap<string, FileContent | null>): Promise<Oid> {
  const writer = git.objectWriter();
  const placed = new Map<string, Placement | null>();
  for (const [path, content] of changes) {
    // Read when its turn comes: a few blobs at a time, as spooled content is large.
    const oid = content === null ? undefined : writer.blob(() => contentBytes(content));
    // A failed write is seen below, once the tree is built or given up.
    oid?.catch(() => {});
    placed.set(path, oid === undefined ? null : { oid });
  }
  try {
    return (await placeInTrees(git, base, placed)) ?? await buildTreeInIndex(git, base, placed);
  } finally {
    // Every blob is stored, or its failure seen, before the tree counts.
    await Promise.all([...placed.values()].map((placement) => placement?.oid));
  }
}

/**
 * Builds a tree from `base` with these entries put in place: each an object
 * with its exact mode, or null to remove the path. Built as `buildTree`
 * builds trees; in a private index when it must be.
 */
export async function placeEntries(git: Git, base: Oid, entries: ReadonlyMap<string, { mode: string; oid: Oid } | null>): Promise<Oid> {
  const placed = new Map([...entries].map(([path, entry]) => [path, entry === null ? null : { oid: Promise.resolve(entry.oid), mode: entry.mode }]));
  const built = await placeInTrees(git, base, placed);
  if (built !== undefined) return built;
  const dir = await mkdtemp(join(tmpdir(), 'lane-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git.run(['read-tree', `${base}^{tree}`], { env });
    const zero = '0'.repeat((await git.objectFormat()) === 'sha256' ? 64 : 40);
    const input = [...entries].map(([path, entry]) => entry === null ? `0 ${zero}\t${path}\0` : `${entry.mode} ${entry.oid}\t${path}\0`).join('');
    if (input) await git.run(['update-index', '-z', '--index-info'], { env, input });
    return await git.text(['write-tree'], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Builds the tree in a private index file, as git itself does. */
async function buildTreeInIndex(git: Git, base: string | null, changes: ReadonlyMap<string, Placement | null>): Promise<Oid> {
  const dir = await mkdtemp(join(tmpdir(), 'state-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (base === null) await git.run(['read-tree', '--empty'], { env });
    else await git.run(['read-tree', `${base}^{tree}`], { env });

    const modes = base !== null && changes.size > 0 ? await listModes(git, base) : new Map<string, string>();

    // `--index-info` takes paths from the repository root and needs no
    // working tree; mode 0 with the null id removes a path.
    const nullOid = '0'.repeat((await git.objectFormat()) === 'sha256' ? 64 : 40);
    const lines = await mapLimit([...changes.entries()], 8, async ([path, placement]) => {
      if (placement === null) return `0 ${nullOid}\t${path}\0`;
      const oid = await placement.oid;
      const mode = modes.get(path) === '100755' ? '100755' : '100644';
      return `${mode} ${oid}\t${path}\0`;
    });
    if (lines.length > 0) await git.run(['update-index', '-z', '--index-info'], { input: lines.join(''), env });
    return await git.text(['write-tree'], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What a change puts at a path: an object, and its mode (by default the base's `100755` there, else `100644`). */
interface Placement {
  oid: Promise<Oid>;
  mode?: string;
}

/** The changes at and below one path: a change of the entry there (null removes it), and the changes below it by name. */
interface ChangeNode {
  change?: Placement | null;
  below: Map<string, ChangeNode>;
}

/** The tree must be built in an index. */
class NeedsIndex extends Error {}

/**
 * Builds the tree from the base's tree objects, writing only the trees on
 * changed paths; undefined when it must be built in an index instead.
 *
 * This follows the index: `read-tree` keeps the id of every tree it reads,
 * and `update-index` drops the id of each folder on a changed path, so
 * `write-tree` writes those folders again from their entries (with the
 * modes git reads, and without folders that hold no file) and keeps the
 * other trees as they are. Removing a path that is a folder drops every id
 * below it; that, an entry put where a folder is or a folder where a file
 * is, and a folder whose entries are out of git's order, go to the index.
 */
async function placeInTrees(git: Git, base: string | null, changes: ReadonlyMap<string, Placement | null>): Promise<Oid | undefined> {
  const root: ChangeNode = { below: new Map() };
  for (const [path, change] of changes) {
    const parts = path.split('/');
    // A path git itself refuses gets git's own answer.
    if (parts.some((part) => part === '' || part === '.' || part === '..' || isGitDirectoryName(part))) return undefined;
    let node = root;
    for (const part of parts) {
      let next = node.below.get(part);
      if (next === undefined) node.below.set(part, next = { below: new Map() });
      node = next;
    }
    node.change = change;
  }

  let tree: Buffer | null = null;
  if (base !== null) {
    const found = await git.readObject(`${base}^{tree}`);
    // A base that is no tree gets git's own error.
    if (found === null || found.type !== 'tree') return undefined;
    if (changes.size === 0) return found.oid;
    tree = found.content;
  }
  const context = { rawLength: (await git.objectFormat()) === 'sha256' ? 32 : 20, holdsFiles: new Map<Oid, Promise<boolean>>() };
  try {
    return await rebuild(git, tree, root, context) ?? await git.objectWriter().tree([]);
  } catch (error) {
    if (error instanceof NeedsIndex) return undefined;
    throw error;
  }
}

interface Rebuild {
  rawLength: number;
  holdsFiles: Map<Oid, Promise<boolean>>;
}

/** Writes a folder on a changed path again; null when it holds no file and so has no tree. */
async function rebuild(git: Git, content: Buffer | null, node: ChangeNode, context: Rebuild): Promise<Oid | null> {
  // Entries by name; names are bytes, keyed as latin1 strings.
  const entries = new Map<string, NewTreeEntry>();
  if (content !== null) {
    let previous: RawTreeEntry | undefined;
    for (const entry of parseTree(content, context.rawLength)) {
      // Entries out of order or twice, or a name git checks on reading it: the index reads such a tree its own way.
      if (previous !== undefined && compareEntries(previous, entry) >= 0) throw new NeedsIndex();
      const name = entry.name.toString('latin1');
      if (name === '.' || name === '..' || isGitDirectoryName(entry.name.toString('utf8'))) throw new NeedsIndex();
      previous = entry;
      entries.set(name, { mode: entry.mode, type: entryType(entry.mode), oid: entry.oid, name: entry.name });
    }
  }
  const changedKeys = new Set([...node.below.keys()].map((name) => Buffer.from(name, 'utf8').toString('latin1')));
  const changed = await Promise.all([...node.below.entries()].map(async ([name, below]): Promise<NewTreeEntry | null> => {
    const bytes = Buffer.from(name, 'utf8');
    const existing = entries.get(bytes.toString('latin1'));
    if (below.change !== undefined) {
      if (below.below.size > 0 || existing?.type === 'tree') throw new NeedsIndex();
      if (below.change === null) return null;
      const mode = below.change.mode ?? (existing?.mode === '100755' ? '100755' : '100644');
      return { mode, type: entryType(mode), oid: await below.change.oid, name: bytes };
    }
    if (existing !== undefined && existing.type !== 'tree') {
      if (adds(below)) throw new NeedsIndex();
      return existing;
    }
    if (existing === undefined && !adds(below)) return null;
    let subtree: Buffer | null = null;
    if (existing !== undefined) {
      const found = await git.readObject(existing.oid);
      if (found === null || found.type !== 'tree') throw new NeedsIndex();
      subtree = found.content;
    }
    const oid = await rebuild(git, subtree, below, context);
    return oid === null ? null : { mode: '040000', type: 'tree', oid, name: bytes };
  }));
  const kept = [...entries.entries()].filter(([key]) => !changedKeys.has(key)).map(([, entry]) => entry);
  // Folders off the changed paths keep their ids, but one that holds no file has no place in the index.
  const holds = await Promise.all(kept.map((entry) => entry.type === 'tree' ? holdsFile(git, entry.oid, context) : true));
  const result = [...kept.filter((_, index) => holds[index]), ...changed.filter((entry) => entry !== null)];
  if (result.length === 0) return null;
  return git.objectWriter().tree(result);
}

/** True when a change at or below this node puts an entry somewhere. */
function adds(node: ChangeNode): boolean {
  if (node.change !== undefined && node.change !== null) return true;
  for (const next of node.below.values()) if (adds(next)) return true;
  return false;
}

/** True when a tree holds a file or submodule at any depth. */
function holdsFile(git: Git, oid: Oid, context: Rebuild): Promise<boolean> {
  let known = context.holdsFiles.get(oid);
  if (known === undefined) {
    known = (async () => {
      const found = await git.readObject(oid);
      if (found === null || found.type !== 'tree') throw new NeedsIndex();
      const entries = parseTree(found.content, context.rawLength);
      if (entries.some((entry) => entry.mode !== '040000')) return true;
      for (const entry of entries) if (await holdsFile(git, entry.oid, context)) return true;
      return false;
    })();
    context.holdsFiles.set(oid, known);
  }
  return known;
}

function entryType(mode: string): 'blob' | 'tree' | 'commit' {
  return mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
}

/** Git's order of tree entries: by name bytes, a folder's name compared as if it ended in `/`. */
function compareEntries(a: { name: Buffer; mode: string }, b: { name: Buffer; mode: string }): number {
  const length = Math.min(a.name.length, b.name.length);
  const common = a.name.subarray(0, length).compare(b.name.subarray(0, length));
  if (common !== 0) return common;
  const next = (entry: { name: Buffer; mode: string }) => entry.name.length > length ? entry.name[length] as number : entry.mode === '040000' ? 0x2f : 0;
  return next(a) - next(b);
}

/** File modes by path, as `git ls-tree -r` gives them, without reading blob sizes. */
async function listModes(git: Git, treeish: string): Promise<Map<string, string>> {
  return new Map((await walkTree(git, treeish)).map((file) => [file.path, file.mode]));
}
