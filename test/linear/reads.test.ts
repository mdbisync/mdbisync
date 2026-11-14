// Linear's answers kept by one step of a job and taken by the next: each
// read is answered once, writes always reach Linear, the record ends with
// the capture, and the next step's token is minted only when a request
// still needs Linear.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { LinearClient, LinearHttpError, LinearReads, withDeferredRunToken, withRunToken } from '../../src/linear/index.ts';
import { FakeLinear } from './fake-linear.ts';

const credentials = { clientId: 'client-id', clientSecret: 'client-secret-value' };
const QUERY = 'query Teams { teams { nodes { id } } }';
const MUTATION = 'mutation Touch { touch { success } }';

describe('Linear reads kept for the next step', () => {
  const fake = new FakeLinear();
  let dir: string;
  let teams: number;

  before(async () => {
    await fake.start();
  });
  after(async () => {
    await fake.stop();
  });
  beforeEach(async () => {
    fake.received.length = 0;
    teams = 0;
    fake.operations.set('Teams', () => ({ body: { data: { teams: { nodes: [{ id: `team-${(teams += 1)}` }] } } } }));
    fake.operations.set('Touch', () => ({ body: { data: { touch: { success: true } } } }));
    fake.operations.set('Broken', () => ({ body: { errors: [{ message: 'no', extensions: { code: 'INPUT_ERROR' } }] } }));
    dir = await mkdtemp(join(tmpdir(), 'linear-reads-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const paths = () => fake.received.map((request) => request.operation ?? request.path);
  const index = () => join(dir, 'index.json');

  /** The stage step: a real token, every successful read kept. */
  async function record(work: (client: LinearClient) => Promise<void>): Promise<void> {
    const reads = LinearReads.recording();
    await withRunToken(credentials, { baseUrl: fake.url, onRevokeError: (error) => assert.fail(String(error)) }, async (token) => {
      reads.tokenMinted(token.scope, token.context);
      await work(new LinearClient({ token: token.accessToken, auth: token.context, baseUrl: fake.url, reads }));
    });
    try { await reads.save(dir); } finally { reads.close(); }
  }

  /** The apply step: the kept answers and a token minted on first need. */
  async function replay<T>(work: (client: LinearClient, reads: LinearReads) => Promise<T>): Promise<T> {
    const reads = await LinearReads.replaying(dir);
    assert.ok(reads !== null && reads.token !== null);
    try { return await withDeferredRunToken(credentials, reads.token, { baseUrl: fake.url, onRevokeError: (error) => assert.fail(String(error)) }, (token) =>
      work(new LinearClient({ token: () => token.accessToken(), auth: token.context, baseUrl: fake.url, reads }), reads));
    } finally { reads.close(); }
  }

  it('replays a recorded page larger than 32 MiB within the aggregate budget', async () => {
    const recording = LinearReads.recording();
    let replaying: LinearReads | null = null;
    try {
      recording.tokenMinted(['read'], {grantType:'client_credentials', requestedScopes:['read'], returnedScopes:['read']});
      recording.keep('large-page', {status:200, type:'application/json', body:Buffer.alloc(33 * 1024 * 1024, 32)});
      await recording.save(dir);
      replaying = await LinearReads.replaying(dir);
      assert.ok(replaying !== null);
      assert.equal(replaying.take('large-page')?.body.length, 33 * 1024 * 1024);
    } finally { recording.close(); replaying?.close(); }
  });

  it('answers the stage step\'s reads without a token or a request of its own', async () => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    assert.deepEqual(paths(), ['/oauth/token', 'Teams', '/oauth/revoke']);
    fake.received.length = 0;
    const data = await replay((client) => client.transport.request<{ teams: { nodes: Array<{ id: string }> } }>('Teams', 'query', QUERY));
    assert.deepEqual(data.teams.nodes, [{ id: 'team-1' }]);
    assert.deepEqual(paths(), []);
  });

  it('answers each read once; a repeated read, a write and a read after the end reach Linear with one minted token', async () => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    fake.received.length = 0;
    const seen = await replay(async (client, reads) => {
      const first = await client.transport.request<{ teams: { nodes: Array<{ id: string }> } }>('Teams', 'query', QUERY);
      const second = await client.transport.request<{ teams: { nodes: Array<{ id: string }> } }>('Teams', 'query', QUERY);
      await client.transport.request('Touch', 'mutation', MUTATION);
      reads.end();
      return [first.teams.nodes[0]?.id, second.teams.nodes[0]?.id];
    });
    assert.deepEqual(seen, ['team-1', 'team-2']);
    assert.deepEqual(paths(), ['/oauth/token', 'Teams', 'Touch', '/oauth/revoke']);
  });

  it('after the capture ends, the same read reaches Linear', async () => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    fake.received.length = 0;
    await replay(async (client, reads) => {
      reads.end();
      await client.transport.request('Teams', 'query', QUERY);
    });
    assert.deepEqual(paths(), ['/oauth/token', 'Teams', '/oauth/revoke']);
  });

  it('keeps neither writes nor error answers, and never a token', async () => {
    await record(async (client) => {
      await client.transport.request('Touch', 'mutation', MUTATION);
      await assert.rejects(client.transport.request('Broken', 'query', 'query Broken { broken }'));
    });
    const text = await readFile(index(), 'utf8');
    assert.ok(!text.includes('fake-token'), 'the record holds the token');
    assert.ok(!text.includes('client-secret-value'), 'the record holds the client secret');
    const kept = JSON.parse(text) as { answers: unknown[]; token: { scope: string[] } };
    assert.deepEqual(kept.answers, []);
    assert.deepEqual(kept.token.scope, ['read', 'write']);
  });

  it('a record that does not hold an answer the transport could have kept is an error, not data', async () => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    const kept = JSON.parse(await readFile(index(), 'utf8')) as { answers: Array<{ body: string }> };
    const errorBody = Buffer.from('{"data":null,"errors":[{"message":"x"}]}');
    const hash = createHash('sha256').update(errorBody).digest('hex');
    await writeFile(join(dir, 'bodies', hash), errorBody);
    kept.answers[0]!.body = hash;
    await writeFile(index(), JSON.stringify(kept));
    await assert.rejects(replay((client) => client.transport.request('Teams', 'query', QUERY)), LinearHttpError);
  });

  it('an answer with an empty error list is kept and answered as Linear gave it', async () => {
    fake.operations.set('Teams', () => ({ body: { data: { teams: { nodes: [{ id: 'team-kept' }] } }, errors: [] } }));
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    fake.received.length = 0;
    const data = await replay((client) => client.transport.request<{ teams: { nodes: Array<{ id: string }> } }>('Teams', 'query', QUERY));
    assert.deepEqual(data.teams.nodes, [{ id: 'team-kept' }]);
    assert.deepEqual(paths(), []);
  });

  it('the apply step without a usable record from the stage step reads Linear itself', async () => {
    assert.equal(await LinearReads.replaying(join(dir, 'missing')), null);
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    // A record cut short (the stage step killed while writing it) is no record.
    await writeFile(index(), '{"version":2,"token":');
    assert.equal(await LinearReads.replaying(dir), null);
    await writeFile(index(), '{"version":2,"token":{"scope":[],"context":{}}}');
    assert.equal(await LinearReads.replaying(dir), null);
  });

  it('a body file that does not match its hash makes the record unusable', async () => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    const kept = JSON.parse(await readFile(index(), 'utf8')) as { answers: Array<{ body: string }> };
    await writeFile(join(dir, 'bodies', kept.answers[0]!.body), 'changed');
    assert.equal(await LinearReads.replaying(dir), null);
  });

  it('rejects a body that grows after its opened file is measured', async (t) => {
    await record(async (client) => {
      await client.transport.request('Teams', 'query', QUERY);
    });
    const kept = JSON.parse(await readFile(index(), 'utf8')) as { answers: Array<{ body: string }> };
    const file = join(dir, 'bodies', kept.answers[0]!.body);
    const probe = await open(file, 'r');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalStat = prototype.stat;
    await probe.close();
    t.mock.method(prototype, 'stat', async function (this: FileHandle) {
      const info = await originalStat.call(this);
      await appendFile(file, 'extra');
      return info;
    });
    assert.equal(await LinearReads.replaying(dir), null);
  });
});
