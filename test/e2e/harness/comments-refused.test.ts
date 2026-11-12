// suspended.commentsRefused: Linear refused to resolve each held document's
// suspension comment once, the comment stayed open, and no later run of the
// scenario reported hold work.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { HOLD_FAILED } from '../../../src/sync/hold.ts';
import type { RunContext } from './context.ts';
import { BEFORE_VIEW, SUBJECTS } from './subjects.ts';

const PATH = 'docs/a.md';
const REFUSAL = { path: PATH, error: 'LinearGraphQLError INPUT_ERROR HTTP 200' };
const COMMENT = `${HOLD_FAILED}\n\n- Check \`format\`.`;

type Marks = Record<string, unknown> | undefined;

async function refused(runs: Marks[], resolvedAt: string | null = null): Promise<unknown> {
  const before = { ids: new Map([[PATH, { id: 'doc' }]]) };
  const now = { holdComments: new Map([['doc', [{ id: 'c1', body: COMMENT, resolvedAt }]]]) };
  const ctx = {
    observations: new Map<string, unknown>([[BEFORE_VIEW, before], ['suspended.documents', new Set(['doc'])]]),
    engine: { setupRuns: 1, results: [{ report: {} }, ...runs.map((holdMarks) => ({ report: { pullRequest: holdMarks === undefined ? {} : { holdMarks } } }))] },
  } as unknown as RunContext;
  const env = { ctx, which: 'now' as const, view: async () => now } as unknown as Parameters<(typeof SUBJECTS)[string]>[0];
  return SUBJECTS['suspended.commentsRefused']!(env);
}

const released = { set: [], updated: [], cleared: [], deferred: 0, removed: [], unresolved: [REFUSAL] };

it('holds when the release names the document once with Linear\'s refusal and later runs report no hold work', async () => {
  assert.equal(await refused([{ set: [PATH] }, released, undefined, undefined]), true);
});

it('fails when the comment was resolved, when no run reported the refusal, or when the error is not Linear\'s refusal', async () => {
  assert.equal(await refused([{ set: [PATH] }, released, undefined], '2026-11-12T00:00:00Z'), false);
  assert.equal(await refused([{ set: [PATH] }, { cleared: [PATH] }, undefined]), false);
  assert.equal(await refused([{ set: [PATH] }, { ...released, unresolved: [{ path: PATH, error: 'LinearHttpError HTTP 502' }] }, undefined]), false);
});

it('fails when the document is named twice, a later run reports hold work, or no run follows the refusal', async () => {
  assert.equal(await refused([{ ...released, unresolved: [REFUSAL, REFUSAL] }, undefined]), false);
  assert.equal(await refused([released, released, undefined]), false);
  assert.equal(await refused([released, { code: 'write-failed' }]), false);
  assert.equal(await refused([released]), false);
});
