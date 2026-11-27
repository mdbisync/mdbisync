// Which repository-file links of a document came from Linear, for an
// initial sync that rebuilds the state, from git (the recovery path) or from Linear.
//
// Capture turns an image a Linear member wrote with a repository path into a
// plain link and records its target as a plain file of that document: such a
// link never authorizes an upload. The ids entries and the `Plain-link:`
// trailers of the state's commits carry this. A confirmed initial sync reads
// them back by document identity before it uploads anything, and keeps them
// in the ids it records.

import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { type Git, type IdMap, type Oid, type StateSnapshot, INITIAL_SYNC_FROM_LINEAR_RECORD, INITIAL_SYNC_FROM_LINEAR_TITLE, INITIAL_SYNC_PROGRESS, parseLfsPointer, readIds } from '../state/index.ts';
import { listPaths } from '../state/objects.ts';
import { ASSETS_FOLDER, isCaptureName } from '../sync/upload-type.ts';
import { readPlainFileProvenance } from '../sync/pull-repairs.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from '../sync/write.ts';
import { SYNC_PULL_REQUEST_TITLE } from '../sync/pull-request.ts';
import { CAPTURE_MESSAGE } from '../sync/capture.ts';
import { splitFile } from '../format/index.ts';
import { MarkdownLimitError } from '../format/markdown.ts';
import { destinations, resolveTarget } from './uploads.ts';

/**
 * The trailer of an initial sync's record that names a document it left out
 * because its provenance is unknown: a later recovery leaves it out again
 * until its links no longer need provenance, instead of trusting the record.
 */
export function provenanceUnknownTrailer(id: string): string {
  return `Provenance-unknown: ${encodeURIComponent(id)}`;
}

/** The documents a run writes: their paths, and the document each existing file is matched to. */
export interface ProvenancePlan {
  create: ReadonlyArray<{ path: string }>;
  overwrite: ReadonlyArray<{ path: string; documentId: string }>;
}

export interface PlainLinkProvenance {
  /** The targets of plain links that came from Linear, by document path. */
  plainFiles: Map<string, Set<string>>;
  /**
   * Documents Linear holds whose provenance the state cannot give: `linear`
   * and their ids entries are lost while the tracked branch has taken in
   * Linear's text before, or an earlier recovery left them out for that. A
   * non-image repository-file link in one leaves the document out instead of
   * uploading the file.
   */
  unknown: Set<string>;
}

/**
 * Rebuilds plain-link provenance for the documents the plan writes, by
 * document identity: the ids entries (the current ones, and those before an
 * unfinished initial sync's progress commits), the `Plain-link:` trailers of
 * the `linear` ref's first-parent history, and those the tracked branch took
 * in. A trailer only ever withholds an upload, so reading the tracked
 * branch's whole history cannot grant one. Unless `progressKnown` is false,
 * a document an unfinished initial sync's progress commits name is known.
 */
