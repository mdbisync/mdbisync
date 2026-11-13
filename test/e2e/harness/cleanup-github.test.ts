import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { GitError } from '../../../src/state/index.ts';
import type { TestConfig } from './config.ts';
import type { Governor } from './governor.ts';
import { cleanupAndCount, createRunContext, removeRunRefsAndPullRequests, runScenario } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios } from './spec.ts';

const scenario = loadScenarios().find((item) => item.id === 'L2-11');
assert.ok(scenario, 'L2-11 must exist as the live setup fixture');

it('leaves resources untouched when a scheduled writer cannot be proven stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-cleanup-'));
  try {
    const { ctx } = createRunContext(scenario, 'abcdef', root, { config: {} as TestConfig, stateDir: root, outDir: root, log: () => {} });
    ctx.observations.set('workflows.unstopped', true);
    const outcome = await cleanupAndCount(ctx);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail!, /retain resources and shared reservation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ['cache', 'push']) {
  it(`handles the reservation after a failed ${phase} with a conservative remote-write proof`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'empty-cleanup-'));
    try {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/repos/example/sandbox/installation') return Response.json({ id: 1, app_slug: 'test' });
        if (path === '/app/installations/1/access_tokens') return Response.json({ token: 'fake-token' });
        assert.fail(`unexpected network request: ${path}`);
      });
      t.mock.method(Sandbox.prototype, 'refreshCache', async () => {
        if (phase === 'cache') throw new GitError(['fetch', 'origin'], 128, 'remote: Repository not found.');
        return 'a'.repeat(40);
      });
      t.mock.method(Sandbox.prototype, 'manifest', async () => ({}));
      t.mock.method(Sandbox.prototype, 'createTrackedBranch', async () => { throw new Error('push answer lost'); });
      const listing = t.mock.method(Sandbox.prototype, 'runRefs', async () => {
        if (phase === 'cache') assert.fail('empty run must not list refs');
        throw new Error('listing failed');
      });
      let released = 0;
      const config = {
        sandboxUrl: '', editors: { 'editor-a': '', 'editor-b': '' }, githubAppMissing: [],
        owner: 'example', repo: 'sandbox', gitUrl: 'https://github.com/example/sandbox.git', missing: [],
        linearApps: [{ name: 'app1', clientId: 'test', clientSecret: 'test' }],
        githubApp: { clientId: 'test', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
      } as TestConfig;
      const governor = { admit: async () => ({ app: { name: 'app1' }, owner: 'fake-owner', waitedMs: 0, release: async () => { released++; } }) } as unknown as Governor;
      const result = await runScenario(scenario, { config, governor, stateDir: root, outDir: root, appClients: new Map(), expectedRed: new Set(), log: () => {} }, 'abcdef');
      assert.match(result.reason!, phase === 'cache' ? /Repository not found/ : /push answer lost/);
      assert.deepEqual(result.cleanup, phase === 'cache' ? { ok: true } : { ok: false, detail: 'refs: listing failed' });
      assert.equal(result.sharedReservationKept, phase === 'cache' ? undefined : true);
      assert.equal(released, phase === 'cache' ? 1 : 0);
      assert.equal(listing.mock.callCount(), phase === 'cache' ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const state of ['write-attempted', 'zone', 'project', 'document', 'missing-ledger']) {
  it(`requires remote cleanup when emptiness is not proved: ${state}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nonempty-cleanup-'));
    try {
      const { ctx } = createRunContext(scenario, 'abcdef', root, { config: {} as TestConfig, stateDir: root, outDir: root, log: () => {} });
      if (state !== 'missing-ledger') ctx.owned.scope(state === 'zone' ? ['team'] : []);
      if (state === 'write-attempted') ctx.remoteWritesStarted = true;
      if (state === 'project') ctx.owned.project({ id: 'project', name: 'Field notes abcdef' });
      if (state === 'document') ctx.owned.record({ kind: 'document', id: 'doc', confirmed: false });
      let listings = 0;
      ctx.sandbox = { runRefs: async () => { listings++; throw new Error('listing failed'); } } as unknown as Sandbox;
      assert.deepEqual(await cleanupAndCount(ctx), { ok: false, detail: 'refs: listing failed' });
      assert.equal(listings, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

it('retries the initial and verification ref listings while preserving deletion and verification', async () => {
  let calls = 0;
  const removed: string[][] = [];
  const ref = 'refs/heads/t/abcdef/sync';
  const problems = await removeRunRefsAndPullRequests('abcdef', {
    runRefs: async () => {
      calls++;
      if (calls === 1 || calls === 3) throw new GitError(['ls-remote', 'origin'], 128, 'The requested URL returned error: 504');
      return calls === 2 ? [{ ref, oid: 'a'.repeat(40), runId: 'abcdef' }] : [];
    },
    deleteRunRefs: async (_runId, refs) => { removed.push([...refs]); },
  }, undefined);
  assert.deepEqual(problems, []);
  assert.deepEqual(removed, [[ref]]);
  assert.equal(calls, 4);
});
