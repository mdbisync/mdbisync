import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CANARY_BASELINE, CANARY_ENABLED, CANARY_EVIDENCE, CANARY_FILE, CANARY_HOOK_ENTRY, canaryFacts, canaryScript } from './security-canary.ts';
import { loadScenarios } from './spec.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('the Actions variation preserves every blocked-secret assertion and dispatches the workflow', () => {
  const scenarios = loadScenarios();
  const original = scenarios.find(scenario => scenario.id === 'L2-35')!;
  const actions = scenarios.find(scenario => scenario.id === 'L2-41')!;
  assert.equal(actions.mode, 'actions');
  assert.deepEqual(actions.checks.invariants, original.checks.invariants);
  // L2-35's assertions first, then the canary's, then the oracles only an Actions run has: who wrote and merged.
  const shared = original.checks.assertions.length;
  assert.deepEqual(actions.checks.assertions.slice(0, shared), original.checks.assertions);
  assert.equal(actions.checks.assertions[shared]?.subject, 'securityCanary.isolated');
  assert.deepEqual(actions.checks.assertions.slice(shared + 1).map((assertion) => assertion.subject), ['writes.commitIdentity', 'pullRequests.merger', 'pullRequests.mergeKind']);
  assert.deepEqual(actions.steps[1], { kind: 'run', action: 'workflow', args: { event: 'workflow_dispatch' } });
  assert.deepEqual(actions.steps.at(-1), original.steps.at(-1));
});

test('the canary fails on its own secrets or a wrong key and records only facts', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'security-canary-'));
  const linear = randomUUID();
  const app = randomUUID();
  const key = randomUUID();
  const token = randomUUID();
  try {
    const script = join(directory, 'canary.mjs');
    await writeFile(script, canaryScript(digest(key)));
    await writeFile(join(directory, CANARY_BASELINE), JSON.stringify([linear, app, token].map(value => ({ hash: digest(value), length: value.length }))));
    for (const leak of [false, true]) {
      const child = spawn(process.execPath, [script], { env: {
        [CANARY_ENABLED]: '1', PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_RUN_ID: randomUUID(), CANARY_HOOK_KEY: key,
        ...(leak ? { 'INPUT_LINEAR-CLIENT-SECRET': `https://example.invalid/?secret=${linear}`, APP_INPUT: `AUTHORIZATION: basic ${Buffer.from('x-access-token:' + app).toString('base64')}`, MDBISYNC_AUTH: `Bearer ${token}` } : {}),
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(code, leak ? 1 : 0);
      const raw = await readFile(join(directory, 'mdbisync-report', CANARY_EVIDENCE), 'utf8');
      const facts = canaryFacts(raw).at(-1)!;
      assert.equal(facts.hookKeyMatches, true);
      assert.equal(facts.linearSecretMatches, leak);
      assert.equal(facts.appTokenMatches, leak);
      assert.equal(facts.linearTokenMatches, leak);
      for (const value of [linear, app, token, key, digest(linear), digest(app), digest(key)]) assert.ok(!raw.includes(value));
    }
    // The copied PR check and person hooks must run without canary-only inputs.
    const ordinary = spawn(process.execPath, [script], { env: {}, stdio: 'ignore' });
    assert.equal(await new Promise((resolve, reject) => { ordinary.on('error', reject); ordinary.on('close', resolve); }), 0);
    // The hook entry as pre-commit runs it: outside the sync's hooks step no Node is named, and it takes `node` from PATH.
    await writeFile(join(directory, CANARY_FILE), canaryScript(digest(key)));
    const entry = spawn('sh', ['-c', CANARY_HOOK_ENTRY], { cwd: directory, env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') }, stdio: 'ignore' });
    assert.equal(await new Promise((resolve, reject) => { entry.on('error', reject); entry.on('close', resolve); }), 0);
    await writeFile(script, canaryScript(digest('different-key')));
    const child = spawn(process.execPath, [script], { env: { [CANARY_ENABLED]: '1', RUNNER_TEMP: directory, GITHUB_RUN_ID: randomUUID(), CANARY_HOOK_KEY: key }, stdio: 'ignore' });
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 1);
    assert.equal(canaryFacts(await readFile(join(directory, 'mdbisync-report', CANARY_EVIDENCE), 'utf8')).at(-1)?.hookKeyMatches, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('canary evidence rejects values and unrelated fields', () => {
  assert.deepEqual(canaryFacts('Security canary: {"secret":"value"}'), []);
  assert.deepEqual(canaryFacts('Security canary: null'), []);
});
