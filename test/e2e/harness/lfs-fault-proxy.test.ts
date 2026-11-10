import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Git } from '../../../src/state/index.ts';
import { lfsEndpoint, lfsUrlEnv, startLfsFaultProxy } from './lfs-fault-proxy.ts';

const MISSING = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** A stand-in for the LFS server's batch API that records what reached it. */
function upstream(status = 200) {
  const calls: Array<{ url: string; authorization: string | null; body: { operation: string; objects: Array<{ oid: string }> } }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body });
    return new Response(JSON.stringify({ transfer: 'basic', objects: body.objects.map((object: { oid: string; size: number }) => ({ ...object, actions: {} })) }), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function batch(url: string, operation: string, oids: string[]): Promise<{ status: number; body: { objects?: Array<{ oid: string; error?: { code: number } }> } }> {
  const response = await fetch(`${url}/objects/batch`, { method: 'POST', body: JSON.stringify({ operation, objects: oids.map((oid) => ({ oid, size: 1 })) }) });
  return { status: response.status, body: (await response.json()) as { objects?: Array<{ oid: string; error?: { code: number } }> } };
}

describe('LFS fault proxy', () => {
  it('answers 404 for a refused download without asking the server, and passes the rest on with its credential', async () => {
    const server = upstream();
    const proxy = await startLfsFaultProxy('https://lfs.example/repo.git/info/lfs/', 'basic token', new Set([MISSING]), server.fetchImpl);
    try {
      const alone = await batch(proxy.url, 'download', [MISSING]);
      assert.equal(alone.status, 200);
      assert.deepEqual(alone.body.objects?.map((object) => [object.oid, object.error?.code]), [[MISSING, 404]]);
      assert.equal(server.calls.length, 0);

      const both = await batch(proxy.url, 'download', [OTHER, MISSING]);
      assert.deepEqual(both.body.objects?.map((object) => [object.oid, object.error?.code]), [[OTHER, undefined], [MISSING, 404]]);
      assert.deepEqual(server.calls.map((call) => [call.url, call.authorization, call.body.objects.map((object) => object.oid)]), [['https://lfs.example/repo.git/info/lfs/objects/batch', 'basic token', [OTHER]]]);

      // An upload of the same object is the server's to answer.
      await batch(proxy.url, 'upload', [MISSING]);
      assert.deepEqual(server.calls.at(-1)?.body, { operation: 'upload', objects: [{ oid: MISSING, size: 1 }] });
      assert.deepEqual(proxy.requests, [{ operation: 'download', refused: [MISSING] }, { operation: 'download', refused: [MISSING] }, { operation: 'upload', refused: [] }]);
    } finally {
      await proxy.close();
    }
  });

  it('passes on the server\'s refusal and answers 502 when the server cannot be reached', async () => {
    const refusing = upstream(403);
    const proxy = await startLfsFaultProxy('https://lfs.example/info/lfs', 'basic token', new Set([MISSING]), refusing.fetchImpl);
    try {
      assert.equal((await batch(proxy.url, 'download', [OTHER, MISSING])).status, 403);
    } finally {
      await proxy.close();
    }
    const unreachable = await startLfsFaultProxy('https://lfs.example/info/lfs', 'basic token', new Set(), (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    try {
      assert.equal((await batch(unreachable.url, 'download', [OTHER])).status, 502);
    } finally {
      await unreachable.close();
    }
  });

  it('serves nothing but the batch API', async () => {
    const server = upstream();
    const proxy = await startLfsFaultProxy('https://lfs.example/info/lfs', 'basic token', new Set(), server.fetchImpl);
    try {
      assert.equal((await fetch(`${proxy.url}/objects/${OTHER}`)).status, 404);
      assert.equal((await fetch(`${proxy.url}/locks`, { method: 'POST', body: '{}' })).status, 404);
      assert.equal((await fetch(`${proxy.url}/objects/batch`, { method: 'POST', body: '{}' })).status, 422);
      assert.equal(server.calls.length, 0);
    } finally {
      await proxy.close();
      await proxy.close();
    }
  });

  it('finds the endpoint a clone uses and adds lfs.url after given configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lfs-endpoint-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet']);
      await git.run(['remote', 'add', 'origin', 'https://github.com/example/sandbox']);
      assert.equal(await lfsEndpoint(git), 'https://github.com/example/sandbox.git/info/lfs');
      await git.run(['remote', 'set-url', 'origin', 'https://github.com/example/sandbox.git']);
      assert.equal(await lfsEndpoint(git), 'https://github.com/example/sandbox.git/info/lfs');
      await git.run(['config', 'lfs.url', 'https://lfs.example/info/lfs']);
      assert.equal(await lfsEndpoint(git), 'https://lfs.example/info/lfs');
      await git.run(['config', '--unset', 'lfs.url']);
      await git.run(['remote', 'set-url', 'origin', join(dir, 'remote.git')]);
      assert.equal(await lfsEndpoint(git), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(lfsUrlEnv('http://127.0.0.1:1/lfs', {}), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'lfs.url', GIT_CONFIG_VALUE_0: 'http://127.0.0.1:1/lfs' });
    assert.deepEqual(lfsUrlEnv('u', { GIT_CONFIG_COUNT: '2' }), { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'lfs.url', GIT_CONFIG_VALUE_2: 'u' });
  });
});
