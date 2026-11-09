// The templates rendered for one sandbox run: only the run's isolation
// changes, every other part stays the template's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ACTION_REPOSITORY, DISPATCH_GUARD, pinnedActionSha, prerequisiteErrors, readTemplate, renderForRun, runWorkflows, SANDBOX_RUNNER, WORKFLOW_FILES, workflowFor } from './workflow-files.ts';
import { REPORT_ARTIFACT } from './workflows.ts';

const RUN = {
  trackedBranch: 't/2026-11-09-abc123/main',
  syncBranch: 't/2026-11-09-abc123/sync',
  refPrefix: 'refs/mdbisync-test/2026-11-09-abc123',
  group: 'mdbisync-2026-11-09-abc123',
};
const SHA = 'a'.repeat(40);

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string; with?: Record<string, unknown>; if?: string };
const jobsOf = (text: string) => Object.values((parse(text) as { jobs: Record<string, { 'runs-on': unknown; steps: Step[] }> }).jobs);

describe('workflow templates rendered for a run', () => {
  it('the initial sync: the run\'s group, runner, names, branches and refs, and a report artifact', () => {
    const template = readTemplate(WORKFLOW_FILES['initial-sync']);
    const text = renderForRun(template, { ...RUN, actionSha: SHA });
    const parsed = parse(text) as { concurrency: { group: string; 'cancel-in-progress': boolean }; on: Record<string, unknown> };
    // Dispatches share the run's group; a registering push run has a group of its own, so it never replaces a pending dispatch.
    assert.deepEqual(parsed.concurrency, { group: `\${{ github.event_name == 'push' && format('{0}-register-{1}', '${RUN.group}', github.run_id) || '${RUN.group}' }}`, 'cancel-in-progress': false });
    // Registered by a push to the run's own branch only, which runs no job.
    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch', 'push']);
    assert.deepEqual(parsed.on['push'], { branches: [RUN.trackedBranch] });
    assert.deepEqual(jobsOf(text).map((job) => (job as { if?: string }).if), [DISPATCH_GUARD]);
    assert.deepEqual((parse(template) as { on: Record<string, unknown> }).on['workflow_dispatch'], parsed.on['workflow_dispatch'], 'the dispatch inputs stay the template\'s');
    assert.doesNotMatch(text, /(?:vars|secrets)\.MDBISYNC_/, 'a template name was left');
    assert.match(text, /vars\.SYNC_APP_CLIENT_ID/);
    assert.match(text, /secrets\.LINEAR_TEST_APP_CLIENT_SECRET/);
    const [job] = jobsOf(text);
    assert.deepEqual(job?.['runs-on'], SANDBOX_RUNNER);
    // The stage step gets the run's branches and refs too, and leaves the report to the apply step.
    const stage = job!.steps.find((step) => step.uses?.startsWith(`${ACTION_REPOSITORY}@`))!;
    assert.equal(stage.with?.['security-step'], 'stage');
    assert.equal(stage.with?.['cleanup-tokens'], false);
    assert.equal(stage.uses, `${ACTION_REPOSITORY}@${SHA}`);
    assert.equal(stage.with?.['tracked-branch'], RUN.trackedBranch);
    assert.equal(stage.with?.['report-file'], undefined);
    const index = job!.steps.findLastIndex((step) => step.uses?.startsWith(`${ACTION_REPOSITORY}@`));
    const action = job!.steps[index]!;
    assert.equal(action.with?.['security-step'], 'apply');
    assert.equal(job!.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@')).length, 1);
    assert.equal(action.uses, `${ACTION_REPOSITORY}@${SHA}`);
    assert.equal(action.with?.['tracked-branch'], RUN.trackedBranch);
    assert.equal(action.with?.['sync-branch'], RUN.syncBranch);
    assert.equal(action.with?.['state-ref-prefix'], RUN.refPrefix);
    assert.equal(action.with?.['operation'], 'initial-sync');
    const upload = job!.steps[index + 1]!;
    assert.match(upload.uses ?? '', /^actions\/upload-artifact@[0-9a-f]{40}$/);
    assert.equal(upload.with?.['name'], REPORT_ARTIFACT);
    assert.equal(upload.if, '${{ always() }}');
  });

  it('keeps the template\'s release pin unless a release under test is named', () => {
    const template = readTemplate(WORKFLOW_FILES['initial-sync']);
    const pin = pinnedActionSha(template);
    assert.match(pin, /^[0-9a-f]{40}$/);
    assert.ok(renderForRun(template, RUN).includes(`${ACTION_REPOSITORY}@${pin}`));
  });

  it('limits push and pull request triggers to the run\'s branch', () => {
    const template = 'on:\n  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: "*/5 * * * *"\nconcurrency:\n  group: mdbisync\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps: []\n';
    const parsed = parse(renderForRun(template, RUN)) as { on: Record<string, { branches?: string[] }> };
    assert.deepEqual(parsed.on['push']?.branches, [RUN.trackedBranch]);
    assert.deepEqual(parsed.on['pull_request']?.branches, [RUN.trackedBranch]);
    assert.ok(Array.isArray(parsed.on['schedule']));
  });

  it('registers only dispatch-only templates, keeping a job\'s own condition', () => {
    const dispatchOnly = 'on:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    if: ${{ vars.ENABLED == \'true\' }}\n    steps: []\n  b:\n    runs-on: ubuntu-latest\n    steps: []\n';
    const parsed = parse(renderForRun(dispatchOnly, RUN)) as { on: Record<string, unknown>; jobs: Record<string, { if?: string }> };
    assert.deepEqual(parsed.on['push'], { branches: [RUN.trackedBranch] });
    assert.equal(parsed.jobs['a']?.if, `${DISPATCH_GUARD} && (vars.ENABLED == 'true')`);
    assert.equal(parsed.jobs['b']?.if, DISPATCH_GUARD);
    // A schedule never runs on the run's branch, so it does not register the workflow either.
    const scheduled = parse(renderForRun('on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 * * * *"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n', RUN)) as { on: Record<string, unknown> };
    assert.deepEqual(scheduled.on['push'], { branches: [RUN.trackedBranch] });
    assert.throws(() => renderForRun('on:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    if: ${{ vars.A }} && ${{ vars.B }}\n    steps: []\n', RUN), /not one expression/);
    for (const file of [WORKFLOW_FILES.sync, WORKFLOW_FILES['pre-commit']]) {
      const rendered = parse(renderForRun(readTemplate(file), RUN)) as { on: Record<string, unknown> };
      assert.deepEqual(Object.keys(rendered.on), Object.keys((parse(readTemplate(file)) as { on: Record<string, unknown> }).on), file);
      assert.ok(jobsOf(renderForRun(readTemplate(file), RUN)).every((job) => (job as { if?: string }).if === undefined), file);
    }
  });

  it('reads the prerequisite errors the templates\' install steps report, as log lines', () => {
    const errors = prerequisiteErrors();
    assert.ok(errors.every((error) => error.startsWith('##[error]') && !/['"]/.test(error)));
    assert.ok(errors.some((error) => error.includes('Install Python 3 with venv support')));
    assert.ok(errors.some((error) => error.includes('venv support is required')));
    // A failed install may be a wrong pin or the network: it proves nothing about the runner.
    assert.ok(!errors.some((error) => error.includes('Could not install')), errors.join('\n'));
  });

  it('refuses a secret or variable the sandbox has no name for', () => {
    assert.throws(() => renderForRun('x: ${{ secrets.MDBISYNC_OTHER }}\n', RUN), /no sandbox name for secrets\.MDBISYNC_OTHER/);
  });

  it('the sync: push on the run\'s branch, the schedule and dispatch kept, the run\'s group', () => {
    const text = renderForRun(readTemplate(WORKFLOW_FILES.sync), { ...RUN, actionSha: SHA });
    const parsed = parse(text) as { on: Record<string, { branches?: string[] } | null>; concurrency: { group: string } };
    assert.deepEqual(parsed.on['push'], { branches: [RUN.trackedBranch] });
    assert.ok(Array.isArray(parsed.on['schedule']));
    assert.ok('workflow_dispatch' in parsed.on);
    assert.equal(parsed.concurrency.group, RUN.group);
    const [job] = jobsOf(text);
    const action = job!.steps.find((step) => step.uses?.startsWith(`${ACTION_REPOSITORY}@`));
    assert.equal(action?.with?.['operation'], 'sync');
    assert.equal(action?.with?.['tracked-branch'], RUN.trackedBranch);
  });

  it('wires the known key only into the separate hook step and retains stage/apply', () => {
    for (const file of [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']]) {
      const [job] = jobsOf(renderForRun(readTemplate(file), { ...RUN, securityCanary: true }));
      const steps = job!.steps;
      assert.deepEqual(steps.filter(step => step.uses?.startsWith(ACTION_REPOSITORY)).map(step => step.with?.['security-step']), ['stage', 'apply']);
      assert.deepEqual((parse(renderForRun(readTemplate(file), { ...RUN, securityCanary: true })) as { on: Record<string, unknown> }).on['push'], { branches: [RUN.trackedBranch] });
      assert.equal((job as { if?: string }).if, DISPATCH_GUARD);
      const stage = steps.find(step => step.with?.['security-step'] === 'stage')!;
      assert.ok(stage.env?.['NODE_OPTIONS']?.includes('security-token-observer.mjs'));
      const hook = steps.find(step => step.name === 'Run the security hooks')!;
      assert.equal(hook.env?.['NODE_OPTIONS'], undefined);
      assert.equal(steps.find(step => step.with?.['security-step'] === 'apply')?.env?.['NODE_OPTIONS'], undefined);
      assert.equal(hook.env?.['CANARY_HOOK_KEY'], '${{ secrets.CANARY_HOOK_KEY }}');
      assert.ok(Object.values(hook.env!).every(value => !/LINEAR|app-token/.test(value)));
      const prepare = steps.findIndex(step => step.name === 'Prepare own-run canary comparisons');
      assert.ok(prepare < steps.findIndex(step => step.with?.['security-step'] === 'stage'));
      assert.ok(String(steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.with?.['path']).includes('mdbisync-report'));
    }
  });

  it('renders every template that exists, and finds the workflow of each command', () => {
    const files = runWorkflows(RUN);
    assert.ok(files.has(WORKFLOW_FILES.sync));
    assert.ok(files.has(WORKFLOW_FILES['initial-sync']));
    assert.ok(files.has(WORKFLOW_FILES['pre-commit']));
    assert.deepEqual([...runWorkflows(RUN, [WORKFLOW_FILES['initial-sync'], WORKFLOW_FILES['pre-commit']]).keys()], [WORKFLOW_FILES['initial-sync'], WORKFLOW_FILES['pre-commit']]);
    assert.equal(workflowFor('initial-sync'), 'mdbisync-initial-sync.yml');
    assert.equal(workflowFor('sync'), 'mdbisync.yml');
  });
});
