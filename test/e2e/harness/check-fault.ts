// Check runs belong to Actions: the harness writes the branch marker and
// reads the resulting check. It never needs checks:write. A person's
// credential (never the sync App's) reruns a failed check and cancels a
// pending marker job that would keep the sandbox's single runner busy.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Git, resolveStateConfig, suspendedBranch } from '../../../src/state/index.ts';
import { CHECK_MARKER, CHECK_NAME, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import type { RunContext } from './context.ts';
import { GitHubError, SandboxRest, hostToken } from './github.ts';
import { targetPath } from './step-helpers.ts';
import { nextToken } from './context.ts';
import { EnvBlockedError, HarnessGapError, ProductError } from './results.ts';
import { HARNESS } from './sandbox.ts';
import { live } from './step-helpers.ts';

export type CheckState = 'pending' | 'failed' | 'passed';

type CheckReading = { check: { id: number } | undefined; actual: string };

/** The latest marker-workflow check on this exact head, never an unrelated check. */
async function readCheck(rest: SandboxRest, sha: string): Promise<CheckReading> {
  const { check_runs: runs } = await rest.request<{ check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; app?: { slug: string } }> }>(
    'GET', `/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
  );
  const check = runs.filter((run) => run.name === CHECK_NAME && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0];
  const actual = check === undefined ? 'absent' : check.status !== 'completed' ? 'pending'
    : check.conclusion === 'success' ? 'passed' : check.conclusion === 'failure' ? 'failed' : String(check.conclusion);
  return { check, actual };
}

type WaitOptions = { timeoutMs?: number; pollMs?: number | undefined; signal?: AbortSignal };

/** The default bound of every wait for a marker check. */
export const CHECK_WAIT_MS = 5 * 60_000;

/** Polls the check until `done` accepts its state; at the deadline, `timedOut` names the error. */
async function pollCheck(rest: SandboxRest, sha: string, done: (actual: string) => boolean, timedOut: (reading: CheckReading) => Error, options: WaitOptions): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? CHECK_WAIT_MS);
  for (;;) {
    options.signal?.throwIfAborted();
    const reading = await readCheck(rest, sha);
    if (done(reading.actual)) return reading.actual;
    if (Date.now() >= deadline) throw timedOut(reading);
    await sleep(options.pollMs ?? 2_000, undefined, { signal: options.signal });
  }
}

/** Wait for this workflow's check on this exact head, never an unrelated check. */
export async function waitForCheck(rest: SandboxRest, sha: string, state: CheckState, options: WaitOptions = {}): Promise<void> {
  await pollCheck(rest, sha, (actual) => actual === state, ({ check, actual }) => check === undefined
    ? new ProductError(`no ${CHECK_NAME} check appeared on the marker commit`)
    : new EnvBlockedError(`the ${CHECK_NAME} check did not reach ${state} on the marker commit (last state: ${actual})`), options);
}

/**
 * Wait until the check that a push to the tracked branch starts has
 * completed, whatever its result, and return that result. The sync treats a
 * check that still runs on the tracked tip as a reason to wait before it
 * suspends (the red-main rule), so a scenario step must not race it.
 */
export async function waitForCheckCompleted(rest: SandboxRest, sha: string, options: WaitOptions = {}): Promise<string> {
  // The push trigger and the runner belong to the sandbox, not to the product.
  return pollCheck(rest, sha, (actual) => actual !== 'absent' && actual !== 'pending',
    ({ actual }) => new EnvBlockedError(`the ${CHECK_NAME} check on the tracked branch's new tip did not complete (last state: ${actual})`), options);
}

/** A `pending` marker job sleeps on the sandbox's single runner until its head moves on. */
interface PendingHead { branch: string; sha: string }
const PENDING_HEADS = 'checks.pendingHeads';

type WorkflowRun = { id: number; head_sha: string; path: string; status: string; conclusion: string | null };

async function markerRuns(person: SandboxRest, sha: string): Promise<WorkflowRun[]> {
  const { workflow_runs: runs } = await person.request<{ workflow_runs: WorkflowRun[] }>(
    'GET', `/actions/workflows/${encodeURIComponent(CHECK_WORKFLOW_PATH.split('/').at(-1)!)}/runs?head_sha=${sha}&per_page=100`,
  );
  return runs.filter((run) => run.head_sha === sha && run.path === CHECK_WORKFLOW_PATH);
}

/**
 * Cancel the marker workflow's unfinished runs on these pending heads and wait
 * until GitHub reports them completed, so the runner is free for the next check.
 * Returns how many cancels GitHub accepted.
 */
export async function cancelPendingRuns(
  ctx: RunContext, person: SandboxRest, shas: string[],
  options: { timeoutMs?: number; pollMs?: number | undefined } = {},
): Promise<number> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  const requested = new Set<number>();
  let cancelled = 0;
  for (const sha of shas) {
    for (;;) {
      ctx.signal.throwIfAborted();
      const open = (await markerRuns(person, sha)).filter((run) => run.status !== 'completed');
      if (open.length === 0) break;
      for (const run of open.filter((run) => !requested.has(run.id))) {
        try {
          await person.request('POST', `/actions/runs/${run.id}/cancel`);
          cancelled += 1;
        } catch (error) {
          // 409: the run completed between the read and the cancel.
          if (!(error instanceof GitHubError && error.status === 409)) throw error;
        }
        requested.add(run.id);
      }
      if (Date.now() >= deadline) throw new EnvBlockedError('the pending marker run did not finish within 5 minutes after its cancel');
      await sleep(options.pollMs ?? 2_000, undefined, { signal: ctx.signal });
    }
  }
  return cancelled;
}

