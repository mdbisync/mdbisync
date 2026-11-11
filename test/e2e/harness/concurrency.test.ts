import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, it } from 'node:test';
import type { LinearDocument } from '../../../src/linear/index.ts';
import type { IdMap } from '../../../src/state/index.ts';
import type { RunContext } from './context.ts';
import { AUDITED_CONTRACTS, AUDITED_STEPS, AUDITED_SUBJECTS, zoneConcurrent } from './concurrency.ts';
import { loadScenarios } from './spec.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import { annotatedFolders } from './corpus.ts';
import { readRunDocuments, isolationSnapshot, INVARIANT_CHECKS, evaluateAssertion, type Sides } from './checks.ts';
import { BEFORE_VIEW } from './subjects.ts';
import { requireStoppedLocalRun } from './locks.ts';

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scenario = loadScenarios().find((item) => item.id === 'L1-05')!;

it('requires the audited contract and excludes workspace-wide scenarios', () => {
  assert.deepEqual(loadScenarios().filter(zoneConcurrent).map((item) => item.id), [
    'L1-01', 'L1-02', 'L1-05', 'L1-18', 'L1-19', 'L2-01', 'L2-02', 'L2-04', 'L2-07', 'L2-11', 'L2-20', 'L2-21', 'L2-23',
  ]);
  assert.deepEqual([...AUDITED_CONTRACTS].sort(), loadScenarios().filter(zoneConcurrent).map((item) => item.id));
  // Faults, kills, workflows, trash and restore, uploads, helper projects and shared settings stay exclusive.
  for (const action of ['fault.pause', 'fault.checks', 'fault.settings', 'kill.engine', 'run.workflow', 'run.check', 'linear.trash', 'linear.restore',
    'linear.out-of-scope', 'linear.image-add', 'linear.metadata', 'git.delete', 'git.move-rewrite', 'git.annotation', 'git.image-add', 'git.remove-security-hooks']) {
    assert.equal(AUDITED_STEPS.has(action), false, action);
  }
  for (const subject of ['workspace.documents', 'documents.deletedState', 'uploads.newCount', 'scan.canaryMatches', 'pullRequests.merger', 'pullRequests.ciPassed']) {
    assert.equal(AUDITED_SUBJECTS.has(subject), false, subject);
  }
  for (const mutate of [
    (s: typeof scenario) => { s.slice = 'full'; },
    (s: typeof scenario) => { s.setup.state = 'converged'; },
    (s: typeof scenario) => { s.setup.teamZoneLock = false; },
    (s: typeof scenario) => { s.steps.push({ kind: 'fault', action: 'settings', args: {} }); },
    (s: typeof scenario) => { s.checks.assertions.push({ subject: 'workspace.documents', operator: 'equal', expected: 0 }); },
    (s: typeof scenario) => { s.checks.invariants.I1.required = false; },
    (s: typeof scenario) => { s.mode = 'actions'; },
    (s: typeof scenario) => { (s.steps[0]!.args as Record<string, unknown>).confirm = false; },
  ]) {
    const changed = structuredClone(scenario); mutate(changed);
    assert.equal(zoneConcurrent(changed), false);
  }
  // A changed spec of any audited contract returns it to exclusive mode, even with audited steps and subjects only.
  for (const audited of loadScenarios().filter(zoneConcurrent)) {
    const changed = structuredClone(audited);
    changed.checks.assertions = changed.checks.assertions.slice(1);
    assert.equal(zoneConcurrent(changed), false, audited.id);
  }
});

function doc(id: string, projectId: string | null, teamId: string, title: string): LinearDocument {
  return { id, projectId, teamId, title, content: 'Ordinary notes.\n', slugId: id, icon: null, color: null, documentContentId: id, trashed: false, archivedAt: null, createdAt: '', updatedAt: '' };
}

