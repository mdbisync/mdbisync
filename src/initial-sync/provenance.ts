// Which repository-file links of a document came from Linear, for an
// initial sync from git that rebuilds the state (the recovery path).
//
// Capture turns an image a Linear member wrote with a repository path into a
// plain link and records its target as a plain file of that document: such a
// link never authorizes an upload. The ids entries and the `Plain-link:`
// trailers of the state's commits carry this. A confirmed initial sync reads
// them back by document identity before it uploads anything, and keeps them
// in the ids it records.

import { posix } from 'node:path';
import { type Git, type IdMap, type Oid, type StateSnapshot, INITIAL_SYNC_FROM_LINEAR_RECORD, INITIAL_SYNC_PROGRESS, readIds } from '../state/index.ts';
import { readPlainFileProvenance } from '../sync/pull-repairs.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from '../sync/write.ts';
import { SYNC_PULL_REQUEST_TITLE } from '../sync/pull-request.ts';
import { CAPTURE_MESSAGE } from '../sync/capture.ts';
import { type InitialSyncPlan } from './plan.ts';

/**
 * The trailer of an initial sync's record that names a document it left out
 * because its provenance is unknown: a later recovery leaves it out again
 * until its links no longer need provenance, instead of trusting the record.
 */
export function provenanceUnknownTrailer(id: string): string {
  return `Provenance-unknown: ${encodeURIComponent(id)}`;
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
 * branch's whole history cannot grant one.
 */
export async function readPlainLinkProvenance(git: Git, state: Pick<StateSnapshot, 'ids' | 'linear'>, tracked: Oid, plan: InitialSyncPlan): Promise<PlainLinkProvenance> {
  const entries: IdMap[] = [await readIds(git, state.ids)];
  const before = await idsBeforeProgress(git, state.ids);
  if (before !== null && before !== state.ids) entries.push(await readIds(git, before));

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
  const idsLost = entries.every((ids) => ids.size === 0);
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
  const known = new Set(entries.flatMap((ids) => [...ids.values()].map((entry) => entry.id)));
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
 * Whether the tracked branch has taken in text from Linear: a capture, a
 * sync's record, an initial sync from Linear, or the sync's pull request
 * merged by squash. A repository that never synced has none, so its first
 * initial sync uploads every repository-file link as before.
 */
async function tookInLinear(git: Git, tracked: Oid): Promise<boolean> {
  const subjects = new Set([CAPTURE_MESSAGE, MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD, SYNC_PULL_REQUEST_TITLE]);
  // Subjects only, so a commit that merely quotes one in its body does not count; a squash merge adds ` (#<n>)`.
  const log = await git.text(['log', '--format=%s', '--fixed-strings', ...[...subjects].map((subject) => `--grep=${subject}`), tracked]);
  return log.split('\n').some((subject) => subjects.has(subject.replace(/ \(#\d+\)$/, '')));
}
