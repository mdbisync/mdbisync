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
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { CANARY_TOKEN_OBSERVER_FILE, CANARY_ENABLED, CANARY_HOOK_STEP, CANARY_KEY, CANARY_PREPARE, CANARY_PREPARE_STEP } from './security-canary.ts';
import type { CommandName } from '../../../src/commands.ts';
import { runNames } from './isolation.ts';
import { PREREQUISITE_STEPS, REPORT_ARTIFACT } from './workflows.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));

/** Where each workflow goes in `.github/workflows/`, and its template in `examples/`. */
export const WORKFLOW_FILES = {
  sync: 'mdbisync.yml',
  'initial-sync': 'mdbisync-initial-sync.yml',
  'pre-commit': 'pre-commit.yml',
} as const;

/** A run's own concurrency group, in place of the templates' shared one. */
export function runGroup(runId: string): string {
  return `mdbisync-${runId}`;
}

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
  /**
   * The release commit under test; the template's pin when absent. Absent
   * only offline: every live caller passes `requiredActionSha()` (steps.ts),
   * since the pin can be an older release than the templates' inputs.
   */
  actionSha?: string;
  securityCanary?: boolean;
  /** A timed soak runs sync only on scheduler ticks, so edits do not start extra syncs. */
  scheduledOnly?: boolean;
}

export function readTemplate(file: string): string {
  return readFileSync(join(EXAMPLES, file), 'utf8');
}

/** Whether a step's `uses` is the action, at any ref. */
export function isActionUses(uses: unknown): boolean {
  return typeof uses === 'string' && uses.startsWith(`${ACTION_REPOSITORY}@`);
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
  if ((options.securityCanary || options.scheduledOnly) && isMap(on) && isMap(doc.getIn(['jobs', 'sync']))) {
    // These drivers observe requested runs only; pushes register the workflow with no job.
    on.delete('push');
    on.delete('schedule');
  }
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
  return guarded(DISPATCH_GUARD, condition);
}

/** `guard` and a job's own condition, when it has one. */
function guarded(guard: string, condition: unknown): string {
  if (condition === undefined || condition === null) return guard;
  const own = String(condition).replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
  // Several `${{ }}` parts make a string, not one expression the guard can join.
  if (own.includes('${{') || own.includes('}}')) throw new Error(`cannot guard the job condition ${String(condition)}: it is not one expression`);
  return `${guard} && (${own})`;
}

// --- the scheduled sync -------------------------------------------------------
//
// GitHub starts a scheduled workflow only from the default branch, and a
// run's branches never are. The sandbox's default branch therefore holds one
// scheduled workflow, rendered from the sync template: on each tick its
// `request` job takes one run's request (the branch t/<run>/schedule, which
// it deletes, so a request is served once) and its sync jobs run the
// template's steps for that run's branches, state refs and concurrency group.
// A tick without a request runs only the `request` job. A dispatch of the
// workflow on the default branch is a tick by hand: the same jobs, under its
// own event (steps.ts, scheduleTick). The workflow is
// installed once, by hand (`cli.ts scheduler --install`); a run never changes
// the default branch, and refuses to ask a scheduled workflow that is not
// this template's rendering for the release under test.

/** The scheduled workflow's file on the sandbox's default branch. */
export const SCHEDULER_FILE = 'mdbisync-scheduled.yml';

/** The scheduled workflow's own concurrency group: one tick at a time, the newest waiting. */
export const SCHEDULER_GROUP = 'mdbisync-scheduled';

/** The scheduled workflow's first job, which takes a request. */
export const REQUEST_JOB = 'request';

/** A request job output, as an expression in the sync jobs. */
function requested(output: string): string {
  return `\${{ needs.${REQUEST_JOB}.outputs.${output} }}`;
}

/** The name of a sync job of the scheduled workflow that serves run `runId`. */
export function scheduledJobName(job: string, runId: string): string {
  return `${job} ${runId}`;
}

/**
 * The request job's script: takes the first request whose run still has its
 * tracked branch and writes that run's names to the job's outputs. The run's
 * names are runNames' and runGroup's, with the run id as `$run`.
 */
