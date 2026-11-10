import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LinearClient, LinearGraphQLError, LinearHttpError, LinearNetworkError, LinearStoppedError } from '../../../src/linear/index.ts';
import { retryCleanup } from './cleanup-retry.ts';
import { LinearWorld } from './linear-world.ts';

it('preserves the server error when its response also stops the client on low budget', async () => {
  let calls = 0;
  const client = new LinearClient({ token: 'key', fetch: async () => {
    calls += 1;
    return Response.json({ errors: [{ extensions: { code: 'DEADLOCK_DETECTED' } }] }, { headers: { 'x-ratelimit-requests-remaining': '0' } });
  } });
  await assert.rejects(new LinearWorld(client).deleteProject({ id: 'project', name: 'Field notes abc123' }, 'abc123'), (error) => error instanceof LinearGraphQLError && error.code === 'DEADLOCK_DETECTED');
  assert.equal(calls, 1);
  assert.equal(client.stats.writesAfterStop, 0);
});

it('keeps the original failure if the client stops during the pause', async () => {
  const error = new LinearHttpError('DeleteProject', 503);
  let calls = 0;
  let stopped = false;
  await assert.rejects(retryCleanup(async () => { calls += 1; throw error; }, async () => { stopped = true; }, () => !stopped), (caught) => caught === error);
  assert.equal(calls, 1);
});

it('accepts not-found only after a transient delete failure', async () => {
  let calls = 0;
  const client = new LinearClient({ token: 'key', fetch: async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
      : Response.json({ errors: [{ message: 'Entity not found: Project' }] });
  } });
  const world = new LinearWorld(client);
  const project = { id: 'project', name: 'Field notes abc123' };
  await world.deleteProject(project, 'abc123');
  assert.equal(calls, 2);
  await assert.rejects(world.deleteProject(project, 'abc123'), (error) => error instanceof LinearGraphQLError && error.notFound);
  assert.equal(calls, 3);
});

for (const error of [
  new LinearGraphQLError('DeleteProject', 200, { extensions: { code: 'DEADLOCK_DETECTED' } }),
  new LinearGraphQLError('GetDocuments', 200, { extensions: { code: 'INTERNAL_SERVER_ERROR' } }),
  new LinearGraphQLError('RunProjects', 503, {}),
  new LinearHttpError('DeleteProject', 502),
]) {
  it(`retries ${error.operation} ${error.message} with a pause and returns the result`, async () => {
    let calls = 0;
    const pauses: number[] = [];
    const result = await retryCleanup(async () => {
      if (++calls < 3) throw error;
      return 'done';
    }, async (ms) => { pauses.push(ms); });
    assert.equal(result, 'done');
    assert.equal(calls, 3);
    assert.deepEqual(pauses, [1000, 1000]);
  });
}

it('stops after three failed attempts and reports the last error unchanged', async () => {
  let calls = 0;
  const pauses: number[] = [];
  const errors = [1, 2, 3].map((n) => new LinearGraphQLError('DeleteProject', 200, { message: `failure ${n}`, extensions: { code: 'DEADLOCK_DETECTED' } }));
  await assert.rejects(retryCleanup(async () => { throw errors[calls++]; }, async (ms) => { pauses.push(ms); }), (error) => error === errors[2]);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 1000]);
});

for (const error of [
  new LinearGraphQLError('DeleteProject', 200, { message: 'Entity not found: Project' }),
  new LinearGraphQLError('DeleteProject', 200, { extensions: { code: 'FORBIDDEN' } }),
  new LinearHttpError('DeleteProject', 401),
  new LinearStoppedError('DeleteProject', { kind: 'rate-limited', operation: 'DeleteProject' }),
  new LinearNetworkError('DeleteProject', new Error('connection lost')),
  new Error('invalid cleanup state'),
]) {
  it(`reports ${error.message} immediately without retrying`, async () => {
    let calls = 0;
    await assert.rejects(retryCleanup(async () => { calls += 1; throw error; }, async () => { assert.fail('unexpected pause'); }), (caught) => caught === error);
    assert.equal(calls, 1);
  });
}
