// Two runs on one Linear OAuth app: Linear's client_credentials grant gives
// concurrent mints the same token, so a run that ends and revokes it ends it
// for the other run too. These tests model that and check that the other
// run's requests get a fresh token instead of failing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GraphQLTransport, LinearClient, LinearGraphQLError, mintAppToken, revokeToken, withDeferredRunToken, withRunToken } from '../../src/linear/index.ts';

const credentials = { clientId: 'shared-client', clientSecret: 'shared-secret' };
const BASE = 'https://linear.test';
const UPLOAD = 'https://uploads.linear.app/workspace/file';

/** Linear as the runs see it: one active token per app, ended by any revoke of it. */
class SharedApp {
  active: string | undefined;
  minted = 0;
  mintRequests = 0;
  /** Answers the next token requests with an outage. */
  mintOutage = 0;
  revoked: string[] = [];
  /** GraphQL operations by the token that sent them. */
  requests: Array<[operation: string, token: string]> = [];
  uploads: string[] = [];
  /** Tokens the upload host refuses although they are active. */
  refuseUpload = false;

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (url.startsWith('https://uploads.linear.app/')) {
      this.uploads.push(token);
      return new Response('file', { status: token === this.active && !this.refuseUpload ? 200 : 401 });
    }
    const path = url.slice(BASE.length);
    if (path === '/oauth/token') {
      this.mintRequests += 1;
      if (this.mintOutage > 0) {
        this.mintOutage -= 1;
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      }
      if (this.active === undefined) this.active = `token-${++this.minted}`;
      return Response.json({ access_token: this.active, expires_in: 3600, scope: 'read write' });
    }
    if (path === '/oauth/revoke') {
      const ended = new URLSearchParams(String(init?.body)).get('token') ?? '';
      this.revoked.push(ended);
      if (ended === this.active) this.active = undefined;
      return Response.json({ success: true });
    }
    const { operationName } = JSON.parse(String(init?.body)) as { operationName: string };
    this.requests.push([operationName, token]);
    if (token !== this.active) return Response.json({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, { status: 401 });
    if (operationName === 'PartlyRefused') return Response.json({ data: { viewer: { id: 'app' } }, errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
    if (operationName === 'Forbidden') return Response.json({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] }, { status: 401 });
    return Response.json({ data: { viewer: { id: 'app' } } });
  };

  /** The other run: it mints (getting the shared token) and ends, revoking it. */
  async otherRunEnds(): Promise<void> {
    const token = await mintAppToken(credentials, { baseUrl: BASE, fetch: this.fetch });
    await revokeToken(token.accessToken, { baseUrl: BASE, fetch: this.fetch });
  }
}

const viewer = 'query Viewer { viewer { id } }';

describe('a run on a Linear app another run also uses', () => {
  it('reads and writes on with a fresh token after the other run revokes the shared one', async () => {
    const app = new SharedApp();
    const saved: string[] = [];
    const lifecycle = { minted: (token: string) => saved.push(token), revoked: () => saved.push('') };
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, lifecycle, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await client.request('Before', 'query', viewer);
      await app.otherRunEnds();
      await client.request('Read', 'query', viewer);
      await app.otherRunEnds();
      await client.request('Write', 'mutation', 'mutation Write { viewer { id } }');
    });
    assert.deepEqual(app.requests, [
      ['Before', 'token-1'],
      ['Read', 'token-1'], ['Read', 'token-2'],
      ['Write', 'token-2'], ['Write', 'token-3'],
    ]);
    // The other run's two revokes, then this run's own revoke of its last token only.
    assert.deepEqual(app.revoked, ['token-1', 'token-2', 'token-3']);
    // The post step's state follows the token the run holds, and is cleared once it is revoked.
    assert.deepEqual(saved, ['token-1', 'token-2', 'token-3', '']);
  });