it('interleaves two runs through production reads, content checks and assertion subjects with solo-equivalent results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-views-')); roots.push(root);
  const rows = new Map<string, LinearDocument>();
  const aDoc = doc('a-doc', 'a-project', 'zone-a', 'note');
  const bDoc = doc('b-doc', 'b-project', 'zone-b', 'note');
  rows.set(aDoc.id, aDoc); rows.set(bDoc.id, bDoc);
  let interleave: (() => void) | undefined;
  const context = (runId: string, team: string, projectId: string) => {
    const names = runNames(runId);
    const path = 'project/note.md';
    const project = { id: projectId, name: names.project(0) };
    const ctx = { scenario, names, engine: { results: [] }, owned: new OwnershipLedger(root, runId), observations: new Map(),
      live: {
        manifest: { files: [{ path, canary: 'foreign-canary', canary_in: 'content' }] },
        rest: { pullRequests: async (prefix: string) => { assert.equal(prefix, `t/${runId}/`); return []; } },
        projects: new Map([['PROJECT_ENG_1', project]]), teams: new Map([[team, { id: `zone-${team}` }]]),
        tree: { teams: new Set([team]), teamZones: new Map([[team, 'team']]), paths: new Map([[path, path]]) },
        app: {
          listDocuments: async (filter: { projectId?: string; teamId?: string }) => {
            assert.ok(filter.projectId === projectId || filter.teamId === `zone-${team}`, 'every list has this run scope');
            interleave?.();
            return [...rows.values()].filter((row) => filter.projectId ? row.projectId === filter.projectId : row.teamId === filter.teamId);
          },
          request: async (_name: string, _kind: string, _query: string, variables: { filter: { project?: { id: { eq: string } }; team?: { id: { eq: string } }; title?: { startsWith: string } } }) => {
            const filter = variables.filter;
            assert.ok(filter.project?.id.eq === projectId || (filter.team?.id.eq === `zone-${team}` && filter.title?.startsWith === names.teamZonePrefix), 'comment lists require the same run scope');
            interleave?.();
            const matching = [...rows.values()].filter((row) => filter.project ? row.projectId === filter.project.id.eq : row.teamId === filter.team?.id.eq && row.title.startsWith(filter.title!.startsWith));
            return { documents: { nodes: matching.map((row) => ({ id: row.id, project: row.projectId === null ? null : { id: row.projectId }, comments: { nodes: [{ body: row.title.includes('foreign') ? 'foreign-canary' : 'Ordinary comment.' }] } })), pageInfo: { hasNextPage: false, endCursor: null } } };
          },
          getDocuments: async (ids: string[]) => ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []),
          getDocument: async (id: string) => rows.get(id) ?? null,
        }, documentUrlBase: 'https://example.test/document',
      },
    } as unknown as RunContext;
    const ids: IdMap = new Map([[path, { id: `${team}-doc` }]]);
    const inspect = async () => {
      const documents = await readRunDocuments(ctx, ids);
      const sides = { ...documents, ids, files: new Map([[path, 'Ordinary notes.\n']]), uploads: new Map(), uploadsByHash: new Map(), hashes: new Map(),
        folders: annotatedFolders(new Map([['project/README.md', `---\nlinear-project: ${project.name}\n---\n`]])), documentUrlBase: 'https://example.test/document', omitted: new Map(), kept: new Set(), tip: 'tip' } as Sides;
      ctx.observations.set(BEFORE_VIEW, { ...sides, comments: new Map() });
      ctx.observations.delete('canary.remoteTexts');
      const checks = await Promise.all(['I1', 'I5', 'I8'].map((id) => INVARIANT_CHECKS[id as 'I1' | 'I5' | 'I8'](ctx, async () => sides)));
      const assertions = await Promise.all(scenario.checks.assertions.map((item) => evaluateAssertion(ctx, { ...item, subject: `before.${item.subject}`, expected: item.operator === 'same-as' ? `before.${item.expected}` : item.expected })));
      return { checks, assertions, snapshot: isolationSnapshot(ctx, sides) };
    };
    return { ctx, ids, inspect };
  };
  const a = context('aaaaaa', 'a', 'a-project'); const b = context('bbbbbb', 'b', 'b-project');
  const soloA = await a.inspect(); const soloB = await b.inspect();
  assert.ok(soloA.checks.every((check) => check.ok)); assert.ok(soloA.assertions.every((check) => check.holds));
  assert.ok(soloB.checks.every((check) => check.ok)); assert.ok(soloB.assertions.every((check) => check.holds));
  let n = 0;
  interleave = () => {
    // Foreign creates, updates, deletion, duplicate titles and a canary must
    // never enter the other run's checks or change its document hashes.
    n++;
    // Each writer also replaces its own project's document. The other
    // reader must never observe that project's intermediate state.
    rows.set('a-doc', { ...aDoc, updatedAt: String(n) });
    rows.set('b-doc', { ...bDoc, updatedAt: String(n) });
    for (const team of ['a', 'b']) {
      const id = `foreign-${team}-${n}`;
      rows.set(id, doc(id, `other-${team}`, `zone-${team}`, 'foreign-canary'));
      rows.set(`team-${team}`, doc(`team-${team}`, null, `zone-${team}`, 'cccccc/note'));
      rows.delete(`foreign-${team}-${n - 1}`);
    }
  };
  const parallel = await Promise.all([a.inspect(), b.inspect()]);
  assert.ok(n >= 4);
  assert.deepEqual(parallel, [soloA, soloB]);
  // An accidentally foreign mapped id must fail rather than influence I1.
  a.ids.set('project/note.md', { id: 'b-doc' });
  await assert.rejects(readRunDocuments(a.ctx, a.ids), /outside the leased run scope/);
});

