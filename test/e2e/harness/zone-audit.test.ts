// Every audited zone-concurrent contract, run by two runs in disjoint team
// zones that share one sandbox remote and one in-memory Linear workspace.
// Each run takes its start view and runs the scenario's Git and Linear steps
// through the production executors; engine runs are replaced by a recorded
// report, since the engine's own reads are scoped by the team lease. Then
// each run evaluates its scoped invariants and every subject its assertions
// name, first alone and then both at once while a third run writes foreign
// documents, comments, projects, refs and pull requests between their reads.
// Each run's values must equal its solo values.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, it } from 'node:test';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { Git } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { evaluateAssertion, INVARIANT_CHECKS, readSides } from './checks.ts';
import { AUDITED_CONTRACTS, assertionSubjects, zoneConcurrent } from './concurrency.ts';
import type { LiveWorld, RunContext } from './context.ts';
import type { EngineResult } from './engine.ts';
import { SandboxRest, type PullRequest } from './github.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import { recordStart } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios, type Scenario } from './spec.ts';
import { runStep } from './steps.ts';
import { refreshView, resolveSubject } from './subjects.ts';

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

/** One in-memory workspace for every run; `onRead` runs before each read answers. */
class SharedLinear {
  documents = new Map<string, LinearDocument>();
  comments = new Map<string, string[]>();
  onRead: (() => Promise<void>) | undefined;
  #next = 0;

