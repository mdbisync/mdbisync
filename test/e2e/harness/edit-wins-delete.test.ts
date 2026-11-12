// L3-15 (deleted in git, edited in Linear) with its live steps and
// assertions on fake services. The fake Linear drops a final newline, as the
// format probe measured (fixture construct-singles/final-newline), so the
// editor's sent text and Linear's stored text differ as they do live.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { differingValue, evaluateAssertion } from './checks.ts';
import type { RunContext } from './context.ts';
import { runOnFakeServices } from './fake-services.ts';
import { ProductError } from './results.ts';
import { loadScenarios } from './spec.ts';
import { resolveSubject } from './subjects.ts';

const scenario = loadScenarios().find((s) => s.id === 'L3-15')!;
// In Linear's form, as the corpus files are: no final newline.
const documents = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`eng/notes/item-${i}.md`, `# Notes ${i}\n\nFirst paragraph.\n\nSecond paragraph.`]));

it('L3-15: the Linear edit wins over the git deletion, with the live steps and assertions on fake services', { timeout: 180_000 }, async (t) => {
  const outcomes = await runOnFakeServices(t, scenario, documents, {
    prepare: (world) => { world.linear.store = (content) => content.replace(/\n+$/, ''); },
    inspect: async (ctx) => {
      // The decision is in the run that met the conflict; the run that restores the file reports no code of its own.
      // The scenario's own runs: after setup, before the checks' own runs (I6).
      const runs = ctx.engine.results.slice(ctx.engine.setupRuns, ctx.observations.get('scenario.runsEnd') as number);
      assert.deepEqual(runs.map((run) => (run.report?.['sync'] as { decided: Array<{ summary: { code: string } }> }).decided.map((entry) => entry.summary.code)).filter((codes) => codes.length > 0), [['edit-wins-delete']]);
      assert.equal(runs.at(-1)?.report?.['code'], null);
      // The checks the live batch failed on, with the failure details they now give.
      assert.deepEqual(await evaluateAssertion(ctx, { subject: 'summary.code', operator: 'equal', expected: 'edit-wins-delete' }), { holds: false, reason: 'equal did not hold: actual null' });
      assert.deepEqual(await evaluateAssertion(ctx, { subject: 'tracked.body', operator: 'same-as', expected: 'edited.linearBody' }), { holds: false, reason: 'same-as did not hold: only the line breaks at the end differ (actual ends "", expected "\\n")' });
    },
  });
  const names = new Set(outcomes.map((outcome) => outcome.name));
  for (const name of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'tracked.body', 'pullRequests.restoredPath', 'decided.code']) assert.ok(names.has(name), `${name} ran`);
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

it('decided.code reads the deciding run, under the moved path for a rename, and fails when no run decided the target', async () => {
  const run = (decided: Array<{ path: string; code: string }>) => ({ report: { code: null, sync: { decided: decided.map(({ path, code }) => ({ path, summary: { code, text: '' } })) } } });
  const context = (observations: Record<string, unknown>, decided: Array<Array<{ path: string; code: string }>>) => ({
    engine: { results: [run([]), ...decided.map(run)], setupRuns: 1 },
    observations: new Map<string, unknown>(Object.entries(observations)),
  }) as unknown as RunContext;
  const code = async (ctx: RunContext) => (await resolveSubject(ctx, 'decided.code')).value;
  assert.equal(await code(context({ 'target.path': 'a.md' }, [[], [{ path: 'a.md', code: 'edit-wins-delete' }], []])), 'edit-wins-delete');
  assert.equal(await code(context({ 'target.path': 'a.md', 'git.moved': { from: 'a.md', to: 'b/a.md' } }, [[{ path: 'b/a.md', code: 'rename-and-edit' }]])), 'rename-and-edit');
  await assert.rejects(code(context({ 'target.path': 'a.md' }, [[{ path: 'other.md', code: 'edit-wins-delete' }]])), ProductError);
  await assert.rejects(code(context({ 'target.path': 'a.md' }, [[{ path: 'a.md', code: 'edit-wins-delete' }], [{ path: 'a.md', code: 'delete-wins' }]])), /different rules/);
});

it('a failed comparison names a code, flag or count, and where two texts differ without their content', () => {
  assert.equal(differingValue('edit-wins-rename', 'edit-wins-delete', true), 'actual "edit-wins-rename"');
  assert.equal(differingValue(null, 'edit-wins-delete', true), 'actual null');
  assert.equal(differingValue(3, 2, false), 'actual 3');
  // A one-word text that is not a code is a document's text: only where it differs.
  assert.equal(differingValue('confidential', 'other', false), 'the texts first differ at line 1 (actual has 1 lines, expected 1)');
  assert.equal(differingValue('# A\n\nsecret text\n', '# A\n\nother text', false), 'the texts first differ at line 3 (actual has 3 lines, expected 3)');
  assert.equal(differingValue({ a: 1 }, { a: 2 }, false), undefined);
});
