// Runs scenarios: for each, a run id and its own names, setup to the spec's
// starting state, the steps, the checks, and cleanup in a `finally` step.
// Workers run scenarios in parallel; the governor admits each one.

import { collectCanaryEvidence } from './checks.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { LinearClient, type LinearDocument } from '../../../src/linear/index.ts';
import { parse, visit } from '../../../src/format/markdown.ts';
import { contentTypeOf, destinations, resolveTarget } from '../../../src/initial-sync/uploads.ts';
import { isRegularFile, MARKDOWN_EXTENSION } from '../../../src/mapping/index.ts';
import { Git, lfsReader, listTree, parseLfsPointer, readBlobs, readIds, type LfsRead } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { REF_MOVES, runChecks, snapshotRefs, recordRefs, startRefHistory, bodyOf, titleOf } from './checks.ts';
import type { LinearApp, TestConfig } from './config.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { annotatedFolders, CORPUS_DIR, inheritedTeam, owningFolder, readAnnotation, type Manifest, type RunTree } from './corpus.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { runScheduled } from './schedule.ts';
import { BudgetBlockedError, budgetFromStatus, estimate, MAX_ADMISSION, type Governor } from './governor.ts';
import { SandboxRest, githubToken, type GitHubToken } from './github.ts';
import { newRunId, runNames, runOfTeamTitle, type RunNames } from './isolation.ts';
import { answerSizes, engineRequestCount, requestBuckets, remoteRequests, isGraphql } from './request-accounting.ts';
import { withAppRequests } from './app-reads.ts';
import { LinearWorld, editorClient, type Project, type Team } from './linear-world.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { OwnershipLedger, readOwnership, type WriteObserver } from './ownership.ts';
import { retryGitHubCleanup } from './cleanup-retry.ts';
import { blockedBySetupStop, classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import { finishPersonClone } from './person-git.ts';
import { assertCurrentCorpus } from './corpus-drift.ts';
import { CorpusMissingError, hookEnv, installHooks, Sandbox } from './sandbox.ts';
import { provisionHookNpm } from './hook-npm.ts';
import { PRE_COMMIT_CONFIG } from '../../../src/setup/hooks.ts';
import { levelOf, type Scenario } from './spec.ts';
import { requiredActionSha, RUN_REFS, runStep, settleFollowUpRuns } from './steps.ts';
import { openSetupConflict, prepareFixtures, publishesCheckWorkflow, UNSAFE_TITLES, type FixtureTools } from './fixtures.ts';
import { projectFolders } from './step-helpers.ts';
import { BEFORE_VIEW, takeStartView, encodeTitlePath } from './subjects.ts';
import { renderUiChecklist } from './ui-checklist.ts';
import { cleanupKilledTokens } from './token-cleanup.ts';
import { heldRunOf, saveHeldRun, UI_CHECKLIST_FILE } from './held-run.ts';

export const TEAM_LOCK_TIMEOUT_MS = 90 * 60_000;
/** A team zone holds about this many documents, trashed ones included (measured 2026-11-09: QUOTA_EXCEEDED at 1,000 trashed). */
export const ZONE_CAP = 1_000;
/** The harness warns from here on. */
export const ZONE_TRASH_WARNING = 900;
/** Default setup deadline. A wait for a team zone that another live run holds does not count: it has its own bound. */
export const SETUP_TIMEOUT_MS = 15 * 60_000;
/** Full setup can include initial sync of thousands of documents. */
export function setupTimeoutMs(slice: Scenario['slice']): number {
  return slice === 'full' ? 45 * 60_000 : SETUP_TIMEOUT_MS;
}
/** How long a setup past its deadline gets to stop before cleanup runs anyway. */
export const SETUP_STOP_MS = 2 * 60_000;

/** Census must succeed and leave room for every planned team-zone document. */
export async function requireZoneCapacity(world: Pick<LinearWorld, 'zoneUsage'>, teamId: string, planned: number): Promise<{ active: number; trashed: number }> {
  let usage;
  try { usage = await world.zoneUsage(teamId); }
  catch { throw new EnvBlockedError('document capacity census unavailable'); }
  if (!Number.isInteger(planned) || planned < 0 || !Number.isInteger(usage.active) || usage.active < 0 || !Number.isInteger(usage.trashed) || usage.trashed < 0) throw new EnvBlockedError('document capacity census invalid');
  if (usage.active + usage.trashed + planned > ZONE_CAP) throw new EnvBlockedError(`document capacity insufficient (active ${usage.active}, trash ${usage.trashed}, planned at most ${planned}, cap ${ZONE_CAP})`);
  return usage;
}

/** Whether `work` settles (either way) within `ms`. */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects with `onTimeout()` when `work` has not settled in time. The work itself goes on unobserved. */
export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Setup's deadline. Time spent waiting for a team zone that another live run
 * holds is given back (`credit`): that wait has its own bound, and a run that
 * waits its turn is not stuck. Everything else counts, a stalled request
 * during such a wait too, since only a wait that ended is given back.
 */
export class SetupDeadline {
  #left: number;
  #since = 0;
  #timer: NodeJS.Timeout | undefined;
  #expire: (() => void) | undefined;
  #credited = 0;
  readonly #now: () => number;

  constructor(ms: number, now: () => number = () => performance.now()) {
    this.#left = ms;
    this.#now = now;
  }

  /** How long, in milliseconds, waits for held zones took that the deadline did not count. */
  get creditedMs(): number {
    return this.#credited;
  }

  /** Rejects with `onTimeout()` when `work` has not settled before the deadline. The work itself goes on unobserved. */
  async race<T>(work: Promise<T>, onTimeout: () => Error): Promise<T> {
    const deadline = new Promise<never>((_, reject) => {
      this.#expire = () => reject(onTimeout());
    });
    this.#start();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      this.#stop();
      this.#expire = undefined;
    }
  }

  /** Gives back `ms` that setup spent waiting for a team zone another live run holds. */
  credit(ms: number): void {
    if (!(ms > 0)) return;
    this.#credited += ms;
    if (this.#timer === undefined) return;
    this.#stop();
    this.#left += ms;
    this.#start();
  }

  #start(): void {
    if (this.#expire === undefined || this.#timer !== undefined) return;
    this.#since = this.#now();
    this.#timer = setTimeout(this.#expire, Math.max(0, this.#left));
  }

  #stop(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#left -= this.#now() - this.#since;
  }
}
/** How long a run that reached its UI steps keeps its resources. */
export const UI_HOLD_MS = 2 * 3_600_000;

export interface RunnerDeps {
  config: TestConfig;
  /** Optional partial-corpus team selection; never a full catalog result. */
  teams?: readonly string[];
  governor: Governor | null;
  /** The harness's own Linear client per app (as the app), for reads and budget. */
  appClients: Map<string, LinearClient>;
  stateDir: string;
  outDir: string;
  expectedRed: ReadonlySet<string>;
  log: (line: string) => void;
}

