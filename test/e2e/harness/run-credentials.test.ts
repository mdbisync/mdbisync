import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recordRefs, REF_HISTORY_TIMES, startRefHistory } from './checks.ts';
import type { RunContext } from './context.ts';
import { runNames } from './isolation.ts';
import { appTokenClientIds, workflowWriteCredentials } from './run-credentials.ts';
import { readTemplate, renderScheduler, runGroup, runWorkflows, WORKFLOW_FILES } from './workflow-files.ts';

const names = runNames('aaaaaa');
const options = { trackedBranch: names.trackedBranch, syncBranch: names.syncBranch, refPrefix: names.refPrefix, group: runGroup(names.runId), actionSha: 'c'.repeat(40) };

describe('what a workflow run can write with', () => {
  it('find no other credential in the sync and initial sync workflows the harness renders, with and without the canary', () => {
    for (const securityCanary of [false, true]) {
      const files = runWorkflows({ ...options, securityCanary }, [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']]);
      assert.equal(files.size, 2);
      for (const [file, text] of files) assert.deepEqual(workflowWriteCredentials(text), [], file);
    }
  });

  it('name the scheduled workflow\'s request job, whose own token writes contents', () => {
    assert.deepEqual(workflowWriteCredentials(renderScheduler(readTemplate(WORKFLOW_FILES.sync), 'c'.repeat(40))), ['lets job "request" write contents with the job\'s own token']);
  });

  it('read permissions per job, a job\'s own taking the place of the workflow\'s', () => {
    const job = (permissions: string) => `on: push\n${permissions}jobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    assert.deepEqual(workflowWriteCredentials(job('permissions: {}\n')), []);
    assert.deepEqual(workflowWriteCredentials(job('permissions: read-all\n')), []);
    assert.deepEqual(workflowWriteCredentials(job('permissions:\n  contents: read\n  pull-requests: write\n')), []);
    assert.deepEqual(workflowWriteCredentials(job('permissions: write-all\n')), ['lets job "sync" write contents with the job\'s own token']);
    assert.deepEqual(workflowWriteCredentials(job('')), ['gives job "sync" the repository\'s default token permissions']);
    const own = 'on: push\npermissions: {}\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: echo\n';
    assert.deepEqual(workflowWriteCredentials(own), ['lets job "sync" write contents with the job\'s own token']);
    assert.deepEqual(workflowWriteCredentials('on: push\njobs: {}\n'), ['has no jobs']);
    assert.deepEqual(workflowWriteCredentials('jobs: [\n'), ['is not a workflow GitHub can read']);
  });

  it('read secrets only in expressions GitHub evaluates, never in comments or a script\'s own words', () => {
    const steps = (lines: string) => `on: push\npermissions: {}\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps:\n${lines}`;
    assert.deepEqual(workflowWriteCredentials(steps('      # token: ${{ secrets.PERSONAL_TOKEN }}\n      - run: echo "no secrets here"\n')), []);
    assert.deepEqual(workflowWriteCredentials(steps('      - run: echo\n        env:\n          KEY: ${{ secrets.SYNC_APP_PRIVATE_KEY }}\n')), []);
    assert.deepEqual(workflowWriteCredentials(steps('      - run: echo\n        env:\n          TOKEN: ${{ secrets . PERSONAL_TOKEN }}\n')), ['hands a job the secret PERSONAL_TOKEN']);
    assert.deepEqual(workflowWriteCredentials(steps('      - run: echo\n        env:\n          ALL: ${{ toJSON(secrets) }}\n')), ['hands a job the whole secrets context']);
    assert.deepEqual(workflowWriteCredentials(steps("      - run: echo\n        env:\n          ONE: ${{ secrets['PERSONAL_TOKEN'] }}\n")), ['hands a job the whole secrets context']);
    // GitHub reads context and secret names in any case.
    assert.deepEqual(workflowWriteCredentials(steps('      - run: echo\n        env:\n          TOKEN: ${{ SECRETS.PERSONAL_TOKEN }}\n')), ['hands a job the secret PERSONAL_TOKEN']);
    assert.deepEqual(workflowWriteCredentials(steps('      - run: echo\n        env:\n          KEY: ${{ Secrets.sync_app_private_key }}\n')), []);
  });

  it('name a job that calls a reusable workflow, whose own jobs and secrets the file does not show', () => {
    const called = 'on: push\npermissions: {}\njobs:\n  sync:\n    uses: ./.github/workflows/inner.yml\n    secrets: inherit\n';
    assert.deepEqual(workflowWriteCredentials(called), ['calls a reusable workflow in job "sync"']);
  });
});

describe('the App token steps in a run\'s logs', () => {
  const at = '2026-11-13T12:59:01.1234567Z ';
  it('read each App token step\'s client id as the runner logged its inputs, and nothing from other steps', () => {
    const log = [
      `${at}##[group]Run actions/checkout@abc`, `${at}with:`, `${at}  client-id: not-a-token-step`, `${at}##[endgroup]`,
      `${at}##[group]Run actions/create-github-app-token@64ab`, `${at}with:`, `${at}  client-id: Iv23liOne`, `${at}  private-key: ***`, `${at}##[endgroup]`,
      '##[group]Run actions/create-github-app-token@64ab', 'with:', '  private-key: ***', '##[endgroup]',
    ].join('\r\n');
    assert.deepEqual(appTokenClientIds([log, `${at}##[group]Run actions/create-github-app-token@64ab\n${at}  client-id: Iv23liTwo\n${at}##[endgroup]\n`]), ['Iv23liOne', '', 'Iv23liTwo']);
    assert.deepEqual(appTokenClientIds(['no groups at all']), []);
  });
});

describe('the ref history\'s times', () => {
  it('note beside each snapshot when the harness began to read it, starting afresh', async () => {
    const observations = new Map<string, unknown>([['refHistory', [{ old: 'x' }]], [REF_HISTORY_TIMES, [9]]]);
    const ctx = { live: null, names, observations } as unknown as RunContext;
    const before = Date.now();
    await startRefHistory(ctx);
    await recordRefs(ctx);
    assert.deepEqual(observations.get('refHistory'), [{}, {}]);
    const times = observations.get(REF_HISTORY_TIMES) as number[];
    assert.equal(times.length, 2);
    assert.ok(before <= times[0]! && times[0]! <= times[1]! && times[1]! <= Date.now());
  });
});