export async function readPlainLinkProvenance(git: Git, state: Pick<StateSnapshot, 'ids' | 'linear'>, tracked: Oid, plan: ProvenancePlan, options: { progressKnown?: boolean } = {}): Promise<PlainLinkProvenance> {
  const entries: IdMap[] = [await readIds(git, state.ids)];
  const before = await idsBeforeProgress(git, state.ids);
  if (before !== null && before !== state.ids) entries.push(await readIds(git, before));
  // The ids the run started from: an unfinished initial sync's progress commits do not bring lost ids back.
  const started = before === null ? new Map() : before === state.ids ? entries[0]! : entries[1]!;

  const byId = new Map<string, Set<string>>();
  const add = (id: string, targets: Iterable<string>) => {
    const set = byId.get(id) ?? new Set<string>();
    for (const target of targets) set.add(target);
    byId.set(id, set);
  };
  /** Where the ids put each document before, so a target can follow a document that moved. */
  const oldPaths = new Map<string, Set<string>>();
  for (const ids of entries) for (const [path, entry] of ids) {
    add(entry.id, entry.plainFiles ?? []);
    oldPaths.set(entry.id, (oldPaths.get(entry.id) ?? new Set()).add(path));
  }
  if (state.linear !== null) for (const [id, targets] of await readPlainFileProvenance(git, state.linear)) add(id, targets);
  for (const [id, targets] of await readPlainFileProvenance(git, tracked, { firstParent: false })) add(id, targets);

  const plainFiles = new Map<string, Set<string>>();
  const matched = new Map(plan.overwrite.map((entry) => [entry.path, entry.documentId]));
  const identified = new Set<string>();
  const identify = (entry: { path: string }): Set<string> => {
    const identities = new Set<string>(entries.flatMap((ids): string[] => {
      const old = ids.get(entry.path);
      return old === undefined ? [] : [old.id];
    }));
    const documentId = matched.get(entry.path);
    if (documentId !== undefined) identities.add(documentId);
    for (const id of identities) identified.add(id);
    return identities;
  };
  const planned = [...plan.create, ...plan.overwrite].map((entry) => ({ entry, identities: identify(entry) }));
  // With the ids lost, a document no planned file is known to be (its title changed in Linear, or another document
  // took its title) may be any planned file, so its targets protect every one. With the ids, such a file is new.
  const idsLost = started.size === 0;
  const orphaned = idsLost ? [...byId].filter(([id]) => !identified.has(id)) : [];
  for (const { entry, identities } of planned) {
    const targets = new Set<string>();
    for (const ids of entries) for (const target of ids.get(entry.path)?.plainFiles ?? []) targets.add(target);
    const sources = [...[...identities].map((id) => [id, byId.get(id)] as const), ...orphaned];
    for (const [id, own] of sources) for (const target of own ?? []) {
      targets.add(target);
      // A relative link that stayed the same while its document moved names another path now: protect that one too.
      for (const from of oldPaths.get(id) ?? []) if (from !== entry.path) targets.add(relocate(target, from, entry.path));
    }
    if (targets.size > 0) plainFiles.set(entry.path, targets);
  }

  // With `linear` present, its trailers and the ids are the whole record. Without it, an ids entry still is for
  // its document; any other document Linear holds may carry a Linear member's link the state no longer names.
  const unknown = new Set<string>();
  // The progress commits of an initial sync from git name only documents it wrote from git text; those of one from
  // Linear name every document before any provenance is read (`progressKnown: false`).
  const known = new Set((options.progressKnown === false ? [started] : entries).flatMap((ids) => [...ids.values()].map((entry) => entry.id)));
  const unproven = plan.overwrite.filter((entry) => !known.has(entry.documentId));
  if (unproven.length > 0) {
    const marked = state.linear === null ? new Set<string>() : await readProvenanceUnknown(git, state.linear);
    const lost = state.linear === null && await tookInLinear(git, tracked);
    for (const entry of unproven) if (lost || marked.has(entry.documentId)) unknown.add(entry.path);
  }
  return { plainFiles, unknown };
}

/** `target`, linked relatively from `from`, as the same link resolves from `to`. */
function relocate(target: string, from: string, to: string): string {
  return posix.normalize(posix.join(posix.dirname(to), posix.relative(posix.dirname(from), target)));
}

/** The ids commit an unfinished initial sync started from: the first one of `ids`' first-parent history that is not its progress. */
async function idsBeforeProgress(git: Git, ids: Oid | null): Promise<Oid | null> {
  if (ids === null) return null;
  const found = (await git.text(['log', '--first-parent', '-1', '--format=%H', '--invert-grep', '--fixed-strings', `--grep=${INITIAL_SYNC_PROGRESS}`, ids])).trim();
  return found === '' ? null : found;
}

/** The documents an initial sync's record in `linear`'s first-parent history left out for unknown provenance. */
async function readProvenanceUnknown(git: Git, linear: Oid): Promise<Set<string>> {
  const log = await git.text(['log', '--first-parent', '--format=%B', '--grep=^Provenance-unknown:', linear]);
  const result = new Set<string>();
  for (const match of log.matchAll(/^Provenance-unknown: (\S+)$/gm)) {
    try {
      result.add(decodeURIComponent(match[1]!));
    } catch { /* A malformed trailer names no document. */ }
  }
  return result;
}

/**
 * The subjects of the commits that take in text from Linear: a capture, a
 * sync's record, an initial sync from Linear, and the pull request of the
 * sync or of an initial sync from Linear merged by squash.
 */
const linearIntakeSubjects = (): ReadonlySet<string> =>
  // Built when used: the modules that define them import this one.
  new Set([CAPTURE_MESSAGE, MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD, INITIAL_SYNC_FROM_LINEAR_TITLE, SYNC_PULL_REQUEST_TITLE]);

