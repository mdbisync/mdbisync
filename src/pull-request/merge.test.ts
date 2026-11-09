import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FakeCheck, GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { PullRequestError } from './github.ts';
import { mergePullRequest, readChecks } from './merge.ts';

const SHA = 'a'.repeat(40);

function target(checks: FakeCheck[]) {
  const world = fakeWorld();
  world.github.checks = new Map([[SHA, checks]]);
  return { world, repo: { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) } };
}

describe('readChecks', () => {
  it('passes a commit without checks, and one whose checks succeeded, were neutral or skipped', async () => {
    assert.deepEqual(await readChecks(target([]).repo, SHA), { state: 'passed', failed: [], pending: [] });
    const checks: FakeCheck[] = [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'neutral' },
      { name: 'c', status: 'completed', conclusion: 'skipped' },
      { name: 'd', status: 'completed', conclusion: 'success', commitStatus: true },
    ];
    assert.deepEqual(await readChecks(target(checks).repo, SHA), { state: 'passed', failed: [], pending: [] });
  });

  it('reads every page of check runs, so a failure past the first hundred is seen', async () => {
    const checks: FakeCheck[] = Array.from({ length: 150 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' }));
    checks.push({ name: 'late', status: 'completed', conclusion: 'timed_out' });
    const { world, repo } = target(checks);
    assert.deepEqual(await readChecks(repo, SHA), { state: 'failed', failed: ['late'], pending: [] });
    assert.equal(world.requests.filter((request) => request.includes('/check-runs')).length, 2);
  });

  it('reports pending checks and statuses, and a failure over a pending one', async () => {
    const pending: FakeCheck[] = [
      { name: 'queued', status: 'queued' },
      { name: 'ext', status: 'pending', commitStatus: true },
    ];
    assert.deepEqual(await readChecks(target(pending).repo, SHA), { state: 'pending', failed: [], pending: ['ext', 'queued'] });
    const failed: FakeCheck[] = [...pending, { name: 'cancelled', status: 'completed', conclusion: 'cancelled' }];
    assert.deepEqual(await readChecks(target(failed).repo, SHA), { state: 'failed', failed: ['cancelled'], pending: ['ext', 'queued'] });
  });

  it('never reads unlisted commit statuses or check runs as passed', async () => {
    const statuses: FakeCheck[] = Array.from({ length: 101 }, (_, i) => ({ name: `ctx-${i}`, status: 'completed', conclusion: 'success', commitStatus: true }));
    const { world, repo } = target(statuses);
    const answer = (await readChecks(repo, SHA));
    // The fake lists every status in one answer; GitHub lists at most one page of contexts.
    assert.equal(answer.state, 'passed');
    const paged = fakeFetch(world);
    const truncated: typeof fetch = async (input, init) => {
      const response = await paged(input, init);
      if (!String(input).includes('/status?')) return response;
      const body = (await response.json()) as { statuses: unknown[]; total_count: number };
      return new Response(JSON.stringify({ ...body, statuses: body.statuses.slice(0, 100) }), { status: 200 });
    };
    assert.deepEqual(await readChecks({ ...repo, fetch: truncated }, SHA), { state: 'pending', failed: [], pending: ['1 more commit statuses'] });

    const empty: typeof fetch = async (input) =>
      String(input).includes('/check-runs')
        ? new Response(JSON.stringify({ total_count: 3, check_runs: [] }), { status: 200 })
        : new Response(JSON.stringify({ total_count: 0, statuses: [] }), { status: 200 });
    assert.deepEqual(await readChecks({ ...repo, fetch: empty }, SHA), { state: 'pending', failed: [], pending: ['3 more check runs'] });
  });

  it('throws a pull request error, without a body, when GitHub refuses', async () => {
    const { world, repo } = target([]);
    world.github.missing.add('checks:read');
    await assert.rejects(readChecks(repo, SHA), (error: unknown) => error instanceof PullRequestError && error.status === 403);
  });
});

describe('mergePullRequest', () => {
  it('merges with a merge commit while the head is the commit read, and reports a refusal by its status and reason', async () => {
    const { world, repo } = target([]);
    world.github.pullRequests.push({ number: 1, title: 't', body: 'b', head: 'sync', base: 'main', state: 'open', merged: false });
    world.github.merge = async (_pr, sha) => (sha === SHA ? { sha: 'b'.repeat(40) } : { status: 409, message: 'Head branch was modified. Review and try the merge again.' });
    assert.deepEqual(await mergePullRequest(repo, 1, 'c'.repeat(40)), { merged: false, status: 409, reason: 'Head branch was modified. Review and try the merge again.' });
    assert.deepEqual(await mergePullRequest(repo, 1, SHA), { merged: true, sha: 'b'.repeat(40) });
    assert.deepEqual(await mergePullRequest(repo, 1, SHA), { merged: false, status: 422, reason: 'Pull Request is not open' });
  });

  it("keeps GitHub's reason on one line, without backticks, and short", async () => {
    const { world, repo } = target([]);
    world.github.pullRequests.push({ number: 1, title: 't', body: 'b', head: 'sync', base: 'main', state: 'open', merged: false });
    world.github.merge = async () => ({ status: 405, message: 'Repository rule violations found\n\n`review`\trequired.' });
    assert.deepEqual(await mergePullRequest(repo, 1, SHA), { merged: false, status: 405, reason: 'Repository rule violations found review required.' });
    world.github.merge = async () => ({ status: 405, message: 'x'.repeat(1000) });
    const long = await mergePullRequest(repo, 1, SHA);
    assert.ok(!long.merged && long.reason.length === 300 && long.reason.endsWith('…'));
  });

  it('a request that gets no answer is a PullRequestError without a status', async () => {
    const { world, repo } = target([]);
    world.github.pullRequests.push({ number: 1, title: 't', body: 'b', head: 'sync', base: 'main', state: 'open', merged: false });
    world.github.reset = () => 'before';
    await assert.rejects(mergePullRequest(repo, 1, SHA), (error: unknown) => error instanceof PullRequestError && error.status === undefined && /did not answer/.test(error.message));
  });
});
