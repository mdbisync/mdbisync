import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderedFiles, plan } from './test-run.ts';

const runner = fileURLToPath(new URL('./test-run.ts', import.meta.url));

test('takes the options it supports in --name=value form, and leaves the rest to node --test', () => {
  assert.deepEqual(plan(['--test-concurrency=3', '--test-name-pattern=a', '--test-name-pattern=b', '--test-skip-pattern=c', '--test-timeout=500', 'src/**/*.test.ts'], ''), {
    patterns: ['src/**/*.test.ts'], concurrency: 3, namePatterns: ['a', 'b'], skipPatterns: ['c'],
    reporters: [{ name: 'spec', destination: 'stdout' }], timeout: 500,
  });
  assert.equal(plan(['x.test.ts'], '')?.concurrency, availableParallelism());
  assert.deepEqual(plan(['--test-reporter=dot', '--test-reporter=junit', '--test-reporter-destination=stdout', '--test-reporter-destination=out.xml', 'x.test.ts'], '')?.reporters,
    [{ name: 'dot', destination: 'stdout' }, { name: 'junit', destination: 'out.xml' }]);
  for (const args of [
    ['--experimental-test-coverage', 'x.test.ts'], ['--test-only', 'x.test.ts'], ['--test-concurrency', '3', 'x.test.ts'],
    ['--test-concurrency=0', 'x.test.ts'], ['--test-reporter=dot', '--test-reporter=tap', 'x.test.ts'],
    ['--test-reporter=dot', '--test-reporter=tap', '--test-reporter-destination=a', 'x.test.ts'],
    ['--test-reporter=./my-reporter.mjs', 'x.test.ts'], ['--test-concurrency=2'],
  ]) assert.equal(plan(args, ''), undefined, args.join(' '));
  assert.equal(plan(['x.test.ts'], '--test-shard=2/2'), undefined);
  assert.notEqual(plan(['x.test.ts'], '--max-old-space-size=4096'), undefined);
});

test('orders files by their last duration, longest first, by name otherwise, and never under node_modules', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'test-run-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a/one.test.ts', 'a/two.test.ts', 'b/three.test.ts', 'b/four.test.ts', 'node_modules/dep/five.test.ts']) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), '');
  }
  const at = (name: string) => relative(process.cwd(), join(root, name));
  assert.deepEqual(orderedFiles([join(root, '**/*.test.ts')], {}), ['a/one.test.ts', 'a/two.test.ts', 'b/four.test.ts', 'b/three.test.ts'].map(at));
  assert.deepEqual(orderedFiles([join(root, '**/*.test.ts'), join(root, 'b/*.test.ts')], { [at('b/three.test.ts')]: 50, [at('a/two.test.ts')]: 10 }),
    ['b/three.test.ts', 'a/two.test.ts', 'a/one.test.ts', 'b/four.test.ts'].map(at));
});

test('exits as node --test does: a failing todo test passes, a failing test fails, a pattern that matches nothing passes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'test-run-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'todo.test.mjs'), "import { test } from 'node:test'; test('later', { todo: true }, () => { throw new Error('not yet'); });");
  writeFileSync(join(root, 'fails.test.mjs'), "import { test } from 'node:test'; test('fails', () => { throw new Error('expected failure'); });");
  // As a run of its own, not a test of this one.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const status = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' }).status;
  assert.equal(status('todo.test.mjs'), 0);
  assert.equal(status('fails.test.mjs'), 1);
  assert.equal(status('todo.test.mjs', 'fails.test.mjs'), 1);
  assert.equal(status('none/**/*.test.mjs'), 0);
});
