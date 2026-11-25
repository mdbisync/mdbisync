import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type TestContext, test } from 'node:test';

const runner = fileURLToPath(new URL('./test-temp-cleanup.ts', import.meta.url));
const helpers = new URL('../src/state/test-helpers.ts', import.meta.url).href;
const git = new URL('../src/state/git.ts', import.meta.url).href;

for (const [name, body, status, leaks] of [
  ['passing test', '', 0, false],
  ['failing test', 'throw new Error("expected failure");', 1, false],
  ['leaking test', 'mkdtempSync(join(tmpdir(), "deliberate-leak-"));', 1, true],
  ['failing leaking test', 'mkdtempSync(join(tmpdir(), "deliberate-leak-")); throw new Error("expected failure");', 1, true],
] as const) {
  test(`cleanup check detects a ${name} and removes its own directory`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-check-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, 'fixture.mjs');
    writeFileSync(script, `
      import { test } from 'node:test';
      import { mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      test('fixture', () => { ${body} });
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, script], { env, encoding: 'utf8' });
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(result.stderr.includes('Temporary directory cleanup failed:'), leaks, result.stderr);
    assert.deepEqual(readdirSync(root), ['fixture.mjs']);
  });
}

test('shared fixtures are cleaned after abandoned fixtures and failed setup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-cleanup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'fixture.mjs');
  writeFileSync(script, `
    import { test } from 'node:test';
    import { createFixture, pathWithoutGitLfs } from ${JSON.stringify(helpers)};
    import { Git } from ${JSON.stringify(git)};
    test('abandoned fixtures', async () => {
      await createFixture();
      await pathWithoutGitLfs();
      throw new Error('expected failure');
    });
    test('failed setup', async (t) => {
      t.mock.method(Git.prototype, 'run', async () => { throw new Error('expected setup failure'); });
      await createFixture();
    });
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, script], { env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /expected failure/);
  assert.match(result.stdout, /expected setup failure/);
  assert.doesNotMatch(result.stderr, /Temporary directory cleanup failed:/);
  assert.deepEqual(readdirSync(root), ['fixture.mjs']);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`cleanup check removes its directory after ${signal}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-signal-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, 'fixture.mjs');
    writeFileSync(script, `
      import { test } from 'node:test';
      import { mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      test('interrupted fixture', async () => {
        mkdtempSync(join(tmpdir(), 'interrupted-'));
        console.log('FIXTURE_READY');
        await new Promise((resolve) => setTimeout(resolve, 30000));
      });
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [runner, script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture did not become ready')), 10000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('FIXTURE_READY')) { clearTimeout(timeout); resolve(); }
      });
      child.once('error', reject);
    });
    child.kill(signal);
    assert.notEqual(await ended, 0, stdout + stderr);
    assert.match(stderr, /Forwarding SIG(INT|TERM) to test runner/);
    assert.deepEqual(readdirSync(root), ['fixture.mjs']);
  });
}

/** Runs the runner with `args`, where `[file]` stands for a fixture test file that prints its NODE_COMPILE_CACHE. */
function runFixture(t: TestContext, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runner-arguments-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'fixture.mjs');
  writeFileSync(script, `
    import { test } from 'node:test';
    test('fixture', () => { console.log('CACHE=' + process.env.NODE_COMPILE_CACHE); });
    test('other', () => {});
  `);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  if (env.NODE_COMPILE_CACHE === undefined) delete childEnv.NODE_COMPILE_CACHE;
  const result = spawnSync(process.execPath, [runner, ...args.map((arg) => (arg === '[file]' ? script : arg))], { env: childEnv, encoding: 'utf8' });
  assert.deepEqual(readdirSync(root), ['fixture.mjs']);
  return result;
}

test('options after the file patterns apply, as npm passes them', (t) => {
  const result = runFixture(t, ['[file]', '--test-reporter=tap', '--test-name-pattern=fixture']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^TAP version 13$/m);
  assert.match(result.stdout, /^# tests 1$/m);
});

test('options before the file patterns keep their order, values given apart included', (t) => {
  const result = runFixture(t, ['--test-reporter', 'tap', '--test-name-pattern=fixture', '[file]']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^TAP version 13$/m);
  assert.match(result.stdout, /^# tests 1$/m);
});

test('an option after the file patterns without its value is refused, so it cannot take a pattern for one', (t) => {
  const result = runFixture(t, ['[file]', '--test-reporter=tap', '--test-reporter-destination']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Write --test-reporter-destination after the file patterns as --test-reporter-destination=<value>, or put it before them/);
});

test('an option that takes no value may end the arguments', (t) => {
  const result = runFixture(t, ['[file]', '--test-reporter=tap', '--test-force-exit']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# tests 2$/m);
});

test('a coverage run compiles afresh, since a warm cache can change what coverage reports', (t) => {
  const result = runFixture(t, ['[file]', '--test-reporter=spec', '--experimental-test-coverage']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CACHE=undefined\n/);
});

test('test processes share the compile cache, unless the caller names another', (t) => {
  const own = runFixture(t, ['--test-reporter=spec', '[file]']);
  assert.equal(own.status, 0, own.stdout + own.stderr);
  const shared = fileURLToPath(new URL('../node_modules/.cache/test-compile-cache', import.meta.url));
  assert.ok(own.stdout.includes(`CACHE=${shared}\n`), own.stdout);
  const cache = mkdtempSync(join(tmpdir(), 'named-compile-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const named = runFixture(t, ['--test-reporter=spec', '[file]'], { NODE_COMPILE_CACHE: cache });
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.ok(named.stdout.includes(`CACHE=${cache}\n`), named.stdout);
});
