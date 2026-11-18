// Which repository-file links of a document came from Linear, for an
// initial sync from git that rebuilds the state (the recovery path).
//
// Capture turns an image a Linear member wrote with a repository path into a
// plain link and records its target as a plain file of that document: such a
// link never authorizes an upload. The ids entries and the `Plain-link:`
// trailers of the state's commits carry this. A confirmed initial sync reads
// them back by document identity before it uploads anything, and keeps them
// in the ids it records.

import { type Git, type IdMap, type Oid, type StateSnapshot, INITIAL_SYNC_FROM_LINEAR_RECORD, INITIAL_SYNC_PROGRESS, readIds } from '../state/index.ts';
import { readPlainFileProvenance } from '../sync/pull-repairs.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from '../sync/write.ts';
import { SYNC_PULL_REQUEST_TITLE } from '../sync/pull-request.ts';
import { type InitialSyncPlan } from './plan.ts';

/** The subject of a capture commit on the `linear` ref: Linear members' text entering git. */
export const CAPTURE_MESSAGE = 'Capture Linear changes';

export interface PlainLinkProvenance {
  /** The targets of plain links that came from Linear, by document path. */
  plainFiles: Map<string, Set<string>>;
  /**
   * Documents Linear holds whose provenance the state cannot give: `linear`
   * and their ids entries are lost, while the tracked branch has taken in
   * Linear's text before. A non-image repository-file link in one leaves the
   * document out instead of uploading the file.
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
  for (const ids of entries) for (const entry of ids.values()) add(entry.id, entry.plainFiles ?? []);
  if (state.linear !== null) for (const [id, targets] of await readPlainFileProvenance(git, state.linear)) add(id, targets);
  for (const [id, targets] of await readTrackedPlainFiles(git, tracked)) add(id, targets);

  const plainFiles = new Map<string, Set<string>>();
  const matched = new Map(plan.overwrite.map((entry) => [entry.path, entry.documentId]));
  for (const entry of [...plan.create, ...plan.overwrite]) {
    const targets = new Set<string>();
    const identities = new Set<string>(entries.flatMap((ids): string[] => {
      const old = ids.get(entry.path);
      for (const target of old?.plainFiles ?? []) targets.add(target);
      return old === undefined ? [] : [old.id];
    }));
    const documentId = matched.get(entry.path);
    if (documentId !== undefined) identities.add(documentId);
    for (const id of identities) for (const target of byId.get(id) ?? []) targets.add(target);
    if (targets.size > 0) plainFiles.set(entry.path, targets);
  }

  // With `linear` present, its trailers and the ids are the whole record. Without it, an ids entry still is for
  // its document; any other document Linear holds may carry a Linear member's link the state no longer names.
  const unknown = new Set<string>();
  if (state.linear === null && plan.overwrite.length > 0) {
    const known = new Set(entries.flatMap((ids) => [...ids.values()].map((entry) => entry.id)));
    const unproven = plan.overwrite.filter((entry) => !known.has(entry.documentId));
    if (unproven.length > 0 && await tookInLinear(git, tracked)) for (const entry of unproven) unknown.add(entry.path);
  }
  return { plainFiles, unknown };
}

/** The ids commit an unfinished initial sync started from: the first one of `ids`' first-parent history that is not its progress. */
async function idsBeforeProgress(git: Git, ids: Oid | null): Promise<Oid | null> {
  if (ids === null) return null;
  const log = await git.text(['log', '--first-parent', '--format=%H %s', ids]);
  for (const line of log.split('\n')) {
    const cut = line.indexOf(' ');
    if (cut !== -1 && line.slice(cut + 1) !== INITIAL_SYNC_PROGRESS) return line.slice(0, cut);
  }
  return null;
}

/** `Plain-link:` trailers of every commit the tracked branch holds, by document id. */
async function readTrackedPlainFiles(git: Git, tracked: Oid): Promise<Map<string, Set<string>>> {
  const log = await git.text(['log', '--format=%B', '--grep=^Plain-link:', tracked]);
  const result = new Map<string, Set<string>>();
  for (const match of log.matchAll(/^Plain-link: (\S+) (\S+)$/gm)) {
    try {
      const id = decodeURIComponent(match[1]!);
      const target = decodeURIComponent(match[2]!);
      result.set(id, (result.get(id) ?? new Set()).add(target));
    } catch { /* A malformed trailer names nothing. */ }
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
  const subjects = [CAPTURE_MESSAGE, MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE, INITIAL_SYNC_FROM_LINEAR_RECORD, SYNC_PULL_REQUEST_TITLE];
  const found = await git.text(['log', '-1', '--format=%H', '--fixed-strings', ...subjects.map((subject) => `--grep=${subject}`), tracked]);
  return found.trim() !== '';
}