function appFor(deps: Pick<RunnerDeps, 'config'>, name: string): LinearApp {
  const app = deps.config.linearApps.find((candidate) => candidate.name === name);
  if (app === undefined) throw new Error(`unknown app ${name}`);
  return app;
}

/** The team of each project placeholder: the project folder's own team, else the nearest team above it. */
function projectTeams(readmes: ReadonlyMap<string, string>): Map<string, string> {
  const folders = annotatedFolders(readmes);
  const teams = new Map<string, string>();
  for (const folder of folders) {
    if (folder.project === null) continue;
    const team = inheritedTeam(folder.folder, folders);
    if (team !== null) teams.set(folder.project, team);
  }
  return teams;
}

/**
 * The clients and handles of a live run around its sandbox and run tree:
 * a new run's (no projects yet) or a held run's, made again in a later
 * process. Reads the workspace's teams and its document URL prefix unless
 * they are known (a held run saved them).
 */
export async function liveWorld(
  deps: Pick<RunnerDeps, 'config' | 'appClients' | 'teams'>,
  appName: string,
  parts: {
    sandbox: Sandbox;
    token: GitHubToken;
    manifest: Manifest;
    tree: RunTree;
    known?: { teams: Map<string, Team>; documentUrlBase: string };
    /** The run's ownership record: sees every write of the editors' clients. */
    owned?: WriteObserver;
  },
): Promise<LiveWorld> {
  const { config } = deps;
  const app = appFor(deps, appName);
  const appClient = deps.appClients.get(appName);
  if (appClient === undefined) throw new Error(`no harness client for app ${appName}`);
  const editors = {
    'editor-a': editorClient(config.editors['editor-a'], undefined, parts.owned),
    'editor-b': editorClient(config.editors['editor-b'], undefined, parts.owned),
  };
  const world = new LinearWorld(editors['editor-a']);
  const teams = parts.known?.teams ?? new Map((await world.teams()).filter((team) => deps.teams === undefined || deps.teams.includes(team.key)).map((team) => [team.key, team]));
  // Links between synchronized documents are written as document URLs of this workspace.
  const documentUrlBase = parts.known?.documentUrlBase
    ?? `https://linear.app/${(await appClient.request<{ organization: { urlKey: string } }>('Organization', 'query', 'query Organization { organization { urlKey } }')).organization.urlKey}/document`;
  return {
    sandbox: parts.sandbox,
    rest: new SandboxRest(config, parts.token.getToken ?? parts.token.token),
    ...(parts.token.getToken === undefined ? {} : { getGithubToken: parts.token.getToken }),
    githubToken: parts.token.token,
    githubTokenSource: parts.token.source,
    ...(parts.token.appLogin === undefined ? {} : { githubAppLogin: parts.token.appLogin }),
    ...(parts.token.appClientId === undefined ? {} : { githubAppClientId: parts.token.appClientId }),
    repository: `${config.owner}/${config.repo}`,
    manifest: parts.manifest,
    tree: parts.tree,
    projects: new Map(),
    teams,
    app: appClient,
    editors,
    world,
    engineApp: { clientId: app.clientId, clientSecret: app.clientSecret },
    seededDocuments: [],
    documentUrlBase,
    async download(url) {
      // Personal API keys go in the Authorization header as they are.
      const response = await fetch(url, { headers: { authorization: config.editors['editor-a'] } });
      if (!response.ok) throw new ProductError(`an upload URL answered HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/** Identity is stable across API-key rotation; credentials never become ledger keys. */
export async function claimEditorBudgets(ctx: RunContext, grant: Awaited<ReturnType<Governor['admit']>> | undefined, maxWaitMs?: number): Promise<void> {
  if (grant?.claimBudgets === undefined || ctx.live === null) return;
  const estimated = estimate(ctx.scenario);
  const need = { requests: Math.min(estimated.requests, MAX_ADMISSION.requests), complexity: Math.min(estimated.complexity, MAX_ADMISSION.complexity) };
  const accounts = new Map<string, import('./shared-state.ts').AccountBudget>();
  for (const client of Object.values(ctx.live.editors)) {
    const identity = await client.request<{ viewer: { id: string } }>('EditorIdentity', 'query', 'query EditorIdentity { viewer { id } }');
    if (typeof identity.viewer?.id !== 'string' || identity.viewer.id === '') throw new EnvBlockedError('editor identity unavailable for shared budget');
    const key = `editor-${createHash('sha256').update(identity.viewer.id).digest('hex')}`;
    // The estimate covers the whole scenario: aliases of one actor must
    // reserve it once, including scenarios spanning several quota windows.
    accounts.set(key, { key, need, readBudget: async () => budgetFromStatus(await client.rateLimitStatus(), Date.now()) });
  }
  try {
    await grant.claimBudgets([...accounts.values()], ctx.signal, maxWaitMs);
  } catch (blocked) {
    if (blocked instanceof BudgetBlockedError) throw new EnvBlockedError(blocked.message);
    throw blocked;
  }
}

/**
 * Every team the run's slice annotates, as team lock keys and as team ids: one set for the run's team locks, its
 * shared zone claim and the scope of its ownership record. A team zone whose only file is its own README is not in
 * `tree.teamZones`, yet the engine syncs that README into the zone, so the set is every annotated team, not only
 * the zones the run places files below.
 */
export function runTeamZones(tree: Pick<RunTree, 'teams'>, teams: ReadonlyMap<string, Pick<Team, 'id'>>): { ids: string[]; lockKeys: string[] } {
  const lockKeys = [...tree.teams];
  const ids = lockKeys.map((key) => {
    const team = teams.get(key);
    if (team === undefined) throw new EnvBlockedError(`the test workspace has no team ${key}`);
    return team.id;
  });
  return { ids, lockKeys };
}

/**
 * A live run needs the whole test configuration before it touches anything shared: the shared admission
 * lives on the sandbox repository, so without its URL it would ask GitHub for a repository with no owner or name.
 */
export function requireLiveConfig(config: TestConfig): void {
  if (config.missing.length > 0) throw new EnvBlockedError(`test configuration is missing: ${config.missing.join(', ')}`);
}

async function setupLive(ctx: RunContext, deps: RunnerDeps, appName: string, locks: Lock[], deadline: SetupDeadline, grant?: Awaited<ReturnType<Governor['admit']>>): Promise<void> {
  const { config } = deps;
  let token;
  try {
    ctx.phase('github token');
    token = await githubToken(config, ctx.scenario.mode === 'actions' ? 'actions' : 'local');
  } catch (error) {
    throw new EnvBlockedError(`GitHub token: ${(error as Error).message}`);
  }
  const sandbox = new Sandbox({ url: config.gitUrl, token: token.token, ...(token.getToken === undefined ? {} : { getToken: token.getToken }), stateDir: deps.stateDir, runId: ctx.names.runId });
  ctx.sandbox = sandbox;
  ctx.phase('sandbox cache');
  await sandbox.refreshCache();
  let manifest: Manifest;
  let created;
  try {
    ctx.phase('corpus manifest');
    manifest = await sandbox.manifest();
    ctx.phase('tracked branch');
    ctx.remoteWritesStarted = true;
    created = await sandbox.createTrackedBranch(ctx.scenario.slice, ctx.names, {
      validate: (selected) => assertCurrentCorpus(manifest, selected, (path) => sandbox.readMain(`corpus/${path}`), deps.teams),
      checks: publishesCheckWorkflow(ctx.scenario),
      ...(ctx.scenario.steps.some((step) => step.kind === 'run' && step.action === 'soak') ? { soak: manifest } : {}),
      ...(deps.teams === undefined ? {} : { teams: deps.teams }),
    });
  } catch (error) {
    if (error instanceof CorpusMissingError) throw new EnvBlockedError(`corpus: ${error.message}`);
    throw error;
  }
  const { tree, commit } = created;
  ctx.ownCommits.push(commit);
  ctx.phase('linear teams');
  const live = await liveWorld(deps, appName, { sandbox, token, manifest, tree, owned: ctx.owned });
  const { teams, world } = live;
  ctx.live = live;
  // The team zones the run may write in, on record before anything is created there.
  const zones = runTeamZones(tree, teams);
  ctx.owned.scope(zones.ids);

  // Setup ends after SETUP_TIMEOUT_MS: a key that frees up later is reported now, with its reason.
  ctx.phase('editor budget');
  await claimEditorBudgets(ctx, grant, SETUP_TIMEOUT_MS);

  // The team lock: initial sync matches every document of an annotated team zone, a README-only zone included.
  ctx.phase('team lock');
  await takeTeamZones(ctx, deps.stateDir, grant, zones, locks, deadline);

  const readmes = new Map<string, string>();
  for (const [target, source] of tree.paths) {
    if (/(^|\/)README\.md$/.test(source)) readmes.set(source, tree.rewritten.get(target) ?? (await sandbox.readMain(`corpus/${source}`)) ?? '');
  }
  // Census is required before writes while all selected zones are leased.
  const trash: Record<string, { before: number; after?: number }> = {};
  const synced = new Set(manifest.files.filter((file) => file.synced && file.class !== 'lint-error').map((file) => file.path));
  const folders = annotatedFolders(readmes);
  const additions = ctx.scenario.steps.reduce((count, step) => count + (['git.add', 'git.copy', 'linear.create'].includes(`${step.kind}.${step.action}`) ? 1 : 0), 0);
  ctx.observations.set('zone.trash', trash);
  for (const key of tree.teams) {
    const planned = [...tree.paths].filter(([target, source]) => {
      const folder = owningFolder(target, folders);
      return synced.has(source) && folder?.team === key && folder.project === null;
    }).length + additions;
    const team = teams.get(key)!;
    let usage;
    try { usage = await requireZoneCapacity(world, team.id, planned); }
    catch (error) { throw new EnvBlockedError(`team ${key}: ${(error as Error).message}`); }
    trash[key] = { before: usage.trashed };
    if (usage.trashed >= ZONE_TRASH_WARNING) ctx.log(`warning: team ${key}'s zone is near its trash cap`);
  }

  ctx.phase('projects');
  const teamOf = projectTeams(readmes);
  for (const [placeholder, name] of tree.projects) {
    const key = teamOf.get(name) ?? teamOf.get(placeholder);
    const team = key === undefined ? undefined : teams.get(key);
    if (team === undefined) throw new EnvBlockedError(`the test workspace has no team for project placeholder ${placeholder}`);
    const project: Project = await world.createProject(name, [team.id]);
    live.projects.set(placeholder, project);
  }

  ctx.phase('setup state');
  await setupState(ctx, live, { runStep });
}

/**
 * The setup's state on a world whose tracked branch and projects exist: the
 * fixtures, the initial sync and the setup conflict, as the scenario's
 * `setup.state` asks. `tools.runStep` runs each step; the offline specs pass
 * one that runs the engine in process.
 */
export async function setupState(ctx: RunContext, live: LiveWorld, tools: FixtureTools): Promise<void> {
  const state = ctx.scenario.setup.state;
  await prepareFixtures(ctx, live, 'beforeSync', tools);
  if (state === 'linear-seeded') await seedLinear(ctx, live);
  if (state === 'converged' || state === 'conflicted') {
    await tools.runStep(ctx, { kind: 'run', action: 'initial-sync', args: { direction: 'git-to-linear', confirm: true } });
    await prepareFixtures(ctx, live, 'afterSync', tools);
  }
  if (state === 'conflicted') await openSetupConflict(ctx, tools);
  await endSetup(ctx, live);
}

/** The scenario's own edits and runs start here: setup's edits and runs are not the scenario's. */
async function endSetup(ctx: RunContext, live: LiveWorld): Promise<void> {
  ctx.engine.setupRuns = ctx.engine.results.length;
  for (const key of [...ctx.observations.keys()]) if (/^(target\.|edited\.|runs\.|harness\.runs\.|harness\.quiet\.|harness\.untouched\.|harness\.refs\.|harness\.runView\.)/.test(key)) ctx.observations.delete(key);
  await recordStart(ctx, live);
}

/** What the subjects compare against: the world when setup ended. */
export async function recordStart(ctx: RunContext, live: LiveWorld): Promise<void> {
  ctx.observations.set('start.time', Date.now());
  ctx.observations.set('start.proxyIndex', ctx.proxy?.requests.length ?? 0);
  ctx.observations.set('start.refs', await snapshotRefs(ctx));
  ctx.observations.set('start.trackedTip', (await live.sandbox.runRefs()).find((ref) => ref.ref === `refs/heads/${ctx.names.trackedBranch}`)?.oid);
  ctx.observations.set('start.pullRequests', (await live.rest.pullRequests(ctx.names.syncBranch)).map((pr) => pr.number));
  ctx.observations.set(BEFORE_VIEW, await takeStartView(ctx));
}

/** Documents in Linear whose titles are the slice's paths, as editor-a: the start of Linear → git scenarios. */
async function seedLinear(ctx: RunContext, live: LiveWorld): Promise<void> {
  const readmes = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const [target, source] of live.tree.paths) {
    if (!target.endsWith('.md')) continue;
    const text = live.tree.rewritten.get(target) ?? (await live.sandbox.readMain(`corpus/${source}`)) ?? '';
    texts.set(target, text);
    if (/(^|\/)README\.md$/.test(target)) readmes.set(target, text);
  }
  const folders = annotatedFolders(readmes);
  const synced = new Set(live.manifest.files.filter((file) => file.synced && file.class !== 'lint-error').map((file) => file.path));
  const seededPaths = new Map<string, string>();
  const images = trackedImageUploads(ctx, live);
  for (const [target, source] of live.tree.paths) {
    if (!synced.has(source) || !target.endsWith('.md')) continue;
    const folder = owningFolder(target, folders);
    if (folder === null) continue;
    // A team zone's own README would be titled "README" without the run's prefix, shared by every run.
    if (folder.project === null && target === `${folder.folder}/README.md`) continue;
    const project = folder.project === null ? undefined : [...live.projects.values()].find((p) => p.name === folder.project);
    const team = folder.team === null ? undefined : live.teams.get(folder.team);
    const place = project !== undefined ? { projectId: project.id } : team !== undefined ? { teamId: team.id } : null;
    if (place === null) continue;
    const content = await uploadImages(target, bodyOf(texts.get(target) ?? ''), images);
    const document = await live.editors['editor-a'].createDocument(place, { id: randomUUID(), title: titleOf(target, folder.folder), content });
    live.seededDocuments.push(document.id);
    seededPaths.set(target, document.id);
  }
  ctx.observations.set('setup.seededPaths', seededPaths);
  for (const fixture of ctx.scenario.setup.fixtures) await FIXTURE_PREPARATION[fixture]?.(ctx, live);
  ctx.observations.set('setup.seeded', [...live.seededDocuments]);
}

/** Uploads a tracked file once, by its path, and gives its upload URL; null for a path that is not a tracked file. */
type ImageUploads = (path: string) => Promise<string | null>;

/**
 * A synchronized document in Linear holds its images as uploads of the
 * workspace, as a pasted image or the sync's own write makes them; a relative
 * path there is an image Linear cannot show, and the capture blocks the
 * document. The seeded documents therefore embed each tracked image as an
 * upload of the tracked file's own bytes, so the initial sync from Linear
 * maps it back to that file. The tracked tree is read on the first image.
 */
function trackedImageUploads(ctx: RunContext, live: LiveWorld): ImageUploads {
  let tracked: Promise<{ git: Git; files: Map<string, string> }> | undefined;
  const read = async () => {
    const git = await ctx.person();
    const tip = (await git.text(['rev-parse', 'HEAD'])).trim();
    // Files as the initial sync sees them: regular files that are not documents.
    const files = new Map((await listTree(git, tip)).filter((entry) => isRegularFile(entry) && !entry.path.endsWith(MARKDOWN_EXTENSION)).map((entry) => [entry.path, entry.oid]));
    return { git, files };
  };
  const urls = new Map<string, Promise<string>>();
  let readLfs: LfsRead | undefined;
  const upload = async (git: Git, path: string, oid: string): Promise<string> => {
    const blob = (await readBlobs(git, [oid])).get(oid) as Buffer;
    const pointer = parseLfsPointer(blob);
    let bytes = blob;
    if (pointer !== null) {
      readLfs ??= await lfsReader(git, 'origin');
      const lfs = await readLfs(pointer, path);
      if (!lfs.ok) throw new EnvBlockedError(`the seeded image ${path} cannot be read from LFS: ${lfs.reason}`);
      bytes = lfs.content;
    }
    const uploaded = await live.editors['editor-a'].uploadFile({ filename: posix.basename(path), contentType: contentTypeOf(path), bytes: new Uint8Array(bytes) });
    return uploaded.assetUrl;
  };
  return async (path) => {
    tracked ??= read();
    const { git, files } = await tracked;
    const oid = files.get(path);
    if (oid === undefined) return null;
    if (!urls.has(path)) urls.set(path, upload(git, path, oid));
    return urls.get(path) as Promise<string>;
  };
}

/**
 * `body` with each image that names a tracked file pointing at that file's
 * upload instead: inline images, and the definitions reference-style images
 * use. Links stay as they are; only images must be uploads.
 */
async function uploadImages(documentPath: string, body: string, images: ImageUploads): Promise<string> {
  const referenced = new Set<string>();
  visit(parse(body), (node) => {
    if (node.type === 'imageReference') referenced.add(node.identifier);
  });
  let result = '';
  let at = 0;
  for (const { node, range } of destinations(body)) {
    if (node.type !== 'image' && !(node.type === 'definition' && referenced.has(node.identifier))) continue;
    const target = resolveTarget(documentPath, node.url);
    const url = target === null ? null : await images(target);
    if (url === null) continue;
    const cut = node.url.search(/[?#]/);
    result += `${body.slice(at, range.from)}${url}${cut === -1 ? '' : node.url.slice(cut)}`;
    at = range.to;
  }
  return result + body.slice(at);
}

/** A 1×1 PNG, for an image that exists only in Linear. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');

export { UNSAFE_TITLES };

/**
 * Setup beyond seeding that some fixtures of Linear-first scenarios need.
 * Fixtures not listed here select content of the slice and need no setup.
 */
export const FIXTURE_PREPARATION: Record<string, (ctx: RunContext, live: LiveWorld) => Promise<void>> = {
  // L1-14: matched documents with comments, an archived one and one only in Linear.
  async 'matching-commented-archived-linear-only'(ctx, live) {
    const editor = live.editors['editor-a'];
    const [first] = await editor.getDocuments(live.seededDocuments.slice(0, 1));
    if (first?.documentContentId) await editor.commentOnDocument(first.documentContentId, 'Please check the dates before Friday.');
    const project = [...live.projects.values()][0];
    if (project === undefined || first === undefined) throw new EnvBlockedError('the slice maps no project to seed');
    const only = await editor.createDocument({ projectId: project.id }, { id: randomUUID(), title: `notes/only-in-linear-${ctx.names.runId}`, content: 'Kept only here for now.\n' });
    live.seededDocuments.push(only.id);
    ctx.observations.set('setup.linearOnlyDocument', only.id);
    // Linear archives documents only with their project: a helper project holds
    // a document with a matched title and is deleted, which archives it.
    const team = [...live.teams.values()][0];
    if (team !== undefined) {
      const helper = await live.world.createProject(ctx.names.helperProject('archived-copy'), [team.id]);
      const archived = await editor.createDocument({ projectId: helper.id }, { id: randomUUID(), title: first.title, content: 'An older copy.\n' });
      await live.world.deleteProject(helper, ctx.names.runId);
      ctx.observations.set('setup.archivedDocument', archived.id);
    }
  },
  // L1R-04: images and attachments that exist only in Linear.
  async 'reverse-assets'(ctx, live) {
    const editor = live.editors['editor-a'];
    const project = [...live.projects.values()][0];
    if (project === undefined) throw new EnvBlockedError('the slice maps no project to seed');
    const upload = await editor.uploadFile({ filename: 'diagram.png', contentType: 'image/png', bytes: new Uint8Array(TINY_PNG) });
    const document = await editor.createDocument({ projectId: project.id }, { id: randomUUID(), title: `guides/diagram-${ctx.names.runId}`, content: `The flow at a glance.\n\n![diagram](${upload.assetUrl})\n` });
    live.seededDocuments.push(document.id);
    // The bytes the pull request must hold, hashed here from what was uploaded.
    const folder = projectFolders(ctx).find((candidate) => candidate.project === project.name)?.folder;
    if (folder === undefined) throw new EnvBlockedError('the image fixture project has no mapped folder');
    const documentPath = `${folder === '' ? '' : `${folder}/`}${encodeTitlePath(document.title)}.md`;
    const sha256 = createHash('sha256').update(TINY_PNG).digest('hex');
    ctx.observations.set('linear.assets', [{ documentPath, path: `${documentPath.slice(0, documentPath.lastIndexOf('/') + 1)}${sha256}.png`, sha256, bytes: TINY_PNG }]);
  },
  // L1R-05: titles with characters a file name cannot hold as they are.
  async 'unsafe-titles'(_ctx, live) {
    const editor = live.editors['editor-a'];
    const project = [...live.projects.values()][0];
    if (project === undefined) throw new EnvBlockedError('the slice maps no project to seed');
    for (const title of UNSAFE_TITLES) {
      const document = await editor.createDocument({ projectId: project.id }, { id: randomUUID(), title, content: 'Short note.\n' });
      live.seededDocuments.push(document.id);
    }
  },
};

/** Document ids in the run's ids state ref, or none when the engine recorded nothing. */
async function recordedIds(ctx: RunContext): Promise<string[]> {
  const sandbox = ctx.sandbox;
  if (sandbox === undefined) return [];
  const ref = `${ctx.names.refPrefix}/ids`;
  if (!(await retryGitHubCleanup(() => sandbox.runRefs())).some((entry) => entry.ref === ref)) return [];
  const git = await ctx.person();
  await retryGitHubCleanup(() => git.run(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${ref}:${ref}`]));
  const ids = await readIds(git, (await git.text(['rev-parse', ref])).trim());
  return [...ids.values()].map((entry) => entry.id);
}

/** Preserve a killed engine's diagnostics before the remote fixtures disappear. */
export async function retainPendingOutput(ctx: Pick<RunContext, 'engine' | 'observations' | 'checkpoints'>): Promise<void> {
  if (ctx.engine.pending === undefined) return;
  ctx.engine.pending.kill();
  try {
    ctx.engine.results.push(await withDeadline(ctx.engine.pending.done, 35_000, () => new Error('pending engine did not stop')));
  } catch {
    ctx.observations.set('canary.pendingIncomplete', true);
  } finally {
    delete ctx.engine.pending;
    ctx.checkpoints.resumeAll();
  }
}

/**
 * Closes a run's pull requests and deletes its refs on the sandbox, and
 * reports a problem unless both then read back gone: no run pull request
 * reads open and no run ref is left. Pull requests go first, while their head
 * branches exist; a head branch a step already deleted makes GitHub close its
 * pull request itself, and that close counts. Safe to repeat.
 */
export async function removeRunRefsAndPullRequests(
  runId: string,
  sandbox: Pick<Sandbox, 'runRefs' | 'deleteRunRefs'> | undefined,
  rest: Pick<SandboxRest, 'closeOpenPullRequests'> | undefined,
): Promise<string[]> {
  const problems: string[] = [];
  if (rest !== undefined) {
    try {
      await rest.closeOpenPullRequests(`t/${runId}/`);
    } catch (error) {
      problems.push(`pull requests: ${(error as Error).message}`);
    }
  }
  if (sandbox !== undefined) {
    try {
      const ofRun = async () => (await retryGitHubCleanup(() => sandbox.runRefs())).filter((ref) => ref.runId === runId).map((ref) => ref.ref);
      await sandbox.deleteRunRefs(runId, await ofRun());
      const left = await ofRun();
      if (left.length > 0) problems.push(`refs: still on the sandbox: ${left.join(', ')}`);
    } catch (error) {
      problems.push(`refs: ${(error as Error).message}`);
    }
  }
  return problems;
}

async function cleanup(ctx: RunContext): Promise<{ ok: boolean; detail?: string }> {
  if (ctx.observations.get('workflows.unstopped') === true) return { ok: false, detail: 'scheduled writer stop is unconfirmed; retain resources and shared reservation for verified recovery' };
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`);
    }
  };
  if (ctx.engine.pending !== undefined) {
    ctx.engine.pending.kill();
    await ctx.engine.pending.done;
    delete ctx.engine.pending;
  }
  ctx.checkpoints.resumeAll();
  const proxy = ctx.proxy;
  if (ctx.signal.aborted && proxy !== null) {
    await attempt('setup tokens', async () => {
      // The engine revoked its own tokens through the proxy; another revocation of one would be refused.
      await cleanupKilledTokens(proxy.unrevokedTokens(), {
        cwd: ctx.runDir,
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], LANG: 'C.UTF-8' },
        linearUrl: proxy.url,
      });
    });
  }
  // Every document the run made, by id: what the harness seeded, what the run's ownership record holds (every
  // create, a team zone's README and a create whose answer was lost included) and what the engine recorded.
  // Read the ids before the refs go.
  const owned = readOwnership(ctx.owned.stateDir, ctx.names.runId);
  if (ctx.live === null && ctx.remoteWritesStarted === false && owned !== null
    && owned.teamIds.size === 0 && owned.projects.size === 0 && owned.documents.size === 0) {
    return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
  }
  const created = new Set([...(ctx.live?.seededDocuments ?? []), ...(owned?.documents.keys() ?? [])]);
  if (ctx.live !== null) {
    await attempt('ids', async () => {
      for (const id of await recordedIds(ctx)) created.add(id);
    });
  }
  const live = ctx.live;
  problems.push(...(await removeRunRefsAndPullRequests(ctx.names.runId, ctx.sandbox, live?.rest)));
  if (live !== null) {
    for (const project of live.projects.values()) {
      await attempt(`project ${project.name}`, () => live.world.deleteProject(project, ctx.names.runId));
    }
    // Project documents went with their projects. Team-zone documents the run made (by id: seeded or recorded;
    // by title: the run's prefix) are archived through a run project of their team, never trashed: trashed
    // documents count against a team zone's cap and cannot be purged.
    // Reads go through the harness's own editor client, not the app whose budget the scenarios share.
    const zone = new Map<string, LinearDocument>();
    await attempt('team-zone documents by id', async () => {
      for (const document of await live.world.client.getDocuments([...created])) if (document.projectId === null) zone.set(document.id, document);
    });
    for (const team of live.tree.teamZones.keys()) {
      const teamId = live.teams.get(team)?.id;
      if (teamId === undefined) continue;
      // This run's own documents, trashed ones included: archiving them takes them out of the zone's trash.
      await attempt(`team ${team} documents`, async () => {
        for (const document of await live.world.runTeamDocuments(teamId, { trashed: true })) if (document.runId === ctx.names.runId) zone.set(document.id, document);
      });
    }
    await attempt('archiving team-zone documents', () => live.world.archiveRunTeamDocuments([...zone.values()], ctx.names.runId, ctx.names.helperProject('archive'), (document) => created.has(document.id) || runOfTeamTitle(document.title) === ctx.names.runId));
  }
  return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
}

