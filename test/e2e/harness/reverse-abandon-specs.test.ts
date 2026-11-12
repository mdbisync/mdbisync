// Execute the live spec for abandoning an initial pull request from Linear
// (L1R-07) against local git and the same service fakes as the engine tests,
// with seeded documents that embed tracked images. The scenario's actions and
// assertions remain the live ones; only the services are fakes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { RunContext } from './context.ts';
import { runOnFakeServices } from './fake-services.ts';
import { writeRunRefs } from './runner.ts';
import { loadScenarios } from './spec.ts';

/** Two small images, so one document embeds two different files: one inline, one by reference. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// The last document seeded is the newest in Linear: the first sync after the
// person's merge reads it again at the capture cursor, so its images decide
// whether that sync stays quiet. The inline image is linked with `./`, as the
// corpus writes it, the reference without: the first initial sync, whose upload
// cache is empty, must keep each spelling, or the replacement makes a different
// record and moves the `linear` ref to a commit that does not descend from the
// first (I4).
const DOCUMENTS: Readonly<Record<string, string | Buffer>> = {
  'eng/notes/images/diagram.png': PNG,
  'eng/notes/images/chart.gif': GIF,
  'eng/notes/item-0.md': '# Notes 0\n\nFirst paragraph.\n\nSecond paragraph.\n',
  'eng/notes/item-1.md': '# Notes 1\n\nFirst paragraph.\n\n![Diagram](./images/diagram.png)\n\n*Diagram*\n\n![Chart][chart]\n\n*Chart*\n\n[chart]: images/chart.gif\n',
};

/** A watched run's refs before and after it, as `run-refs.json` keeps them. */
type RunRefs = { before: Record<string, string>; after: Record<string, string> };

/**
 * Outcomes the fakes cannot give, and what stands in for each: no proxy sees
 * an in-process run (request cost and Linear writes are unknown), and the
 * in-process report has no exit code, which the run's result holds instead.
 */
const OFFLINE: Readonly<Record<string, (ctx: RunContext) => void>> = {
  I9: () => {},
  'untouched.1': (ctx) => assert.deepEqual(ctx.observations.get('harness.untouched.1'), ['the proxy did not see the run, so its Linear writes are unknown']),
  'runs.1.exitCode': (ctx) => assert.equal(ctx.engine.results[ctx.engine.setupRuns + 1]?.exitCode, 4),
};

it('L1R-07 on fake services: the first sync after the person merges the replacement leaves seeded images alone', { timeout: 180_000 }, async (t) => {
  const scenario = loadScenarios().find((candidate) => candidate.id === 'L1R-07');
  assert.ok(scenario);
  let seeded: unknown;
  let refusal: RunRefs | undefined;
  let firstAfterMerge: { capture?: { blocked?: unknown[] }; writes?: unknown } | undefined;
  const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
    inspect: async (ctx) => {
      seeded = ctx.observations.get('setup.seeded');
      // The scenario's runs 0 to 3 follow setup's; I6's extra sync comes after them.
      firstAfterMerge = ctx.engine.results[ctx.engine.setupRuns + 3]?.report as typeof firstAfterMerge;
      for (const check of Object.values(OFFLINE)) check(ctx);
      // The refusal's evidence keeps the raw ref maps it compared, not only the outcome.
      const dir = mkdtempSync(join(tmpdir(), 'run-refs-'));
      try {
        writeRunRefs(ctx, dir);
        refusal = (JSON.parse(readFileSync(join(dir, 'run-refs.json'), 'utf8')) as Record<string, RunRefs>)['1'];
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  });
  assert.equal((seeded as string[]).length, 2);
  assert.ok(refusal !== undefined && Object.keys(refusal.before).some((ref) => ref.endsWith('/ids')));
  assert.deepEqual(refusal.after, refusal.before);
  assert.deepEqual(firstAfterMerge?.capture?.blocked, []);
  assert.deepEqual(firstAfterMerge?.writes, { linear: {}, git: {}, pullRequests: {} });
  for (const outcome of outcomes) if (!(outcome.name in OFFLINE)) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(outcomes.some((outcome) => outcome.name === 'quiet.last' && outcome.ok));
});
