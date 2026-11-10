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
  const deadline = new SetupDeadline(1_000);
  const lines: string[] = [];
  const locksB: Lock[] = [];
  const setup = setupOf(deadline, b, 'bbbbbb', lines, locksB);
  await pause(2_500);
  await a.release();
  await pause(2_500);
  lockA.release();
  assert.equal(await setup, 'ready');
  assert.deepEqual(lines, ['waiting for team ENG (held by run aaaaaa)']);
  assert.ok(deadline.creditedMs >= 3_000, `the waits were not counted (${deadline.creditedMs} ms)`);
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
