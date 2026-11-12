// A live scenario's context on local git and the same service fakes as the
// engine tests: the scenario's actions and assertions stay the live ones,
// and the engine runs in process against the fakes.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { runCli } from '../../../src/cli.ts';
import { LinearClient, type LogEntry } from '../../../src/linear/index.ts';
import { fakeFetch, fakeWorld, GITHUB_API, LINEAR_API } from '../../../src/setup/test-helpers.ts';
import { createFixture, IDENTITY } from '../../../src/state/test-helpers.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs } from './checks.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { engineInputs, type EngineResult } from './engine.ts';
import { SandboxRest } from './github.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import { setupState } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import type { Scenario, Step } from './spec.ts';
import { runStep, watchRun, STEP_ACTIONS } from './steps.ts';
import { refreshView } from './subjects.ts';

export const README = '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n';
/** Two documents of two paragraphs each, unless a spec names its own. */
export const DOCUMENTS: Readonly<Record<string, string>> = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`eng/notes/item-${i}.md`, `# Notes ${i}\n\nFirst paragraph.\n\nSecond paragraph.\n`]));
const PRE_COMMIT = 'repos:\n  - repo: https://github.com/example/hooks\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n';

export interface SpecWorld {
  ctx: RunContext;
  world: ReturnType<typeof fakeWorld>;
  /** One engine run in process; it must exit with 0. */
  sync(command?: 'sync' | 'initial-sync'): Promise<void>;
  /** A scenario step: sync runs go to the in-process engine, the others to the harness's executors. */
  step(ctx: RunContext, step: Step): Promise<void>;
  /** The live setup of the scenario's `setup.state`, its runs in process, up to the start of its own steps. */
  setUp(): Promise<void>;
  /** The scenario's invariants and assertions; each must hold. */
  check(): Promise<void>;
  /** A file's text at the tip of the tracked branch, or null. */
  tracked(path: string): Promise<string | null>;
  cleanup(): Promise<void>;
}

/**
 * The scenario's world: `eng/notes/README.md` maps the folder to project
 * "Field notes" of team ENG, next to `documents`, on the tracked branch.
 */
