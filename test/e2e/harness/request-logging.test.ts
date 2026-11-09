import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { LogEntry } from '../../../src/linear/index.ts';

for (const mode of ['success', 'query-failure', 'mint-failure'] as const) {
  it(`the harness emits safe correlated authentication diagnostics (${mode})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-request-log-'));
    try {
      const injection = join(root, 'fetch.mjs');
      writeFileSync(injection, `
        let requests = 0;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          const headers = { 'x-request-id': 'fake-request-' + ++requests, 'x-ratelimit-requests-remaining': '4500', 'set-cookie': 'secret-cookie-canary' };
          if (url.endsWith('/oauth/token')) {
            const rejected = ${JSON.stringify(mode)} === 'mint-failure' && requests === 2;
            return new Response(JSON.stringify(rejected ? { error: 'invalid_client' } : { access_token: 'secret-token-canary', token_type: 'Bearer', expires_in: 3600, scope: 'read write' }), { status: rejected ? 401 : 200, headers });
          }
          if (url.endsWith('/graphql')) return new Response(JSON.stringify({ errors: [{ message: 'Entity not found: User', extensions: { code: 'INPUT_ERROR' } }], privateData: 'workspace-content-canary' }), { status: 400, headers });
          if (url.endsWith('/oauth/revoke')) return new Response('{}', { status: ${mode === 'query-failure' ? 401 : 200}, headers });
          throw new Error('unexpected fake request');
        };
      `);
      // An explicit environment keeps this process away from real credentials and shared locks.
      const child = spawnSync(process.execPath, ['--import', injection, fileURLToPath(new URL('./cli.ts', import.meta.url)), 'run', '--ids', 'L1-04', ...(mode === 'query-failure' ? [] : ['--defer', 'L1-04']), '--out', join(root, 'out')], {
        encoding: 'utf8', timeout: 15_000,
        env: {
          PATH: process.env['PATH'],
          MDBISYNC_TEST_CONFIG_DIR: root,
          MDBISYNC_HARNESS_STATE_DIR: join(root, 'state'),
          LINEAR_TEST_APP_CLIENT_ID: 'secret-client-id-canary',
          LINEAR_TEST_APP_CLIENT_SECRET: 'secret-client-key-canary',
          ...(mode === 'mint-failure' ? { LINEAR_TEST_APP_2_CLIENT_ID: 'second-client-id-canary', LINEAR_TEST_APP_2_CLIENT_SECRET: 'second-client-key-canary' } : {}),
        },
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, mode === 'success' ? 0 : 1, child.stderr);
      const entries = child.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as LogEntry & { harnessRunId: string; app: string });
      assert.deepEqual(entries.map(e => [e.operation, e.status]), mode === 'success'
        ? [['oauth.token', 200], ['oauth.revoke', 200]]
        : mode === 'mint-failure' ? [['oauth.token', 200], ['oauth.token', 401], ['oauth.revoke', 200]]
        : [['oauth.token', 200], ['RateLimitStatus', 400], ['oauth.revoke', 401]]);
      assert.equal(new Set(entries.map(e => e.harnessRunId)).size, 1);
      for (const [index, entry] of entries.entries()) {
        assert.ok(entry.harnessRunId);
        assert.equal(entry.app, mode === 'mint-failure' && index === 1 ? 'app2' : 'app1');
        assert.equal(entry.requestId, `fake-request-${index + 1}`);
        assert.equal(entry.grantType, 'client_credentials');
        assert.deepEqual(entry.requestedScopes, ['read', 'write']);
        if (entry.status === 200 || mode === 'query-failure') assert.deepEqual(entry.returnedScopes, ['read', 'write']);
        assert.equal(new Date(entry.startedAt).toISOString(), entry.startedAt);
        assert.equal(new Date(entry.finishedAt).toISOString(), entry.finishedAt);
        assert.equal(entry.rateLimitHeaders['x-ratelimit-requests-remaining'], '4500');
      }
      if (mode === 'mint-failure') assert.deepEqual(entries[1]?.errorCodes, ['invalid_client']);
      if (mode === 'query-failure') {
        assert.deepEqual(entries[1]?.errorCodes, ['INPUT_ERROR']);
        assert.equal(entries.at(-1)?.revocationConfirmed, false);
        assert.match(child.stderr, /a harness token was not revoked/);
      }
      if (mode !== 'query-failure') {
        assert.equal(entries.at(-1)?.revocationConfirmed, true);
        assert.doesNotMatch(child.stderr, /a harness token was not revoked/);
      }
      for (const secret of ['secret-token-canary', 'secret-client-id-canary', 'secret-client-key-canary', 'second-client-id-canary', 'second-client-key-canary', 'secret-cookie-canary', 'workspace-content-canary']) assert.ok(!`${child.stdout}${child.stderr}`.includes(secret), secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
