import assert from 'node:assert/strict';
import { it } from 'node:test';
import { collectCanaryEvidence } from './checks.ts';
import { retainPendingOutput } from './runner.ts';
import type { RunContext } from './context.ts';

it('keeps stdout and stderr from a pending failed engine before the snapshot', async () => {
  let killed = false;
  let resumed = false;
  const ctx = {
    live: null, observations: new Map(),
    checkpoints: { resumeAll: () => { resumed = true; } },
    engine: { results: [], pending: {
      kill: () => { killed = true; },
      done: Promise.resolve({ stdout: 'kx-pending-canary', stderr: 'diagnostic', summary: '' }),
    } },
  } as unknown as RunContext;
  await retainPendingOutput(ctx);
  const evidence = await collectCanaryEvidence(ctx, { summariesOnly: false });
  assert.equal(killed && resumed, true);
  assert.equal(ctx.engine.pending, undefined);
  assert.equal(evidence.texts['run 0 stdout'], 'kx-pending-canary');
  assert.equal(evidence.texts['run 0 stderr'], 'diagnostic');
});
