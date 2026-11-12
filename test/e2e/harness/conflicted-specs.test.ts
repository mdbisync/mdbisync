// Execute the live specs that start from an open conflict (L3-09 to L3-14)
// against local git and the same service fakes as the engine tests. The
// setup is the live one: the initial sync, then the setup conflict, whose
// markers reach the tracked branch through the sync cycle, so the git-side
// steps (L3-10, L3-12) find them there. The setup fails unless they do.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { loadScenarios } from './spec.ts';

const CONFLICTED = /^L3-(09|1[0-4])$/;

it('the conflicted L3 specs are the six scenarios this file runs', () => {
  const ids = ['L3-09', 'L3-10', 'L3-11', 'L3-12', 'L3-13', 'L3-14'];
  assert.deepEqual(loadScenarios().filter((s) => s.setup.state === 'conflicted' && s.id.startsWith('L3-')).map((s) => s.id), ids);
  assert.deepEqual(loadScenarios().filter((s) => CONFLICTED.test(s.id)).map((s) => s.id), ids);
});

for (const scenario of loadScenarios().filter((s) => CONFLICTED.test(s.id))) {
  it(`${scenario.id}: live setup, steps and assertions on fake services`, { timeout: 180_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });
}