export function requestScript(): string {
  const placeholder = '000000';
  const names = runNames(placeholder);
  const named = (value: string) => value.split(placeholder).join('$run');
  const [requestHead, requestTail] = names.scheduleRequest.split(placeholder) as [string, string];
  return [
    'set -euo pipefail',
    'auth="AUTHORIZATION: basic $(printf \'x-access-token:%s\' "$TOKEN" | base64 | tr -d \'\\n\')"',
    'remote() { git -c http.extraheader="$auth" "$@"; }',
    '# A push needs a repository; nothing is fetched into it.',
    'git init --quiet "$RUNNER_TEMP/requests"',
    'cd "$RUNNER_TEMP/requests"',
    `refs=$(remote ls-remote --refs "$REMOTE" 'refs/heads/${requestHead}*' | awk '{print $2}')`,
    `for run in $(printf '%s\\n' "$refs" | sed -n 's|^refs/heads/${requestHead}\\([0-9a-f]\\{6\\}\\)${requestTail}$|\\1|p'); do`,
    '  # The deletion that succeeds takes the request: each is served once.',
    `  if ! out=$(remote push --quiet "$REMOTE" ":refs/heads/${named(names.scheduleRequest)}" 2>&1); then`,
    '    # Only a request another tick took is skipped; any other failure (a rule, the token) fails the job.',
    '    case "$out" in *"remote ref does not exist"*) continue ;; esac',
    '    printf \'%s\\n\' "$out" >&2',
    '    exit 1',
    '  fi',
    '  # A request of a run whose branch is gone is dropped.',
    `  printf '%s\\n' "$refs" | grep -qx "refs/heads/${named(names.trackedBranch)}" || continue`,
    '  {',
    '    echo "run=$run"',
    `    echo "tracked-branch=${named(names.trackedBranch)}"`,
    `    echo "sync-branch=${named(names.syncBranch)}"`,
    `    echo "state-ref-prefix=${named(names.refPrefix)}"`,
    `    echo "group=${named(runGroup(placeholder))}"`,
    '  } >> "$GITHUB_OUTPUT"',
    '  echo "Took the request of $run."',
    '  exit 0',
    'done',
    'echo "No request."',
    '',
  ].join('\n');
}

const SCHEDULER_HEADER = [
  ` The sync template, rendered for the test repository's default branch: the`,
  ` only branch GitHub starts a schedule from. Each tick the request job takes`,
  ` one run's request (its branch t/<run>/schedule) and the sync job runs the`,
  ` template's steps on that run's branches. Generated; install with the`,
  ` harness's \`scheduler --install\`, never edit it by hand.`,
].join('\n');

/** The sync template rendered as the sandbox's scheduled workflow, for the release `actionSha` (the template's pin when absent; live callers always name it). */
export function renderScheduler(template: string, actionSha?: string): string {
  const rendered = renderForRun(template, {
    trackedBranch: requested('tracked-branch'),
    syncBranch: requested('sync-branch'),
    refPrefix: requested('state-ref-prefix'),
    group: SCHEDULER_GROUP,
    ...(actionSha === undefined ? {} : { actionSha }),
  });
  const doc = parseDocument(rendered);
  // The template's own header says where a deployer copies it; this file's says what it is.
  doc.commentBefore = SCHEDULER_HEADER;
  const top = doc.contents as YAMLMap;
  const first = top.items[0]?.key;
  if (isScalar(first)) first.commentBefore = null;
  doc.set('name', `${String(doc.get('name') ?? 'mdbisync')} (scheduled)`);
  const on = doc.get('on');
  if (!isMap(on) || !on.has('schedule')) throw new Error('the template has no schedule');
  // The template's dispatch stays: a tick by hand (MDBISYNC_TEST_SCHEDULE_TICK=dispatch) when GitHub starts no schedule.
  if (!on.has('workflow_dispatch')) throw new Error('the template has no workflow_dispatch');
  for (const event of on.items.map((pair) => String(pair.key))) if (event !== 'schedule' && event !== 'workflow_dispatch') on.delete(event);
  if (doc.getIn(['concurrency', 'group']) !== SCHEDULER_GROUP) throw new Error('the template has no shared concurrency group');
  const concurrency = top.items.find((pair) => isScalar(pair.key) && pair.key.value === 'concurrency')?.key;
  if (isScalar(concurrency)) concurrency.commentBefore = ' One tick at a time; a newer tick replaces a waiting one.';

  const jobs = doc.get('jobs') as YAMLMap;
  for (const pair of jobs.items) {
    const job = pair.value as YAMLMap;
    const condition = job.get('if');
    for (const key of ['name', 'needs', 'if', 'concurrency']) job.delete(key);
    // Only a tick that took a request runs the template's job, as that run's job: its name carries the run id.
    // The run's own group, the one its pushes and dispatches use, so the scheduled job queues behind them.
    job.items.unshift(...Object.entries({
      name: scheduledJobName(String(pair.key), requested('run')),
      needs: REQUEST_JOB,
      if: guarded(`needs.${REQUEST_JOB}.outputs.run != ''`, condition),
      // A tick without a request skips the job; its group then is the tick's own, never empty and never shared.
      concurrency: { group: `\${{ needs.${REQUEST_JOB}.outputs.group || format('${SCHEDULER_GROUP}-idle-{0}', github.run_id) }}`, 'cancel-in-progress': false },
    }).map(([key, value]) => doc.createPair(key, value)));
    const steps = job.get('steps');
    if (!isSeq(steps)) continue;
    for (const item of steps.items) {
      const step = item as YAMLMap;
      const uses = step.get('uses');
      if (typeof uses !== 'string' || !uses.startsWith('actions/checkout@')) continue;
      // On a schedule the checkout is the default branch's; the run's tracked branch takes its place, as main is the deployer's.
      if (!isMap(step.get('with'))) step.set('with', doc.createNode({}));
      (step.get('with') as YAMLMap).set('ref', requested('tracked-branch'));
    }
  }
  const request = doc.createNode({
    'runs-on': SANDBOX_RUNNER,
    'timeout-minutes': 5,
    permissions: { contents: 'write' },
    outputs: Object.fromEntries(['run', 'tracked-branch', 'sync-branch', 'state-ref-prefix', 'group'].map((output) => [output, `\${{ steps.take.outputs.${output} }}`])),
    steps: [{
      name: 'Take a request',
      id: 'take',
      shell: 'bash',
      env: { TOKEN: '${{ github.token }}', REMOTE: '${{ github.server_url }}/${{ github.repository }}' },
      run: requestScript(),
    }],
  });
  jobs.items.unshift(doc.createPair(REQUEST_JOB, request));
  return doc.toString({ lineWidth: 0 });
}

