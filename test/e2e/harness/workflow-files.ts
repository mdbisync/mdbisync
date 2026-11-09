// The workflow templates of `examples/`, as a deployer copies them, made
// fit for one run in the shared sandbox (actions mode). Only what a run's
// isolation needs changes: the run's branches, state refs and concurrency
// group, the sandbox's runner, its secret and variable names, the release
// under test, and an artifact that carries the engine's report back to the
// harness. A template with no trigger on the run's branch also gets the push
// trigger that registers it, with its jobs guarded to run only on a dispatch
// (renderForRun). Every other line is the template's.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { CANARY_KEY, CANARY_PREPARE } from './security-canary.ts';
import type { CommandName } from '../../../src/commands.ts';
import { PREREQUISITE_STEPS, REPORT_ARTIFACT } from './workflows.ts';

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
export const ACTION_REPOSITORY = 'mdbisync/mdbisync';

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
  securityCanary?: boolean;
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
  // GitHub dispatches a workflow only once it is registered, and a workflow
  // that is not on the default branch is registered only when it runs on
  // another event. A dispatchable template with no trigger on the run's
  // branch therefore also runs on a push to that branch with every job
  // skipped: that run registers it and does nothing else. The registering run
  // gets a group of its own, so it never replaces a pending dispatch of the
  // run's group. The default branch and the repository's settings stay as
  // they are.
  const register = isMap(on) && on.has('workflow_dispatch') && !on.has('push') && !on.has('pull_request');
  if (register) {
    on.set('push', { branches: [options.trackedBranch] });
    const group = doc.getIn(['concurrency', 'group']);
    if (typeof group === 'string') doc.setIn(['concurrency', 'group'], `\${{ github.event_name == 'push' && format('{0}-register-{1}', '${group}', github.run_id) || '${group}' }}`);
  }

  const jobs = doc.get('jobs');
  if (!isMap(jobs)) throw new Error('the template has no jobs');
  for (const pair of jobs.items) {
    const job = pair.value as YAMLMap;
    job.set('runs-on', doc.createNode(SANDBOX_RUNNER));
    if (register) job.set('if', dispatchOnly(job.get('if')));
    patchSteps(doc, job, options);
  }
  return doc.toString({ lineWidth: 0 });
}

/** The condition that keeps a registering push run from running a job. */
export const DISPATCH_GUARD = "github.event_name == 'workflow_dispatch'";

/** A job condition that holds only for a dispatch, keeping the job's own condition. */
function dispatchOnly(condition: unknown): string {
  if (condition === undefined || condition === null) return DISPATCH_GUARD;
  const own = String(condition).replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
  // Several `${{ }}` parts make a string, not one expression the guard can join.
  if (own.includes('${{') || own.includes('}}')) throw new Error(`cannot guard the job condition ${String(condition)}: it is not one expression`);
  return `${DISPATCH_GUARD} && (${own})`;
}

function patchSteps(doc: Document, job: YAMLMap, options: RunWorkflowOptions): void {
  const steps = job.get('steps');
  if (!isSeq(steps)) return;
  const isAction = (item: unknown) => {
    const uses = (item as YAMLMap).get('uses');
    return typeof uses === 'string' && uses.startsWith(`${ACTION_REPOSITORY}@`);
  };
  if (options.securityCanary && steps.items.some(isAction)) {
    const hooks = steps.items.find(item => (item as YAMLMap).get('name') === 'Run the security hooks') as YAMLMap | undefined;
    if (hooks === undefined) throw new Error('Security canary needs a separate hooks step');
    hooks.setIn(['env', CANARY_KEY], '${{ secrets.CANARY_HOOK_KEY }}');
    const stage = steps.items.findIndex(isAction);
    steps.items.splice(stage, 0, doc.createNode({
      name: 'Prepare own-run canary comparisons',
      run: CANARY_PREPARE,
      env: {
        CANARY_LINEAR_SECRET: '${{ secrets.LINEAR_TEST_APP_CLIENT_SECRET }}',
        CANARY_APP_TOKEN: '${{ steps.app-token.outputs.token }}',
      },
    }));
  }
  // The stage step runs before the hooks step; the last action step is the one whose report the harness reads.
  const last = steps.items.findLastIndex(isAction);
  for (let index = 0; index < steps.items.length; index += 1) {
    const step = steps.items[index] as YAMLMap;
    if (!isAction(step)) continue;
    if (options.actionSha !== undefined) step.set('uses', `${ACTION_REPOSITORY}@${options.actionSha}`);
    if (!isMap(step.get('with'))) step.set('with', doc.createNode({}));
    const inputs = step.get('with') as YAMLMap;
    // Workers share this app; a run's concurrency group does not own it.
    inputs.set('cleanup-tokens', false);
    inputs.set('tracked-branch', options.trackedBranch);
    inputs.set('sync-branch', options.syncBranch);
    inputs.set('state-ref-prefix', options.refPrefix);
    if (index !== last) continue;
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

let knownPrerequisiteErrors: string[] | undefined;

/**
 * The errors the templates' prerequisite steps report when the runner lacks
 * what they need (`echo '::error::…'` in the step's script), as GitHub writes
 * them to the step's log. A failed install ("Could not install …") is left
 * out: a wrong pin or a passing network failure gives it too, so it proves
 * nothing about the runner.
 */
export function prerequisiteErrors(): string[] {
  knownPrerequisiteErrors ??= readPrerequisiteErrors().filter((error) => !error.startsWith('##[error]Could not install'));
  return knownPrerequisiteErrors;
}

function readPrerequisiteErrors(): string[] {
  const errors = new Set<string>();
  for (const file of Object.values(WORKFLOW_FILES)) {
    if (!existsSync(join(EXAMPLES, file))) continue;
    const jobs = (parseDocument(readTemplate(file)).toJS() as { jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }> }).jobs ?? {};
    for (const step of Object.values(jobs).flatMap((job) => job.steps ?? [])) {
      if (step.name === undefined || !PREREQUISITE_STEPS.has(step.name)) continue;
      for (const match of (step.run ?? '').matchAll(/::error::([^'"\n]+)/g)) errors.add(`##[error]${(match[1] as string).trim()}`);
    }
  }
  return [...errors];
}

/** The templates that exist (of `only`, when given), rendered for one run, by their `.github/workflows/` file name. */
export function runWorkflows(options: RunWorkflowOptions, only?: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of only ?? Object.values(WORKFLOW_FILES)) {
    if (existsSync(join(EXAMPLES, file))) files.set(file, renderForRun(readTemplate(file), options));
  }
  return files;
}
