import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  DOCUMENT_BODY_BUDGET_BYTES,
  LINEAR_FACTS,
  LinearClient,
  LinearGraphQLError,
  LinearHttpError,
  LinearNetworkError,
  LinearResponseLimitError,
  LinearStoppedError,
  MAX_PAGE_SIZE,
  MAX_RESPONSE_BYTES,
} from '../../src/linear/index.ts';
import { fakeFetch, fakeWorld, LINEAR_API } from '../../src/setup/test-helpers.ts';

const place = { projectId: 'project-api', createdAt: '2026-01-01T00:00:00.000Z' };

/** An answer whose body never ends: a client that reads it whole never returns. */
function endlessAnswer(pulls: { count: number }): Response {
  const chunk = new TextEncoder().encode(`{"data":{"documents":{"nodes":[{"content":"${'a'.repeat(64 * 1024)}`);
  return new Response(new ReadableStream({ pull(controller) { pulls.count += 1; controller.enqueue(chunk); } }), { status: 200 });
}

describe('byte limits of Linear answers', () => {
  it('gives up an answer over the per-answer limit while reading it, before it is parsed', async () => {
    const pulls = { count: 0 };
    const limit = 1024 * 1024;
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: async () => endlessAnswer(pulls), limits: { responseBytes: limit } });
    await assert.rejects(linear.getDocuments(['d1']), (error: unknown) => {
      assert.ok(error instanceof LinearResponseLimitError);
      assert.equal(error.code, 'linear-response-too-large');
      assert.equal(error.limit, limit);
      assert.match(error.message, /^linear-response-too-large: GetDocuments: .* 1048576-byte limit/);
      return true;
    });
    // 64 KiB a chunk: the read stopped at the first chunk past the limit.
    assert.ok(pulls.count <= limit / (64 * 1024) + 2, `read ${pulls.count} chunks`);
  });

  it('treats a write whose answer is over the limit as a write with an unknown outcome', async () => {
    const pulls = { count: 0 };
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: async () => endlessAnswer(pulls), limits: { responseBytes: 1024 * 1024 } });
    await assert.rejects(linear.updateDocument('d1', { title: 'Plan' }), (error: unknown) => {
      assert.ok(error instanceof LinearNetworkError);
      assert.ok(error.cause instanceof LinearResponseLimitError);
      return true;
    });
  });

  it('counts the answers with bodies of one client toward its body budget, and only those', async () => {
    const world = fakeWorld();
    for (let i = 0; i < 6; i += 1) world.linear.documents.push({ id: `d${i}`, title: `Note ${i}`, ...place, content: 'x'.repeat(10_000) });
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: fakeFetch(world), limits: { bodyBytes: 50_000 } });
    // Reads without bodies cost nothing, however often.
    for (let i = 0; i < 20; i += 1) assert.equal((await linear.listDocuments({ projectId: 'project-api' })).length, 6);
    // Two documents a page: three pages of about 20 kB each, the third over the budget.
    const ids = world.linear.documents.map((document) => document.id);
    await assert.rejects(linear.getDocuments(ids, { withContent: true, pageSize: 2 }), (error: unknown) => {
      assert.ok(error instanceof LinearResponseLimitError);
      assert.equal(error.code, 'linear-body-budget');
      assert.equal(error.limit, 50_000);
      assert.match(error.message, /^linear-body-budget: GetDocuments: .* 50000-byte budget/);
      return true;
    });
    // The budget is the client's for the rest of the run: about 9 kB are left, less than one more body.
    await assert.rejects(linear.getDocuments(['d0'], { withContent: true }), { code: 'linear-body-budget' });
    await assert.rejects(linear.listDocuments({ projectId: 'project-api' }, { withContent: true }), { code: 'linear-body-budget' });
    assert.equal((await linear.getDocuments(ids)).length, 6);
    // One document read by itself, as the write step reads the document it writes next, is not counted.
    for (let i = 0; i < 10; i += 1) assert.equal((await linear.getDocument('d0', { withContent: true }))?.content?.length, 10_000);
  });

  it('stops on a rate limit answered with HTTP 200 when the body budget is nearly used up', async () => {
    const world = fakeWorld();
    world.linear.documents.push({ id: 'd0', title: 'Note', ...place, content: 'x'.repeat(10_000) });
    const fetch = fakeFetch(world);
    let limited = false;
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, limits: { bodyBytes: 10_500 }, maxRetryAfterSeconds: 0,
      fetch: async (input, init) => limited
        ? new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded '.repeat(100), extensions: { code: 'RATELIMITED' } }] }), { status: 200 })
        : fetch(input, init) });
    assert.equal((await linear.getDocuments(['d0'], { withContent: true })).length, 1);
    limited = true;
    await assert.rejects(linear.getDocuments(['d0'], { withContent: true }), (error: unknown) => error instanceof LinearStoppedError);
    assert.equal(linear.stopped?.kind, 'rate-limited');
  });

  it('reports an error answer as itself when the body budget is used up', async () => {
    const world = fakeWorld();
    world.linear.documents.push({ id: 'd0', title: 'Note', ...place, content: 'x'.repeat(10_000) });
    const fetch = fakeFetch(world);
    let failing = false;
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, limits: { bodyBytes: 10_500 },
      fetch: async (input, init) => failing ? new Response(JSON.stringify({ errors: [{ message: 'x'.repeat(2_000) }] }), { status: 502 }) : fetch(input, init) });
    assert.equal((await linear.getDocuments(['d0'], { withContent: true })).length, 1);
    failing = true;
    await assert.rejects(linear.getDocuments(['d0'], { withContent: true }), (error: unknown) => error instanceof LinearHttpError || error instanceof LinearGraphQLError);
  });

  it('reads an ordinary workspace with the default limits', async () => {
    const world = fakeWorld();
    for (let i = 0; i < 1000; i += 1) world.linear.documents.push({ id: `d${i}`, title: `Note ${i}`, ...place, content: `# Note ${i}\n\n${'Text of a note. '.repeat(200)}\n` });
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
    const ids = world.linear.documents.map((document) => document.id);
    assert.equal((await linear.getDocuments(ids, { withContent: true })).length, 1000);
    // Full pages: the limits cost no request.
    assert.equal(linear.stats.byOperation.get('GetDocuments'), 1000 / MAX_PAGE_SIZE);
  });

  it('reads a page over the per-answer limit again in halves, by id and in a listing', async () => {
    // One document of Linear's widest content in JSON (escaped control characters, six bytes each) fits the
    // limit, so halving always ends.
    assert.ok((LINEAR_FACTS.maxContentLength + LINEAR_FACTS.maxTitleLength) * 6 + 4096 < MAX_RESPONSE_BYTES);
    const world = fakeWorld();
    for (let i = 0; i < 6; i += 1) world.linear.documents.push({ id: `d${i}`, title: `Note ${i}`, ...place, content: 'x'.repeat(10_000) });
    const ids = world.linear.documents.map((document) => document.id);
    const linear = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: fakeFetch(world), limits: { responseBytes: 25_000 } });
    // Six bodies of 10 kB: the page of 6 and both of 3 are over, pages of 2 and 1 fit: 7 requests.
    assert.deepEqual((await linear.getDocuments(ids, { withContent: true })).map((document) => document.id), ids);
    assert.equal(linear.stats.byOperation.get('GetDocuments'), 7);
    assert.deepEqual((await linear.listDocuments({ projectId: 'project-api' }, { withContent: true })).map((document) => document.id).sort(), ids);
    // A single document over the limit is refused, not split.
    const tight = new LinearClient({ token: 't', baseUrl: LINEAR_API, fetch: fakeFetch(world), limits: { responseBytes: 5_000 } });
    await assert.rejects(tight.getDocuments(ids, { withContent: true }), { code: 'linear-response-too-large' });
  });

  // A run reads page after page of the longest documents Linear stores. Without a budget it holds them all; with
  // it, it stops after DOCUMENT_BODY_BUDGET_BYTES. A child process under a heap limit shows the bound, and the
  // parent's timeout stops a stall.
  it('keeps a run that reads the longest documents page after page within a heap limit', { timeout: 120_000 }, () => {
    const script = `
      import { LinearClient } from ${JSON.stringify(new URL('../../src/linear/index.ts', import.meta.url).href)};
      const content = 'a'.repeat(250000);
      // One document for each id asked for, each at Linear's longest content.
      const pageOf = new Map();
      const page = (size) => pageOf.get(size) ?? pageOf.set(size, Buffer.from(JSON.stringify({ data: { documents: { nodes: Array.from({ length: size }, (_, i) => ({
        id: 'd' + i, title: 'Note ' + i, slugId: 's' + i, icon: null, color: null, trashed: false, archivedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', documentContentId: 'c' + i, content, project: { id: 'p' }, team: null })) } } }))).get(size);
      let pages = 0;
      let pageBytes = 0;
      const fetch = async (_, init) => {
        pages += 1;
        const body = page(JSON.parse(init.body).variables.first);
        pageBytes = body.length;
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const linear = new LinearClient({ token: 't', fetch });
      // 10,000 ids, 2.5 GB of bodies.
      const ids = Array.from({ length: 10000 }, (_, i) => 'd' + i);
      try {
        const read = await linear.getDocuments(ids, { withContent: true });
        console.log(JSON.stringify({ read: read.length, pages, pageBytes }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message, pages, pageBytes }));
      }
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=640', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 90_000 });
    assert.notEqual((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', 'the reads did not finish within the parent timeout');
    assert.ifError(child.error);
    assert.equal(child.status, 0, `the child ended with signal ${child.signal}: ${child.stderr.slice(-2000)}`);
    const result = JSON.parse(child.stdout) as { code?: string; message?: string; pages: number; pageBytes: number };
    assert.equal(result.code, 'linear-body-budget', child.stdout);
    assert.match(result.message ?? '', new RegExp(`${DOCUMENT_BODY_BUDGET_BYTES}-byte budget`));
    // About 63 MB a page: the first page past the 256 MiB budget is refused.
    assert.equal(result.pages, Math.floor(DOCUMENT_BODY_BUDGET_BYTES / result.pageBytes) + 1);
  });
});