/** Runs one scenario and counts the harness's own requests through the app while it runs. */
export async function runScenario(scenario: Scenario, deps: RunnerDeps, runId: string = newRunId()): Promise<ScenarioResult> {
  const { result, requests } = await withAppRequests(() => runScenarioCounted(scenario, deps, runId));
  return { ...result, harnessAppRequests: requests };
}

/**
 * The sandbox's corpus for an offline scenario: the shared cache of its main
 * branch, brought up to date. Nothing is pushed and Linear is not involved.
 */
async function corpusReader(deps: Pick<RunnerDeps, 'config' | 'stateDir'>, runId: string): Promise<Sandbox> {
  const { config } = deps;
  if (config.gitUrl === '') throw new EnvBlockedError('the corpus is on the sandbox repository, and none is configured (MDBISYNC_TEST_SANDBOX_URL)');
  let token;
  try {
    token = await githubToken(config, 'local');
  } catch (error) {
    throw new EnvBlockedError(`GitHub token: ${(error as Error).message}`);
  }
  const sandbox = new Sandbox({ url: config.gitUrl, token: token.token, ...(token.getToken === undefined ? {} : { getToken: token.getToken }), stateDir: deps.stateDir, runId });
  try {
    await sandbox.refreshCache();
  } catch (error) {
    throw new EnvBlockedError(`the sandbox's corpus could not be read: ${(error as Error).message}`);
  }
  return sandbox;
}

