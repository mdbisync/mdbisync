import assert from 'node:assert/strict';
import { it } from 'node:test';
import { cleanupAppTokens } from './cleanup.ts';

it('refuses cleanup without exclusive ownership before making a request', async () => {
  let calls = 0;
  await assert.rejects(cleanupAppTokens({ clientId: 'app', clientSecret: 'secret' }, {
    exclusive: false, onRevokeError: () => {}, fetch: async () => { calls++; throw new Error(); },
  }), /exclusive/);
  assert.equal(calls, 0);
});

it('invalidates unknown killed-run tokens, revokes both cleanup tokens and restores the normal scopes', async () => {
  const active = new Set(['unknown-killed-token']);
  let scopes = 'read,write';
  let sequence = 0;
  const requested: string[] = [];
  await cleanupAppTokens({ clientId: 'app', clientSecret: 'secret' }, {
    exclusive: true, onRevokeError: (error) => { throw error; },
    fetch: async (url, init) => {
      const body = init?.body as URLSearchParams;
      if (String(url).endsWith('/oauth/revoke')) {
        active.delete(body.get('token')!);
        return Response.json({ success: true });
      }
      const next = body.get('scope')!;
      requested.push(next);
      if (next !== scopes) active.clear();
      scopes = next;
      const token = `cleanup-${++sequence}`;
      active.add(token);
      return Response.json({ access_token: token, scope: next });
    },
  });
  assert.deepEqual(requested, ['read', 'read,write']);
  assert.equal(active.size, 0);
  assert.equal(scopes, 'read,write');
});

it('restores write scopes after a lost reset response without exposing its body', async () => {
  const scopes: string[] = [];
  await assert.rejects(cleanupAppTokens({ clientId: 'app', clientSecret: 'secret' }, {
    exclusive: true, onRevokeError: () => {}, fetch: async (url, init) => {
      if (String(url).endsWith('/oauth/revoke')) return Response.json({ success: true });
      const scope = (init?.body as URLSearchParams).get('scope')!;
      scopes.push(scope);
      if (scope === 'read') throw new Error('private-response');
      return Response.json({ access_token: 'replacement', scope });
    },
  }), (error: Error) => !error.message.includes('private-response'));
  assert.deepEqual(scopes, ['read', 'read,write']);
});
