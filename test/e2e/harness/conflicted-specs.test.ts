// Execute the live specs that start from an open conflict (L3-09 to L3-14)
// against local git and the same service fakes as the engine tests. The
// setup is the live one: the initial sync, then the setup conflict, whose
// markers reach the tracked branch through the sync cycle, so the git-side
// steps (L3-10, L3-12) find them there. The setup fails unless they do.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fakeLfsServer } from '../../../src/state/test-helpers.ts';
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

it('a conflicted setup settles with a new document linking an absent LFS image and reports the omission', { timeout: 180_000 }, async (t) => {
  const server = await fakeLfsServer([]);
  try {
    const scenario = loadScenarios().find((s) => s.id === 'L3-10')!;
    const path = 'eng/notes/z-figure.md';
    const documents = {
      ...DOCUMENTS,
      [path]: '# Figure\n\n![Diagram](../media/diagram.png)\n',
      'eng/media/diagram.png': `version https://git-lfs.github.com/spec/v1\noid sha256:${'ab'.repeat(32)}\nsize 42\n`,
    };
    const outcomes = await runOnFakeServices(t, scenario, documents, {
      lfsUrl: server.url,
      inspect: async (ctx) => {
        assert.ok(ctx.engine.results.some((run) => run.summary.includes(`| ${path} | upload-unreadable |`)), 'the report names the left-out document and rule');
        assert.equal(ctx.engine.results.at(-1)?.report?.['complete'], true);
        assert.equal(ctx.engine.results.at(-1)?.report?.['changed'], false);
      },
    });
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  } finally {
    await server.close();
  }
});