/** A scenario run's context, before setup: no live world, no proxy, nothing recorded. */
export function createRunContext(
  scenario: Scenario,
  runId: string,
  runDir: string,
  deps: Pick<RunnerDeps, 'config' | 'stateDir' | 'outDir' | 'log'>,
): { ctx: RunContext; logLines: string[]; phase(): string; abort: AbortController } {
  const names: RunNames = runNames(runId);
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    deps.log(`${scenario.id} ${runId}: ${line}`);
  };
  let person: Git | undefined;
  let hooksInstalled = false;
  let engineDir: string | undefined;
  let corpus: Promise<Sandbox> | undefined;
  let phase = 'admission';
  // Set when setup missed its deadline: setup stops at its next phase or lock wait, and creates nothing more.
  const abort = new AbortController();
  const ctx: RunContext = {
    signal: abort.signal,
    phase(next: string) {
      abort.signal.throwIfAborted();
      phase = next;
      log(`setup: ${next}`);
    },
    scenario,
    names,
    runDir,
    live: null,
    remoteWritesStarted: false,
    proxy: null,
    owned: new OwnershipLedger(deps.stateDir, runId),
    checkpoints: new CheckpointControl(join(runDir, 'hooks')),
    engine: { results: [], setupRuns: 0, env: {}, restores: [] },
    edits: [],
    ownCommits: [],
    observations: new Map([['canary.evidenceRoot', deps.outDir]]),
    uiSteps: 0,
    sequence: 0,
    log,
    async person() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      person ??= await ctx.live.sandbox.clone(names, join(runDir, 'person'));
      return person;
    },
    async personHooks() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      if (hooksInstalled) return;
      // No sandbox credentials: npm runs while the public hooks install.
      await installHooks(await ctx.person(), { signal: ctx.signal, npmDir: join(runDir, 'hook-npm') });
      hooksInstalled = true;
    },
    async engineClone() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      if (engineDir === undefined) {
        await ctx.live.sandbox.clone(names, join(runDir, 'engine'));
        engineDir = join(runDir, 'engine');
        if (existsSync(join(engineDir, PRE_COMMIT_CONFIG))) {
          await provisionHookNpm(join(runDir, 'hook-npm'), hookEnv(), { signal: ctx.signal });
        }
      }
      return engineDir;
    },
    async corpusFile(path) {
      // A live run's setup refreshed the cache; an offline run reads the sandbox's main once, read-only.
      corpus ??= ctx.live === null ? corpusReader(deps, runId) : Promise.resolve(ctx.live.sandbox);
      return (await corpus).readMain(`${CORPUS_DIR}/${path}`);
    },
  };
  return { ctx, logLines, phase: () => phase, abort };
}

