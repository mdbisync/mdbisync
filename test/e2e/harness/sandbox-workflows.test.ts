// The read of the sandbox's workflows for the settings they read, and the
// format probe's workflow as the sandbox installs it (sandbox-workflows.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  failsRead, FORMAT_PROBE_FILE, formatProbeWorkflow, HARNESS_WORKFLOWS, knownSetting, readSandboxWorkflows, removalRefusal, settingsRead, type WorkflowSource,
} from './sandbox-workflows.ts';
import { readTemplate, renderForRun, renderScheduler, SCHEDULER_FILE, WORKFLOW_FILES } from './workflow-files.ts';

const SHA = 'a'.repeat(40);

describe('the settings a sandbox workflow reads', () => {
  it('finds names in keys and values, never in comments', () => {
    const text = [
      'on: workflow_dispatch',
      '# A comment that names ${{ secrets.IN_A_COMMENT }} reads nothing.',
      'jobs:',
      '  probe:',
      '    if: ${{ vars.GATE != \'\' }}',
      '    steps:',
      '      - env:',
      '          A: ${{ secrets.ONE }}',
      '          B: "${{ vars.TWO }}-${{ secrets.ONE }}"',
      '          # C: ${{ secrets.COMMENTED }}',
      '        run: echo "${{ secrets.GITHUB_TOKEN }}"',
      '',
    ].join('\n');
    assert.deepEqual(settingsRead(text), ['secrets.GITHUB_TOKEN', 'secrets.ONE', 'vars.GATE', 'vars.TWO']);
  });

  it('reads only expressions, outside property paths, whatever the case', () => {
    const text = [
      'jobs:',
      '  a:',
      '    if: vars.ENABLED == \'1\' && steps.vars.outputs.x',
      '    steps:',
      '      - id: vars',
      '        run: |',
      '          cat conf/vars.json secrets.txt',
      '          echo "${{ steps.vars.outputs.sha }} ${{ needs.secrets.outputs.y }} ${{ inputs.secrets }}"',
      '          echo "${{ secrets.github_token }} ${{ SECRETS.Old_Key }}"',
      '',
    ].join('\n');
    assert.deepEqual(settingsRead(text), ['secrets.GITHUB_TOKEN', 'secrets.OLD_KEY', 'vars.ENABLED']);
  });

  it('counts indexed, whole-context and inherited reads', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - env:',
      '          A: ${{ secrets[\'linear_test_app_client_id\'] }}',
      "          B: ${{ vars['x'] }}",
      '          C: ${{ toJSON(secrets) }}',
      '  b:',
      '    uses: ./.github/workflows/other.yml',
      '    secrets: inherit',
      '',
    ].join('\n');
    assert.deepEqual(settingsRead(text), ['secrets.*', 'secrets.LINEAR_TEST_APP_CLIENT_ID', 'vars.X']);
    assert.equal(knownSetting('secrets.*'), false);
    assert.equal(knownSetting('vars.*'), false);
  });

  it('reads nothing in string literals, and finds a read after a literal that holds }}', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      "      - run: echo \"${{ format('Check secrets.OLD') }} ${{ format('}}', secrets.LATER) }} ${{ secrets['it''s'] }}\"",
      '',
    ].join('\n');
    assert.deepEqual(settingsRead(text), ["secrets.IT'S", 'secrets.LATER']);
  });

  it('reads `if:` and `secrets: inherit` only where GitHub does', () => {
    const text = [
      'env:',
      '  if: vars.LITERAL',
      '  secrets: inherit',
      'jobs:',
      '  a:',
      '    env: { if: vars.ALSO_LITERAL, secrets: inherit }',
      '    steps:',
      '      - if: vars.STEP',
      '        name: &condition vars.ANCHORED',
      '      - if: *condition',
      '',
    ].join('\n');
    assert.deepEqual(settingsRead(text), ['vars.ANCHORED', 'vars.STEP']);
  });

  it('refuses a file that is not YAML without quoting it', () => {
    assert.throws(() => settingsRead('jobs: [unclosed private-value\n'), (error: Error) => /not valid YAML: [A-Z_]+ at line \d+$/.test(error.message) && !error.message.includes('private-value'));
  });

  it('compares the whole indexed name', () => {
    assert.equal(knownSetting('secrets.GITHUB_TOKEN.INVALID'), false);
    assert.equal(knownSetting('secrets.GITHUB_TOKEN'), true);
  });

  it('knows the sandbox\'s settings and none of the retired ones', () => {
    for (const setting of ['vars.MDBISYNC_APP_CLIENT_ID', 'vars.MDBISYNC_LINEAR_CLIENT_ID', 'secrets.MDBISYNC_APP_PRIVATE_KEY', 'secrets.MDBISYNC_LINEAR_CLIENT_SECRET', 'secrets.GITHUB_TOKEN'] as const) {
      assert.equal(knownSetting(setting), true, setting);
    }
    for (const setting of ['vars.SYNC_APP_CLIENT_ID', 'secrets.SYNC_APP_PRIVATE_KEY', 'secrets.LINEAR_TEST_APP_CLIENT_ID', 'secrets.LINEAR_TEST_APP_CLIENT_SECRET', 'vars.MDBISYNC_APP_PRIVATE_KEY'] as const) {
      assert.equal(knownSetting(setting), false, setting);
    }
  });

  it('finds only known settings in what the harness installs and renders', () => {
    const texts = [
      renderScheduler(readTemplate(WORKFLOW_FILES.sync), SHA),
      formatProbeWorkflow(),
      ...Object.values(WORKFLOW_FILES).map((file) => renderForRun(readTemplate(file), { trackedBranch: 't/000000/main', syncBranch: 't/000000/sync', refPrefix: 'refs/t/000000', group: 'g', actionSha: SHA, securityCanary: true })),
    ];
    for (const text of texts) {
      const reads = settingsRead(text);
      assert.ok(reads.length > 0);
      assert.deepEqual(reads.filter((setting) => !knownSetting(setting)), []);
    }
  });
});

