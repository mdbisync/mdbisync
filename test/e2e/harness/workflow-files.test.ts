// The templates rendered for one sandbox run: only the run's isolation
// changes, every other part stays the template's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ACTION_REPOSITORY, pinnedActionSha, readTemplate, renderForRun, runWorkflows, SANDBOX_RUNNER, WORKFLOW_FILES, workflowFor } from './workflow-files.ts';
import { REPORT_ARTIFACT } from './workflows.ts';

const RUN = {
  trackedBranch: 't/2026-11-09-abc123/main',
  syncBranch: 't/2026-11-09-abc123/sync',
  refPrefix: 'refs/mdbisync-test/2026-11-09-abc123',
  group: 'mdbisync-2026-11-09-abc123',
};
const SHA = 'a'.repeat(40);

type Step = { uses?: string; with?: Record<string, unknown>; if?: string };
const jobsOf = (text: string) => Object.values((parse(text) as { jobs: Record<string, { 'runs-on': unknown; steps: Step[] }> }).jobs);

describe('workflow templates rendered for a run', () => {
  it('the initial sync: the run\'s group, runner, names, branches and refs, and a report artifact', () => {
    const template = readTemplate(WORKFLOW_FILES['initial-sync']);
    const text = renderForRun(template, { ...RUN, actionSha: SHA });
    const parsed = parse(text) as { concurrency: { group: string; 'cancel-in-progress': boolean }; on: Record<string, unknown> };
    assert.deepEqual(parsed.concurrency, { group: RUN.group, 'cancel-in-progress': false });
    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch']);
    assert.doesNotMatch(text, /(?:vars|secrets)\.MDBISYNC_/, 'a template name was left');
    assert.match(text, /vars\.SYNC_APP_CLIENT_ID/);
    assert.match(text, /secrets\.LINEAR_TEST_APP_CLIENT_SECRET/);
    const [job] = jobsOf(text);
    assert.deepEqual(job?.['runs-on'], SANDBOX_RUNNER);
    const index = job!.steps.findIndex((step) => step.uses?.startsWith(`${ACTION_REPOSITORY}@`));
    const action = job!.steps[index]!;
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

  it('refuses a secret or variable the sandbox has no name for', () => {
    assert.throws(() => renderForRun('x: ${{ secrets.MDBISYNC_OTHER }}\n', RUN), /no sandbox name for secrets\.MDBISYNC_OTHER/);
  });

  it('renders every template that exists, and finds the workflow of each command', () => {
    const files = runWorkflows(RUN);
    assert.ok(files.has(WORKFLOW_FILES['initial-sync']));
    assert.ok(files.has(WORKFLOW_FILES['pre-commit']));
    assert.equal(workflowFor('initial-sync'), 'mdbisync-initial-sync.yml');
    assert.equal(workflowFor('sync'), 'mdbisync.yml');
  });
});