/** Saves what the engine and the remote side showed, before cleanup removes pull requests and comments. Collection errors are saved as errors. */
export async function captureCanaryEvidence(ctx: RunContext): Promise<void> {
  try {
    if (ctx.observations.get('canary.pendingIncomplete')) throw new Error('pending engine output unavailable');
    const evidence = await withDeadline(collectCanaryEvidence(ctx, { summariesOnly: false }), 30_000, () => new Error('canary collection timed out'));
    writeFileSync(join(ctx.runDir, 'canary-evidence.tmp'), JSON.stringify(evidence));
    renameSync(join(ctx.runDir, 'canary-evidence.tmp'), join(ctx.runDir, 'canary-evidence.json'));
  } catch {
    writeFileSync(join(ctx.runDir, 'canary-evidence.json'), JSON.stringify({ canaries: [], texts: {}, error: 'could not collect remote output' }));
  }
}

/** Cleans a run up and counts its team zones' trash after it: a run should leave the trash as it found it. */
export async function cleanupAndCount(ctx: RunContext): Promise<{ ok: boolean; detail?: string }> {
  let outcome: { ok: boolean; detail?: string };
  try {
    outcome = await cleanup(ctx);
  } catch (cleanupError) {
    outcome = { ok: false, detail: (cleanupError as Error).message };
  }
  const trashProblems: string[] = [];
  const trash = ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> | undefined;
  if (trash !== undefined && ctx.live !== null) {
    for (const [key, counts] of Object.entries(trash)) {
      const teamId = ctx.live.teams.get(key)?.id;
      if (teamId === undefined) continue;
      try {
        counts.after = await ctx.live.world.trashedInZone(teamId);
        if (counts.after > counts.before) trashProblems.push(`team ${key}'s trash count increased`);
      } catch (error) {
        trashProblems.push(`could not read team ${key}'s trash count after cleanup`);
      }
    }
  }
  if (trashProblems.length > 0) return { ok: false, detail: [...(outcome.detail === undefined ? [] : [outcome.detail]), ...trashProblems].join('; ') };
  return outcome;
}

