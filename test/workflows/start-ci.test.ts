// The pre-commit template pushes its fixes with the workflow's own token, which
// starts no other workflow. Its "Start genuine CI on the fixing commit" step
// starts itself and the workflows the repository lists on the pull request's branch, so
// the fixing commit runs the same checks as the commit before it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

interface Step { name?: string; if?: string; env?: Record<string, string>; run?: string }

interface Job { name?: string; needs?: string[]; if?: string; permissions: Record<string, string>; steps: Step[] }

const workflow = parse(await readFile(new URL('../../examples/pre-commit.yml', import.meta.url), 'utf8')) as { on: Record<string, unknown>; jobs: Record<string, Job> };
// The publish job pushes the fix; the hooks job holds no token (hook-isolation.test.ts).
const job = workflow.jobs['publish']!;
const names = job.steps.map((step) => step.name);
const step = job.steps.find((item) => item.name === 'Start genuine CI on the fixing commit')!;

/** Runs the step with a `curl` that records its arguments instead of calling GitHub. */
async function start(workflows: string): Promise<{ status: number | null; output: string; calls: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'start-ci-'));
  try {
    const log = join(dir, 'calls');
    await writeFile(join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    const env = { PATH: `${dir}${delimiter}${process.env.PATH}`, GH_TOKEN: 'token', REPOSITORY: 'owner/repo', HEAD_BRANCH: 'mdbisync/linear', WORKFLOWS: workflows, WORKFLOW_REF: 'owner/repo/.github/workflows/pre-commit.yml@refs/heads/mdbisync/linear' };
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run!], { env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    const calls = await readFile(log, 'utf8').then((text) => text.split('\n').filter(Boolean), () => []);
    return { status: result.status, output: result.stdout + result.stderr, calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('pre-commit template: CI on the fixing commit', () => {
  it('starts genuine CI only after a successful pull-request fix is pushed', () => {
    assert.ok(step, 'the step is missing');
    // The publish job runs only for a same-repository pull request whose hooks changed files.
    assert.match(job.if ?? '', /needs\.hooks\.outputs\.changed == 'true'/);
    assert.match(job.if ?? '', /head\.repo\.full_name == github\.repository/);
    assert.equal(step.if, undefined, 'the formatter itself must always run on the fixing head');
    assert.match(job.if ?? '', /github\.event_name == 'pull_request'/);
    assert.match(job.if ?? '', /needs\.hooks\.result == 'success'/);
    assert.equal(step.env?.WORKFLOWS, '${{ vars.MDBISYNC_CI_WORKFLOWS }}');
    assert.ok(names.indexOf('Push fixes') < names.indexOf(step.name), 'CI started before the fix was pushed');
    assert.equal(job.permissions.checks, undefined);
    assert.equal(job.permissions.actions, 'write');
    assert.deepEqual(Object.keys(workflow.jobs), ['hooks', 'publish', 'pre-commit']);
  });

  it('dispatches its own workflow even when the repository has no other CI', async () => {
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    const { status, output, calls } = await start('');
    assert.equal(status, 0, output);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /actions\/workflows\/pre-commit.yml\/dispatches/);
    assert.doesNotMatch(calls[0]!, /check-runs/);
  });

  it('keeps `pre-commit` the check to require: it fails unless the hooks passed and their fix, if any, was published', () => {
    const gate = workflow.jobs['pre-commit']!;
    assert.deepEqual(gate.needs, ['hooks', 'publish']);
    assert.equal(gate.if, '${{ always() }}');
    assert.deepEqual(gate.permissions, {});
    const script = gate.steps[0]!.run!;
    const verdict = (hooks: string, publish: string) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { env: { PATH: process.env.PATH, HOOKS_RESULT: hooks, PUBLISH_RESULT: publish }, encoding: 'utf8' }).status;
    assert.equal(verdict('success', 'success'), 0);
    assert.equal(verdict('success', 'skipped'), 0);
    for (const [hooks, publish] of [['success', 'failure'], ['success', 'cancelled'], ['failure', 'skipped'], ['failure', 'success'], ['cancelled', 'skipped']]) {
      assert.notEqual(verdict(hooks!, publish!), 0, `${hooks} ${publish}`);
    }
  });

  it('dispatches each listed workflow on the pull request branch', async () => {
    const { status, output, calls } = await start('tests.yml, lint.yaml\nbuild.yml');
    assert.equal(status, 0, output);
    assert.deepEqual(calls.map((call) => /\/actions\/workflows\/([^/]+)\/dispatches/.exec(call)?.[1]), ['pre-commit.yml', 'tests.yml', 'lint.yaml', 'build.yml']);
    for (const call of calls) assert.ok(call.includes('--data {"ref":"mdbisync/linear"}'), call);
  });

  it('refuses a list entry that is not a workflow file name, before it starts anything', async () => {
    for (const bad of ['tests.yml ../../pulls', 'tests', 'tests.yml;id']) {
      const { status, output, calls } = await start(bad);
      assert.notEqual(status, 0, bad);
      assert.match(output, /MDBISYNC_CI_WORKFLOWS must list workflow file names/);
      assert.deepEqual(calls, [], bad);
    }
  });
});
