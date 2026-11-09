// The initial sync from Linear to git: Linear is the model, and one pull
// request makes the synchronized folders of the tracked branch equal to it.
// Nothing is written to Linear.
//
// 1. Plan with the same matching as the other direction (a document matches
//    the file whose path its title names): a matched file gets Linear's text,
//    a document without a file becomes a new file, and a synchronized file
//    without a document is removed. A folder's annotation file is never
//    removed, since the folder's mapping depends on it.
// 2. Take the documents in path order and record their ids in the `ids`
//    state ref as the run goes, in progress commits, so a stopped run
//    resumes with the same inputs and skips what it recorded.
// 3. Record: one atomic push of the final `ids`, `uploads` (created when
//    missing), `linear` and the sync branch. `linear` is one commit whose
//    parent is the tracked branch, whose tree is the tracked tree with
//    every synchronized file replaced by what Linear holds; the sync branch
//    points at it.
// 4. Open the pull request from the sync branch to the tracked branch, or
//    find the one a previous run opened. A person merges it: it can remove
//    files. The sync refuses to run until it is merged.

import { splitFile } from '../format/index.ts';
import { type LinearDocument } from '../linear/index.ts';
import { folderOf, nearestZone } from '../mapping/annotations.ts';
import { type MappedDocument, type Place, type RepositoryMapping, loadMapping } from '../mapping/index.ts';
import { type GitHubRepository, type PullRequest, PullRequestError, ensurePullRequest } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import {
  type CommitIdentity,
  type IdMap,
  type Oid,
  type RefUpdate,
  type StateConfig,
  type StateSnapshot,
  INITIAL_SYNC_FROM_LINEAR_RECORD,
  branchRef,
  commitIds,
  commitTree,
  commitUploads,
  initialSyncProgressMessage,
  listTree,
  pushAtomic,
  readIds,
  readInitialSyncProgress,
  readUploads,
  stateRef,
} from '../state/index.ts';
import { testStopAfterDocuments } from '../test-hooks.ts';
import { FINAL_IDS_MESSAGE, PROGRESS_BATCH, SYNC_IDENTITY, type WriteStop } from './confirm.ts';
import { type LeftOutEntry, type PlanInput, placeKey, planInitialSync } from './plan.ts';
import { readPlanSources } from './run.ts';
import { type BodyTransform, restoreBody } from './transform.ts';

/**
 * The subject of a `linear` record made by an initial sync from Linear to
 * git. The sync refuses to run while such a record is not merged into the
 * tracked branch: its pull request is a person's to merge.
 */
export const REVERSE_RECORD_MESSAGE = INITIAL_SYNC_FROM_LINEAR_RECORD;

export const PULL_REQUEST_TITLE = 'Initial sync from Linear';

/** A document and the file it is, or becomes. */
export interface ReverseEntry {
  path: string;
  title: string;
  place: Place;
  documentId: string;
}

export interface ReversePlan {
  /** Files whose text Linear's replaces (same path, front matter kept). */
  overwrite: ReverseEntry[];
  /** New files, one per document without a file. */
  create: ReverseEntry[];
  /** Synchronized files without a document; the pull request removes them. */
  remove: string[];
  /** Synchronized files without a document that stay, and why. */
  kept: Array<{ path: string; reason: 'annotation' }>;
  /** Files left out on the git side, and documents left out on the Linear side (`path` is where their file would be). */
  leftOut: LeftOutEntry[];
}

export interface ReversePlanInput extends PlanInput {
  /** Every path of the tracked tree, so a new file never lands on an existing one. */
  treePaths: ReadonlySet<string>;
}

/**
 * Builds the plan. A document is left out when its title is not a plain
 * path as it is (`title-not-a-path`) or when its file would collide with
 * another file, in a case-insensitive file system too (`duplicate-title`):
 * the older of two documents with one title keeps it.
 */
