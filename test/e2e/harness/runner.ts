// Runs scenarios: for each, a run id and its own names, setup to the spec's
// starting state, the steps, the checks, and cleanup in a `finally` step.
// Workers run scenarios in parallel; the governor admits each one.

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinearClient } from '../../../src/linear/index.ts';
import { Git, readIds } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs, stripFrontMatter, titleOf } from './checks.ts';
import type { LinearApp, TestConfig } from './config.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { annotatedFolders, owningFolder, readAnnotation } from './corpus.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { BudgetBlockedError, estimate, type Governor } from './governor.ts';
import { SandboxRest, githubToken } from './github.ts';
import { newRunId, runNames, type RunNames } from './isolation.ts';
import { LinearWorld, editorClient, type Project } from './linear-world.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import { CorpusMissingError, Sandbox } from './sandbox.ts';
import { levelOf, type Scenario } from './spec.ts';
import { runStep } from './steps.ts';
import { prepareFixtures, UNSAFE_TITLES } from './fixtures.ts';
import { BEFORE_VIEW, takeStartView } from './subjects.ts';
import { renderUiChecklist } from './ui-checklist.ts';

export const TEAM_LOCK_TIMEOUT_MS = 90 * 60_000;
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
    created = await sandbox.createTrackedBranch(ctx.scenario.slice, ctx.names);
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
    const document = await live.editors['editor-a'].createDocument(place, { title: titleOf(target, folder.folder), content: stripFrontMatter(texts.get(target) ?? '') });
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
      const helper = await live.world.createProject(ctx.names.project(8), [team.id]);
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
    // Project documents went with their projects; team-zone documents the run made go to the trash.
    await attempt('created team-zone documents', () => live.world.trashTeamZoneDocuments([...created]));
    for (const team of live.tree.teamZones.keys()) {
      const teamId = live.teams.get(team)?.id;
      if (teamId === undefined) continue;
      await attempt(`team ${team} documents`, async () => {
        for (const document of await live.world.runTeamDocuments(teamId)) {
          if (document.runId === ctx.names.runId) await live.world.trashRunDocument(document, ctx.names.runId);
        }
      });
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
}

export async function runScenario(scenario: Scenario, deps: RunnerDeps, runId: string = newRunId()): Promise<ScenarioResult> {
  const names: RunNames = runNames(runId);
  const started = Date.now();
  const runDir = join(deps.outDir, 'runs', `${scenario.id}-${runId}`);
  mkdirSync(runDir, { recursive: true });
  const registration = registerRun(deps.stateDir, runId);
  const heartbeat = setInterval(() => registration.heartbeat(), 60_000);
  const log = (line: string) => deps.log(`${scenario.id} ${runId}: ${line}`);
  let person: Git | undefined;
  let engineDir: string | undefined;
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
    observations: new Map(),
    uiSteps: 0,
    sequence: 0,
    log,
    async person() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      person ??= await ctx.live.sandbox.clone(names, join(runDir, 'person'));
      return person;
    },
    async engineClone() {
      if (ctx.live === null) throw new Error('offline scenarios have no repository');
      if (engineDir === undefined) {
        await ctx.live.sandbox.clone(names, join(runDir, 'engine'));
        engineDir = join(runDir, 'engine');
      }
      return engineDir;
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
    if (heldForUi) {
      registration.hold(Date.now() + UI_HOLD_MS);
      cleanupOutcome = { ok: true, detail: 'kept for the UI session; the sweeper removes it after the hold' };
    } else {
      try {
        cleanupOutcome = await cleanup(ctx);
      } catch (cleanupError) {
        cleanupOutcome = { ok: false, detail: (cleanupError as Error).message };
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
  };
}

export function skippedResult(scenario: Scenario, reason: string): ScenarioResult {
  return {
    id: scenario.id, level: levelOf(scenario.id), slice: scenario.slice, mode: scenario.mode, runId: '', result: 'skipped', reason,
    startedAt: new Date().toISOString(), durationMs: 0, engineRequests: 0, harnessRequests: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true },
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
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const scenario = scenarios[index];
      if (scenario === undefined) return;
      results[index] = stop.requested ? skippedResult(scenario, 'the harness was stopped before this scenario') : await runScenario(scenario, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, scenarios.length)) }, worker));
  return results;
}
