import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('CI shards the complete npm test suite on hosted runners', async () => {
  const job = workflow.jobs.test;
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(job.strategy['fail-fast'], false);
  const scripts = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(job.steps.find((step: { name?: string }) => step.name === 'Test').run,
    scripts.test.replace('node --test ', 'node --test --test-shard=${{ matrix.shard }}/4 '));
  for (const job of Object.values(workflow.jobs) as { 'runs-on': string }[]) {
    assert.equal(job['runs-on'], 'ubuntu-latest');
  }
});

test('the required check runs after validation and every shard, including failures', () => {
  const job = workflow.jobs.check;
  assert.equal(job.name ?? 'check', 'check');
  assert.equal(job.if, '${{ always() }}');
  assert.deepEqual(job.needs, ['validate', 'test']);
  assert.equal(job.steps.length, 1);
  const step = job.steps[0];
  assert.deepEqual(step.env, {
    VALIDATION_RESULT: '${{ needs.validate.result }}',
    TEST_RESULT: '${{ needs.test.result }}',
  });
  for (const validation of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const tests of ['success', 'failure', 'cancelled', 'skipped']) {
      // GitHub's default bash shell stops at the first failed command.
      const result = spawnSync('bash', ['-e', '-c', step.run], {
        env: { ...process.env, VALIDATION_RESULT: validation, TEST_RESULT: tests },
      });
      assert.equal(result.status === 0, validation === 'success' && tests === 'success',
        `validation=${validation}, tests=${tests}`);
    }
  }
});
