// Assertion subjects: where each value a scenario asserts on comes from.
//
// - Observed: a step recorded it while the scenario ran (`ctx.observations`).
// - Engine report: `runs.<n|last>.<path>`, `summary.<path>` and `paths.rule`
//   are read by path from the engine's run report (the JSON its report
//   file holds; in actions mode the run's report artifact). These are facts
//   only the engine knows: its decisions, plans and summary codes. A value
//   the report lacks fails the scenario as a product error. One run's
//   writes, `runs.<n|last>.writes.<kind>`, are the sums of the report's
//   `writes` by kind (`runWrites`).
// - Harness: everything the two sides show (Linear documents, the tracked
//   branch, state refs, pull requests, uploads, workflow runs) is computed
//   by the harness from the world itself, never taken from the engine.
// - `before.<subject>`: the same subject, computed on the snapshot the
//   runner took when setup ended.
// - `runs.<n|last>.<subject>` for the document text subjects
//   and their golden form (`RUN_VIEW_SUBJECT`): the same subject, computed
//   on the snapshot the harness took of the world right after that run
//   ended, before the next step. A report holds no document bodies, so the
//   engine cannot answer these, and the world at the end could hide a later
//   rewrite.
// - UI: `ui.*` values come from the UI session's checklist results.
//
// A subject that none of these knows is a harness gap; the scenario-set
// test keeps that list empty.

import { collectCanaryEvidence } from './checks.ts';
import { scanNight } from './night-scan.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { HOLD_FAILED, HOLD_TIMED_OUT } from '../../../src/sync/hold.ts';
import { MARKS } from '../../../src/sync/marks.ts';
import { detectConflicts } from '../../../src/merge/index.ts';
import type { PullRequest } from './github.ts';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { relativeLinkUrls } from '../../../src/format/index.ts';
import { resolveTarget } from '../../../src/format/markdown.ts';
import { listTree, readBlobs, readIds, readUploads, lfsReader, parseLfsPointer, type Git, resolveStateConfig, suspendedBranch } from '../../../src/state/index.ts';
import { findFrontMatter } from '../../../src/mapping/front-matter.ts';
import { INVALID_DIAGRAM_NOTE } from '../../corpus/documents.ts';
import { BANK_HOME } from '../../corpus/tree.ts';
import { BANK_DIR, engineForm, loadBank, readFixture } from '../../probe/bank.ts';
import { canaryScan, fetchRef, fileHash, runScopeGuard, gitLinks, linearLinks, linkDestinations, linkedFile, lfsSize, lostEdits, editsFound, readSides, sameAsFile, expectsDocument, duplicateKey, isLive, snapshotRefs, bodyOf, titleOf, type Sides } from './checks.ts';
import { bothVersionsComplete, colorLabel, conflictScope, CONFLICT_MARK, scanMarkers } from './conflicts.ts';
import type { RunContext } from './context.ts';
import { annotationPath, owningFolder, type Folder } from './corpus.ts';
import { REPO_ROOT, engineEntry } from './engine.ts';
import { canaryIsolated, type CanaryFacts } from './security-canary.ts';
import { isAppBot } from './workflows.ts';
import type { PushActivity } from './github.ts';
import { isDocumentWrite, QUIET_SUBJECT } from './quiet.ts';
import { EnvBlockedError, NotImplementedError, ProductError } from './results.ts';
import { zoneConcurrent } from './concurrency.ts';
import { documentPaths, MOVE_SOURCE_FOLDER, projectFolderOf, projectFolders } from './step-helpers.ts';
import { UNSAFE_TITLES } from './fixtures.ts';

// --- views of the world ---------------------------------------------------------------

/** The world at one moment: the two sides, plus comments read for it. */
export interface View extends Sides {
  /** Comment bodies by document id, for the documents read so far. */
  comments: Map<string, string[]>;
  suspendedFiles?: Map<string, string>;
  holdComments?: Map<string, Array<{ id: string; body: string; resolvedAt: string | null }>>;
  pullRequests?: Array<PullRequest & { empty: boolean }>;
}

export const BEFORE_VIEW = 'view.before';

export async function takeView(ctx: RunContext, withComments: boolean, options: { allowNoIds?: boolean } = {}): Promise<View> {
  const sides = await readSides(ctx, options);
  const view: View = { ...sides, comments: new Map() };
  if (withComments && ctx.live !== null) {
    const ids = new Set([...sides.ids.values()].map((entry) => entry.id));
    for (const id of (ctx.observations.get('setup.seeded') as string[] | undefined) ?? []) ids.add(id);
    for (const id of ids) view.comments.set(id, await documentComments(ctx, id));
  }
  if (ctx.scenario.checks.assertions.some((a) => /suspended\.|normal\./.test(a.subject))) {
    view.holdComments = new Map();
    const held = (ctx.observations.get('suspended.documents') as Set<string> | undefined) ?? new Set<string>();
    for (const entry of view.ids.values()) if (entry.suspended !== undefined) held.add(entry.id);
    ctx.observations.set('suspended.documents', held);
    const commentIds = new Set([...held, ...ctx.edits.flatMap((edit) => {
      const id = view.ids.get(edit.path)?.id;
      return id === undefined ? [] : [id];
    })]);
    // Keep each query comfortably below Linear's complexity limit.
    const commentList = [...commentIds];
    if (ctx.live !== null) for (let start = 0; start < commentList.length; start += 10) {
      const page = commentList.slice(start, start + 10);
      const variables = Object.fromEntries(page.map((id, i) => [`id${i}`, id]));
      const declarations = page.map((_, i) => `$id${i}: String!`).join(', ');
      const fields = page.map((_, i) => `d${i}: document(id: $id${i}) { comments(first: 100) { nodes { id body resolvedAt } } }`).join(' ');
      const data = await ctx.live.app.request<Record<string, { comments: { nodes: Array<{ id: string; body: string; resolvedAt: string | null }> } } | null>>(
        'SuspendedComments', 'query', `query SuspendedComments(${declarations}) { ${fields} }`, variables,
      );
      for (const [i, id] of page.entries()) view.holdComments.set(id, data[`d${i}`]?.comments.nodes ?? []);
    }
    const git = await person(ctx);
    const branch = suspendedBranch(resolveStateConfig(ctx.names));
    const tip = await fetchRef(git, `refs/heads/${branch}`);
    view.suspendedFiles = tip === null ? new Map() : new Map([...await treeFiles(git, tip, (p) => p.endsWith('.md'))].map(([p, bytes]) => [p, bytes.toString('utf8')]));
    view.pullRequests = [];
    for (const pr of await pullRequestsSinceStart(ctx)) view.pullRequests.push({ ...pr, empty: pr.head.ref === ctx.names.syncBranch && pr.state === 'closed' && pr.merged_at === null && (await pullRequestFiles(ctx, pr.number)).length === 0 });
  }
  return view;
}

/**
 * The snapshot of the start, which every scenario takes: many subjects
 * compare with it. Comments are read only when an assertion speaks of them
 * (one request per document). A run that starts from Linear has no ids ref
 * yet, and its snapshot has an empty ids map.
 */
export async function takeStartView(ctx: RunContext): Promise<View> {
  const names = ctx.scenario.checks.assertions.flatMap((assertion) => [assertion.subject, String(assertion.expected)]);
  return takeView(ctx, names.some((name) => /omment/i.test(name)), { allowNoIds: true });
}

interface Env {
  ctx: RunContext;
  /** The world now, at the start (`before.`), or right after one run (`runs.<n|last>.`). */
  which: 'now' | 'before' | 'run';
  view(): Promise<View>;
}

async function documentComments(ctx: RunContext, id: string): Promise<string[]> {
  const world = ctx.live;
  if (world === null) return [];
  const data = await world.app.request<{ document: { comments: { nodes: Array<{ body: string; createdAt: string }> } } | null }>(
    'DocumentComments',
    'query',
    'query DocumentComments($id: String!) { document(id: $id) { comments(first: 100) { nodes { body createdAt } } } }',
    { id },
  );
  return (data.document?.comments.nodes ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((comment) => comment.body);
}

async function commentsOf(env: Env, id: string | undefined): Promise<string[]> {
  if (id === undefined) return [];
  const view = await env.view();
  if (!view.comments.has(id)) {
    // Only the world now may be read again; a snapshot answers from what it holds.
    if (env.which !== 'now') return [];
    // A concurrent run reads comments only of a document in its scope: one its view holds, or one a guarded by-id read returns.
    if (zoneConcurrent(env.ctx.scenario) && !view.documents.has(id) && await documentById(env.ctx, id) === undefined) {
      throw new ProductError('a commented document is not in the run scope');
    }
    view.comments.set(id, await documentComments(env.ctx, id));
  }
  return view.comments.get(id) as string[];
}

/** Comments added to a document since the scenario's start. */
async function newComments(env: Env, id: string | undefined): Promise<string[]> {
  if (id === undefined) return [];
  const before = (env.ctx.observations.get(BEFORE_VIEW) as View | undefined)?.comments.get(id) ?? [];
  const now = await commentsOf({ ...env, which: 'now' }, id);
  return now.slice(before.length);
}

// --- small helpers ---------------------------------------------------------------------

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sorted = <T>(items: Iterable<T>) => [...items].sort();

function observed(ctx: RunContext, name: string): unknown {
  if (!ctx.observations.has(name)) throw new Error(`the scenario recorded no ${name}: the step that records it did not run`);
  return ctx.observations.get(name);
}

function hasTarget(ctx: RunContext): boolean {
  return ctx.observations.has('target.path');
}

function firstDocument(ctx: RunContext): string {
  const fixture = ctx.observations.get('fixture.document');
  if (typeof fixture === 'string') return fixture;
  const [path] = documentPaths(ctx);
  if (path === undefined) throw new Error('the slice has no document');
  return path;
}

/** The document the scenario acted on: its path and id in this view. */
async function target(env: Env): Promise<{ path: string; id: string | undefined; document: LinearDocument | undefined }> {
  const { ctx } = env;
  const view = await env.view();
  const origin = (ctx.observations.get('target.path') as string | undefined) ?? firstDocument(ctx);
  const moved = ctx.observations.get('git.moved') as { from: string; to: string } | undefined;
  if (env.which === 'before') {
    const path = moved?.from ?? origin;
    const id = view.ids.get(path)?.id;
    return { path, id, document: id === undefined ? undefined : view.documents.get(id) };
  }
  const before = ctx.observations.get(BEFORE_VIEW) as View | undefined;
  const knownId = (ctx.observations.get('target.id') as string | undefined) ?? before?.ids.get(moved?.from ?? origin)?.id;
  const byId = knownId === undefined ? undefined : [...view.ids].find(([, entry]) => entry.id === knownId)?.[0];
  const path = byId ?? moved?.to ?? origin;
  const id = view.ids.get(path)?.id ?? knownId;
  let document = id === undefined ? undefined : view.documents.get(id);
  // Only the world now may be read again; a snapshot answers from what it holds.
  if (document === undefined && id !== undefined && env.which === 'now' && ctx.live !== null) {
    [document] = await ctx.live.app.getDocuments([id], { withContent: true });
    if (document !== undefined) runScopeGuard(ctx)(document);
  }
  return { path, id, document };
}

/**
 * A document's text in git's terms, to compare with a file body: when the
 * document holds exactly the file's text (links mapped link by link, as I1
 * compares), the file's body; otherwise its content with upload URLs mapped
 * back to file paths.
 */
function documentBody(view: View, path: string, document: LinearDocument | undefined): string | null {
  if (document === undefined) return null;
  const file = view.files.get(path);
  if (file !== undefined && sameAsFile(file, document.content ?? '', path, view)) return bodyOf(file);
  return gitLinks(document.content ?? '', path, view);
}

function fileBody(view: View, path: string): string | null {
  const text = view.files.get(path);
  return text === undefined ? null : bodyOf(text);
}

/** The YAML of a file's front matter, found by the engine's own rule. */
function frontMatter(text: string | undefined | null): string | null {
  return text === undefined || text === null ? null : (findFrontMatter(text)?.yaml ?? null);
}

/** Each synchronized file's value, or the target's when the scenario acted on one document. */
async function perTarget(env: Env, one: (path: string, document: LinearDocument | undefined, view: View) => unknown): Promise<unknown> {
  const view = await env.view();
  if (hasTarget(env.ctx)) {
    const { path, document } = await target(env);
    return one(path, document, view);
  }
  const result = new Map<string, unknown>();
  for (const path of view.files.keys()) {
    const id = view.ids.get(path)?.id;
    result.set(path, one(path, id === undefined ? undefined : view.documents.get(id), view));
  }
  return result;
}

export type DocumentState = 'active' | 'trash' | 'archived' | 'gone';

function stateOf(document: LinearDocument | undefined): DocumentState {
  if (document === undefined) return 'gone';
  if (document.trashed) return 'trash';
  if (document.archivedAt !== null) return 'archived';
  return 'active';
}

async function documentById(ctx: RunContext, id: string | undefined): Promise<LinearDocument | undefined> {
  if (id === undefined || ctx.live === null) return undefined;
  let document: LinearDocument | undefined;
  try {
    [document] = await ctx.live.app.getDocuments([id], { withContent: true });
  } catch {
    return undefined;
  }
  // Outside the try: a foreign document fails the subject instead of reading as gone.
  return document === undefined ? undefined : runScopeGuard(ctx)(document);
}

/** Restores a trashed document and trashes it again: whether Linear could restore it. */
async function restorable(ctx: RunContext, id: string | undefined): Promise<boolean> {
  const world = ctx.live;
  if (world === null || id === undefined) return false;
  if (stateOf(await documentById(ctx, id)) !== 'trash') return false;
  try {
    await world.editors['editor-a'].restoreDocument(id);
  } catch {
    return false;
  }
  await world.editors['editor-a'].trashDocument(id);
  return true;
}

/** Where a document lives: `project:<name>` or `team:<key>`. */
export function placeOf(ctx: RunContext, document: LinearDocument | undefined): string | null {
  const world = ctx.live;
  if (world === null || document === undefined) return null;
  if (document.projectId !== null) {
    const project = [...world.projects.values()].find((candidate) => candidate.id === document.projectId);
    return `project:${project?.name ?? document.projectId}`;
  }
  const team = [...world.teams.values()].find((candidate) => candidate.id === document.teamId);
  return `team:${team?.key ?? document.teamId}`;
}

/** Where a path's annotation says its document lives, and its title. */
export function expectedPlace(folders: readonly Folder[], path: string): { place: string; title: string } | null {
  const folder = owningFolder(path, folders);
  if (folder === null) return null;
  const place = folder.project !== null ? `project:${folder.project}` : `team:${folder.team}`;
  return { place, title: titleOf(path, folder.folder) };
}

async function person(ctx: RunContext): Promise<Git> {
  return ctx.person();
}

async function stateTip(ctx: RunContext, store: 'linear' | 'ids' | 'uploads'): Promise<string | null> {
  return fetchRef(await person(ctx), `${ctx.names.refPrefix}/${store}`);
}

async function syncTip(ctx: RunContext): Promise<string | null> {
  return fetchRef(await person(ctx), `refs/heads/${ctx.names.syncBranch}`);
}

/** Files of a commit: path → bytes. */
async function treeFiles(git: Git, commit: string, filter: (path: string) => boolean = () => true): Promise<Map<string, Buffer>> {
  const entries = (await listTree(git, commit)).filter((entry) => entry.type === 'blob' && filter(entry.path));
  const blobs = await readBlobs(git, entries.map((entry) => entry.oid));
  return new Map(entries.map((entry) => [entry.path, blobs.get(entry.oid) as Buffer]));
}

async function parents(git: Git, commit: string): Promise<string[]> {
  return (await git.text(['rev-list', '--parents', '-n', '1', commit])).trim().split(' ').slice(1);
}

/**
 * A path as specs write it: a run's project folder becomes `project/`
 * (specs name destinations by role, since each run has its own folders).
 */
export function symbolicPath(ctx: RunContext, path: string): string {
  const folder = projectFolders(ctx).find((candidate) => path.startsWith(`${candidate.folder}/`));
  return folder === undefined ? path : `project/${path.slice(folder.folder.length + 1)}`;
}

/**
 * Where a moved document is, as specs write it: only the project folder the
 * document started in reads as `project/` (for a cross-project move, the
 * project it left, which its recorded destination shares). A path in any
 * other project, or at team level, keeps its real folder, so a document that
 * went to the wrong project, or started outside a project, never reads as
 * `project/…`.
 */
export function movedPath(ctx: RunContext, path: string): string {
  const origin = (ctx.observations.get('target.path') as string | undefined) ?? firstDocument(ctx);
  const source = (ctx.observations.get(MOVE_SOURCE_FOLDER) as string | undefined) ?? projectFolderOf(ctx, origin);
  return source !== undefined && projectFolderOf(ctx, path) === source ? symbolicPath(ctx, path) : path;
}

/** Brings commits into the person's clone; returns the ones it has afterwards. */
async function present(git: Git, commits: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const commit of new Set(commits)) {
    if ((await git.run(['cat-file', '-e', `${commit}^{commit}`], { okCodes: [0, 1, 128] })).code !== 0) {
      await git.run(['fetch', '--quiet', 'origin', commit], { okCodes: [0, 1, 128] });
    }
    if ((await git.run(['cat-file', '-e', `${commit}^{commit}`], { okCodes: [0, 1, 128] })).code === 0) result.push(commit);
  }
  return result;
}

