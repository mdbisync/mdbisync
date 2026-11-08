import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { LinearClient, mintAppToken, revokeToken, withRunToken, type LogEntry } from '../../src/linear/index.ts';
import { FakeLinear } from './fake-linear.ts';

const credentials = { clientId: 'client-id-canary', clientSecret: 'client-secret-canary' };
const tokenValue = 'access-token-canary';
const content = 'workspace-content-canary';

function assertTimed(entry: LogEntry): void {
  assert.equal(new Date(entry.startedAt).toISOString(), entry.startedAt);
  assert.equal(new Date(entry.finishedAt).toISOString(), entry.finishedAt);
  assert.ok(Date.parse(entry.finishedAt) >= Date.parse(entry.startedAt));
  assert.equal(entry.durationMs, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt));
}

describe('safe per-request lifecycle diagnostics', () => {
  const fake = new FakeLinear();
  let logs: LogEntry[];
  before(async () => { await fake.start(); });
  after(async () => { await fake.stop(); });
  beforeEach(() => {
    logs = [];
    fake.received.length = 0;
    fake.fault = (request) => {
      const headers = { 'x-request-id': `request-${fake.received.length}`, 'x-ratelimit-requests-limit': '5000', 'x-ratelimit-requests-remaining': '4500', 'set-cookie': 'cookie-canary' };
      if (request.path === '/oauth/token') return { headers, body: { access_token: tokenValue, refresh_token: 'refresh-token-canary', scope: 'read write', expires_in: 3600, private: content } };
      if (request.path === '/oauth/revoke') return { headers, body: { success: true, private: content } };
      return { headers, status: 400, body: { errors: [{ message: content, extensions: { code: 'INPUT_ERROR', private: content } }], data: { private: content } } };
    };
  });

  it('correlates mint, GraphQL rejection and revoke without secrets or workspace data', async () => {
    const hooks = { log: (entry: LogEntry) => logs.push(entry) };
    await withRunToken(credentials, { baseUrl: fake.url, hooks, onRevokeError: () => assert.fail('cleanup failed') }, async (token) => {
      const enriched = { ...token.context, accessToken: token.accessToken, private: content };
      const client = new LinearClient({ token: token.accessToken, auth: enriched, baseUrl: fake.url, hooks });
      await assert.rejects(client.request('Teams', 'query', 'query Teams { teams { nodes { id } } }', { private: content }));
    });
    assert.deepEqual(logs.map(e => [e.operation, e.status, e.requestId]), [['oauth.token', 200, 'request-1'], ['Teams', 400, 'request-2'], ['oauth.revoke', 200, 'request-3']]);
    for (const entry of logs) {
      assertTimed(entry);
      assert.equal(entry.grantType, 'client_credentials');
      assert.deepEqual(entry.requestedScopes, ['read', 'write']);
      assert.deepEqual(entry.returnedScopes, ['read', 'write']);
      assert.equal(entry.rateLimitHeaders['x-ratelimit-requests-remaining'], '4500');
    }
    assert.deepEqual(logs[1]?.errorCodes, ['INPUT_ERROR']);
    const serialized = JSON.stringify(logs);
    for (const secret of [credentials.clientId, credentials.clientSecret, tokenValue, 'refresh-token-canary', 'cookie-canary', content]) assert.ok(!serialized.includes(secret), secret);
    assert.equal(fake.received.length, 3, 'diagnostics do not introduce retries');
  });

  it('retains OAuth failure codes and request ids without copying descriptions', async () => {
    fake.fault = () => ({ status: 401, headers: { 'x-request-id': 'request-refused' }, body: { error: 'invalid_client', error_description: `${credentials.clientSecret} ${content}` } });
    await assert.rejects(mintAppToken(credentials, { baseUrl: fake.url, hooks: { log: e => logs.push(e) } }));
    assert.equal(logs.length, 1);
    assertTimed(logs[0]!);
    assert.equal(logs[0]?.status, 401);
    assert.equal(logs[0]?.requestId, 'request-refused');
    assert.deepEqual(logs[0]?.errorCodes, ['invalid_client']);
    assert.ok(!JSON.stringify(logs).includes(content));
    assert.ok(!JSON.stringify(logs).includes(credentials.clientSecret));
  });

  it('records a failed owned revocation once', async () => {
    fake.fault = () => ({ reset: true });
    await assert.rejects(revokeToken(tokenValue, { baseUrl: fake.url, hooks: { log: e => logs.push(e) } }));
    assert.equal(logs.length, 1);
    assertTimed(logs[0]!);
    assert.equal(logs[0]?.status, 'network-error');
    assert.equal(logs[0]?.operation, 'oauth.revoke');
    assert.equal(fake.received.length, 1);
  });

  it('does not expose reflected credentials in an unknown OAuth error', async () => {
    fake.fault = () => ({ status: 401, body: { error: credentials.clientSecret } });
    const error = await mintAppToken(credentials, { baseUrl: fake.url, hooks: { log: e => logs.push(e) } }).catch((e: unknown) => e);
    assert.ok(error instanceof Error);
    assert.deepEqual(logs[0]?.errorCodes, ['unknown']);
    assert.ok(!JSON.stringify(logs).includes(credentials.clientSecret));
    assert.ok(!error.message.includes(credentials.clientSecret));
  });

  it('retains the response when a governor rejects it', async () => {
    const failure = new Error('governor stopped');
    const client = new LinearClient({ token: tokenValue, baseUrl: fake.url, hooks: {
      log: e => logs.push(e), afterResponse: () => { throw failure; },
    } });
    await assert.rejects(client.request('Teams', 'query', 'query Teams { teams { nodes { id } } }'), e => e === failure);
    assert.equal(logs.length, 1);
    assertTimed(logs[0]!);
    assert.equal(logs[0]?.status, 400);
    assert.equal(logs[0]?.requestId, 'request-1');
    assert.equal(logs[0]?.responseHookFailed, true);
  });

  it('records a GraphQL network failure without its exception details', async () => {
    const client = new LinearClient({ token: tokenValue, fetch: async () => { throw new Error(content); }, hooks: { log: e => logs.push(e) } });
    await assert.rejects(client.request('Teams', 'query', 'query Teams { teams { nodes { id } } }'));
    assert.equal(logs.length, 1);
    assertTimed(logs[0]!);
    assert.equal(logs[0]?.status, 'network-error');
    assert.ok(!JSON.stringify(logs).includes(content));
  });

  it('cleans up after a GraphQL network failure', async () => {
    const reply = fake.fault!;
    fake.fault = (request, index) => request.operation === 'Teams' ? { reset: true } : reply(request, index);
    const hooks = { log: (entry: LogEntry) => logs.push(entry) };
    await assert.rejects(withRunToken(credentials, { baseUrl: fake.url, hooks, onRevokeError: () => assert.fail('cleanup failed') }, async token => {
      await new LinearClient({ token: token.accessToken, auth: token.context, baseUrl: fake.url, hooks }).request('Teams', 'query', 'query Teams { teams { nodes { id } } }');
    }));
    assert.deepEqual(logs.map(e => [e.operation, e.status]), [['oauth.token', 200], ['Teams', 'network-error'], ['oauth.revoke', 200]]);
  });

  it('does not attach an earlier token scope to a failed mint', async () => {
    fake.fault = () => ({ reset: true });
    await assert.rejects(mintAppToken(credentials, { baseUrl: fake.url, hooks: { log: e => logs.push(e) }, auth: {
      grantType: 'client_credentials', requestedScopes: ['read'], returnedScopes: ['read'],
    } }));
    assert.deepEqual(logs[0]?.requestedScopes, ['read', 'write']);
    assert.equal(logs[0]?.returnedScopes, undefined);
  });

  it('distinguishes a refused revocation payload from HTTP success', async () => {
    fake.fault = () => ({ body: { success: false } });
    await assert.rejects(revokeToken(tokenValue, { baseUrl: fake.url, hooks: { log: e => logs.push(e) } }));
    assert.equal(logs[0]?.status, 200);
    assert.equal(logs[0]?.revocationConfirmed, false);
  });

  it('an asynchronous sink failure cannot interrupt token cleanup', async () => {
    await withRunToken(credentials, { baseUrl: fake.url, hooks: { log: async () => { throw new Error('sink unavailable'); } }, onRevokeError: () => assert.fail('cleanup failed') }, async () => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(fake.received.map(r => r.path), ['/oauth/token', '/oauth/revoke']);
  });

  it('a failing diagnostic sink cannot strand a newly minted token', async () => {
    await withRunToken(credentials, {
      baseUrl: fake.url,
      hooks: { log: () => { throw new Error('sink unavailable'); } },
      onRevokeError: () => assert.fail('cleanup failed'),
    }, async () => undefined);
    assert.deepEqual(fake.received.map(r => r.path), ['/oauth/token', '/oauth/revoke']);
  });
});
