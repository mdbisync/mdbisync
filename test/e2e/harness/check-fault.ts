// Check runs belong to Actions: the harness only writes the branch marker
// and reads the resulting check. It never needs checks:write.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Git } from '../../../src/state/index.ts';
import { CHECK_MARKER, CHECK_NAME, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import type { RunContext } from './context.ts';
import type { SandboxRest } from './github.ts';
import { nextToken } from './context.ts';
import { EnvBlockedError, HarnessGapError, ProductError } from './results.ts';
import { HARNESS } from './sandbox.ts';
import { live } from './step-helpers.ts';

export type CheckState = 'pending' | 'failed' | 'passed';

/** Wait for this workflow's check on this exact head, never an unrelated check. */
export async function waitForCheck(
  rest: SandboxRest, sha: string, state: CheckState,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const { check_runs: runs } = await rest.request<{ check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; app?: { slug: string } }> }>(
      'GET', `/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    );
    const check = runs.filter((run) => run.name === CHECK_NAME && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0];
    const actual = check === undefined ? 'absent' : check.status !== 'completed' ? 'pending'
      : check.conclusion === 'success' ? 'passed' : check.conclusion === 'failure' ? 'failed' : check.conclusion;
    if (actual === state) return;
    if (Date.now() >= deadline) {
      if (check === undefined) throw new ProductError(`no ${CHECK_NAME} check appeared on the marker commit`);
      throw new EnvBlockedError(`the ${CHECK_NAME} check did not reach ${state} on the marker commit (last state: ${actual})`);
    }
    await sleep(options.pollMs ?? 2_000, undefined, { signal: options.signal });
  }
}

export async function faultChecks(ctx: RunContext, args: Record<string, unknown>): Promise<void> {
  const state = args.status;
  if (state !== 'pending' && state !== 'failed' && state !== 'passed') throw new Error('invalid check status');
  if (args.name !== undefined && args.name !== CHECK_NAME) throw new Error(`the marker workflow provides only the ${CHECK_NAME} check`);
  const world = live(ctx);
  const person = await ctx.person();
  const ref = `refs/heads/${ctx.names.syncBranch}`;
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
    if (state === 'passed') await git.run(['rm', '--quiet', '--ignore-unmatch', '--', CHECK_MARKER]);
    else {
      writeFileSync(join(dir, CHECK_MARKER), `${state}\n`);
      await git.run(['add', '--', CHECK_MARKER]);
    }
    await git.run(['commit', '--quiet', '--no-verify', '--allow-empty', '-m', `Set check state to ${state}`]);
    sha = (await git.text(['rev-parse', 'HEAD'])).trim();
    await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:${ref}`]);
    ctx.ownCommits.push(sha);
  } finally {
    await person.run(['worktree', 'remove', '--force', dir]);
  }
  const prs = await world.rest.pullRequests(ctx.names.syncBranch, 'open');
  if (!prs.some((pr) => pr.head.ref === ctx.names.syncBranch && pr.base.ref === ctx.names.trackedBranch)) {
    // A check fault is a fixture of an already waiting PR. Seeding it lets
    // the workflow run before the scenario's first sync; it does not test
    // the product's ability to create a PR.
    await world.rest.openPullRequest(ctx.names.syncBranch, ctx.names.trackedBranch, 'Update documents', 'Review the latest document changes.');
  }
  ctx.log(`waiting up to 5 minutes for ${CHECK_NAME} to reach ${state}`);
  await waitForCheck(world.rest, sha, state, { signal: ctx.signal });
  ctx.observations.set('fault.checks', { name: CHECK_NAME, state, sha });
}
