import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { Git, GitError, type RunOptions, type RunResult } from '../../../src/state/git.ts';
import { GitStateStore, NOT_FOUND_RETRY_MS, SharedAdmission, parseSharedState, redactGitOutput } from './shared-state.ts';
import { BudgetBlockedError, Governor } from './governor.ts';
import { loadScenarios } from './spec.ts';
import { selectTeams, buildRunTree } from './corpus.ts';
import { runNames } from './isolation.ts';
import { sweep, type SweepTargets } from './sweeper.ts';

const roots: string[] = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shared-admission-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  await new Git(root).run(['init', '--bare', '--quiet', remote]);
  const first = new SharedAdmission(new GitStateStore({ stateDir: join(root, 'a'), url: remote }));
  const second = new SharedAdmission(new GitStateStore({ stateDir: join(root, 'b'), url: remote }));
  return { root, remote, first, second };
}
const budget = { requestsRemaining: 5000, complexityRemaining: 2_000_000, resetAt: 0 };
const options = (runId: string, changes = {}) => ({ runId, owner: randomUUID(), app: 'shared-app', full: false, need: { requests: 100, complexity: 40000 }, maxWorkers: 4, reserve: { requests: 200, complexity: 100000 }, readBudget: async () => budget, ...changes });

it('serializes competing hosts, claims disjoint zones and checks release ownership', async () => {
  const { first, second } = await fixture();
  const a = options('aaaaaa'); const b = options('bbbbbb');
  const admitted = await Promise.all([first.reserve(a), second.reserve(b)]);
  assert.ok(admitted.every((item) => item.admitted));
  assert.deepEqual([...await first.liveRuns()].sort(), ['aaaaaa', 'bbbbbb']);
  await Promise.all([first.claim(a.runId, a.owner, ['zone-a']), second.claim(b.runId, b.owner, ['zone-b'])]);
  await assert.rejects(second.claim(b.runId, b.owner, ['zone-a']), /held/);
  await assert.rejects(first.release(a.runId, b.owner), /ownership/);
  await first.release(a.runId, a.owner);
  await second.claim(b.runId, b.owner, ['zone-a', 'zone-b']);
  await second.release(b.runId, b.owner);
  assert.equal((await first.liveRuns()).size, 0);
});

it('cannot promise the same request or complexity budget twice', async () => {
  for (const need of [{ requests: 3000, complexity: 1 }, { requests: 1, complexity: 1_200_000 }]) {
    const { first, second } = await fixture();
    const result = await Promise.all([first.reserve(options('aaaaaa', { need })), second.reserve(options('bbbbbb', { need }))]);
    assert.equal(result.filter((entry) => entry.admitted).length, 1);
    assert.equal((await first.liveRuns()).size, 1);
  }
});

it('excludes full slices from every ordinary run in both directions and caps workers', async () => {
  const { first, second } = await fixture();
  const full = options('aaaaaa', { full: true });
  assert.ok((await first.reserve(full)).admitted);
  assert.equal((await second.reserve(options('bbbbbb'))).admitted, false);
  await first.release(full.runId, full.owner);
  const small = options('bbbbbb');
  assert.ok((await second.reserve(small)).admitted);
  assert.equal((await first.reserve(full)).admitted, false);
  assert.equal((await first.reserve(options('cccccc', { maxWorkers: 1 }))).admitted, false);
  assert.ok((await first.reserve(options('cccccc', { app: 'another-app', maxWorkers: 1 }))).admitted);
});

it('independent processes with separate local state cannot both reserve a scarce budget', async () => {
  const { root, remote, first } = await fixture();
  const child = (runId: string) => new Promise<boolean>((resolve, reject) => {
    const payload = { root: join(root, runId), remote, reservation: options(runId, { need: { requests: 3000, complexity: 1 } }), budget };
    const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./admission-child.ts', import.meta.url)), 'reserve', JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    process.stdout.on('data', (chunk) => output += chunk);
    process.stderr.on('data', (chunk) => error += chunk);
    process.on('error', reject);
    process.on('close', (status) => {
      if (status !== 0) reject(new Error(error));
      else { try { resolve(JSON.parse(output)); } catch (caught) { reject(caught); } }
    });
  });
  const result = await Promise.all([child('dddddd'), child('eeeeee')]);
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal((await first.liveRuns()).size, 1);
});

it('fails closed on malformed state and unreachable store', async () => {
  assert.throws(() => parseSharedState('{"version":2,"runs":[]}'));
  assert.throws(() => parseSharedState(JSON.stringify({ version: 1, runs: [{ ...options('aaaaaa'), requests: -1 }] })));
  const { root } = await fixture();
  const unavailable = new GitStateStore({ stateDir: join(root, 'missing-state'), url: join(root, 'missing-remote') });
  await assert.rejects(unavailable.read(), /unavailable/);
  await assert.rejects(unavailable.update(() => {}), /unavailable/);
});

it('shared governor uses stable app identity and awaits release before readmission', async () => {
  const { root, first, second } = await fixture();
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L1-05')!;
  const governor = (name: string, shared: SharedAdmission) => new Governor({ apps: [{ name, key: 'same-identity', readBudget: async () => budget }], stateDir: root, shared, maxWaitMs: 0 });
  const a = governor('first-label', first); const b = governor('different-label', second);
  const grant = await a.admit(scenario, 'aaaaaa', { requests: 3000, complexity: 1 });
  await assert.rejects(b.admit(scenario, 'bbbbbb', { requests: 3000, complexity: 1 }), BudgetBlockedError);
  await grant.release();
  await (await b.admit(scenario, 'bbbbbb', { requests: 3000, complexity: 1 })).release();
});