  it('keeps a refusal when Linear hands back the same token: the token was not revoked', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await assert.rejects(client.request('Forbidden', 'query', viewer), (error) => error instanceof LinearGraphQLError && error.code === 'FORBIDDEN');
    });
    assert.deepEqual(app.requests, [['Forbidden', 'token-1']]);
    assert.equal(app.minted, 1);
    assert.deepEqual(app.revoked, ['token-1']);
  });

  it('renews once per request: a fresh token that is refused again ends the request', async () => {
    const app = new SharedApp();
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await app.fetch(input, init);
      // Every fresh token is revoked by the time the request reaches Linear.
      if (String(input).endsWith('/oauth/token')) app.active = undefined;
      return response;
    };
    await withRunToken(credentials, { baseUrl: BASE, fetch: fetchImpl, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: fetchImpl });
      await assert.rejects(client.request('Read', 'query', viewer), (error) => error instanceof LinearGraphQLError && error.code === 'AUTHENTICATION_ERROR');
    });
    assert.deepEqual(app.requests.map(([operation]) => operation), ['Read', 'Read']);
    assert.equal(app.minted, 2);
  });

  it('mints one fresh token for requests Linear refused together', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await app.otherRunEnds();
      await Promise.all([1, 2, 3].map((n) => client.request(`Read${n}`, 'query', viewer)));
    });
    assert.equal(app.minted, 2);
    assert.deepEqual(app.requests.filter(([, token]) => token === 'token-2').map(([operation]) => operation).sort(), ['Read1', 'Read2', 'Read3']);
    assert.deepEqual(app.revoked, ['token-1', 'token-2']);
  });

  it('renews a token minted on first use (the apply step)', async () => {
    const app = new SharedApp();
    const known = { scope: ['read', 'write'], context: { grantType: 'client_credentials' as const, requestedScopes: ['read', 'write'], returnedScopes: ['read', 'write'] } };
    await withDeferredRunToken(credentials, known, { baseUrl: BASE, fetch: app.fetch, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const client = new LinearClient({ token: token.accessToken, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await client.request('Before', 'query', viewer);
      await app.otherRunEnds();
      await client.request('After', 'mutation', 'mutation After { viewer { id } }');
    });
    assert.deepEqual(app.requests, [['Before', 'token-1'], ['After', 'token-1'], ['After', 'token-2']]);
    assert.deepEqual(app.revoked, ['token-1', 'token-2']);
  });

  it('fetches an upload again with a fresh token, and keeps a refusal of an active token', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      const transport = new GraphQLTransport({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await app.otherRunEnds();
      assert.equal((await transport.fetchUpload(UPLOAD)).status, 200);
      app.refuseUpload = true;
      assert.equal((await transport.fetchUpload(UPLOAD)).status, 401);
      // A refusal of an active token, and then the other run revokes it: the readable file still comes.
      app.refuseUpload = false;
      await app.otherRunEnds();
      assert.equal((await transport.fetchUpload(UPLOAD)).status, 200);
    });
    assert.deepEqual(app.uploads, ['token-1', 'token-2', 'token-2', 'token-2', 'token-3']);
    assert.equal(app.minted, 3);
  });

  it('keeps an upload refused when the fresh token cannot be minted', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: () => {} }, async (token) => {
      const transport = new GraphQLTransport({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      app.refuseUpload = true;
      app.mintOutage = 1;
      assert.equal((await transport.fetchUpload(UPLOAD)).status, 401);
      // The run goes on with the token it held.
      await new LinearClient(transport).request('After', 'query', viewer);
    });
    assert.deepEqual(app.requests, [['After', 'token-1']]);
  });

  it('a failed renewal fails only its own request', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: () => {} }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await app.otherRunEnds();
      app.mintOutage = 1;
      await assert.rejects(client.request('First', 'query', viewer), /oauth\.token/);
      await client.request('Second', 'query', viewer);
    });
    assert.deepEqual(app.requests, [['First', 'token-1'], ['Second', 'token-1'], ['Second', 'token-2']]);
  });

  it('never sends again an answer that carries data, whatever its errors say', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: () => {} }, async (token) => {
      const client = new LinearClient({ token: token.current, renewToken: token.renew, baseUrl: BASE, fetch: app.fetch });
      await assert.rejects(client.request('PartlyRefused', 'mutation', 'mutation PartlyRefused { viewer { id } }'), LinearGraphQLError);
    });
    assert.deepEqual(app.requests, [['PartlyRefused', 'token-1']]);
    assert.equal(app.mintRequests, 1);
  });

  it('without a renewal, a revoked token fails the request as before', async () => {
    const app = new SharedApp();
    await withRunToken(credentials, { baseUrl: BASE, fetch: app.fetch, onRevokeError: () => {} }, async (token) => {
      const client = new LinearClient({ token: token.accessToken, baseUrl: BASE, fetch: app.fetch });
      await app.otherRunEnds();
      await assert.rejects(client.request('Read', 'query', viewer), (error) => error instanceof LinearGraphQLError && error.httpStatus === 401);
    });
    assert.equal(app.minted, 1);
  });
});
