// L3-17 (renamed in Linear, edited in git) and L3-18 (moved in git, edited in
// Linear) with their live steps and assertions on fake services. The fake
// GitHub merges as GitHub does: it does not pair a rename on one side with an
// edit on the other, so the sync pull request merges only when the sync
// branch has taken in the tracked branch.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { loadScenarios } from './spec.ts';

const SPECS = ['L3-17', 'L3-18'];

it('the rename and move against an edit are the two specs this file runs', () => {
  assert.deepEqual(loadScenarios().filter((s) => SPECS.includes(s.id)).map((s) => s.id), SPECS);
});

for (const scenario of loadScenarios().filter((s) => SPECS.includes(s.id))) {
  it(`${scenario.id}: both changes land, with the live steps and assertions on fake services`, { timeout: 180_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
      inspect: async (ctx) => {
        const runs = ctx.engine.results.slice(ctx.engine.setupRuns, ctx.observations.get('scenario.runsEnd') as number);
        const pullRequests = runs.map((run) => run.report?.['pullRequest'] as { merged?: unknown; code?: unknown } | undefined);
        assert.ok(pullRequests.some((step) => typeof step?.merged === 'string'), 'the sync pull request merged');
        assert.ok(pullRequests.every((step) => step?.code !== 'merge-blocked' && step?.code !== 'merge-refused'), 'GitHub refused no merge');
      },
    });
    const names = new Set(outcomes.map((outcome) => outcome.name));
    for (const name of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']) assert.ok(names.has(name), `${name} ran`);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });
}