  add(place: { projectId?: string | undefined; teamId: string }, title: string, content: string): LinearDocument {
    this.#next += 1;
    const id = `doc-${this.#next}`;
    const document: LinearDocument = { id, title, slugId: String(this.#next).padStart(12, '0'), icon: null, color: null, content, documentContentId: `content-${id}`,
      projectId: place.projectId ?? null, teamId: place.teamId, trashed: false, archivedAt: null, createdAt: '', updatedAt: '' };
    this.documents.set(id, document);
    return document;
  }

  async listDocuments(place: { projectId?: string; teamId?: string }, options: { includeArchived?: boolean } = {}) {
    await this.onRead?.();
    return [...this.documents.values()]
      .filter((document) => (place.projectId !== undefined ? document.projectId === place.projectId : document.teamId === place.teamId))
      .filter((document) => options.includeArchived === true || (!document.trashed && document.archivedAt === null))
      .map((document) => ({ ...document }));
  }

  async getDocuments(ids: readonly string[]) {
    await this.onRead?.();
    return ids.flatMap((id) => (this.documents.has(id) ? [{ ...(this.documents.get(id) as LinearDocument) }] : []));
  }

  async getDocument(id: string) {
    await this.onRead?.();
    const document = this.documents.get(id);
    return document === undefined ? null : { ...document };
  }

  async createDocument(place: { projectId?: string; teamId?: string }, input: { title: string; content?: string }) {
    const project = [...this.documents.values()].find((document) => document.projectId === place.projectId);
    return this.add({ projectId: place.projectId, teamId: place.teamId ?? project?.teamId ?? 'team-unknown' }, input.title, input.content ?? '');
  }

  async updateDocument(id: string, patch: Partial<LinearDocument>) {
    const document = this.documents.get(id) as LinearDocument;
    Object.assign(document, patch);
    return { ...document };
  }

  async request<T>(operation: string, _kind: string, _query: string, variables: Record<string, unknown> = {}): Promise<T> {
    await this.onRead?.();
    if (operation === 'DocumentComments') {
      return { document: { comments: { nodes: (this.comments.get(String(variables.id)) ?? []).map((body, index) => ({ body, createdAt: new Date(index).toISOString() })) } } } as T;
    }
    if (operation === 'RunComments') {
      const filter = variables.filter as { project?: { id: { eq: string } }; team?: { id: { eq: string } }; title?: { startsWith: string }; id?: { in: string[] } };
      const nodes = [...this.documents.values()]
        .filter((document) => variables.includeArchived === true || (!document.trashed && document.archivedAt === null))
        .filter((document) => filter.project === undefined || document.projectId === filter.project.id.eq)
        .filter((document) => filter.team === undefined || document.teamId === filter.team.id.eq)
        .filter((document) => filter.title === undefined || document.title.startsWith(filter.title.startsWith))
        .filter((document) => filter.id === undefined || filter.id.in.includes(document.id))
        .map((document) => ({ id: document.id, project: document.projectId === null ? null : { id: document.projectId }, comments: { nodes: (this.comments.get(document.id) ?? []).map((body) => ({ body })) } }));
      return { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } as T;
    }
    throw new Error(`the shared fake Linear has no ${operation}`);
  }
}

/** One run's team, team-zone folder and project folder. */
interface Zone { runId: string; team: string; teamId: string; folder: string; projectId: string }

const A: Zone = { runId: 'aaaaaa', team: 'ENG', teamId: 'team-eng', folder: 'eng', projectId: 'project-a' };
const B: Zone = { runId: 'bbbbbb', team: 'DOCS', teamId: 'team-docs', folder: 'docs', projectId: 'project-b' };
/** The third run whose writes the two runs must never see. */
const FOREIGN = runNames('cccccc');

function treeOf(zone: Zone, projectName: string): Record<string, string> {
  return {
    [`${zone.folder}/README.md`]: `---\nlinear-team: ${zone.team}\n---\n`,
    [`${zone.folder}/backend/api.md`]: '# API\n\nThe service answers within a second.\n',
    [`${zone.folder}/platform/README.md`]: `---\nlinear-project: ${projectName}\n---\n`,
    [`${zone.folder}/platform/plan.md`]: '---\nowner: platform\n---\n# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n',
    [`${zone.folder}/platform/notes.md`]: '# Notes\n\nKept short.\n',
  };
}

/** A finished engine run with a fixed report; the engine itself never runs offline. */
function recordedRun(command: string): EngineResult {
  const report = { code: 'initial-sync-required', changed: false, securityHooks: { configured: true }, setupChecks: [{ name: 'security-hooks', state: 'ok' }] };
  return { command: command as EngineResult['command'], exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report };
}

async function world(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'zone-audit-')); roots.push(root);
  const remote = join(root, 'sandbox.git');
  await new Git(root, IDENTITY).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  const seed = new Git(join(root, 'seed'), IDENTITY);
  await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
  await seed.run(['commit', '--quiet', '--allow-empty', '-m', 'Sandbox']);
  await seed.run(['push', '--quiet', remote, 'HEAD:refs/heads/main']);
  const linear = new SharedLinear();
  const pulls: PullRequest[] = [];
  const pull = (ref: string, merge?: string): PullRequest => ({ number: pulls.length + 1, state: merge === undefined ? 'open' : 'closed', title: 'Sync', body: null,
    head: { ref, sha: merge ?? '0'.repeat(40) }, base: { ref: 'main' }, merged_at: merge === undefined ? null : 'now', created_at: '', user: { login: 'sync-app[bot]' }, merge_commit_sha: merge ?? null });
  const fetchPulls = (async (input: string | URL | Request) => {
    await linear.onRead?.();
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls') && url.searchParams.get('page') === '1') return Response.json([...pulls].reverse());
    if (url.pathname.endsWith('/pulls')) return Response.json([]);
    throw new Error(`no fake for ${url.pathname}`);
  }) as typeof fetch;

  const run = async (zone: Zone) => {
    const names = runNames(zone.runId);
    const project = { id: zone.projectId, name: names.project(0), createdAt: '' };
    const files = treeOf(zone, project.name);
    const branch = new Git(join(root, `seed-${zone.runId}`), IDENTITY);
    await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', branch.dir]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(branch.dir, path)), { recursive: true });
      writeFileSync(join(branch.dir, path), text);
    }
    await branch.run(['add', '--all']);
    await branch.run(['commit', '--quiet', '-m', 'Starting tree']);
    await branch.run(['push', '--quiet', remote, `HEAD:refs/heads/${names.trackedBranch}`]);
    const stateDir = join(root, `state-${zone.runId}`);
    const owned = new OwnershipLedger(stateDir, names.runId);
    if (scenario.setup.state === 'converged') {
      // The converged start: every document in Linear and the ids ref the initial sync recorded.
      const ids: Record<string, { id: string }> = {};
      ids[`${zone.folder}/backend/api.md`] = { id: linear.add({ teamId: zone.teamId }, `${names.teamZonePrefix}backend/api`, '# API\n\nThe service answers within a second.\n').id };
      for (const name of ['plan', 'notes']) ids[`${zone.folder}/platform/${name}.md`] = { id: linear.add({ projectId: zone.projectId, teamId: zone.teamId }, name, files[`${zone.folder}/platform/${name}.md`]!.replace(/^---\n[\s\S]*?\n---\n/, '')).id };
      const blob = (await branch.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(ids) })).trim();
      const tree = (await branch.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
      const commit = (await branch.text(['commit-tree', tree, '-m', 'ids'])).trim();
      await branch.run(['push', '--quiet', remote, `${commit}:${names.refPrefix}/ids`]);
      linear.comments.set(ids[`${zone.folder}/platform/plan.md`]!.id, ['Reviewed in the weekly meeting.']);
      // The fault proxy records every document the setup's initial sync creates.
      for (const { id } of Object.values(ids)) owned.record({ kind: 'document', id, confirmed: true });
    }
    const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir, runId: names.runId });
    await sandbox.refreshCache();
    const live: LiveWorld = {
      sandbox,
      rest: new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', fetchPulls),
      githubToken: 'unused',
      githubTokenSource: 'host',
      repository: 'example/sandbox',
      manifest: { seed: 'test', files: Object.keys(files).map((path) => ({ path, group: 'work-documents', kind: 'markdown' as const, synced: true, lfs: false, canary: null, class: null, rule: null })) },
      tree: {
        paths: new Map(Object.keys(files).map((path) => [path, path])),
        rewritten: new Map([[`${zone.folder}/platform/README.md`, files[`${zone.folder}/platform/README.md`]!]]),
        projects: new Map([['PROJECT_1', project.name]]),
        teamZones: new Map([[zone.team, zone.folder]]),
        teams: new Set([zone.team]),
      },
      projects: new Map([['PROJECT_1', project]]),
      teams: new Map([[zone.team, { id: zone.teamId, key: zone.team, name: zone.team }]]),
      app: linear as never,
      editors: { 'editor-a': linear as never, 'editor-b': linear as never },
      world: {} as never,
      engineApp: { clientId: 'id', clientSecret: 'secret' },
      seededDocuments: [],
      download: async () => Buffer.alloc(0),
      documentUrlBase: 'https://linear.app/test/document',
    };
    let person: Git | undefined;
    const ctx: RunContext = {
      scenario: structuredClone(scenario), names, runDir: join(root, `run-${zone.runId}`), live, sandbox, proxy: null,
      owned, checkpoints: new CheckpointControl(join(root, `run-${zone.runId}`, 'hooks')),
      engine: { results: [], setupRuns: 0, env: {}, restores: [] }, edits: [], ownCommits: [], observations: new Map(), uiSteps: 0, sequence: 0,
      log: () => {}, phase: () => {}, signal: new AbortController().signal,
      async person() { person ??= await sandbox.clone(names, join(root, `run-${zone.runId}`, 'person')); return person; },
      async personHooks() {},
      async engineClone() { return join(root, `run-${zone.runId}`, 'engine'); },
      async corpusFile() { return null; },
    };
    await recordStart(ctx, live);
    for (const step of scenario.steps) {
      if (step.kind === 'run') ctx.engine.results.push(recordedRun(step.action));
      else await runStep(ctx, step);
    }
    // The engine's sync pull request of this run, merged into its tracked branch.
    if (scenario.steps.some((step) => step.kind === 'run' && step.action !== 'initial-sync')) {
      pulls.push(pull(names.syncBranch, (await (await ctx.person()).text(['rev-parse', 'HEAD'])).trim()));
    }
    ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
    ctx.observations.set('scenario.proxyEnd', 0);
    return ctx;
  };
  const a = await run(A);
  const b = await run(B);

  let writes = 0;
  let queue = Promise.resolve();
  // One foreign writer: its writes run one at a time, whichever run's read triggers them.
  const foreign = () => (queue = queue.then(write));
  const write = async () => {
    // A third run writes into both team zones and foreign projects, comments, trashes,
    // pushes its own refs and opens pull requests; the two runs' documents only change updatedAt.
    writes += 1;
    for (const zone of [A, B]) {
      linear.add({ teamId: zone.teamId }, `${FOREIGN.teamZonePrefix}backend/api`, `# API\n\nForeign ${writes}.\n`);
      linear.add({ teamId: zone.teamId }, 'README', `Unowned ${writes}.\n`);
      const other = linear.add({ projectId: `foreign-${zone.projectId}`, teamId: zone.teamId }, 'plan', `Foreign plan ${writes}.\n`);
      linear.comments.set(other.id, [`Foreign comment ${writes}.`]);
      if (writes > 1) Object.assign(linear.documents.get(`doc-${linear.documents.size - 4}`) as LinearDocument, { trashed: true, archivedAt: 'now' });
    }
    for (const document of linear.documents.values()) if (!document.title.startsWith(FOREIGN.teamZonePrefix)) document.updatedAt = String(writes);
    pulls.push(pull(FOREIGN.syncBranch, writes % 2 === 0 ? 'f'.repeat(40) : undefined));
    if (writes % 3 === 1) {
      const commit = (await seed.text(['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', `foreign ${writes}`])).trim();
      await seed.run(['push', '--quiet', remote, `+${commit}:refs/heads/${FOREIGN.trackedBranch}`, `+${commit}:${FOREIGN.refPrefix}/ids`, `+${commit}:refs/heads/${FOREIGN.syncBranch}`]);
    }
  };
  return { a, b, linear, foreign, writes: () => writes };
}

