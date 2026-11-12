// Execute the live specs that start from an open conflict (L3-09 to L3-14)
// against local git and the same service fakes as the engine tests. The
// setup is the live one: the initial sync, then the setup conflict, whose
// markers reach the tracked branch through the sync cycle, so the git-side
// steps (L3-10, L3-12) find them there.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadScenarios } from './spec.ts';
import { runScenarioSteps, specWorld } from './spec-world.ts';

const CONFLICTED = /^L3-(09|1[0-4])$/;

it('the conflicted L3 specs are the six scenarios this file runs', () => {
  const ids = ['L3-09', 'L3-10', 'L3-11', 'L3-12', 'L3-13', 'L3-14'];
  assert.deepEqual(loadScenarios().filter((s) => s.setup.state === 'conflicted' && s.id.startsWith('L3-')).map((s) => s.id), ids);
  assert.deepEqual(loadScenarios().filter((s) => CONFLICTED.test(s.id)).map((s) => s.id), ids);
});

for (const scenario of loadScenarios().filter((s) => CONFLICTED.test(s.id))) {
  it(`${scenario.id}: live setup, steps and assertions on fake services`, { timeout: 180_000 }, async (t) => {
    const spec = await specWorld(t, scenario);
    try {
      // The setup fails unless the tracked branch holds the conflict's markers.
      await spec.setUp();
      await runScenarioSteps(spec);
      await spec.check();
    } finally { await spec.cleanup(); }
  });
}
