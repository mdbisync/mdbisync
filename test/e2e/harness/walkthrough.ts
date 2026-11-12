// Operations for a manual walk-through on one sandbox run branch. Prepare
// locally, commit, then push; dispatch and read the runs; the Linear side and
// the run's cleanup are in walkthrough-linear.ts. Live use needs the same
// admission and cleanup window as a scenario run; these commands do not
// reserve Linear zones.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMap, isSeq, parse, parseDocument } from 'yaml';
import { Git } from '../../../src/state/git.ts';
import { reportText } from '../../../src/run/output.ts';
import { loadTestConfig, parseRepoUrl, type TestConfig } from './config.ts';
import { appInstallationToken, gitAuthEnv, SandboxRest, type WorkflowRun } from './github.ts';
import { runNames, runOfRef } from './isolation.ts';
import { editorClient, LinearWorld, RunWorldError } from './linear-world.ts';
import { defaultStateDir } from './locks.ts';
import { OwnershipRefusal } from './ownership.ts';
import { EnvBlockedError, ProductError } from './results.ts';
import { readIds, resolveStateConfig, stateRef } from '../../../src/state/index.ts';
import { checkLinearOptions, LINEAR_ACTIONS, linearAction, SANDBOX_LINEAR_ACTIONS, WalkthroughRefusal, type RunGit, type WalkthroughWorld } from './walkthrough-linear.ts';
import { isActionUses, renderForRun, runGroup, SANDBOX_RUNNER, WORKFLOW_FILES } from './workflow-files.ts';
import { REPORT_ARTIFACT, runLogs, unzip, waitForRegistration, waitForRun, RUN_WAIT_MS, POLL_MS } from './workflows.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const dispatchable: readonly string[] = [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']];
const workflows: readonly string[] = Object.values(WORKFLOW_FILES);
const ACTIONS: readonly string[] = ['prepare', 'push', 'dispatch', 'wait', 'list', 'cancel'];
class WalkthroughError extends Error {}

export function walkthroughRef(runId: string, ref: string): string {
  const names = runNames(runId);
  if (ref !== names.trackedBranch) throw new Error('walkthrough ref must be t/<run>/main for the selected run');
  return ref;
}

function workflow(file: string): string {
  if (!dispatchable.includes(file)) throw new Error('walkthrough workflow must be mdbisync.yml or mdbisync-initial-sync.yml');
  return file;
}

