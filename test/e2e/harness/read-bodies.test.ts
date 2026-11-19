import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { LinearClient } from '../../../src/linear/index.ts';
import { Git } from '../../../src/state/index.ts';
import { Governor, type App } from './governor.ts';
import { HELD_RUN_FILE, saveHeldRun, type HeldRun } from './held-run.ts';
import { acquireLock, registerRun } from './locks.ts';
import { OwnershipLedger } from './ownership.ts';
import { readHeldBodies } from './read-bodies.ts';
import { GitStateStore, SharedAdmission } from './shared-state.ts';
import { loadScenarios } from './spec.ts';

const runId = 'ab1234';
const scenario = loadScenarios().find(({ id }) => id === 'L6-13')!;
const app: App = {
  name: 'app2',
  readBudget: async () => ({ requestsRemaining: 5000, complexityRemaining: 2_000_000, resetAt: 0 }),
};

function fixture(t: TestContext) {
  const runDir = mkdtempSync(join(tmpdir(), 'read-bodies-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const stateDir = join(runDir, 'state');
  const held: HeldRun = {
    version: 1, runId, scenarioId: scenario.id, appName: app.name, holdUntil: Date.now() + 60_000,
    stepIndex: 0, startedAt: new Date().toISOString(), budgetWaitMs: 0,
    takeUpRequests: { harness: 0, harnessApp: 0 }, engine: { results: [], setupRuns: 0 },
    edits: [], ownCommits: [], sequence: 0, uiSteps: 0, proxyRequests: [],
    observations: new Map([['admission.owner', 'test-owner']]),
    live: {
      repository: 'example/sandbox', githubTokenSource: 'app',
      manifest: { seed: '', files: [] },
      tree: { teams: new Set(['ENG']), paths: new Map(), rewritten: new Map(), projects: new Map(), teamZones: new Map() },
      projects: new Map([['Field notes', { id: 'project-1', name: 'Field notes', createdAt: '2025-01-01' }]]),
      teams: new Map([['ENG', { id: 'team-1', key: 'ENG', name: 'Engineering' }]]),
      seededDocuments: [], documentUrlBase: 'https://example.com/document',
    },
  };
  const ids = new Map([['docs/garden.md', 'doc-1'], ['docs/harbor.md', 'doc-2']]);
  const report = join(runDir, 'read-bodies.json');
  saveHeldRun(runDir, held);
  registerRun(stateDir, runId, { holdUntil: held.holdUntil });
  return { runDir, stateDir, held, ids, report };
}

it('reads project and team-zone bodies through a query under the held app reservation', async (t) => {
  const { runDir, stateDir, held, ids, report } = fixture(t);
  const remote = join(runDir, 'control.git');
  await new Git(runDir).run(['init', '--bare', '--quiet', remote]);
  const store = new GitStateStore({ stateDir, url: remote });
  const governor = new Governor({ stateDir, apps: [app], shared: new SharedAdmission(store), maxWaitMs: 0 });
  t.after(() => store.close());
  const grant = await governor.admit(scenario, runId, { requests: 2, complexity: 800 }, app.name);
  await grant.claimZones!(['team-1']);
  new OwnershipLedger(stateDir, runId).record({ kind: 'document', id: 'doc-2', confirmed: true });
  held.observations.set('admission.owner', grant.owner);
  saveHeldRun(runDir, held);
  const before = readFileSync(join(runDir, HELD_RUN_FILE), 'utf8');
  const body = [
    'Spring schedule', '', '![Rose](https://images.example.com/rose.png)', '![Plan][plan]', '',
    '> [plan]: https://files.example.com/plan.png', '',
    '| Bed | Plants |', '| --- | --- |', '| East | 12 |', '',
    '```mermaid', 'graph TD; A-->B', '```', '', '<!-- linear:callout color=#f2c94c -->', '> [!NOTE]', '> Water weekly.',
  ].join('\n');
  const queries: string[][] = [];
  const client = new LinearClient({ token: 'fixture-token', fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    const { query, variables } = JSON.parse(String(init?.body));
    assert.match(query, /^query GetDocuments\b/);
    assert.equal(variables.withContent, true);
    queries.push(variables.ids);
    const current = (await store.read()).runs.find((run) => run.runId === runId);
    assert.ok(current?.revision, 'the held reservation was resumed before the query');
    const doc = {
      slugId: 'slug', icon: null, color: null, documentContentId: null,
      trashed: false, archivedAt: null, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    };
    const nodes = [
      { ...doc, id: 'doc-2', title: 'README', content: '![Plan](https://uploads.linear.app/signed-path?token=fixture-signature)', project: null, team: { id: 'team-1' } },
      { ...doc, id: 'doc-1', title: 'Garden notes', content: body, project: { id: 'project-1' }, team: null },
    ];
    return Response.json({ data: { documents: { nodes: nodes.filter(({ id }) => variables.ids.includes(id)) } } });
  } });
  const deps = {
    stateDir, scenarios: [scenario], readIds: async () => ids,
    connect: async (selected: HeldRun) => {
      assert.equal(selected.appName, app.name);
      return { client, governor };
    },
  };

  assert.equal(await readHeldBodies(runDir, undefined, deps), 2);
  assert.deepEqual(queries, [['doc-1', 'doc-2']]);
  const raw = readFileSync(report, 'utf8');
  const evidence = JSON.parse(raw);
  assert.doesNotMatch(raw, /signed-path|fixture-signature|fixture-token/);
  const readmeUrl = evidence.documents[1]?.images[0]?.url;
  assert.match(readmeUrl, /^https:\/\/uploads\.linear\.app\/redacted-[0-9a-f]{64}$/);
  assert.deepEqual(evidence, {
    runId, scenarioId: scenario.id,
    documents: [{
      path: 'docs/garden.md', title: 'Garden notes', firstScreen: body,
      images: [
        { url: 'https://images.example.com/rose.png', host: 'images.example.com' },
        { url: 'https://files.example.com/plan.png', host: 'files.example.com' },
      ],
      tables: ['| Bed | Plants |\n| --- | --- |\n| East | 12 |'],
      diagrams: ['```mermaid\ngraph TD; A-->B\n```'],
      callouts: ['<!-- linear:callout color=#f2c94c -->\n> [!NOTE]\n> Water weekly.'],
    }, {
      path: 'docs/harbor.md', title: 'README', firstScreen: `![Plan](${readmeUrl})`,
      images: [{ url: readmeUrl, host: 'uploads.linear.app' }], tables: [], diagrams: [], callouts: [],
    }],
  });
  assert.equal(statSync(report).mode & 0o777, 0o600);
  assert.equal(await readHeldBodies(runDir, ['docs/harbor.md', 'docs/harbor.md'], deps), 1);
  assert.deepEqual(queries.at(-1), ['doc-2']);
  assert.equal(readFileSync(join(runDir, HELD_RUN_FILE), 'utf8'), before);
  assert.equal((await store.read()).runs[0]?.owner, grant.owner);
  assert.deepEqual((await store.read()).runs[0]?.zones, ['team-1']);
});

it('refuses a locked run, unknown paths and expired holds before connecting to Linear', async (t) => {
  const { runDir, stateDir, held, ids, report } = fixture(t);
  const deps = {
    stateDir, scenarios: [scenario], readIds: async () => ids,
    connect: async () => assert.fail('must not connect'),
  };
  const lock = await acquireLock(`ui-result-${runId}`, { stateDir, runId, timeoutMs: 0 });
  try {
    await assert.rejects(readHeldBodies(runDir, undefined, deps), /ui-result/);
  } finally {
    lock.release();
  }
  await assert.rejects(readHeldBodies(runDir, undefined, { ...deps, stateDir: join(runDir, 'wrong-state') }), /needs its original state directory/);
  await assert.rejects(readHeldBodies(runDir, ['docs/missing.md'], deps), /requested path/);
  saveHeldRun(runDir, { ...held, holdUntil: 1 });
  await assert.rejects(readHeldBodies(runDir, undefined, deps), /hold has ended/);
  assert.equal(existsSync(report), false);
});

it('refuses missing and out-of-run documents without writing a partial report', async (t) => {
  const { runDir, stateDir, held, ids, report } = fixture(t);
  let documents: Awaited<ReturnType<LinearClient['getDocuments']>> = [];
  const deps = {
    stateDir, scenarios: [scenario], readIds: async () => ids,
    connect: async () => ({
      client: { getDocuments: async () => documents },
      governor: { admit: async () => ({
        app, owner: String(held.observations.get('admission.owner')),
        waitedMs: 0, budgetBefore: await app.readBudget(), release: () => assert.fail('must retain the reservation'),
      }) },
    }),
  };
  await assert.rejects(readHeldBodies(runDir, ['docs/garden.md'], deps), /document is missing/);
  documents = [{
    id: 'doc-1', title: `${runId}/Garden notes`, content: 'Outside the run', projectId: null, teamId: 'other-team',
    slugId: '', icon: null, color: null, documentContentId: null, trashed: false, archivedAt: null, createdAt: '', updatedAt: '',
  }];
  await assert.rejects(readHeldBodies(runDir, ['docs/garden.md'], deps), /outside the held run/);
  assert.equal(existsSync(report), false);
});

it('exposes read-bodies through the CLI and rejects a missing hold before authenticating', async (t) => {
  const { runDir } = fixture(t);
  const run = promisify(execFile)(process.execPath, ['test/e2e/harness/cli.ts', 'read-bodies', join(runDir, 'missing')], {
    env: { PATH: process.env.PATH, MDBISYNC_TEST_CONFIG_DIR: runDir },
  });
  await assert.rejects(run, { code: 1, stdout: '', stderr: /holds no run waiting for its UI steps/ });
});