export function planLinearToGit(input: ReversePlanInput): ReversePlan {
  const plan = planInitialSync(input);
  const annotations = new Set(input.mapping.annotations.map((annotation) => annotation.readme));
  const result: ReversePlan = { overwrite: plan.overwrite.map(entryOf), create: [], remove: [], kept: [], leftOut: [...plan.leftOut] };
  for (const entry of plan.create) {
    if (annotations.has(entry.path)) result.kept.push({ path: entry.path, reason: 'annotation' });
    else result.remove.push(entry.path);
  }

  const removed = new Set(result.remove);
  const occupied = new Map<string, string>();
  for (const path of input.treePaths) if (!removed.has(path)) occupied.set(pathKey(path), path);
  const collision = (path: string): string | undefined => {
    const key = pathKey(path);
    const same = occupied.get(key);
    if (same !== undefined) return same;
    // A file where a folder is needed, or the other way round.
    for (const [other, original] of occupied) if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) return original;
    return undefined;
  };
  // In the plan, a document without a file is listed for trash, oldest first within a path.
  for (const entry of plan.trash) {
    if (!isPlainTitle(entry.title) || !landsInPlace(input.mapping, entry.path, entry.place)) {
      result.leftOut.push({ path: entry.path, rules: ['title-not-a-path'], lines: [], documentId: entry.documentId });
      continue;
    }
    const other = collision(entry.path);
    if (other !== undefined) {
      result.leftOut.push({ path: entry.path, rules: ['duplicate-title'], lines: [], collidesWith: [other], documentId: entry.documentId });
      continue;
    }
    result.create.push(entryOf(entry));
    occupied.set(pathKey(entry.path), entry.path);
  }
  result.remove.sort(compare);
  result.leftOut.sort((a, b) => compare(a.path, b.path));
  return result;
}

/** Whether a file at `path` maps to `place`: a title can name a folder that another annotation owns. */
function landsInPlace(mapping: RepositoryMapping, path: string, place: Place): boolean {
  const zone = nearestZone(mapping.zones, folderOf(path));
  if (zone === undefined) return false;
  const zonePlace: Place = zone.project !== undefined ? { kind: 'project', team: zone.team, project: zone.project } : { kind: 'team', team: zone.team };
  return placeKey(zonePlace) === placeKey(place);
}

/**
 * A title that is a file path as it is: segments that are not empty, `.` or
 * `..`, without characters that file systems or URLs treat specially, without
 * leading or trailing spaces and dots, and not a name Windows reserves.
 * Other titles wait for a rule that encodes them.
 */
export function isPlainTitle(title: string): boolean {
  return title.split('/').every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      segment.toLowerCase() !== '.git' &&
      !/[%\\\u0000-\u001f\u007f:*?"<>|]/.test(segment) &&
      !/^[ ]|[. ]$/.test(segment) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) &&
      Buffer.byteLength(segment) <= 180,
  );
}

/** The dry run's plan: reads the files and lists the documents, without content. */
export async function planLinearToGitFromRepository(context: RunContext): Promise<ReversePlan> {
  const { input } = await readPlanSources(context);
  const treePaths = new Set((await listTree(context.git, context.fetched.tracked)).map((entry) => entry.path));
  return planLinearToGit({ ...input, treePaths });
}

export interface ReverseOptions {
  config: StateConfig;
  /** Where the pull request is opened, with the token the run acts as. */
  github: GitHubRepository;
  transforms?: readonly BodyTransform[];
  identity?: CommitIdentity;
  progressBatch?: number;
  /** Stop after this many documents, as if the budget ran low; the test hook's value by default. */
  stopAfterDocuments?: number | undefined;
}

export interface ReverseResult {
  /** Every document taken, the state recorded and the pull request open (or not needed). */
  complete: boolean;
  /**
   * `sync-branch-changed`: the sync branch holds commits this sync did not
   * make (a person's, on the open pull request); nothing was recorded.
   */
  code?: 'stopped' | 'state-moved' | 'pull-request-failed' | 'sync-branch-changed';
  /** The run continued an unfinished one. */
  resumed: boolean;
  overwritten: string[];
  created: string[];
  /** Recorded by the unfinished run this one continued. */
  skippedCompleted: string[];
  removed: string[];
  /**
   * Planned files left out once their text was known: `front-matter-boundary`
   * when the document's text would not stay the file's body (it starts with
   * what reads as front matter), `title-not-a-path` when the new tree maps the
   * file to another document. Such a file keeps the tracked branch's version.
   */
  leftOutAtRecord: Array<{ path: string; rule: string }>;
  notAttempted: string[];
  stopped?: WriteStop;
  progressPushes: number;
  record: ReverseRecord | null;
  /** The pull request a person merges; null when the tracked branch already equals Linear. */
  pullRequest: (PullRequest & { opened: boolean }) | null;
  /** The HTTP status of a failed pull request request; absent when GitHub could not be reached. */
  pullRequestStatus?: number;
}

