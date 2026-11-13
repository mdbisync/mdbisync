// L5-18 (a sync branch deleted by a person) with its live steps and
// assertions on fake services. GitHub closes a pull request whose head branch
// is deleted; the fake keeps it open, so the deletion step closes it here.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fetchRef } from './checks.ts';
import type { RunContext } from './context.ts';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { INVARIANTS, loadScenarios } from './spec.ts';
import { runStep } from './steps.ts';
import type { FakeWorld } from '../../../src/setup/test-helpers.ts';

type Report = Record<string, any>;

it('L5-18: a sync branch deleted while its pull request waits comes back at linear with a new pull request', { timeout: 180_000 }, async (t) => {
  const scenario = loadScenarios().find((s) => s.id === 'L5-18')!;
  let world: FakeWorld | undefined;
  let deleted: { tip: string | null; open: number } | undefined;
  const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
    prepare: (w) => { world = w; },
    steps: {
      'git.delete-sync-branch': async (ctx, args) => {
        // The precondition: the branch is the head of an open pull request that holds a capture.
        const tip = await fetchRef(await ctx.person(), `refs/heads/${ctx.names.syncBranch}`);
        const open = world!.github.pullRequests.filter((pr) => pr.state === 'open' && pr.head === ctx.names.syncBranch);
        deleted = { tip, open: open.length };
        await runStep(ctx, { kind: 'git', action: 'delete-sync-branch', args });
        for (const pr of open) pr.state = 'closed';
      },
    },
    inspect: async (ctx: RunContext) => {
      const end = ctx.observations.get('scenario.runsEnd') as number;
      const own = ctx.engine.results.slice(ctx.engine.setupRuns, end).map((result) => result.report as Report);
      assert.ok(own.length >= 3, `${own.length} runs`);
      assert.equal(own[0]?.['pullRequest']?.pullRequest?.opened, true, 'the first sync opens the sync pull request');
      assert.equal(own[1]?.['pullRequest']?.pullRequest?.opened, true, 'the sync after the deletion opens a new one');
    },
  });
  assert.ok(deleted?.tip, 'the scenario deletes a sync branch that exists');
  assert.equal(deleted?.open, 1, 'the deleted branch is the head of an open pull request');
  const names = new Set(outcomes.map((outcome) => outcome.name));
  for (const name of [...INVARIANTS, 'syncBranch.recreatedFrom']) assert.ok(names.has(name), `${name} ran`);
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

it('L5-18 without a pending capture: on a setup converged by initial sync no sync branch is made, and the subject fails', { timeout: 180_000 }, async (t) => {
  // The scenario's steps before it had a Linear edit: the engine has no use for the branch.
  const base = loadScenarios().find((s) => s.id === 'L5-18')!;
  const deletion = base.steps.findIndex((step) => step.kind === 'git' && step.action === 'delete-sync-branch');
  const scenario = { ...base, steps: base.steps.slice(deletion, deletion + 2) };
  assert.deepEqual(scenario.steps.map((step) => `${step.kind}.${step.action}`), ['git.delete-sync-branch', 'run.sync']);
  let after: string | null = 'unread';
  const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
    inspect: async (ctx: RunContext) => { after = await fetchRef(await ctx.person(), `refs/heads/${ctx.names.syncBranch}`); },
  });
  assert.equal(after, null, 'no run made a sync branch');
  const recreated = outcomes.find((outcome) => outcome.name === 'syncBranch.recreatedFrom');
  assert.equal(recreated?.ok, false, JSON.stringify(recreated));
});
