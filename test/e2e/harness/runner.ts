// Runs scenarios: for each, a run id and its own names, setup to the spec's
// starting state, the steps, the checks, and cleanup in a `finally` step.
// Workers run scenarios in parallel; the governor admits each one.

import { collectCanaryEvidence } from './checks.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinearClient, type LinearDocument } from '../../../src/linear/index.ts';
import { Git, readIds } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs, bodyOf, titleOf } from './checks.ts';
import type { LinearApp, TestConfig } from './config.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { annotatedFolders, CORPUS_DIR, owningFolder, readAnnotation } from './corpus.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { BudgetBlockedError, estimate, type Governor } from './governor.ts';
import { SandboxRest, githubToken } from './github.ts';
import { newRunId, runNames, runOfTeamTitle, type RunNames } from './isolation.ts';
import { withAppRequests } from './app-reads.ts';
import { LinearWorld, editorClient, type Project } from './linear-world.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import { CorpusMissingError, installHooks, Sandbox } from './sandbox.ts';
import { levelOf, type Scenario } from './spec.ts';
import { runStep } from './steps.ts';
import { prepareFixtures, UNSAFE_TITLES } from './fixtures.ts';
import { BEFORE_VIEW, takeStartView } from './subjects.ts';
import { renderUiChecklist } from './ui-checklist.ts';

export const TEAM_LOCK_TIMEOUT_MS = 90 * 60_000;
/** A team zone holds about this many documents, trashed ones included (measured 2026-11-09: QUOTA_EXCEEDED at 1,000 trashed). */
export const ZONE_CAP = 1_000;
/** The harness warns from here on. */
export const ZONE_TRASH_WARNING = 900;
/** The longest setup, team-lock wait included; a full slice alone takes under a minute. */
export const SETUP_TIMEOUT_MS = 15 * 60_000;
/** How long a setup past its deadline gets to stop before cleanup runs anyway. */
export const SETUP_STOP_MS = 2 * 60_000;

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
  governor: Governor | null;
  /** The harness's own Linear client per app (as the app), for reads and budget. */
  appClients: Map<string, LinearClient>;
  stateDir: string;
  outDir: string;
  expectedRed: ReadonlySet<string>;
  log: (line: string) => void;
}

