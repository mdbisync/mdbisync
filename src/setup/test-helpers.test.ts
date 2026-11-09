import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fakeFetch, fakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST } from './test-helpers.ts';

it('rejects unrelated origins and API path prefixes in the fake transport', async () => {
  const request = fakeFetch(fakeWorld());
  for (const url of [
    `${LINEAR_API}.example.com/graphql`,
    `${LINEAR_API}@example.com/graphql`,
    `${GITHUB_API}-other/repos/example/repository`,
    `${GITHUB_API.replace('github.test', 'github.test.example.com')}/repos/example/repository`,
    `${UPLOADS_HOST}.example.com/file.png`,
  ]) {
    await assert.rejects(request(url), /unexpected request/);
  }
  assert.equal((await request(`${GITHUB_API}/repos/example/repository`)).status, 200);
  assert.equal((await request(`${UPLOADS_HOST}/missing.png`)).status, 404);
});
