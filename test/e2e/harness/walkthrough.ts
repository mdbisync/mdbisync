// Token-free operations for a manual walk-through on one sandbox run branch.
// Prepare locally, commit, then push. Live use needs the same admission and
// cleanup window as a scenario run; these commands do not reserve Linear zones.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { Git } from '../../../src/state/git.ts';
import { reportText } from '../../../src/run/output.ts';
import { loadTestConfig, parseRepoUrl, type TestConfig } from './config.ts';
import { appInstallationToken, gitAuthEnv, SandboxRest, type WorkflowRun } from './github.ts';
import { runNames } from './isolation.ts';
import { EnvBlockedError } from './results.ts';
import { isActionUses, renderForRun, runGroup, WORKFLOW_FILES } from './workflow-files.ts';
import { REPORT_ARTIFACT, unzip, waitForRun, RUN_WAIT_MS, POLL_MS } from './workflows.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const workflows: readonly string[] = [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']];

export function walkthroughRef(runId: string, ref: string): string {
  const names = runNames(runId);
  if (ref !== names.trackedBranch) throw new Error('walkthrough ref must be t/<run>/main for the selected run');
  return ref;
}

function workflow(file: string): string {
  if (!workflows.includes(file)) throw new Error('walkthrough workflow must be mdbisync.yml or mdbisync-initial-sync.yml');
  return file;
}

/** Refuse a copied workflow whose action could write outside this run. */
export function requireWalkthroughIsolation(text: string, runId: string): void {
  const names = runNames(runId);
  const doc = parse(text) as { jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
  const steps = Object.values(doc?.jobs ?? {}).flatMap((job) => job.steps ?? []).filter((step) => isActionUses(step.uses));
  if (steps.length === 0 || steps.some((step) => step.with?.['tracked-branch'] !== names.trackedBranch
    || step.with?.['sync-branch'] !== names.syncBranch || step.with?.['state-ref-prefix'] !== names.refPrefix
    || step.with?.['cleanup-tokens'] !== false)) throw new Error('prepare and commit the run-isolated workflows before pushing or dispatching');
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

function ownRun(run: WorkflowRun, ref: string): WorkflowRun {
  if (run.head_branch !== ref || !['push', 'workflow_dispatch'].includes(run.event)
    || !workflows.some((file) => run.path?.split('@')[0] === `.github/workflows/${file}`)) throw new Error('workflow run is outside the selected walkthrough branch/workflows');
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
  if (['wait', 'cancel'].includes(action as string) && (!Number.isSafeInteger(number) || number < 1)) throw new Error('--run-number must be a positive integer');
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
    // Render both before writing either. Keep the release pins init wrote.
    const rendered = workflows.map((file) => ({ path: join(dir, '.github/workflows', file), text: renderForRun(readFileSync(join(dir, '.github/workflows', file), 'utf8'), {
      trackedBranch: ref, syncBranch: names.syncBranch, refPrefix: names.refPrefix, group: runGroup(runId),
    }) }));
    for (const { path, text } of rendered) writeFileSync(path, text);
    write('Prepared the two local workflows; review and commit them before push.\n');
    return 0;
  }
  const config = options.config ?? loadTestConfig();
  if (!config.sandboxUrl) throw new EnvBlockedError('MDBISYNC_TEST_SANDBOX_URL is missing');
  const parsed = parseRepoUrl(config.sandboxUrl);
  if (parsed === null || parsed.owner !== config.owner || parsed.repo !== config.repo) throw new EnvBlockedError('MDBISYNC_TEST_SANDBOX_URL must name the configured GitHub sandbox');
  if (action === 'push') {
    const git = new Git(dir);
    for (const file of workflows) requireWalkthroughIsolation(await git.text(['show', `refs/heads/${ref}:.github/workflows/${file}`]), runId);
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
        if (run.head_branch === ref && workflows.some((file) => run.path?.split('@')[0] === `.github/workflows/${file}`)
          && ['push', 'workflow_dispatch'].includes(run.event)) print(describe(run));
      }
      return 0;
    }
    let run: WorkflowRun;
    if (action === 'dispatch') {
      requireWalkthroughIsolation(await rest.fileText(`.github/workflows/${file!}`, ref) ?? '', runId);
      const exclude = new Set((await rest.workflowRuns(ref)).map((run) => run.id));
      const after = Date.now();
      await rest.dispatchWorkflow(file!, ref, inputs);
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
        if (Date.now() >= deadline) throw new Error('walkthrough wait deadline exceeded');
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
    if (error instanceof EnvBlockedError) throw new EnvBlockedError('walkthrough workflow did not appear or finish before its deadline');
    throw new Error('walkthrough operation failed; check the run isolation, workflow registration and GitHub access');
  }
}
