// The workflow templates of `examples/`, as a deployer copies them, made
// fit for one run in the shared sandbox (actions mode). Only what a run's
// isolation needs changes: the run's branches, state refs and concurrency
// group, the sandbox's runner, its secret and variable names, the release
// under test, and an artifact that carries the engine's report back to the
// harness. Every other line is the template's.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import type { CommandName } from '../../../src/commands.ts';
import { REPORT_ARTIFACT } from './workflows.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));

/** Where each workflow goes in `.github/workflows/`, and its template in `examples/`. */
export const WORKFLOW_FILES = {
  sync: 'mdbisync.yml',
  'initial-sync': 'mdbisync-initial-sync.yml',
  'pre-commit': 'pre-commit.yml',
} as const;

/** The workflow file that runs a command. */
export function workflowFor(command: CommandName): string {
  return command === 'initial-sync' ? WORKFLOW_FILES['initial-sync'] : WORKFLOW_FILES.sync;
}

/** The action's repository in the templates' `uses:`. */
export const ACTION_REPOSITORY = 'mikhail-yaskou/mdbisync';

/** The templates' secret and variable names, and the sandbox's. */
export const SANDBOX_NAMES: Readonly<Record<string, string>> = {
  'vars.MDBISYNC_APP_CLIENT_ID': 'vars.SYNC_APP_CLIENT_ID',
  'secrets.MDBISYNC_APP_PRIVATE_KEY': 'secrets.SYNC_APP_PRIVATE_KEY',
  'secrets.MDBISYNC_LINEAR_CLIENT_ID': 'secrets.LINEAR_TEST_APP_CLIENT_ID',
  'secrets.MDBISYNC_LINEAR_CLIENT_SECRET': 'secrets.LINEAR_TEST_APP_CLIENT_SECRET',
};

export const SANDBOX_RUNNER = ['self-hosted', 'mdbisync-sandbox'];

const REPORT_DIR = '${{ runner.temp }}/mdbisync-report';

export interface RunWorkflowOptions {
  trackedBranch: string;
  syncBranch: string;
  refPrefix: string;
  /** The run's own concurrency group, in place of the templates' shared one. */
  group: string;
  /** The release commit under test; the template's pin when absent. */
  actionSha?: string;
}

export function readTemplate(file: string): string {
  return readFileSync(join(EXAMPLES, file), 'utf8');
}

/** The release commit a template pins the action to. */
export function pinnedActionSha(template: string): string {
  const match = new RegExp(`uses: ${ACTION_REPOSITORY}@([0-9a-f]{40})\\b`).exec(template);
  if (match === null) throw new Error(`the template does not pin ${ACTION_REPOSITORY} to a commit`);
  return match[1] as string;
}

/** A template rendered for one run. */
export function renderForRun(template: string, options: RunWorkflowOptions): string {
  let text = template;
  for (const [ours, theirs] of Object.entries(SANDBOX_NAMES)) text = text.split(ours).join(theirs);
  const leftover = /\b(?:vars|secrets)\.MDBISYNC_[A-Z0-9_]+/.exec(text);
  if (leftover !== null) throw new Error(`no sandbox name for ${leftover[0]}`);

  const doc = parseDocument(text);
  const on = doc.get('on') as YAMLMap | undefined;
  for (const event of ['push', 'pull_request']) {
    if (on?.has(event) !== true) continue;
    // A run's events are its own branch's, never another run's.
    const trigger = on.get(event);
    if (isMap(trigger)) trigger.set('branches', [options.trackedBranch]);
    else on.set(event, { branches: [options.trackedBranch] });
  }
  if (doc.getIn(['concurrency', 'group']) === 'mdbisync') doc.setIn(['concurrency', 'group'], options.group);

  const jobs = doc.get('jobs');
  if (!isMap(jobs)) throw new Error('the template has no jobs');
  for (const pair of jobs.items) {
    const job = pair.value as YAMLMap;
    job.set('runs-on', doc.createNode(SANDBOX_RUNNER));
    patchSteps(doc, job, options);
  }
  return doc.toString({ lineWidth: 0 });
}

function patchSteps(doc: Document, job: YAMLMap, options: RunWorkflowOptions): void {
  const steps = job.get('steps');
  if (!isSeq(steps)) return;
  for (let index = 0; index < steps.items.length; index += 1) {
    const step = steps.items[index] as YAMLMap;
    const uses = step.get('uses');
    if (typeof uses !== 'string' || !uses.startsWith(`${ACTION_REPOSITORY}@`)) continue;
    if (options.actionSha !== undefined) step.set('uses', `${ACTION_REPOSITORY}@${options.actionSha}`);
    if (!isMap(step.get('with'))) step.set('with', doc.createNode({}));
    const inputs = step.get('with') as YAMLMap;
    inputs.set('tracked-branch', options.trackedBranch);
    inputs.set('sync-branch', options.syncBranch);
    inputs.set('state-ref-prefix', options.refPrefix);
    inputs.set('report-file', `${REPORT_DIR}/report.json`);
    steps.items.splice(index + 1, 0, doc.createNode({
      name: 'Keep the report for the harness',
      if: '${{ always() }}',
      uses: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
      with: { name: REPORT_ARTIFACT, path: REPORT_DIR, 'if-no-files-found': 'ignore', 'retention-days': 3 },
    }));
    index += 1;
  }
}

/** The templates that exist (of `only`, when given), rendered for one run, by their `.github/workflows/` file name. */
export function runWorkflows(options: RunWorkflowOptions, only?: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of only ?? Object.values(WORKFLOW_FILES)) {
    if (existsSync(join(EXAMPLES, file))) files.set(file, renderForRun(readTemplate(file), options));
  }
  return files;
}