export interface ReverseRecord {
  linear: Oid;
  /** False when the refs already held this record. */
  moved: boolean;
  parents: Oid[];
  hasTrackedParent: boolean;
  /** Its tree differs from the tracked branch's, so a pull request carries it. */
  changesTracked: boolean;
}

export async function confirmLinearToGit(context: RunContext, options: ReverseOptions): Promise<{ plan: ReversePlan; result: ReverseResult }> {
  const { git, fetched } = context;
  const transforms = options.transforms ?? [];
  const identity = options.identity ?? SYNC_IDENTITY;
  const batch = Math.max(1, options.progressBatch ?? PROGRESS_BATCH);
  const stopAfter = 'stopAfterDocuments' in options ? options.stopAfterDocuments : testStopAfterDocuments();

  const { input, documents } = await readPlanSources(context, { withContent: true });
  const treePaths = new Set((await listTree(git, fetched.tracked)).map((entry) => entry.path));
  const plan = planLinearToGit({ ...input, treePaths });

  const expected: StateSnapshot = { ...fetched.state };
  const resumed = (await readInitialSyncProgress(git, expected.ids)) !== null;
  const previous = await readIds(git, expected.ids);
  const ids: IdMap = resumed ? new Map(previous) : new Map();
  const result: ReverseResult = {
    complete: false,
    resumed,
    overwritten: [],
    created: [],
    skippedCompleted: [],
    removed: [],
    leftOutAtRecord: [],
    notAttempted: [],
    progressPushes: 0,
    record: null,
    pullRequest: null,
  };

  let unpushed = 0;
  const pushProgress = async (): Promise<boolean> => {
    const next = await commitIds(git, expected.ids, ids, identity, { message: initialSyncProgressMessage(fetched.tracked), always: true });
    const pushed = await pushAtomic(git, options.config, [{ ref: stateRef(options.config, 'ids'), expected: expected.ids, next }]);
    if (!pushed.ok) return false;
    expected.ids = next;
    result.progressPushes += 1;
    unpushed = 0;
    return true;
  };

  // Take the documents in path order. Each needs no request now; the order
  // and the progress commits are what a resumed run relies on.
  const work = [...plan.overwrite.map((entry) => ({ kind: 'overwrite' as const, entry })), ...plan.create.map((entry) => ({ kind: 'create' as const, entry }))].sort(
    (a, b) => compare(a.entry.path, b.entry.path),
  );
  const completed = (entry: ReverseEntry) => resumed && previous.get(entry.path)?.id === entry.documentId;
  let taken = 0;
  for (let index = 0; index < work.length; index += 1) {
    const { kind, entry } = work[index] as (typeof work)[number];
    if (completed(entry)) {
      result.skippedCompleted.push(entry.path);
      continue;
    }
    const stop = context.linear.stopped ?? (stopAfter !== undefined && taken >= stopAfter ? { kind: 'test-threshold' as const, documents: stopAfter } : undefined);
    if (stop !== undefined) {
      result.stopped = stop;
      result.notAttempted = work.slice(index).filter((rest) => !completed(rest.entry)).map((rest) => rest.entry.path);
      break;
    }
    const before = previous.get(entry.path);
    ids.set(entry.path, before !== undefined && before.id === entry.documentId && before.saved !== undefined ? { id: entry.documentId, saved: before.saved } : { id: entry.documentId });
    (kind === 'overwrite' ? result.overwritten : result.created).push(entry.path);
    taken += 1;
    // An id the `ids` ref already holds needs no progress push: running again after a finished run moves no ref.
    if (before?.id !== entry.documentId) unpushed += 1;
    if (unpushed >= batch && !(await pushProgress())) return { plan, result: { ...result, code: 'state-moved' } };
  }
  if (result.stopped !== undefined) {
    if (unpushed > 0 && !(await pushProgress())) return { plan, result: { ...result, code: 'state-moved' } };
    result.code = 'stopped';
    return { plan, result };
  }

  const recorded = await record();
  if (recorded === 'sync-branch-changed') {
    result.code = 'sync-branch-changed';
    return { plan, result };
  }
  if (recorded === null) {
    result.code = 'state-moved';
    return { plan, result };
  }
  result.record = recorded;
  result.removed = [...plan.remove];

  if (recorded.changesTracked) {
    try {
      const { pullRequest, opened } = await ensurePullRequest(options.github, {
        head: options.config.syncBranch,
        base: options.config.trackedBranch,
        title: PULL_REQUEST_TITLE,
        body: pullRequestBody(plan, result),
      });
      result.pullRequest = { ...pullRequest, opened };
    } catch (error) {
      // GitHub refused, timed out or could not be reached. The state is recorded;
      // running again with the same inputs changes no ref and opens the pull request.
      result.code = 'pull-request-failed';
      if (error instanceof PullRequestError) result.pullRequestStatus = error.status;
      return { plan, result };
    }
  }
  result.complete = true;
  return { plan, result };

  /**
   * Builds the record and pushes it with the final ids, the uploads and,
   * when the record changes the tracked branch, the sync branch. Null when a
   * ref moved.
   */
  async function record(): Promise<ReverseRecord | null | 'sync-branch-changed'> {
    const restored = (entry: ReverseEntry): string =>
      restoreBody(transforms, entry.path, (documents.get(entry.documentId) as LinearDocument).content ?? '');
    const textOf = (entry: ReverseEntry): string => {
      const body = restored(entry);
      const tracked = input.texts.get(entry.path);
      if (tracked === undefined) return body;
      const { head } = splitFile(tracked);
      // A file that ends right after its closing fence needs a line break before the body
      // (a head that is only a byte order mark has no fence).
      const fenced = head.replace(/^﻿/, '') !== '';
      return fenced && body !== '' && !head.endsWith('\n') ? `${head}\n${body}` : head + body;
    };
    const leaveOut = (paths: Iterable<string>, rule: string) => {
      const out = new Set(paths);
      if (out.size === 0) return;
      for (const path of out) {
        result.leftOutAtRecord.push({ path, rule });
        ids.delete(path);
      }
      entries = entries.filter((entry) => !out.has(entry.path));
      result.created = result.created.filter((path) => !out.has(path));
      result.overwritten = result.overwritten.filter((path) => !out.has(path));
      result.skippedCompleted = result.skippedCompleted.filter((path) => !out.has(path));
    };

    let entries = [...plan.overwrite, ...plan.create];
    // The document's text must stay the file's body: text that reads as front
    // matter would become the file's metadata (or a folder's annotation).
    leaveOut(entries.filter((entry) => splitFile(textOf(entry)).body !== restored(entry)).map((entry) => entry.path), 'front-matter-boundary');
    let commit = await build(entries);
    // The new tree must map every file back to its document's title and place.
    const created = new Set(plan.create.map((entry) => entry.path));
    for (let attempt = 0; ; attempt += 1) {
      const misplaced = mismatches(await loadMapping(git, commit), entries);
      if (misplaced.length === 0) break;
      if (attempt > 0) throw new Error(`the recorded tree maps ${misplaced.length} files to other documents`);
      // A new file can only move others when it is a README that names a folder's team or project.
      const moved = misplaced.some((path) => !created.has(path));
      const newReadmes = moved ? entries.filter((entry) => created.has(entry.path) && /(^|\/)README\.md$/.test(entry.path)).map((entry) => entry.path) : [];
      leaveOut([...misplaced.filter((path) => created.has(path)), ...newReadmes], 'title-not-a-path');
      commit = await build(entries);
    }

    async function build(list: readonly ReverseEntry[]): Promise<Oid> {
      const changes = new Map<string, string | null>(list.map((entry) => [entry.path, textOf(entry)]));
      for (const path of plan.remove) changes.set(path, null);
      return commitTree(git, { parents: [fetched.tracked], base: fetched.tracked, changes, message: REVERSE_RECORD_MESSAGE, identity, skipIfUnchanged: false });
    }

    const trees = (await git.text(['show', '-s', '--format=%T', commit, fetched.tracked])).split('\n');
    const changesTracked = trees[0] !== trees[1];
    // Rerunning reuses an equal record (tree, parent and message), so nothing moves.
    for (const previousRecord of [expected.linear, fetched.sync]) {
      if (previousRecord !== null && (await sameRecord(previousRecord, commit))) {
        commit = previousRecord;
        break;
      }
    }
    // The sync branch is the pull request's head: replace it only while it holds nothing but a record of this sync.
    // An earlier record's pull request still open is moved to the new record too, so it never merges stale text.
    const ownSync = fetched.sync !== null && fetched.sync !== commit && (await isOwnRecord(fetched.sync));
    if (changesTracked && fetched.sync !== null && fetched.sync !== commit && !ownSync) return 'sync-branch-changed';
    const moveSync = fetched.sync !== commit && (changesTracked || ownSync);

    const synced = new Set(entries.map((entry) => entry.path));
    const finalIds: IdMap = new Map([...ids].filter(([path]) => synced.has(path)));
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      message: FINAL_IDS_MESSAGE,
      always: (await readInitialSyncProgress(git, expected.ids)) !== null,
    });
    const uploadsCommit = await commitUploads(git, expected.uploads, await readUploads(git, expected.uploads), identity);
    const updates: RefUpdate[] = [
      { ref: stateRef(options.config, 'ids'), expected: expected.ids, next: idsCommit },
      { ref: stateRef(options.config, 'uploads'), expected: expected.uploads, next: uploadsCommit },
      // Initial sync replaces `linear`: its new record does not descend from an earlier one.
      { ref: stateRef(options.config, 'linear'), expected: expected.linear, next: commit, replace: true },
    ];
    if (moveSync) updates.push({ ref: branchRef(options.config.syncBranch), expected: fetched.sync, next: commit, replace: true });
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    const parents = (await git.text(['show', '-s', '--format=%P', commit])).split(' ').filter(Boolean);
    return {
      linear: commit,
      moved: pushed.updated.length > 0,
      parents,
      hasTrackedParent: parents.length === 1 && parents[0] === fetched.tracked,
      changesTracked,
    };
  }

  /** Whether two commits have the same tree, parents and subject, so the newer one adds nothing. */
  async function sameRecord(a: Oid, b: Oid): Promise<boolean> {
    const describe = (oid: Oid) => git.text(['show', '-s', '--format=%T %P%n%s', oid]);
    return (await describe(a)) === (await describe(b));
  }

  /** A record an initial sync from Linear made: its subject, the sync's identity, one parent. */
  async function isOwnRecord(oid: Oid): Promise<boolean> {
    const [subject, email, parents] = (await git.text(['show', '-s', '--format=%s%n%ae%n%P', oid])).split('\n');
    return subject === REVERSE_RECORD_MESSAGE && email === identity.email && (parents ?? '').split(' ').filter(Boolean).length === 1;
  }
}