/**
 * Claims the run's team zones in the shared admission and takes their team locks. Waiting while another live
 * run holds a zone does not count toward the setup deadline: each of those waits keeps its own bound. A team
 * lock whose run died on this host is taken over at once; a shared claim stays until that run is recovered.
 */
export async function takeTeamZones(
  ctx: RunContext,
  stateDir: string,
  grant: Pick<Awaited<ReturnType<Governor['admit']>>, 'claimZones'> | undefined,
  zones: { ids: readonly string[]; lockKeys: Iterable<string> },
  locks: Lock[],
  deadline: SetupDeadline,
): Promise<void> {
  const onHeld = (ms: number) => deadline.credit(ms);
  try { await grant?.claimZones?.(zones.ids, ctx.signal, onHeld); }
  catch { throw new EnvBlockedError('shared team zone is held or unavailable'); }
  await takeTeamLocks(ctx, stateDir, zones.lockKeys, locks, onHeld);
}

/** Takes the team locks of the run's team zones, when the scenario asks for them. */
export async function takeTeamLocks(ctx: RunContext, stateDir: string, teams: Iterable<string>, locks: Lock[], onHeld?: (waitedMs: number) => void): Promise<void> {
  if (!ctx.scenario.setup.teamZoneLock) return;
  for (const team of [...teams].sort()) {
    try {
      locks.push(await acquireLock(`team-${team.toLowerCase()}`, {
        signal: ctx.signal,
        stateDir,
        runId: ctx.names.runId,
        timeoutMs: TEAM_LOCK_TIMEOUT_MS,
        // A held run's take-up goes on with the team locks the run kept.
        takeOverHeld: true,
        onWait: (holder) => ctx.log(`waiting for team ${team} (held by run ${holder?.runId ?? 'unknown'})`),
        ...(onHeld === undefined ? {} : { onHeld }),
      }));
    } catch (error) {
      if (error instanceof LockTimeoutError) throw new EnvBlockedError(`team lock ${team}: ${error.message}`);
      throw error;
    }
  }
}