/** What the run's checks see: its scoped invariants and every value its assertions name. */
async function inspect(ctx: RunContext) {
  refreshView(ctx);
  const errorOf = (error: unknown) => ({ error: (error as Error).message });
  let cached: ReturnType<typeof readSides> | undefined;
  const sides = () => (cached ??= readSides(ctx, { allowNoIds: true }));
  const invariants = [];
  for (const id of ['I1', 'I2', 'I7', 'I8'] as const) invariants.push(await INVARIANT_CHECKS[id](ctx, sides).catch(errorOf));
  const subjects: Record<string, unknown> = {};
  for (const subject of assertionSubjects(ctx.scenario)) subjects[subject] = await resolveSubject(ctx, subject).catch(errorOf);
  const assertions = [];
  for (const assertion of ctx.scenario.checks.assertions) assertions.push(await evaluateAssertion(ctx, assertion).catch(errorOf));
  return { invariants, subjects, assertions };
}

const audited = loadScenarios().filter((scenario) => AUDITED_CONTRACTS.includes(scenario.id));

it('runs every audited contract, and only those, as zone-concurrent', () => {
  assert.deepEqual(audited.map((scenario) => scenario.id), [...AUDITED_CONTRACTS].sort());
  for (const scenario of audited) assert.equal(zoneConcurrent(scenario), true, scenario.id);
});