describe('the format probe\'s workflow in the sandbox', () => {
  it('is the drift workflow as it is here', () => {
    assert.equal(formatProbeWorkflow(), readFileSync(new URL('../../probe/drift-workflow.yml', import.meta.url), 'utf8'));
    assert.equal(FORMAT_PROBE_FILE, 'format-probe.yml');
    assert.deepEqual(HARNESS_WORKFLOWS, [SCHEDULER_FILE, FORMAT_PROBE_FILE]);
  });
});

function source(files: Record<string, string>, registered: string[]): WorkflowSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    directory: async (path) => (path === '.github/workflows' ? Object.keys(files) : undefined),
    fileBlob: async (path) => {
      reads.push(path);
      const name = path.replace('.github/workflows/', '');
      const text = files[name];
      return text === undefined ? undefined : { text, sha: `sha-${name}` };
    },
    workflowPaths: async () => registered,
  };
}

describe('reading every workflow on the default branch', () => {
  const files = {
    [SCHEDULER_FILE]: 'jobs:\n  a:\n    env:\n      K: ${{ secrets.MDBISYNC_APP_PRIVATE_KEY }}\n',
    'old.yml': 'jobs:\n  a:\n    env:\n      K: ${{ secrets.LINEAR_TEST_APP_CLIENT_ID }}\n      V: ${{ vars.MDBISYNC_APP_CLIENT_ID }}\n',
    'hello.yaml': 'jobs:\n  a:\n    steps: []\n',
    'README.md': 'not a workflow ${{ secrets.X }}',
  };

  it('names what each reads and what the sandbox does not provide', async () => {
    const rest = source(files, ['.github/workflows/old.yml', '.github/workflows/elsewhere.yml', 'dynamic/pages/pages-build-deployment']);
    const report = await readSandboxWorkflows(rest);
    assert.deepEqual(report.files, [
      { file: 'hello.yaml', sha: 'sha-hello.yaml', reads: [], unknown: [] },
      { file: SCHEDULER_FILE, sha: `sha-${SCHEDULER_FILE}`, reads: ['secrets.MDBISYNC_APP_PRIVATE_KEY'], unknown: [] },
      { file: 'old.yml', sha: 'sha-old.yml', reads: ['secrets.LINEAR_TEST_APP_CLIENT_ID', 'vars.MDBISYNC_APP_CLIENT_ID'], unknown: ['secrets.LINEAR_TEST_APP_CLIENT_ID'] },
    ]);
    assert.deepEqual(report.files.map(failsRead), [false, false, true]);
    assert.deepEqual(report.elsewhere, ['.github/workflows/elsewhere.yml']);
    assert.equal(rest.reads.includes('.github/workflows/README.md'), false);
  });

  it('reads an empty report when there is no workflow folder', async () => {
    const report = await readSandboxWorkflows({ directory: async () => undefined, fileBlob: async () => undefined, workflowPaths: async () => [] });
    assert.deepEqual(report, { files: [], elsewhere: [] });
  });

  it('reports a file that is not YAML and reads the others', async () => {
    const report = await readSandboxWorkflows(source({ ...files, 'broken.yml': 'jobs: [unclosed\n' }, []));
    const broken = report.files.find((entry) => entry.file === 'broken.yml')!;
    assert.match(broken.error ?? '', /not valid YAML/);
    assert.equal(failsRead(broken), true);
    assert.equal(report.files.length, 4);
    assert.equal(removalRefusal(report, 'broken.yml'), undefined);
  });

  it('removes only a workflow the harness does not install that reads an unknown setting', async () => {
    const report = await readSandboxWorkflows(source({ ...files, [FORMAT_PROBE_FILE]: 'x: ${{ secrets.OLD }}\n' }, []));
    assert.equal(removalRefusal(report, 'old.yml'), undefined);
    assert.match(removalRefusal(report, 'hello.yaml') ?? '', /reads only settings the sandbox provides/);
    assert.match(removalRefusal(report, 'missing.yml') ?? '', /not on the default branch/);
    assert.match(removalRefusal(report, FORMAT_PROBE_FILE) ?? '', /harness's own/);
    assert.match(removalRefusal(report, SCHEDULER_FILE) ?? '', /harness's own/);
  });
});
