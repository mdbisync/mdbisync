import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { FakeLinear } from '../linear/fake-linear.ts';
import { main } from './run.ts';

it('the probe retains safe OAuth and query diagnostics when setup fails', { timeout: 15_000 }, async () => {
  const fake = await new FakeLinear().start();
  const directory = await mkdtemp(join(tmpdir(), 'probe-request-log-'));
  const reportPath = join(directory, 'report.json');
  fake.fault = (request) => {
    if (request.operation === 'Teams') return { status: 400, headers: { 'x-request-id': 'query-failed' }, body: { errors: [{ message: 'Setup refused', extensions: { code: 'INPUT_ERROR' } }] } };
    if (request.path === '/oauth/revoke') return { status: 401, headers: { 'x-request-id': 'revoke-failed' }, body: {} };
    return undefined;
  };
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, LINEAR_TEST_APP_CLIENT_ID: 'probe-client', LINEAR_TEST_APP_CLIENT_SECRET: 'probe-secret', LINEAR_BASE_URL: fake.url };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run.ts', import.meta.url)), '--no-facts', '--json', reportPath], { env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 2, output);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.failed, true);
    assert.deepEqual(report.requestLog.map((e: { operation: string }) => e.operation), ['oauth.token', 'Teams', 'oauth.revoke']);
    assert.equal(report.requestLog[1].requestId, 'query-failed');
    assert.equal(report.requestLog[2].requestId, 'revoke-failed');
    for (const entry of report.requestLog) {
      assert.ok(entry.startedAt.endsWith('Z'));
      assert.ok(entry.finishedAt.endsWith('Z'));
      assert.equal(entry.grantType, 'client_credentials');
    }
    for (const secret of ['probe-client', 'probe-secret', 'fake-token']) {
      assert.ok(!JSON.stringify(report).includes(secret));
      assert.ok(!output.includes(secret));
    }
    assert.deepEqual(fake.received.map(r => r.path), ['/oauth/token', '/graphql', '/oauth/revoke']);
  } finally {
    await fake.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps failed-probe JSON writable for C1 and oversized remote diagnostic headers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'probe-diagnostics-'));
  let requestId = 'request\x85id';
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).origin, 'https://example.test');
    return Response.json({ error: 'denied' }, { status: 401, headers: { 'x-request-id': requestId } });
  });
  const env = { LINEAR_TEST_APP_CLIENT_ID: 'test-client', LINEAR_TEST_APP_CLIENT_SECRET: 'test-secret', LINEAR_BASE_URL: 'https://example.test' };
  try {
    const file = join(root, 'report.json');
    assert.equal(await main(['--json', file], env), 2);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.failed, true);
    assert.equal(report.requestLog[0].requestId, requestId);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\x85/);
    requestId = 'x'.repeat(1024 * 1024 + 1);
    assert.equal(await main(['--json', file], env), 2);
    const bounded = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(bounded.failed, true);
    assert.equal(bounded.requestLog.length, 0);
    assert.equal(bounded.requestLogOmitted, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