export async function specWorld(t: TestContext, scenario: Scenario, documents: Readonly<Record<string, string>> = DOCUMENTS): Promise<SpecWorld> {
  const fixture = await createFixture();
  const names = runNames('aaaaaa');
  await fixture.seed({ 'eng/notes/README.md': README, ...documents, '.pre-commit-config.yaml': PRE_COMMIT }, { branch: names.trackedBranch });
  const world = fakeWorld();
  // No check workflow in the tree: the head has no checks, as in the live specs.
  world.github.checks = new Map();
  const transport = fakeFetch(world);
  const serve = async (input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Promise<Response> => {
    const url = String(input).replace('https://api.github.com', GITHUB_API);
    // The harness reads a document's comments with a query of its own, which the shared fake lacks.
    if (init?.body && url.endsWith('/graphql') && JSON.parse(String(init.body)).operationName === 'DocumentComments') {
      const id = `content-${JSON.parse(String(init.body)).variables.id}`;
      const nodes = [...world.linear.comments].filter(([, c]) => c.documentContentId === id).map(([commentId, c]) => ({ id: commentId, body: c.body, resolvedAt: c.resolved ? new Date().toISOString() : null, createdAt: new Date().toISOString() }));
      return Response.json({ data: { document: { comments: { nodes } } } });
    }
    if (!url.includes('/pulls') || /\/pulls\/\d+\/merge$/.test(url)) return transport(url, init);
    // GitHub's answers carry the head's sha and the merge and creation times the harness reads.
    const response = await transport(url, init);
    const data = await response.json() as Record<string, any> | Array<Record<string, any>>;
    const enrich = async (node: Record<string, any>) => {
      const pr = world.github.pullRequests.find((p) => p.number === node.number);
      if (pr !== undefined) {
        node.merged_at = pr.merged ? new Date().toISOString() : null;
        node.created_at = new Date().toISOString();
        node.head.sha = (await fixture.remote.text(['rev-parse', `refs/heads/${pr.head}`])).trim();
      }
      return node;
    };
    return Response.json(Array.isArray(data) ? await Promise.all(data.map(enrich)) : await enrich(data), { status: response.status });
  };
  world.github.merge = async (pr, sha) => {
    const base = (await fixture.remote.text(['rev-parse', `refs/heads/${pr.base}`])).trim();
    const result = await fixture.remote.run(['merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
    if (result.code !== 0) return { status: 405 };
    const commit = (await fixture.remote.text(['commit-tree', result.stdout.toString().split('\n')[0]!, '-p', base, '-p', sha, '-m', 'Merge the reviewed changes'], { env: { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email } })).trim();
    await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
    return { sha: commit };
  };
  const rest = new SandboxRest({ owner: 'owner', repo: 'repo' }, 'app-token', serve);
  const app = new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: serve });
  const sandbox = new Sandbox({ url: fixture.url, token: 'unused', stateDir: join(fixture.root, 'state'), runId: names.runId });
  await mkdir(sandbox.cache.dir, { recursive: true });
  await sandbox.cache.run(['init', '--quiet', '--bare']);
  const engine = await fixture.clone('engine');
  const person = await sandbox.clone(names, join(fixture.root, 'person'));
  const ctx = {
    scenario, names, runDir: fixture.root, sandbox, live: {
      sandbox, rest, repository: 'owner/repo', githubToken: 'app-token', githubTokenSource: 'app', app, editors: { 'editor-a': app, 'editor-b': app },
      tree: { paths: new Map(Object.keys(documents).map((p) => [p, p])), rewritten: new Map([['eng/notes/README.md', README]]), projects: new Map([['PROJECT_ENG_1', 'Field notes']]), teams: new Set(['ENG']), teamZones: new Map() },
      manifest: { files: Object.keys(documents).map((path) => ({ path, synced: true, kind: 'markdown', class: null, canary: null })) },
      projects: new Map([['PROJECT_ENG_1', { id: 'project-api', name: 'Field notes' }]]), teams: new Map([['ENG', { id: 'team-eng', key: 'ENG' }]]), documentUrlBase: 'https://linear.app/example-team/document',
      seededDocuments: [],
    },
    proxy: null, owned: new OwnershipLedger(join(fixture.root, 'state'), names.runId), checkpoints: new CheckpointControl(join(fixture.root, 'hooks')),
    engine: { results: [], setupRuns: 0, env: {}, restores: [] }, edits: [], ownCommits: [], observations: new Map(), sequence: 0, uiSteps: 0,
    log: (message: string) => t.diagnostic(message), signal: t.signal, checkPollMs: 10, person: async () => person, personHooks: async () => {}, engineClone: async () => engine.dir,
  } as unknown as RunContext;
  const sync = async (command: 'sync' | 'initial-sync' = 'sync') => {
    const reportFile = join(fixture.root, 'report.json');
    const summaryFile = join(fixture.root, 'summary.md');
    await rm(reportFile, { force: true });
    await rm(summaryFile, { force: true });
    const env = engineInputs({ names, command, cwd: engine.dir, repository: 'owner/repo', credentials: { linearClientId: 'client-id', linearClientSecret: 'client-secret', githubToken: 'app-token' }, reportFile, summaryFile, hooksDir: ctx.checkpoints.dir, extraEnv: {}, timeoutMs: 30_000, linearUrl: LINEAR_API, mergeGraceSeconds: 0, direction: 'git-to-linear', confirm: true });
    await watchRun(ctx, { throughProxy: false }, async () => {
      const requests: LogEntry[] = [];
      const result = await runCli([command], { cwd: engine.dir, env: { ...env, PATH: process.env.PATH!, HOME: process.env.HOME!, MDBISYNC_GITHUB_API_URL: GITHUB_API, GITHUB_STEP_SUMMARY: summaryFile }, fetch: serve, log: (entry) => requests.push(entry) });
      assert.equal(result.exitCode, 0, result.stderr);
      ctx.engine.results.push({ command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, remote: { runId: ctx.engine.results.length, runAttempt: 1, linearEngine: true, requests }, report: JSON.parse(await readFile(reportFile, 'utf8')), summary: await readFile(summaryFile, 'utf8'), signal: null, durationMs: 0, timedOut: false, notImplemented: false } as EngineResult);
    });
  };
  const step = async (stepCtx: RunContext, next: Step) => {
    t.diagnostic(`${next.kind}.${next.action} ${JSON.stringify(next.args)}`);
    if (next.kind === 'run' && next.action === 'settle') {
      for (let i = 0; i < 4; i++) {
        await sync();
        if (stepCtx.engine.results.at(-1)?.report?.['changed'] === false) break;
      }
    } else if (next.kind === 'run' && (next.action === 'sync' || next.action === 'capture')) await sync();
    else if (next.kind === 'run' && next.action === 'initial-sync') await sync('initial-sync');
    // Other runs (lint, fix, workflows, cleanup) have no in-process counterpart here.
    else if (next.kind === 'run') throw new Error(`the fake-service specs cannot run run.${next.action}`);
    else await runStep(stepCtx, next);
  };
  const check = async () => {
    // I6 uses the same in-process engine transport as the scenario's own runs.
    const original = STEP_ACTIONS['run.sync'];
    STEP_ACTIONS['run.sync'] = async () => sync();
    // I5 reads the fake's pull request texts and comments: it has no comment query of its own.
    ctx.observations.set('canary.remoteTexts', Object.fromEntries([
      ...world.github.pullRequests.map((pr) => [`pull request #${pr.number}`, `${pr.title}\n${pr.body}`]),
      ...[...world.linear.comments].map(([id, c]) => [id, c.body]),
    ]));
    try {
      const outcomes = await runChecks(ctx);
      for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
    } finally { STEP_ACTIONS['run.sync'] = original!; }
  };
  const tracked = async (path: string) => {
    const result = await fixture.remote.run(['show', `refs/heads/${names.trackedBranch}:${path}`], { okCodes: [0, 128] });
    return result.code === 0 ? result.stdout.toString('utf8') : null;
  };
  const setUp = () => setupState(ctx, ctx.live as LiveWorld, { runStep: step });
  return { ctx, world, sync, step, setUp, check, tracked, cleanup: () => fixture.cleanup() };
}

/** Each step of the scenario after its setup ended, with the refs after it in `refHistory`. */
export async function runScenarioSteps(spec: SpecWorld): Promise<void> {
  const history = [await snapshotRefs(spec.ctx)];
  spec.ctx.observations.set('refHistory', history);
  for (const step of spec.ctx.scenario.steps) {
    await spec.step(spec.ctx, step);
    history.push(await snapshotRefs(spec.ctx));
    refreshView(spec.ctx);
  }
}
