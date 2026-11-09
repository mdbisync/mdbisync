import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PullRequestError, openPullRequest, updatePullRequest } from './github.ts';
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

  it('counts no call GitHub refused', async () => {
    const opened = answering(422, { message: 'Validation Failed' });
    await assert.rejects(openPullRequest(opened.target, spec), PullRequestError);
    const merged = answering(405, { message: 'Pull Request is not mergeable' });
    assert.equal((await mergePullRequest(merged.target, 1, 'abc')).merged, false);
    assert.deepEqual([...opened.writes, ...merged.writes], []);
  });
});
