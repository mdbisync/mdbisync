// The sync's state in git: the tracked branch it reads, and three commit
// chains under the state-ref prefix (`linear`, `ids`, `uploads`). Every
// change to the remote is one atomic push with an expected old value per
// ref, so of two runs that started from the same state exactly one wins and
// the other changes nothing.

import { type StateConfig, STORES, type Store, branchRef, localRef, stateRef } from './config.ts';
import { type Git, GitError, type Oid, mapLimit } from './git.ts';
import { type LfsPointer, type LfsReadResult, lfsReader, parseLfsPointer } from './lfs.ts';
import { type CommitIdentity, type TreeEntry, commitTree, listTree, readBlobs } from './objects.ts';

/** The state refs as last fetched from the remote; null when a ref does not exist. */
export type StateSnapshot = Record<Store, Oid | null>;

export interface FetchedState {
  /** The tracked branch's commit. */
  tracked: Oid;
  /** The sync branch's commit, null when it does not exist. */
  sync: Oid | null;
  state: StateSnapshot;
}

/**
 * Fetches the tracked branch, the sync branch and the state refs in one
 * call and returns their values. These values are the expected old values
 * of the next push. LFS content is not downloaded.
 */
export async function fetchState(git: Git, config: StateConfig): Promise<FetchedState> {
  const tracked = branchRef(config.trackedBranch);
  const sync = branchRef(config.syncBranch);
  const advertised = await lsRemote(git, config.remote, [tracked, sync, ...STORES.map((store) => stateRef(config, store))]);
  if (!advertised.has(tracked)) {
    throw new Error(`the tracked branch "${config.trackedBranch}" does not exist on remote "${config.remote}"`);
  }

  // Fetch only refs that exist (a missing one would fail the fetch), and
  // forget local copies of refs that are gone.
  const present = [...advertised.keys()];
  const refspecs = present.map((ref) => `+${ref}:${localRef(config, ref)}`);
  await git.run(['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', config.remote, ...refspecs]);
  const read = async (ref: string): Promise<Oid | null> => {
    const local = localRef(config, ref);
    if (advertised.has(ref)) return git.text(['rev-parse', '--verify', `${local}^{commit}`]);
    await git.run(['update-ref', '-d', local]);
    return null;
  };

  const state = {} as StateSnapshot;
  for (const store of STORES) state[store] = await read(stateRef(config, store));
  return { tracked: (await read(tracked)) as Oid, sync: await read(sync), state };
}