/** A person's REST client for Actions writes; the sync App's token never cancels or reruns a check. */
export function personRest(ctx: RunContext, purpose: string): SandboxRest {
  const world = live(ctx);
  const [owner, repo] = world.repository.split('/');
  if (!owner || !repo) throw new Error('invalid sandbox repository');
  const token = hostToken({ owner, repo });
  if (token === null || token === world.githubToken) throw new EnvBlockedError(`a separate person credential with Actions write permission is required to ${purpose}`);
  return new SandboxRest({ owner, repo }, token);
}

export async function faultChecks(
  ctx: RunContext, args: Record<string, unknown>,
  actionsPerson: () => SandboxRest = () => personRest(ctx, 'cancel the pending check'),
): Promise<void> {
  const state = args.status;
  if (state !== 'pending' && state !== 'failed' && state !== 'passed') throw new Error('invalid check status');
  if (args.name !== undefined && args.name !== CHECK_NAME) throw new Error(`the marker workflow provides only the ${CHECK_NAME} check`);
  if (args.lane !== undefined && args.lane !== 'normal' && args.lane !== 'suspended' && args.lane !== 'tracked') throw new Error('invalid check lane');
  const branch = args.lane === 'suspended' ? suspendedBranch(resolveStateConfig({trackedBranch:ctx.names.trackedBranch,syncBranch:ctx.names.syncBranch,refPrefix:ctx.names.refPrefix})) : args.lane === 'tracked' ? ctx.names.trackedBranch : ctx.names.syncBranch;
  const world = live(ctx);
  // A new head on the same branch cancels its pending job (the workflow's
  // concurrency group); a fault on another lane would queue behind it.
  const pending = (ctx.observations.get(PENDING_HEADS) as PendingHead[] | undefined) ?? [];
  const elsewhere = pending.filter((head) => head.branch !== branch);
  if (elsewhere.length > 0) {
    ctx.log(`cancelling the pending ${CHECK_NAME} run on ${elsewhere.map((head) => head.branch).join(', ')}`);
    const cancelled = await cancelPendingRuns(ctx, actionsPerson(), elsewhere.map((head) => head.sha), { pollMs: ctx.checkPollMs });
    ctx.observations.set('checks.cancelledPending', Number(ctx.observations.get('checks.cancelledPending') ?? 0) + cancelled);
  }
  ctx.observations.set(PENDING_HEADS, []);
  const person = await ctx.person();
  const ref = `refs/heads/${branch}`;
  const refs = await world.sandbox.runRefs();
  const exists = refs.some((entry) => entry.ref === ref);
  if (!exists && state === 'passed') throw new HarnessGapError('fault.checks release without a sync branch');
  await person.run(['fetch', '--quiet', 'origin', exists ? ref : `refs/heads/${ctx.names.trackedBranch}`]);
  const dir = join(ctx.runDir, `check-worktree-${nextToken(ctx)}`);
  await person.run(['worktree', 'add', '--quiet', '--detach', dir, 'FETCH_HEAD']);
  const git = new Git(dir, world.sandbox.env(HARNESS));
  let sha: string;
  try {
    const workflow = await git.run(['cat-file', '-e', `HEAD:${CHECK_WORKFLOW_PATH}`], { okCodes: [0, 128] });
    if (workflow.code !== 0) throw new EnvBlockedError('the run tree has no marker check workflow; publish the updated corpus first');
    {
      const path = typeof args.target === 'string' ? targetPath(ctx, args.target) : (ctx.observations.get('target.path') as string | undefined) ?? targetPath(ctx);
      writeFileSync(join(dir, '.harness-check-target'), `${path}\n`);
      await git.run(['add', '--', '.harness-check-target']);
    }
    if (args.reset === true || state !== 'passed') await git.run(['rm', '--quiet', '--ignore-unmatch', '--', '.harness-check-fixed']);
    if (state === 'passed' && args.lane === 'tracked' && args.reset !== true) {
      writeFileSync(join(dir, '.harness-check-fixed'), 'approved\n');
      await git.run(['add', '--', '.harness-check-fixed']);
    }
    if (state === 'passed') await git.run(['rm', '--quiet', '--ignore-unmatch', '--', CHECK_MARKER]);
    else {
      writeFileSync(join(dir, CHECK_MARKER), `${args.flaky === true ? 'flaky' : args.document === true ? 'document' : state}\n`);
      await git.run(['add', '--', CHECK_MARKER]);
    }
    await git.run(['commit', '--quiet', '--no-verify', '--allow-empty', '-m', `Set check state to ${state}`]);
    sha = (await git.text(['rev-parse', 'HEAD'])).trim();
    await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:${ref}`]);
    ctx.ownCommits.push(sha);
  } finally {
    await person.run(['worktree', 'remove', '--force', dir]);
  }
  const prs = await world.rest.pullRequests(branch, 'open');
  if (args.lane !== 'tracked' && !prs.some((pr) => pr.head.ref === branch && pr.base.ref === ctx.names.trackedBranch)) {
    // A check fault is a fixture of an already waiting PR. Seeding it lets
    // the workflow run before the scenario's first sync; it does not test
    // the product's ability to create a PR.
    await world.rest.openPullRequest(branch, ctx.names.trackedBranch, 'Update documents', 'Review the latest document changes.');
  }
  ctx.log(`waiting up to 5 minutes for ${CHECK_NAME} to reach ${state}`);
  await waitForCheck(world.rest, sha, state, { signal: ctx.signal, pollMs: ctx.checkPollMs });
  if (state === 'pending') ctx.observations.set(PENDING_HEADS, [{ branch, sha } satisfies PendingHead]);
  ctx.observations.set('fault.checks', { name: CHECK_NAME, state, sha });
}

/** A person's rerun uses a host credential, never the sync App's token. */
export async function rerunSuspendedCheck(ctx: RunContext): Promise<void> {
  await rerunCheckAsPerson(ctx, personRest(ctx, 'rerun the check'));
}

/** The caller supplies a separate person's REST client; the App client only reads. */
export async function rerunCheckAsPerson(ctx: RunContext, person: SandboxRest): Promise<void> {
  const world = live(ctx);
  const branch = suspendedBranch(resolveStateConfig(ctx.names));
  const git = await ctx.person();
  await git.run(['fetch', '--quiet', 'origin', `refs/heads/${branch}`]);
  const sha = (await git.text(['rev-parse', 'FETCH_HEAD'])).trim();
  ctx.log(`waiting up to 5 minutes for the suspended head's first failed check`);
  await waitForCheck(world.rest, sha, 'failed', { signal: ctx.signal, pollMs: ctx.checkPollMs });
  // Workflow reads need Actions permission too: keep them on the person's
  // credential, and allow the workflow to finish after its failed check job.
  const deadline = Date.now() + 5 * 60_000;
  let run: WorkflowRun | undefined;
  for (;;) {
    ctx.signal.throwIfAborted();
    run = (await markerRuns(person, sha)).find((candidate) => candidate.status === 'completed' && candidate.conclusion === 'failure');
    if (run?.status === 'completed') break;
    if (Date.now() >= deadline) throw new EnvBlockedError('the marker workflow did not complete within 5 minutes after its failed check');
    await sleep(2_000, undefined, { signal: ctx.signal });
  }
  await person.request('POST', `/actions/runs/${run.id}/rerun-failed-jobs`);
  ctx.log(`waiting up to 5 minutes for the person-rerun ${CHECK_NAME} check`);
  await waitForCheck(world.rest, sha, 'passed', { signal: ctx.signal, pollMs: ctx.checkPollMs });
  ctx.observations.set('checks.personReruns', Number(ctx.observations.get('checks.personReruns') ?? 0) + 1);
}

/** Age the fixture's durable head timestamp without a ten-minute wall-clock wait. */
export async function ageCheck(ctx: RunContext, args: Record<string, unknown>): Promise<void> {
  const world = live(ctx);
  const git = await ctx.person();
  await git.run(['fetch', '--quiet', 'origin', `refs/heads/${ctx.names.syncBranch}`]);
  const sha = (await git.text(['rev-parse', 'FETCH_HEAD'])).trim();
  const pr = (await world.rest.pullRequests(ctx.names.syncBranch, 'open')).find((pr) => pr.head.ref === ctx.names.syncBranch);
  if (pr === undefined) throw new ProductError('no normal pull request to age');
  const note = `<!-- head: sha=${sha} since=${new Date(Date.now() - Number(args.minutes) * 60_000).toISOString()} -->`;
  const body = (pr.body ?? '').replace(/^<!-- head:.* -->\r?$/gm, '').trimEnd();
  await world.rest.request('PATCH', `/pulls/${pr.number}`, { body: `${body}\n\n${note}\n` });
}