for (const scenario of audited) {
  it(`${scenario.id}: interleaved with foreign writes, each run keeps its solo result`, async () => {
    const { a, b, linear, foreign, writes } = await world(scenario);
    const soloA = await inspect(a);
    const soloB = await inspect(b);
    // The solo values are real values, not one harness error repeated: every subject resolves.
    for (const solo of [soloA, soloB]) {
      for (const [subject, value] of Object.entries(solo.subjects)) assert.ok(!('error' in (value as object)), `${scenario.id} ${subject}: ${JSON.stringify(value)}`);
      for (const check of solo.invariants) assert.ok(!('error' in check), `${scenario.id}: ${JSON.stringify(check)}`);
    }
    linear.onRead = foreign;
    const [concurrentA, concurrentB] = await Promise.all([inspect(a), inspect(b)]);
    linear.onRead = undefined;
    assert.ok(writes() >= 4, 'the foreign run wrote between the reads');
    assert.deepEqual(concurrentA, soloA, `${scenario.id} in ${A.team}`);
    assert.deepEqual(concurrentB, soloB, `${scenario.id} in ${B.team}`);
  });
}

it('fails a by-id read that leaves the run scope instead of reading it', async () => {
  const scenario = audited.find((item) => item.id === 'L2-23')!;
  const { a, linear } = await world(scenario);
  // A product bug points this run's target at the other run's document.
  const foreignId = [...linear.documents.values()].find((document) => document.projectId === B.projectId)!.id;
  // The step recorded an id the ids ref no longer maps and the scoped lists do not hold: the subject reads it by id.
  a.observations.set('target.id', foreignId);
  a.observations.set('target.path', `${A.folder}/platform/gone.md`);
  refreshView(a);
  for (const subject of ['ids.documentId', 'documents.title', 'documents.body']) await assert.rejects(resolveSubject(a, subject), /outside the leased run scope/, subject);
  // Read for an exclusive scenario, the same document is accepted: only audited contracts are guarded.
  a.scenario = { ...a.scenario, id: 'L2-22' };
  refreshView(a);
  assert.deepEqual(await resolveSubject(a, 'ids.documentId'), { known: true, value: foreignId });
});