it('selects inherited project teams while keeping source identities and common assets', () => {
  const readmes = new Map([
    ['eng/README.md', '---\nlinear-team: ENG\n---\n'],
    ['eng/project/README.md', '---\nlinear-project: PROJECT_ENG_1\n---\n'],
    ['docs/README.md', '---\nlinear-team: DOCS\n---\n'],
  ]);
  const slice = { slice: 'mini', paths: ['README.md', 'eng/README.md', 'eng/a.md', 'eng/project/README.md', 'eng/project/b.md', 'docs/README.md', 'docs/c.md', 'assets/icon.png'] };
  const selected = selectTeams(slice, readmes, ['ENG']);
  assert.ok(selected.paths.includes('eng/project/b.md'));
  assert.ok(selected.paths.includes('assets/icon.png'));
  assert.ok(!selected.paths.some((path) => path.startsWith('docs/')));
  const tree = buildRunTree(selected, new Map([...readmes].filter(([path]) => selected.paths.includes(path))), runNames('aaaaaa'));
  assert.deepEqual([...tree.teams], ['ENG']);
  assert.equal(tree.paths.get('eng/aaaaaa/a.md'), 'eng/a.md');
  assert.throws(() => selectTeams({ ...slice, slice: 'full' }, readmes, ['ENG']), /full/);
  assert.throws(() => selectTeams(slice, readmes, ['UNKNOWN']), /unknown/);
});

it('sweeper protects remote reservations and stops before mutations on shared read failure', async () => {
  const { root, first } = await fixture();
  const entry = options('aaaaaa');
  await first.reserve(entry);
  const targets = {
    shared: first,
    sandbox: { runRefs: async () => [{ runId: 'aaaaaa', ref: 'refs/heads/t/aaaaaa/main', oid: 'x' }], deleteRunRefs: async () => assert.fail('live refs deleted') },
    rest: { pullRequests: async () => [] },
    world: { runProjects: async () => [{ runId: 'aaaaaa', createdAt: new Date(0).toISOString() }], deleteProject: async () => assert.fail('live project deleted') },
    teamIds: [],
  } as unknown as SweepTargets;
  const report = await sweep(targets, root);
  assert.deepEqual(report.keptLive, ['aaaaaa']);
  assert.deepEqual(report.errors, []);
  targets.shared = new SharedAdmission({ read: async () => { throw new Error('unavailable'); }, update: async () => { throw new Error('unavailable'); } });
  targets.sandbox = { runRefs: async () => assert.fail('read after failed shared state') } as never;
  await assert.rejects(sweep(targets, root), /unavailable/);
});

it('requires readable capacity and counts active documents plus trash before writes', async () => {
  const { requireZoneCapacity } = await import('./runner.ts');
  const world = { zoneUsage: async () => ({ active: 10, trashed: 978 }) };
  assert.deepEqual(await requireZoneCapacity(world, 'zone-a', 12), { active: 10, trashed: 978 });
  await assert.rejects(requireZoneCapacity(world, 'zone-a', 13), /insufficient/);
  await assert.rejects(requireZoneCapacity({ zoneUsage: async () => { throw new Error('read failed'); } }, 'zone-a', 0), /unavailable/);
  await assert.rejects(requireZoneCapacity({ zoneUsage: async () => ({ active: NaN, trashed: 0 }) }, 'zone-a', 0), /invalid/);
});

it('rereads app spending after a conflicting release instead of admitting from stale budget', async () => {
  const { first, second } = await fixture();
  const existing = options('aaaaaa');
  await first.reserve(existing);
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let continueRead!: () => void;
  const released = new Promise<void>((resolve) => { continueRead = resolve; });
  let reads = 0;
  const candidate = second.reserve(options('bbbbbb', {
    need: { requests: 3000, complexity: 1 },
    readBudget: async () => {
      if (++reads === 1) { entered(); await released; return budget; }
      return { ...budget, requestsRemaining: 2000 };
    },
  }));
  await reading;
  await first.release(existing.runId, existing.owner);
  continueRead();
  assert.equal((await candidate).admitted, false);
  assert.equal(reads, 2);
  assert.equal((await first.liveRuns()).size, 0);
});

it('partial-corpus results never replace full catalog status, including blocked or skipped runs', async () => {
  const { mergeLatest, renderRunMarkdown, evidenceSummary } = await import('./report.ts');
  const previous = [{ id: 'L1-05', result: 'pass' as const, runId: 'aaaaaa', at: 'before', harnessRunId: 'whole' }];
  const report = { harnessRunId: 'scoped', startedAt: 'after', finishedAt: 'after', host: 'example', selection: { teams: ['ENG'] }, results: [] };
  assert.deepEqual(mergeLatest(previous, report), previous);
  assert.match(renderRunMarkdown(report), /Partial corpus/);
  assert.match(evidenceSummary(report), /Partial corpus/);
});

it('resuming a UI hold rechecks budget while keeping its zones and worker reservation', async () => {
  const { first } = await fixture();
  const entry = options('aaaaaa');
  await first.reserve(entry);
  await first.claim(entry.runId, entry.owner, ['zone-a']);
  assert.equal((await first.reserve({ ...entry, resume: true, readBudget: async () => ({ ...budget, requestsRemaining: 0 }) })).admitted, false);
  assert.deepEqual((await first.store.read()).runs[0]?.zones, ['zone-a']);
  assert.ok((await first.reserve({ ...entry, resume: true })).admitted);
  assert.equal((await first.store.read()).runs.length, 1);
  await assert.rejects(first.reserve({ ...entry, resume: true, owner: randomUUID() }), /reservation/);
});

