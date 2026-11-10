import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FakeCheck, GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { PullRequestError } from './github.ts';
import { mergePullRequest, readAnnotations, readChecks, waitForChecks } from './merge.ts';

const SHA = 'a'.repeat(40);

function target(checks: FakeCheck[]) {
  const world = fakeWorld();
  world.github.checks = new Map([[SHA, checks]]);
  return { world, repo: { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) } };
}

describe('readChecks', () => {
  it('passes a commit without checks, and one whose checks succeeded, were neutral or skipped', async () => {
    assert.deepEqual(await readChecks(target([]).repo, SHA), { state: 'passed', failed: [], pending: [], hasChecks: false });
    const checks: FakeCheck[] = [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'neutral' },
      { name: 'c', status: 'completed', conclusion: 'skipped' },
      { name: 'd', status: 'completed', conclusion: 'success', commitStatus: true },
    ];
    assert.deepEqual(await readChecks(target(checks).repo, SHA), { state: 'passed', failed: [], pending: [], hasChecks: true, succeeded: ['a', 'b', 'c', 'd'] });
  });

  it('reads every page of check runs, so a failure past the first hundred is seen', async () => {
    const checks: FakeCheck[] = Array.from({ length: 150 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' }));
    checks.push({ name: 'late', status: 'completed', conclusion: 'timed_out' });
    const { world, repo } = target(checks);
    const { succeeded, ...state } = await readChecks(repo, SHA);
    assert.deepEqual(state, { hasChecks: true, state: 'failed', failed: ['late'], pending: [], failures: [{ name: 'late', url: 'https://github.test/owner/repo/runs/151', checkRunId: 151 }] });
    assert.equal(succeeded?.length, 150);
    assert.equal(world.requests.filter((request) => request.includes('/check-runs')).length, 2);
  });

  it('reports pending checks and statuses, and a failure over a pending one', async () => {
    const pending: FakeCheck[] = [
      { name: 'queued', status: 'queued' },
      { name: 'ext', status: 'pending', commitStatus: true },
    ];
    assert.deepEqual(await readChecks(target(pending).repo, SHA), { hasChecks: true, state: 'pending', failed: [], pending: ['ext', 'queued'] });
    const failed: FakeCheck[] = [...pending, { name: 'cancelled', status: 'completed', conclusion: 'cancelled' }];
    assert.deepEqual(await readChecks(target(failed).repo, SHA), { hasChecks: true, state: 'failed', failed: ['cancelled'], pending: ['ext', 'queued'], failures: [{ name: 'cancelled', url: 'https://github.test/owner/repo/runs/2', checkRunId: 2 }] });
  });

  it('names each failed check with its run link, a commit status with its https link only', async () => {
    const checks: FakeCheck[] = [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'ci/external', status: 'completed', conclusion: 'error', commitStatus: true, url: 'https://ci.example.test/build/7' },
      { name: 'ci/plain', status: 'completed', conclusion: 'failure', commitStatus: true, url: 'http://ci.example.test/build/8' },
      { name: 'ci/secret', status: 'completed', conclusion: 'failure', commitStatus: true, url: 'https://user:pass@ci.example.test/build/9' },
    ];
    const state = await readChecks(target(checks).repo, SHA);
    assert.deepEqual(state.failures, [
      { name: 'ci/external', url: 'https://ci.example.test/build/7' },
      { name: 'ci/plain' },
      { name: 'ci/secret' },
      { name: 'lint', url: 'https://github.test/owner/repo/runs/1', checkRunId: 1 },
    ]);
  });
});

describe('readAnnotations', () => {
  it('reads a check run\'s annotations page by page, path, line, title and message only', async () => {
    const annotations = Array.from({ length: 130 }, (_, i) => ({ path: 'docs/a.md', start_line: i + 1, message: `Problem ${i}.`, ...(i === 0 ? { title: 'Heading' } : {}) }));
    const { world, repo } = target([{ name: 'lint', status: 'completed', conclusion: 'failure', annotations }]);
    const [failure] = (await readChecks(repo, SHA)).failures ?? [];
    const read = await readAnnotations(repo, failure?.checkRunId as number);
    assert.equal(read.length, 130);
    assert.deepEqual(read[0], { path: 'docs/a.md', line: 1, title: 'Heading', message: 'Problem 0.' });
    assert.deepEqual(read[1], { path: 'docs/a.md', line: 2, message: 'Problem 1.' });
    assert.equal(world.github.annotationReads, 2);
  });

  it('fails as a GitHub error when the annotations cannot be read', async () => {
    const { world, repo } = target([{ name: 'lint', status: 'completed', conclusion: 'failure' }]);
    world.github.missing.add('checks:read');
    await assert.rejects(readAnnotations(repo, 1), PullRequestError);
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
    const { succeeded: _listed, ...truncatedState } = await readChecks({ ...repo, fetch: truncated }, SHA);
    assert.deepEqual(truncatedState, { hasChecks: true, state: 'pending', failed: [], pending: ['1 more commit statuses'] });

    const empty: typeof fetch = async (input) =>
      String(input).includes('/check-runs')
        ? new Response(JSON.stringify({ total_count: 3, check_runs: [] }), { status: 200 })
        : new Response(JSON.stringify({ total_count: 0, statuses: [] }), { status: 200 });
    assert.deepEqual(await readChecks({ ...repo, fetch: empty }, SHA), { hasChecks: true, state: 'pending', failed: [], pending: ['3 more check runs'] });
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
    // A character outside the BMP at the cut stays whole.
    world.github.merge = async () => ({ status: 405, message: `${'x'.repeat(298)}${'😀'.repeat(10)}` });
    const astral = await mergePullRequest(repo, 1, SHA);
    assert.ok(!astral.merged);
    assert.equal(astral.reason, `${'x'.repeat(298)}😀…`);
    assert.doesNotThrow(() => encodeURIComponent(astral.reason));
  });

  it('a request whose fake throws for another reason keeps that error', async () => {
    const { world, repo } = target([]);
    world.github.pullRequests.push({ number: 1, title: 't', body: 'b', head: 'sync', base: 'main', state: 'open', merged: false });
    world.github.merge = async () => {
      throw new Error('a bug in the test');
    };
    await assert.rejects(mergePullRequest(repo, 1, SHA), /a bug in the test/);
  });

  it('a request that gets no answer is a PullRequestError without a status', async () => {
    const { world, repo } = target([]);
    world.github.pullRequests.push({ number: 1, title: 't', body: 'b', head: 'sync', base: 'main', state: 'open', merged: false });
    world.github.reset = () => 'before';
    await assert.rejects(mergePullRequest(repo, 1, SHA), (error: unknown) => error instanceof PullRequestError && error.status === undefined && /did not answer/.test(error.message));
  });
});