/** Whether a commit subject is one of `subjects`; a squash merge adds ` (#<n>)`. */
const hasSubject = (subjects: ReadonlySet<string>, subject: string): boolean => subjects.has(subject.replace(/ \(#\d+\)$/, ''));

/**
 * Whether the tracked branch has taken in text from Linear. A repository that
 * never synced has none, so its first initial sync uploads every
 * repository-file link as before.
 */
async function tookInLinear(git: Git, tracked: Oid): Promise<boolean> {
  const subjects = linearIntakeSubjects();
  // Subjects only, so a commit that merely quotes one in its body does not count.
  const log = await git.text(['log', '--format=%s', '--fixed-strings', ...[...subjects].map((subject) => `--grep=${subject}`), tracked]);
  return log.split('\n').some((subject) => hasSubject(subjects, subject));
}

/** A historical version larger than this is not read: it counts as one no parse reads. */
const HISTORY_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The repository paths that `current` (the links of the tracked text of the
 * document at `path`) names and that a commit taking in a Linear member's
 * text added to that file: the link is in that commit's file and not in its
 * parent's. Those commits are captures and initial syncs from Linear, or
 * their pull requests merged by squash; a sync's record holds what the sync
 * wrote to Linear from git, so it is not one. The history follows the file
 * across renames, and a relative link added under an earlier path counts
 * both where it pointed then and where it points from `path`. A link written
 * in git that those commits only carried over is not one, nor is a capture's
 * own file in the document's `assets/` folder whose bytes still have the hash
 * its name gives: they are an upload's.
 * A version that no parse reads, or that is too large to read, may have
 * added any of them.
 */
export async function linksTakenInFromLinear(git: Git, tracked: Oid, path: string, current: readonly string[]): Promise<Set<string>> {
  // A capture's own file in the document's `assets/` folder: named by its bytes' hash, which they still have.
  const assets = posix.join(posix.dirname(path), ASSETS_FOLDER);
  const named = [...new Set(current.filter((target) => posix.dirname(target) === assets && isCaptureName(target)))];
  const captures = new Set<string>();
  const listed = named.length === 0 ? [] : (await listPaths(git, tracked, named)).filter((entry) => entry.type === 'blob');
  const blobs = listed.length === 0 ? new Map<Oid, Buffer>() : await git.readBlobs(listed.map((entry) => entry.oid));
  for (const entry of listed) {
    const blob = blobs.get(entry.oid);
    if (blob === undefined) continue;
    const hash = parseLfsPointer(blob)?.oid ?? createHash('sha256').update(blob).digest('hex');
    if (posix.basename(entry.path).startsWith(hash)) captures.add(entry.path);
  }
  const wanted = new Set(current.filter((target) => !captures.has(target)));
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  const intake = new Set([CAPTURE_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD, INITIAL_SYNC_FROM_LINEAR_TITLE, SYNC_PULL_REQUEST_TITLE]);
  // The file's history from the repository's root, whatever folder the run started in; one entry per commit.
  const log = await git.text(['log', '-z', '--follow', '-M', '--format=%x01%H %P%x09%s', '--name-status', tracked, '--', `:(top,literal)${path}`]);
  const parsed = new Map<string, Set<string> | null>();
  /** The links of the file at `at` in `commit`, resolved from `at`; null when no parse reads it. */
  const linksAt = async (commit: Oid, at: string): Promise<Set<string> | null> => {
    const [entry] = await listPaths(git, commit, [at]);
    if (entry === undefined || entry.type !== 'blob') return new Set();
    const key = `${entry.oid}\0${at}`;
    if (!parsed.has(key)) {
      let links: Set<string> | null = null;
      if ((entry.size ?? Infinity) <= HISTORY_FILE_BYTES) {
        const blob = (await git.readBlobs([entry.oid])).get(entry.oid);
        try {
          links = new Set(pathLinks(at, splitFile(blob?.toString('utf8') ?? '').body));
        } catch (error) {
          if (!(error instanceof MarkdownLimitError)) throw error;
        }
      }
      parsed.set(key, links);
    }
    return parsed.get(key)!;
  };
  for (const record of log.split('\x01')) {
    const fields = record.split('\0');
    const header = fields[0] ?? '';
    const tab = header.indexOf('\t');
    if (tab === -1 || !hasSubject(intake, header.slice(tab + 1))) continue;
    const [commit, parent] = header.slice(0, tab).split(' ');
    const status = (fields[1] ?? '').trim();
    const renamed = /^[RC]/.test(status);
    const at = renamed ? fields[3] : fields[2];
    if (commit === undefined || at === undefined) continue;
    const links = await linksAt(commit, at);
    if (links === null) return wanted;
    // A copy: the parsed version stays as it is for the commits that share its blob.
    const added = new Set(links);
    // A parent's version no parse reads is taken to hold no link, so the commit may have added any.
    // A document the commit moved keeps a link to the same file, or the same link text, which now points from `at`.
    const before = renamed ? fields[2]! : at;
    if (parent !== undefined && parent !== '') {
      for (const target of await linksAt(parent, before) ?? []) {
        added.delete(target);
        added.delete(relocate(target, before, at));
      }
    }
    for (const target of added) {
      for (const candidate of [target, relocate(target, at, path)]) if (wanted.has(candidate)) found.add(candidate);
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

/**
 * The repository paths the non-image links of a document's body name, also ones the tree does not hold now (the
 * file may come back): the links a Linear member may have written, when the state no longer says. An upload is
 * held in Linear's text as its URL, so it is never one.
 */
export function pathLinks(path: string, body: string): string[] {
  return destinations(body).flatMap(({ node }) => {
    const target = node.type === 'image' ? null : resolveTarget(path, node.url);
    return target === null ? [] : [target];
  });
}