it('renews cached credentials before expiry and retries failed refreshes', async () => {
  const { refreshingGitEnv } = await import('./shared-state.ts');
  let now = 0; let calls = 0;
  const env = refreshingGitEnv(async () => ({ GENERATION: String(++calls) }), () => now);
  assert.deepEqual(await Promise.all([env(), env()]), [{ GENERATION: '1' }, { GENERATION: '1' }]);
  now = 45 * 60_000;
  assert.deepEqual(await env(), { GENERATION: '2' });
  let fail = true;
  const retry = refreshingGitEnv(async () => { if (fail) throw new Error('unavailable'); return {}; });
  await assert.rejects(retry(), /unavailable/);
  fail = false;
  assert.deepEqual(await retry(), {});
});

it('does not spend Linear budget when full exclusion or worker slots already block admission', async () => {
  const { first, second } = await fixture();
  const full = options('aaaaaa', { full: true });
  await first.reserve(full);
  const noRead = async () => assert.fail('unnecessary budget read');
  assert.equal((await second.reserve(options('bbbbbb', { readBudget: noRead }))).admitted, false);
  await first.release(full.runId, full.owner);
  await first.reserve(options('cccccc'));
  assert.equal((await second.reserve(options('dddddd', { maxWorkers: 1, readBudget: noRead }))).admitted, false);
});

