// A run held for its UI session leaves its documents in its team zone. Until
// the hold ends, no other zone run may start there: its initial sync would
// take the held run's documents for documents without a file and move them
// to the trash.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { Git } from '../../../src/state/git.ts';
import type { RunContext } from './context.ts';
import { BudgetBlockedError, Governor, estimate, type App } from './governor.ts';
import { forgetRun, registerRun, type Lock } from './locks.ts';
import { takeTeamLocks } from './runner.ts';
import { GitStateStore, SharedAdmission } from './shared-state.ts';
import { EnvBlockedError } from './results.ts';
import { loadScenarios, type Scenario } from './spec.ts';

const roots: string[] = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scenarios = loadScenarios();
const byId = (id: string) => scenarios.find((scenario) => scenario.id === id) ?? assert.fail(id);
const app: App = { name: 'app1', key: 'app-key', readBudget: async () => ({ requestsRemaining: 5_000, complexityRemaining: 2_000_000, resetAt: 0 }) };
const ZONE = 'team-eng';

/** A Linear team zone in memory: documents by owning run, and the trash. */
function fakeZone() {
  const documents = new Map<string, string>();
  let trashed = 0;
  return {
    get trashed() { return trashed; },
    add(id: string, runId: string) { documents.set(id, runId); },
    /** What a run's cleanup does: it archives its own documents, never trashing them. */
    archiveRun(runId: string) { for (const [id, owner] of documents) if (owner === runId) documents.delete(id); },
    /** What an initial sync does to zone documents it has no file for: it moves them to the trash. */
    initialSync(runId: string) {
      for (const [id, owner] of documents) if (owner !== runId) { documents.delete(id); trashed += 1; }
    },
  };
}

function lockContext(scenario: Scenario, runId: string, signal: AbortSignal, lines: string[]): RunContext {
  return { scenario, signal, names: { runId }, log: (line: string) => lines.push(line) } as unknown as RunContext;
}

