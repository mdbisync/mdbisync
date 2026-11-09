// Checks after a scenario: the invariants I1 to I9 of every scenario and the
// scenario's own assertions. A check reports what failed in words and paths,
// never document content.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { readIds, readUploads, resolveStateConfig, stateRef, type Git, type IdMap } from '../../../src/state/index.ts';
import type { RunContext } from './context.ts';
import { annotatedFolders, owningFolder, type Folder } from './corpus.ts';
import { HarnessGapError, ProductError, type CheckOutcome } from './results.ts';
import { INVARIANTS, type Assertion, type InvariantId } from './spec.ts';
import { refreshView, resolveSubject } from './subjects.ts';

// --- pure helpers ----------------------------------------------------------

/** Removes a YAML front matter block at the start of a file. */
export function stripFrontMatter(text: string): string {
  return text.replace(/^(?:﻿)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

/** The Linear title of a synchronized file: its path below its annotated folder, without `.md`. */
export function titleOf(path: string, folderOfPath: string): string {
  const relative = folderOfPath === '' ? path : path.slice(folderOfPath.length + 1);
  return relative.replace(/\.md$/, '');
}

/** Replaces upload URLs with the relative path of the file they hold, seen from `documentPath`. */
export function mapImageLinks(content: string, urlToPath: ReadonlyMap<string, string>, documentPath: string): string {
  let result = content;
  const base = posix.dirname(documentPath);
  for (const [url, path] of urlToPath) result = result.split(url).join(posix.relative(base, path) || path);
  return result;
}

export interface CanaryHit {
  source: string;
  canary: string;
}

/** Finds canary tokens in texts. Reports the source and the token, never the text around it. */
export function scanCanaries(texts: ReadonlyMap<string, string>, canaries: Iterable<string>): CanaryHit[] {
  const hits: CanaryHit[] = [];
  const list = [...canaries].filter((canary) => canary.length >= 6);
  for (const [source, text] of texts) for (const canary of list) if (text.includes(canary)) hits.push({ source, canary });
  return hits;
}

/** I9: requests per written document stay at or under 1.5, plus at most 5 per run. */
export function budgetHolds(requests: number, documentsWritten: number, runs: number): boolean {
  return requests <= 1.5 * documentsWritten + 5 * runs;
}

/** Evaluates one assertion operator. */
export function compare(operator: Assertion['operator'], actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'equal':
    case 'same-as':
      return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
    case 'contains-all':
      return Array.isArray(actual) && Array.isArray(expected) && expected.every((item) => actual.some((value) => JSON.stringify(value) === JSON.stringify(item)));
    case 'at-most':
      return typeof actual === 'number' && actual <= (expected as number);
    case 'at-least':
      return typeof actual === 'number' && actual >= (expected as number);
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (value instanceof Map) return Object.fromEntries([...value].sort(([a], [b]) => String(a).localeCompare(String(b))));
  return value;
}

// --- the run's two sides -----------------------------------------------------

export interface Sides {
  /** Synchronized Markdown files of the tracked branch's tip: path → text. */
  files: Map<string, string>;
  ids: IdMap;
  /** Upload URL → file path in the tree. */
  uploads: Map<string, string>;
  /** Documents by id. */
  documents: Map<string, LinearDocument>;
  /** Every document in the run's projects and team-zone prefix. */
  allDocuments: LinearDocument[];
  /** SHA-256 of a file → upload URL, as the uploads ref holds it. */
  uploadsByHash: Map<string, string>;
  /** Every tracked file's SHA-256 (an LFS pointer's object id for LFS files) by path. */
  hashes: Map<string, string>;
  /** The tracked branch's tip. */
  tip: string;
  /** Annotated folders of the tracked branch. */
  folders: Folder[];
}

/** A file's SHA-256: an LFS pointer's object id, else the hash of the bytes. */
export function fileHash(bytes: Buffer): string {
  const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\n/.exec(bytes.toString('latin1'));
  return pointer?.[1] ?? createHash('sha256').update(bytes).digest('hex');
}

/** An LFS pointer's object size, or null for a file stored in git. */
export function lfsSize(bytes: Buffer): number | null {
  const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n[\s\S]*?^size (\d+)$/m.exec(bytes.toString('latin1'));
  return match === null ? null : Number(match[1]);
}

export async function fetchRef(git: Git, ref: string): Promise<string | null> {
  try {
    await git.run(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
    return (await git.text(['rev-parse', ref])).trim();
  } catch {
    return null;
  }
}

/** Reads both sides; without `allowNoIds`, a run with no ids state ref is a product error. */
export async function readSides(ctx: RunContext, options: { allowNoIds?: boolean } = {}): Promise<Sides> {
  const world = ctx.live;
  if (world === null) throw new Error('offline scenarios have no sides');
  const git = await ctx.person();
  await git.run(['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', ctx.names.trackedBranch]);
  const config = resolveStateConfig({ trackedBranch: ctx.names.trackedBranch, syncBranch: ctx.names.syncBranch, refPrefix: ctx.names.refPrefix });
  const idsCommit = await fetchRef(git, stateRef(config, 'ids'));
  const uploadsCommit = await fetchRef(git, stateRef(config, 'uploads'));
  if (idsCommit === null && options.allowNoIds !== true) throw new ProductError('the run has no ids state ref');
  const ids = await readIds(git, idsCommit);
  const uploadsByHash = await readUploads(git, uploadsCommit);

  const tracked = (await git.text(['ls-files', '-z'])).split('\0').filter(Boolean);
  const readmes = new Map<string, string>();
  for (const path of tracked) if (/(^|\/)README\.md$/.test(path)) readmes.set(path, readFileSync(join(git.dir, path), 'utf8'));
  const folders = annotatedFolders(readmes);
  // Files of the slice that the corpus marks as not synchronized or left out (lint errors) have no document.
  const manifest = new Map(world.manifest.files.map((file) => [file.path, file]));
  const unsynced = new Set<string>();
  for (const [target, source] of world.tree.paths) {
    const entry = manifest.get(source);
    if (entry !== undefined && (!entry.synced || entry.class === 'lint-error')) unsynced.add(target);
  }
  const files = new Map<string, string>();
  const hashToPath = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const path of tracked) {
    const bytes = readFileSync(join(git.dir, path));
    const hash = fileHash(bytes);
    hashToPath.set(hash, path);
    hashes.set(path, hash);
    if (path.endsWith('.md') && owningFolder(path, folders) !== null && !unsynced.has(path)) files.set(path, bytes.toString('utf8'));
  }
  const uploads = new Map<string, string>();
  for (const [hash, url] of uploadsByHash) {
    const path = hashToPath.get(hash);
    if (path !== undefined) uploads.set(url, path);
  }

  const allDocuments: LinearDocument[] = [];
  for (const project of world.projects.values()) allDocuments.push(...(await world.app.listDocuments({ projectId: project.id }, { withContent: true })));
  for (const team of world.tree.teamZones.keys()) {
    const teamId = world.teams.get(team)?.id;
    if (teamId === undefined) continue;
    const documents = await world.app.listDocuments({ teamId }, { withContent: true });
    allDocuments.push(...documents.filter((document) => document.projectId === null && document.title.startsWith(ctx.names.teamZonePrefix)));
  }
  const documents = new Map(allDocuments.map((document) => [document.id, document]));
  const missing = [...ids.values()].map((entry) => entry.id).filter((id) => !documents.has(id));
  if (missing.length > 0) for (const document of await world.app.getDocuments(missing, { withContent: true })) documents.set(document.id, document);
  const tip = (await git.text(['rev-parse', 'HEAD'])).trim();
  return { files, ids, uploads, documents, allDocuments, uploadsByHash, hashes, tip, folders };
}

// --- invariants ---------------------------------------------------------------

type Check = (ctx: RunContext, sides: () => Promise<Sides>) => Promise<CheckOutcome>;

const ok = (name: string): CheckOutcome => ({ name, ok: true });
const bad = (name: string, detail: string): CheckOutcome => ({ name, ok: false, detail });

export const INVARIANT_CHECKS: Record<InvariantId, Check> = {
  async I1(_ctx, sides) {
    const s = await sides();
    const differing: string[] = [];
    for (const [path, text] of s.files) {
      const entry = s.ids.get(path);
      const document = entry === undefined ? undefined : s.documents.get(entry.id);
      if (document === undefined || document.trashed) {
        differing.push(`${path} (no document)`);
        continue;
      }
      if (stripFrontMatter(text) !== mapImageLinks(document.content ?? '', s.uploads, path)) differing.push(path);
    }
    return differing.length === 0 ? ok('I1') : bad('I1', `${differing.length} files differ from their documents: ${differing.slice(0, 10).join(', ')}`);
  },

  async I2(ctx, sides) {
    if (ctx.edits.length === 0) return ok('I2');
    const lost = lostEdits(ctx, await sides());
    return lost.length === 0 ? ok('I2') : bad('I2', `${lost.length} edits are not on both sides: ${lost.map((edit) => `${edit.side} ${edit.token}`).join(', ')}`);
  },

  async I3(ctx) {
    const git = await ctx.person();
    await git.run(['fetch', '--quiet', 'origin', ctx.names.trackedBranch]);
    // First parents only: commits that reached the branch through a sync merge are the merge's, not the branch's own.
    const lines = (await git.text(['rev-list', '--first-parent', '--parents', 'FETCH_HEAD'])).split('\n').filter(Boolean);
    const own = new Set(ctx.ownCommits);
    const foreign = lines
      .map((line) => line.split(' '))
      .filter(([commit, ...parents]) => parents.length > 0 && !own.has(commit as string) && parents.length < 2)
      .map(([commit]) => (commit as string).slice(0, 12));
    return foreign.length === 0 ? ok('I3') : bad('I3', `commits on the tracked branch that are neither the scenario's nor sync merges: ${foreign.join(', ')}`);
  },

  async I4(ctx) {
    const history = (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined) ?? [];
    const git = await ctx.person();
    const backwards: string[] = [];
    for (let index = 1; index < history.length; index += 1) {
      const before = history[index - 1] as Record<string, string>;
      const after = history[index] as Record<string, string>;
      for (const [ref, old] of Object.entries(before)) {
        const next = after[ref];
        if (next === undefined || next === old) continue;
        await git.run(['fetch', '--quiet', 'origin', old, next], { okCodes: [0, 1, 128] });
        const result = await git.run(['merge-base', '--is-ancestor', old, next], { okCodes: [0, 1, 128] });
        if (result.code !== 0) backwards.push(ref.replace(`${ctx.names.refPrefix}/`, '').replace(`refs/heads/${ctx.names.syncBranch}`, 'sync branch'));
      }
    }
    return backwards.length === 0 ? ok('I4') : bad('I4', `refs moved other than forward: ${[...new Set(backwards)].join(', ')}`);
  },

  async I5(ctx) {
    const hits = await canaryScan(ctx, { summariesOnly: false });
    return hits.length === 0 ? ok('I5') : bad('I5', `canary tokens found in: ${[...new Set(hits.map((hit) => hit.source))].join(', ')}`);
  },

  async I6(ctx) {
    const before = (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined)?.at(-1) ?? {};
    const world = ctx.live;
    const trackedBefore = world === null ? undefined : await trackedTip(ctx);
    const pullRequestsBefore = world === null ? 0 : (await world.rest.pullRequests(`t/${ctx.names.runId}/`)).length;
    const proxy = ctx.proxy;
    const mutationsBefore = proxy?.counts().mutations ?? 0;
    const { STEP_ACTIONS } = await import('./steps.ts');
    await (STEP_ACTIONS['run.sync'] as (c: RunContext, a: Record<string, unknown>) => Promise<void>)(ctx, {});
    const after = await snapshotRefs(ctx);
    const moved = Object.keys({ ...before, ...after }).filter((ref) => before[ref] !== after[ref]);
    const writes = (proxy?.counts().mutations ?? 0) - mutationsBefore;
    const trackedMoved = world !== null && (await trackedTip(ctx)) !== trackedBefore;
    const newPullRequests = world === null ? 0 : (await world.rest.pullRequests(`t/${ctx.names.runId}/`)).length - pullRequestsBefore;
    if (moved.length > 0 || writes > 0 || trackedMoved || newPullRequests > 0) {
      return bad('I6', `one more run with no changes wrote ${writes} mutations, moved ${moved.length} refs${trackedMoved ? ', moved the tracked branch' : ''} and opened ${newPullRequests} pull requests`);
    }
    return ok('I6');
  },

  async I7(ctx, sides) {
    const s = await sides();
    const readmes = new Map<string, string>();
    for (const path of s.files.keys()) if (/(^|\/)README\.md$/.test(path)) readmes.set(path, s.files.get(path) as string);
    const folders = annotatedFolders(readmes);
    const problems: string[] = [];
    for (const path of s.files.keys()) {
      const entry = s.ids.get(path);
      if (entry === undefined) {
        problems.push(`${path} has no id`);
        continue;
      }
      const document = s.documents.get(entry.id);
      const folder = owningFolder(path, folders);
      if (document === undefined) problems.push(`${path}: its id is not in Linear`);
      else if (folder !== null && document.title !== titleOf(path, folder.folder)) problems.push(`${path}: title differs from its path`);
    }
    for (const path of s.ids.keys()) if (!s.files.has(path)) problems.push(`${path} is mapped but not a synchronized file`);
    return problems.length === 0 ? ok('I7') : bad('I7', `${problems.length} problems: ${problems.slice(0, 10).join('; ')}`);
  },

  async I8(_ctx, sides) {
    const s = await sides();
    const seen = new Map<string, number>();
    for (const document of s.allDocuments) {
      if (document.trashed || document.archivedAt !== null) continue;
      const key = `${document.projectId ?? document.teamId}:${document.title}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([key]) => key.split(':').slice(1).join(':'));
    return duplicates.length === 0 ? ok('I8') : bad('I8', `duplicate titles: ${duplicates.slice(0, 10).join(', ')}`);
  },

  async I9(ctx) {
    const proxy = ctx.proxy;
    if (proxy === null) return ok('I9');
    const requests = proxy.requests.filter((record) => !record.injected).length;
    const written = proxy.requests.filter((record) => record.kind === 'mutation' && /document(Create|Update)|(Create|Update)Document/i.test(record.operation) && record.status === 200).length;
    const runs = ctx.engine.results.length;
    return budgetHolds(requests, written, runs)
      ? ok('I9')
      : bad('I9', `${requests} requests for ${written} written documents in ${runs} runs (limit ${1.5 * written + 5 * runs})`);
  },
};

/** Edits that are not on both sides (or, for a removal, still on a side). */
export function lostEdits(ctx: RunContext, sides: Pick<Sides, 'files' | 'documents'>): RunContext['edits'] {
  const gitText = [...sides.files.values()].join('\n');
  const linearText = [...sides.documents.values()].filter((document) => !document.trashed).map((document) => document.content ?? '').join('\n');
  return ctx.edits.filter((edit) => {
    const inGit = gitText.includes(edit.token);
    const inLinear = linearText.includes(edit.token);
    return edit.removal === true ? inGit || inLinear : !(inGit && inLinear);
  });
}

/** Canary tokens of the run's slice in run logs and summaries and, unless `summariesOnly`, in pull request texts and Linear comments. */
export async function canaryScan(ctx: RunContext, options: { summariesOnly: boolean }): Promise<CanaryHit[]> {
  const world = ctx.live;
  const canaries = new Set<string>();
  if (world !== null) {
    const sources = new Set(world.tree.paths.values());
    for (const file of world.manifest.files) if (file.canary !== null && sources.has(file.path)) canaries.add(file.canary);
  }
  const texts = new Map<string, string>();
  ctx.engine.results.forEach((result, index) => {
    texts.set(`run ${index} summary`, result.summary);
    if (options.summariesOnly) return;
    texts.set(`run ${index} stdout`, result.stdout);
    texts.set(`run ${index} stderr`, result.stderr);
  });
  if (world !== null && !options.summariesOnly) {
    for (const pr of await world.rest.pullRequests(`t/${ctx.names.runId}/`)) texts.set(`pull request #${pr.number}`, `${pr.title}\n${pr.body ?? ''}`);
    // Linear comments on the run's documents.
    for (const project of world.projects.values()) {
      const data = await world.app.request<{ documents: { nodes: Array<{ id: string; comments: { nodes: Array<{ body: string }> } }> } }>(
        'RunComments',
        'query',
        'query RunComments($projectId: ID!) { documents(first: 250, filter: { project: { id: { eq: $projectId } } }) { nodes { id comments(first: 50) { nodes { body } } } } }',
        { projectId: project.id },
      );
      for (const document of data.documents.nodes) texts.set(`comments on ${document.id}`, document.comments.nodes.map((comment) => comment.body).join('\n'));
    }
    for (const team of world.tree.teamZones.keys()) {
      const teamId = world.teams.get(team)?.id;
      if (teamId === undefined) continue;
      const data = await world.app.request<{ documents: { nodes: Array<{ id: string; project: { id: string } | null; comments: { nodes: Array<{ body: string }> } }> } }>(
        'RunTeamComments',
        'query',
        'query RunTeamComments($teamId: ID!, $prefix: String!) { documents(first: 250, filter: { team: { id: { eq: $teamId } }, title: { startsWith: $prefix } }) { nodes { id project { id } comments(first: 50) { nodes { body } } } } }',
        { teamId, prefix: ctx.names.teamZonePrefix },
      );
      for (const document of data.documents.nodes) {
        if (document.project === null) texts.set(`comments on ${document.id}`, document.comments.nodes.map((comment) => comment.body).join('\n'));
      }
    }
  }
  return scanCanaries(texts, canaries);
}

async function trackedTip(ctx: RunContext): Promise<string | undefined> {
  const world = ctx.live;
  if (world === null) return undefined;
  return (await world.sandbox.runRefs()).find((ref) => ref.ref === `refs/heads/${ctx.names.trackedBranch}`)?.oid;
}

/** The run's branches and state refs on the sandbox: ref → commit. */
export async function snapshotRefs(ctx: RunContext): Promise<Record<string, string>> {
  const world = ctx.live;
  if (world === null) return {};
  const refs = await world.sandbox.runRefs();
  return Object.fromEntries(refs.filter((ref) => ref.runId === ctx.names.runId && ref.ref !== `refs/heads/${ctx.names.trackedBranch}`).map((ref) => [ref.ref, ref.oid]));
}

// --- assertions --------------------------------------------------------------

// Assertion subjects resolve in subjects.ts: observed, from the engine's report, or computed by the harness.
export { resolveSubject };

export async function runChecks(ctx: RunContext): Promise<CheckOutcome[]> {
  // The scenario's own runs and requests end here; I6's extra run is the check's, not the scenario's.
  ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
  ctx.observations.set('scenario.proxyEnd', ctx.proxy?.requests.length ?? 0);
  let cached: Promise<Sides> | undefined;
  const sides = () => (cached ??= readSides(ctx));
  const outcomes: CheckOutcome[] = [];
  for (const id of INVARIANTS) {
    if (!ctx.scenario.checks.invariants[id].required) continue;
    try {
      outcomes.push(await INVARIANT_CHECKS[id](ctx, sides));
    } catch (error) {
      if (error instanceof ProductError) outcomes.push(bad(id, error.message));
      else throw error;
    }
  }
  // I6 ran the sync once more: assertions read the world as it is now.
  refreshView(ctx);
  for (const assertion of ctx.scenario.checks.assertions) {
    const actual = await resolveSubject(ctx, assertion.subject);
    if (!actual.known) throw new HarnessGapError(`assertion subject ${assertion.subject}`);
    let expected = assertion.expected;
    if (assertion.operator === 'same-as') {
      const other = await resolveSubject(ctx, String(assertion.expected));
      if (!other.known) throw new HarnessGapError(`assertion subject ${String(assertion.expected)}`);
      expected = other.value;
    }
    outcomes.push(compare(assertion.operator, actual.value, expected) ? ok(assertion.subject) : bad(assertion.subject, `${assertion.operator} did not hold`));
  }
  return outcomes;
}
