// Run a live scenario's steps and checks against local git and the same
// service fakes as the engine tests, with the real engine in process. The
// scenario's actions and assertions remain the live ones; only the services
// are fakes.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { runCli } from '../../../src/cli.ts';
import { LinearClient, type LogEntry } from '../../../src/linear/index.ts';
import { fakeFetch, fakeWorld, GITHUB_API, LINEAR_API, type FakeWorld } from '../../../src/setup/test-helpers.ts';
import { createFixture, mergeOnGitHub } from '../../../src/state/test-helpers.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs } from './checks.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { engineInputs, type EngineResult } from './engine.ts';
import { SandboxRest } from './github.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import type { CheckOutcome } from './results.ts';
import { setupState } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import type { Scenario, Step } from './spec.ts';
import { runStep, watchRun, STEP_ACTIONS } from './steps.ts';
import { refreshView } from './subjects.ts';

export interface FakeServiceOptions {
  /** Adjusts the fake world before anything runs. */
  prepare?: (world: FakeWorld) => void;
  /** Reads the run once its checks ran, while its fixture still exists. */
  inspect?: (ctx: RunContext) => Promise<void>;
}

/** Two documents of two paragraphs each, for specs that need no content of their own. */
export const DOCUMENTS: Readonly<Record<string, string>> = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`eng/notes/item-${i}.md`, `# Notes ${i}\n\nFirst paragraph.\n\nSecond paragraph.\n`]));

/**
 * Seeds `documents` into the project folder `eng/notes` (Linear project
 * "Field notes"), runs the live setup of the scenario's `setup.state` (for a
 * converged start the initial sync, for a conflicted one also the setup
 * conflict and the runs that bring it to the tracked branch), then the
 * scenario's steps and its checks, and returns the checks' outcomes.
 */
export async function runOnFakeServices(t: TestContext, scenario: Scenario, documents: Readonly<Record<string, string>>, options: FakeServiceOptions = {}): Promise<CheckOutcome[]> {
  const fixture = await createFixture();
  try {
    const names = runNames('aaaaaa');
    const tree = { 'eng/notes/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n', ...documents, '.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/hooks\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n' };
    await fixture.seed(tree, { branch: names.trackedBranch });
    const world = fakeWorld();
    // No check workflow in the tree: the head has no checks, as in the live specs.
    world.github.checks = new Map();
    options.prepare?.(world);
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
    // GitHub's merge, which refuses a rename against an edit that only git's rename detection pairs.
    world.github.merge = (pr, sha) => mergeOnGitHub(fixture, pr, sha, 'Merge the reviewed changes');
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
        tree: { paths: new Map(Object.keys(documents).map((p) => [p, p])), rewritten: new Map([['eng/notes/README.md', tree['eng/notes/README.md']]]), projects: new Map([['PROJECT_ENG_1', 'Field notes']]), teams: new Set(['ENG']), teamZones: new Map() },
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
    // Sync runs go to the in-process engine, the other steps to the harness's executors.
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
    await setupState(ctx, ctx.live as LiveWorld, { runStep: step });
    const history = [await snapshotRefs(ctx)];
    ctx.observations.set('refHistory', history);
    for (const next of scenario.steps) {
      await step(ctx, next);
      history.push(await snapshotRefs(ctx));
      refreshView(ctx);
    }
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
      await options.inspect?.(ctx);
      return outcomes;
    } finally { STEP_ACTIONS['run.sync'] = original!; }
  } finally { await fixture.cleanup(); }
}
