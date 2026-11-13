import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenLease } from './token-lease.ts';
import { CredentialGit } from './sandbox.ts';
import { SandboxRest } from './github.ts';

test('a day-long lease renews before expiry and shares concurrent requests', async () => {
  let now = 0; let mints = 0;
  const get = tokenLease({ generation: 0 }, () => 3600_000, async () => ({ generation: ++mints }), () => now);
  for (let hour = 0; hour <= 25; hour += 1) {
    now = hour * 3600_000;
    const values = await Promise.all([get(), get(), get()]);
    assert.deepEqual(values.map((v) => v.generation), [hour, hour, hour]);
  }
  assert.equal(mints, 25);
});

test('a failed renewal propagates and can be retried without returning an expired token', async () => {
  let now = 0; let fail = true;
  const get = tokenLease('initial', () => 1000, async () => { if (fail) throw new Error('mint failed'); return 'renewed'; }, () => now);
  now = 751;
  await assert.rejects(get(), /mint failed/);
  fail = false;
  assert.equal(await get(), 'renewed');
  assert.throws(() => tokenLease('unknown', () => 0, async () => 'next'), /lifetime/);
});

test('cached Git instances renew auth while hook environments remain isolated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-git-'));
  let loads = 0;
  const git = new CredentialGit(dir, {}, async () => `generation-${++loads}`);
  try {
    for (const generation of [1, 2]) {
      const text = await git.text(['config', '--get', 'http.https://github.com/.extraheader']);
      assert.equal(text.trim(), `AUTHORIZATION: basic ${Buffer.from(`x-access-token:generation-${generation}`).toString('base64')}`);
    }
    const result = await git.run(['config', '--get', 'http.https://github.com/.extraheader'], { onlyEnv: {}, okCodes: [1] });
    assert.equal(result.stdout.length, 0);
    assert.equal(loads, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REST operations and scoped clients obtain the current token', async () => {
  let generation = 0;
  const auth: string[] = [];
  const rest = new SandboxRest({ owner: 'owner', repo: 'repo' }, async () => `generation-${++generation}`, async (_url, init) => {
    auth.push(String((init?.headers as Record<string, string>).authorization));
    return new Response('{}');
  });
  await rest.request('GET', '/actions/runs');
  await rest.withSignal(new AbortController().signal).request('GET', '/actions/runs');
  await rest.download('/actions/artifacts/1/zip');
  assert.deepEqual(auth, ['Bearer generation-1', 'Bearer generation-2', 'Bearer generation-3']);
});