describe('waitForChecks', () => {
  const passing: FakeCheck = { name: 'ci', status: 'completed', conclusion: 'success' };
  async function scenario(at: (ms: number) => FakeCheck[], seconds = 60) {
    const { world, repo } = target([]);
    let elapsed = 0;
    const clock = {
      now: () => elapsed,
      sleep: async (ms: number) => { elapsed += ms; world.github.checks?.set(SHA, at(elapsed)); },
    };
    world.github.checks?.set(SHA, at(0));
    const result = await waitForChecks(repo, SHA, seconds, clock);
    return { result, elapsed, world };
  }
  it('allows green checks to merge only after the registration minimum', async () => {
    const { result, elapsed } = await scenario(ms => ms < 10_000 ? [{ name: 'ci', status: 'in_progress' }] : [passing]);
    assert.equal(result.state, 'passed');
    assert.equal(elapsed, 15_000);
  });
  it('waits for a later workflow when an early check is already green', async () => {
    const { result, elapsed } = await scenario(ms => [passing, ...(ms >= 10_000 ? [{ name: 'tests', status: ms < 20_000 ? 'queued' as const : 'completed' as const, conclusion: 'success' }] : [])]);
    assert.equal(result.state, 'passed');
    assert.equal(elapsed, 20_000);
    assert.equal((await scenario(() => [passing], 10)).result.state, 'pending');
  });
  it('propagates caller cancellation instead of treating it as the grace deadline', async () => {
    const { repo } = target([]);
    const controller = new AbortController();
    const fetcher: typeof fetch = async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); };
    await assert.rejects(waitForChecks({ ...repo, fetch: fetcher, signal: controller.signal }, SHA, 60), PullRequestError);
  });
  it('bounds a pending check and its request count, including when the grace is shorter than a poll', async () => {
    for (const seconds of [1, 60, 120]) {
      const { result, elapsed, world } = await scenario(() => [{ name: 'ci', status: 'queued' }], seconds);
      assert.equal(result.state, 'pending');
      assert.equal(elapsed, seconds * 1000);
      assert.equal(world.requests.length, Math.ceil(seconds / 5) * 2);
    }
  });
  it('reports a failure immediately even if another check runs', async () => {
    const { result, elapsed } = await scenario(() => [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    assert.equal(result.state, 'failed');
    assert.equal(elapsed, 0);
  });
  it('requires fifteen seconds of continuously absent checks', async () => {
    const { result, elapsed } = await scenario(() => []);
    assert.equal(result.state, 'passed');
    assert.equal(elapsed, 15_000);
    assert.equal((await scenario(() => [], 10)).result.state, 'pending');
    const delayed = await scenario(ms => ms >= 10_000 ? [{ name: 'ci', status: 'queued' }] : []);
    assert.equal(delayed.result.state, 'pending');
    assert.equal(delayed.elapsed, 60_000);
    const reset = await scenario(ms => ms === 5000 ? [{ name: 'ci', status: 'queued' }] : []);
    assert.equal(reset.elapsed, 25_000);
  });
  it('aborts an unfinished HTTP observation at the grace deadline', async () => {
    const { repo } = target([]);
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
    });
    // AbortSignal's own timer is unref'ed; keep this isolated test alive.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const result = await waitForChecks({ ...repo, fetch: fetcher }, SHA, 0.02);
      assert.equal(aborted, true);
      assert.equal(result.state, 'pending');
    } finally {
      clearTimeout(keepAlive);
    }
  });
  it('does not accept a green response that arrives past the deadline', async () => {
    const { repo } = target([passing]);
    let elapsed = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await (repo.fetch as typeof fetch)(input, init);
      elapsed += 40_000;
      return response;
    };
    const result = await waitForChecks({ ...repo, fetch: fetcher }, SHA, 60, { now: () => elapsed, sleep: async () => {} });
    assert.equal(result.state, 'pending');
  });
});
