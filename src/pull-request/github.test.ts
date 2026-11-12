import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PullRequestError, closePullRequestAtHead, ensurePullRequest, openPullRequest, updatePullRequest } from './github.ts';
import { mergePullRequest } from './merge.ts';

/** A GitHub that answers every request with `status` and `body`. */
function answering(status: number, body: unknown) {
  const writes = new Map<string, number>();
  const fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof globalThis.fetch;
  return { target: { repository: 'owner/repo', token: 'token', apiUrl: 'https://api.example.test', fetch, writes }, writes };
}

const spec = { head: 'sync', base: 'main', title: 'Sync', body: 'Body.' };

describe('pull request writes', () => {
  it('counts a call GitHub accepted also when its answer cannot be read', async () => {
    const opened = answering(201, { number: 1 });
    await assert.rejects(openPullRequest(opened.target, spec), PullRequestError);
    assert.deepEqual(Object.fromEntries(opened.writes), { opened: 1 });
    const updated = answering(200, null);
    await assert.rejects(updatePullRequest(updated.target, 1, spec), PullRequestError);
    assert.deepEqual(Object.fromEntries(updated.writes), { updated: 1 });
    const merged = answering(200, { merged: true });
    await assert.rejects(mergePullRequest(merged.target, 1, 'abc'), PullRequestError);
    assert.deepEqual(Object.fromEntries(merged.writes), { merged: 1 });
  });

  it('counts a call GitHub accepted also when its answer breaks off while it is read', async () => {
    const writes = new Map<string, number>();
    const broken = new ReadableStream({ pull: (controller) => controller.error(new TypeError('terminated')) });
    const fetch = (async () => new Response(broken, { status: 201 })) as typeof globalThis.fetch;
    await assert.rejects(openPullRequest({ repository: 'owner/repo', token: 'token', apiUrl: 'https://api.example.test', fetch, writes }, spec), PullRequestError);
    assert.deepEqual(Object.fromEntries(writes), { opened: 1 });
  });

  it('counts no call GitHub refused', async () => {
    const opened = answering(422, { message: 'Validation Failed' });
    await assert.rejects(openPullRequest(opened.target, spec), PullRequestError);
    const merged = answering(405, { message: 'Pull Request is not mergeable' });
    assert.equal((await mergePullRequest(merged.target, 1, 'abc')).merged, false);
    assert.deepEqual([...opened.writes, ...merged.writes], []);
  });
});

describe('ensuring the sync pull request', () => {
  const node = (body: string) => ({ number: 7, html_url: 'https://github.test/pull/7', head: { ref: 'sync' }, base: { ref: 'main' }, title: 'Sync', body });

  /** A GitHub where another run opens the pull request between this run's look and its open. */
  function racing(open: unknown[] | Response, openAnswer: { status: number; body: unknown }) {
    const calls: string[] = [];
    let listed = 0;
    const fetch = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'GET') return listed++ === 0 ? Response.json([]) : open instanceof Response ? open : Response.json(open);
      if (method === 'POST') return Response.json(openAnswer.body, { status: openAnswer.status });
      return Response.json(node(JSON.parse(String(init?.body)).body as string));
    }) as typeof globalThis.fetch;
    return { target: { repository: 'owner/repo', token: 'token', apiUrl: 'https://api.example.test', fetch }, calls };
  }

  it('uses the pull request another run opened when GitHub refuses a duplicate', async () => {
    const same = racing([node('Body.')], { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for owner:sync.' }] } });
    const kept = await ensurePullRequest(same.target, spec);
    assert.deepEqual(kept, { pullRequest: { number: 7, url: 'https://github.test/pull/7', head: 'sync', base: 'main', title: 'Sync', body: 'Body.' }, opened: false, updated: false });
    assert.deepEqual(same.calls, ['GET', 'POST', 'GET']);

    // The other run's description is replaced with this run's, as for any open pull request.
    const other = racing([node('Other body.')], { status: 422, body: { message: 'Validation Failed' } });
    const updated = await ensurePullRequest(other.target, spec);
    assert.equal(updated.opened, false);
    assert.equal(updated.updated, true);
    assert.equal(updated.pullRequest.body, 'Body.');
    assert.deepEqual(other.calls, ['GET', 'POST', 'GET', 'PATCH']);
  });

  it('still fails on a refusal when no pull request is open, and on other statuses without looking again', async () => {
    const none = racing([], { status: 422, body: { message: 'Validation Failed' } });
    await assert.rejects(ensurePullRequest(none.target, spec), (error: unknown) => error instanceof PullRequestError && error.status === 422);
    assert.deepEqual(none.calls, ['GET', 'POST', 'GET']);
    // A second look that fails reports the refusal, not the look.
    const failing = racing(Response.json({ message: 'Server Error' }, { status: 502 }), { status: 422, body: { message: 'Validation Failed' } });
    await assert.rejects(ensurePullRequest(failing.target, spec), (error: unknown) => error instanceof PullRequestError && error.status === 422);
    assert.deepEqual(failing.calls, ['GET', 'POST', 'GET']);
    const forbidden = racing([node('Body.')], { status: 403, body: { message: 'Resource not accessible by integration' } });
    await assert.rejects(ensurePullRequest(forbidden.target, spec), (error: unknown) => error instanceof PullRequestError && error.status === 403);
    assert.deepEqual(forbidden.calls, ['GET', 'POST']);
  });
});

