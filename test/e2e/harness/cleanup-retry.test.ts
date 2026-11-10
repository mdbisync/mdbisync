import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LinearGraphQLError, LinearHttpError, LinearNetworkError, LinearStoppedError } from '../../../src/linear/index.ts';
import { retryCleanup } from './cleanup-retry.ts';

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