function patchSteps(doc: Document, job: YAMLMap, options: RunWorkflowOptions): void {
  const steps = job.get('steps');
  if (!isSeq(steps)) return;
  const isAction = (item: unknown) => isActionUses((item as YAMLMap).get('uses'));
  if (options.securityCanary && steps.items.some(isAction)) {
    const hooks = steps.items.find(item => (item as YAMLMap).get('name') === CANARY_HOOK_STEP) as YAMLMap | undefined;
    if (hooks === undefined) throw new Error('Security canary needs a separate hooks step');
    hooks.setIn(['env', CANARY_ENABLED], '1');
    hooks.setIn(['env', CANARY_KEY], '${{ secrets.CANARY_HOOK_KEY }}');
    const stage = steps.items.findIndex(isAction);
    (steps.items[stage] as YAMLMap).setIn(['env', 'NODE_OPTIONS'], `--import \"\${{ github.workspace }}/${CANARY_TOKEN_OBSERVER_FILE}\"`);
    steps.items.splice(stage, 0, doc.createNode({
      name: CANARY_PREPARE_STEP,
      run: CANARY_PREPARE,
      env: {
        CANARY_LINEAR_SECRET: `\${{ ${SANDBOX_NAMES['secrets.MDBISYNC_LINEAR_CLIENT_SECRET']} }}`,
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

interface TemplateStep {
  name?: string;
  run?: string;
  uses?: string;
}

/** Every step of every template that exists. */
function templateSteps(): TemplateStep[] {
  return Object.values(WORKFLOW_FILES)
    .filter((file) => existsSync(join(EXAMPLES, file)))
    .flatMap((file) => Object.values((parseDocument(readTemplate(file)).toJS() as { jobs?: Record<string, { steps?: TemplateStep[] }> }).jobs ?? {}))
    .flatMap((job) => job.steps ?? []);
}

function readPrerequisiteErrors(): string[] {
  const errors = new Set<string>();
  for (const step of templateSteps()) {
    if (step.name === undefined || !PREREQUISITE_STEPS.has(step.name)) continue;
    for (const match of (step.run ?? '').matchAll(/::error::([^'"\n]+)/g)) errors.add(`##[error]${(match[1] as string).trim()}`);
  }
  return [...errors];
}

let knownEngineSteps: ReadonlySet<string> | undefined;

/** The names of the templates' steps that run the engine: those whose `uses` is the action (the stage step and the sync or initial sync step). */
export function engineSteps(): ReadonlySet<string> {
  knownEngineSteps ??= readEngineSteps();
  return knownEngineSteps;
}

function readEngineSteps(): Set<string> {
  return new Set(templateSteps().filter((step) => isActionUses(step.uses)).flatMap((step) => (step.name === undefined ? [] : [step.name])));
}

/** The templates that exist (of `only`, when given), rendered for one run, by their `.github/workflows/` file name. */
export function runWorkflows(options: RunWorkflowOptions, only?: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of only ?? Object.values(WORKFLOW_FILES)) {
    if (existsSync(join(EXAMPLES, file))) files.set(file, renderForRun(readTemplate(file), options));
  }
  return files;
}