/** The scenario's result fields that do not depend on how it ended. */
export function resultOf(
  ctx: RunContext,
  outcome: ReturnType<typeof classify>,
  extra: { startedAt: number; budgetWaitMs: number; checks: CheckOutcome[]; cleanup: { ok: boolean; detail?: string } },
): Omit<ScenarioResult, 'harnessAppRequests'> {
  const { scenario } = ctx;
  const remote = remoteRequests(ctx);
  return {
    id: scenario.id,
    level: levelOf(scenario.id),
    slice: scenario.slice,
    mode: scenario.mode,
    runId: ctx.names.runId,
    ...outcome,
    startedAt: new Date(extra.startedAt).toISOString(),
    durationMs: Date.now() - extra.startedAt,
    engineRequests: engineRequestCount(ctx, remote),
    requestBuckets: requestBuckets(ctx, remote),
    harnessRequests: ctx.live === null ? 0 : [...Object.values(ctx.live.editors)].reduce((sum, client) => sum + client.stats.total, 0),
    budgetWaitMs: extra.budgetWaitMs,
    checks: extra.checks,
    cleanup: extra.cleanup,
    ...(ctx.observations.has('isolation.snapshot') ? { isolationSnapshot: ctx.observations.get('isolation.snapshot') } : {}),
    ...(ctx.observations.has('metrics') ? { metrics: ctx.observations.get('metrics') as Record<string, unknown> } : {}),
    ...(ctx.observations.has('corpus.teams') ? { corpusTeams: ctx.observations.get('corpus.teams') as string[] } : {}),
    ...(ctx.observations.has('zone.trash') ? { teamZoneTrash: ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> } : {}),
    ...(ctx.proxy === null ? {} : { answerSizes: answerSizes(ctx.proxy.requests) }),
    ...(ctx.observations.has('conflictMarks') ? { conflictMarks: ctx.observations.get('conflictMarks') as NonNullable<ScenarioResult['conflictMarks']> } : {}),
  };
}

