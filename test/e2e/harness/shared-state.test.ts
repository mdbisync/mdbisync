import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { Git } from '../../../src/state/git.ts';
import { GitStateStore, SharedAdmission, parseSharedState } from './shared-state.ts';
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
    const code = `
      import { GitStateStore, SharedAdmission } from ${JSON.stringify(new URL('./shared-state.ts', import.meta.url).href)};
      const admission = new SharedAdmission(new GitStateStore({stateDir: ${JSON.stringify(root)} + '/' + ${JSON.stringify(runId)}, url: ${JSON.stringify(remote)}}));
      const result = await admission.reserve({...${JSON.stringify(options(runId, { need: { requests: 3000, complexity: 1 } }))}, readBudget: async () => (${JSON.stringify(budget)})});
      process.stdout.write(JSON.stringify(result.admitted));
    `;
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L2-01')!;
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
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L2-01')!;
  const governor = new Governor({ apps: [{ name: 'one', readBudget: async () => ++reads === 1 ? { ...budget, requestsRemaining: 250, resetAt: now + 60_000 } : budget }], stateDir: root, shared: first,
    now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  await (await governor.admit(scenario, 'aaaaaa', { requests: 100, complexity: 1 })).release();
  assert.deepEqual(waits, [61_000]);
  assert.equal(reads, 2);
});

it('waits for a claimed team and accepts cancellation without dropping the reservation', async () => {
  const { root, first, second } = await fixture();
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L2-01')!;
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
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L2-01')!;
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
  const scenario = loadScenarios().find((scenario) => scenario.id === 'L2-01')!;
  const result = await runScenario(scenario, {
    stateDir: root, outDir: root, appClients: new Map(), expectedRed: new Set(), log: () => {},
    config: { linearApps: [], githubApp: null, gitUrl: '', missing: ['not configured'] } as never,
    governor: { admit: async () => {
      assert.ok(readOwnership(root, 'aaaaaa'));
      throw new BudgetBlockedError('budget unavailable');
    } } as never,
  }, 'aaaaaa');
  assert.equal(result.result, 'env-blocked');
  assert.equal(result.cleanup.ok, true);
});