describe('closing only at the expected pull request head', () => {
  const target = (fetch: typeof globalThis.fetch, signal?: AbortSignal) => ({ repository: 'owner/repo', token: 'token', apiUrl: 'https://api.example.test', fetch, ...(signal === undefined ? {} : { signal }) });

  it('waits for the displayed head and counts only the accepted close', async () => {
    const methods: string[] = [];
    let reads = 0;
    const writes = new Map<string, number>();
    const fetch = (async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'PATCH') return new Response('{}');
      reads += 1;
      return Response.json({ state: 'open', head: { sha: reads === 1 ? 'old' : 'empty' } });
    }) as typeof globalThis.fetch;
    assert.equal(await closePullRequestAtHead({ ...target(fetch), writes }, 1, 'empty'), true);
    assert.deepEqual(methods, ['GET', 'GET', 'PATCH']);
    assert.deepEqual(Object.fromEntries(writes), { closed: 1 });
  });

  it('bounds stale or missing head reads without closing', async () => {
    for (const head of [{ sha: 'old' }, {}]) {
      let reads = 0;
      const fetch = (async (_input, init) => {
        assert.equal(init?.method, 'GET');
        reads += 1;
        return Response.json({ state: 'open', head });
      }) as typeof globalThis.fetch;
      assert.equal(await closePullRequestAtHead(target(fetch), 1, 'empty'), false);
      assert.equal(reads, 5);
    }
  });

  it('does not write when another actor already closed the pull request', async () => {
    let reads = 0;
    const fetch = (async (_input, init) => {
      assert.equal(init?.method, 'GET');
      reads += 1;
      return Response.json({ state: 'closed', head: { sha: 'old' } });
    }) as typeof globalThis.fetch;
    assert.equal(await closePullRequestAtHead(target(fetch), 1, 'empty'), true);
    assert.equal(reads, 1);
  });

  it('reports API refusal and caller cancellation instead of treating them as a stale head', async () => {
    const refused = answering(403, {});
    await assert.rejects(closePullRequestAtHead(refused.target, 1, 'empty'), (error: unknown) => error instanceof PullRequestError && error.status === 403);
    const controller = new AbortController();
    const cancelled = (async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error('expected abort');
    }) as typeof globalThis.fetch;
    await assert.rejects(closePullRequestAtHead(target(cancelled, controller.signal), 1, 'empty'), PullRequestError);
    const closeRefused = (async (_input, init) => init?.method === 'PATCH' ? Response.json({}, { status: 403 }) : Response.json({ state: 'open', head: { sha: 'empty' } })) as typeof globalThis.fetch;
    await assert.rejects(closePullRequestAtHead(target(closeRefused), 1, 'empty'), (error: unknown) => error instanceof PullRequestError && error.status === 403);
  });

  it('reports caller cancellation during the polling sleep as a GitHub failure', async () => {
    const controller = new AbortController();
    const fetch = (async () => Response.json({ state: 'open', head: { sha: 'old' } })) as typeof globalThis.fetch;
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(closePullRequestAtHead(target(fetch, controller.signal), 1, 'empty'), PullRequestError); }
    finally { clearTimeout(timer); }
  });

  it('does not hide an unrelated error when the visibility deadline expires', async () => {
    const unexpected = new Error('unexpected failure');
    const fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(unexpected), { once: true });
    })) as typeof globalThis.fetch;
    const keepAlive = setInterval(() => {}, 1_000);
    try { await assert.rejects(closePullRequestAtHead(target(fetch), 1, 'empty'), (error: unknown) => error === unexpected); }
    finally { clearInterval(keepAlive); }
  });

  it('defers when a detail request exceeds the visibility deadline', async () => {
    const fetch = (async (_input, init) => {
      assert.equal(init?.method, 'GET');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    // Keep the event loop alive as a real HTTP connection would.
    const keepAlive = setInterval(() => {}, 1_000);
    try { assert.equal(await closePullRequestAtHead(target(fetch), 1, 'empty'), false); }
    finally { clearInterval(keepAlive); }
  });
});