it('waits for actual budget reset while polling short-lived reservations separately', async () => {
  const { root, first } = await fixture();
  let now = 1_000_000; let reads = 0;
  const waits: number[] = [];
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L1-05')!;
  const governor = new Governor({ apps: [{ name: 'one', readBudget: async () => ++reads === 1 ? { ...budget, requestsRemaining: 250, resetAt: now + 60_000 } : budget }], stateDir: root, shared: first,
    now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  await (await governor.admit(scenario, 'aaaaaa', { requests: 100, complexity: 1 })).release();
  assert.deepEqual(waits, [61_000]);
  assert.equal(reads, 2);
});

it('waits for a claimed team and accepts cancellation without dropping the reservation', async () => {
  const { root, first, second } = await fixture();
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L1-05')!;
  const make = (shared: SharedAdmission) => new Governor({ apps: [{ name: 'one', readBudget: async () => budget }], stateDir: root, shared });
  const a = await make(first).admit(scenario, 'aaaaaa', { requests: 1, complexity: 1 });
  const b = await make(second).admit(scenario, 'bbbbbb', { requests: 1, complexity: 1 });
  await a.claimZones!(['zone-a']);
  const abort = new AbortController();
  const blocked = b.claimZones!(['zone-a'], abort.signal);
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(blocked);
  assert.equal((await first.liveRuns()).size, 2);
  const waiting = b.claimZones!(['zone-a']);
  await a.release();
  await waiting;
  await b.release();
});

it('recognizes optimistic push races without retrying permission failures', async () => {
  const { isConcurrentPush } = await import('./shared-state.ts');
  assert.ok(isConcurrentPush("[remote rejected] (cannot lock ref 'refs/heads/scenario-control': is at aaaa but expected bbbb)"));
  assert.equal(isConcurrentPush('[remote rejected] (permission denied)'), false);
});

it('fences saved UI ownership before explicit stopped-writer recovery', async () => {
  const { first } = await fixture();
  const entry = options('aaaaaa');
  await first.reserve(entry);
  await first.claim(entry.runId, entry.owner, ['zone-a']);
  const owner = await first.beginRecovery(entry.runId, entry.owner);
  assert.notEqual(owner, entry.owner);
  await assert.rejects(first.reserve({ ...entry, resume: true }), /reservation/);
  await assert.rejects(first.release(entry.runId, entry.owner), /ownership/);
  assert.deepEqual((await first.store.read()).runs[0]?.zones, ['zone-a']);
  await first.release(entry.runId, owner);
});

it('removes only its own local Git object cache on close', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const { root, remote } = await fixture();
  const stateDir = join(root, 'disposable');
  const store = new GitStateStore({ stateDir, url: remote });
  await store.read();
  const owned = readdirSync(join(stateDir, 'control'));
  assert.equal(owned.length, 1);
  await store.close();
  assert.deepEqual(readdirSync(join(stateDir, 'control')), []);
  assert.ok(existsSync(remote));
});

it('explicit recovery cleans only the fenced run and keeps its record until reservation release', async () => {
  const { OwnershipLedger, readOwnership } = await import('./ownership.ts');
  const { root, first } = await fixture();
  const entry = options('aaaaaa');
  await first.reserve(entry);
  const owner = await first.beginRecovery(entry.runId, entry.owner);
  new OwnershipLedger(root, entry.runId).scope([]);
  let refs = [entry.runId, 'bbbbbb'].map((runId) => ({ runId, ref: `refs/heads/t/${runId}/main`, oid: 'x' }));
  let closed = false;
  const targets = {
    shared: first, recovering: entry.runId,
    sandbox: {
      runRefs: async () => refs,
      deleteRunRefs: async (runId: string) => { assert.equal(runId, entry.runId); refs = refs.filter((ref) => ref.runId !== runId); },
    },
    rest: {
      pullRequests: async () => closed ? [] : [{ number: 1, head: { ref: 't/aaaaaa/sync' }, created_at: new Date().toISOString() }],
      closePullRequest: async () => { assert.ok(refs.some((ref) => ref.runId === entry.runId), 'close before deleting the head refs'); closed = true; },
    },
    world: { runProjects: async () => [], projects: async () => [], client: { getDocuments: async () => [] } },
    teamIds: [],
  } as unknown as SweepTargets;
  const report = await sweep(targets, root);
  assert.deepEqual(report.errors, []);
  assert.equal(closed, true);
  assert.deepEqual(refs.map((ref) => ref.runId), ['bbbbbb']);
  assert.ok(readOwnership(root, entry.runId));
  assert.equal((await first.liveRuns()).size, 1, 'only successful caller census and release free the reservation');
  await first.release(entry.runId, owner);
});

it('cleanup reports both the original failure and failed trash after-count', async () => {
  const { createRunContext, cleanupAndCount } = await import('./runner.ts');
  const { root } = await fixture();
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L1-05')!;
  const { ctx } = createRunContext(scenario, 'aaaaaa', join(root, 'run'), { stateDir: root, outDir: root, config: {} as never, log: () => {} });
  ctx.observations.set('zone.trash', { ENG: { before: 0 } });
  ctx.live = {
    seededDocuments: [], projects: new Map(), teams: new Map([['ENG', { id: 'zone-a' }]]), tree: { teamZones: new Map() },
    rest: { closeOpenPullRequests: async () => { throw new Error('project cleanup failed'); } },
    world: { client: { getDocuments: async () => [] }, archiveRunTeamDocuments: async () => 0, trashedInZone: async () => { throw new Error('unavailable'); } },
  } as never;
  const result = await cleanupAndCount(ctx);
  assert.equal(result.ok, false);
  assert.match(result.detail!, /project cleanup failed/);
  assert.match(result.detail!, /trash count after cleanup/);
});

it('persists an empty ownership scope before admission so pre-write crashes can be recovered', async () => {
  const { runScenario } = await import('./runner.ts');
  const { readOwnership } = await import('./ownership.ts');
  const { root } = await fixture();
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L1-05')!;
  let admitted = false;
  const result = await runScenario(scenario, {
    stateDir: root, outDir: root, appClients: new Map(), expectedRed: new Set(), log: () => {},
    config: { linearApps: [], githubApp: null, gitUrl: '', missing: [] } as never,
    governor: { admit: async () => {
      admitted = true;
      assert.ok(readOwnership(root, 'aaaaaa'));
      throw new BudgetBlockedError('budget unavailable');
    } } as never,
  }, 'aaaaaa');
  assert.equal(admitted, true, 'the scenario reached admission');
  assert.equal(result.result, 'env-blocked');
  assert.equal(result.cleanup.ok, true);
});

it('workspace-wide scenarios exclude otherwise disjoint audited runs', async () => {
  const { root, first, second } = await fixture();
  const ordinary = loadScenarios().find((item) => item.id === 'L1-05')!;
  const global = loadScenarios().find((item) => item.id === 'L2-30')!;
  const governor = (shared: SharedAdmission) => new Governor({ apps: [{ name: 'app', readBudget: async () => budget }], stateDir: root, shared, maxWaitMs: 0 });
  const a = governor(first); const b = governor(second);
  const exclusive = await a.admit(global, 'aaaaaa', { requests: 1, complexity: 1 });
  await assert.rejects(b.admit(ordinary, 'bbbbbb', { requests: 1, complexity: 1 }), BudgetBlockedError);
  await exclusive.release();
  const safe = await b.admit(ordinary, 'bbbbbb', { requests: 1, complexity: 1 });
  await assert.rejects(a.admit(global, 'aaaaaa', { requests: 1, complexity: 1 }), BudgetBlockedError);
  await safe.release();
});

it('shares editor quotas across apps and groups aliases of the same viewer', async () => {
  for (const need of [{ requests: 3000, complexity: 1 }, { requests: 1, complexity: 1_200_000 }]) {
    const { first, second } = await fixture();
    const a = options('aaaaaa'); const b = options('bbbbbb', { app: 'another-app' });
    await Promise.all([first.reserve(a), second.reserve(b)]);
    const accounts = [{ key: 'editor-stable-viewer', need, readBudget: async () => budget }];
    const results = await Promise.all([first.reserveAccounts(a.runId, a.owner, accounts, a.reserve), second.reserveAccounts(b.runId, b.owner, accounts, b.reserve)]);
    assert.equal(results.filter((result) => result.admitted).length, 1);
  }
  const { first } = await fixture(); const a = options('aaaaaa'); await first.reserve(a);
  const account = { key: 'same-viewer', need: { requests: 2500, complexity: 1 }, readBudget: async () => budget };
  assert.equal((await first.reserveAccounts(a.runId, a.owner, [account, account], a.reserve)).admitted, false);
  assert.equal((await first.store.read()).runs[0]?.resources, undefined, 'a rejected multi-account reservation writes nothing');
});

it('refuses recovery without rotating ownership when the stopped-writer check fails', async () => {
  const { first } = await fixture(); const a = options('aaaaaa'); await first.reserve(a);
  await assert.rejects(first.beginRecovery(a.runId, a.owner, () => { throw new Error('writer alive'); }), /writer alive/);
  assert.equal((await first.store.read()).runs[0]?.owner, a.owner);
  assert.equal((await first.store.read()).runs[0]?.recovering, undefined);
});

it('keeps a killed process lease until verified recovery, fencing and cleanup let a waiting run in', async () => {
  const { requireStoppedLocalRun } = await import('./locks.ts');
  const { OwnershipLedger } = await import('./ownership.ts');
  const { root, remote, first, second } = await fixture();
  const entry = options('aaaaaa');
  const payload = { root, remote, reservation: entry, budget };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./admission-child.ts', import.meta.url)), 'hold', JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data');
    const waiter = options('bbbbbb'); await second.reserve(waiter);
    await assert.rejects(second.claim(waiter.runId, waiter.owner, ['zone-a']), /held/);
    await assert.rejects(first.beginRecovery(entry.runId, entry.owner, () => requireStoppedLocalRun(root, entry.runId)), /still alive/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await assert.rejects(second.claim(waiter.runId, waiter.owner, ['zone-a']), /held/, 'process death never frees the lease');
    const recoveryOwner = await first.beginRecovery(entry.runId, entry.owner, () => requireStoppedLocalRun(root, entry.runId));
    await assert.rejects(first.claim(entry.runId, entry.owner, ['zone-a']), /ownership/);
    const ledger = new OwnershipLedger(root, entry.runId);
    ledger.scope(['zone-a']);
    const project = { id: 'project-a', name: runNames(entry.runId).project(0) };
    ledger.project(project);
    ledger.record({ kind: 'document', id: 'doc-a', confirmed: true });
    let archived = false;
    const document = { id: 'doc-a', projectId: project.id, teamId: null, trashed: false, archivedAt: null as string | null };
    const report = await sweep({
      shared: first, recovering: entry.runId, teamIds: ['zone-a'],
      sandbox: { runRefs: async () => [], deleteRunRefs: async () => {} },
      rest: { pullRequests: async () => [] },
      world: { runProjects: async () => [], runTeamDocuments: async () => [], projects: async () => archived ? [] : [project],
        client: { getDocuments: async () => [document] },
        deleteProject: async () => { archived = true; document.archivedAt = new Date().toISOString(); },
      },
    } as unknown as SweepTargets, root);
    assert.deepEqual(report.errors, []);
    assert.ok(archived);
    assert.equal(report.recovered[0]?.verifiedArchived, 1);
    await assert.rejects(second.claim(waiter.runId, waiter.owner, ['zone-a']), /held/, 'cleanup alone cannot expose an unreleased lease');
    await first.release(entry.runId, recoveryOwner);
    await second.claim(waiter.runId, waiter.owner, ['zone-a']);
    await second.release(waiter.runId, waiter.owner);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

// A `full` scenario against an editor key with Linear's 2,500-request hourly window.
async function editorClaim(allowed: { requests: number; complexity: number }, spent = 1) {
  const { claimEditorBudgets } = await import('./runner.ts');
  const { first } = await fixture();
  const full = loadScenarios().find((item) => item.slice === 'full' && item.setup.state !== 'offline')!;
  const governor = new Governor({ apps: [{ name: 'app', readBudget: async () => budget }], stateDir: join(roots.at(-1)!, 'state'), shared: first, maxWaitMs: 0 });
  const grant = await governor.admit(full, 'aaaaaa', { requests: 1, complexity: 1 });
  const status = { identifier: null, kind: 'api key', limits: [
    { type: 'requestLimit', allowedAmount: allowed.requests, remainingAmount: allowed.requests - spent, requestedAmount: 1, period: 3_600_000, reset: Date.now() + 3_600_000 },
    { type: 'complexityLimit', allowedAmount: allowed.complexity, remainingAmount: allowed.complexity - 10, requestedAmount: 10, period: 3_600_000, reset: Date.now() + 3_600_000 },
  ] };
  const editor = { request: async () => ({ viewer: { id: 'stable-viewer' } }), rateLimitStatus: async () => status };
  const ctx = { scenario: full, signal: new AbortController().signal, live: { editors: { 'editor-a': editor, 'editor-b': editor } } } as never;
  return { first, full, grant, claim: (maxWaitMs?: number) => claimEditorBudgets(ctx, grant, maxWaitMs) };
}

it('admits a full-sized editor claim on a 2,500-request key at once', { timeout: 30_000 }, async () => {
  const { estimate } = await import('./governor.ts');
  const { first, full, grant, claim } = await editorClaim({ requests: 2500, complexity: 3_000_000 });
  assert.ok(estimate(full).requests > 2500, 'the scenario estimate alone exceeds the key window');
  await claim();
  assert.deepEqual((await first.store.read()).runs[0]?.resources?.map(({ requests, complexity }) => ({ requests, complexity })), [{ requests: 1500, complexity: 1_200_000 }]);
  await grant.release();
});

it('fails an editor claim at once when no window of the key could admit it', { timeout: 30_000 }, async () => {
  const { EnvBlockedError } = await import('./results.ts');
  const { first, grant, claim } = await editorClaim({ requests: 300, complexity: 3_000_000 });
  await assert.rejects(claim(), (error: Error) => error instanceof EnvBlockedError && /can never be admitted: a window of the account allows 300 requests/.test(error.message));
  assert.equal((await first.store.read()).runs[0]?.resources, undefined, 'a claim that never fits reserves nothing');
  await grant.release();
});

it('reports an editor key that frees up only after setup would end, without waiting', { timeout: 30_000 }, async () => {
  const { EnvBlockedError } = await import('./results.ts');
  const { first, grant, claim } = await editorClaim({ requests: 2500, complexity: 3_000_000 }, 1500);
  await assert.rejects(claim(15 * 60_000), (error: Error) => error instanceof EnvBlockedError && /editor budget unavailable: it frees up in 6\d minutes/.test(error.message));
  assert.equal((await first.store.read()).runs[0]?.resources, undefined);
  await grant.release();
});

// GitHub refuses a push in more forms than git's own rejection texts: an
// exit code with an unknown reason, or a thrown error. A hook stands in for
// the push of one store and may change what it reports.
type PushHook = (push: () => Promise<RunResult>) => Promise<RunResult>;
class HookedGit extends Git {
  pushes = 0;
  readonly hook: PushHook;
  constructor(dir: string, env: Record<string, string>, hook: PushHook) { super(dir, env); this.hook = hook; }
  override run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    if (args[0] !== 'push') return super.run(args, options);
    this.pushes++;
    return this.hook(() => super.run(args, options));
  }
}
function hooked(root: string, remote: string, name: string, hook: PushHook, env?: Record<string, string>) {
  let git: HookedGit | undefined;
  const store = new GitStateStore({ stateDir: join(root, name), url: remote, ...(env === undefined ? {} : { env }), git: (dir, base) => (git = new HookedGit(dir, base, hook)) });
  return { shared: new SharedAdmission(store), pushes: () => git?.pushes ?? 0 };
}
const unexpectedEnd = () => new GitError(['push'], 128, 'fatal: the remote end hung up unexpectedly');

// Waiters of the exclusive slot all build their update on the tip the release
// left. Their first pushes go in turn: the first lands, and GitHub refuses each
// later one in another form. Only the ref tells that a competitor moved it.
async function waitersAfterRelease(full: boolean) {
  const { root, remote, first } = await fixture();
  const holder = options('aaaaaa', { full: true });
  assert.ok((await first.reserve(holder)).admitted);
  const refusals: Array<(real: RunResult) => RunResult> = [
    (real) => real,
    () => { throw new GitError(['push'], 128, 'remote: Internal Server Error\nfatal: the remote end hung up unexpectedly'); },
    () => ({ code: 1, stdout: Buffer.from('To https://github.com/example/sandbox.git\n!\tHEAD:refs/heads/scenario-control\t[remote rejected] (internal server error)\nDone\n'), stderr: 'error: failed to push some refs\n' }),
    () => { throw new GitError(['push'], 1, "remote: error: cannot lock ref 'refs/heads/scenario-control': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222\n"); },
  ];
  let arrived = 0;
  let allBuilt!: () => void;
  const built = new Promise<void>((resolve) => { allBuilt = resolve; });
  const turns = refusals.map(() => Promise.withResolvers<void>());
  // What each first push really did; checked outside the hook, since update() handles what the hook throws.
  const raced: number[] = [];
  const waiters = refusals.map((refuse, index) => {
    let first = true;
    return hooked(root, remote, `waiter-${index}`, async (push) => {
      if (!first) return push();
      first = false;
      if (++arrived === refusals.length) allBuilt();
      await built;
      await turns[index - 1]?.promise;
      try {
        const real = await push();
        raced[index] = real.code;
        return refuse(real);
      } finally { turns[index]!.resolve(); }
    });
  });
  const entries = waiters.map((_, index) => options(String(index + 1).repeat(6), { full }));
  for (const [index, waiter] of waiters.entries()) assert.equal((await waiter.shared.reserve(entries[index]!)).admitted, false, 'the slot is held');
  assert.deepEqual(waiters.map((waiter) => waiter.pushes()), [0, 0, 0, 0], 'a refused waiter writes nothing');
  await first.release(holder.runId, holder.owner);
  const results = await Promise.all(waiters.map((waiter, index) => waiter.shared.reserve(entries[index]!)));
  assert.deepEqual(raced, [0, 1, 1, 1], 'only the first push of the race lands');
  return { first, results, entries, pushes: waiters.map((waiter) => waiter.pushes()) };
}

it('retries a competing push in any form when waiters for the exclusive slot update at once after a release', async () => {
  const { first, results, entries, pushes } = await waitersAfterRelease(true);
  assert.deepEqual(results.map((result) => result.admitted), [true, false, false, false]);
  assert.deepEqual([...await first.liveRuns()], [entries[0]!.runId]);
  assert.deepEqual(pushes, [1, 1, 1, 1], 'a retry rereads the state and, refused, writes nothing');
});

it('applies every waiter update after its competing push was refused, when the slot is shared', async () => {
  const { first, results, entries, pushes } = await waitersAfterRelease(false);
  assert.ok(results.every((result) => result.admitted));
  assert.deepEqual([...await first.liveRuns()].sort(), entries.map((entry) => entry.runId).sort());
  // The retries race each other again, as real waiters do: each refused waiter pushes at least once more.
  assert.equal(pushes[0], 1);
  assert.ok(pushes.slice(1).every((count) => count >= 2), `pushes ${pushes.join(', ')}`);
});

it('keeps an update that landed although its push reported a thrown error', async () => {
  const { root, remote, first } = await fixture();
  const codes: number[] = [];
  const store = hooked(root, remote, 'landed', async (push) => { codes.push((await push()).code); throw unexpectedEnd(); });
  assert.ok((await store.shared.reserve(options('aaaaaa'))).admitted);
  assert.deepEqual(codes, [0]);
  assert.deepEqual([...await first.liveRuns()], ['aaaaaa']);
  assert.equal(store.pushes(), 1);
});

it('keeps an update that landed and was built on before the ref was read back', async () => {
  const { root, remote, first, second } = await fixture();
  const codes: number[] = [];
  const store = hooked(root, remote, 'built-on', async (push) => {
    codes.push((await push()).code);
    assert.ok((await second.reserve(options('bbbbbb'))).admitted);
    throw unexpectedEnd();
  });
  assert.ok((await store.shared.reserve(options('aaaaaa'))).admitted, 'not retried into "run id already has a shared reservation"');
  assert.deepEqual(codes, [0]);
  assert.deepEqual([...await first.liveRuns()].sort(), ['aaaaaa', 'bbbbbb']);
  assert.equal(store.pushes(), 1);
});

it('retries a server failure that left the ref unchanged a few times, then reports it', async () => {
  const { root, remote, first } = await fixture();
  let failures = 1;
  const passing = hooked(root, remote, 'passing', async (push) => (failures-- > 0 ? Promise.reject(unexpectedEnd()) : push()));
  assert.ok((await passing.shared.reserve(options('aaaaaa'))).admitted);
  assert.equal(passing.pushes(), 2);
  const lasting = hooked(root, remote, 'lasting', async () => { throw new GitError(['push'], 128, 'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly'); });
  await assert.rejects(lasting.shared.reserve(options('bbbbbb')), /^Error: shared admission push failed: git push exited with 128: error: RPC failed; HTTP 502/);
  assert.equal(lasting.pushes(), 4);
  assert.deepEqual([...await first.liveRuns()], ['aaaaaa']);
});

it('ends at once when credentials for the push cannot be had', async () => {
  const { root, remote } = await fixture();
  let calls = 0;
  const store = new GitStateStore({ stateDir: join(root, 'no-credentials'), url: remote, env: async () => { if (++calls > 1) throw new Error('installation token: HTTP 503'); return {}; } });
  await assert.rejects(new SharedAdmission(store).reserve(options('aaaaaa')), /^Error: shared admission credentials unavailable: installation token: HTTP 503/);
});

it('ends at once on an access failure, naming the cause without credentials', async () => {
  const { root, remote, first } = await fixture();
  const token = 'tok-secret-value-0123';
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
  const store = hooked(root, remote, 'denied', async () => {
    throw new GitError(['push'], 128, `remote: Permission to example/sandbox.git denied to harness-bot (${token}).\nfatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/example/sandbox.git/': The requested URL returned error: 403\n`);
  }, env);
  await assert.rejects(store.shared.reserve(options('aaaaaa')), (error: Error) => {
    assert.match(error.message, /^shared admission push refused access: git push exited with 128: remote: Permission to example\/sandbox.git denied/);
    assert.match(error.message, /returned error: 403/);
    assert.doesNotMatch(error.message, /tok-secret|ghs_|x-access-token:/);
    return true;
  });
  assert.equal(store.pushes(), 1, 'an access failure is not retried');
  assert.equal((await first.liveRuns()).size, 0);
});

it('reports a refusal that left the ref unchanged with git push output', async () => {
  const { root, remote, first } = await fixture();
  const store = hooked(root, remote, 'declined', async () => ({ code: 1, stdout: Buffer.from('To example\n!\tHEAD:refs/heads/scenario-control\t[remote rejected] (pre-receive hook declined)\nDone\n'), stderr: 'error: failed to push some refs\n' }));
  await assert.rejects(store.shared.reserve(options('aaaaaa')), /^Error: shared admission push failed: git push exited with 1: .*\(pre-receive hook declined\)/s);
  assert.equal(store.pushes(), 1);
  assert.equal((await first.liveRuns()).size, 0);
});

it('removes credentials from git output', () => {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:installation-token-1').toString('base64')}` };
  const text = [
    'fatal: unable to access \'https://user:password-1@github.com/example/repo.git/\'',
    'token installation-token-1 leaked',
    `header ${env.GIT_CONFIG_VALUE_0}`,
    'Authorization: bearer abcdefgh12345678',
    'ghp_0123456789abcdefghijABCD and github_pat_0123456789abcdefghij_klm',
  ].join('\n');
  const out = redactGitOutput(text, env);
  assert.doesNotMatch(out, /password-1|installation-token-1|abcdefgh12345678|ghp_|github_pat_/);
  assert.doesNotMatch(out, new RegExp(Buffer.from('x-access-token:installation-token-1').toString('base64')));
  assert.match(out, /https:\/\/\*\*\*@github.com\/example\/repo.git/);
  assert.ok(redactGitOutput('x'.repeat(5000)).length <= 2001);
});

// A fake git whose `command` (`ls-remote` by default) gives GitHub's answer for
// a repository the credential cannot see, for as many calls as `missing` says;
// every other call goes to the real git. It records the credential each call
// of `command` used.
type Answer = (command: string, token: string) => GitError;
const notFound: Answer = (command, token) => new GitError([command, 'https://github.com/example/sandbox/'], 128,
  `remote: Repository not found.\nfatal: repository 'https://x-access-token:${token}@github.com/example/sandbox/' not found\n`);
class MissingRepositoryGit extends Git {
  readonly listings: string[] = [];
  missing: number;
  readonly answer: Answer;
  readonly command: string;
  constructor(dir: string, env: Record<string, string>, missing: number, answer: Answer, command: string) { super(dir, env); this.missing = missing; this.answer = answer; this.command = command; }
  override run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    if (args[0] !== this.command) return super.run(args, options);
    const token = options.env?.TOKEN ?? '';
    this.listings.push(token);
    if (this.missing-- > 0) return Promise.reject(this.answer(this.command, token));
    return super.run(args, options);
  }
}
async function missingRepository(missing: number, answer: Answer = notFound, command = 'ls-remote') {
  const { root, remote, first } = await fixture();
  const { refreshingGitEnv } = await import('./shared-state.ts');
  let minted = 0;
  const env = refreshingGitEnv(async () => ({ TOKEN: `minted-token-${++minted}` }));
  const lines: string[] = [];
  const waits: number[] = [];
  let git!: MissingRepositoryGit;
  const store = new GitStateStore({
    stateDir: join(root, `missing-${command}-${missing}`), url: remote, env,
    git: (dir, base) => (git = new MissingRepositoryGit(dir, base, missing, answer, command)),
    log: (line) => lines.push(line),
    sleep: async (ms) => { waits.push(ms); },
  });
  return { first, shared: new SharedAdmission(store), store, git, lines, waits, minted: () => minted };
}

it('retries admission once with fresh credentials after the sandbox answers "Repository not found", logging both answers without the token', async () => {
  const { first, shared, git, lines, waits, minted } = await missingRepository(1);
  assert.ok((await shared.reserve(options('aaaaaa'))).admitted);
  assert.deepEqual([...await first.liveRuns()], ['aaaaaa']);
  assert.deepEqual(waits, [NOT_FOUND_RETRY_MS], 'one short wait before the retry');
  assert.equal(git.listings[0], 'minted-token-1');
  assert.equal(git.listings[1], 'minted-token-2', 'the retry reads with a newly minted token');
  assert.equal(minted(), 2, 'exactly one new token for the retry');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^shared admission read: git ls-remote exited with 128: remote: Repository not found\..*retrying once in \d+ s with fresh credentials$/s);
  assert.equal(lines[1], 'shared admission read: the retry succeeded');
  for (const line of lines) assert.doesNotMatch(line, /minted-token|x-access-token:/);
});