/** Refuse a copied workflow whose action could write outside this run. */
export function requireWalkthroughIsolation(text: string, runId: string, file: string = WORKFLOW_FILES.sync): void {
  const names = runNames(runId);
  const doc = parse(text) as { on?: Record<string, { branches?: string[] }>; concurrency?: { group?: string }; jobs?: Record<string, { 'runs-on'?: unknown; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
  const refuse = () => { throw new WalkthroughError('prepare and commit the run-isolated workflows before pushing or dispatching'); };
  if (Object.keys(doc?.jobs ?? {}).length === 0) refuse();
  for (const job of Object.values(doc?.jobs ?? {})) if (JSON.stringify(job['runs-on']) !== JSON.stringify(SANDBOX_RUNNER)) refuse();
  for (const event of ['push', 'pull_request']) if (Object.hasOwn(doc.on ?? {}, event)
    && JSON.stringify(doc.on?.[event]?.branches) !== JSON.stringify([names.trackedBranch])) refuse();
  if (file !== WORKFLOW_FILES['pre-commit']) {
    const group = runGroup(runId);
    const registrationGroup = `\${{ github.event_name == 'push' && format('{0}-register-{1}', '${group}', github.run_id) || '${group}' }}`;
    if (![group, registrationGroup].includes(doc.concurrency?.group ?? '')) refuse();
  }
  const steps = Object.values(doc?.jobs ?? {}).flatMap((job) => job.steps ?? []).filter((step) => isActionUses(step.uses));
  if ((file !== WORKFLOW_FILES['pre-commit'] && steps.length === 0) || steps.some((step) => step.with?.['tracked-branch'] !== names.trackedBranch
    || step.with?.['sync-branch'] !== names.syncBranch || step.with?.['state-ref-prefix'] !== names.refPrefix
    || step.with?.['cleanup-tokens'] !== false)) refuse();
}

function prepareWorkflow(text: string, runId: string): string {
  // Remove the generated upload before re-rendering, so preparation is safe
  // to repeat. Every other step and the original release pins are retained.
  const doc = parseDocument(text);
  const jobs = doc.get('jobs');
  if (isMap(jobs)) for (const pair of jobs.items) {
    if (!isMap(pair.value)) continue;
    const steps = pair.value.get('steps');
    if (isSeq(steps)) steps.items = steps.items.filter((step) => !(isMap(step)
      && String(step.get('uses')).startsWith('actions/upload-artifact@')
      && step.getIn(['with', 'name']) === REPORT_ARTIFACT));
  }
  const names = runNames(runId);
  const rendered = renderForRun(doc.toString({ lineWidth: 0 }), { trackedBranch: names.trackedBranch,
    syncBranch: names.syncBranch, refPrefix: names.refPrefix, group: runGroup(runId) });
  return rendered;
}

export interface WalkthroughConnection {
  rest: SandboxRest;
  push(dir: string, ref: string): Promise<void>;
  /** The run's refs and ids state ref, for the Linear side and cleanup. */
  git: RunGit;
  safe(text: string): string;
}

/**
 * Runs `use` in a new empty bare repository that is removed afterwards: ls-remote, fetch and push need no clone.
 * It has no template and no hooks, so no hook inherits the App token from the environment.
 */
async function inScratchRepo<T>(env: Record<string, string>, use: (git: Git) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-git-'));
  try {
    const git = new Git(dir, env);
    await git.run(['init', '--quiet', '--bare', '--template=']);
    await git.run(['config', 'core.hooksPath', '/dev/null']);
    return await use(git);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function runGit(url: string, env: Record<string, string>): RunGit {
  const refs = async (git: Git, runId: string) => {
    const names = runNames(runId);
    const text = await git.text(['ls-remote', '--refs', url, `refs/heads/t/${runId}/*`, `${names.refPrefix}/*`]);
    return text.split('\n').flatMap((line) => {
      const ref = line.split('\t')[1];
      return ref !== undefined && runOfRef(ref) === runId ? [ref] : [];
    });
  };
  return {
    refs: (runId) => inScratchRepo(env, (git) => refs(git, runId)),
    deleteRefs: async (runId, list) => {
      if (list.length === 0) return;
      for (const ref of list) if (runOfRef(ref) !== runId) throw new WalkthroughRefusal('refusing to delete a ref that is not the selected run\'s');
      await inScratchRepo(env, (git) => git.run(['push', '--quiet', '--no-verify', '--', url, ...list.map((ref) => `:${ref}`)]));
    },
    ids: (runId) => inScratchRepo(env, async (git) => {
      const names = runNames(runId);
      const ref = stateRef(resolveStateConfig({ trackedBranch: names.trackedBranch, syncBranch: names.syncBranch, refPrefix: names.refPrefix }), 'ids');
      if (!(await refs(git, runId)).includes(ref)) return new Map<string, string>();
      await git.run(['fetch', '--quiet', '--no-write-fetch-head', '--', url, `+${ref}:${ref}`]);
      const ids = await readIds(git, (await git.text(['rev-parse', ref])).trim());
      return new Map([...ids].map(([path, entry]) => [path, entry.id]));
    }),
  };
}

async function connect(config: TestConfig, fetchImpl: typeof fetch = fetch): Promise<WalkthroughConnection> {
  // Never fall back to a host credential for the manual API route.
  const { token } = await appInstallationToken(config, fetchImpl);
  const env = gitAuthEnv(token);
  const secrets = [token, Buffer.from(`x-access-token:${token}`).toString('base64'),
    config.githubApp?.privateKey, ...config.linearApps.flatMap((app) => [app.clientId, app.clientSecret]), ...Object.values(config.editors)]
    .filter((value): value is string => value !== undefined && value !== '');
  return {
    rest: new SandboxRest(config, token, fetchImpl),
    git: runGit(config.sandboxUrl, env),
    push: async (dir, ref) => {
      // Use the configured URL, never the clone's origin or an implicit push.
      // Hooks must not inherit the App token. Preparation/commit already runs
      // the user's hooks; this transfer only sends the committed run branch.
      await new Git(dir, env).run(['-c', 'core.hooksPath=/dev/null', 'push', '--', config.sandboxUrl, `refs/heads/${ref}:refs/heads/${ref}`]);
    },
    safe: (text) => {
      let safe = text;
      for (const secret of secrets.sort((a, b) => b.length - a.length)) safe = safe.split(secret).join('[redacted]');
      return reportText(safe.replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]'));
    },
  };
}

export interface WalkthroughOptions {
  config?: TestConfig;
  connect?: (config: TestConfig) => Promise<WalkthroughConnection>;
  write?: (text: string) => void;
  /** The editor's Linear world for the Linear-side commands. */
  linear?: (config: TestConfig) => WalkthroughWorld;
  stateDir?: string;
  now?: () => Date;
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

/** Why a run left no summary: its jobs, failed steps and the error lines GitHub logged for them. */
async function explainMissingSummary(rest: SandboxRest, run: WorkflowRun, print: (text: string) => void): Promise<void> {
  let failed = 0;
  for (const job of await rest.runJobs(run.id)) {
    const steps = (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name);
    failed += steps.length;
    print(`Job ${job.name}: ${job.conclusion ?? 'not finished'}${steps.length === 0 ? '' : `; failed step: ${steps.join(', ')}`}`);
  }
  // GitHub marks a step's failure with "##[error]" in its log; the job's
  // combined log repeats it, so each line is printed once.
  const errors = new Set<string>();
  for (const log of (await runLogs(rest, run)).values()) {
    for (const line of log.split(/\r?\n/)) {
      const text = line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '');
      if (text.startsWith('##[error]')) errors.add(text.slice('##[error]'.length).trimEnd().slice(0, 500));
    }
  }
  for (const error of [...errors].slice(0, 10)) print(`Error: ${error}`);
  if (failed === 0 && errors.size === 0) print('No failed step or error line was found; open the run in Actions.');
}

function isOwnRun(run: WorkflowRun, ref: string): boolean {
  return run.head_branch === ref && ['push', 'workflow_dispatch', 'pull_request'].includes(run.event)
    && workflows.some((file) => run.path?.split('@')[0] === `.github/workflows/${file}`);
}

function ownRun(run: WorkflowRun, ref: string): WorkflowRun {
  if (!isOwnRun(run, ref)) throw new WalkthroughError('workflow run is outside the selected walkthrough branch/workflows');
  return run;
}

function requireSandboxUrl(config: TestConfig): void {
  if (!config.sandboxUrl) throw new EnvBlockedError('env-blocked: MDBISYNC_TEST_SANDBOX_URL is missing');
  const parsed = parseRepoUrl(config.sandboxUrl);
  if (parsed === null || parsed.owner !== config.owner || parsed.repo !== config.repo) throw new EnvBlockedError('MDBISYNC_TEST_SANDBOX_URL must name the configured GitHub sandbox');
}

async function openConnection(config: TestConfig, options: WalkthroughOptions): Promise<WalkthroughConnection> {
  // Authentication and transport errors are deliberately not echoed: even
  // an unexpected fetch/git error may contain a credential or a remote body.
  try { return await (options.connect ?? ((config) => connect(config, options.fetch)))(config); }
  catch { throw new Error('walkthrough GitHub App authentication failed'); }
}

async function sandboxConnection(config: TestConfig, options: WalkthroughOptions): Promise<WalkthroughConnection> {
  requireSandboxUrl(config);
  return openConnection(config, options);
}

export async function walkthrough(argv: string[], options: WalkthroughOptions = {}): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    run: { type: 'string' }, ref: { type: 'string' }, dir: { type: 'string' },
    workflow: { type: 'string' }, input: { type: 'string', multiple: true }, 'run-number': { type: 'string' },
    team: { type: 'string', multiple: true }, path: { type: 'string' }, text: { type: 'string' },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || ![...ACTIONS, ...LINEAR_ACTIONS].includes(action ?? '')) throw new Error(`usage: walkthrough ${[...ACTIONS, ...LINEAR_ACTIONS].join('|')} --run <six hex> [--ref t/<run>/main] [--dir <clone>] [--workflow <file>] [--input key=value] [--run-number <id>] [--team <key>] [--path <synced file>] [--text <line>]`);
  const runId = values.run ?? '';
  const names = runNames(runId);
  const ref = walkthroughRef(runId, values.ref ?? names.trackedBranch);
  const file = action === 'dispatch' ? workflow(values.workflow ?? '') : undefined;
  const number = Number(values['run-number']);
  if (values.workflow !== undefined && action !== 'dispatch') throw new Error('--workflow is only for dispatch');
  if (values.dir !== undefined && !['prepare', 'push'].includes(action!)) throw new Error('--dir is only for prepare or push');
  if (values['run-number'] !== undefined && !['wait', 'cancel'].includes(action!)) throw new Error('--run-number is only for wait or cancel');
  if (['wait', 'cancel'].includes(action!) && (!/^[1-9][0-9]*$/.test(values['run-number'] ?? '') || !Number.isSafeInteger(number))) throw new Error('--run-number must be a positive decimal integer');
  const inputs: Record<string, string> = {};
  for (const input of values.input ?? []) {
    const match = /^(direction|confirm)=(.*)$/.exec(input);
    if (action !== 'dispatch' || match === null || Object.hasOwn(inputs, match[1]!)) throw new Error('inputs must be unique direction=... or confirm=... values for dispatch');
    inputs[match[1]!] = match[2]!;
  }
  if (inputs['direction'] !== undefined && !['git-to-linear', 'linear-to-git'].includes(inputs['direction'])) throw new Error('invalid direction');
  if (inputs['confirm'] !== undefined && !['true', 'false'].includes(inputs['confirm'])) throw new Error('confirm must be true or false');
  if (file === WORKFLOW_FILES['initial-sync'] && inputs['direction'] === undefined) throw new Error('initial sync needs --input direction=git-to-linear or linear-to-git');
  const teams = values.team ?? [];
  checkLinearOptions(action!, teams, values.path, values.text);
  if (LINEAR_ACTIONS.includes(action!) && values.ref !== undefined) throw new Error('--ref is not for the Linear-side commands');
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const dir = values.dir ?? '.';
  if (action === 'prepare') {
    // Render and validate all three before writing any. Keep init's pins.
    const rendered = workflows.map((file) => {
      const path = join(dir, '.github/workflows', file);
      const text = prepareWorkflow(readFileSync(path, 'utf8'), runId);
      requireWalkthroughIsolation(text, runId, file);
      return { path, text };
    });
    for (const { path, text } of rendered) writeFileSync(path, text);
    write('Prepared the three local workflows; review and commit them before push.\n');
    return 0;
  }
  const config = options.config ?? loadTestConfig();
  if (LINEAR_ACTIONS.includes(action!)) {
    if (options.linear === undefined && config.editors['editor-a'] === '') throw new EnvBlockedError('env-blocked: the editor-a Linear key is missing');
    const world = (options.linear ?? ((config) => new LinearWorld(editorClient(config.editors['editor-a']))))(config);
    let connection: WalkthroughConnection | undefined;
    if (SANDBOX_LINEAR_ACTIONS.includes(action!)) connection = await sandboxConnection(config, options);
    const print = (text: string) => write(`${connection?.safe(text) ?? reportText(text)}\n`);
    try {
      return await linearAction({ action: action!, runId, teams, ...(values.path === undefined ? {} : { path: values.path }),
        ...(values.text === undefined ? {} : { text: values.text }), stateDir: options.stateDir ?? defaultStateDir(), world,
        ...(connection === undefined ? {} : { git: connection.git, rest: connection.rest }), print, ...(options.now === undefined ? {} : { now: options.now }) });
    } catch (error) {
      // Refusals name only run ids, project names and document ids; other errors may carry a remote body.
      if (error instanceof WalkthroughRefusal || error instanceof RunWorldError || error instanceof OwnershipRefusal) throw error;
      throw new Error('walkthrough Linear operation failed; check the run isolation and the Linear and GitHub access');
    }
  }
  requireSandboxUrl(config);
  if (action === 'push') {
    const git = new Git(dir);
    for (const file of workflows) requireWalkthroughIsolation(await git.text(['show', `refs/heads/${ref}:.github/workflows/${file}`]), runId, file);
  }
  const connection = await openConnection(config, options);
  const { rest } = connection;
  const print = (text: string) => write(`${connection.safe(text)}\n`);
  const describe = (run: WorkflowRun) => JSON.stringify({ id: run.id, status: run.status, conclusion: run.conclusion });
  const timeoutMs = options.timeoutMs ?? RUN_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  try {
    if (action === 'push') {
      await connection.push(dir, ref);
      print(`Pushed ${ref}`);
      return 0;
    }
    if (action === 'list') {
      for (const run of await rest.workflowRuns(ref)) {
        if (isOwnRun(run, ref)) print(describe(run));
      }
      return 0;
    }
    let run: WorkflowRun;
    if (action === 'dispatch') {
      for (const candidate of workflows) requireWalkthroughIsolation(await rest.fileText(`.github/workflows/${candidate}`, ref) ?? '', runId, candidate);
      let workflowId: number;
      try { workflowId = await waitForRegistration(rest, file!, { timeoutMs, pollMs }); }
      catch { throw new WalkthroughError('workflow registration failed or exceeded its deadline; check the registering push run'); }
      const exclude = new Set((await rest.workflowRuns(ref)).map((run) => run.id));
      const after = Date.now();
      await rest.dispatchWorkflow(workflowId, ref, inputs);
      run = ownRun(await waitForRun(rest, { branch: ref, event: 'workflow_dispatch', workflow: file!, after, exclude, timeoutMs, pollMs }), ref);
    } else {
      run = ownRun(await rest.request<WorkflowRun>('GET', `/actions/runs/${number}`), ref);
      if (action === 'cancel') {
        await rest.request('POST', `/actions/runs/${number}/cancel`);
        print(`Cancellation requested for run ${number}`);
        return 0;
      }
      const deadline = Date.now() + timeoutMs;
      while (run.status !== 'completed') {
        if (Date.now() >= deadline) throw new EnvBlockedError('walkthrough wait deadline exceeded');
        await sleep(pollMs);
        run = ownRun(await rest.request<WorkflowRun>('GET', `/actions/runs/${number}`), ref);
      }
    }
    print(describe(run));
    const { artifacts } = await rest.request<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>('GET', `/actions/runs/${run.id}/artifacts`);
    const artifact = artifacts.find((item) => item.name === REPORT_ARTIFACT && !item.expired);
    if (artifact === undefined) {
      print('Summary unavailable: no report artifact (the run may have failed before the action wrote one, or the artifact expired).');
      // Diagnostics only: a failed read must not hide the run's conclusion.
      try { await explainMissingSummary(rest, run, print); }
      catch { print('The run\'s jobs and logs could not be read; open the run in Actions.'); }
      return 1;
    }
    const summary = unzip(await rest.download(`/actions/artifacts/${artifact.id}/zip`)).get('summary.md');
    if (summary === undefined) { print('Summary unavailable: report artifact has no summary.md.'); return 1; }
    print(summary.toString('utf8'));
    return run.conclusion === 'success' ? 0 : 1;
  } catch (error) {
    if (error instanceof WalkthroughError) throw error;
    if (error instanceof ProductError) throw new WalkthroughError('the dispatched workflow did not appear before its deadline; check the registering push run');
    if (error instanceof EnvBlockedError) throw new EnvBlockedError('walkthrough workflow did not appear or finish before its deadline');
    throw new Error('walkthrough operation failed; check the run isolation, workflow registration and GitHub access');
  }
}
