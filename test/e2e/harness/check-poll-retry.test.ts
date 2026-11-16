import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { waitForCheck, waitForCheckCompleted } from './check-fault.ts';
import { GitHubError, SandboxRest } from './github.ts';

/** A local check endpoint; its final answer repeats. */
function endpoint(answers: Array<number | 'pending' | 'passed'>) {
  let polls = 0;
  const times: number[] = [];
  const rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => {
    times.push(performance.now());
    const answer = answers[Math.min(polls++, answers.length - 1)]!;
    if (typeof answer === 'number') return new Response('', { status: answer });
    return Response.json({ check_runs: [{ id: polls, name: 'format', app: { slug: 'github-actions' },
      status: answer === 'pending' ? 'in_progress' : 'completed', conclusion: answer === 'passed' ? 'success' : null }] });
  }) as typeof fetch);
  return { rest, polls: () => polls, times };
}

describe('marker check polling after GitHub server errors', () => {
  it('retries a transient 5xx for either kind of wait', async () => {
    for (const wait of [
      (rest: SandboxRest) => waitForCheck(rest, 'abc', 'passed', { pollMs: 0 }),
      (rest: SandboxRest) => waitForCheckCompleted(rest, 'abc', { pollMs: 0 }),
    ]) {
      const api = endpoint([500, 'passed']);
      await wait(api.rest);
      assert.equal(api.polls(), 2);
    }
  });

  it('fails on the third 5xx with the last status and request path', async () => {
    const api = endpoint([500, 502, 503]);
    await assert.rejects(waitForCheck(api.rest, 'abc', 'passed', { pollMs: 0 }), {
      name: 'GitHubError', status: 503, message: 'GET /repos/example/sandbox/commits/abc/check-runs: HTTP 503',
    });
    assert.equal(api.polls(), 3);
  });

  it('counts errors across the whole wait, even with successful reads between them', async () => {
    const api = endpoint([500, 'pending', 502, 'pending', 503, 'passed']);
    await assert.rejects(waitForCheckCompleted(api.rest, 'abc', { pollMs: 0 }), { status: 503 });
    assert.equal(api.polls(), 5);
  });

  it('does not retry client errors', async () => {
    const api = endpoint([403, 'passed']);
    await assert.rejects(waitForCheck(api.rest, 'abc', 'passed', { pollMs: 0 }), GitHubError);
    assert.equal(api.polls(), 1);
  });

  it('doubles the polling delay before the second retry', async () => {
    const api = endpoint([500, 502, 'passed']);
    assert.equal(await waitForCheckCompleted(api.rest, 'abc', { pollMs: 30 }), 'passed');
    assert.equal(api.polls(), 3);
    assert.ok(api.times[1]! - api.times[0]! >= 29, 'first retry waits one polling interval');
    assert.ok(api.times[2]! - api.times[1]! >= 59, 'second retry waits two polling intervals');
  });

  it('keeps the server error when its backoff reaches the wait deadline', async (t) => {
    // A timer may wake slightly before Date.now reaches the deadline.
    let reads = 0;
    t.mock.method(Date, 'now', () => reads++ === 0 ? 0 : 19);
    const api = endpoint([502, 'passed']);
    await assert.rejects(waitForCheckCompleted(api.rest, 'abc', { timeoutMs: 20 }), { status: 502 });
    assert.equal(api.polls(), 1);
  });

  it('obeys cancellation during the backoff', async () => {
    const api = endpoint([500, 'passed']);
    const controller = new AbortController();
    const result = assert.rejects(waitForCheckCompleted(api.rest, 'abc', { signal: controller.signal }), { name: 'AbortError' });
    await setImmediate();
    controller.abort();
    await result;
    assert.equal(api.polls(), 1);
  });
});
