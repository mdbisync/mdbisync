// Execute the live sync-branch reconciliation specs (L4-14 to L4-18) against
// local git and the same service fakes as the engine tests. The scenario's
// actions and assertions remain the live ones; only the services are fakes.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runOnFakeServices } from './fake-services.ts';
import { loadScenarios } from './spec.ts';

const RECONCILE = /^L4-1[4-8]$/;

it('the reconciliation specs are the five scenarios this file runs', () => {
  assert.deepEqual(loadScenarios().filter((s) => RECONCILE.test(s.id)).map((s) => s.id), ['L4-14', 'L4-15', 'L4-16', 'L4-17', 'L4-18']);
});

for (const scenario of loadScenarios().filter((s) => RECONCILE.test(s.id))) {
  it(`${scenario.id}: live steps and assertions on fake services`, { timeout: 180_000 }, async (t) => {
    const documents = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`eng/notes/item-${i}.md`, `# Notes ${i}\n\nFirst paragraph.\n\nSecond paragraph.\n`]));
    const outcomes = await runOnFakeServices(t, scenario, documents);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });
}