/** Paths whose file the mapping of the new tree does not give the entry's title and place. */
function mismatches(mapping: RepositoryMapping, entries: readonly ReverseEntry[]): string[] {
  const mapped = new Map<string, MappedDocument>(mapping.documents.map((document) => [document.path, document]));
  return entries
    .filter((entry) => {
      const file = mapped.get(entry.path);
      return file === undefined || placeKey(file.place) !== placeKey(entry.place) || file.title.normalize('NFC') !== entry.title.normalize('NFC');
    })
    .map((entry) => entry.path)
    .sort(compare);
}

/** The pull request's text: counts and paths, never content. */
export function pullRequestBody(plan: ReversePlan, result: ReverseResult): string {
  const lines = [
    'This pull request makes the synchronized folders equal to Linear, as an initial sync from Linear asked.',
    '',
    `- ${count(plan.overwrite.length, 'file')} take Linear's text (front matter kept);`,
    `- ${count(plan.create.length - result.leftOutAtRecord.length, 'file')} are new, one per document only in Linear;`,
    `- ${count(plan.remove.length, 'file')} are removed: they have no document in Linear.`,
    '',
    'Review it and merge it with a merge commit. The sync does not merge it, because it removes files, and it does not run until this pull request is merged. Removed files stay in the history.',
  ];
  if (plan.remove.length > 0) {
    lines.push('', '### Removed files', '');
    for (const path of plan.remove.slice(0, 100)) lines.push(`- \`${path.replace(/`/g, "'")}\``);
    if (plan.remove.length > 100) lines.push(`- and ${plan.remove.length - 100} more`);
  }
  return `${lines.join('\n')}\n`;
}

function entryOf(entry: { path: string; title: string; place: Place; documentId: string }): ReverseEntry {
  return { path: entry.path, title: entry.title, place: entry.place, documentId: entry.documentId };
}

function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
