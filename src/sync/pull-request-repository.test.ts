import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request head repository', () => {
  const h = pullRequestHarness();

  it('leaves a same-organization fork alone and opens and reuses its own pull request', async () => {
    const fork = {
      number: 1, head: SYNC_BRANCH.slice('refs/heads/'.length), headRepository: 'owner/fork', base: 'main',
      title: 'Fork changes', body: 'Please review these changes.', state: 'open' as const, merged: false,
    };
    h.world.github.pullRequests.push(fork);
    const before = structuredClone(fork);
    await h.editInLinear('combined/guide.md', '# Guide\n\nEdited in Linear.\n');
    const opened = await h.sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    assert.equal(opened.report.pullRequest?.pullRequest?.number, 2);
    assert.deepEqual(fork, before);

    h.checksOn(await h.rev(SYNC_BRANCH), h.PASSED);
    const merged = await h.sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.ok(merged.report.pullRequest?.merged);
    assert.equal(h.world.github.pullRequests[1]?.merged, true);
    assert.deepEqual(fork, before);
    assert.ok(!h.world.writes.some((write) => /\/pulls\/1(?:\/|$)/.test(write)));
  });
});
