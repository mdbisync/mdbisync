// The pre-commit template pushes its fixes with the workflow's own token, which
// starts no other workflow. Its "Start the other CI on the fixing commit" step
// starts the workflows the repository lists on the pull request's branch, so
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

const workflow = parse(await readFile(new URL('../../examples/pre-commit.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> };
// The publish job pushes the fix; the hooks job holds no token (hook-isolation.test.ts).
const job = workflow.jobs['publish']!;
const names = job.steps.map((step) => step.name);
const step = job.steps.find((item) => item.name === 'Start the other CI on the fixing commit')!;

/** Runs the step with a `curl` that records its arguments instead of calling GitHub. */
async function start(workflows: string): Promise<{ status: number | null; output: string; calls: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'start-ci-'));
  try {
    const log = join(dir, 'calls');
    await writeFile(join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    const env = { PATH: `${dir}${delimiter}${process.env.PATH}`, GH_TOKEN: 'token', REPOSITORY: 'owner/repo', HEAD_BRANCH: 'mdbisync/linear', WORKFLOWS: workflows };
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run!], { env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    const calls = await readFile(log, 'utf8').then((text) => text.split('\n').filter(Boolean), () => []);
    return { status: result.status, output: result.stdout + result.stderr, calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('pre-commit template: CI on the fixing commit', () => {
  it('starts the listed workflows only after a push of fixes, while the fixing commit\'s check is pending', () => {
    assert.ok(step, 'the step is missing');
    // The publish job runs only for a same-repository pull request whose hooks changed files.
    assert.match(job.if ?? '', /needs\.hooks\.outputs\.changed == 'true'/);
    assert.match(job.if ?? '', /head\.repo\.full_name == github\.repository/);
    assert.equal(step.if, "${{ vars.MDBISYNC_CI_WORKFLOWS != '' }}");
    assert.equal(step.env?.WORKFLOWS, '${{ vars.MDBISYNC_CI_WORKFLOWS }}');
    // After the fixing commit's check is marked pending: a failed start then fails that check, which the sync sees.
    assert.ok(names.indexOf('Mark the fixing commit pending') < names.indexOf(step.name), 'it starts CI before the fixing commit has its check');
    assert.ok(names.indexOf(step.name) < names.indexOf('Publish result on the fixing commit'));
    assert.equal(job.permissions.actions, 'write');
    assert.deepEqual(Object.keys(workflow.jobs), ['hooks', 'publish', 'pre-commit']);
  });

  it('gives the fixing commit a check under each job\'s name, since each job leaves one on the earlier head', () => {
    // The sync merges no head that lacks a check its earlier heads show.
    const checks = Object.entries(workflow.jobs).map(([id, each]) => each.name ?? id);
    const mark = job.steps.find((item) => item.name === 'Mark the fixing commit pending')!.run!;
    const created = /for name in ((?:'[^']+' ?)+); do/.exec(mark)?.[1]?.match(/'[^']+'/g)?.map((name) => name.slice(1, -1));
    assert.deepEqual(created, checks);
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
    assert.deepEqual(calls.map((call) => /\/actions\/workflows\/([^/]+)\/dispatches/.exec(call)?.[1]), ['tests.yml', 'lint.yaml', 'build.yml']);
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