function appFor(deps: RunnerDeps, name: string): LinearApp {
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

async function setupLive(ctx: RunContext, deps: RunnerDeps, appName: string, locks: Lock[]): Promise<void> {
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
      checks: ctx.scenario.steps.some((step) => step.kind === 'fault' && step.action === 'checks'),
    });
  } catch (error) {
    if (error instanceof CorpusMissingError) throw new EnvBlockedError(`corpus: ${error.message}`);
    throw error;
  }
  const { tree, commit } = created;
  ctx.ownCommits.push(commit);
  const app = appFor(deps, appName);
  const appClient = deps.appClients.get(appName) as LinearClient;
  const editors = { 'editor-a': editorClient(config.editors['editor-a']), 'editor-b': editorClient(config.editors['editor-b']) };
  const world = new LinearWorld(editors['editor-a']);
  ctx.phase('linear teams');
  const teams = new Map((await world.teams()).map((team) => [team.key, team]));
  // Links between synchronized documents are written as document URLs of this workspace.
  const organization = await appClient.request<{ organization: { urlKey: string } }>('Organization', 'query', 'query Organization { organization { urlKey } }');
  const live: LiveWorld = {
    sandbox,
    rest: new SandboxRest(config, token.token),
    githubToken: token.token,
    githubTokenSource: token.source,
    repository: `${config.owner}/${config.repo}`,
    manifest,
    tree,
    projects: new Map(),
    teams,
    app: appClient,
    editors,
    world,
    engineApp: { clientId: app.clientId, clientSecret: app.clientSecret },
    seededDocuments: [],
    documentUrlBase: `https://linear.app/${organization.organization.urlKey}/document`,
    async download(url) {
      // Personal API keys go in the Authorization header as they are.
      const response = await fetch(url, { headers: { authorization: config.editors['editor-a'] } });
      if (!response.ok) throw new ProductError(`an upload URL answered HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
  ctx.live = live;

  // The team lock: initial sync matches every document of an annotated team zone.
  ctx.phase('team lock');
  if (ctx.scenario.setup.teamZoneLock) {
    for (const team of [...tree.teamZones.keys()].sort()) {
      try {
        locks.push(await acquireLock(`team-${team.toLowerCase()}`, {
          signal: ctx.signal,
          stateDir: deps.stateDir,
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

  // Trashed documents per team zone the run uses, counted once the team lock is held so another run's work
  // is not counted as this run's. They count against the zone's cap and cannot be purged. Only a measure:
  // a count that cannot be read is logged and leaves the run alone.
  const trash: Record<string, { before: number; after?: number }> = {};
  for (const key of tree.teamZones.keys()) {
    const team = teams.get(key);
    if (team === undefined) continue;
    try {
      const before = await world.trashedInZone(team.id);
      trash[key] = { before };
      if (before >= ZONE_TRASH_WARNING) ctx.log(`warning: team ${key}'s zone holds ${before} trashed documents, near the cap of about ${ZONE_CAP}; creates there fail with QUOTA_EXCEEDED at the cap`);
    } catch (error) {
      ctx.log(`could not count team ${key}'s trashed documents: ${(error as Error).message}`);
    }
  }
  ctx.observations.set('zone.trash', trash);

  const readmes = new Map<string, string>();
  for (const [target, source] of tree.paths) {
    if (/(^|\/)README\.md$/.test(source)) readmes.set(source, tree.rewritten.get(target) ?? (await sandbox.readMain(`corpus/${source}`)) ?? '');
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
  for (const key of [...ctx.observations.keys()]) if (/^(target\.|edited\.|runs\.|harness\.runs\.)/.test(key)) ctx.observations.delete(key);
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
    const document = await live.editors['editor-a'].createDocument(place, { title: titleOf(target, folder.folder), content: bodyOf(texts.get(target) ?? '') });
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
    const only = await editor.createDocument({ projectId: project.id }, { title: `notes/only-in-linear-${ctx.names.runId}`, content: 'Kept only here for now.\n' });
    live.seededDocuments.push(only.id);
    ctx.observations.set('setup.linearOnlyDocument', only.id);
    // Linear archives documents only with their project: a helper project holds
    // a document with a matched title and is deleted, which archives it.
    const team = [...live.teams.values()][0];
    if (team !== undefined) {
      const helper = await live.world.createProject(ctx.names.helperProject('archived-copy'), [team.id]);
      const archived = await editor.createDocument({ projectId: helper.id }, { title: first.title, content: 'An older copy.\n' });
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
    const document = await editor.createDocument({ projectId: project.id }, { title: `guides/diagram-${ctx.names.runId}`, content: `The flow at a glance.\n\n![diagram](${upload.assetUrl})\n` });
    live.seededDocuments.push(document.id);
    // The bytes the pull request must hold, hashed here from what was uploaded.
    ctx.observations.set('linear.assets', [{ name: 'diagram.png', sha256: createHash('sha256').update(TINY_PNG).digest('hex') }]);
  },
  // L1R-05: titles with characters a file name cannot hold as they are.
  async 'unsafe-titles'(_ctx, live) {
    const editor = live.editors['editor-a'];
    const project = [...live.projects.values()][0];
    if (project === undefined) throw new EnvBlockedError('the slice maps no project to seed');
    for (const title of UNSAFE_TITLES) {
      const document = await editor.createDocument({ projectId: project.id }, { title, content: 'Short note.\n' });
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
  // Every document the run made, by id: what the harness seeded and what the engine recorded.
  // Read the ids before the refs go.
  const created = new Set(ctx.live?.seededDocuments ?? []);
  if (ctx.live !== null) {
    await attempt('ids', async () => {
      for (const id of await recordedIds(ctx)) created.add(id);
    });
  }
  const sandbox = ctx.sandbox;
  if (sandbox !== undefined) {
    await attempt('refs', async () => {
      const refs = (await sandbox.runRefs()).filter((ref) => ref.runId === ctx.names.runId).map((ref) => ref.ref);
      await sandbox.deleteRunRefs(ctx.names.runId, refs);
    });
  }
  const live = ctx.live;
  if (live !== null) {
    await attempt('pull requests', async () => {
      for (const pr of await live.rest.pullRequests(`t/${ctx.names.runId}/`, 'open')) await live.rest.closePullRequest(pr.number);
    });
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
async function corpusReader(deps: RunnerDeps, runId: string): Promise<Sandbox> {
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

async function runScenarioCounted(scenario: Scenario, deps: RunnerDeps, runId: string): Promise<Omit<ScenarioResult, 'harnessAppRequests'>> {
  const names: RunNames = runNames(runId);
  const started = Date.now();
  const runDir = join(deps.outDir, 'runs', `${scenario.id}-${runId}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'canary-pending'), '');
  const registration = registerRun(deps.stateDir, runId);
  const heartbeat = setInterval(() => registration.heartbeat(), 60_000);
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
  const locks: Lock[] = [];
  let grant: Awaited<ReturnType<Governor['admit']>> | undefined;
  let error: unknown;
  let checks: CheckOutcome[] = [];
  let cleanupOutcome: { ok: boolean; detail?: string } = { ok: true };
  const appName = deps.config.linearApps[0]?.name ?? 'app1';
  /** Set when the scenario reached its UI steps: its resources stay for the UI session. */
  let heldForUi = false;
  /** Set when setup did not stop after its deadline: the run stays registered, so the sweeper removes what it makes later. */
  let setupStuck = false;
  try {
    if (scenario.setup.state !== 'offline') {
      if (deps.governor === null) throw new EnvBlockedError('no Linear app is configured');
      try {
        grant = await deps.governor.admit(scenario, runId, estimate(scenario));
      } catch (blocked) {
        if (blocked instanceof BudgetBlockedError) throw new EnvBlockedError(blocked.message);
        throw blocked;
      }
      ctx.proxy = await startFaultProxy('https://api.linear.app');
      // A setup that does not finish must not hold a worker and its locks forever. On the deadline it is
      // told to stop; cleanup waits until it has stopped, so nothing is created after the cleanup.
      const setup = setupLive(ctx, deps, grant.app.name ?? appName, locks);
      try {
        await withDeadline(setup, SETUP_TIMEOUT_MS, () =>
          new EnvBlockedError(`setup did not finish within ${SETUP_TIMEOUT_MS / 60_000} minutes (last phase: ${phase})`));
      } catch (late) {
        abort.abort();
        setupStuck = !(await settlesWithin(setup, SETUP_STOP_MS));
        throw late;
      }
      ctx.phase('steps');
    }
    const history: Array<Record<string, string>> = [await snapshotRefs(ctx)];
    ctx.observations.set('refHistory', history);
    for (const step of scenario.steps) {
      if (step.kind === 'ui') {
        writeFileSync(join(runDir, 'ui-checklist.md'), renderUiChecklist(scenario, names, ctx));
        heldForUi = true;
        throw new EnvBlockedError(`ui steps wait for the UI session: checklist ${join(runDir, 'ui-checklist.md')}`);
      }
      log(`step ${step.kind}.${step.action}`);
      await runStep(ctx, step);
      history.push(await snapshotRefs(ctx));
    }
    checks = await runChecks(ctx);
    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      throw new ProductError(`checks failed: ${failed.map((check) => `${check.name} (${check.detail ?? ''})`).join('; ')}`);
    }
  } catch (caught) {
    error = caught;
  } finally {
    await retainPendingOutput(ctx);
    // Capture output before cleanup removes remote pull requests and comments,
    // even when a step or assertion failed. Persist collection errors as errors.
    {
      try {
        if (ctx.observations.get('canary.pendingIncomplete')) throw new Error('pending engine output unavailable');
        const evidence = await withDeadline(collectCanaryEvidence(ctx, { summariesOnly: false }), 30_000, () => new Error('canary collection timed out'));
        writeFileSync(join(runDir, 'canary-evidence.tmp'), JSON.stringify(evidence));
        renameSync(join(runDir, 'canary-evidence.tmp'), join(runDir, 'canary-evidence.json'));
      } catch {
        writeFileSync(join(runDir, 'canary-evidence.json'), JSON.stringify({ canaries: [], texts: {}, error: 'could not collect remote output' }));
      }
    }
    if (heldForUi) {
      registration.hold(Date.now() + UI_HOLD_MS);
      cleanupOutcome = { ok: true, detail: 'kept for the UI session; the sweeper removes it after the hold' };
    } else {
      try {
        cleanupOutcome = await cleanup(ctx);
      } catch (cleanupError) {
        cleanupOutcome = { ok: false, detail: (cleanupError as Error).message };
      }
      // The zone's trash after cleanup: a run should leave it as it found it.
      const trash = ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> | undefined;
      if (trash !== undefined && ctx.live !== null) {
        for (const [key, counts] of Object.entries(trash)) {
          const teamId = ctx.live.teams.get(key)?.id;
          if (teamId === undefined) continue;
          try {
            counts.after = await ctx.live.world.trashedInZone(teamId);
            if (counts.after > counts.before) ctx.log(`warning: the run left ${counts.after - counts.before} more trashed documents in team ${key}'s zone`);
          } catch (error) {
            ctx.log(`could not count team ${key}'s trashed documents after the run: ${(error as Error).message}`);
          }
        }
      }
    }
    await ctx.proxy?.close();
    locks.splice(0).reverse().forEach((lock) => lock.release());
    grant?.release();
    clearInterval(heartbeat);
    if (setupStuck) cleanupOutcome = { ok: false, detail: `setup did not stop; ${cleanupOutcome.detail ?? 'cleaned up'}; the sweeper removes the rest once this process ends` };
    if (cleanupOutcome.ok && !heldForUi && !setupStuck) registration.done();
    rmSync(join(runDir, 'person'), { recursive: true, force: true });
    rmSync(join(runDir, 'engine'), { recursive: true, force: true });
  }
  const outcome = classify(error, deps.expectedRed.has(scenario.id));
  log(`${outcome.result}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`);
  writeFileSync(join(runDir, 'harness.log'), logLines.join('\n'));
  rmSync(join(runDir, 'canary-pending'), { force: true });
  return {
    id: scenario.id,
    level: levelOf(scenario.id),
    slice: scenario.slice,
    mode: scenario.mode,
    runId,
    ...outcome,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    engineRequests: ctx.proxy?.requests.filter((record) => !record.injected).length ?? 0,
    harnessRequests: ctx.live === null ? 0 : [...Object.values(ctx.live.editors)].reduce((sum, client) => sum + client.stats.total, 0),
    budgetWaitMs: grant?.waitedMs ?? 0,
    checks,
    cleanup: cleanupOutcome,
    ...(ctx.observations.has('metrics') ? { metrics: ctx.observations.get('metrics') as Record<string, unknown> } : {}),
    ...(ctx.observations.has('zone.trash') ? { teamZoneTrash: ctx.observations.get('zone.trash') as Record<string, { before: number; after?: number }> } : {}),
  };
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
