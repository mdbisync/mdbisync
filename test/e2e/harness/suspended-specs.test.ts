// Execute the live specs against local git and the same service fakes as the
// engine tests. The scenario's actions and assertions remain the live ones.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { runCli } from '../../../src/cli.ts';
import { LinearClient, type LogEntry } from '../../../src/linear/index.ts';
import { fakeFetch, fakeWorld, GITHUB_API, LINEAR_API, type FakeCheck } from '../../../src/setup/test-helpers.ts';
import { createFixture, IDENTITY } from '../../../src/state/test-helpers.ts';
import { CHECK_MARKER, CHECK_WORKFLOW, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { CheckpointControl } from './checkpoints.ts';
import { runChecks, snapshotRefs, budgetHolds } from './checks.ts';
import { rerunCheckAsPerson } from './check-fault.ts';
import type { RunContext } from './context.ts';
import { engineInputs, type EngineResult } from './engine.ts';
import { SandboxRest } from './github.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios } from './spec.ts';
import { runStep, watchRun, STEP_ACTIONS } from './steps.ts';
import { BEFORE_VIEW, refreshView, takeStartView } from './subjects.ts';

for (const scenario of loadScenarios().filter((s) => s.id === 'L5-17' || /^L5-(2[3-9]|3[0-5])$/.test(s.id))) {
  it(`${scenario.id}: live steps and assertions on fake services`, { timeout: 180_000, skip: scenario.id === 'L5-34' ? 'requires the engine checkpoint before-suspension-push' : false }, async (t) => {
    const fixture = await createFixture();
    try {
      const names = runNames('aaaaaa');
      const count = scenario.id === 'L5-35' ? 65 : 3;
      const documents = Object.fromEntries(Array.from({ length: count }, (_, i) => [`eng/notes/item-${String(i).padStart(2, '0')}.md`, `# Notes ${i}\n\nFirst paragraph.\n\nSecond paragraph.\n`]));
      const tree = { 'eng/notes/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n', ...documents, '.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/hooks\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n', [CHECK_WORKFLOW_PATH]: CHECK_WORKFLOW };
      await fixture.seed(tree, { branch: names.trackedBranch });
      const world = fakeWorld();
      const transport = fakeFetch(world);
      world.github.checks = new Map();
      const attempts = new Map<string, number>();
      const checks = new Map<string, FakeCheck>();
      const show = async (sha: string, path: string) => {
        const result = await fixture.remote.run(['show', `${sha}:${path}`], { okCodes: [0, 128] });
        return result.code === 0 ? result.stdout.toString('utf8') : null;
      };
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const sha = /\/commits\/([0-9a-f]+)\/check-runs/.exec(url)?.[1];
        if (sha !== undefined) {
          const marker = (await show(sha, CHECK_MARKER))?.trim();
          const target = (await show(sha, '.harness-check-target'))?.trim();
          const passed = marker === undefined || await show(sha, '.harness-check-fixed') !== null || (marker === 'flaky' && (attempts.get(sha) ?? 1) > 1) || (marker === 'document' && target !== undefined && (await show(sha, target))?.includes('Approved for review.'));
          const check = checks.get(sha) ?? { name: 'format', status: 'completed' };
          Object.assign(check, { status: marker === 'pending' && !passed ? 'queued' : 'completed', conclusion: passed ? 'success' : 'failure', annotations: (target === undefined ? [] : [target]).map((path) => ({ path, start_line: 1, title: 'Review required', message: 'Check the review status.' })) });
          checks.set(sha, check);
          world.github.checks!.set(sha, [check]);
          const response = await transport(String(input).replace('https://api.github.com', GITHUB_API), init);
          const data = await response.json() as { check_runs: Array<Record<string, unknown>> };
          for (const run of data.check_runs) Object.assign(run, { app: { slug: 'github-actions' }, html_url: `https://github.com/owner/repo/actions/runs/${run.id}` });
          return Response.json(data);
        }
        if (url.includes('/actions/workflows/harness-check.yml/runs')) {
          const sha = new URL(url).searchParams.get('head_sha')!;
          return Response.json({ workflow_runs: [{ id: 1, head_sha: sha, path: CHECK_WORKFLOW_PATH, status: 'completed' }] });
        }
        if (url.endsWith('/actions/runs/1/rerun-failed-jobs')) {
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer person-token');
          const sha = (await fixture.remote.text(['rev-parse', 'refs/heads/t/aaaaaa/suspended'])).trim();
          attempts.set(sha, 2);
          return new Response(null, { status: 201 });
        }
        const prFiles = /\/pulls\/(\d+)\/files/.exec(url);
        if (prFiles !== null) {
          const pr = world.github.pullRequests.find((p) => p.number === Number(prFiles[1]))!;
          const diff = await fixture.remote.text(['diff', '--name-only', `refs/heads/${pr.base}`, `refs/heads/${pr.head}`]);
          return Response.json(diff.split('\n').filter(Boolean).map((filename) => ({ filename, status: 'modified' })));
        }
        if (url.includes('/pulls')) {
          const response = await transport(String(input).replace('https://api.github.com', GITHUB_API), init);
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
        }
        if (init?.body && url.endsWith('/graphql')) {
          const body = JSON.parse(String(init.body));
          if (['DocumentComments', 'SuspendedComments'].includes(body.operationName)) {
            const id = `content-${body.variables.id}`;
            const nodes = [...world.linear.comments].filter(([, c]) => c.documentContentId === id).map(([id, c]) => ({ id, body: c.body, resolvedAt: c.resolved ? new Date().toISOString() : null, createdAt: new Date().toISOString() }));
            return Response.json({ data: { document: { comments: { nodes } } } });
          }
        }
        return transport(String(input).replace('https://api.github.com', GITHUB_API), init);
      };
      world.github.merge = async (pr, sha) => {
        const base = (await fixture.remote.text(['rev-parse', `refs/heads/${pr.base}`])).trim();
        const result = await fixture.remote.run(['merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
        if (result.code !== 0) return { status: 405 };
        const commit = (await fixture.remote.text(['commit-tree', result.stdout.toString().split('\n')[0]!, '-p', base, '-p', sha, '-m', 'Merge the reviewed changes'], { env: { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email } })).trim();
        await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
        return { sha: commit };
      };
      const rest = new SandboxRest({ owner: 'owner', repo: 'repo' }, 'app-token', fetchImpl);
      const app = new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fetchImpl });
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
        },
        proxy: null, owned: new OwnershipLedger(join(fixture.root, 'state'), names.runId), checkpoints: new CheckpointControl(join(fixture.root, 'hooks')),
        engine: { results: [], setupRuns: 0, env: {}, restores: [] }, edits: [], ownCommits: [], observations: new Map(), sequence: 0, uiSteps: 0,
        log: (message: string) => t.diagnostic(message), signal: t.signal, person: async () => person, personHooks: async () => {}, engineClone: async () => engine.dir,
      } as unknown as RunContext;
      const sync = async (command: 'sync' | 'initial-sync' = 'sync', args: Record<string, unknown> = {}) => {
        const reportFile = join(fixture.root, 'report.json');
        const summaryFile = join(fixture.root, 'summary.md');
        await rm(reportFile, { force: true });
        await rm(summaryFile, { force: true });
        const env = engineInputs({ names, command, cwd: engine.dir, repository: 'owner/repo', credentials: { linearClientId: 'client-id', linearClientSecret: 'client-secret', githubToken: 'app-token' }, reportFile, summaryFile, hooksDir: ctx.checkpoints.dir, extraEnv: {}, timeoutMs: 30_000, linearUrl: LINEAR_API, mergeGraceSeconds: Number(args.mergeGraceSeconds ?? 0), ...(typeof args.checkDeadlineMinutes === 'number' ? { checkDeadlineMinutes: args.checkDeadlineMinutes } : {}), direction: 'git-to-linear', confirm: true });
        await watchRun(ctx, { throughProxy: false }, async () => {
          const beforeDocuments = new Map(world.linear.documents.map((d) => [d.id, { ...d }]));
          const beforeComments = new Map([...world.linear.comments].map(([id, c]) => [id, { ...c }]));
          const requests: LogEntry[] = [];
          const result = await runCli([command], { cwd: engine.dir, env: { ...env, PATH: process.env.PATH!, HOME: process.env.HOME!, MDBISYNC_GITHUB_API_URL: GITHUB_API, GITHUB_STEP_SUMMARY: summaryFile }, fetch: fetchImpl, log: (entry) => requests.push(entry) });
          assert.equal(result.exitCode, 0, result.stderr);
          ctx.engine.results.push({ command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, remote: { runId: ctx.engine.results.length, runAttempt: 1, linearEngine: true, requests }, report: JSON.parse(await readFile(reportFile, 'utf8')), summary: await readFile(summaryFile, 'utf8'), signal: null, durationMs: 0, timedOut: false, notImplemented: false } as EngineResult);
          if (scenario.id === 'L5-35') {
            const writes = world.linear.documents.filter((d) => {
              const before = beforeDocuments.get(d.id);
              return before === undefined || ['content', 'title', 'projectId', 'teamId', 'trashed'].some((key) => d[key as keyof typeof d] !== before[key as keyof typeof before]);
            }).length;
            // Count changed suspended documents from the service, including clears
            // that capture finishes after the lane's own holdMarks report.
            const changed = new Set([...world.linear.comments].flatMap(([id, c]) => {
              const before = beforeComments.get(id);
              return c.body.includes('Check `') && (before === undefined || before.body !== c.body || before.resolved !== c.resolved) ? [c.documentContentId] : [];
            }));
            const count = requests.filter((r) => r.kind !== 'oauth').length;
            assert.ok(budgetHolds(count, writes, 1, changed.size), `I9 per run: ${count} requests, ${writes} document writes, ${changed.size} hold changes`);
          }
        });
      };
      await sync('initial-sync');
      ctx.engine.setupRuns = 1;
      const history = [await snapshotRefs(ctx)];
      ctx.observations.set('refHistory', history);
      ctx.observations.set('start.refs', history[0]);
      ctx.observations.set(BEFORE_VIEW, await takeStartView(ctx));
      for (const step of scenario.steps) {
        t.diagnostic(`${step.kind}.${step.action} ${JSON.stringify(step.args)}`);
        if (step.kind === 'run') {
          if (step.action === 'settle') {
            for (let i = 0; i < 4; i++) {
              await sync('sync', step.args);
              if (ctx.engine.results.at(-1)?.report?.['changed'] === false) break;
            }
          } else await sync('sync', step.args);
        } else if (step.action === 'rerun-suspended-check') {
          await rerunCheckAsPerson(ctx, new SandboxRest({ owner: 'owner', repo: 'repo' }, 'person-token', fetchImpl));
        } else await runStep(ctx, step);
        history.push(await snapshotRefs(ctx));
        refreshView(ctx);
      }
      // I6 uses the same in-process engine transport as the scenario's own runs.
      const original = STEP_ACTIONS['run.sync'];
      STEP_ACTIONS['run.sync'] = async () => sync();
      ctx.observations.set('canary.remoteTexts', Object.fromEntries([...world.linear.comments].map(([id, c]) => [id, c.body])));
      try {
        const outcomes = await runChecks(ctx);
        for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
      } finally { STEP_ACTIONS['run.sync'] = original!; }
    } finally { await fixture.cleanup(); }
  });
}