async function lsRemote(git: Git, remote: string, refs: readonly string[]): Promise<Map<string, Oid>> {
  const output = await git.text(['ls-remote', '--refs', remote, ...refs]);
  const wanted = new Set(refs);
  const result = new Map<string, Oid>();
  for (const line of output.split('\n')) {
    const [oid, ref] = line.split('\t');
    // ls-remote matches patterns by suffix; keep exact names only.
    if (oid !== undefined && ref !== undefined && wanted.has(ref)) result.set(ref, oid);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pushing

export interface RefUpdate {
  /** The full ref name on the remote. */
  ref: string;
  /** The value the remote must still hold; null means the ref must not exist yet. */
  expected: Oid | null;
  /** The new value. */
  next: Oid;
  /**
   * Allows a new value that does not descend from the expected one. Only
   * recovery (initial sync replacing lost or drifted state) sets it.
   */
  replace?: boolean;
}

export type PushResult =
  | { ok: true; updated: string[] }
  | { ok: false; reason: 'stale' | 'rejected'; refs: { ref: string; message: string }[] };

export class NotFastForwardError extends Error {
  constructor(ref: string) {
    super(`refusing to move ${ref} to a commit that does not descend from its current value`);
    this.name = 'NotFastForwardError';
  }
}

/**
 * Pushes all updates in one `git push --atomic`, each with
 * `--force-with-lease=<ref>:<expected>`. Either every ref moves or none
 * does. A lease that no longer holds returns `{ ok: false, reason: 'stale' }`
 * and leaves the remote and the local copies unchanged. Other failures
 * (network, rights) throw.
 */
export async function pushAtomic(git: Git, config: StateConfig, updates: readonly RefUpdate[]): Promise<PushResult> {
  if (new Set(updates.map((update) => update.ref)).size !== updates.length) {
    throw new Error('a push names the same ref twice');
  }
  const changing = updates.filter((update) => update.next !== update.expected);
  if (changing.length === 0) return { ok: true, updated: [] };

  // Refs that keep their value still go into the push with their lease, so
  // a run whose view of them is stale is refused as a whole. git checks
  // those leases against the remote's advertisement; only the changing refs
  // reach the remote's atomic transaction, so a move of an unchanged ref in
  // the moment between the advertisement and that transaction is not seen.
  // Runs of one repository share a concurrency group, which closes it.
  for (const update of changing) {
    if (update.expected !== null && update.replace !== true) {
      const ancestor = await git.run(['merge-base', '--is-ancestor', update.expected, update.next], { okCodes: [0, 1] });
      if (ancestor.code !== 0) throw new NotFastForwardError(update.ref);
    }
  }

  // git treats a ref that already holds the new value as up to date and
  // skips its lease, so the other refs would still move. Such a ref has
  // moved away from what this run saw: refuse the push before sending it.
  const before = await lsRemote(git, config.remote, updates.map((update) => update.ref));
  const skipped = updates.filter((update) => update.next !== update.expected && before.get(update.ref) === update.next);
  if (skipped.length > 0) {
    return { ok: false, reason: 'stale', refs: skipped.map((update) => ({ ref: update.ref, message: 'already at the new value, not at the expected one' })) };
  }

  const args = ['push', '--atomic', '--porcelain', '--no-verify', config.remote];
  for (const update of updates) args.push(`--force-with-lease=${update.ref}:${update.expected ?? ''}`);
  for (const update of updates) args.push(`${update.next}:${update.ref}`);

  const result = await git.run(args, { okCodes: [0, 1] });
  const lines = parsePorcelain(result.stdout.toString('utf8'));

  if (result.code === 0) {
    // The local copies are only a record of the last value seen; if they
    // cannot be written the remote still moved, and the next lease built
    // from a stale copy is refused, so the push is still reported as done.
    const input = changing.map((update) => `update ${localRef(config, update.ref)} ${update.next}\n`).join('');
    await git.run(['update-ref', '--stdin'], { input, okCodes: [0, 1, 128] });
    return { ok: true, updated: changing.map((update) => update.ref) };
  }

  const rejected = lines.filter((line) => line.flag === '!');
  if (rejected.length === 0) throw new GitError(args, result.code, result.stderr);
  // The client refuses a lease it can see is stale ("stale info"); when two
  // pushes pass that check at the same time, the remote's own compare refuses
  // the later one ("atomic transaction failed"). Either way a ref has moved
  // away from its expected value; any other refusal (a hook, missing rights)
  // leaves them where they were.
  const stale =
    rejected.some((line) => line.summary.includes('stale info')) ||
    (await movedAway(git, config.remote, updates));
  return {
    ok: false,
    reason: stale ? 'stale' : 'rejected',
    refs: rejected.map((line) => ({ ref: line.ref, message: line.summary })),
  };
}

async function movedAway(git: Git, remote: string, updates: readonly RefUpdate[]): Promise<boolean> {
  const current = await lsRemote(git, remote, updates.map((update) => update.ref));
  return updates.some((update) => (current.get(update.ref) ?? null) !== update.expected);
}

interface PorcelainLine {
  flag: string;
  ref: string;
  summary: string;
}

function parsePorcelain(output: string): PorcelainLine[] {
  const lines: PorcelainLine[] = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3 || (parts[0] as string).length !== 1) continue;
    const refs = parts[1] as string;
    lines.push({ flag: parts[0] as string, ref: refs.slice(refs.lastIndexOf(':') + 1), summary: parts.slice(2).join('\t') });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The `ids` and `uploads` stores

export const IDS_FILE = 'ids.json';
export const UPLOADS_FILE = 'uploads.json';

export interface IdEntry {
  /** The Linear document id. */
  id: string;
  /**
   * The document's own icon and color while the sync shows a mark in their
   * place; absent when no mark is shown.
   */
  saved?: { icon: string | null; color: string | null };
}

/** Path → Linear document. */
export type IdMap = Map<string, IdEntry>;
/** SHA-256 of a file (lowercase hex) → Linear upload URL. */
export type UploadMap = Map<string, string>;

export async function readIds(git: Git, commit: Oid | null): Promise<IdMap> {
  const data = await readJsonFile(git, commit, IDS_FILE);
  const map: IdMap = new Map();
  for (const [path, value] of Object.entries(data)) {
    if (!isIdEntry(value)) throw new Error(`${IDS_FILE} has an invalid entry for a path`);
    map.set(path, value.saved === undefined ? { id: value.id } : { id: value.id, saved: value.saved });
  }
  return map;
}

export async function readUploads(git: Git, commit: Oid | null): Promise<UploadMap> {
  const data = await readJsonFile(git, commit, UPLOADS_FILE);
  const map: UploadMap = new Map();
  for (const [hash, url] of Object.entries(data)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof url !== 'string') throw new Error(`${UPLOADS_FILE} has an invalid entry`);
    map.set(hash, url);
  }
  return map;
}

/**
 * The subject of an `ids` commit made while an initial sync is still
 * writing. Its body names the tracked commit the run writes from, as a
 * `Tracked: <oid>` line. The sync does not run while `ids` is at such a
 * commit: the map may hold only part of the documents.
 */
export const INITIAL_SYNC_PROGRESS = 'Initial sync in progress: document ids';

export function initialSyncProgressMessage(tracked: Oid): string {
  return `${INITIAL_SYNC_PROGRESS}\n\nTracked: ${tracked}\n`;
}

/** When `commit` is a progress commit of an unfinished initial sync, the tracked commit it names; otherwise null. */
export async function readInitialSyncProgress(git: Git, commit: Oid | null): Promise<{ tracked: Oid | null } | null> {
  if (commit === null) return null;
  const message = (await git.run(['show', '-s', '--format=%B', commit])).stdout.toString('utf8');
  const [subject] = message.split('\n');
  if (subject !== INITIAL_SYNC_PROGRESS) return null;
  return { tracked: /^Tracked: ([0-9a-f]{40,64})$/m.exec(message)?.[1] ?? null };
}

export interface CommitStateOptions {
  /** The commit message; a reader can tell a run's progress commits from its final one by it. */
  message?: string;
  /** Commit even when the file is unchanged, so the new message is recorded. */
  always?: boolean;
}

/** Commits the id map on top of `parent`. Returns `parent` when nothing changed, unless `always`. */
export function commitIds(git: Git, parent: Oid | null, ids: IdMap, identity: CommitIdentity, options: CommitStateOptions = {}): Promise<Oid> {
  const entries = [...ids.entries()].sort(([a], [b]) => compareStrings(a, b));
  const data = Object.fromEntries(entries.map(([path, entry]) => [path, entry.saved === undefined ? { id: entry.id } : { id: entry.id, saved: entry.saved }]));
  return commitJsonFile(git, parent, IDS_FILE, data, options.message ?? 'Update document ids', identity, options.always === true);
}

/** Commits the upload cache on top of `parent`. Returns `parent` when nothing changed. */
export function commitUploads(git: Git, parent: Oid | null, uploads: UploadMap, identity: CommitIdentity): Promise<Oid> {
  const data = Object.fromEntries([...uploads.entries()].sort(([a], [b]) => compareStrings(a, b)));
  return commitJsonFile(git, parent, UPLOADS_FILE, data, 'Update upload cache', identity);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isIdEntry(value: unknown): value is IdEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id === '') return false;
  if (entry.saved === undefined) return true;
  const saved = entry.saved as Record<string, unknown> | null;
  return (
    typeof saved === 'object' &&
    saved !== null &&
    (saved.icon === null || typeof saved.icon === 'string') &&
    (saved.color === null || typeof saved.color === 'string')
  );
}