async function runScenarioCounted(scenario: Scenario, deps: RunnerDeps, runId: string): Promise<Omit<ScenarioResult, 'harnessAppRequests'>> {
  const started = Date.now();
  const runDir = join(deps.outDir, 'runs', `${scenario.id}-${runId}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'canary-pending'), '');
  const registration = registerRun(deps.stateDir, runId);
  const heartbeat = setInterval(() => registration.heartbeat(), 60_000);
  const { ctx, logLines, phase, abort } = createRunContext(scenario, runId, runDir, deps);
  const { names, log } = ctx;
  // Persist even the pre-write scope so a crash immediately after admission
  // still has an ownership record for explicit recovery.
  ctx.owned.scope([]);
  if (deps.teams !== undefined) ctx.observations.set('corpus.teams', [...deps.teams]);
  const locks: Lock[] = [];
  let grant: Awaited<ReturnType<Governor['admit']>> | undefined;
  let released = false;
  let error: unknown;
  let checks: CheckOutcome[] = [];
  let cleanupOutcome: { ok: boolean; detail?: string } = { ok: true };
  const appName = deps.config.linearApps[0]?.name ?? 'app1';
  /** The index of the first UI step, once the scenario reached it. */
  let heldAt: number | undefined;
  /** Set when the run was kept for the UI session: its resources stay until `ui-result` or the hold's end. */
  let heldForUi = false;
  /** Set when setup did not stop after its deadline: the run stays registered, so the sweeper removes what it makes later. */
  let setupStuck = false;
  /** Set once setup has ended: until then, every engine run so far is setup's. */
  let setupEnded = scenario.setup.state === 'offline';
  try {
    if (scenario.setup.state !== 'offline') {
      requireLiveConfig(deps.config);
      // Before admission and setup: an actions scenario without the release under test must create nothing.
      if (scenario.mode === 'actions') requiredActionSha();
      if (deps.governor === null) throw new EnvBlockedError('no Linear app is configured');
      try {
        // Rendered workflows use the primary app's repository secrets. A
        // scenario invoking them must reserve that same app, including setup.
        const actions = scenario.mode === 'actions' || scenario.steps.some((step) => step.kind === 'run' && step.action.startsWith('workflow'));
        grant = await deps.governor.admit(scenario, runId, estimate(scenario), actions ? deps.config.linearApps[0]?.name : undefined);
      } catch (blocked) {
        if (blocked instanceof BudgetBlockedError) throw new EnvBlockedError(blocked.message);
        throw blocked;
      }
      if (grant.owner !== undefined) ctx.observations.set('admission.owner', grant.owner);
      ctx.proxy = await startFaultProxy('https://api.linear.app', { observer: ctx.owned });
      // A setup that does not finish must not hold a worker and its locks forever. On the deadline it is
      // told to stop; cleanup waits until it has stopped, so nothing is created after the cleanup.
      const timeoutMs = setupTimeoutMs(scenario.slice);
      const deadline = new SetupDeadline(timeoutMs);
      const setup = setupLive(ctx, deps, grant.app.name ?? appName, locks, deadline, grant);
      try {
        await deadline.race(setup, () =>
          new EnvBlockedError(`setup did not finish within ${timeoutMs / 60_000} minutes (last phase: ${phase()}${deadline.creditedMs >= 60_000 ? `; not counted: ${Math.round(deadline.creditedMs / 60_000)} minutes waiting for held team zones` : ''})`));
      } catch (late) {
        abort.abort();
        setupStuck = !(await settlesWithin(setup, SETUP_STOP_MS));
        throw late;
      }
      setupEnded = true;
      ctx.phase('steps');
    }
    await startRefHistory(ctx);
    for (const [index, step] of scenario.steps.entries()) {
      if (step.kind === 'ui') {
        writeFileSync(join(runDir, UI_CHECKLIST_FILE), renderUiChecklist(scenario, names, ctx));
        heldAt = index;
        throw new EnvBlockedError(`ui steps wait for the UI session: checklist ${join(runDir, UI_CHECKLIST_FILE)}`);
      }
      log(`step ${step.kind}.${step.action}`);
      await runStep(ctx, step);
      await recordRefs(ctx);
    }
    await settleFollowUpRuns(ctx);
    checks = await runChecks(ctx);
    failOnChecks(checks);
  } catch (caught) {
    // What failed after a run stopped at its setup check on the environment's credentials says nothing about the scenario.
    error = blockedBySetupStop(caught, ctx.engine.results, setupEnded ? ctx.engine.setupRuns : ctx.engine.results.length);
  } finally {
    await retainPendingOutput(ctx);
    // Capture output before cleanup removes remote pull requests and comments,
    // even when a step or assertion failed.
    await captureCanaryEvidence(ctx);
    if (heldAt !== undefined) {
      // What `ui-result` needs to take the run up again; a run that cannot be saved is cleaned up now.
      const holdUntil = Date.now() + UI_HOLD_MS;
      try {
        saveHeldRun(runDir, heldRunOf(ctx, { stepIndex: heldAt, appName: grant?.app.name ?? appName, holdUntil, startedAt: new Date(started).toISOString(), budgetWaitMs: grant?.waitedMs ?? 0, takeUpRequests: { harness: 0, harnessApp: 0 } }));
        heldForUi = true;
        registration.hold(holdUntil);
        // A held run's documents stay in its team zones, so its team locks stay too: another zone run's
        // initial sync would take them for documents without a file and move them to the trash.
        locks.splice(0).reverse().forEach((lock) => lock.hold(holdUntil));
        cleanupOutcome = { ok: true, detail: grant?.owner === undefined ? 'kept for the UI session; the sweeper removes it after the hold' : 'kept for the UI session; shared reservation retained until cleanup or verified recovery' };
      } catch (saveError) {
        error = new EnvBlockedError(`the run could not be kept for the UI session: ${(saveError as Error).message}`);
      }
    }
    if (!heldForUi) cleanupOutcome = await cleanupAndCount(ctx);
    await ctx.proxy?.close();
    await ctx.engine.lfsProxy?.close();
    const writerUnstopped = ctx.observations.get('workflows.unstopped') === true;
    if (writerUnstopped) {
      // Only verified recovery may release an unknown writer's team zones.
      registration.hold(Number.MAX_SAFE_INTEGER);
      locks.splice(0).reverse().forEach((lock) => lock.hold(Number.MAX_SAFE_INTEGER));
    } else locks.splice(0).reverse().forEach((lock) => lock.release());
    if (grant !== undefined) for (const { entry } of remoteRequests(ctx)) {
      if (isGraphql(entry) && deps.config.linearApps[0] !== undefined) {
        deps.governor?.observeRateLimits(deps.config.linearApps[0].name, entry.rateLimitHeaders, Date.parse(entry.finishedAt));
      }
    }
    if (grant !== undefined && !writerUnstopped && (grant.owner === undefined || (cleanupOutcome.ok && !heldForUi && !setupStuck))) {
      try { await grant.release(); released = true; }
      catch { cleanupOutcome = { ok: false, detail: 'shared reservation could not be released; retry cleanup before reuse' }; }
    }
    clearInterval(heartbeat);
    if (setupStuck) cleanupOutcome = { ok: false, detail: `setup did not stop; ${cleanupOutcome.detail ?? 'cleaned up'}; shared admission keeps its resources reserved for verified recovery` };
    if (cleanupOutcome.ok && !heldForUi && !setupStuck) registration.done();
    rmSync(join(runDir, 'engine'), { recursive: true, force: true });
    if (!setupStuck) rmSync(join(runDir, 'hook-npm'), { recursive: true, force: true });
  }
  const outcome = classify(error, deps.expectedRed.has(scenario.id));
  finishPersonClone(runDir, outcome.result, log);
  log(`${outcome.result}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`);
  writeFileSync(join(runDir, 'harness.log'), logLines.join('\n'));
  writeRunRefs(ctx, runDir);
  rmSync(join(runDir, 'canary-pending'), { force: true });
  const result = resultOf(ctx, outcome, { startedAt: started, budgetWaitMs: grant?.waitedMs ?? 0, checks, cleanup: cleanupOutcome });
  return grant?.owner !== undefined && !released ? { ...result, sharedReservationKept: true } : result;
}

/**
 * The run's refs before and after each watched run, by the scenario's run
 * index: the raw maps that `untouched.<n>` and `quiet.<n>` compare, so the
 * run's evidence keeps what was compared and not only the outcome.
 */
export function writeRunRefs(ctx: RunContext, runDir: string): void {
  const runs = Object.fromEntries([...ctx.observations].filter(([key]) => key.startsWith(RUN_REFS)).map(([key, value]) => [key.slice(RUN_REFS.length), value]));
  if (Object.keys(runs).length > 0) writeFileSync(join(runDir, 'run-refs.json'), `${JSON.stringify(runs, null, 2)}\n`);
  // I4's non-forward moves, with what differs between the two commits.
  const moves = ctx.observations.get(REF_MOVES);
  if (moves !== undefined) writeFileSync(join(runDir, 'ref-moves.json'), `${JSON.stringify(moves, null, 2)}\n`);
}

/** A check that does not hold fails the scenario as a product error; the outcomes stay in the result either way. */
export function failOnChecks(checks: readonly CheckOutcome[]): void {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new ProductError(`checks failed: ${failed.map((check) => `${check.name} (${check.detail ?? ''})`).join('; ')}`);
  }
}

export function skippedResult(scenario: Scenario, reason: string): ScenarioResult {
  return {
    id: scenario.id, level: levelOf(scenario.id), slice: scenario.slice, mode: scenario.mode, runId: '', result: 'skipped', reason,
    startedAt: new Date().toISOString(), durationMs: 0, engineRequests: 0, harnessRequests: 0, harnessAppRequests: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true },
  };
}

/**
 * Runs scenarios on `workers` parallel workers; results come back in the
 * given order. Once `stop.requested` is set, running scenarios finish (with
 * their cleanup) and the rest are reported skipped.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  deps: RunnerDeps,
  workers: number,
  stop: { requested: boolean } = { requested: false },
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = new Array(scenarios.length);
  const ordinary = scenarios.map((_, index) => index).filter((index) => scenarios[index]?.id !== 'L5-21');
  const governor = deps.governor;
  const memo = new Map<number, boolean>();
  const conflicting = (a: number, b: number) => {
    const key = a * scenarios.length + b;
    if (!memo.has(key)) memo.set(key, governor !== null && governor.conflicts(scenarios[a]!, scenarios[b]!));
    return memo.get(key)!;
  };
  // A stopped batch only reports the rest skipped, which conflicts with nothing.
  const conflicts = (a: number, b: number) => !stop.requested && conflicting(a, b);
  await runScheduled(ordinary, workers, conflicts, async (index) => {
    const scenario = scenarios[index]!;
    results[index] = stop.requested ? skippedResult(scenario, 'the harness was stopped before this scenario') : await runScenario(scenario, deps);
    return results[index]!.sharedReservationKept === true ? 'kept' : 'released';
  });
  // The batch scan runs after all producer workers and their cleanup finish.
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index]!;
    if (scenario.id === 'L5-21') results[index] = stop.requested ? skippedResult(scenario, 'the harness was stopped before the batch scan') : await runScenario(scenario, deps);
  }
  return results;
}