it('also retries a plain read of the state once after "Repository not found"', async () => {
  const { shared, git, waits } = await missingRepository(1);
  assert.deepEqual((await shared.store.read()).runs, []);
  assert.equal(git.listings.length, 2);
  assert.deepEqual(waits, [NOT_FOUND_RETRY_MS]);
});

it('ends admission on a second "Repository not found", naming the error without the token', async () => {
  const { first, shared, git, lines, waits } = await missingRepository(2);
  await assert.rejects(shared.reserve(options('aaaaaa')), (error: Error) => {
    assert.match(error.message, /^shared admission state unavailable or invalid: git ls-remote exited with 128: remote: Repository not found\./);
    assert.match(error.message, /\(again, after one retry with fresh credentials\)$/);
    assert.doesNotMatch(error.message, /minted-token|x-access-token:/);
    return true;
  });
  assert.equal(git.listings.length, 2, 'retried once, not more');
  assert.deepEqual(waits, [NOT_FOUND_RETRY_MS]);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^shared admission read: the retry failed: git ls-remote exited with 128: remote: Repository not found\./);
  for (const line of lines) assert.doesNotMatch(line, /minted-token|x-access-token:/);
  assert.equal((await first.liveRuns()).size, 0);
});

it('retries once when the fetch of the state answers "Repository not found"', async () => {
  const { first, shared, git, lines, waits, minted } = await missingRepository(1, notFound, 'fetch');
  assert.ok((await first.reserve(options('aaaaaa'))).admitted, 'a tip to fetch');
  assert.ok((await shared.reserve(options('bbbbbb'))).admitted);
  assert.deepEqual([...await first.liveRuns()].sort(), ['aaaaaa', 'bbbbbb']);
  assert.deepEqual(git.listings, ['minted-token-1', 'minted-token-2']);
  assert.equal(minted(), 2);
  assert.deepEqual(waits, [NOT_FOUND_RETRY_MS]);
  assert.match(lines[0]!, /^shared admission read: git fetch exited with 128: remote: Repository not found\./);
  assert.equal(lines[1], 'shared admission read: the retry succeeded');
});

it('does not retry any other failure of the admission read', async () => {
  const denied: Answer = () => new GitError(['ls-remote', '--refs', 'https://github.com/example/sandbox/', 'refs/heads/scenario-control'], 128,
    "remote: Permission to example/sandbox.git denied to harness-bot.\nfatal: unable to access 'https://github.com/example/sandbox/': The requested URL returned error: 403\n");
  const { shared, git, lines, waits } = await missingRepository(1, denied);
  await assert.rejects(shared.reserve(options('aaaaaa')), /^Error: shared admission state unavailable or invalid: git ls-remote exited with 128: remote: Permission to example\/sandbox.git denied/);
  assert.equal(git.listings.length, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(lines, []);
});

it('mints new credentials when asked for fresh ones', async () => {
  const { refreshingGitEnv } = await import('./shared-state.ts');
  let calls = 0;
  const env = refreshingGitEnv(async () => ({ GENERATION: String(++calls) }), () => 0);
  assert.deepEqual(await env(), { GENERATION: '1' });
  assert.deepEqual(await env({ fresh: true }), { GENERATION: '2' });
  assert.deepEqual(await env(), { GENERATION: '2' });
});
