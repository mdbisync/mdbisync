import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { FakeLinear } from './fake-linear.ts';

it('saves contract diagnostics when setup and token revocation both fail', { timeout: 15_000 }, async () => {
  const fake = await new FakeLinear().start();
  const directory = await mkdtemp(join(tmpdir(), 'contract-report-'));
  const reportPath = join(directory, 'report.json');
  fake.fault = (request) => {
    if (request.operation === 'Teams') return {
      status: 400,
      headers: { 'x-request-id': 'request-teams-failed' },
      body: { errors: [{ message: 'Entity not found: User', extensions: { code: 'INPUT_ERROR' } }] },
    };
    if (request.path === '/oauth/revoke') return { status: 401, body: {} };
    return undefined;
  };
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./contract.test.ts', import.meta.url))], {
      env: {
        ...env,
        LINEAR_TEST_APP_CLIENT_ID: 'test-client',
        LINEAR_TEST_APP_CLIENT_SECRET: 'test-secret',
        LINEAR_BASE_URL: fake.url,
        LINEAR_CONTRACT_REPORT: reportPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, output);
    assert.match(output, /Entity not found: User/);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.cleanupFailed, true);
    assert.deepEqual(report.cleanupErrors, [{ operation: 'oauth.revoke', error: 'oauth.revoke: Linear did not confirm the revocation (HTTP 401)' }]);
    assert.equal(report.stats.total, 3);
    assert.equal(report.perOperation['revoke token'], 1);
    assert.equal(report.requests[0].requestId, 'request-teams-failed');
    assert.deepEqual(report.requests[0].errorCodes, ['INPUT_ERROR']);
    assert.equal(report.requests[0].status, 400);
    assert.equal(report.requests[0].rateLimitHeaders['x-ratelimit-requests-limit'], '5000');
    assert.deepEqual(fake.received.map((r) => r.path), ['/oauth/token', '/graphql', '/oauth/revoke']);
  } finally {
    await fake.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
