// Runs scenarios: for each, a run id and its own names, setup to the spec's
// starting state, the steps, the checks, and cleanup in a `finally` step.
// Workers run scenarios in parallel; the governor admits each one.

import { collectCanaryEvidence } from './checks.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinearClient, type LinearDocument } from '../../../src/linear/index.ts';
import { Git, readIds } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs, bodyOf, titleOf } from './checks.ts';
import type { LinearApp, TestConfig } from './config.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { annotatedFolders, CORPUS_DIR, owningFolder, readAnnotation, type Manifest, type RunTree } from './corpus.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { BudgetBlockedError, estimate, type Governor } from './governor.ts';
import { SandboxRest, githubToken, type GitHubToken } from './github.ts';
import { newRunId, runNames, runOfTeamTitle, type RunNames } from './isolation.ts';
import { engineRequestCount, requestBuckets, remoteRequests, isGraphql } from './request-accounting.ts';
import { withAppRequests } from './app-reads.ts';
import { LinearWorld, editorClient, type Project, type Team } from './linear-world.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { OwnershipLedger, ownedDocuments, type WriteObserver } from './ownership.ts';
import { classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import { CorpusMissingError, installHooks, Sandbox } from './sandbox.ts';
import { levelOf, type Scenario } from './spec.ts';
import { runStep } from './steps.ts';
import { prepareFixtures, publishesCheckWorkflow, UNSAFE_TITLES } from './fixtures.ts';
import { projectFolders } from './step-helpers.ts';
import { BEFORE_VIEW, takeStartView, encodeTitlePath } from './subjects.ts';
import { renderUiChecklist } from './ui-checklist.ts';
import { heldRunOf, saveHeldRun, UI_CHECKLIST_FILE } from './held-run.ts';

export const TEAM_LOCK_TIMEOUT_MS = 90 * 60_000;
/** A team zone holds about this many documents, trashed ones included (measured 2026-11-09: QUOTA_EXCEEDED at 1,000 trashed). */
export const ZONE_CAP = 1_000;
/** The harness warns from here on. */
export const ZONE_TRASH_WARNING = 900;
/** The longest setup, team-lock wait included; a full slice alone takes under a minute. */
export const SETUP_TIMEOUT_MS = 15 * 60_000;
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
    let team = folder.team;
    let parent = folder.folder;
    while (team === null && parent !== '') {
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
      team = folders.find((candidate) => candidate.folder === parent)?.team ?? null;
    }
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
    rest: new SandboxRest(config, parts.token.token),
    githubToken: parts.token.token,
    githubTokenSource: parts.token.source,
    ...(parts.token.appLogin === undefined ? {} : { githubAppLogin: parts.token.appLogin }),
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

async function setupLive(ctx: RunContext, deps: RunnerDeps, appName: string, locks: Lock[], grant?: Awaited<ReturnType<Governor['admit']>>): Promise<void> {
  const { config } = deps;
  if (config.missing.length > 0) throw new EnvBlockedError(`test configuration is missing: ${config.missing.join(', ')}`);
  let token;
  try {
    ctx.phase('github token');
    token = await githubToken(config, ctx.scenario.mode === 'actions' ? 'actions' : 'local');
  } catch (error) {
    throw new EnvBlockedError(`GitHub token: ${(error as Error).message}`);
  }
  const sandbox = new Sandbox({ url: config.gitUrl, token: token.token, stateDir: deps.stateDir, runId: ctx.names.runId });
  ctx.sandbox = sandbox;
  ctx.phase('sandbox cache');
  await sandbox.refreshCache();
  let manifest;
  let created;
  try {
    ctx.phase('corpus manifest');
    manifest = await sandbox.manifest();
    ctx.phase('tracked branch');
    created = await sandbox.createTrackedBranch(ctx.scenario.slice, ctx.names, {
      checks: publishesCheckWorkflow(ctx.scenario),
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
  ctx.owned.scope([...tree.teamZones.keys()].flatMap((key) => teams.get(key)?.id ?? []));

  // The team lock: initial sync matches every document of an annotated team zone.
  ctx.phase('team lock');
  const zoneIds = [...tree.teams].map((key) => {
    const team = teams.get(key);
    if (team === undefined) throw new EnvBlockedError(`the test workspace has no team ${key}`);
    return team.id;
  });
  try { await grant?.claimZones?.(zoneIds); }
  catch { throw new EnvBlockedError('shared team zone is held or unavailable'); }
  await takeTeamLocks(ctx, deps.stateDir, tree.teamZones.keys(), locks);

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

  const state = ctx.scenario.setup.state;
  ctx.phase('setup state');
  const tools = { runStep };
  await prepareFixtures(ctx, live, 'beforeSync', tools);
  if (state === 'linear-seeded') await seedLinear(ctx, live);
  if (state === 'converged' || state === 'conflicted') {
    await runStep(ctx, { kind: 'run', action: 'initial-sync', args: { direction: 'git-to-linear', confirm: true } });
    await prepareFixtures(ctx, live, 'afterSync', tools);
  }
  if (state === 'conflicted') {
    // Both sides edit the same paragraph of the same document: an open conflict.
    await runStep(ctx, { kind: 'git', action: 'edit', args: { fixture: 'same-paragraph' } });
    await runStep(ctx, { kind: 'linear', action: 'edit', args: { actor: 'editor-a', fixture: 'same-paragraph' } });
    await runStep(ctx, { kind: 'run', action: 'sync', args: {} });
  }
  // The scenario's own edits and runs start here: setup's edits are not the scenario's.
  ctx.engine.setupRuns = ctx.engine.results.length;
  for (const key of [...ctx.observations.keys()]) if (/^(target\.|edited\.|runs\.|harness\.runs\.|harness\.quiet\.|harness\.runView\.)/.test(key)) ctx.observations.delete(key);
  await recordStart(ctx, live);
}

/** What the subjects compare against: the world when setup ended. */
async function recordStart(ctx: RunContext, live: LiveWorld): Promise<void> {
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
    const document = await live.editors['editor-a'].createDocument(place, { id: randomUUID(), title: titleOf(target, folder.folder), content: bodyOf(texts.get(target) ?? '') });
    live.seededDocuments.push(document.id);
    seededPaths.set(target, document.id);
  }
  ctx.observations.set('setup.seededPaths', seededPaths);
  for (const fixture of ctx.scenario.setup.fixtures) await FIXTURE_PREPARATION[fixture]?.(ctx, live);
  ctx.observations.set('setup.seeded', [...live.seededDocuments]);
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
  if (!(await sandbox.runRefs()).some((entry) => entry.ref === ref)) return [];
  const git = await ctx.person();
  await git.run(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
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
      const ofRun = async () => (await sandbox.runRefs()).filter((ref) => ref.runId === runId).map((ref) => ref.ref);
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
  // Every document the run made, by id: what the harness seeded, what the run's ownership record holds (every
  // create, a team zone's README and a create whose answer was lost included) and what the engine recorded.
  // Read the ids before the refs go.
  const created = new Set([...(ctx.live?.seededDocuments ?? []), ...ownedDocuments(ctx.owned).keys()]);
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
  const sandbox = new Sandbox({ url: config.gitUrl, token: token.token, stateDir: deps.stateDir, runId });
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
      await installHooks(await ctx.person(), { signal: ctx.signal });
      hooksInstalled = true;
    },
    async engineClone() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      if (engineDir === undefined) {
        await ctx.live.sandbox.clone(names, join(runDir, 'engine'));
        engineDir = join(runDir, 'engine');
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
  const trash = ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> | undefined;
  if (trash !== undefined && ctx.live !== null) {
    for (const [key, counts] of Object.entries(trash)) {
      const teamId = ctx.live.teams.get(key)?.id;
      if (teamId === undefined) continue;
      try {
        counts.after = await ctx.live.world.trashedInZone(teamId);
        if (counts.after > counts.before) outcome = { ok: false, detail: `team ${key}'s trash count increased` };
      } catch (error) {
        outcome = { ok: false, detail: `could not read team ${key}'s trash count after cleanup` };
      }
    }
  }
  return outcome;
}

/** Takes the team locks of the run's team zones, when the scenario asks for them. */
export async function takeTeamLocks(ctx: RunContext, stateDir: string, teams: Iterable<string>, locks: Lock[]): Promise<void> {
  if (!ctx.scenario.setup.teamZoneLock) return;
  for (const team of [...teams].sort()) {
    try {
      locks.push(await acquireLock(`team-${team.toLowerCase()}`, {
        signal: ctx.signal,
        stateDir,
        runId: ctx.names.runId,
        timeoutMs: TEAM_LOCK_TIMEOUT_MS,
        onWait: (holder) => ctx.log(`waiting for team ${team} (held by run ${holder?.runId ?? 'unknown'})`),
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
    ...(ctx.observations.has('metrics') ? { metrics: ctx.observations.get('metrics') as Record<string, unknown> } : {}),
    ...(ctx.observations.has('corpus.teams') ? { corpusTeams: ctx.observations.get('corpus.teams') as string[] } : {}),
    ...(ctx.observations.has('zone.trash') ? { teamZoneTrash: ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> } : {}),
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
  if (deps.teams !== undefined) ctx.observations.set('corpus.teams', [...deps.teams]);
  const locks: Lock[] = [];
  let grant: Awaited<ReturnType<Governor['admit']>> | undefined;
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
  try {
    if (scenario.setup.state !== 'offline') {
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
      const setup = setupLive(ctx, deps, grant.app.name ?? appName, locks, grant);
      try {
        await withDeadline(setup, SETUP_TIMEOUT_MS, () =>
          new EnvBlockedError(`setup did not finish within ${SETUP_TIMEOUT_MS / 60_000} minutes (last phase: ${phase()})`));
      } catch (late) {
        abort.abort();
        setupStuck = !(await settlesWithin(setup, SETUP_STOP_MS));
        throw late;
      }
      ctx.phase('steps');
    }
    const history: Array<Record<string, string>> = [await snapshotRefs(ctx)];
    ctx.observations.set('refHistory', history);
    for (const [index, step] of scenario.steps.entries()) {
      if (step.kind === 'ui') {
        writeFileSync(join(runDir, UI_CHECKLIST_FILE), renderUiChecklist(scenario, names, ctx));
        heldAt = index;
        throw new EnvBlockedError(`ui steps wait for the UI session: checklist ${join(runDir, UI_CHECKLIST_FILE)}`);
      }
      log(`step ${step.kind}.${step.action}`);
      await runStep(ctx, step);
      history.push(await snapshotRefs(ctx));
    }
    checks = await runChecks(ctx);
    failOnChecks(checks);
  } catch (caught) {
    error = caught;
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
        cleanupOutcome = { ok: true, detail: 'kept for the UI session; the sweeper removes it after the hold' };
      } catch (saveError) {
        error = new EnvBlockedError(`the run could not be kept for the UI session: ${(saveError as Error).message}`);
      }
    }
    if (!heldForUi) cleanupOutcome = await cleanupAndCount(ctx);
    await ctx.proxy?.close();
    locks.splice(0).reverse().forEach((lock) => lock.release());
    if (grant !== undefined) for (const { entry } of remoteRequests(ctx)) {
      if (isGraphql(entry) && deps.config.linearApps[0] !== undefined) {
        deps.governor?.observeRateLimits(deps.config.linearApps[0].name, entry.rateLimitHeaders, Date.parse(entry.finishedAt));
      }
    }
    if (grant !== undefined && (grant.owner === undefined || (cleanupOutcome.ok && !heldForUi && !setupStuck))) {
      try { await grant.release(); }
      catch { cleanupOutcome = { ok: false, detail: 'shared reservation could not be released; retry cleanup before reuse' }; }
    }
    clearInterval(heartbeat);
    if (setupStuck) cleanupOutcome = { ok: false, detail: `setup did not stop; ${cleanupOutcome.detail ?? 'cleaned up'}; shared admission keeps its resources reserved for verified recovery` };
    if (cleanupOutcome.ok && !heldForUi && !setupStuck) registration.done();
    rmSync(join(runDir, 'person'), { recursive: true, force: true });
    rmSync(join(runDir, 'engine'), { recursive: true, force: true });
  }
  const outcome = classify(error, deps.expectedRed.has(scenario.id));
  log(`${outcome.result}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`);
  writeFileSync(join(runDir, 'harness.log'), logLines.join('\n'));
  rmSync(join(runDir, 'canary-pending'), { force: true });
  return resultOf(ctx, outcome, { startedAt: started, budgetWaitMs: grant?.waitedMs ?? 0, checks, cleanup: cleanupOutcome });
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
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = ordinary[next++];
      if (index === undefined) return;
      const scenario = scenarios[index];
      if (scenario === undefined) return;
      results[index] = stop.requested ? skippedResult(scenario, 'the harness was stopped before this scenario') : await runScenario(scenario, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, scenarios.length)) }, worker));
  // The batch scan runs after all producer workers and their cleanup finish.
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index]!;
    if (scenario.id === 'L5-21') results[index] = stop.requested ? skippedResult(scenario, 'the harness was stopped before the batch scan') : await runScenario(scenario, deps);
  }
  return results;
}