async function readJsonFile(git: Git, commit: Oid | null, file: string): Promise<Record<string, unknown>> {
  if (commit === null) return {};
  // A state commit without its file is damaged state, not an empty map:
  // reading it as empty would make the sync forget every id.
  const read = await git.run(['cat-file', 'blob', `${commit}:${file}`], { okCodes: [0, 128] });
  if (read.code !== 0) throw new Error(`${file} is missing in state commit ${commit}`);
  const blob = read.stdout;
  let data: unknown;
  try {
    data = JSON.parse(blob.toString('utf8'));
  } catch {
    throw new Error(`${file} in ${commit} is not valid JSON`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${file} in ${commit} is not a JSON object`);
  return data as Record<string, unknown>;
}

function commitJsonFile(
  git: Git,
  parent: Oid | null,
  file: string,
  data: unknown,
  message: string,
  identity: CommitIdentity,
  always = false,
): Promise<Oid> {
  return commitTree(git, {
    parents: parent === null ? [] : [parent],
    base: null,
    changes: new Map([[file, `${JSON.stringify(data, null, 2)}\n`]]),
    message,
    identity,
    skipIfUnchanged: !always,
  });
}

// ---------------------------------------------------------------------------
// Reading files of a commit

export type FileRead =
  | { ok: true; content: Buffer; lfs: boolean }
  | { ok: false; reason: string };

/**
 * Reads files of `commit` by path. Files stored in LFS are downloaded, and
 * only those asked for. A file that is missing, not a regular file, or whose
 * LFS object cannot be read gets `ok: false` with the reason; the others are
 * still read.
 */
export async function readFiles(git: Git, config: StateConfig, commit: Oid, paths: readonly string[]): Promise<Map<string, FileRead>> {
  const wanted = new Set(paths);
  const entries = new Map<string, TreeEntry>();
  for (const entry of await listTree(git, commit)) if (wanted.has(entry.path)) entries.set(entry.path, entry);

  const result = new Map<string, FileRead>();
  const blobs = await readBlobs(
    git,
    [...entries.values()].filter((entry) => entry.type === 'blob').map((entry) => entry.oid),
  );
  const pointers = new Map<string, { pointer: LfsPointer; path: string }>();
  for (const path of wanted) {
    const entry = entries.get(path);
    if (entry === undefined) {
      result.set(path, { ok: false, reason: 'not in the tree' });
      continue;
    }
    if (entry.type !== 'blob' || entry.mode === '120000') {
      result.set(path, { ok: false, reason: 'not a regular file' });
      continue;
    }
    const blob = blobs.get(entry.oid) as Buffer;
    const pointer = parseLfsPointer(blob);
    if (pointer === null) result.set(path, { ok: true, content: blob, lfs: false });
    else if (!pointers.has(entry.oid)) pointers.set(entry.oid, { pointer, path });
  }

  // Keyed by the pointer file itself, so files with identical pointers share
  // one read and any pointer that differs (size, extensions) is checked on
  // its own. Objects already downloaded are read from the local LFS store.
  const lfs = new Map<Oid, LfsReadResult>();
  if (pointers.size > 0) {
    const read = await lfsReader(git, config.remote);
    const items = [...pointers.entries()];
    const results = await mapLimit(items, 4, ([, item]) => read(item.pointer, item.path));
    items.forEach(([pointerBlob], index) => lfs.set(pointerBlob, results[index] as LfsReadResult));
  }
  for (const path of wanted) {
    if (result.has(path)) continue;
    const read = lfs.get((entries.get(path) as TreeEntry).oid) as LfsReadResult;
    result.set(path, read.ok ? { ok: true, content: read.content, lfs: true } : read);
  }
  return new Map([...wanted].map((path) => [path, result.get(path) as FileRead]));
}
