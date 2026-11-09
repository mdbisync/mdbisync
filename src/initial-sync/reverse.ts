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
// 3. Download the files the documents embed from Linear's upload host (a
//    file the tracked tree already holds, by content hash, is linked
//    instead), next to their documents, stored as `.gitattributes` decides.
// 4. Record: one atomic push of the final `ids`, `uploads` (created when
//    missing), `linear` and the sync branch. `linear` is one commit whose
//    parent is the tracked branch, whose tree is the tracked tree with
//    every synchronized file replaced by what Linear holds; the sync branch
//    points at it.
// 5. Open the pull request from the sync branch to the tracked branch, or
//    find the one a previous run opened. A person merges it: it can remove
//    files. The sync refuses to run until it is merged.

import { posix } from 'node:path';
import { splitFile } from '../format/index.ts';
import { type LinearDocument, LinearStoppedError } from '../linear/index.ts';
import { folderOf, nearestZone } from '../mapping/annotations.ts';
import { type MappedDocument, type Place, type RepositoryMapping, loadMapping } from '../mapping/index.ts';
import {
  type GitHubRepository,
  type PullRequest,
  PullRequestError,
  closePullRequest,
  ensurePullRequest,
  findOpenPullRequest,
} from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import {
  type CommitIdentity,
  type IdMap,
  type Oid,
  type RefUpdate,
  type StateConfig,
  type StateSnapshot,
  type UploadMap,
  INITIAL_SYNC_FROM_LINEAR_RECORD,
  branchRef,
  parseLfsPointer,
  isAncestor,
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
import { createAssetCapture } from '../sync/assets.ts';
import { prepareLfs } from '../sync/capture.ts';
import { type SecurityGate, securityGate } from '../sync/security.ts';
import { documentPath, titlePath } from '../sync/paths.ts';
import { testStopAfterDocuments } from '../test-hooks.ts';
import { FINAL_IDS_MESSAGE, PROGRESS_BATCH, SYNC_IDENTITY, type WriteStop } from './confirm.ts';
import { type LeftOutEntry, type PlanInput, annotatedPlaces, placeKey, planInitialSync } from './plan.ts';
import { readPlanSources } from './run.ts';
import { type LinkMap, type LinkSpellings, documentUrlBase, linksFromLinear, linksToLinear, workspaceUrlKey } from './links.ts';
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
  /**
   * The title the file's path gives it: the document's title, or its encoded
   * form when the title is not a path as it is.
   */
  fileTitle: string;
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
 * Builds the plan. A new file is named by the rule the sync's capture uses
 * (`documentPath`): the title's path, with characters a path cannot hold
 * percent-encoded; a name that would land on another file (in a
 * case-insensitive file system too), or in a folder another annotation
 * owns, gets a suffix made from the document's id instead. Titles in Linear
 * stay as they are.
 */
export function planLinearToGit(input: ReversePlanInput): ReversePlan {
  const plan = planInitialSync(input);
  const annotations = new Set(input.mapping.annotations.map((annotation) => annotation.readme));
  const result: ReversePlan = { overwrite: plan.overwrite.map(entryOf), create: [], remove: [], kept: [], leftOut: [...plan.leftOut] };
  const folders = new Map(annotatedPlaces(input.mapping.zones).map(({ place, folder }) => [placeKey(place), folder]));
  const invalid = (place: Place) => (candidate: string) => !landsInPlace(input.mapping, candidate, place);

  const folderOfPlace = (place: Place) => folders.get(placeKey(place)) ?? '';
  const plainPath = (title: string, place: Place) => `${posix.join(folderOfPlace(place), titlePath(title))}.md`;
  const named = new Map<string, string>();

  // An encoded name belongs to the title it encodes: `Q3%3A goals.md` is the file of `Q3: goals`, even when
  // another document is titled `Q3%3A goals` (whose own name the rule encodes to `Q3%253A goals.md`).
  const trash = [...plan.trash];
  const overwriteByPath = new Map(result.overwrite.map((entry) => [entry.path, entry]));
  for (const entry of plan.trash) {
    const plain = plainPath(entry.title, entry.place);
    const other = overwriteByPath.get(plain);
    if (other === undefined || placeKey(other.place) !== placeKey(entry.place) || plainPath(other.title, other.place) === plain) continue;
    result.overwrite = result.overwrite.filter((candidate) => candidate !== other);
    const claimed = { path: plain, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: other.fileTitle };
    result.overwrite.push(claimed);
    overwriteByPath.set(plain, claimed);
    named.set(entry.documentId, plain);
    // The other document now has no file: it is named like any document without one.
    trash.push({ path: plain, title: other.title, place: other.place, documentId: other.documentId });
  }

  // A file without a document by title can be one by the naming rule: the file an earlier run named for an encoded title.
  const gitOnly = new Map(plan.create.map((entry) => [entry.path, entry]));
  // Oldest first, as in the other direction: the older of two documents keeps the plain name.
  const created = new Map(input.places.flatMap(({ documents }) => documents.map((document) => [document.id, document.createdAt] as const)));
  const documentsOldestFirst = trash
    .filter((entry) => !named.has(entry.documentId))
    .sort((a, b) => compare(created.get(a.documentId) ?? '', created.get(b.documentId) ?? '') || compare(a.documentId, b.documentId));
  for (const entry of documentsOldestFirst) {
    const folder = folderOfPlace(entry.place);
    const plain = plainPath(entry.title, entry.place);
    for (const [path, file] of gitOnly) {
      // Only the plain encoded name or a suffixed one (`~`) can be the rule's; `documentPath` decides.
      if (path !== plain && !(path.startsWith(folder === '' ? '' : `${folder}/`) && path.includes('~'))) continue;
      if (placeKey(file.place) !== placeKey(entry.place)) continue;
      const others = new Set([...input.treePaths].filter((other) => other !== path));
      if (documentPath(folder, entry.title, entry.documentId, others, path, invalid(entry.place)) !== path) continue;
      result.overwrite.push({ path, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: file.title });
      named.set(entry.documentId, path);
      gitOnly.delete(path);
      break;
    }
  }
  for (const entry of gitOnly.values()) {
    if (annotations.has(entry.path)) result.kept.push({ path: entry.path, reason: 'annotation' });
    else result.remove.push(entry.path);
  }

  const removed = new Set(result.remove);
  const occupied = new Set([...input.treePaths].filter((path) => !removed.has(path)));
  for (const entry of documentsOldestFirst) {
    if (named.has(entry.documentId)) continue;
    const folder = folderOfPlace(entry.place);
    const path = documentPath(folder, entry.title, entry.documentId, occupied, undefined, invalid(entry.place));
    result.create.push({ path, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: posix.relative(folder, path).slice(0, -'.md'.length) });
    occupied.add(path);
  }
  result.overwrite.sort((a, b) => compare(a.path, b.path));
  result.create.sort((a, b) => compare(a.path, b.path));
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
  /** The repository's security hooks; read from the tracked branch by default. */
  security?: SecurityGate;
  /** Downloads files from Linear's upload host; the Linear client's authenticated request by default. */
  fetch?: typeof fetch;
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
   * file to another document, `download-failed` when a file the document
   * embeds could not be downloaded (gone, over 10 MB, redirected elsewhere).
   * Such a file keeps the tracked branch's version; an existing one also keeps
   * its document's id (`front-matter-boundary`, `download-failed`).
   */
  leftOutAtRecord: Array<{ path: string; rule: string }>;
  notAttempted: string[];
  stopped?: WriteStop;
  progressPushes: number;
  record: ReverseRecord | null;
  /**
   * The pull request a person merges; null when the tracked branch already
   * equals Linear and no earlier pull request of this sync is open.
   * `updated`: an open one got a new title or description.
   */
  pullRequest: (PullRequest & { opened: boolean; updated: boolean }) | null;
  /** An earlier record's pull request this run closed, because the tracked branch already equals Linear. */
  closedPullRequest?: number;
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
  /** The sync branch points at this record, which changes the tracked branch: a pull request must show it. */
  needsPullRequest: boolean;
  /** The record changes nothing, and the sync branch holds an earlier record whose pull request may still be open. */
  closesPullRequest: boolean;
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

  // The sync branch is the pull request's head. Holding commits this sync did
  // not make that the tracked branch has not merged (a person's review, or the
  // cycle's open pull request), it is left as it is: stop before writing anything.
  if (fetched.sync !== null && !(await isOwnRecord(fetched.sync)) && !(await isAncestor(git, fetched.sync, fetched.tracked))) {
    result.code = 'sync-branch-changed';
    return { plan, result };
  }

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
    // Taking a document makes no request (the listing read every text), so
    // only the test threshold stops here, not a budget that ran low on the last page.
    if (stopAfter !== undefined && taken >= stopAfter) {
      result.stopped = { kind: 'test-threshold', documents: stopAfter };
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

  try {
    if (recorded.needsPullRequest) {
      const { pullRequest, opened, updated } = await ensurePullRequest(options.github, {
        head: options.config.syncBranch,
        base: options.config.trackedBranch,
        title: PULL_REQUEST_TITLE,
        body: pullRequestBody(plan, result),
      });
      result.pullRequest = { ...pullRequest, opened, updated };
    } else if (recorded.closesPullRequest) {
      // The tracked branch already equals Linear: an earlier record's open pull request has nothing left to carry.
      const open = await findOpenPullRequest(options.github, options.config.syncBranch, options.config.trackedBranch);
      if (open !== null) {
        await closePullRequest(options.github, open.number);
        result.closedPullRequest = open.number;
      }
    }
  } catch (error) {
    // GitHub refused, timed out or could not be reached. The state is recorded;
    // running again with the same inputs changes no ref and finishes the pull request step.
    result.code = 'pull-request-failed';
    if (error instanceof PullRequestError) result.pullRequestStatus = error.status;
    return { plan, result };
  }
  result.complete = true;
  return { plan, result };

  /**
   * Builds the record and pushes it with the final ids, the uploads and,
   * when the record changes the tracked branch, the sync branch. Null when a
   * ref moved.
   */
  async function record(): Promise<ReverseRecord | null | 'sync-branch-changed'> {
    // Each document's body once its embedded files are downloaded, the files, and their upload URLs by content hash.
    const bodies = new Map<string, { body: string; files: Map<string, Buffer>; uploads: UploadMap }>();
    // A link to another synchronized document's URL becomes a relative link to its file, as the capture does:
    // only to a file the record holds, so the links follow every file left out on the way.
    let linkBase: string | undefined;
    const documentOf = new Map([...plan.overwrite, ...plan.create].map((entry) => [entry.path, entry.documentId]));
    let linkMemo: { entries: readonly ReverseEntry[]; kept: number; map: LinkMap } | undefined;
    const linkMap = (base: string): LinkMap => {
      if (linkMemo?.entries !== entries || linkMemo.kept !== keptTracked.size) {
        const ids = new Map([...entries.map((entry): [string, string] => [entry.path, entry.documentId]), ...[...keptTracked].map((path): [string, string] => [path, documentOf.get(path) as string])]);
        linkMemo = { entries, kept: keptTracked.size, map: { base, ids } };
      }
      return linkMemo.map;
    };
    const restored = (entry: ReverseEntry): string => {
      const { body } = bodies.get(entry.path) as { body: string };
      if (linkBase === undefined) return body;
      const map = linkMap(linkBase);
      // The tracked file's own spelling of each link comes back as it was.
      const seen: LinkSpellings = new Map();
      const tracked = input.texts.get(entry.path);
      if (tracked !== undefined) linksToLinear(splitFile(tracked).body, entry.path, map, seen);
      return linksFromLinear(body, entry.path, map, seen);
    };
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
    const uploads = await readUploads(git, expected.uploads);
    const download = createAssetCapture(git, options.config, fetched.tracked, options.fetch ?? ((url, init) => context.linear.transport.fetchUpload(String(url), init)));
    const failed: string[] = [];
    if (entries.some((entry) => ((documents.get(entry.documentId) as LinearDocument).content ?? '').includes('https://linear.app/'))) {
      linkBase = documentUrlBase(await workspaceUrlKey(context.linear));
    }
    for (const entry of entries) {
      const content = (documents.get(entry.documentId) as LinearDocument).content ?? '';
      const tracked = input.texts.get(entry.path);
      const trackedBody = tracked === undefined ? undefined : splitFile(tracked).body;
      try {
        // A file the tracked text links keeps its path; other uploads are downloaded next to the document.
        const captured = await download(entry.path, restoreBody(transforms, entry.path, content, content), uploads, trackedBody);
        bodies.set(entry.path, captured);
      } catch (error) {
        if (error instanceof LinearStoppedError) throw error;
        // Not downloadable (gone, over the size limit, a redirect elsewhere): the file keeps the tracked branch's version.
        failed.push(entry.path);
      }
    }
    const created = new Set(plan.create.map((entry) => entry.path));
    // A new file is left out; an existing one keeps the tracked text and its
    // document's id, so the document stays its document and is not adopted and overwritten later.
    const keptTracked = new Set<string>();
    const keepTracked = (paths: readonly string[], rule: string) => {
      const kept = new Set(paths.filter((path) => !created.has(path)));
      for (const path of kept) {
        result.leftOutAtRecord.push({ path, rule });
        keptTracked.add(path);
      }
      entries = entries.filter((entry) => !kept.has(entry.path));
      result.overwritten = result.overwritten.filter((path) => !kept.has(path));
      leaveOut(paths.filter((path) => created.has(path)), rule);
    };
    keepTracked(failed, 'download-failed');
    // The document's text must stay the file's body: text that reads as front
    // matter would become the file's metadata (or a folder's annotation).
    keepTracked(entries.filter((entry) => splitFile(textOf(entry)).body !== restored(entry)).map((entry) => entry.path), 'front-matter-boundary');
    // The repository's security hooks see Linear's text and every downloaded file before any byte is pushed, as in the capture.
    const gate = options.security ?? (await securityGate(git, fetched.tracked));
    try {
      if (gate.configured) {
        const blocked: string[] = [];
        for (const entry of entries) {
          const { files } = bodies.get(entry.path) as { files: Map<string, Buffer> };
          const text = textOf(entry);
          if (files.size === 0 && text === input.texts.get(entry.path)) continue;
          if ((await gate.check(new Map<string, Buffer | string>([[entry.path, text], ...files]))).length > 0) blocked.push(entry.path);
        }
        keepTracked(blocked, 'security-hook');
      }
    } finally {
      await gate.close?.();
    }
    let lfsObjects: string[] = [];
    // What `.gitattributes` makes of each changed path, cleaned once across the builds.
    const stored = new Map<string, Buffer | string | null>();
    let commit = await build(entries);
    // The new tree must map every file back to its document's title and place.
    // Each pass leaves out more: the misplaced new files (and new README files,
    // which can name a folder's team or project), then every new file. Without
    // new files the tree maps as the tracked one does, since text that reads as
    // front matter is already out; a mismatch then is a defect, not data.
    for (let attempt = 0; ; attempt += 1) {
      const misplaced = mismatches(await loadMapping(git, commit), entries);
      if (misplaced.length === 0) break;
      const newPaths = entries.filter((entry) => created.has(entry.path)).map((entry) => entry.path);
      if (attempt === 0) {
        const moved = misplaced.some((path) => !created.has(path));
        const newReadmes = moved ? newPaths.filter((path) => /(^|\/)README\.md$/.test(path)) : [];
        leaveOut([...misplaced.filter((path) => created.has(path)), ...newReadmes], 'title-not-a-path');
      } else if (attempt === 1 && newPaths.length > 0) {
        leaveOut(newPaths, 'title-not-a-path');
      } else {
        throw new Error(`the recorded tree maps ${misplaced.length} files to other documents`);
      }
      commit = await build(entries);
    }

    async function build(list: readonly ReverseEntry[]): Promise<Oid> {
      const changes = new Map<string, Buffer | string | null>();
      for (const entry of list) {
        for (const [path, bytes] of (bodies.get(entry.path) as { files: Map<string, Buffer> }).files) changes.set(path, bytes);
        changes.set(entry.path, textOf(entry));
      }
      for (const path of plan.remove) changes.set(path, null);
      // `.gitattributes` decides what is stored in LFS, as for a person's commit.
      const fresh = new Map([...changes].filter(([path]) => !stored.has(path)));
      if (fresh.size > 0) for (const [path, content] of (await prepareLfs(git, fetched.tracked, fresh)).changes) stored.set(path, content);
      const prepared = new Map([...changes.keys()].map((path) => [path, stored.get(path) as Buffer | string | null]));
      lfsObjects = [
        ...new Set(
          [...prepared]
            .filter(([path, content]) => content !== null && content !== changes.get(path))
            .map(([, content]) => parseLfsPointer(Buffer.from(content as Buffer | string))?.oid)
            .filter((oid): oid is string => oid !== undefined),
        ),
      ];
      return commitTree(git, { parents: [fetched.tracked], base: fetched.tracked, changes: prepared, message: REVERSE_RECORD_MESSAGE, identity, skipIfUnchanged: false });
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
    // The sync branch moves to a record that changes the tracked branch; its open pull
    // request then shows the new record. A record that changes nothing leaves the branch,
    // and an earlier record's pull request still open is closed (it has nothing to carry).
    const syncOpen = fetched.sync !== null && fetched.sync !== commit && !(await isAncestor(git, fetched.sync, fetched.tracked));
    if (syncOpen && !(await isOwnRecord(fetched.sync as Oid))) return 'sync-branch-changed';
    const moveSync = fetched.sync !== commit && changesTracked;

    const synced = new Set([...entries.map((entry) => entry.path), ...keptTracked]);
    const finalIds: IdMap = new Map([...ids].filter(([path]) => synced.has(path)));
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      message: FINAL_IDS_MESSAGE,
      always: (await readInitialSyncProgress(git, expected.ids)) !== null,
    });
    // The cache records each downloaded file, so the sync never uploads it again.
    const finalUploads: UploadMap = new Map(uploads);
    for (const entry of entries) for (const [hash, url] of (bodies.get(entry.path) as { uploads: UploadMap }).uploads) finalUploads.set(hash, url);
    const uploadsCommit = await commitUploads(git, expected.uploads, finalUploads, identity);
    // The objects reach the remote's LFS store before any ref points at their pointers.
    if (lfsObjects.length > 0) await git.run(['lfs', 'push', '--object-id', options.config.remote, ...lfsObjects]);
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
      needsPullRequest: changesTracked,
      closesPullRequest: !changesTracked && syncOpen,
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
      return file === undefined || placeKey(file.place) !== placeKey(entry.place) || file.title.normalize('NFC') !== entry.fileTitle.normalize('NFC');
    })
    .map((entry) => entry.path)
    .sort(compare);
}

/** The pull request's text: counts and paths, never content. */
export function pullRequestBody(plan: ReversePlan, result: ReverseResult): string {
  const out = new Set(result.leftOutAtRecord.map((entry) => entry.path));
  const overwritten = plan.overwrite.filter((entry) => !out.has(entry.path)).length;
  const created = plan.create.filter((entry) => !out.has(entry.path)).length;
  const lines = [
    'This pull request makes the synchronized folders equal to Linear, as an initial sync from Linear asked.',
    '',
    `- ${count(overwritten, 'file')} take Linear's text (front matter kept);`,
    `- ${count(created, 'file')} are new, one per document only in Linear;`,
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
  return { path: entry.path, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: entry.title };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