it('keeps a held UI run\'s team zone from the next zone run until the hold ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'held-zone-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const remote = join(root, 'control.git');
  await new Git(root).run(['init', '--bare', '--quiet', remote]);
  const governor = (dir: string) => new Governor({ apps: [app], stateDir, maxWaitMs: 0, shared: new SharedAdmission(new GitStateStore({ stateDir: join(root, dir), url: remote })) });
  const zone = fakeZone();
  const held = byId('L6-03');
  const next = byId('L6-04');
  const holdUntil = Date.now() + 3_600_000;

  // Run A reaches its UI step and is held, as the runner leaves it: shared
  // reservation and zone claim retained, team lock kept, run registered as held.
  const a = await governor('a').admit(held, 'aaaaaa', estimate(held), app.name);
  await a.claimZones!([ZONE]);
  zone.add('doc-a1', 'aaaaaa');
  zone.add('doc-a2', 'aaaaaa');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { registerRun } = await import(${JSON.stringify(new URL('./locks.ts', import.meta.url).href)});
    const { takeTeamLocks } = await import(${JSON.stringify(new URL('./runner.ts', import.meta.url).href)});
    const { loadScenarios } = await import(${JSON.stringify(new URL('./spec.ts', import.meta.url).href)});
    const scenario = loadScenarios().find((item) => item.id === 'L6-03');
    const stateDir = ${JSON.stringify(stateDir)};
    const locks = [];
    await takeTeamLocks({ scenario, signal: new AbortController().signal, names: { runId: 'aaaaaa' }, log: () => {} }, stateDir, ['ENG'], locks);
    registerRun(stateDir, 'aaaaaa').hold(${holdUntil});
    locks.forEach((lock) => lock.hold(${holdUntil}));
  `], { stdio: ['ignore', 'inherit', 'inherit'] });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'the held run\'s process ended');

  // Run B, another zone run: it syncs the zone only once both gates let it in, as the runner's setup does.
  const locksB: Lock[] = [];
  const startB = async (gate: 'admission' | 'team lock', signal: AbortSignal, lines: string[] = []) => {
    if (gate === 'admission') {
      const b = await governor('b').admit(next, 'bbbbbb', estimate(next), app.name);
      await b.claimZones!([ZONE]);
      await b.release();
    }
    await takeTeamLocks(lockContext(next, 'bbbbbb', signal, lines), stateDir, ['ENG'], locksB);
    zone.initialSync('bbbbbb');
  };
  // The shared admission keeps it out (a zone-concurrent run too)...
  await assert.rejects(startB('admission', new AbortController().signal), BudgetBlockedError);
  await assert.rejects(governor('b').admit(byId('L1-05'), 'cccccc', estimate(byId('L1-05')), app.name), BudgetBlockedError, 'a zone-concurrent run waits too');
  // ...and so does the team lock on its own, as for a run admitted without the shared admission.
  const waiting = new AbortController();
  const lines: string[] = [];
  const blocked = startB('team lock', waiting.signal, lines);
  await new Promise((resolve) => setTimeout(resolve, 300));
  waiting.abort();
  await assert.rejects(blocked);
  assert.deepEqual(lines, ['waiting for team ENG (held by run aaaaaa)']);
  assert.equal(locksB.length, 0);
  assert.equal(zone.trashed, 0, 'the held run\'s documents are still in the zone, not in the trash');

  // The UI session's answers: run A is taken up in a new process, cleaned up, and lets go.
  const takeUp = await governor('a2').admit(held, 'aaaaaa', estimate(held), app.name, a.owner);
  await takeUp.claimZones!([ZONE]);
  const locksA: Lock[] = [];
  await takeTeamLocks(lockContext(held, 'aaaaaa', new AbortController().signal, []), stateDir, ['ENG'], locksA);
  assert.equal(locksA.length, 1, 'the take-up holds the run\'s own kept lock');
  zone.archiveRun('aaaaaa');
  await takeUp.release();
  registerRun(stateDir, 'aaaaaa', { holdUntil }).done();
  locksA.forEach((lock) => lock.release());

  // Now run B starts, and its initial sync finds nothing of run A's.
  await startB('admission', new AbortController().signal);
  assert.equal(locksB.length, 1);
  assert.equal(zone.trashed, 0, 'the zone\'s trash is unchanged');
  locksB.forEach((lock) => lock.release());
  forgetRun(stateDir, 'bbbbbb');
});

it('lets setup wait past its limit for a zone that a live run holds, and takes a dead run\'s team lock at once', async () => {
  const { SetupDeadline, takeTeamZones } = await import('./runner.ts');
  const { acquireLock } = await import('./locks.ts');
  const root = mkdtempSync(join(tmpdir(), 'zone-wait-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const remote = join(root, 'control.git');
  await new Git(root).run(['init', '--bare', '--quiet', remote]);
  const governor = (dir: string, maxWaitMs: number) => new Governor({ apps: [app], stateDir, maxWaitMs, shared: new SharedAdmission(new GitStateStore({ stateDir: join(root, dir), url: remote })) });
  // L1-05 is the scenario the shared admission lets run beside another zone run; it takes the team lock too.
  const scenario = byId('L1-05');
  assert.equal(scenario.setup.teamZoneLock, true);
  const setupOf = (deadline: InstanceType<typeof SetupDeadline>, grant: Parameters<typeof takeTeamZones>[2], runId: string, lines: string[], locks: Lock[]) =>
    deadline.race(takeTeamZones(lockContext(scenario, runId, new AbortController().signal, lines), stateDir, grant, { ids: [ZONE], lockKeys: ['ENG'] }, locks, deadline).then(() => 'ready'),
      () => new EnvBlockedError('setup did not finish'));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Run A, live, holds the shared zone claim and then team ENG's lock, each well past run B's setup limit.
  const a = await governor('a', 0).admit(scenario, 'aaaaaa', estimate(scenario), app.name);
  await a.claimZones!([ZONE]);
  const b = await governor('b', 60_000).admit(scenario, 'bbbbbb', estimate(scenario), app.name);
  const lockA = await acquireLock('team-eng', { stateDir, runId: 'aaaaaa', timeoutMs: 0 });
  const deadline = new SetupDeadline(3_000);
  const lines: string[] = [];
  const locksB: Lock[] = [];
  const setup = setupOf(deadline, b, 'bbbbbb', lines, locksB);
  await pause(4_000);
  await a.release();
  await pause(4_000);
  lockA.release();
  assert.equal(await setup, 'ready');
  assert.deepEqual(lines, ['waiting for team ENG (held by run aaaaaa)']);
  assert.ok(deadline.creditedMs >= 5_000, `the waits were not counted (${deadline.creditedMs} ms)`);
  assert.equal(locksB.length, 1);
  locksB.splice(0).forEach((lock) => lock.release());
  await b.release();

  // A claim that never answers is not a wait for a held zone: setup's limit still stops it.
  const stalled = { claimZones: () => new Promise<void>(() => {}) };
  await assert.rejects(setupOf(new SetupDeadline(300), stalled, 'cccccc', [], []), EnvBlockedError);

  // A run that died while holding team ENG's lock: the next run takes it over without waiting.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  mkdirSync(join(stateDir, 'locks', 'team-eng'));
  writeFileSync(join(stateDir, 'locks', 'team-eng', 'owner.json'), JSON.stringify({ pid: child.pid, host: hostname(), runId: 'dddddd', since: new Date().toISOString() }));
  const recovered: string[] = [];
  const locksE: Lock[] = [];
  assert.equal(await setupOf(new SetupDeadline(5_000), undefined, 'eeeeee', recovered, locksE), 'ready');
  assert.deepEqual(recovered, [], 'no wait for a dead run\'s lock');
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'locks', 'team-eng', 'owner.json'), 'utf8')).runId, 'eeeeee');
  locksE.splice(0).forEach((lock) => lock.release());
  for (const runId of ['aaaaaa', 'bbbbbb']) forgetRun(stateDir, runId);
});

it('does not let setup\'s limit expire during a pause between two looks at a held team lock', async () => {
  const { SetupDeadline, takeTeamZones } = await import('./runner.ts');
  const { acquireLock } = await import('./locks.ts');
  const root = mkdtempSync(join(tmpdir(), 'zone-pause-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const scenario = byId('L1-05');
  // Less setup time is left than one 500 ms pause between two looks at the lock.
  const holder = await acquireLock('team-eng', { stateDir, runId: 'aaaaaa', timeoutMs: 0 });
  const deadline = new SetupDeadline(300);
  const locks: Lock[] = [];
  const setup = deadline.race(takeTeamZones(lockContext(scenario, 'bbbbbb', new AbortController().signal, []), stateDir, undefined, { ids: [ZONE], lockKeys: ['ENG'] }, locks, deadline).then(() => 'ready'),
    () => new EnvBlockedError('setup did not finish'));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  holder.release();
  assert.equal(await setup, 'ready');
  assert.equal(locks.length, 1);
  locks.splice(0).forEach((lock) => lock.release());
});

it('locks a team zone a run writes only through its README, so two such runs do not hold it at once, while runs on separate zones start together', async () => {
  const { SetupDeadline, runTeamZones, takeTeamZones } = await import('./runner.ts');
  const { buildRunTree } = await import('./corpus.ts');
  const { runNames } = await import('./isolation.ts');
  const root = mkdtempSync(join(tmpdir(), 'readme-zone-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const scenario = byId('L1-05');
  assert.equal(scenario.setup.teamZoneLock, true);
  const annotation = (team: string) => `---\nlinear-team: ${team}\n---\n# Area\n`;
  const readmes = new Map([['eng/README.md', annotation('ENG')], ['ops/README.md', annotation('OPS')], ['docs/README.md', annotation('DOCS')]]);
  const teams = new Map([['ENG', { id: 'team-eng' }], ['OPS', { id: 'team-ops' }], ['DOCS', { id: 'team-docs' }]]);
  // Each run's slice: files below its own zone and, for runs A and B, the DOCS zone's own README, which the engine syncs into DOCS.
  const zonesOf = (runId: string, paths: string[]) => {
    const tree = buildRunTree({ slice: 'mini', paths }, new Map(paths.filter((path) => readmes.has(path)).map((path) => [path, readmes.get(path)!])), runNames(runId));
    return { tree, zones: runTeamZones(tree, teams) };
  };
  const a = zonesOf('aaaaaa', ['eng/README.md', 'eng/guides/start.md', 'docs/README.md']);
  const b = zonesOf('bbbbbb', ['ops/README.md', 'ops/runbooks/deploy.md', 'docs/README.md']);
  const c = zonesOf('cccccc', ['ops/README.md', 'ops/runbooks/deploy.md']);
  // DOCS is no zone the runs place files below, yet it is in their lock keys and ids, one set.
  assert.deepEqual([...a.tree.teamZones.keys()], ['ENG']);
  assert.deepEqual([...b.tree.teamZones.keys()], ['OPS']);
  assert.deepEqual(a.zones, { lockKeys: ['DOCS', 'ENG'], ids: ['team-docs', 'team-eng'] });
  assert.deepEqual(b.zones, { lockKeys: ['DOCS', 'OPS'], ids: ['team-docs', 'team-ops'] });
  assert.deepEqual(c.zones, { lockKeys: ['OPS'], ids: ['team-ops'] });

  const setup = (runId: string, zones: { ids: string[]; lockKeys: string[] }, signal: AbortSignal, lines: string[], locks: Lock[]) =>
    takeTeamZones(lockContext(scenario, runId, signal, lines), stateDir, undefined, zones, locks, new SetupDeadline(60_000));

  // Run A takes its zones, the README-only DOCS zone included.
  const locksA: Lock[] = [];
  await setup('aaaaaa', a.zones, new AbortController().signal, [], locksA);
  assert.equal(locksA.length, 2);

  // Run B, whose slice writes the same DOCS README, waits for DOCS and holds none of its zones meanwhile.
  const waiting = new AbortController();
  const linesB: string[] = [];
  const locksB: Lock[] = [];
  const blocked = setup('bbbbbb', b.zones, waiting.signal, linesB, locksB);
  await new Promise((resolve) => setTimeout(resolve, 300));
  waiting.abort();
  await assert.rejects(blocked);
  assert.deepEqual(linesB, ['waiting for team DOCS (held by run aaaaaa)']);
  assert.equal(locksB.length, 0);

  // Run C, on a zone run A does not write into, starts while run A still holds its zones.
  const linesC: string[] = [];
  const locksC: Lock[] = [];
  await setup('cccccc', c.zones, new AbortController().signal, linesC, locksC);
  assert.deepEqual(linesC, []);
  assert.equal(locksC.length, 1);
  locksC.splice(0).forEach((lock) => lock.release());

  // Once run A lets go, run B takes DOCS.
  locksA.splice(0).forEach((lock) => lock.release());
  await setup('bbbbbb', b.zones, new AbortController().signal, [], locksB);
  assert.equal(locksB.length, 2);
  locksB.splice(0).forEach((lock) => lock.release());
});
