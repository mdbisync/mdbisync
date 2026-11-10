import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupAndCount, createRunContext } from './runner.ts';
import { loadScenarios } from './spec.ts';
import { cleanupKilledTokens } from './token-cleanup.ts';
import { startFaultProxy } from './fault-proxy.ts';

it('revokes killed-run tokens and expired setup tokens through a proxy in the parent process', async () => {
  const revoked: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    revoked.push(new URLSearchParams(body).get('token')!);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"success":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const output = await cleanupKilledTokens(['orphan-one', 'orphan-two'], {
      cwd: process.cwd(), env: process.env, linearUrl: `http://127.0.0.1:${address.port}`,
    });
    assert.deepEqual(revoked, ['orphan-one', 'orphan-two']);
    assert.match(output, /post: revoked/);
    assert.ok(!output.includes('orphan-one') && !output.includes('orphan-two'));
    assert.ok(!output.includes('::add-mask::'));
    const root = mkdtempSync(join(tmpdir(), 'setup-token-'));
    try {
      const { ctx, abort } = createRunContext(loadScenarios()[0]!, 'abcdef', root, {
        stateDir: root, outDir: root, config: {} as never, log: () => {},
      });
      ctx.proxy = { unrevokedTokens: () => ['setup-orphan'], url: `http://127.0.0.1:${address.port}` } as never;
      abort.abort();
      assert.deepEqual(await cleanupAndCount(ctx), { ok: true });
      assert.deepEqual(revoked, ['orphan-one', 'orphan-two', 'setup-orphan']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

/**
 * A fake Linear. A token revoked once no longer works: its queries and a second revocation answer 401, as
 * Linear does. `failFirst` tokens get one 503 before their revocation works; `refuse` refuses every revocation.
 */
async function fakeLinear(answers: { failFirst?: ReadonlySet<string>; refuse?: 'rejected' | 'disconnected' } = {}) {
  const revocations: string[] = [];
  const revoked = new Set<string>();
  const failed = new Set<string>();
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    if (request.url !== '/oauth/revoke') {
      const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
      if (revoked.has(token)) response.writeHead(401, { 'content-type': 'application/json' }).end('{"errors":[{"extensions":{"code":"AUTHENTICATION_ERROR"}}]}');
      else response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"viewer":{"id":"u"}}}');
      return;
    }
    const token = new URLSearchParams(body).get('token')!;
    revocations.push(token);
    if (answers.refuse === 'disconnected') {
      request.socket.destroy();
    } else if (answers.refuse === 'rejected') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":false}');
    } else if (answers.failFirst?.has(token) && !failed.has(token)) {
      failed.add(token);
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"success":false}');
    } else if (revoked.has(token)) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
    } else {
      revoked.add(token);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, revocations, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const viewer = (url: string, token: string) =>
  fetch(`${url}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"query":"query Viewer { viewer { id } }"}' });
const revoke = (url: string, token: string) => fetch(`${url}/oauth/revoke`, { method: 'POST', body: new URLSearchParams({ token }) });

/** Cleanup of an aborted run, with the tokens its proxy reports as not revoked yet. */
async function abortedCleanup(proxy: { url: string; unrevokedTokens(): readonly string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'setup-token-'));
  try {
    const { ctx, abort } = createRunContext(loadScenarios()[0]!, 'abcdef', root, {
      stateDir: root, outDir: root, config: {} as never, log: () => {},
    });
    ctx.proxy = proxy as never;
    abort.abort();
    return await cleanupAndCount(ctx);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('keeps aborted setup cleanup failed when post warns and the token still works', async () => {
  for (const refuse of ['rejected', 'disconnected'] as const) {
    const linear = await fakeLinear({ refuse });
    try {
      const cleanup = await abortedCleanup({ url: linear.url, unrevokedTokens: () => ['unrevoked-token'] });
      assert.equal(cleanup.ok, false, refuse);
      assert.match(cleanup.detail!, /setup tokens: token revocation was not confirmed \(post: .+\)/);
      assert.ok(!cleanup.detail!.includes('unrevoked-token'));
      assert.deepEqual(linear.revocations, ['unrevoked-token', 'unrevoked-token'], 'one retry');
    } finally { await linear.close(); }
  }
});

it('releases an aborted run whose engine already revoked a token: cleanup revokes only the ones left', async () => {
  const linear = await fakeLinear();
  const proxy = await startFaultProxy(linear.url);
  try {
    // A finished engine run used its token and revoked it; a killed one only used its token.
    await viewer(proxy.url, 'finished-token');
    await viewer(proxy.url, 'killed-token');
    await revoke(proxy.url, 'finished-token');
    assert.deepEqual(proxy.tokens(), ['finished-token', 'killed-token']);
    assert.deepEqual(proxy.unrevokedTokens(), ['killed-token']);
    assert.deepEqual(await abortedCleanup(proxy), { ok: true });
    // No second revocation of the finished run's token, which Linear would refuse with 401.
    assert.deepEqual(linear.revocations, ['finished-token', 'killed-token']);
  } finally {
    await proxy.close();
    await linear.close();
  }
});

it('releases an aborted run whose token was revoked without the proxy seeing it confirmed', async () => {
  // The engine's revocation was still in flight, or its answer was lost: Linear revoked the token, the proxy
  // did not record it, and the cleanup's own revocation gets 401. The token no longer works, so it is revoked.
  const linear = await fakeLinear();
  try {
    await revoke(linear.url, 'revoked-token');
    assert.deepEqual(await abortedCleanup({ url: linear.url, unrevokedTokens: () => ['revoked-token'] }), { ok: true });
    assert.deepEqual(linear.revocations, ['revoked-token', 'revoked-token']);
  } finally { await linear.close(); }
});

it('keeps a token among the unrevoked ones when Linear refused its revocation', async () => {
  const linear = await fakeLinear({ failFirst: new Set(['refused-token']) });
  const proxy = await startFaultProxy(linear.url);
  try {
    await viewer(proxy.url, 'refused-token');
    assert.equal((await revoke(proxy.url, 'refused-token')).status, 503);
    assert.deepEqual(proxy.unrevokedTokens(), ['refused-token']);
  } finally {
    await proxy.close();
    await linear.close();
  }
});

it('confirms a revocation that failed once by trying it again, keeping both answers', async () => {
  const linear = await fakeLinear({ failFirst: new Set(['flaky-token']) });
  try {
    const output = await cleanupKilledTokens(['flaky-token'], { cwd: process.cwd(), env: process.env, linearUrl: linear.url, retryDelayMs: 0 });
    assert.match(output, /::warning::.*HTTP 503[\s\S]*post: revoked/);
    assert.ok(!output.includes('flaky-token'));
    assert.deepEqual(linear.revocations, ['flaky-token', 'flaky-token']);
  } finally { await linear.close(); }
});

it('retries a post that did not finish and fails with its reason', async () => {
  const linear = await fakeLinear();
  try {
    await assert.rejects(
      cleanupKilledTokens(['live-token'], { cwd: join(tmpdir(), 'no-such-folder-for-post'), env: process.env, linearUrl: linear.url, retryDelayMs: 0 }),
      (error: Error) => /token revocation was not confirmed \(.*ENOENT.*\)/.test(error.message) && !error.message.includes('live-token'),
    );
    assert.deepEqual(linear.revocations, []);
  } finally { await linear.close(); }
});
