import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CANARY_BASELINE, CANARY_ENABLED, CANARY_EVIDENCE, CANARY_FILE, CANARY_HOOK_ENTRY, canaryFacts, canaryIsolated, canaryScript, type CanaryFacts } from './security-canary.ts';
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

// The hooks step's environment names as a hosted runner gave them to the canary in a live L2-41 run
// (November 2026). A snapshot: a name the runner adds later shows up only in the next live L2-41 run.
const hostedRunnerNames = ['ACTIONS_ORCHESTRATION_ID', 'CANARY_HOOK_KEY', 'CI', 'GITHUB_ACTION', 'GITHUB_ACTIONS', 'GITHUB_ACTION_REF', 'GITHUB_ACTION_REPOSITORY', 'GITHUB_ACTOR', 'GITHUB_ACTOR_ID', 'GITHUB_API_URL', 'GITHUB_ARTIFACTS', 'GITHUB_ARTIFACTS_LIST', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_GRAPHQL_URL', 'GITHUB_HEAD_REF', 'GITHUB_JOB', 'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_REF_PROTECTED', 'GITHUB_REF_TYPE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_RETENTION_DAYS', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_SERVER_URL', 'GITHUB_SHA', 'GITHUB_TRIGGERING_ACTOR', 'GITHUB_WORKFLOW', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKSPACE', 'GIT_TERMINAL_PROMPT', 'HOME', 'HOSTNAME', 'LC_CTYPE', 'MDBISYNC_HOOKS', 'MDBISYNC_NODE', 'MDBISYNC_SECURITY_CANARY', 'PATH', 'PRE_COMMIT', 'PRE_COMMIT_COLOR', 'PWD', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'RUNNER_NAME', 'RUNNER_OS', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'RUNNER_TRACKING_ID', 'RUNNER_WORKSPACE', 'SHLVL', '_'];
const clean = (environmentNames: string[]): CanaryFacts => ({ environmentNames, hookKeyMatches: true, linearSecretMatches: false, linearTokenMatches: false, appTokenMatches: false });

test('isolation accepts the runner orchestration id and nothing else named ACTIONS_*', () => {
  assert.equal(canaryIsolated(clean(hostedRunnerNames)), true);
  const leaking = [
    'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RUNTIME_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL',
    // An ACTIONS_* name nobody has checked yet fails.
    'ACTIONS_SOMETHING_NEW', 'ACTIONS_', 'ACTIONS_ORCHESTRATION_ID_TOKEN', 'ACTIONS_ORCHESTRATION',
    'INPUT_LINEAR-CLIENT-SECRET', 'INPUT_APP-TOKEN', 'INPUT_ACTIONS_ORCHESTRATION_ID',
    'CANARY_LINEAR_SECRET', 'CANARY_APP_TOKEN',
  ];
  for (const name of leaking) assert.equal(canaryIsolated(clean([...hostedRunnerNames, name])), false, name);
  for (const flag of ['linearSecretMatches', 'linearTokenMatches', 'appTokenMatches'] as const) assert.equal(canaryIsolated({ ...clean(hostedRunnerNames), [flag]: true }), false, flag);
  assert.equal(canaryIsolated({ ...clean(hostedRunnerNames), hookKeyMatches: false }), false);
});