/** Whether `ancestor` is an ancestor of `descendant`; a commit the server no longer has cannot be shown to be. */
async function isAncestor(git: Git, ancestor: string, descendant: string | null): Promise<boolean> {
  if (descendant === null) return false;
  if (ancestor === descendant) return (await present(git, [ancestor])).length === 1;
  if ((await present(git, [ancestor, descendant])).length < 2) return false;
  return (await git.run(['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [0, 1] })).code === 0;
}

/** Commits on `tip` that the scenario's start did not have. */
async function newCommits(git: Git, tip: string | null, startTips: readonly string[]): Promise<string[]> {
  if (tip === null) return [];
  const not = (await present(git, startTips)).map((oid) => `^${oid}`);
  return (await git.text(['rev-list', tip, ...not])).split('\n').filter(Boolean);
}

function startTips(ctx: RunContext): string[] {
  const refs = (ctx.observations.get('start.refs') as Record<string, string> | undefined) ?? {};
  const tracked = ctx.observations.get('start.trackedTip') as string | undefined;
  return [...Object.values(refs), ...(tracked === undefined ? [] : [tracked])];
}

/** The run refs the sync writes, each with the commits on it that neither the start nor the scenario's own steps made. */
async function syncCommits(ctx: RunContext): Promise<Map<string, string[]>> {
  const git = await person(ctx);
  const own = new Set(ctx.ownCommits);
  const refs = [...(['linear', 'ids', 'uploads'] as const).map((store) => `${ctx.names.refPrefix}/${store}`), `refs/heads/${ctx.names.syncBranch}`, `refs/heads/${suspendedBranch(resolveStateConfig({trackedBranch:ctx.names.trackedBranch,syncBranch:ctx.names.syncBranch,refPrefix:ctx.names.refPrefix}))}`];
  const result = new Map<string, string[]>();
  for (const ref of refs) {
    const commits = (await newCommits(git, await fetchRef(git, ref), startTips(ctx))).filter((commit) => !own.has(commit));
    if (commits.length > 0) result.set(ref, commits);
  }
  return result;
}

/** The identity the repository's CI commits its fixes under (the pre-commit example): GitHub Actions' bot account. */
export const CI_IDENTITY = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';

/** Who a push record names, for a failure: a bot by its login, a person only as a user account. */
function actorKind(actor: PushActivity['actor']): string {
  if (actor === null) return 'no recorded actor';
  return actor.type === 'Bot' ? actor.login : 'a user account';
}

/**
 * The scenario's own engine runs: after setup, before the deployment's
 * follow-up runs (steps.ts, settleFollowUpRuns) and the checks' own run (I6).
 */
function ownResults(ctx: RunContext) {
  const end = (ctx.observations.get('scenario.stepRunsEnd') ?? ctx.observations.get('scenario.runsEnd')) as number | undefined;
  return ctx.engine.results.slice(ctx.engine.setupRuns, end);
}

/** Relative link and image destinations of a Markdown body (as the parser reads them; nothing in code). */
export function relativeLinks(text: string): string[] {
  // Relative by form: no scheme, not protocol-relative, not an anchor in the same document. Whether it stays
  // inside the repository depends on the linking document, which `resolveLink` checks with that path.
  return linkDestinations(text).map((destination) => destination.url).filter((url) => url !== '' && !url.startsWith('#') && !url.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(url));
}

function imageLinks(text: string): string[] {
  return linkDestinations(text).filter((destination) => destination.image).map((destination) => destination.url);
}

/** The repository file a link points to, by the same rule as the convergence check (empty when none). */
function resolveLink(fromPath: string, link: string): string {
  return linkedFile(fromPath, link)?.path ?? '';
}

/** Links (not images) to documents of the workspace in a body, as `<id>` or `<id>#<fragment>`, in text order. */
export function documentLinks(text: string, base: string): string[] {
  const prefix = `${base}/`;
  return linkDestinations(text).filter((destination) => !destination.image && destination.url.startsWith(prefix)).map((destination) => destination.url.slice(prefix.length));
}

function manifestOf(ctx: RunContext) {
  const world = ctx.live;
  if (world === null) throw new Error('offline scenarios have no manifest');
  const byTarget = new Map<string, (typeof world.manifest.files)[number]>();
  const bySource = new Map(world.manifest.files.map((file) => [file.path, file]));
  for (const [target, source] of world.tree.paths) {
    const entry = bySource.get(source);
    if (entry !== undefined) byTarget.set(target, entry);
  }
  return byTarget;
}

/**
 * Repository paths of the run's tree as the roles the corpus manifest gives
 * their files (`role`). A path whose file has no role stays a path, so an
 * unexpected file still shows up in the comparison.
 */
export function rolesOf(ctx: RunContext, paths: readonly string[]): string[] {
  const manifest = manifestOf(ctx);
  return sorted(paths.map((path) => manifest.get(path)?.role ?? path));
}

/** The slice's documents of a corpus group; an empty group would make its subject vacuous, so it is an error. */
function groupPaths(ctx: RunContext, group: string): string[] {
  const paths = sorted([...manifestOf(ctx)].filter(([, entry]) => entry.group === group && entry.kind === 'markdown').map(([path]) => path));
  if (paths.length === 0) throw new Error(`the slice has no document of the corpus group ${group}`);
  return paths;
}

/** The slice's Mermaid documents the corpus manifest notes as holding an invalid diagram. */
function invalidMermaidPaths(ctx: RunContext): string[] {
  const paths = sorted([...manifestOf(ctx)].filter(([, entry]) => entry.group === 'mermaid' && entry.kind === 'markdown' && entry.note?.includes(INVALID_DIAGRAM_NOTE) === true).map(([path]) => path));
  if (paths.length === 0) throw new Error('the slice has no Mermaid document with an invalid diagram');
  return paths;
}

/** Runs `fix` on texts with the snapshot's file existence context: path → fixed text. */
export function linearForms(texts: ReadonlyMap<string, string>, existingPaths: Iterable<string>): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'linear-form-'));
  try {
    // `fix` only needs existence for linked files, including LFS assets; their bytes are irrelevant.
    const existing = new Set(existingPaths);
    const linked = new Set<string>();
    for (const [path, text] of texts) {
      for (const url of relativeLinkUrls(text)) {
        const target = resolveTarget(path, url);
        if (target !== null && existing.has(target) && !texts.has(target)) linked.add(target);
      }
    }
    for (const path of linked) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), '');
    }
    for (const [path, text] of texts) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const result = spawnSync(process.execPath, [engineEntry(), 'fix', ...texts.keys()], { cwd: dir, encoding: 'utf8' });
    if (result.stderr.includes('not implemented')) throw new NotImplementedError('fix', 'the Linear form of the expected text');
    return new Map([...texts.keys()].map((path) => [path, readFileSync(join(dir, path), 'utf8')]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A path segment of more than 180 bytes: its first 40 characters, `~` and 16 hex digits of SHA-256 of `source`. */
export function shortSegment(segment: string, source: string): string {
  return Buffer.byteLength(segment) > 180 ? `${[...segment].slice(0, 40).join('')}~${createHash('sha256').update(source).digest('hex').slice(0, 16)}` : segment;
}

const hex = (char: string) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The expected file path of a title, written from the documented path rule and
 * kept independent of the engine's own implementation. Per slash-separated
 * segment, after Unicode NFC: percent-encode `%`, `\`, control characters and
 * `:*?"<>|`; encode the leading character of `.`, `..`, `.git` (any case) and
 * Windows device names; write an empty segment as `%00`; encode trailing
 * periods and spaces. Leading spaces stay as they are. A segment whose
 * encoded form is longer than 180 bytes is cut to its first 40 characters,
 * `~` and the first 16 hex digits of SHA-256 of the segment as titled.
 * Collision names are `pathFitsTitle`'s, in `checks.ts`.
 */
export function encodeTitlePath(title: string): string {
  return title
    .normalize('NFC')
    .split('/')
    .map((segment) => {
      if (segment === '') return '%00';
      let encoded = segment.replace(/[%\\\u0000-\u001f\u007f:*?"<>|]/g, hex);
      if (/^(\.|\.\.|\.git)$/i.test(encoded) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(encoded)) encoded = `${hex(encoded)}${encoded.slice(1)}`;
      encoded = encoded.replace(/[. ]+$/, (tail) => [...tail].map(hex).join(''));
      return shortSegment(encoded, segment);
    })
    .join('/');
}

function proxyRecordsSinceStart(ctx: RunContext) {
  const from = Number(ctx.observations.get('start.proxyIndex') ?? 0);
  const end = ctx.observations.get('scenario.proxyEnd') as number | undefined;
  return (ctx.proxy?.requests ?? []).slice(from, end);
}

function documentWrites(ctx: RunContext): number {
  return proxyRecordsSinceStart(ctx).filter(isDocumentWrite).length;
}

async function gitWrites(ctx: RunContext): Promise<number> {
  const git = await person(ctx);
  // The person's clone has the tracked branch checked out, so read its tip through FETCH_HEAD.
  await git.run(['fetch', '--quiet', 'origin', ctx.names.trackedBranch]);
  const tracked = (await git.text(['rev-parse', 'FETCH_HEAD'])).trim();
  const tips = [tracked, await syncTip(ctx), await stateTip(ctx, 'linear'), await stateTip(ctx, 'ids'), await stateTip(ctx, 'uploads')];
  const own = new Set(ctx.ownCommits);
  const commits = new Set<string>();
  for (const tip of tips) for (const commit of await newCommits(git, tip, startTips(ctx))) if (!own.has(commit)) commits.add(commit);
  return commits.size;
}

async function pullRequestsSinceStart(ctx: RunContext) {
  if (ctx.live === null) return [];
  const branch = suspendedBranch(resolveStateConfig({trackedBranch:ctx.names.trackedBranch,syncBranch:ctx.names.syncBranch,refPrefix:ctx.names.refPrefix}));
  const all = [...await ctx.live.rest.pullRequests(ctx.names.syncBranch), ...await ctx.live.rest.pullRequests(branch)];
  const before = new Set((ctx.observations.get('start.pullRequests') as number[] | undefined) ?? []);
  return [...new Map(all.map((pr) => [pr.number, pr])).values()].filter((pr) => !before.has(pr.number));
}

async function pullRequestFiles(ctx: RunContext, number: number): Promise<Array<{ filename: string; status: string }>> {
  if (ctx.live === null) return [];
  return ctx.live.rest.request('GET', `/pulls/${number}/files?per_page=100`);
}

/** Every tracked file with the given extensions, from the tracked tip. */
async function trackedBytes(ctx: RunContext, filter: (path: string) => boolean): Promise<Map<string, Buffer>> {
  const git = await person(ctx);
  const view = await currentView(ctx);
  return treeFiles(git, view.tip, filter);
}

const viewCache: WeakMap<RunContext, Promise<View>> = new WeakMap();
async function currentView(ctx: RunContext): Promise<View> {
  let view = viewCache.get(ctx);
  if (view === undefined) {
    // Previews (L1-03, L1R-01) leave no ids ref: the view then has an empty ids map, and subjects that need ids fail on their own values.
    view = takeView(ctx, false, { allowNoIds: true });
    viewCache.set(ctx, view);
  }
  return view;
}

/** Forgets the cached view, after something changed the world. */
export function refreshView(ctx: RunContext): void {
  viewCache.delete(ctx);
}

async function storageOf(git: Git, paths: readonly string[], bytes: ReadonlyMap<string, Buffer>): Promise<{ actual: Map<string, string>; expected: Map<string, string> }> {
  const actual = new Map<string, string>();
  const expected = new Map<string, string>();
  for (const path of paths) {
    actual.set(path, lfsSize(bytes.get(path) ?? Buffer.alloc(0)) === null ? 'regular' : 'lfs');
    const attr = await git.text(['check-attr', 'filter', '--', path]);
    expected.set(path, /: filter: lfs$/m.test(attr) ? 'lfs' : 'regular');
  }
  return { actual, expected };
}

/** The image files a Markdown file embeds by relative link, as repository paths. */
function embeddedImages(path: string, text: string): string[] {
  return imageLinks(text).filter((link) => !/^[a-z]+:/i.test(link)).map((link) => resolveLink(path, link));
}

/** The pull request head the reverse initial sync opened (newest sync pull request). */
async function syncPullRequestHead(ctx: RunContext): Promise<{ git: Git; commit: string } | null> {
  const [pr] = await pullRequestsSinceStart(ctx);
  const git = await person(ctx);
  const commit = pr === undefined ? await syncTip(ctx) : (await fetchRef(git, `refs/pull/${pr.number}/head`)) ?? pr.head.sha;
  return commit === null ? null : { git, commit };
}

/** Linear's documents as files: the path each document maps to → its content. */
function linearTree(ctx: RunContext, view: View): Map<string, string> {
  const world = ctx.live;
  const result = new Map<string, string>();
  if (world === null) return result;
  for (const document of view.allDocuments) {
    if (document.trashed || document.archivedAt !== null) continue;
    const place = placeOf(ctx, document);
    const folder = view.folders.find((candidate) => (candidate.project !== null ? `project:${candidate.project}` : `team:${candidate.team}`) === place && (candidate.project !== null || place?.startsWith('team:')));
    if (folder === undefined) continue;
    const prefix = folder.folder === '' ? '' : `${folder.folder}/`;
    result.set(`${prefix}${encodeTitlePath(document.title)}.md`, document.content ?? '');
  }
  return result;
}

/**
 * The annotation READMEs of the tracked tree that no Linear document maps
 * to (`documents`: `linearTree`'s paths), with their whole text, body or
 * none. The initial sync from Linear keeps them as they are: a folder's
 * mapping depends on its annotation. They are not actions of its plan, and
 * its pull request still holds them.
 */
function keptAnnotationReadmes(view: View, documents: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const result = new Map<string, string>();
  for (const folder of view.folders) {
    const path = annotationPath(folder);
    const text = view.files.get(path);
    if (text !== undefined && !documents.has(path)) result.set(path, text);
  }
  return result;
}

/** Linear's documents as files and the annotation READMEs the initial sync from Linear keeps beside them. */
function reverseSides(ctx: RunContext, view: View): { documents: Map<string, string>; kept: Map<string, string> } {
  const documents = linearTree(ctx, view);
  return { documents, kept: keptAnnotationReadmes(view, documents) };
}

/**
 * What the initial sync from Linear makes of the synchronized folders, by
 * body: Linear's documents as files, and the annotation READMEs it keeps
 * (the subject `expected.linearTree`).
 */
function reverseTree(ctx: RunContext, view: View): Map<string, string> {
  const { documents, kept } = reverseSides(ctx, view);
  for (const [path, text] of kept) documents.set(path, bodyOf(text));
  return documents;
}

// --- the registry ----------------------------------------------------------------------------

type Compute = (env: Env) => Promise<unknown>;

async function conflictTexts(env: Env): Promise<Array<{ git: string | null; linear: string | null }>> {
  const view = await env.view();
  const paths = (env.ctx.observations.get('conflict.paths') as string[] | undefined) ?? [(await target(env)).path];
  return paths.map((path) => {
    const id = view.ids.get(path)?.id;
    const document = id === undefined ? undefined : view.documents.get(id);
    return { git: fileBody(view, path), linear: document?.content ?? null };
  });
}

/** One value when both sides agree, else both. */
function agreed<T>(git: T, linear: T): T | { git: T; linear: T } {
  return JSON.stringify(git) === JSON.stringify(linear) ? git : { git, linear };
}

function markRetained(document: LinearDocument | undefined): boolean {
  return document?.icon === CONFLICT_MARK.icon && colorLabel(document.color) === CONFLICT_MARK.color;
}

/** A synchronized document the run's final view shows with the conflict mark. */
export interface ConflictMarkRecord {
  path: string;
  icon: string;
  color: string;
  /** The own icon and color the ids ref saved before the mark replaced them; null when it saved none. */
  saved: { icon: string | null; color: string | null } | null;
  comments: number;
}

/**
 * The documents of the run's ids ref that carry the conflict mark, with
 * their saved own decoration and comment count: what a report shows of the
 * marks without their content. A document not listed has no mark. One
 * comment read per marked document.
 */
export async function conflictMarks(ctx: RunContext, sides: Sides): Promise<{ mapped: number; marked: ConflictMarkRecord[] }> {
  const marked: ConflictMarkRecord[] = [];
  for (const [path, entry] of sides.ids) {
    const document = sides.documents.get(entry.id);
    if (document === undefined || !markRetained(document)) continue;
    marked.push({
      path,
      icon: document.icon as string,
      color: colorLabel(document.color) as string,
      saved: entry.saved === undefined ? null : { icon: entry.saved.icon, color: entry.saved.color },
      comments: (await documentComments(ctx, entry.id)).length,
    });
  }
  return { mapped: sides.ids.size, marked };
}

async function metrics(env: Env): Promise<Record<string, unknown>> {
  const { ctx } = env;
  const values = (ctx.observations.get('metrics') as Record<string, unknown> | undefined) ?? {};
  const own = ownResults(ctx);
  const requests = proxyRecordsSinceStart(ctx).filter((record) => !record.injected);
  const written = documentWrites(ctx);
  values.duration = own.reduce((sum, result) => sum + result.durationMs, 0);
  values.requestsPerDocument = written === 0 ? null : Math.round((requests.length / written) * 100) / 100;
  const times = requests.map((record) => record.at);
  values.budgetWindows = times.length === 0 ? 0 : Math.floor((Math.max(...times) - Math.min(...times)) / 3_600_000) + 1;
  const race = ctx.observations.get('race') as { reachedAt: number; resumedAt: number; tokens: string[] } | undefined;
  if (race !== undefined) {
    const view = await currentView(ctx);
    const lost = lostEdits(ctx, view).filter((edit) => race.tokens.includes(edit.token)).length;
    values.raceWindowMs = race.resumedAt - race.reachedAt;
    values.lostEditCount = lost;
    values.raceOutcome = lost === 0 ? 'no-loss' : 'edits-lost';
  }
  ctx.observations.set('metrics', values);
  return values;
}

const BURST_COUNTS = new WeakMap<object, { made: number; foundInGit: number; foundInLinear: number }>();

/** The burst's edits made and found on each side after quiet (L4-12), also kept in the report's metrics. */
async function burstEdits(env: Env): Promise<{ made: number; foundInGit: number; foundInLinear: number }> {
  const edits = observed(env.ctx, 'burst.edits') as RunContext['edits'];
  const view = await env.view();
  // Three subjects read these counts from one view: scan its text once.
  let counts = BURST_COUNTS.get(view);
  if (counts === undefined) {
    const found = editsFound(edits, view);
    counts = { made: edits.length, foundInGit: found.git, foundInLinear: found.linear };
    BURST_COUNTS.set(view, counts);
  }
  const values = (env.ctx.observations.get('metrics') as Record<string, unknown> | undefined) ?? {};
  values.burstEdits = counts;
  env.ctx.observations.set('metrics', values);
  return counts;
}

const linearBody: Compute = (env) => perTarget(env, (path, document, view) => documentBody(view, path, document));

const linearRecords: Compute = async (env) => {
  const tip = await stateTip(env.ctx, 'linear');
  return (await newCommits(await person(env.ctx), tip, [(await env.view()).tip])).length;
};

/**
 * Subjects whose recorded observation is raw: the subject's own computation
 * turns it into the form specs compare (a role path, a palette label), so
 * the raw observation of the same name must not answer for it.
 */
const NORMALIZED_OBSERVATIONS = new Set<string>();

function normalizedObservation(name: string, normalize: (raw: unknown, env: Env) => unknown): Compute {
  NORMALIZED_OBSERVATIONS.add(name);
  return async (env) => normalize(observed(env.ctx, name), env);
}

export const SUBJECTS: Record<string, Compute> = {
  // --- documents in Linear --------------------------------------------------------------
  // Three names the specs use for the same thing: the document's text in Linear, image links mapped.
  'documents.body': linearBody,
  'documents.content': linearBody,
  'linear.body': linearBody,
  'documents.id': async (env) => (await target(env)).id ?? null,
  'ids.documentId': async (env) => (await target(env)).id ?? null,
  'documents.title': async (env) => (await target(env)).document?.title ?? null,
  'documents.icon': async (env) => (await target(env)).document?.icon ?? null,
  'documents.color': async (env) => (await target(env)).document?.color ?? null,
  'documents.state': async (env) => stateOf((await target(env)).document),
  'documents.comments': async (env) => commentsOf(env, (await target(env)).id),
  'documents.location': async (env) => placeOf(env.ctx, (await target(env)).document),
  'documents.bytes': async (env) => new Map([...(await env.view()).documents.values()].map((document) => [document.id, sha256(document.content ?? '')])),
  'documents.titles': async (env) => {
    const seeded = (env.ctx.observations.get('setup.seeded') as string[] | undefined) ?? [];
    const view = await env.view();
    const titles = new Map<string, string>();
    for (const id of seeded) {
      const document = view.documents.get(id) ?? (env.which === 'now' ? await documentById(env.ctx, id) : undefined);
      if (document !== undefined) titles.set(id, document.title);
    }
    return titles;
  },
  'documents.duplicateCount': async (env) => {
    const seen = new Map<string, number>();
    for (const document of (await env.view()).allDocuments) {
      if (!isLive(document)) continue;
      const key = duplicateKey(document);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen.values()].filter((count) => count > 1).length;
  },
  'documents.mapping': async (env) => {
    const view = await env.view();
    return new Map([...view.files.keys()].map((path) => {
      const id = view.ids.get(path)?.id;
      const document = id === undefined ? undefined : view.documents.get(id);
      return [path, document === undefined ? null : `${placeOf(env.ctx, document)}/${document.title}`];
    }));
  },
  'expected.annotationMapping': async (env) => {
    const view = await env.view();
    return new Map([...view.files.keys()].map((path) => {
      const expected = expectedPlace(view.folders, path);
      return [path, expected === null ? null : `${expected.place}/${expected.title}`];
    }));
  },
  'documents.unsyncedPaths': async (env) => {
    const view = await env.view();
    const mapped = new Set([...view.ids.values()].map((entry) => entry.id));
    const seeded = new Set((env.ctx.observations.get('setup.seeded') as string[] | undefined) ?? []);
    return sorted(view.allDocuments.filter((document) => !document.trashed && !mapped.has(document.id) && !seeded.has(document.id)).map((document) => document.title));
  },
  'documents.frontMatterCount': async (env) => [...(await env.view()).documents.values()].filter((document) => /^(---\n|```ya?ml\n)/.test(document.content ?? '')).length,
  'documents.annotationReadmeBodiesIncluded': async (env) => {
    const view = await env.view();
    const readmes = [...view.files.keys()].filter((path) => /(^|\/)README\.md$/.test(path) && (fileBody(view, path) ?? '').trim() !== '');
    return readmes.length > 0 && readmes.every((path) => {
      const id = view.ids.get(path)?.id;
      const document = id === undefined ? undefined : view.documents.get(id);
      return document !== undefined && documentBody(view, path, document) === fileBody(view, path);
    });
  },
  'documents.leftOutPaths': async (env) => {
    const view = await env.view();
    const lintErrors = [...manifestOf(env.ctx)].filter(([, entry]) => entry.class === 'lint-error').map(([path]) => path);
    return sorted(lintErrors.filter((path) => view.ids.has(path)));
  },
  'documents.mermaidBytes': async (env) => mermaidFences(env, 'linear'),
  'fixtures.mermaidBytes': async (env) => mermaidFences(env, 'git'),
  // Each Mermaid document with an invalid diagram → whether it has a live Linear document.
  'documents.invalidMermaidIncluded': async (env) => {
    const view = await env.view();
    return new Map(invalidMermaidPaths(env.ctx).map((path) => {
      const id = view.ids.get(path)?.id;
      return [path, isLive(id === undefined ? undefined : view.documents.get(id))];
    }));
  },
  'expected.invalidMermaidIncluded': async (env) => new Map(invalidMermaidPaths(env.ctx).map((path) => [path, true])),
  'documents.tableSeparators': async (env) => {
    const rows = (await tableRows(env, 'linear')).filter((row) => row.separator).map((row) => row.cells);
    const odd = rows.find((cells) => cells.some((cell) => cell !== '--'));
    return rows.length === 0 ? null : odd === undefined ? '| -- |' : `| ${odd.join(' | ')} |`;
  },
  'documents.tableAlignmentCount': async (env) => (await tableRows(env, 'linear')).filter((row) => row.separator).flatMap((row) => row.cells).filter((cell) => cell.includes(':')).length,
  'documents.tableCells': async (env) => cellMap(await tableRows(env, 'linear')),
  'fixtures.tableCells': async (env) => cellMap(await tableRows(env, 'git')),
  'documents.typographyBytes': async (env) => {
    const view = await env.view();
    return new Map(groupPaths(env.ctx, 'typography-scripts').map((path) => [path, documentBody(view, path, view.documents.get(view.ids.get(path)?.id ?? ''))]));
  },
  'golden.typographyBytes': async (env) => {
    const view = await env.view();
    return linearForms(new Map(groupPaths(env.ctx, 'typography-scripts').map((path) => [path, fileBody(view, path) ?? ''])), view.hashes.keys());
  },
  'golden.linearForm': async (env) => {
    // The form Linear keeps of every synchronized file: a bank fixture's form as the engine sends it
    // while the file is the fixture's own text, else what the normalizer makes of it, without front matter.
    const view = await env.view();
    const bank = loadBank(join(REPO_ROOT, BANK_DIR));
    const fixtures = new Map(bank.fixtures.map((fixture) => [fixture.file, fixture]));
    const fixed = linearForms(view.files, view.hashes.keys());
    const result = new Map<string, string>();
    for (const [path, text] of view.files) {
      const fixture = path.startsWith(`${BANK_HOME}/`) ? fixtures.get(path.slice(BANK_HOME.length + 1)) : undefined;
      const recorded = fixture !== undefined && readFixture(bank, fixture) === text ? engineForm(bank, fixture, text) : undefined;
      result.set(path, recorded ?? bodyOf(fixed.get(path) ?? text));
    }
    return result;
  },
  'documents.syncedLinks': async (env) => linkMap(env, 'synced-linear'),
  'expected.linearUrls': async (env) => linkMap(env, 'synced-expected'),
  'documents.unsyncedLinks': async (env) => linkMap(env, 'unsynced-linear'),
  'input.unsyncedLinks': async (env) => linkMap(env, 'unsynced-git'),
  'input.relativeLinks': async (env) => linkMap(env, 'relative-git'),
  'capture.relativeLinks': async (env) => linkMap(env, 'relative-capture'),
  // Every link with a fragment to another synchronized document keeps its fragment on the document URL.
  'documents.supportedAnchorsPreserved': async (env) => {
    const view = await env.view();
    let anchored = 0;
    for (const path of groupPaths(env.ctx, 'links')) {
      const id = view.ids.get(path)?.id;
      // Every occurrence counts: a fragment kept on one of two equal links does not cover the other.
      const actual = documentLinks(id === undefined ? '' : (view.documents.get(id)?.content ?? ''), view.documentUrlBase).filter((link) => link.includes('#'));
      const expected = documentLinks(linearLinks(bodyOf(view.files.get(path) ?? ''), path, view), view.documentUrlBase).filter((link) => link.includes('#'));
      anchored += expected.length;
      if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) return false;
    }
    if (anchored === 0) throw new Error('the slice has no link with a fragment to another synchronized document');
    return true;
  },
  'documents.oversizeAssetReferences': async (env) => {
    const view = await env.view();
    const bytes = await trackedBytes(env.ctx, (path) => !path.endsWith('.md'));
    const oversize = new Set([...bytes].filter(([, data]) => (lfsSize(data) ?? data.length) > 10 * 1024 * 1024).map(([path]) => path));
    return [...view.files].filter(([path, text]) => view.ids.has(path) && relativeLinks(text).some((link) => oversize.has(resolveLink(path, link)))).length;
  },
  'documents.matchedIds': async (env) => {
    const seeded = (env.ctx.observations.get('setup.seededPaths') as Map<string, string> | undefined) ?? new Map();
    if (env.which === 'before') return seeded;
    const view = await env.view();
    return new Map([...seeded.keys()].map((path) => [path, view.ids.get(path)?.id ?? null]));
  },
  'documents.matchedComments': async (env) => {
    const seeded = (env.ctx.observations.get('setup.seededPaths') as Map<string, string> | undefined) ?? new Map();
    const view = await env.view();
    const result = new Map<string, string[]>();
    for (const [path, seededId] of seeded) result.set(path, await commentsOf(env, env.which === 'before' ? seededId : (view.ids.get(path)?.id ?? seededId)));
    return result;
  },
  'documents.archived': async (env) => {
    const id = env.ctx.observations.get('setup.archivedDocument') as string | undefined;
    if (env.which === 'before') return { state: 'archived', id };
    const document = await documentById(env.ctx, id);
    const view = await env.view();
    return { state: document === undefined ? 'archived' : stateOf(document), id: [...view.ids.values()].some((entry) => entry.id === id) ? 'mapped' : id };
  },
  'documents.linearOnlyState': async (env) => stateOf(await documentById(env.ctx, observed(env.ctx, 'setup.linearOnlyDocument') as string)),
  'documents.linearOnlyRestorable': async (env) => restorable(env.ctx, observed(env.ctx, 'setup.linearOnlyDocument') as string),
  'documents.adoptedUnmappedTitle': async (env) => {
    // The documents the killed run created, by the exact ids Linear confirmed before the kill: the resumed
    // run keeps each one as its file's document, and the run holds no second live document with its title
    // in its place. The view's documents include the team-zone ones the run's ownership record holds, so an
    // annotation README's duplicate counts although its title has no run prefix.
    const created = observed(env.ctx, 'kill.created') as string[];
    const view = await env.view();
    const mapped = new Set([...view.ids.values()].map((entry) => entry.id));
    return created.length > 0 && created.every((id) => {
      const document = view.documents.get(id);
      if (!isLive(document) || !mapped.has(id)) return false;
      return !view.allDocuments.some((other) => other.id !== id && isLive(other) && duplicateKey(other) === duplicateKey(document));
    });
  },
  'documents.newLocation': async (env) => {
    const view = await env.view();
    const path = observed(env.ctx, 'git.added') as string;
    const id = view.ids.get(path)?.id;
    const document = id === undefined ? undefined : view.documents.get(id);
    return document === undefined ? null : { place: placeOf(env.ctx, document), title: document.title };
  },
  'expected.annotationLocation': async (env) => {
    const view = await env.view();
    const expected = expectedPlace(view.folders, observed(env.ctx, 'git.added') as string);
    return expected === null ? null : { place: expected.place, title: expected.title };
  },
  'ids.newPathRecorded': async (env) => (await env.view()).ids.has(observed(env.ctx, 'git.added') as string),
  'documents.deletedState': async (env) => stateOf(await documentById(env.ctx, beforeId(env.ctx, observed(env.ctx, 'git.deleted') as string))),
  'documents.deletedRestorable': async (env) => restorable(env.ctx, beforeId(env.ctx, observed(env.ctx, 'git.deleted') as string)),
  'expected.pathTitle': async (env) => {
    const moved = observed(env.ctx, 'git.moved') as { to: string };
    return expectedPlace((await env.view()).folders, moved.to)?.title ?? null;
  },
  'expected.destination': async (env) => {
    const annotation = env.ctx.observations.get('git.annotation') as { project: string } | undefined;
    if (annotation !== undefined) return [`project:${annotation.project}`];
    const moved = observed(env.ctx, 'git.moved') as { to: string };
    return expectedPlace((await env.view()).folders, moved.to)?.place ?? null;
  },
  'documents.allLocation': async (env) => {
    const view = await env.view();
    const folder = (observed(env.ctx, 'git.annotation') as { folder: string }).folder;
    const places = new Set<string | null>();
    for (const [path, entry] of view.ids) if (path.startsWith(`${folder}/`)) places.add(placeOf(env.ctx, view.documents.get(entry.id)));
    return sorted([...places].map(String));
  },
  'documents.newIdDiffers': async (env) => {
    const change = (env.ctx.observations.get('git.moved') ?? env.ctx.observations.get('git.copied')) as { from: string; to: string } | undefined;
    if (change === undefined) throw new Error('the scenario recorded no move or copy');
    const view = await env.view();
    const now = view.ids.get(change.to)?.id;
    return now !== undefined && now !== beforeId(env.ctx, change.from);
  },
  'documents.oldState': async (env) => stateOf(await documentById(env.ctx, beforeId(env.ctx, (observed(env.ctx, 'git.moved') as { from: string }).from))),
  'documents.imageUrlCount': async (env) => {
    const view = await env.view();
    const url = view.uploadsByHash.get(observed(env.ctx, 'git.imageHash') as string);
    if (url === undefined) return 0;
    return [...view.documents.values()].filter((document) => (document.content ?? '').includes(url)).length;
  },
  'documents.imageUrl': async (env) => {
    const { document } = await target(env);
    const urls = linkDestinations(document?.content ?? '').filter((destination) => destination.image && /^https?:/.test(destination.url)).map((destination) => destination.url);
    const fresh = (await env.view()).uploadsByHash.get(observed(env.ctx, 'git.imageHash') as string);
    return urls.find((url) => url === fresh) ?? urls[0] ?? null;
  },
  'uploads.newUrl': async (env) => (await env.view()).uploadsByHash.get(observed(env.ctx, 'git.imageHash') as string) ?? null,
  'documents.newCount': async (env) => {
    const view = await env.view();
    const id = view.ids.get(observed(env.ctx, 'git.joined') as string)?.id;
    return id !== undefined && view.documents.has(id) ? 1 : 0;
  },
  'documents.renamedCount': async (env) => {
    const moves = observed(env.ctx, 'git.movedFolder') as Array<{ from: string; to: string }>;
    const view = await env.view();
    return moves.filter((move) => {
      const id = view.ids.get(move.to)?.id;
      const expected = expectedPlace(view.folders, move.to);
      return id !== undefined && id === beforeId(env.ctx, move.from) && view.documents.get(id)?.title === expected?.title;
    }).length;
  },
  'documents.ids': async (env) => {
    const moves = observed(env.ctx, 'git.movedFolder') as Array<{ from: string; to: string }>;
    const view = await env.view();
    return moves.map((move) => view.ids.get(env.which === 'before' ? move.from : move.to)?.id ?? null);
  },
  'documents.updatedCount': async (env) => editsOnSide(env, 'git', 'linear'),
  'tracked.updatedDocuments': async (env) => editsOnSide(env, 'linear', 'git'),
  'documents.otherChangesSynced': async (env) => {
    const view = await env.view();
    const edits = env.ctx.edits.filter((edit) => edit.side === 'git');
    return edits.length > 0 && edits.every((edit) => [...view.documents.values()].some((document) => (document.content ?? '').includes(edit.token)));
  },
  'documents.allEditsPreserved': async (env) => lostEdits(env.ctx, await env.view()).length === 0,
  'documents.allThreeEditsPreserved': async (env) => lostEdits(env.ctx, await env.view()).length === 0,
  'documents.cleanEditCount': async (env) => {
    const clean = (env.ctx.observations.get('edits.clean') as string[] | undefined) ?? [];
    const lost = new Set(lostEdits(env.ctx, await env.view()).map((edit) => edit.token));
    return clean.filter((token) => !lost.has(token)).length;
  },
  'documents.cleanEditsSyncedSameRun': async (env) => {
    const clean = (env.ctx.observations.get('edits.clean') as string[] | undefined) ?? [];
    const firstRunEnd = env.ctx.observations.get('harness.runs.0.finishedAt') as number | undefined;
    if (clean.length === 0 || firstRunEnd === undefined) return false;
    const view = await env.view();
    return clean.every((token) => [...view.documents.values()].some((document) => (document.content ?? '').includes(token) && Date.parse(document.updatedAt) <= firstRunEnd));
  },
  'documents.renameDecisionCommentPresent': async (env) => (await newComments(env, (await target(env)).id)).length > 0,
  'documents.stableFixApplied': async (env) => {
    const token = observed(env.ctx, 'ciFix.stable') as string;
    return [...(await env.view()).documents.values()].some((document) => (document.content ?? '').includes(token));
  },
  'documents.unstableFixWritten': async (env) => {
    const token = observed(env.ctx, 'ciFix.unstable') as string;
    return [...(await env.view()).documents.values()].some((document) => (document.content ?? '').includes(token));
  },
  'summary.unstableHookNamed': async (env) => ownResults(env.ctx).some((run) => {
    const sync = run.report?.['sync'] as { leftOut?: Array<{ hooks?: string[] }> } | null | undefined;
    return sync?.leftOut?.some((file) => file.hooks?.includes('aligned-table')) === true && run.summary.includes('aligned-table');
  }),

  // --- the tracked branch ----------------------------------------------------------------
  'tracked.body': (env) => perTarget(env, (path, _document, view) => fileBody(view, path)),
  'tracked.frontMatter': (env) => perTarget(env, (path, _document, view) => frontMatter(view.files.get(path))),
  'linear.frontMatter': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    if (tip === null) throw new ProductError('the run has no linear state ref');
    const view = await env.view();
    const files = await treeFiles(await person(env.ctx), tip, (path) => view.files.has(path));
    return new Map([...view.files.keys()].map((path) => [path, frontMatter(files.get(path)?.toString('utf8'))]));
  },
  'tracked.documentPath': async (env) => symbolicPath(env.ctx, (await target(env)).path),
  'tracked.movedPath': async (env) => movedPath(env.ctx, (await target(env)).path),
  'tracked.createdPath': async (env) => {
    const view = await env.view();
    const id = observed(env.ctx, 'linear.created') as string;
    const path = [...view.ids].find(([, entry]) => entry.id === id)?.[0];
    return path === undefined ? null : symbolicPath(env.ctx, path);
  },
  'tracked.documentPathExists': async (env) => {
    const view = await env.view();
    const paths = (env.ctx.observations.get('target.paths') as string[] | undefined) ?? [(await target(env)).path];
    const git = await person(env.ctx);
    const exists = await Promise.all(paths.map(async (path) => (await git.run(['cat-file', '-e', `${view.tip}:${path}`], { okCodes: [0, 1, 128] })).code === 0));
    return exists.some(Boolean);
  },
  'tracked.tip': async (env) => (await env.view()).tip,
  'tracked.imageStorage': async (env) => (await trackedImages(env)).actual,
  'gitattributes.expected': async (env) => {
    if (env.ctx.observations.has('linear.assets')) return (await pullRequestAssets(env)).storage.expected;
    return (await trackedImages(env)).expected;
  },
  'tracked.imageLinksRelative': async (env) => {
    const view = await env.view();
    const { path } = await target(env);
    const links = imageLinks(view.files.get(path) ?? '');
    const bytes = await trackedBytes(env.ctx, () => true);
    return links.length > 0 && links.every((link) => !/^[a-z]+:/i.test(link) && bytes.has(resolveLink(path, link)));
  },
  'tracked.revertedEdits': async (env) => {
    const view = await env.view();
    const text = [...view.files.values()].join('\n');
    return env.ctx.edits.filter((edit) => edit.side === 'git' && !edit.removal && !text.includes(edit.token)).length;
  },
  'git.latestTip': async (env) => env.ctx.ownCommits.at(-1) ?? null,
  'git.forcePushCount': async (env) => {
    const history = (env.ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined) ?? [];
    const git = await person(env.ctx);
    let count = 0;
    for (let index = 1; index < history.length; index += 1) {
      for (const [ref, old] of Object.entries(history[index - 1] as Record<string, string>)) {
        const next = (history[index] as Record<string, string>)[ref];
        if (next === undefined || next === old) continue;
        // A rewritten ref's old tip may be gone from the server; both commits present and not in line is a force push.
        if ((await present(git, [old, next])).length === 2 && !(await isAncestor(git, old, next))) count += 1;
      }
    }
    return count;
  },
  'merge.output': (env) => perTarget(env, (path, _document, view) => fileBody(view, path)),
  'oracle.gitMerge': async (env) => observed(env.ctx, 'oracle.gitMerge'),
  'resolved.body': async (env) => observed(env.ctx, 'resolved.body'),
  'edited.linearBody': async (env) => observed(env.ctx, 'edited.linearBody'),
  'edited.gitBody': async (env) => observed(env.ctx, 'edited.gitBody'),
  'edited.frontMatter': async (env) => observed(env.ctx, 'edited.frontMatter'),

  // --- state refs ------------------------------------------------------------------------------
  'ids.paths': async (env) => sorted((await env.view()).ids.keys()),
  'corpus.validPaths': async (env) => sorted((await env.view()).files.keys()),
  'ids.documents': async (env) => sorted([...(await env.view()).ids.values()].map((entry) => entry.id)),
  'linear.documents': async (env) => sorted((await env.view()).allDocuments.filter((document) => !document.trashed && document.archivedAt === null).map((document) => document.id)),
  'ids.deletedIdPresent': async (env) => {
    const { id } = observed(env.ctx, 'fixture.trashedDocument') as { id: string };
    return [...(await env.view()).ids.values()].some((entry) => entry.id === id);
  },
  'ids.rebuiltByTitle': async (env) => {
    const view = await env.view();
    const before = env.ctx.observations.get(BEFORE_VIEW) as View | undefined;
    const original = before?.ids;
    if (original === undefined || (await stateTip(env.ctx, 'ids')) === null) return false;
    return [...original].every(([path, entry]) => view.ids.get(path)?.id === entry.id);
  },
  // Records on the linear ref that the tracked branch does not hold (L1-04 calls it the commit count, L1-15 the final record count).
  'linear.commitCount': linearRecords,
  'linear.finalRecordCount': linearRecords,
  'linear.parents': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    return tip === null ? null : parents(await person(env.ctx), tip);
  },
  'expected.initialLinearParents': async (env) => [observed(env.ctx, 'start.trackedTip')],
  'record.kind': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    if (tip === null) return null;
    return (await parents(await person(env.ctx), tip)).length > 1 ? 'merge' : 'ordinary';
  },
  'record.correctParents': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    if (tip === null) return false;
    const git = await person(env.ctx);
    const view = await env.view();
    const list = await parents(git, tip);
    return (await Promise.all(list.map((parent) => isAncestor(git, parent, view.tip)))).some(Boolean);
  },
  'refs.tips': async (env) => {
    if (env.which === 'before') return env.ctx.observations.get('start.refs') ?? {};
    return snapshotRefs(env.ctx);
  },
  'refs.rebuilt': async (env) => {
    const present: string[] = [];
    for (const store of ['linear', 'ids', 'uploads'] as const) if ((await stateTip(env.ctx, store)) !== null) present.push(store);
    return present;
  },
  'refs.linearRestored': async (env) => (await stateTip(env.ctx, 'linear')) !== null,
  'capture.ref': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    if (tip === null) return null;
    const tokens = env.ctx.edits.filter((edit) => edit.side === 'linear').map((edit) => edit.token);
    const files = await treeFiles(await person(env.ctx), tip, (path) => path.endsWith('.md'));
    const text = [...files.values()].map((bytes) => bytes.toString('utf8')).join('\n');
    return tokens.length > 0 && tokens.every((token) => text.includes(token)) ? 'linear' : 'none';
  },
  'capture.writtenDocuments': async (env) => {
    const tip = await stateTip(env.ctx, 'linear');
    const { path } = await target(env);
    if (tip === null) return null;
    const files = await treeFiles(await person(env.ctx), tip, (candidate) => candidate === path);
    const text = files.get(path)?.toString('utf8');
    return text === undefined ? null : bodyOf(text);
  },

  // --- uploads -----------------------------------------------------------------------------------
  // Uploads per distinct content: the upload requests that succeeded (counted at the proxy, whatever the cache
  // keeps) over the hashes the uploads ref records. Each hash needs at least one upload, so 1 means none twice;
  // a hash uploaded again shows as more than 1, even when its cache entry was overwritten.
  'uploads.perHash': async (env) => {
    const view = await env.view();
    const uploaded = proxyRecordsSinceStart(env.ctx).filter((record) => /fileUpload|FileUpload/.test(record.operation) && record.status === 200 && !record.injected).length;
    const hashes = view.uploadsByHash.size;
    return hashes === 0 ? uploaded : Math.ceil(uploaded / hashes);
  },
  // The upload URLs the documents use for the image most documents embed, read link by link from each
  // document beside its file, so a URL the cache no longer holds is still counted.
  'uploads.sharedImageCount': async (env) => {
    const view = await env.view();
    const uses = new Map<string, number>();
    for (const [path, text] of view.files) for (const image of embeddedImages(path, text)) uses.set(image, (uses.get(image) ?? 0) + 1);
    const shared = [...uses].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (shared === undefined) return 0;
    const urls = new Set<string>();
    for (const [path, text] of view.files) {
      const id = view.ids.get(path)?.id;
      const content = id === undefined ? undefined : view.documents.get(id)?.content;
      if (content === undefined || content === null) continue;
      // Every image link, external ones too, so the two lists line up position by position.
      const fileImages = imageLinks(bodyOf(text)).map((link) => (/^[a-z]+:/i.test(link) ? null : resolveLink(path, link)));
      const documentImages = imageLinks(content);
      if (fileImages.length !== documentImages.length) continue; // not converged; I1 reports it
      fileImages.forEach((image, index) => {
        if (image === shared) urls.add(documentImages[index] as string);
      });
    }
    return urls.size;
  },
  'uploads.cacheComplete': async (env) => {
    const view = await env.view();
    // A deliberately broken reference has no file to upload, so it expects no cache entry. It is one the input
    // already held: a link the same document had at the start whose resolved target the branch held no file at,
    // and still holds none at. A link the run added (in any document), or one that does not resolve, still needs
    // its file and entry.
    const before = env.ctx.observations.get(BEFORE_VIEW) as View | undefined;
    const brokenAtStart = new Set<string>();
    for (const [path, text] of before?.files ?? []) for (const image of embeddedImages(path, text)) if (image !== '' && !before?.hashes.has(image)) brokenAtStart.add(`${path}\0${image}`);
    // Images of the documents the engine wrote; a document it left out on purpose uploads nothing.
    let references = 0;
    const expected = new Set<string>();
    for (const [path, text] of view.files) {
      if (!view.ids.has(path)) continue;
      for (const image of embeddedImages(path, text)) {
        references++;
        if (!(brokenAtStart.has(`${path}\0${image}`) && !view.hashes.has(image))) expected.add(image);
      }
    }
    // Images that are all exempt check nothing; report that rather than pass.
    if (references > 0 && expected.size === 0) return false;
    return [...expected].every((path) => {
      const hash = view.hashes.get(path);
      return hash !== undefined && view.uploadsByHash.has(hash);
    });
  },
  'uploads.downloadedBytes': async (env) => downloads(env, 'image'),
  'assets.bytes': async (env) => assetHashes(env, 'image', Infinity),
  'attachments.downloadedBytes': async (env) => downloads(env, 'attachment'),
  'assets.allowedBytes': async (env) => assetHashes(env, 'attachment', 10 * 1024 * 1024),
  'uploads.newCount': async (env) => {
    const view = await env.view();
    const before = (env.ctx.observations.get(BEFORE_VIEW) as View | undefined)?.uploadsByHash ?? new Map();
    return [...view.uploadsByHash.keys()].filter((hash) => !before.has(hash)).length;
  },
  'uploads.reuploadCount': async (env) => {
    const after = Number(env.ctx.observations.get('linear.imageCapturedAtRequest') ?? env.ctx.observations.get('start.proxyIndex') ?? 0);
    return (env.ctx.proxy?.requests ?? []).slice(after).filter((record) => /fileUpload|FileUpload/.test(record.operation) && !record.injected).length;
  },
  'uploads.reuploaded': async (env) => (await stateTip(env.ctx, 'uploads')) !== null && proxyRecordsSinceStart(env.ctx).some((record) => /fileUpload|FileUpload/.test(record.operation) && record.status === 200),

  // --- pull requests ---------------------------------------------------------------------------
  'suspended.trackedUnchanged': async (env) => {
    const view = await env.view();
    const before = env.ctx.observations.get(BEFORE_VIEW) as View;
    const held = [...view.ids].filter(([, entry]) => entry.suspended !== undefined);
    return held.length > 0 && held.every(([path]) => view.files.get(path) === before.files.get(path));
  },
  'suspended.contentsCurrent': async (env) => {
    const view = await env.view();
    const held = [...view.ids].filter(([, entry]) => entry.suspended !== undefined);
    return held.length > 0 && held.every(([path, entry]) => {
      const document = view.documents.get(entry.id);
      const text = view.suspendedFiles?.get(path);
      return document?.trashed === true ? text === undefined : text !== undefined && document !== undefined && sameAsFile(text, document.content ?? '', path, view);
    });
  },
  'suspended.count': async (env) => [...(await env.view()).ids.values()].filter((entry) => entry.suspended !== undefined).length,
  'suspended.markedCount': async (env) => {
    const view = await env.view();
    return [...view.ids.values()].filter((entry) => entry.suspended !== undefined && view.documents.get(entry.id)?.icon === MARKS.suspended.icon && view.documents.get(entry.id)?.color === MARKS.suspended.color).length;
  },
  'suspended.commentCount': async (env) => [...(await env.view()).holdComments?.values() ?? []].flat().filter((c) => c.body.startsWith(HOLD_FAILED) || c.body.startsWith(HOLD_TIMED_OUT)).length,
  'suspended.commentsDetailed': async (env) => {
    const view = await env.view();
    const held = [...view.ids.values()].filter((entry) => entry.suspended !== undefined);
    return held.length > 0 && held.every((entry) => {
      const comments = (view.holdComments?.get(entry.id) ?? []).filter((c) => c.body.startsWith(HOLD_FAILED) || c.body.startsWith(HOLD_TIMED_OUT));
      return comments.length === 1 && comments.every((c) => c.body.includes('Check `format`') && /\[run\]\(https:\/\/github\.com\//.test(c.body) && /Line 1/.test(c.body) && c.resolvedAt === null);
    });
  },
  'suspended.commentsTimedOut': async (env) => {
    const comments = [...(await env.view()).holdComments?.values() ?? []].flat().filter((c) => c.body.startsWith(HOLD_FAILED) || c.body.startsWith(HOLD_TIMED_OUT));
    return comments.length > 0 && comments.every((c) => c.body.includes('did not finish in time'));
  },
  'suspended.commentsResolved': async (env) => {
    const view = await env.view();
    const held = env.ctx.observations.get('suspended.documents') as Set<string> | undefined;
    return held !== undefined && held.size > 0 && [...held].every((id) => {
      const comments = (view.holdComments?.get(id) ?? []).filter((c) => c.body.startsWith(HOLD_FAILED) || c.body.startsWith(HOLD_TIMED_OUT));
      return comments.length > 0 && comments.every((c) => typeof c.resolvedAt === 'string');
    });
  },
  // Linear refuses to resolve the comment of a document in its trash. Each held
  // document is in the trash and named once in a run's `holdMarks.unresolved`,
  // with Linear's GraphQL refusal; its comment stays open, and every later run
  // of the scenario finishes without hold work.
  'suspended.commentsRefused': async (env) => {
    const view = await env.view();
    const before = env.ctx.observations.get(BEFORE_VIEW) as View;
    const held = env.ctx.observations.get('suspended.documents') as Set<string> | undefined;
    if (held === undefined || held.size === 0) return false;
    const pathOf = new Map([...before.ids].map(([path, entry]) => [entry.id, path]));
    const paths = [...held].map((id) => pathOf.get(id));
    if (paths.some((path) => path === undefined)) return false;
    const results = ownResults(env.ctx);
    const marks = results.map((result) => (result.report?.['pullRequest'] as Record<string, unknown> | null | undefined)?.['holdMarks'] as { unresolved?: Array<{ path: string; error: string }> } | null | undefined);
    const refusing = marks.flatMap((mark, index) => mark?.unresolved === undefined ? [] : [index]);
    if (refusing.length !== 1) return false;
    const unresolved = marks[refusing[0]!]!.unresolved!;
    // A later run counts only when it finished with a report of its sync pull request and no hold work.
    const later = results.slice(refusing[0]! + 1);
    const quiet = later.length > 0 && later.every((result, i) => result.exitCode === 0 && result.report?.['pullRequest'] != null && marks[refusing[0]! + 1 + i] == null);
    const trashedWithOpenComment = [...held].every((id) => {
      const comments = (view.holdComments?.get(id) ?? []).filter((c) => c.body.startsWith(HOLD_FAILED) || c.body.startsWith(HOLD_TIMED_OUT));
      return view.documents.get(id)?.trashed === true && comments.length > 0 && comments.every((c) => c.resolvedAt === null);
    });
    return JSON.stringify(unresolved.map((item) => item.path).sort()) === JSON.stringify([...paths].sort())
      && unresolved.every((item) => /^LinearGraphQLError INPUT_ERROR\b/.test(item.error))
      && quiet && trashedWithOpenComment;
  },
  'suspended.marksRestored': async (env) => {
    const view = await env.view();
    const before = env.ctx.observations.get(BEFORE_VIEW) as View;
    const held = env.ctx.observations.get('suspended.documents') as Set<string> | undefined;
    return held !== undefined && held.size > 0 && [...held].every((id) => {
      const document = view.documents.get(id);
      // A released document whose text holds a conflict keeps or gets the
      // conflict mark; every other one gets its own icon and color back.
      // Which marker lines make a conflict (not a lookalike in a quote, code
      // or HTML) is the sync's own reading, which other scenarios check.
      if (detectConflicts(document?.content ?? '').length > 0) return markRetained(document);
      const own = before.documents.get(id);
      return document?.icon === own?.icon && document?.color === own?.color;
    });
  },
  'suspended.comments': async (env) => [...(await env.view()).holdComments?.values() ?? []].flat().map((c) => c.body).sort(),
  'normal.merged': async (env) => ((await env.view()).pullRequests ?? []).filter((pr) => pr.head.ref === env.ctx.names.syncBranch && pr.merged_at !== null).length,
  'normal.open': async (env) => ((await env.view()).pullRequests ?? []).filter((pr) => pr.head.ref === env.ctx.names.syncBranch && pr.state === 'open').length,
  'normal.closedEmpty': async (env) => ((await env.view()).pullRequests ?? []).filter((pr) => pr.head.ref === env.ctx.names.syncBranch && pr.state === 'closed' && pr.merged_at === null && pr.empty).length,
  'checks.personReruns': async (env) => env.ctx.observations.get('checks.personReruns') ?? 0,
  'pullRequests.created': async (env) => (await pullRequestsSinceStart(env.ctx)).length,
  'pullRequests.open': async (env) => (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.state === 'open').length,
  'pullRequests.merged': async (env) => (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.merged_at !== null).length,
  'pullRequests.author': async (env) => {
    const prs = await pullRequestsSinceStart(env.ctx);
    return prs.length > 0 && prs.every((pr) => isAppBot(pr.user?.login)) ? 'app-bot' : (prs.find((pr) => !isAppBot(pr.user?.login))?.user?.login ?? null);
  },
  'pullRequests.merger': async (env) => {
    const merged = (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.merged_at !== null);
    if (merged.length === 0) return null;
    // The list endpoint omits merged_by; read each merged pull request.
    const mergers = await Promise.all(merged.map(async (pr) => (await env.ctx.live?.rest.request<{ merged_by: { login: string } | null }>('GET', `/pulls/${pr.number}`))?.merged_by?.login));
    // With the App's token the harness knows the App's exact login, so the job's own `github-actions[bot]` does not pass for it.
    const app = env.ctx.live?.githubAppLogin;
    const isApp = (login: string | undefined) => (app === undefined ? isAppBot(login) : login === app);
    return mergers.every(isApp) ? 'app-bot' : (mergers.find((login) => !isApp(login)) ?? null);
  },
  // 'merge' when every merged pull request was merged with a merge commit.
  'pullRequests.mergeKind': async (env) => {
    const merged = (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.merged_at !== null);
    const shas = merged.map((pr) => pr.merge_commit_sha);
    if (shas.length === 0 || shas.some((sha) => sha === undefined || sha === null)) return null;
    const git = await person(env.ctx);
    for (const sha of shas as string[]) {
      await git.run(['fetch', '--quiet', 'origin', sha], { okCodes: [0, 1, 128] });
      if ((await parents(git, sha)).length <= 1) return 'squash-or-rebase';
    }
    return 'merge';
  },
  // The merge commit of the one merged pull request; a run that merged it reports the same commit.
  'pullRequests.mergeCommit': async (env) => {
    const merged = (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.merged_at !== null);
    if (merged.length !== 1) throw new ProductError(`${merged.length} sync pull requests merged, not exactly one`);
    return (merged[0] as { merge_commit_sha?: string | null }).merge_commit_sha ?? null;
  },
  'pullRequests.reopenedFromSameBranch': async (env) => (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.head.ref === env.ctx.names.syncBranch).length >= 2,
  'pullRequests.includesAllEdits': async (env) => {
    const view = await env.view();
    const text = [...view.files.values()].join('\n');
    const edits = env.ctx.edits.filter((edit) => edit.side === 'linear');
    return edits.length > 0 && edits.every((edit) => text.includes(edit.token));
  },
  'pullRequests.removalCommitted': async (env) => {
    const view = await env.view();
    const paths = (env.ctx.observations.get('target.paths') as string[] | undefined) ?? [];
    const git = await person(env.ctx);
    const own = new Set(env.ctx.ownCommits);
    for (const path of paths) {
      const removals = (await git.text(['log', '--format=%H', '--diff-filter=D', view.tip, '--', path])).split('\n').filter(Boolean);
      if (!removals.some((commit) => !own.has(commit))) return false;
    }
    return paths.length > 0;
  },
  'pullRequests.restoredPath': async (env) => {
    const deleted = observed(env.ctx, 'git.deleted') as string;
    return (await env.view()).files.has(deleted);
  },
  'pullRequests.spuriousChanges': async (env) => {
    const edited = new Set(env.ctx.edits.filter((edit) => edit.side === 'linear').map((edit) => edit.path));
    let spurious = 0;
    for (const pr of await pullRequestsSinceStart(env.ctx)) for (const file of await pullRequestFiles(env.ctx, pr.number)) if (!edited.has(file.filename)) spurious += 1;
    return spurious;
  },
  'pullRequests.ciPassed': async (env) => {
    const merged = (await pullRequestsSinceStart(env.ctx)).filter((pr) => pr.merged_at !== null);
    if (merged.length === 0) return false;
    for (const pr of merged) if ((await checksOf(env.ctx, pr.head.sha)) !== 'passed') return false;
    return true;
  },
  'pullRequests.tree': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const view = await env.view();
    const files = await treeFiles(head.git, head.commit, (path) => path.endsWith('.md') && owningFolder(path, view.folders) !== null);
    return new Map([...files].map(([path, bytes]) => [path, bodyOf(bytes.toString('utf8'))]));
  },
  'expected.linearTree': async (env) => reverseTree(env.ctx, await env.view()),
  'pullRequests.gitOnlyPaths': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const view = await env.view();
    const expected = reverseTree(env.ctx, view);
    const files = await treeFiles(head.git, head.commit, (path) => path.endsWith('.md') && owningFolder(path, view.folders) !== null);
    return sorted([...files.keys()].filter((path) => !expected.has(path)));
  },
  // The kept annotation READMEs as the pull request holds them, whole: annotation, other front matter and body.
  'pullRequests.keptAnnotationReadmes': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const view = await env.view();
    const kept = new Set(reverseSides(env.ctx, view).kept.keys());
    const files = await treeFiles(head.git, head.commit, (path) => kept.has(path));
    return new Map([...kept].map((path) => [path, files.get(path)?.toString('utf8') ?? null]));
  },
  'expected.keptAnnotationReadmes': async (env) => reverseSides(env.ctx, await env.view()).kept,
  'files.duplicateCount': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const view = await env.view();
    const files = await treeFiles(head.git, head.commit, (path) => path.endsWith('.md') && owningFolder(path, view.folders) !== null);
    const seen = new Map<string, number>();
    for (const bytes of files.values()) {
      const hash = sha256(bodyOf(bytes.toString('utf8')));
      seen.set(hash, (seen.get(hash) ?? 0) + 1);
    }
    return [...seen.values()].reduce((sum, count) => sum + count - 1, 0);
  },
  'pullRequests.assetBytes': async (env) => (await pullRequestAssets(env)).hashes,
  'linear.assetBytes': async (env) => new Map(reverseAssets(env.ctx).map((asset) => [asset.path, asset.sha256])),
  'pullRequests.existingAssetsUnchanged': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return false;
    const before = observed(env.ctx, BEFORE_VIEW) as View;
    const documents = await treeFiles(head.git, before.tip, (path) => path.endsWith('.md'));
    const paths = new Set([...documents].flatMap(([path, bytes]) => embeddedImages(path, bytes.toString('utf8'))));
    const original = await treeFiles(head.git, before.tip, (path) => paths.has(path));
    const files = await treeFiles(head.git, head.commit, (path) => paths.has(path));
    for (const [path, bytes] of documents) {
      for (const asset of embeddedImages(path, bytes.toString('utf8'))) {
        const blob = original.get(asset);
        if (blob !== undefined && !files.get(asset)?.equals(blob)) return false;
      }
    }
    return true;
  },
  'pullRequests.assetStorage': async (env) => (await pullRequestAssets(env)).storage.actual,
  'pullRequests.assetLinksRelative': async (env) => {
    const { links } = await pullRequestAssets(env);
    return links.length > 0 && links.every((link) => !/^[a-z]+:/i.test(link));
  },
  'paths.collisionCount': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const files = await treeFiles(head.git, head.commit, (path) => path.endsWith('.md'));
    const folded = new Map<string, number>();
    for (const path of files.keys()) folded.set(path.normalize('NFC').toLowerCase(), (folded.get(path.normalize('NFC').toLowerCase()) ?? 0) + 1);
    return [...folded.values()].filter((count) => count > 1).length;
  },
  'paths.titleToPath': async (env) => {
    const head = await syncPullRequestHead(env.ctx);
    if (head === null) return null;
    const view = await env.view();
    const result = new Map<string, string | null>();
    const files = await treeFiles(head.git, head.commit, (path) => path.endsWith('.md'));
    for (const title of UNSAFE_TITLES) {
      const id = [...view.documents.values()].find((document) => document.title === title)?.id;
      const path = id === undefined ? undefined : [...view.ids].find(([, entry]) => entry.id === id)?.[0];
      result.set(title, path !== undefined && files.has(path) ? path.split('/').slice(-title.split('/').length).join('/') : null);
    }
    return result;
  },
  'fixtures.unsafeTitlePaths': async () => new Map(UNSAFE_TITLES.map((title) => [title, `${encodeTitlePath(title)}.md`])),
  'paths.decodedTitles': async (env) => {
    const titles = (await SUBJECTS['paths.titleToPath']?.(env)) as Map<string, string | null> | null;
    const seeded = (await SUBJECTS['documents.titles']?.(env)) as Map<string, string>;
    if (titles === null) return null;
    const decoded = new Map<string, string>();
    for (const [id, title] of seeded) {
      const path = titles.get(title);
      decoded.set(id, path === undefined || path === null ? title : decodeURIComponent(path.replace(/\.md$/, '')));
    }
    return decoded;
  },
  'cycle.normalEnabled': async (env) => {
    const last = ownResults(env.ctx).at(-1);
    const code = reportField(last?.report, 'code');
    return last !== undefined && last.exitCode === 0 && code !== 'initial-sync-required';
  },

  // --- conflicts ----------------------------------------------------------------------------------
  'conflicts.scope': async (env) => {
    const oracle = env.ctx.observations.get('oracle.gitMerge') as string | undefined;
    const [first] = await conflictTexts(env);
    if (oracle !== undefined && first?.git === oracle) return 'git-merge-result';
    return agreed(conflictScope(first?.git ?? ''), conflictScope(first?.linear ?? ''));
  },
  'conflicts.bothVersionsComplete': async (env) => {
    const texts = await conflictTexts(env);
    return texts.length > 0 && texts.every((text) => text.git !== null && text.linear !== null && bothVersionsComplete(text.git) && bothVersionsComplete(text.linear));
  },
  'conflicts.markerParagraphCount': async (env) => {
    const [first] = await conflictTexts(env);
    return agreed(scanMarkers(first?.git ?? '').markerLines, scanMarkers(first?.linear ?? '').markerLines);
  },
  'conflicts.markerSetCount': async (env) => {
    const [first] = await conflictTexts(env);
    return agreed(scanMarkers(first?.git ?? '').sets.length, scanMarkers(first?.linear ?? '').sets.length);
  },
  'conflicts.nestedMarkerCount': async (env) => {
    const [first] = await conflictTexts(env);
    return agreed(scanMarkers(first?.git ?? '').nested, scanMarkers(first?.linear ?? '').nested);
  },
  'conflicts.markCount': async (env) => [...(await env.view()).documents.values()].filter(markRetained).length,
  'conflicts.markRetained': async (env) => markRetained((await target(env)).document),
  'conflicts.icon': async (env) => (await target(env)).document?.icon ?? null,
  'conflicts.color': async (env) => colorLabel((await target(env)).document?.color),
  'conflicts.resolutionCommentPresent': async (env) => (await newComments(env, (await target(env)).id)).length > 0,
  'conflicts.imageLinksWorking': async (env) => {
    const view = await env.view();
    const { path } = await target(env);
    const [first] = await conflictTexts(env);
    const bytes = await trackedBytes(env.ctx, () => true);
    const set = scanMarkers(first?.git ?? '').sets[0];
    const gitLinks = set === undefined ? [] : [...imageLinks(set.git), ...imageLinks(set.linear)];
    const linearSet = scanMarkers(first?.linear ?? '').sets[0];
    const linearLinks = linearSet === undefined ? [] : [...imageLinks(linearSet.git), ...imageLinks(linearSet.linear)];
    return gitLinks.length >= 2 && gitLinks.every((link) => bytes.has(resolveLink(path, link))) && linearLinks.length >= 2 && linearLinks.every((link) => view.uploads.has(link));
  },
  'report.gitMergeResultRecorded': async (env) => {
    const oracle = observed(env.ctx, 'oracle.gitMerge') as string;
    const [first] = await conflictTexts(env);
    const values = (env.ctx.observations.get('metrics') as Record<string, unknown> | undefined) ?? {};
    values.gitMergeResult = first?.git === oracle ? 'same-as-git-merge' : scanMarkers(first?.git ?? '').markerLines > 0 ? 'conflict' : 'other';
    env.ctx.observations.set('metrics', values);
    return true;
  },

  // --- blocked documents (L2-35) ----------------------------------------------------------------
  'securityCanary.isolated': async (env) => {
    const facts = (env.ctx.observations.get('securityCanary.facts') as CanaryFacts[] | undefined) ?? [];
    return env.ctx.observations.get('securityCanary.missing') !== true && facts.length > 0 && facts.every(canaryIsolated);
  },
  'blocked.icon': async (env) => observed(env.ctx, 'blocked.icon'),
  'blocked.color': normalizedObservation('blocked.color', (color) => colorLabel(color as string | null)),
  'blocked.commentFields': async (env) => {
    const comments = observed(env.ctx, 'blocked.comments') as string[];
    const fields: string[] = [];
    if (comments.some((comment) => /\bhook\b/i.test(comment))) fields.push('hook');
    if (comments.some((comment) => /\bline \d+/i.test(comment))) fields.push('line');
    return fields;
  },
  'blocked.commentContainsSecret': async (env) => {
    const secret = observed(env.ctx, 'secret.value') as string;
    return (observed(env.ctx, 'blocked.comments') as string[]).some((comment) => comment.includes(secret));
  },
  'blocked.secretOccurrencesOnGithub': async (env) => {
    const secret = observed(env.ctx, 'secret.value') as string;
    const git = await person(env.ctx);
    let count = 0;
    // The secret was typed after the start, so only commits made since then can hold it; each is searched once.
    const tips = [(await env.view()).tip, await syncTip(env.ctx), await stateTip(env.ctx, 'linear'), await stateTip(env.ctx, 'ids'), await stateTip(env.ctx, 'uploads')];
    const commits = new Set<string>();
    for (const tip of tips) for (const commit of await newCommits(git, tip, startTips(env.ctx))) commits.add(commit);
    for (const commit of commits) count += (await git.run(['grep', '-c', '-F', secret, commit], { okCodes: [0, 1] })).stdout.toString('utf8').split('\n').filter(Boolean).length;
    for (const pr of (await env.ctx.live?.rest.pullRequests(`t/${env.ctx.names.runId}/`)) ?? []) if (`${pr.title}\n${pr.body ?? ''}`.includes(secret)) count += 1;
    for (const result of env.ctx.engine.results) if (`${result.stdout}${result.stderr}${result.summary}`.includes(secret)) count += 1;
    return count;
  },

  // --- the sync branch, CI and workflows ------------------------------------------------------
  'syncBranch.personCommitRetained': async (env) => retained(env, [observed(env.ctx, 'syncBranch.personCommit') as string]),
  'syncBranch.ciFixRetained': async (env) => retained(env, observed(env.ctx, 'ciFix.commits') as string[]),
  'syncBranch.ciFixCommitCount': async (env) => {
    const commits = observed(env.ctx, 'ciFix.commits') as string[];
    let count = 0;
    for (const commit of commits) if (await retained(env, [commit])) count += 1;
    return count;
  },
  'syncBranch.newCaptureRetained': async (env) => {
    const token = env.ctx.edits.filter((edit) => edit.side === 'linear').at(-1)?.token;
    const view = await env.view();
    return token !== undefined && [...view.files.values()].some((text) => text.includes(token));
  },
  'syncBranch.recreatedFrom': async (env) => {
    const sync = await syncTip(env.ctx);
    const linear = await stateTip(env.ctx, 'linear');
    if (sync === null) return 'missing';
    const git = await person(env.ctx);
    return linear !== null && (sync === linear || (await isAncestor(git, linear, sync))) ? 'linear' : 'other';
  },
  'ci.fixCommitOnPr': async (env) => {
    const pr = observed(env.ctx, 'ci.pullRequest') as { number: number; head: string };
    const commits = (await env.ctx.live?.rest.request<Array<{ sha: string; author: { login: string } | null; commit: { author: { name: string } } }>>('GET', `/pulls/${pr.number}/commits?per_page=100`)) ?? [];
    return commits.some((commit) => commit.sha !== pr.head && commit.sha !== undefined && !env.ctx.ownCommits.includes(commit.sha));
  },
  'ci.checks': async (env) => {
    const pr = observed(env.ctx, 'ci.pullRequest') as { number: number };
    const current = await env.ctx.live?.rest.request<{ head: { sha: string } }>('GET', `/pulls/${pr.number}`);
    return current === undefined ? null : checksOf(env.ctx, current.head.sha);
  },
  'workflows.events': async (env) => sorted(new Set(((env.ctx.observations.get('workflows.runs') as Array<{ event: string }> | undefined) ?? []).map((run) => run.event))),
  // Who authenticated the pushes of the sync's commits, from GitHub's own push records, never from a commit's
  // author: the engine writes that name itself, whatever credential pushes. 'app-bot' means every recorded push
  // to a run ref the sync wrote was made by the App the harness and the workflows hold (its exact bot login, not
  // any `[bot]` such as the job's own token; in actions mode the harness's own pushes are the App's too), and
  // every one of the sync's commits reached GitHub through such a push. Anything else fails and names the ref.
  'writes.githubActor': async (env) => {
    const live = env.ctx.live;
    if (live === null) throw new EnvBlockedError('who pushed is read from GitHub, and the run has no sandbox');
    const app = live.githubAppLogin;
    if (app === undefined) throw new EnvBlockedError('who pushed is compared with the GitHub App, and the harness holds no App token');
    const git = await person(env.ctx);
    const byRef = await syncCommits(env.ctx);
    for (const [ref, commits] of byRef) {
      const pushes = await live.rest.pushActivities(ref);
      const other = pushes.find((push) => push.actor?.login !== app || push.actor.type !== 'Bot');
      if (other !== undefined) throw new ProductError(`${ref}: GitHub records a ${other.activity_type} to ${other.after.slice(0, 12)} by ${actorKind(other.actor)}, not by the App ${app}`);
      const sync = new Set(commits);
      const afters = pushes.map((push) => push.after).filter((after) => sync.has(after));
      const not = (await present(git, startTips(env.ctx))).map((oid) => `^${oid}`);
      const reached = new Set(afters.length === 0 ? [] : (await git.text(['rev-list', ...afters, ...not])).split('\n').filter(Boolean));
      const unproven = commits.filter((commit) => !reached.has(commit));
      if (unproven.length > 0) throw new ProductError(`${ref}: GitHub has no push record for ${unproven.length} of the sync's ${commits.length} commits (${unproven[0]!.slice(0, 12)} first), so their writer is unproven`);
    }
    return byRef.size === 0 ? null : 'app-bot';
  },
  // The author and committer the sync's own commits name. 'app-bot' means every one names the App the harness
  // and the workflows hold, as GitHub links a commit to it: `<slug>[bot] <<id>+<slug>[bot]@users.noreply.github.com>`.
  // Anything else is the distinct `name <email>` lines, sorted. Two kinds of commit on the sync's refs are not the
  // sync's: GitHub's merge commit of a merged sync pull request (committer GitHub), which a later run's record takes
  // in, and a fixing commit the repository's CI pushes onto the sync branch under its own fixed identity.
  'writes.commitIdentity': async (env) => {
    const git = await person(env.ctx);
    const merges = new Set((await pullRequestsSinceStart(env.ctx)).map((pr) => pr.merge_commit_sha).filter((sha): sha is string => typeof sha === 'string' && sha !== ''));
    const candidates = [...new Set([...(await syncCommits(env.ctx)).values()].flat())].filter((commit) => !merges.has(commit));
    if (candidates.length === 0) return null;
    const ci = `${CI_IDENTITY} ${CI_IDENTITY}`;
    const commits: string[] = [];
    for (const line of (await git.text(['log', '--no-walk=unsorted', '--format=%H %an <%ae> %cn <%ce>', ...candidates])).split('\n')) {
      if (line === '') continue;
      const space = line.indexOf(' ');
      if (line.slice(space + 1) !== ci) commits.push(line.slice(0, space));
    }
    if (commits.length === 0) return null;
    const lines = (await git.text(['log', '--no-walk=unsorted', '--format=%an <%ae>%n%cn <%ce>', ...commits])).split('\n');
    const identities = sorted(new Set(lines.filter((line) => line !== '')));
    const app = env.ctx.live?.githubAppLogin;
    if (app === undefined) throw new EnvBlockedError('the commits are compared with the GitHub App, and the harness holds no App token');
    const login = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linked = new RegExp(`^${login} <[1-9][0-9]*\\+${login}@users\\.noreply\\.github\\.com>$`);
    return identities.every((identity) => linked.test(identity)) ? 'app-bot' : identities.join(', ');
  },

  // --- writes and budget ----------------------------------------------------------------------
  'writes.linear': async (env) => documentWrites(env.ctx),
  'writes.git': async (env) => gitWrites(env.ctx),
  'writes.total': async (env) => documentWrites(env.ctx) + (await gitWrites(env.ctx)) + (await pullRequestsSinceStart(env.ctx)).length,
  'proxy.injectedOperations': async (env) => proxyRecordsSinceStart(env.ctx).filter((record) => record.injected).map((record) => record.operation),
  'http.retryCount': async (env) => {
    const records = proxyRecordsSinceStart(env.ctx);
    // A fault the proxy answered, or a write whose answer it dropped, followed by the same operation again.
    return records.filter((record, index) => (record.injected || record.answerDropped === true) && records.slice(index + 1).some((later) => later.operation === record.operation)).length;
  },
  // Which writes lost their answer after Linear applied them (L5-09): `create`, `update`.
  'proxy.lostAnswers': async (env) => sorted(new Set(proxyRecordsSinceStart(env.ctx).filter((record) => record.answerDropped === true).map((record) => (/create/i.test(record.operation) ? 'create' : 'update')))),
  'run.completed': async (env) => ownResults(env.ctx).at(-1)?.exitCode === 0,
  'leases.refusedCount': async (env) => ownResults(env.ctx).filter((result) => result.report?.['atomicPushRefused'] === true).length,
  'leases.partialRefUpdates': async (env) => ownResults(env.ctx).reduce((sum, result) => sum + Number(result.report?.['partialRefUpdates'] ?? 0), 0),
  // The engine names the files it left out for size by repository path; specs name them by role (L1-08).
  'summary.oversizeFiles': async (env) => {
    const last = ownResults(env.ctx).at(-1);
    if (last?.report === null || last === undefined) throw new ProductError('the engine wrote no report with the oversize files');
    const reported = reportField(last.report, 'oversizeFiles');
    if (!Array.isArray(reported)) throw new ProductError("the engine's report gives no oversizeFiles list");
    return rolesOf(env.ctx, reported.map(String));
  },
  'summary.canaryCount': async (env) => {
    const hits = await canaryScan(env.ctx, { summariesOnly: true });
    return hits.length;
  },
  // Without security hooks every run goes on and warns that content is pushed unchecked.
  'summary.everyRunUncheckedWarning': async (env) => {
    const own = ownResults(env.ctx);
    return own.length > 0 && own.every((result) => setupChecksOf(result.report).some((check) => check.name === 'security-hooks' && check.state === 'warning'));
  },
  'summary.setupChecks': async (env) => {
    const last = ownResults(env.ctx).at(-1);
    if (last?.report === null || last === undefined) throw new ProductError('the engine wrote no report with its setup checks');
    return setupChecksOf(last.report).map((check) => check.name);
  },
  'summary.securityHooksReported': async (env) => {
    const report = ownResults(env.ctx).at(-1)?.report;
    return reportField(report, 'securityHooks') !== undefined && setupChecksOf(report).some((check) => check.name === 'security-hooks');
  },
  'scan.canaryMatches': async (env) => {
    const root = process.env['MDBISYNC_CANARY_EVIDENCE_ROOT'] ?? env.ctx.observations.get('canary.evidenceRoot') as string | undefined;
    if (!root) throw new EnvBlockedError('all-run-evidence scan needs MDBISYNC_CANARY_EVIDENCE_ROOT');
    const evidence = await collectCanaryEvidence(env.ctx, { summariesOnly: false });
    const result = scanNight(root, { directory: env.ctx.runDir, evidence });
    return sorted(new Set(result.matches.map((hit) => hit.source)));
  },
  'hook.fixes': async (env) => {
    const { path } = await target(env);
    const view = await env.view();
    const text = view.files.get(path);
    if (text === undefined) return null;
    return linearForms(new Map([[path, text]]), view.hashes.keys()).get(path) === text ? 0 : 1;
  },

  // --- the scenario report ------------------------------------------------------------------
  'report.metrics': async (env) => Object.keys(await metrics(env)).filter((key) => (env.ctx.observations.get('metrics') as Record<string, unknown>)[key] !== undefined),
  'report.budgetWindows': async (env) => (await metrics(env)).budgetWindows,
  'report.generatedLinearEdits': async (env) => observed(env.ctx, 'report.generatedLinearEdits'),
  'report.generatedGitPushes': async (env) => observed(env.ctx, 'report.generatedGitPushes'),
  'report.burstEditsMade': async (env) => (await burstEdits(env)).made,
  'report.burstEditsFoundInGit': async (env) => (await burstEdits(env)).foundInGit,
  'report.burstEditsFoundInLinear': async (env) => (await burstEdits(env)).foundInLinear,
  // The most edits lost at any moment the harness looked: the end, or an hourly soak check.
  'report.lostEditCount': async (env) => Math.max(lostEdits(env.ctx, await env.view()).length, Number(env.ctx.observations.get('soak.maxLostEdits') ?? 0)),
  'report.hourlyInvariantChecks': async (env) => observed(env.ctx, 'report.hourlyInvariantChecks'),
  'report.interleavingsCovered': async (env) => sorted(new Set((env.ctx.observations.get('report.interleavingsCovered') as string[] | undefined) ?? [])),
  'report.activeLinearTokens': async (env) => {
    const tokens = (env.ctx.observations.get('tokens.seen') as string[] | undefined) ?? env.ctx.proxy?.tokens() ?? [];
    let active = 0;
    for (const token of tokens) if (await tokenActive(token)) active += 1;
    return active;
  },
  'tokens.revokedOnSuccess': async (env) => tokenRevoked(env, 'success'),
  'tokens.revokedOnFailure': async (env) => tokenRevoked(env, 'failure'),
  'tokens.killedRunRevokedByCleanup': async (env) => tokenRevoked(env, 'killed'),

  // --- expectations from the corpus and the setup ----------------------------------------------
  'corpus.lintErrors': async (env) => env.ctx.live === null ? observed(env.ctx, 'corpus.lintErrors') : sorted([...manifestOf(env.ctx)].filter(([, entry]) => entry.class === 'lint-error').map(([path]) => path)),
  'fixtures.bothCollisionPaths': async (env) => sorted([...manifestOf(env.ctx)].filter(([, entry]) => entry.synced && entry.kind === 'markdown' && entry.rule === 'duplicate-title').map(([path]) => path)),
  'expected.initialPlan.paths': async (env) => sorted((await env.view()).files.keys()),
  // Every path the dry run acts on (overwrite, create, remove); the annotation READMEs it keeps are not actions.
  'expected.reversePlan.paths': async (env) => {
    const view = await env.view();
    const { documents, kept } = reverseSides(env.ctx, view);
    return sorted(new Set([...view.files.keys(), ...documents.keys()].filter((path) => !kept.has(path))));
  },
  'expected.destinationPath': normalizedObservation('expected.destinationPath', (path, env) => movedPath(env.ctx, path as string)),
  'setup.requiredChecks': async () => [...REQUIRED_SETUP_CHECKS],
  'fixture.rule': async (env) => observed(env.ctx, 'fixture.rule'),
  // Which Linear-format hook the scratch repository ran: `published` (the corpus's pinned release) or `source`.
  'hook.source': async (env) => observed(env.ctx, 'hook.source'),
  'beforeConflict.icon': async (env) => observed(env.ctx, 'beforeConflict.icon'),
  'beforeConflict.color': async (env) => observed(env.ctx, 'beforeConflict.color'),
  // The start of L1-14 by its own names (`before.matchedIds` …).
  matchedIds: (env) => (SUBJECTS['documents.matchedIds'] as Compute)(env),
  matchedComments: (env) => (SUBJECTS['documents.matchedComments'] as Compute)(env),
  archived: (env) => (SUBJECTS['documents.archived'] as Compute)(env),

  // --- recorded by the steps that produce them ----------------------------------------------
  ...Object.fromEntries([
    // run.fix and run.lint on an offline input (L0)
    'fix.output', 'fix.validOutput', 'fix.first.bytes', 'fix.second.bytes', 'fix.markerBytes', 'input.bytes', 'input.markerBytes', 'lint.leftOut', 'lint.diagnostics.fields',
    // run.probe (L0-05)
    'probe.firstReadback', 'probe.secondReadback', 'probe.drift',
    // run.workflow-parallel (L4-10)
    'workflows.maxActiveInGroup', 'workflows.replacedPending',
    'tokens.activeBeforeCleanup', 'tokens.activeAfterCleanup',
  ].map((name): [string, Compute] => [name, async (env) => observed(env.ctx, name)])),

  // --- after the UI session's steps (L6) -----------------------------------------------------
  'tracked.imageFileExists': async (env) => {
    const view = await env.view();
    const { path } = await target(env);
    const images = embeddedImages(path, view.files.get(path) ?? '');
    const bytes = await trackedBytes(env.ctx, (candidate) => images.includes(candidate));
    return images.length > 0 && images.every((image) => bytes.has(image));
  },
  'tracked.restoredFileExists': async (env) => (await env.view()).files.has((await target(env)).path),
  'tracked.bothEditorChangesPresent': async (env) => {
    // The UI session records the text each editor typed.
    const typed = observed(env.ctx, 'ui.typedTexts') as string[];
    const text = [...(await env.view()).files.values()].join('\n');
    return typed.length >= 2 && typed.every((snippet) => text.includes(snippet));
  },
};

/**
 * What every run checks before writing, in order, by the names the
 * engine's report uses in `setupChecks`. Written out rather than imported,
 * so a check the engine adds, drops or moves fails `setup-checks.test.ts`
 * until this list is updated on purpose.
 */
export const REQUIRED_SETUP_CHECKS = ['linear-credentials', 'github-access', 'github-app', 'merge-commits', 'linear-format-hook', 'annotations', 'annotation-targets', 'left-out-files', 'security-hooks'] as const;

interface SetupCheck {
  name: string;
  state: string;
}

/** A report field at the top or under `summary` (the report is the job summary in structured form). */
function reportField(report: Record<string, unknown> | null | undefined, name: string): unknown {
  return report?.[name] ?? (report?.['summary'] as Record<string, unknown> | undefined)?.[name];
}

function setupChecksOf(report: Record<string, unknown> | null | undefined): SetupCheck[] {
  const checks = reportField(report, 'setupChecks');
  return Array.isArray(checks) ? (checks as SetupCheck[]) : [];
}

function beforeId(ctx: RunContext, path: string): string | undefined {
  const before = ctx.observations.get(BEFORE_VIEW) as View | undefined;
  return before?.ids.get(path)?.id;
}

async function editsOnSide(env: Env, from: 'git' | 'linear', side: 'git' | 'linear'): Promise<number> {
  const view = await env.view();
  const text = side === 'git' ? [...view.files.values()].join('\n') : [...view.documents.values()].map((document) => document.content ?? '').join('\n');
  return env.ctx.edits.filter((edit) => edit.side === from && text.includes(edit.token)).length;
}

async function retained(env: Env, commits: readonly string[]): Promise<boolean> {
  const git = await person(env.ctx);
  const view = await env.view();
  const sync = await syncTip(env.ctx);
  for (const commit of commits) if (!(await isAncestor(git, commit, view.tip)) && !(await isAncestor(git, commit, sync))) return false;
  return commits.length > 0;
}

async function checksOf(ctx: RunContext, sha: string): Promise<'passed' | 'failed' | 'pending' | 'none'> {
  const data = await ctx.live?.rest.request<{ check_runs: Array<{ status: string; conclusion: string | null }> }>('GET', `/commits/${sha}/check-runs?per_page=100`);
  const runs = data?.check_runs ?? [];
  if (runs.length === 0) return 'none';
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  return runs.every((run) => ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')) ? 'passed' : 'failed';
}

const TOKEN_PROBE_TIMEOUT_MS = 15_000;

/**
 * Whether a Linear access token still works: true when Linear answers as
 * the token's user, false only for an authentication refusal. Anything else
 * (a rate limit, an outage, an unexpected answer) proves neither, and after
 * three tries it is an environment problem, never a revoked token.
 */
export async function tokenActive(token: string, fetchImpl: typeof fetch = fetch, pauseMs = 2_000, apiUrl = 'https://api.linear.app'): Promise<boolean> {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    // One deadline for the request and its body, so a stalled Linear cannot hold up a caller such as cleanup.
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: '{ viewer { id } }' }),
        signal: AbortSignal.timeout(TOKEN_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      last = (error as Error).name === 'TimeoutError' ? 'no answer in time' : 'no answer';
      continue;
    }
    if (response.status === 401 || response.status === 403) return false;
    const body = (await response.json().catch(() => ({}))) as { data?: { viewer?: { id?: string } }; errors?: Array<{ extensions?: { code?: string; type?: string } }> };
    if (typeof body.data?.viewer?.id === 'string') return true;
    if (body.errors?.some((error) => /AUTHENTICATION|authentication/.test(`${error.extensions?.code ?? ''} ${error.extensions?.type ?? ''}`))) return false;
    last = `HTTP ${response.status}`;
  }
  throw new EnvBlockedError(`could not tell whether a Linear token is active (${last})`);
}

async function tokenRevoked(env: Env, outcome: string): Promise<boolean> {
  const tokens = (observed(env.ctx, 'tokens.byOutcome') as Record<string, string[]>)[outcome] ?? [];
  if (tokens.length === 0) throw new ProductError(`the ${outcome} run used no Linear token the harness could see`);
  for (const token of tokens) if (await tokenActive(token)) return false;
  return true;
}

async function mermaidFences(env: Env, side: 'git' | 'linear'): Promise<Map<string, string[]>> {
  const view = await env.view();
  const result = new Map<string, string[]>();
  for (const path of groupPaths(env.ctx, 'mermaid')) {
    const id = view.ids.get(path)?.id;
    const text = side === 'git' ? (fileBody(view, path) ?? '') : (id === undefined ? '' : (view.documents.get(id)?.content ?? ''));
    result.set(path, [...text.matchAll(/^```mermaid\n[\s\S]*?^```$/gm)].map((match) => match[0]));
  }
  return result;
}

/**
 * The table rows of the slice's table documents: in Linear, as stored; in
 * git, the file's body with its links as the engine writes them (I1's rule),
 * since a cell's image or document link is a Linear URL there. Cell
 * equality is therefore I1 restricted to table rows: it names the table
 * documents whose cells differ.
 *
 * Both sides take the same table documents, the ones I1 expects a document
 * for: synchronized files that no run left out on purpose. A left-out table
 * (for example one whose image is missing) has no document on either side;
 * an expected table without a mapping, or whose document is missing or
 * trashed, reads as empty in Linear, so its cells differ (I1's "no
 * document").
 */
async function tableRows(env: Env, side: 'git' | 'linear'): Promise<Array<{ path: string; separator: boolean; cells: string[] }>> {
  const view = await env.view();
  const rows: Array<{ path: string; separator: boolean; cells: string[] }> = [];
  for (const path of groupPaths(env.ctx, 'tables')) {
    const file = view.files.get(path);
    if (file === undefined || !expectsDocument(view, path)) continue;
    const id = view.ids.get(path)?.id;
    const document = id === undefined ? undefined : view.documents.get(id);
    const text = side === 'git' ? linearLinks(bodyOf(file), path, view) : (document === undefined || document.trashed ? '' : (document.content ?? ''));
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
      rows.push({ path, separator: cells.every((cell) => /^:?-+:?$/.test(cell)), cells });
    }
  }
  return rows;
}

function cellMap(rows: ReadonlyArray<{ path: string; separator: boolean; cells: string[] }>): Map<string, string[][]> {
  const result = new Map<string, string[][]>();
  for (const row of rows) if (!row.separator) result.set(row.path, [...(result.get(row.path) ?? []), row.cells]);
  return result;
}

type LinkKind = 'synced-linear' | 'synced-expected' | 'unsynced-linear' | 'unsynced-git' | 'relative-git' | 'relative-capture';

async function linkMap(env: Env, kind: LinkKind): Promise<Map<string, string[]>> {
  const view = await env.view();
  const paths = groupPaths(env.ctx, 'links');
  const result = new Map<string, string[]>();
  let capture: Map<string, Buffer> | null = null;
  if (kind === 'relative-capture') {
    const tip = await stateTip(env.ctx, 'linear');
    if (tip === null) throw new ProductError('the run has no linear state ref');
    capture = await treeFiles(await person(env.ctx), tip, (path) => paths.includes(path));
  }
  for (const path of paths) {
    const text = bodyOf(view.files.get(path) ?? '');
    const id = view.ids.get(path)?.id;
    const content = id === undefined ? '' : (view.documents.get(id)?.content ?? '');
    const links = relativeLinks(text);
    switch (kind) {
      case 'synced-linear':
        // The documents this one links to, by id and fragment.
        result.set(path, sorted(documentLinks(content, view.documentUrlBase)));
        break;
      case 'synced-expected':
        result.set(path, sorted(documentLinks(linearLinks(text, path, view), view.documentUrlBase)));
        break;
      case 'unsynced-linear':
        result.set(path, sorted(relativeLinks(content)));
        break;
      case 'unsynced-git':
        // Links that stay as written: to files that are neither synchronized documents nor uploads.
        result.set(path, sorted(relativeLinks(linearLinks(text, path, view))));
        break;
      case 'relative-git':
        result.set(path, sorted(links));
        break;
      case 'relative-capture':
        result.set(path, sorted(relativeLinks(bodyOf(capture?.get(path)?.toString('utf8') ?? ''))));
        break;
    }
  }
  return result;
}

/** Hashes of downloaded uploads that documents embed, by the file they stand for. */
async function downloads(env: Env, kind: 'image' | 'attachment'): Promise<Map<string, string>> {
  const world = env.ctx.live;
  if (world === null) throw new Error('downloads need the live world');
  const view = await env.view();
  const manifest = manifestOf(env.ctx);
  const result = new Map<string, string>();
  // Destinations as the parser reads them (`<…>` included), without a fragment such as `#page=2`.
  const used = new Set([...view.documents.values()].flatMap((document) => linkDestinations(document.content ?? '').map((destination) => destination.url.split('#')[0] as string)));
  for (const [url, path] of view.uploads) {
    if (!used.has(url) || manifest.get(path)?.kind !== kind) continue;
    result.set(path, sha256(await world.download(url)));
  }
  return result;
}

/** Hashes of the files documents should embed, by path; files over `limit` bytes are left out. */
async function assetHashes(env: Env, kind: 'image' | 'attachment', limit: number): Promise<Map<string, string>> {
  const view = await env.view();
  const manifest = manifestOf(env.ctx);
  const bytes = await trackedBytes(env.ctx, (path) => manifest.get(path)?.kind === kind);
  const linked = new Set<string>();
  for (const [path, text] of view.files) if (view.ids.has(path)) for (const link of relativeLinks(text)) linked.add(resolveLink(path, link));
  const result = new Map<string, string>();
  for (const [path, data] of bytes) if (linked.has(path) && (lfsSize(data) ?? data.length) <= limit) result.set(path, fileHash(data));
  return result;
}

async function trackedImages(env: Env): Promise<{ actual: Map<string, string>; expected: Map<string, string> }> {
  const view = await env.view();
  const { path } = await target(env);
  const images = embeddedImages(path, view.files.get(path) ?? '');
  const bytes = await trackedBytes(env.ctx, (candidate) => images.includes(candidate));
  return storageOf(await person(env.ctx), images, bytes);
}

interface ReverseAsset {
  documentPath: string;
  path: string;
  sha256: string;
  bytes: Buffer;
}

function reverseAssets(ctx: RunContext): ReverseAsset[] {
  const assets = observed(ctx, 'linear.assets') as ReverseAsset[];
  if (assets.length === 0) throw new Error('the reverse asset fixture has no expected downloads');
  const before = observed(ctx, BEFORE_VIEW) as View;
  return assets.map((asset) => {
    // A reverse sync reuses an identical file already present before the run.
    const existing = [...before.hashes].filter(([path, hash]) => !path.toLowerCase().endsWith('.md') && hash === asset.sha256).at(-1)?.[0];
    return existing === undefined ? asset : { ...asset, path: existing };
  });
}

async function pullRequestAssets(env: Env): Promise<{ hashes: Map<string, string>; storage: { actual: Map<string, string>; expected: Map<string, string> }; links: string[] }> {
  const head = await syncPullRequestHead(env.ctx);
  if (head === null) throw new ProductError('the reverse initial sync opened no pull request');
  const assets = reverseAssets(env.ctx);
  const paths = new Set(assets.flatMap((asset) => [asset.path, asset.documentPath]));
  const files = await treeFiles(head.git, head.commit, (path) => paths.has(path));
  const readLfs = await lfsReader(head.git, 'origin');
  const links: string[] = [];
  const hashes = new Map<string, string>();
  for (const asset of assets) {
    const document = files.get(asset.documentPath);
    if (document === undefined) throw new ProductError('the reverse asset fixture document is missing');
    const embedded = imageLinks(document.toString('utf8'));
    links.push(...embedded);
    if (!embedded.some((link) => !/^[a-z]+:/i.test(link) && resolveLink(asset.documentPath, link) === asset.path)) {
      throw new ProductError('the reverse asset fixture has no link to its expected download path');
    }
    const blob = files.get(asset.path);
    if (blob === undefined) throw new ProductError('the reverse asset fixture download is missing');
    const pointer = parseLfsPointer(blob);
    const read = pointer === null ? { ok: true as const, content: blob } : await readLfs(pointer, asset.path);
    if (!read.ok) throw new ProductError('the reverse asset fixture LFS download is missing or corrupt');
    const bytes = read.content;
    if (!bytes.equals(asset.bytes)) throw new ProductError('the reverse asset fixture download has different bytes');
    hashes.set(asset.path, sha256(bytes));
  }
  return { hashes, storage: await storageOf(head.git, [...hashes.keys()], files), links };
}

// --- setup failures -------------------------------------------------------------------------------

/**
 * The setup check that stopped run <n|last> before any write, and the link that says how to fix it
 * (L5-01 to L5-05). The report has no field that says the item was named: the harness reads it from
 * what the run actually gave.
 *
 * - `item`: the first entry of the report's `setupChecks` in state `failed`: the engine stops on the
 *   first failure and gives its code as the report's `code`; later independent checks may fail too.
 *   The job summary must show it as a FAILED row.
 * - `fixLink`: the link in that row, which the summary's stop line and the run's terminal stop line,
 *   both naming the report's `code`, must give alike.
 *
 * A missing item, row, line or link, or links that differ, fail as a product error.
 */
const SETUP_FAILURE_SUBJECT = /^runs\.(\d+|last)\.setupFailure\.(item|fixLink)$/;

function setupFailureValue(ctx: RunContext, subject: string): string {
  const [, which, field] = SETUP_FAILURE_SUBJECT.exec(subject) as RegExpExecArray;
  const own = ownResults(ctx);
  const index = which === 'last' ? own.length - 1 : Number(which);
  const result = own[index];
  if (result === undefined) throw new ProductError(`the scenario has no engine run ${which} for ${subject}`);
  if (result.report === null) throw new ProductError(`engine run ${index} wrote no report, so it gives no ${subject}`);
  const first = setupChecksOf(result.report).find((check) => check.state === 'failed');
  if (first === undefined) throw new ProductError(`engine run ${index}'s setupChecks have no failed item`);
  const item = first.name;
  const summaryLines = result.summary.split('\n');
  const row = summaryLines.find((line) => line.startsWith(`| ${item} | FAILED | `));
  if (row === undefined) throw new ProductError(`engine run ${index}'s job summary has no FAILED row for ${item}`);
  if (field === 'item') return item;

  const code = reportField(result.report, 'code');
  if (typeof code !== 'string') throw new ProductError(`engine run ${index}'s report gives no code`);
  const summaryStop = summaryLines.find((line) => line.startsWith(`Stopped before any write: \`${code}\`.`));
  const terminalStop = `${result.stdout}\n${result.stderr}`.split('\n').find((line) => line.startsWith(`${result.command}: stopped before any write (${code})`));
  const links = {
    'the FAILED row': /\(\[how to fix\]\((\S+)\)\) \|$/.exec(row)?.[1],
    "the summary's stop line": / How to fix it: (\S+)$/.exec(summaryStop ?? '')?.[1],
    'the terminal stop line': / How to fix it: (\S+)$/.exec(terminalStop ?? '')?.[1],
  };
  for (const [where, link] of Object.entries(links)) {
    if (link === undefined) throw new ProductError(`engine run ${index}: ${where} for ${code} gives no fix link`);
  }
  const distinct = new Set(Object.values(links));
  if (distinct.size !== 1) throw new ProductError(`engine run ${index} gives different fix links: ${Object.entries(links).map(([where, link]) => `${where} ${link}`).join(', ')}`);
  return links['the FAILED row'] as string;
}

// --- resolution -----------------------------------------------------------------------------------

/**
 * Subjects that also name one run, `runs.<n|last>.<subject>`: computed on the
 * world the harness snapshotted right after that run (`harness.runView.<n>`).
 */
export const RUN_VIEW_SUBJECT = /^runs\.(\d+|last)\.(documents\.content|documents\.body|linear\.body|golden\.linearForm|suspended\.(?:count|contentsCurrent|markedCount|trackedUnchanged|commentCount|commentsDetailed|commentsTimedOut|commentsResolved|commentsRefused|marksRestored|comments)|normal\.(?:open|merged|closedEmpty))$/;

/** The runs whose world the scenario asserts on (`runs.<n|last>.` document subjects): their indices, and whether the last. */
function viewedRuns(ctx: RunContext): { indices: Set<number>; last: boolean } {
  const indices = new Set<number>();
  let last = false;
  for (const assertion of ctx.scenario.checks.assertions) {
    for (const subject of [assertion.subject, ...(assertion.operator === 'same-as' ? [String(assertion.expected)] : [])]) {
      const which = RUN_VIEW_SUBJECT.exec(subject)?.[1];
      if (which === 'last') last = true;
      else if (which !== undefined) indices.add(Number(which));
    }
  }
  return { indices, last };
}

/**
 * The observations that choose which document a subject speaks of
 * (`target`, `perTarget`). A run's snapshot keeps them as they were at the
 * run's end, so a later step that picks a target changes no earlier run.
 */
const TARGET_SELECTION = ['target.path', 'target.id', 'git.moved', 'fixture.document'] as const;

/** The world right after a run, with the target selection of that moment. */
interface RunView {
  view: View;
  selection: ReadonlyArray<readonly [string, unknown]>;
}

/** The scenario asserts on the world right after some run, so its runs are snapshotted. */
export function watchesRunViews(ctx: RunContext): boolean {
  const { indices, last } = viewedRuns(ctx);
  return ctx.live !== null && (last || indices.size > 0);
}

/**
 * The world right after run <n>, for its `runs.<n>.` subjects, when the
 * scenario names that run. For `last`, only the latest run's view is kept.
 * A run after the scenario's own (I6's extra run) is not one of its runs.
 */
export async function recordRunView(ctx: RunContext, n: number): Promise<void> {
  if (ctx.observations.has('scenario.runsEnd')) return;
  const { indices, last } = viewedRuns(ctx);
  if (!last && !indices.has(n)) return;
  const selection = TARGET_SELECTION.filter((key) => ctx.observations.has(key)).map((key) => [key, ctx.observations.get(key)] as const);
  const record: RunView = { view: await takeView(ctx, false, { allowNoIds: true }), selection };
  ctx.observations.set(`harness.runView.${n}`, record);
  if (last && !indices.has(n - 1)) ctx.observations.delete(`harness.runView.${n - 1}`);
}

/** Families of subjects read from the engine's run report. */
const ENGINE_FAMILIES = [/^runs\.(\d+|last)\./, /^summary\./, /^paths\.rule$/];

export type SubjectSource = 'observed' | 'harness' | 'engine' | 'ui';

/** Where a subject's value comes from, or null when nothing provides it (a harness gap). */
export function subjectSource(subject: string): SubjectSource | null {
  const name = subject.startsWith('before.') ? subject.slice('before.'.length) : subject;
  if (Object.hasOwn(SUBJECTS, name) || (!subject.startsWith('before.') && (QUIET_SUBJECT.test(name) || RUN_VIEW_SUBJECT.test(name) || SETUP_FAILURE_SUBJECT.test(name)))) return 'harness';
  if (ENGINE_FAMILIES.some((pattern) => pattern.test(name))) return 'engine';
  if (name.startsWith('ui.')) return 'ui';
  return null;
}

function pathValue(value: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

/** What one engine run wrote, by kind; see `runWrites`. */
export interface RunWrites {
  linear: number;
  git: number;
  pullRequests: number;
  total: number;
}

const WRITE_KINDS = ['linear', 'git', 'pullRequests'] as const;

/**
 * What one engine run wrote, from its report's `writes`: the subjects
 * `runs.<n|last>.writes.linear|git|pullRequests|total`. The engine counts
 * each write where it succeeds and never a refused, failed or unanswered
 * one, so the same holds for every operation:
 *
 * - `linear`: Linear mutations by operation (documents created, updated,
 *   moved, trashed or restored, the icon and color of a mark, comments)
 *   and files storage took.
 * - `git`: refs the run's accepted pushes moved (the `linear`, `ids` and
 *   `uploads` state refs, the sync branch), each move once. A push that was
 *   refused moved nothing; a capture that published and then stopped did.
 * - `pullRequests`: pull request calls GitHub accepted: opened, updated
 *   (a description, also the note of a refused merge), merged, closed.
 * - `total`: their sum.
 *
 * These are this run's own writes. The world-wide `writes.*` subjects count
 * from the world since setup and stay an independent check; they differ in
 * kind (a merge is a tracked-branch commit there, a pull request write
 * here). A report without `writes` fails as a product error.
 */
export function runWrites(report: Record<string, unknown>): RunWrites {
  const writes = report['writes'];
  if (writes === null || typeof writes !== 'object' || Array.isArray(writes)) throw new ProductError("the engine's report gives no writes");
  const counted = { linear: 0, git: 0, pullRequests: 0 };
  for (const kind of WRITE_KINDS) {
    const byName = (writes as Record<string, unknown>)[kind];
    if (byName === null || typeof byName !== 'object' || Array.isArray(byName)) throw new ProductError(`the engine's report gives no writes.${kind}`);
    for (const [name, count] of Object.entries(byName)) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new ProductError(`the engine's report gives writes.${kind}.${name} that is not a count`);
      counted[kind] += count;
    }
  }
  return { ...counted, total: counted.linear + counted.git + counted.pullRequests };
}

function engineValue(ctx: RunContext, subject: string): unknown {
  const own = ownResults(ctx);
  const runMatch = /^runs\.(\d+|last)\.(.+)$/.exec(subject);
  const index = runMatch === null ? own.length - 1 : runMatch[1] === 'last' ? own.length - 1 : Number(runMatch[1]);
  const path = (runMatch === null ? subject : (runMatch[2] as string)).split('.');
  const result = own[index];
  if (result === undefined) throw new ProductError(`the scenario has no engine run ${runMatch?.[1] ?? 'last'} for ${subject}`);
  if (result.report === null) throw new ProductError(`engine run ${index} wrote no report, so it gives no ${subject}`);
  // A run's writes are the report's `writes` summed by kind (`runWrites`).
  if (runMatch !== null && path[0] === 'writes') {
    const writes = runWrites(result.report);
    const kind = path.length === 2 ? path[1] : undefined;
    // A scenario that names another kind is wrong, not the product: a harness error.
    if (kind === undefined || !Object.hasOwn(writes, kind)) throw new Error(`${subject}: a run's writes are ${Object.keys(writes).map((name) => `writes.${name}`).join(', ')}`);
    return writes[kind as keyof RunWrites];
  }
  // The report is the job summary in structured form: `summary.code` is the report's `code`.
  // A sync's report has `summary: null` (that field holds an initial sync's plan), so a `summary` that does not
  // hold the next key sends the path to the top level.
  const nested = result.report['summary'];
  if (path[0] === 'summary' && (nested === null || typeof nested !== 'object' || !Object.hasOwn(nested, path[1] as string))) path.shift();
  const found = pathValue(result.report, path);
  if (!found.found) throw new ProductError(`the engine's report gives no ${path.join('.')}`);
  return found.value;
}

/** The index among the scenario's own runs that `<n|last>` names in `subject`. */
function ownRunIndex(ctx: RunContext, which: string, subject: string): number {
  const count = ownResults(ctx).length;
  const index = which === 'last' ? count - 1 : Number(which);
  if (index < 0 || index >= count) throw new ProductError(`the scenario has no engine run ${which} for ${subject}`);
  return index;
}

/**
 * Why run <n|last> of the scenario was not quiet (quiet.ts), empty when it
 * was. The run must have been watched: a run without snapshots is no
 * evidence either way.
 */
function quietValue(ctx: RunContext, subject: string): string[] {
  const index = ownRunIndex(ctx, (QUIET_SUBJECT.exec(subject) as RegExpExecArray)[1] as string, subject);
  const failures = ctx.observations.get(`harness.quiet.${index}`) as string[] | undefined;
  if (failures === undefined) throw new Error(`engine run ${index} was not watched for ${subject}`);
  return failures;
}

/**
 * A document text subject on the world right after run <n|last>. The run
 * must have been snapshotted: neither the report nor the world at the end
 * stands in for that moment.
 */
async function runViewValue(ctx: RunContext, subject: string): Promise<unknown> {
  const [, which, name] = RUN_VIEW_SUBJECT.exec(subject) as RegExpExecArray;
  const index = ownRunIndex(ctx, which as string, subject);
  const record = ctx.observations.get(`harness.runView.${index}`) as RunView | undefined;
  if (record === undefined) throw new Error(`engine run ${index} has no snapshot of the world right after it for ${subject}`);
  // The run's own target selection, not one a later step recorded.
  const observations = new Map(ctx.observations);
  for (const key of TARGET_SELECTION) observations.delete(key);
  for (const [key, value] of record.selection) observations.set(key, value);
  const atRun: RunContext = Object.assign(Object.create(ctx) as RunContext, { observations });
  return (SUBJECTS[name as string] as Compute)({ ctx: atRun, which: 'run', view: async () => record.view });
}

export async function resolveSubject(ctx: RunContext, subject: string): Promise<{ known: boolean; value?: unknown }> {
  if (ctx.observations.has(subject) && !NORMALIZED_OBSERVATIONS.has(subject)) return { known: true, value: ctx.observations.get(subject) };
  if (QUIET_SUBJECT.test(subject)) return { known: true, value: quietValue(ctx, subject) };
  if (RUN_VIEW_SUBJECT.test(subject)) return { known: true, value: await runViewValue(ctx, subject) };
  if (SETUP_FAILURE_SUBJECT.test(subject)) return { known: true, value: setupFailureValue(ctx, subject) };
  const before = subject.startsWith('before.');
  const name = before ? subject.slice('before.'.length) : subject;
  const compute = SUBJECTS[name];
  if (compute !== undefined) {
    const env: Env = before
      ? {
          ctx,
          which: 'before',
          view: async () => {
            const view = ctx.observations.get(BEFORE_VIEW) as View | undefined;
            if (view === undefined) throw new Error('the runner took no snapshot at the start');
            return view;
          },
        }
      : { ctx, which: 'now', view: () => currentView(ctx) };
    return { known: true, value: await compute(env) };
  }
  if (!before && ENGINE_FAMILIES.some((pattern) => pattern.test(name))) return { known: true, value: engineValue(ctx, name) };
  return { known: false };
}