it('verifies process death and never uses a stale heartbeat to steal a live writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-death-')); roots.push(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./admission-child.ts', import.meta.url)), 'register', JSON.stringify({ root })], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data');
    const file = join(root, 'runs', 'aaaaaa.json');
    const registration = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...registration, heartbeatAt: new Date(0).toISOString() }));
    assert.throws(() => requireStoppedLocalRun(root, 'aaaaaa'), /still alive/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    requireStoppedLocalRun(root, 'aaaaaa');
    writeFileSync(file, JSON.stringify({ ...registration, host: `${hostname()}-other` }));
    assert.throws(() => requireStoppedLocalRun(root, 'aaaaaa'), /cannot verify/);
    assert.throws(() => requireStoppedLocalRun(root, 'bbbbbb'), /original readable/);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

it('uses viewer identities for editor reservations and fails closed before writes if identity is missing', async () => {
  const { claimEditorBudgets } = await import('./runner.ts');
  const accounts: string[] = [];
  const client = { request: async () => ({ viewer: { id: 'stable-viewer' } }) };
  const ctx = { scenario, signal: new AbortController().signal, live: { editors: { 'editor-a': client, 'editor-b': { ...client } } } } as unknown as RunContext;
  const grant = { claimBudgets: async (budgets: Array<{ key: string }>) => { accounts.push(...budgets.map((item) => item.key)); } } as unknown as import('./governor.ts').Grant;
  await claimEditorBudgets(ctx, grant);
  assert.equal(accounts.length, 1, 'aliases reserve the whole-scenario estimate once');
  assert.match(accounts[0]!, /^editor-[0-9a-f]{64}$/);
  ctx.live!.editors['editor-b'] = { request: async () => ({ viewer: null }) } as never;
  await assert.rejects(claimEditorBudgets(ctx, grant), /editor identity unavailable/);
  assert.equal(accounts.length, 1, 'missing identity never reserves a partial set');
});

it('caps a full-corpus editor reservation to a usable quota window', async () => {
  const { claimEditorBudgets } = await import('./runner.ts');
  const { estimate, MAX_ADMISSION } = await import('./governor.ts');
  const full = loadScenarios().find((item) => item.id === 'L1-16')!;
  assert.ok(estimate(full).requests > 5000);
  let needs: Array<{ requests: number; complexity: number }> = [];
  const client = { request: async () => ({ viewer: { id: 'stable-viewer' } }) };
  const ctx = { scenario: full, signal: new AbortController().signal, live: { editors: { 'editor-a': client, 'editor-b': client } } } as unknown as RunContext;
  const grant = { claimBudgets: async (budgets: Array<{ need: { requests: number; complexity: number } }>) => { needs = budgets.map((item) => item.need); } } as unknown as import('./governor.ts').Grant;
  await claimEditorBudgets(ctx, grant);
  assert.deepEqual(needs, [MAX_ADMISSION]);
  ctx.live!.editors['editor-b'] = { request: async () => ({ viewer: { id: 'other-viewer' } }) } as never;
  await claimEditorBudgets(ctx, grant);
  assert.deepEqual(needs, [MAX_ADMISSION, MAX_ADMISSION]);
});
