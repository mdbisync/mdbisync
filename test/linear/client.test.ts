import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  DocumentTooLongError,
  LINEAR_FACTS,
  LinearClient,
  LinearGraphQLError,
  LinearHttpError,
  LinearNetworkError,
  LinearReadBackError,
  LinearStoppedError,
  LinearTokenError,
  RequestStats,
  mintAppToken,
  revokeToken,
  lengthRefusal,
  linearLength,
  withRunToken,
  writeEach,
  type LinearFacts,
  type LogEntry,
} from '../../src/linear/index.ts';
import { fakeFetch, fakeWorld, LINEAR_API, type FakeWorld } from '../../src/setup/test-helpers.ts';
import { FakeLinear, fakeDocument, rateLimited } from './fake-linear.ts';

const SECRET_TEXT = 'kx-canary-4f1a9c2e';

describe('Linear client against a fake Linear', () => {
  const fake = new FakeLinear();
  let sleeps: number[];
  let logs: LogEntry[];

  before(async () => {
    await fake.start();
  });
  after(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.received.length = 0;
    fake.fault = undefined;
    fake.operations.clear();
    sleeps = [];
    logs = [];
    let next = 0;
    fake.operations.set('CreateDocument', (request) => {
      next += 1;
      const input = request.variables?.input as Record<string, unknown>;
      return { body: { data: { documentCreate: { success: true, document: fakeDocument(`d${next}`, { title: input.title, content: input.content }) } } } };
    });
  });

  function client(extra: Partial<ConstructorParameters<typeof LinearClient>[0]> = {}, facts?: LinearFacts) {
    return new LinearClient({
      token: 'run-token',
      baseUrl: `${fake.url}/`,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      hooks: { log: (entry) => logs.push(entry) },
      ...extra,
    }, facts);
  }

  it('sends the operation name and bearer token, and counts requests per operation', async () => {
    const linear = client();
    const doc = await linear.createDocument({ projectId: 'project-1' }, { title: 'Plans', content: 'Body' });
    assert.equal(doc.id, 'd1');
    assert.equal(doc.projectId, 'project-1');
    assert.equal(doc.teamId, null);
    assert.equal(doc.trashed, false);
    const [request] = fake.received;
    assert.equal(request?.operation, 'CreateDocument');
    assert.equal(request?.headers.authorization, 'Bearer run-token');
    assert.deepEqual(request?.variables?.input, { title: 'Plans', content: 'Body', projectId: 'project-1' });
    assert.deepEqual(linear.stats.toJSON(), { total: 1, storagePuts: 0, byOperation: { CreateDocument: 1 } });
  });

  it('stops writing at a 429 on the 30th request and returns what it finished', async () => {
    fake.fault = (request, index) => (index === 30 ? rateLimited() : undefined);
    const linear = client();
    const titles = Array.from({ length: 40 }, (_, i) => `Note ${i + 1}`);

    const outcome = await writeEach(linear, titles, (title) => linear.createDocument({ projectId: 'project-1' }, { title }));

    assert.equal(outcome.done.length, 29);
    assert.deepEqual(outcome.done.map((d) => d.item), titles.slice(0, 29));
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.interrupted?.item, titles[29], 'the item hit by the 429 may be partly applied');
    assert.deepEqual(outcome.notAttempted, titles.slice(30));
    assert.deepEqual(outcome.stopped, { kind: 'rate-limited', operation: 'CreateDocument', retryAfterSeconds: undefined });
    assert.equal(fake.graphqlCount(), 30, 'nothing is sent after the 429');

    await assert.rejects(linear.rateLimitStatus(), LinearStoppedError);
    assert.equal(fake.graphqlCount(), 30, 'a stopped client sends nothing');
  });

  it('retries once after a short Retry-After, then succeeds', async () => {
    fake.fault = (request, index) => (index === 1 ? rateLimited('2') : undefined);
    const linear = client();
    const doc = await linear.createDocument({ teamId: 'team-1' }, { title: 'Plans' });
    assert.equal(doc.id, 'd1');
    assert.deepEqual(sleeps, [2000]);
    assert.equal(linear.stopped, undefined);
    assert.equal(linear.stats.total, 2);
    assert.equal(logs[0]?.retryAfterSeconds, 2);
  });

  it('does not retry a short Retry-After when the budget is below the floor', async () => {
    fake.fault = () => ({ ...rateLimited('1'), headers: { 'retry-after': '1', 'x-ratelimit-requests-remaining': '0' } });
    const linear = client();
    await assert.rejects(linear.createDocument({ teamId: 'team-1' }, { title: 'Plans' }), LinearStoppedError);
    assert.equal(fake.graphqlCount(), 1);
    assert.deepEqual(sleeps, []);
    assert.equal(linear.stopped?.kind, 'rate-limited');
  });

  it('stops without retrying when Retry-After is long', async () => {
    fake.fault = () => rateLimited('120');
    const linear = client();
    const error = await linear.createDocument({ teamId: 'team-1' }, { title: 'Plans' }).catch((e: unknown) => e);
    assert.ok(error instanceof LinearStoppedError);
    assert.deepEqual(error.reason, { kind: 'rate-limited', operation: 'CreateDocument', retryAfterSeconds: 120 });
    assert.deepEqual(sleeps, []);
    assert.equal(fake.graphqlCount(), 1);
  });

  it('retries only once: a second 429 stops the client', async () => {
    fake.fault = () => rateLimited('1');
    const linear = client();
    await assert.rejects(linear.createDocument({ teamId: 'team-1' }, { title: 'Plans' }), LinearStoppedError);
    assert.equal(fake.graphqlCount(), 2);
    assert.deepEqual(sleeps, [1000]);
  });

  it('treats a RATELIMITED GraphQL error without HTTP 429 as a rate limit', async () => {
    fake.fault = () => ({ status: 400, body: { errors: [{ message: 'Too many requests', extensions: { code: 'RATELIMITED' } }] } });
    const linear = client();
    await assert.rejects(linear.rateLimitStatus(), LinearStoppedError);
    assert.equal(linear.stopped?.kind, 'rate-limited');
  });

  it('stops early when remaining-budget headers run low, and logs the endpoint limit headers', async () => {
    fake.fault = (request, index) =>
      index === 3
        ? {
            headers: { 'x-ratelimit-endpoint-name': 'documentCreate', 'x-ratelimit-endpoint-requests-remaining': '2', 'x-ratelimit-endpoint-requests-limit': '100' },
            body: { data: { documentCreate: { success: true, document: fakeDocument('low') } } },
          }
        : undefined;
    const linear = client();
    const outcome = await writeEach(linear, ['a', 'b', 'c', 'd', 'e'], (title) => linear.createDocument({ projectId: 'p' }, { title }));
    assert.deepEqual(outcome.done.map((d) => d.item), ['a', 'b', 'c'], 'the response that reported low budget is kept');
    assert.deepEqual(outcome.notAttempted, ['d', 'e']);
    assert.equal(outcome.interrupted, undefined, 'the stop came between items');
    assert.deepEqual(outcome.stopped, {
      kind: 'budget-low',
      operation: 'CreateDocument',
      header: 'x-ratelimit-endpoint-requests-remaining',
      remaining: 2,
      threshold: 5,
    });
    assert.equal(fake.graphqlCount(), 3);
    assert.equal(logs[2]?.rateLimitHeaders['x-ratelimit-endpoint-name'], 'documentCreate');
    assert.equal(logs[2]?.stop?.kind, 'budget-low');
  });

  it('honours a custom budget floor on the hourly requests header', async () => {
    fake.budgetHeaders = { ...fake.budgetHeaders, 'x-ratelimit-requests-remaining': '400' };
    try {
      const linear = client({ budgetFloor: { minRequestsRemaining: 500 } });
      await linear.rateLimitStatus().catch(() => undefined);
      assert.equal(linear.stopped?.kind, 'budget-low');
      assert.equal(client().stopped, undefined);
    } finally {
      fake.budgetHeaders = { ...fake.budgetHeaders, 'x-ratelimit-requests-remaining': '4900' };
    }
  });

  it('records a rejected, a failed and a reset write as failed and goes on', async () => {
    fake.fault = (request, index) => {
      if (index === 1) return { body: { errors: [{ message: 'Entity not found: Document', extensions: { code: 'INPUT_ERROR', type: 'invalid input' } }] } };
      if (index === 2) return { status: 502, body: undefined };
      if (index === 3) return { reset: true };
      return { body: { data: { documentUpdate: { success: true, document: fakeDocument(`u${index}`) } } } };
    };
    const linear = client();
    const outcome = await writeEach(linear, ['gone', 'bad-gateway', 'reset', 'fine'], (id) => linear.updateDocument(id, { title: 'New title' }));
    assert.deepEqual(outcome.done.map((d) => d.item), ['fine']);
    assert.deepEqual(outcome.failed.map((f) => f.item), ['gone', 'bad-gateway', 'reset']);
    const [notFound, badGateway, reset] = outcome.failed.map((f) => f.error);
    assert.ok(notFound instanceof LinearGraphQLError && notFound.notFound && notFound.code === 'INPUT_ERROR');
    assert.ok(badGateway instanceof LinearHttpError && badGateway.httpStatus === 502);
    assert.ok(reset instanceof LinearNetworkError);
    assert.equal(outcome.stopped, undefined);
  });

  it('carries Linear request ids and error codes into errors and logs', async () => {
    fake.fault = (request, index) =>
      index === 1
        ? { headers: { 'x-request-id': 'req-1' }, body: { errors: [{ message: 'Entity not found: Project', extensions: { code: 'INPUT_ERROR' } }] } }
        : { status: 503, headers: { 'x-request-id': 'req-2' }, body: undefined };
    const linear = client();
    const graphql = await linear.createDocument({ projectId: 'p' }, { title: 'One' }).catch((e: unknown) => e);
    assert.ok(graphql instanceof LinearGraphQLError);
    assert.equal(graphql.requestId, 'req-1');
    assert.match(graphql.message, /INPUT_ERROR \(HTTP 200, request req-1\): Entity not found: Project/);
    const http = await linear.rateLimitStatus().catch((e: unknown) => e);
    assert.ok(http instanceof LinearHttpError);
    assert.equal(http.requestId, 'req-2');
    assert.deepEqual(
      logs.map(({ operation, status, requestId, errorCodes }) => ({ operation, status, requestId, errorCodes })),
      [
        { operation: 'CreateDocument', status: 200, requestId: 'req-1', errorCodes: ['INPUT_ERROR'] },
        { operation: 'RateLimitStatus', status: 503, requestId: 'req-2', errorCodes: undefined },
      ],
    );
  });

  it('marks a write interrupted when the client stops during it, and returns the rest untried', async () => {
    fake.operations.set('CommentOnDocument', () => ({ body: { data: { commentCreate: { success: true, comment: { id: 'c' } } } } }));
    fake.fault = (request, index) => (index === 4 ? rateLimited() : undefined);
    const linear = client();
    const outcome = await writeEach(linear, ['a', 'b', 'c'], async (title) => {
      const doc = await linear.createDocument({ projectId: 'p' }, { title });
      return linear.commentOnDocument(doc.documentContentId ?? '', 'Noted.');
    });
    assert.deepEqual(outcome.done.map((d) => d.item), ['a']);
    assert.equal(outcome.interrupted?.item, 'b', 'its document exists but its comment does not');
    assert.deepEqual(outcome.notAttempted, ['c']);
  });

  it('returns what finished when a write throws an error that is not Linear\'s', async () => {
    const linear = client();
    const bug = new TypeError('bug');
    const outcome = await writeEach(linear, ['a', 'b', 'c'], async (title) => {
      if (title === 'b') throw bug;
      return linear.createDocument({ projectId: 'p' }, { title });
    });
    assert.deepEqual(outcome.done.map((d) => d.item), ['a']);
    assert.deepEqual(outcome.aborted, { item: 'b', error: bug });
    assert.deepEqual(outcome.notAttempted, ['c']);
  });

  it('does not send a request that waited in the governor while another stopped the client', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.fault = (request) => (request.operation === 'RateLimitStatus' ? rateLimited() : undefined);
    const linear = client({
      hooks: {
        beforeRequest: async (info) => {
          if (info.operation === 'CreateDocument') await gate;
        },
      },
    });
    const waiting = linear.createDocument({ projectId: 'p' }, { title: 'Late' }).catch((e: unknown) => e);
    await assert.rejects(linear.rateLimitStatus(), LinearStoppedError);
    release();
    assert.ok((await waiting) instanceof LinearStoppedError);
    assert.deepEqual(fake.received.map((r) => r.operation), ['RateLimitStatus']);
  });

  it('treats a mutation payload with success: false as a failure', async () => {
    fake.operations.set('TrashDocument', () => ({ body: { data: { documentDelete: { success: false } } } }));
    const linear = client();
    await assert.rejects(linear.trashDocument('d'), /TrashDocument: Linear reported success: false/);
  });

  it('treats an unreadable body on a success status as an unknown outcome', async () => {
    fake.fault = () => ({ status: 200, headers: { 'content-type': 'application/json' } });
    const linear = client();
    await assert.rejects(linear.createDocument({ projectId: 'p' }, { title: 'One' }), LinearNetworkError);
  });

  it('refuses a page that says more follow but gives no cursor', async () => {
    fake.operations.set('ListDocuments', () => ({
      body: { data: { documents: { nodes: [fakeDocument('a')], pageInfo: { hasNextPage: true, endCursor: null } } } },
    }));
    const linear = client();
    await assert.rejects(linear.listDocuments({ projectId: 'p' }), /another page without a cursor/);
  });

  it('never logs content, variables or the token', async () => {
    const linear = client();
    await linear.createDocument({ projectId: 'p' }, { title: SECRET_TEXT, content: SECRET_TEXT });
    fake.fault = () => ({ body: { errors: [{ message: 'Entity not found: Document', extensions: { code: 'INPUT_ERROR' } }] } });
    await linear.updateDocument('x', { content: SECRET_TEXT }).catch(() => undefined);
    const logged = JSON.stringify(logs);
    assert.ok(logs.length >= 2);
    assert.ok(!logged.includes(SECRET_TEXT));
    assert.ok(!logged.includes('run-token'));
  });

  it('lets a governor wait before each request and observe each response', async () => {
    const seen: string[] = [];
    const linear = client({
      hooks: {
        beforeRequest: async (info) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.push(`before ${info.operation} ${info.attempt}`);
        },
        afterResponse: (info) => {
          seen.push(`after ${info.operation} ${info.status} ${info.rateLimit.requestsRemaining}`);
        },
      },
    });
    await linear.createDocument({ projectId: 'p' }, { title: 'One' });
    assert.deepEqual(seen, ['before CreateDocument 1', 'after CreateDocument 200 4900']);
    assert.equal(linear.transport.lastRateLimit?.complexity, 12);
  });

  it('reads documents by id in one request per page of ids', async () => {
    fake.operations.set('GetDocuments', (request) => {
      const ids = request.variables?.ids as string[];
      return { body: { data: { documents: { nodes: ids.slice(0, -1).map((id) => fakeDocument(id, { content: 'Body', trashed: true })) } } } };
    });
    const linear = client();
    const ids = Array.from({ length: 600 }, (_, i) => `id${i}`);
    const docs = await linear.getDocuments(ids, { withContent: true });
    assert.equal(fake.graphqlCount(), 3);
    assert.deepEqual(fake.received.map((r) => (r.variables?.ids as string[]).length), [250, 250, 100]);
    assert.equal(fake.received[0]?.variables?.withContent, true);
    assert.equal(docs.length, 597, 'ids Linear no longer has are absent');
    assert.equal(docs[0]?.trashed, true);
    assert.equal(docs[0]?.content, 'Body');

    assert.deepEqual(await linear.getDocuments([]), []);
    assert.equal(fake.graphqlCount(), 3);
  });

  it('lists a project or a team page by page', async () => {
    fake.operations.set('ListDocuments', (request) => {
      const after = request.variables?.after as string | null;
      const page = after === null ? 1 : 2;
      return {
        body: {
          data: {
            documents: {
              nodes: [fakeDocument(`p${page}a`, { project: null }), fakeDocument(`p${page}b`, { project: null })],
              pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? 'cursor-1' : null },
            },
          },
        },
      };
    });
    const linear = client();
    const docs = await linear.listDocuments({ teamId: 'team-9' }, { withContent: true, includeArchived: true, pageSize: 2 });
    assert.deepEqual(docs.map((d) => d.id), ['p1a', 'p1b', 'p2a', 'p2b']);
    assert.deepEqual(fake.received.map((r) => r.variables?.after), [null, 'cursor-1']);
    assert.deepEqual(fake.received[0]?.variables?.filter, { team: { id: { eq: 'team-9' } } });
    assert.equal(fake.received[0]?.variables?.includeArchived, true);
    assert.equal(fake.received[0]?.variables?.first, 2);
  });

  it('lists full pages of 250 by default', async () => {
    fake.operations.set('ListDocuments', () => ({
      body: { data: { documents: { nodes: [fakeDocument('a')], pageInfo: { hasNextPage: false, endCursor: null } } } },
    }));
    await client().listDocuments({ projectId: 'project-1' });
    assert.equal(fake.received[0]?.variables?.first, 250);
  });

  it('keeps project documents out of a team zone listing', async () => {
    fake.operations.set('ListDocuments', () => ({
      body: {
        data: {
          documents: {
            nodes: [fakeDocument('zone', { project: null, team: { id: 'team-9' } }), fakeDocument('in-project')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }));
    const zone = await client().listDocuments({ teamId: 'team-9' }, { includeArchived: true });
    assert.deepEqual(zone.map((d) => d.id), ['zone']);
    assert.equal(fake.graphqlCount(), 1);
  });

  it('a write and its stored record cost one request when Linear returns stored content', async () => {
    fake.operations.set('UpdateDocument', (request) => ({
      body: { data: { documentUpdate: { success: true, document: fakeDocument('d1', { content: (request.variables?.input as { content?: string }).content }) } } },
    }));
    const linear = client();
    const created = await linear.createDocument({ projectId: 'p' }, { title: 'Plan', content: 'Stored text' });
    assert.equal(created.content, 'Stored text');
    const updated = await linear.updateDocument(created.id, { content: 'New text' });
    assert.equal(updated.content, 'New text');
    assert.deepEqual(fake.received.map((r) => r.operation), ['CreateDocument', 'UpdateDocument']);
  });

  it('a write and its stored record cost two requests when Linear\'s payload may differ from what it stores', async () => {
    fake.operations.set('UpdateDocument', () => ({ body: { data: { documentUpdate: { success: true, document: fakeDocument('d1', { content: 'payload' }) } } } }));
    fake.operations.set('GetDocuments', (request) => ({
      body: { data: { documents: { nodes: (request.variables?.ids as string[]).map((id) => fakeDocument(id, { content: 'stored' })) } } },
    }));
    const linear = client({}, { ...LINEAR_FACTS, mutationsReturnStoredContent: false });
    const created = await linear.createDocument({ projectId: 'p' }, { title: 'Plan', content: 'Text' });
    assert.equal(created.content, 'stored');
    const updated = await linear.updateDocument(created.id, { content: 'Text 2' });
    assert.equal(updated.content, 'stored');
    await linear.updateDocument(created.id, { title: 'Renamed' });
    assert.deepEqual(fake.received.map((r) => r.operation), ['CreateDocument', 'GetDocuments', 'UpdateDocument', 'GetDocuments', 'UpdateDocument']);
    assert.equal(fake.received[1]?.variables?.withContent, true);
  });

  it('reports a write whose read-back failed as written, with its id', async () => {
    let reads = 0;
    fake.operations.set('GetDocuments', () => {
      reads += 1;
      return reads === 1 ? { status: 500, body: undefined } : { body: { data: { documents: { nodes: [] } } } };
    });
    const linear = client({}, { ...LINEAR_FACTS, mutationsReturnStoredContent: false });
    const outcome = await writeEach(linear, ['First', 'Second'], (title) => linear.createDocument({ projectId: 'p' }, { title, content: 'Text' }));
    assert.deepEqual(outcome.done, []);
    const [failedRead, missing] = outcome.failed.map((f) => f.error);
    assert.ok(failedRead instanceof LinearReadBackError && failedRead.document.id === 'd1' && failedRead.cause instanceof LinearHttpError);
    assert.ok(missing instanceof LinearReadBackError && missing.document.id === 'd2');
    assert.deepEqual(fake.received.map((r) => r.operation), ['CreateDocument', 'GetDocuments', 'CreateDocument', 'GetDocuments']);
  });

  it('leaves out a too-long title or content with a reason and sends nothing for it', async () => {
    fake.operations.set('UpdateDocument', () => ({ body: { data: { documentUpdate: { success: true, document: fakeDocument('d') } } } }));
    const linear = client();
    const writes: Array<{ name: string; write: () => Promise<unknown> }> = [
      { name: 'title 513', write: () => linear.createDocument({ projectId: 'p' }, { title: 'T'.repeat(513), content: 'x' }) },
      { name: 'content 250001', write: () => linear.updateDocument('d', { content: 'a'.repeat(250_001) }) },
      { name: 'emoji 250001', write: () => linear.updateDocument('d', { content: '\u{1F600}'.repeat(250_001) }) },
      { name: 'title 512 emoji', write: () => linear.createDocument({ projectId: 'p' }, { title: '\u{1F600}'.repeat(512) }) },
      { name: 'emoji 125001', write: () => linear.updateDocument('d', { content: '\u{1F600}'.repeat(125_001) }) },
      { name: 'content 250000', write: () => linear.updateDocument('d', { content: 'a'.repeat(250_000) }) },
    ];
    const outcome = await writeEach(linear, writes, (w) => w.write());
    assert.deepEqual(outcome.failed.map((f) => f.item.name), ['title 513', 'content 250001', 'emoji 250001']);
    assert.deepEqual(outcome.done.map((d) => d.item.name), ['title 512 emoji', 'emoji 125001', 'content 250000']);
    const [title, content] = outcome.failed.map((f) => f.error);
    assert.ok(title instanceof DocumentTooLongError && title.field === 'title' && title.length === 513 && title.limit === 512);
    assert.equal(title.message, 'CreateDocument: title is 513 characters, Linear accepts at most 512');
    assert.ok(content instanceof DocumentTooLongError && content.field === 'content' && content.limit === 250_000);
    assert.deepEqual(fake.received.map((r) => r.operation), ['CreateDocument', 'UpdateDocument', 'UpdateDocument']);
  });

  it('updates, trashes, restores and comments with one request each', async () => {
    fake.operations.set('UpdateDocument', () => ({ body: { data: { documentUpdate: { success: true, document: fakeDocument('d', { project: null, team: { id: 't' } }) } } } }));
    fake.operations.set('TrashDocument', () => ({ body: { data: { documentDelete: { success: true } } } }));
    fake.operations.set('RestoreDocument', () => ({ body: { data: { documentUnarchive: { success: true } } } }));
    fake.operations.set('CommentOnDocument', () => ({ body: { data: { commentCreate: { success: true, comment: { id: 'c1' } } } } }));
    const linear = client();
    const moved = await linear.updateDocument('d', { title: 'Renamed', projectId: null, teamId: 't', icon: 'Book', color: '#5e6ad2' });
    assert.equal(moved.teamId, 't');
    assert.equal(moved.projectId, null);
    assert.deepEqual(fake.received[0]?.variables, {
      id: 'd',
      input: { title: 'Renamed', projectId: null, teamId: 't', icon: 'Book', color: '#5e6ad2' },
      withContent: false,
    });
    await linear.trashDocument('d');
    await linear.restoreDocument('d');
    assert.deepEqual(await linear.commentOnDocument('content-d', 'Looks good'), { id: 'c1' });
    assert.deepEqual(fake.received.map((r) => r.operation), ['UpdateDocument', 'TrashDocument', 'RestoreDocument', 'CommentOnDocument']);
    assert.deepEqual(fake.received[3]?.variables?.input, { documentContentId: 'content-d', body: 'Looks good' });
  });

  it('uploads a file: fileUpload, then one PUT with the signed headers', async () => {
    fake.operations.set('FileUpload', () => ({
      body: {
        data: {
          fileUpload: {
            success: true,
            uploadFile: { uploadUrl: `${fake.url}/upload`, assetUrl: 'https://uploads.example/asset/1', headers: [{ key: 'x-goog-meta-x', value: 'y' }] },
          },
        },
      },
    }));
    const linear = client();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const result = await linear.uploadFile({ filename: 'chart.png', contentType: 'image/png', bytes });
    assert.deepEqual(result, { assetUrl: 'https://uploads.example/asset/1' });
    const [mutation, put] = fake.received;
    assert.deepEqual(mutation?.variables, { contentType: 'image/png', filename: 'chart.png', size: 7 });
    assert.equal(put?.method, 'PUT');
    assert.equal(put?.headers['content-type'], 'image/png');
    assert.equal(put?.headers['x-goog-meta-x'], 'y');
    assert.equal(put?.headers.authorization, undefined, 'the run token never goes to storage');
    assert.equal(put?.bodyBytes, 7);
    assert.deepEqual(linear.stats.toJSON(), { total: 1, storagePuts: 1, byOperation: { FileUpload: 1 } });
  });
});

describe('run tokens against a fake Linear', () => {
  const fake = new FakeLinear();
  before(async () => {
    await fake.start();
  });
  after(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.received.length = 0;
    fake.fault = undefined;
  });

  const credentials = { clientId: 'client-id', clientSecret: 'client-secret-value' };

  it('mints a client credentials token with read and write scopes, and revokes it', async () => {
    const stats = new RequestStats();
    const token = await mintAppToken(credentials, { baseUrl: fake.url, stats });
    assert.equal(token.accessToken, 'fake-token');
    assert.deepEqual(token.scope, ['read', 'write']);
    assert.deepEqual(fake.received[0]?.form, {
      grant_type: 'client_credentials',
      client_id: 'client-id',
      client_secret: 'client-secret-value',
      scope: 'read,write',
    });
    await revokeToken(token.accessToken, { baseUrl: fake.url, stats });
    assert.deepEqual(fake.received[1]?.form, { token: 'fake-token' });
    assert.deepEqual(stats.toJSON().byOperation, { 'oauth.revoke': 1, 'oauth.token': 1 });
  });

  it('revokes the token when the run fails, and rethrows the run error', async () => {
    const failure = new Error('run failed');
    await assert.rejects(withRunToken(credentials, { baseUrl: fake.url, onRevokeError: () => assert.fail('revoked') }, async () => { throw failure; }), (e) => e === failure);
    assert.deepEqual(fake.received.map((r) => r.path), ['/oauth/token', '/oauth/revoke']);
  });

  it('revokes the token when the run succeeds', async () => {
    const result = await withRunToken(credentials, { baseUrl: fake.url, onRevokeError: () => assert.fail('revoked') }, async (token) => token.accessToken.length);
    assert.equal(result, 10);
    assert.deepEqual(fake.received.map((r) => r.path), ['/oauth/token', '/oauth/revoke']);
  });

  it('reports a failed revocation instead of hiding it', async () => {
    fake.fault = (request) => (request.path === '/oauth/revoke' ? { status: 500, body: { success: false } } : undefined);
    const revokeErrors: unknown[] = [];
    const result = await withRunToken(credentials, { baseUrl: fake.url, onRevokeError: (e) => revokeErrors.push(e) }, async () => 'written');
    assert.equal(result, 'written', 'the run keeps its result');
    assert.equal(revokeErrors.length, 1);

    await assert.rejects(
      withRunToken(credentials, { baseUrl: fake.url, onRevokeError: (e) => revokeErrors.push(e) }, async () => {
        throw new Error('run failed');
      }),
      /run failed/,
    );
    assert.equal(revokeErrors.length, 2);
    assert.ok(revokeErrors.every((e) => e instanceof LinearTokenError));
  });

  it('accepts an empty success answer to a revocation, and refuses an explicit success: false', async () => {
    fake.fault = (request) => (request.path === '/oauth/revoke' ? { status: 200 } : undefined);
    await revokeToken('t', { baseUrl: fake.url });
    fake.fault = (request) => (request.path === '/oauth/revoke' ? { body: { success: false } } : undefined);
    await assert.rejects(revokeToken('t', { baseUrl: fake.url }), LinearTokenError);
  });

  it('refuses without echoing the client secret', async () => {
    fake.fault = () => ({ status: 401, body: { error: 'invalid_client' } });
    const error = await mintAppToken(credentials, { baseUrl: fake.url }).catch((e: unknown) => e);
    assert.ok(error instanceof LinearTokenError);
    assert.match(error.message, /invalid_client/);
    assert.ok(!error.message.includes('client-secret-value'));
  });
});

describe('Linear facts', () => {
  it('holds the measured values', () => {
    assert.deepEqual({ ...LINEAR_FACTS }, {
      mutationsReturnStoredContent: true,
      maxTitleLength: 512,
      maxContentLength: 250_000,
      teamFilterIncludesProjectDocuments: false,
    });
    assert.ok(Object.isFrozen(LINEAR_FACTS));
  });

  it('counts length in code points, as Linear does', () => {
    assert.equal(linearLength('\u{1F600}'.repeat(3)), 3);
    assert.equal(linearLength('\u00e9t\u00e9'), 3);
    assert.equal(linearLength(''), 0);
    assert.equal(lengthRefusal({ title: 'Plan', content: '\u{1F600}'.repeat(125_001) }), undefined);
    assert.deepEqual(lengthRefusal({ content: '\u{1F600}'.repeat(250_001) }), { field: 'content', length: 250_001, limit: 250_000 });
    assert.deepEqual(lengthRefusal({ title: 'x'.repeat(513), content: 'a'.repeat(250_001) }), { field: 'title', length: 513, limit: 512 });
  });
});

describe('Linear trash as the fake world models it', () => {
  const client = (world: FakeWorld) => new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
  const place = { teamId: 'team-eng', createdAt: '2026-02-01T00:00:00.000Z' };

  it('moves a document to the trash on delete, and still reads it by id and in lists with includeArchived', async () => {
    const world = fakeWorld();
    world.linear.documents.push({ id: 'doc-1', title: 'Plan', ...place });
    const linear = client(world);
    await linear.trashDocument('doc-1');
    const read = await linear.getDocument('doc-1');
    assert.equal(read?.trashed, true);
    assert.notEqual(read?.archivedAt, null);
    assert.deepEqual((await linear.getDocuments(['doc-1'])).map((d) => d.trashed), [true]);
    assert.deepEqual(await linear.listDocuments({ teamId: 'team-eng' }), []);
    assert.deepEqual((await linear.listDocuments({ teamId: 'team-eng' }, { includeArchived: true })).map((d) => d.id), ['doc-1']);
    await linear.restoreDocument('doc-1');
    const restored = await linear.getDocument('doc-1');
    assert.deepEqual([restored?.trashed, restored?.archivedAt], [false, null]);
  });

  it('reads an unlisted document by id alone, and answers null for an id Linear no longer has', async () => {
    const world = fakeWorld();
    world.linear.documents.push({ id: 'doc-1', title: 'Plan', ...place, trashed: true, archivedAt: '2026-02-02T00:00:00.000Z', unlisted: true });
    const linear = client(world);
    assert.deepEqual(await linear.listDocuments({ teamId: 'team-eng' }, { includeArchived: true }), []);
    assert.deepEqual(await linear.getDocuments(['doc-1']), []);
    assert.equal((await linear.getDocument('doc-1'))?.trashed, true);
    assert.equal(await linear.getDocument('doc-gone'), null);
  });
});
