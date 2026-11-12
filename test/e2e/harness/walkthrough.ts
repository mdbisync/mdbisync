// Token-free operations for a manual walk-through on one sandbox run branch.
// Prepare locally, commit, then push. Live use needs the same admission and
// cleanup window as a scenario run; these commands do not reserve Linear zones.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMap, isSeq, parse, parseDocument } from 'yaml';
import { Git } from '../../../src/state/git.ts';
import { reportText } from '../../../src/run/output.ts';
import { loadTestConfig, parseRepoUrl, type TestConfig } from './config.ts';
import { appInstallationToken, gitAuthEnv, SandboxRest, type WorkflowRun } from './github.ts';
import { runNames } from './isolation.ts';
import { EnvBlockedError, ProductError } from './results.ts';
import { isActionUses, renderForRun, runGroup, SANDBOX_RUNNER, WORKFLOW_FILES } from './workflow-files.ts';
import { REPORT_ARTIFACT, unzip, waitForRegistration, waitForRun, RUN_WAIT_MS, POLL_MS } from './workflows.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const dispatchable: readonly string[] = [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']];
const workflows: readonly string[] = Object.values(WORKFLOW_FILES);
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
  safe(text: string): string;
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
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

function isOwnRun(run: WorkflowRun, ref: string): boolean {
  return run.head_branch === ref && ['push', 'workflow_dispatch', 'pull_request'].includes(run.event)
    && workflows.some((file) => run.path?.split('@')[0] === `.github/workflows/${file}`);
}

function ownRun(run: WorkflowRun, ref: string): WorkflowRun {
  if (!isOwnRun(run, ref)) throw new WalkthroughError('workflow run is outside the selected walkthrough branch/workflows');
  return run;
}

export async function walkthrough(argv: string[], options: WalkthroughOptions = {}): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    run: { type: 'string' }, ref: { type: 'string' }, dir: { type: 'string' },
    workflow: { type: 'string' }, input: { type: 'string', multiple: true }, 'run-number': { type: 'string' },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !['prepare', 'push', 'dispatch', 'wait', 'list', 'cancel'].includes(action ?? '')) throw new Error('usage: walkthrough prepare|push|dispatch|wait|list|cancel --run <six hex> [--ref t/<run>/main] [--dir <clone>] [--workflow <file>] [--input key=value] [--run-number <id>]');
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
  if (!config.sandboxUrl) throw new EnvBlockedError('env-blocked: MDBISYNC_TEST_SANDBOX_URL is missing');
  const parsed = parseRepoUrl(config.sandboxUrl);
  if (parsed === null || parsed.owner !== config.owner || parsed.repo !== config.repo) throw new EnvBlockedError('MDBISYNC_TEST_SANDBOX_URL must name the configured GitHub sandbox');
  if (action === 'push') {
    const git = new Git(dir);
    for (const file of workflows) requireWalkthroughIsolation(await git.text(['show', `refs/heads/${ref}:.github/workflows/${file}`]), runId, file);
  }
  // Authentication and transport errors are deliberately not echoed: even
  // an unexpected fetch/git error may contain a credential or a remote body.
  let connection: WalkthroughConnection;
  try { connection = await (options.connect ?? ((config) => connect(config, options.fetch)))(config); }
  catch { throw new Error('walkthrough GitHub App authentication failed'); }
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
    if (artifact === undefined) { print('Summary unavailable: no report artifact (the run may have failed before the action).'); return 1; }
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
