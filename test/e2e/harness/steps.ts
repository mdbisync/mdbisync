// Step executors: one per `<kind>.<action>` of the spec schema.
//
// git steps commit as a person to the run's tracked branch (or, for the
// sync branch and CI fixes, to the run's sync branch); linear steps edit as
// editor-a or editor-b through their own API keys; run steps start the
// engine or the real workflows; fault steps arm the proxy, the engine's
// checkpoints or a change to the repository that `fault.clear` undoes; ui
// steps are left to the UI session's checklist. Every text a step writes is
// neutral work text with a run token, so I2 can find it on both sides.

import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupKilledTokens } from './token-cleanup.ts';
import { recordRunView, tokenActive, watchesRunViews } from './subjects.ts';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, type CommandName } from '../../../src/commands.ts';
import { LinearError, LinearStoppedError, LinearTokenError, isTransientLinearError } from '../../../src/linear/index.ts';
import { resolveStateConfig, suspendedBranch, Git } from '../../../src/state/index.ts';
import { STOP_AFTER_ENV, type Checkpoint } from '../../../src/test-hooks.ts';
import { BANK_DIR, goldenMarkdownPath, loadBank, probedFixtures, readOptional } from '../../probe/bank.ts';
import { runProbe } from '../../probe/probe.ts';
import { findDrift } from '../../probe/record.ts';
import { INVARIANT_CHECKS, lostEdits, readSides, snapshotRefs, bodyOf } from './checks.ts';
import { isCheckpoint } from './checkpoints.ts';
import { faultChecks, rerunSuspendedCheck, ageCheck } from './check-fault.ts';
import { editParagraph, MARKERS, noteSentence, resolveKeeping } from './conflicts.ts';
import { nextToken, type RunContext } from './context.ts';
import { REPO_ROOT, engineEntry, engineEnv, runEngine, startEngine, type EngineCall, type EngineResult } from './engine.ts';
import { fixtureEdit, paragraphEdit, seededPng, sha256 } from './fixtures.ts';
import { newRunId } from './isolation.ts';
import { fixableSample, hashes, markerLines, offlineInput, parseFindings, readInput, runFormatCommand, writeInput } from './offline.ts';
import { burst, burstDocuments, burstEditCounts, realClock, soak, type Actor, type LoadDriver } from './load.ts';
import { ownedDocuments } from './ownership.ts';
import { EnvBlockedError, HarnessGapError, NotImplementedError, ProductError, runFailure } from './results.ts';
import { commitStaged, HARNESS, hookEnv, installHooks, personCommit } from './sandbox.ts';
import { LINEAR_FORMAT_HOOK, LOCAL_REPOS, PRE_COMMIT_CONFIG, readHookConfig } from '../../../src/setup/hooks.ts';
import { validateSha } from '../../../src/release/package.ts';
import { parse, stringify } from 'yaml';
import { HOOK_REPOSITORY } from '../../corpus/tree.ts';
import type { Step } from './spec.ts';
import { writeError } from './fault-proxy.ts';
import { lfsEndpoint, lfsUrlEnv, startLfsFaultProxy } from './lfs-fault-proxy.ts';
import { quietFailures, snapshotWorld, watchesQuiet, writesBetween } from './quiet.ts';
import {
  commitAsPerson, createHelperProject, documentId, documentPaths, editorEdit, editorOf, folderTeam, live, MOVE_SOURCE_FOLDER, projectFolders, pull, readRunIds, readWorking, resolveDestination, setTarget, sibling, targetPath,
} from './step-helpers.ts';
import type { WorkflowRun } from './github.ts';
import { environmentBlocker, jobSpans, maxOverlap, runLogs, runResult, waitForRegistration, waitForRequestTaken, waitForRun, waitForScheduledRun } from './workflows.ts';
import { CANARY_FIXTURE, canaryFacts } from './security-canary.ts';
import { prerequisiteErrors, readTemplate, renderScheduler, runGroup, runWorkflows, SCHEDULER_FILE, WORKFLOW_FILES, workflowFor } from './workflow-files.ts';

export { documentId, documentPaths, resolveDestination, sibling, targetPath };

export const ENGINE_TIMEOUT_MS = 30 * 60_000;
export const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
/** The longest one `pre-commit run` in a scratch repository may take; its hook environments are built before. */
export const PRE_COMMIT_TIMEOUT_MS = 10 * 60_000;

const execFileAsync = promisify(execFile);
/** The sync's workflow file in a repository. */
export const SYNC_WORKFLOW = WORKFLOW_FILES.sync;
/** The release commit actions mode runs, in place of the templates' pin. */
export const ACTION_SHA_ENV = 'MDBISYNC_TEST_ACTION_SHA';

/** `dispatch` makes the harness start the sandbox's scheduled workflow by hand instead of waiting for GitHub's schedule. */
export const SCHEDULE_TICK_ENV = 'MDBISYNC_TEST_SCHEDULE_TICK';

/**
 * The format probe stopped for a reason in the environment, not in the probe
 * or the product: Linear stopped the client (rate limit, low budget), the
 * app's token could not be minted, or a request did not complete or met a
 * server error. Any other error is a finding and fails the scenario.
 */
export function isProbeEnvironmentError(error: unknown): boolean {
  if (error instanceof LinearStoppedError || error instanceof LinearTokenError) return true;
  return error instanceof LinearError && isTransientLinearError(error);
}

/**
 * How a scheduled sync starts: `schedule`, GitHub's own tick, or
 * `workflow_dispatch`, a tick by hand for a sandbox where GitHub starts no
 * schedule. A tick by hand runs the same jobs and is recorded with its true
 * event, so a scenario that asserts the `schedule` event still fails.
 */
export function scheduleTick(env: NodeJS.ProcessEnv = process.env): 'schedule' | 'workflow_dispatch' {
  const value = env[SCHEDULE_TICK_ENV]?.trim() ?? '';
  if (value === '') return 'schedule';
  if (value === 'dispatch') return 'workflow_dispatch';
  throw new Error(`${SCHEDULE_TICK_ENV} must be empty or "dispatch", not "${value}"`);
}

/** The release commit named by `MDBISYNC_TEST_ACTION_SHA`, or undefined for the templates' own pin. */
export function actionShaUnderTest(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const actionSha = env[ACTION_SHA_ENV]?.trim() ?? '';
  if (actionSha !== '' && !/^[0-9a-f]{40}$/.test(actionSha)) throw new EnvBlockedError(`${ACTION_SHA_ENV} must be a full commit SHA`);
  return actionSha === '' ? undefined : actionSha;
}

type Executor = (ctx: RunContext, args: Record<string, unknown>) => Promise<void>;

const GAPS = new Set<string>();
/** Actions the harness cannot perform yet; their scenarios fail as harness gaps once the engine reaches them. Empty: every action has an executor. */
export const HARNESS_GAPS: ReadonlySet<string> = GAPS;

// --- the engine ----------------------------------------------------------

async function engineCall(ctx: RunContext, command: CommandName, args: Record<string, unknown>): Promise<EngineCall> {
  const world = live(ctx);
  const index = ctx.engine.results.length + (ctx.engine.pending === undefined ? 0 : 1);
  const dir = join(ctx.runDir, `engine-${index}`);
  mkdirSync(dir, { recursive: true });
  const linear = ctx.engine.badCredential === 'linear' ? { linearClientId: world.engineApp.clientId, linearClientSecret: 'not-a-valid-secret' } : { linearClientId: world.engineApp.clientId, linearClientSecret: world.engineApp.clientSecret };
  return {
    command,
    names: ctx.names,
    ...(typeof args.direction === 'string' ? { direction: args.direction } : {}),
    ...(args.confirm === true ? { confirm: true } : {}),
    ...(typeof args.mergeGraceSeconds === 'number' ? { mergeGraceSeconds: args.mergeGraceSeconds } : {}),
    ...(typeof args.checkDeadlineMinutes === 'number' ? { checkDeadlineMinutes: args.checkDeadlineMinutes } : {}),
    cwd: await ctx.engineClone(),
    repository: world.repository,
    extraEnv: { ...ctx.engine.env },
    hooksDir: ctx.checkpoints.dir,
    ...(ctx.engine.badCredential === undefined ? {} : { credentialFault: ctx.engine.badCredential }),
    reportFile: join(dir, 'report.json'),
    summaryFile: join(dir, 'summary.md'),
    linearUrl: ctx.proxy?.url ?? 'https://api.linear.app',
    credentials: {
      ...linear,
      githubToken: ctx.engine.badCredential === 'github' ? 'not-a-valid-token' : world.githubToken,
      ...(world.githubAppLogin === undefined ? {} : { appSlug: world.githubAppLogin.replace(/\[bot\]$/, '') }),
    },
    timeoutMs: ENGINE_TIMEOUT_MS,
    signal: ctx.signal,
  };
}

/** Records an engine result as the scenario's next run. */
function recordResult(ctx: RunContext, result: EngineResult): void {
  ctx.engine.results.push(result);
  const n = ctx.engine.results.length - 1 - ctx.engine.setupRuns;
  ctx.observations.set(`harness.runs.${n}.finishedAt`, Date.now());
  ctx.observations.set(`runs.${n}.exitCode`, result.exitCode);
  if (result.report !== null) for (const [key, value] of Object.entries(result.report)) ctx.observations.set(`runs.${n}.${key}`, value);
}

/** Records an engine result; a "not implemented" answer stops the scenario. */
function settleResult(ctx: RunContext, result: EngineResult): void {
  recordResult(ctx, result);
  ctx.signal.throwIfAborted();
  if (result.notImplemented) throw new NotImplementedError(result.command, 'the engine command');
  if (result.timedOut) throw new ProductError(`${result.command} did not finish within ${ENGINE_TIMEOUT_MS / 60_000} minutes`);
}

/** Starts the engine and waits at `checkpoint`; false (after recording the result) when the engine ended first. */
async function startPaused(ctx: RunContext, call: EngineCall, checkpoint: Checkpoint): Promise<ReturnType<typeof startEngine>> {
  const running = startEngine(call);
  ctx.engine.pending = running;
  const reached = await ctx.checkpoints.waitReached(checkpoint, { timeoutMs: CHECKPOINT_TIMEOUT_MS, exited: running.done });
  if (reached) return running;
  running.kill();
  delete ctx.engine.pending;
  settleResult(ctx, await running.done);
  throw new ProductError(`the engine did not reach checkpoint ${checkpoint}`);
}

/**
 * `lint` or `fix` on an offline input (L0): the outputs the format
 * scenarios assert on, with the expectations of the same input.
 */
async function offlineFormat(ctx: RunContext, command: 'lint' | 'fix', args: Record<string, unknown>): Promise<void> {
  const input = offlineInput(args.input);
  const dir = join(ctx.runDir, `${command}-input`);
  writeInput(dir, input.files);
  // Expectations of this input; the bank's recorded forms only for the files that have one.
  const compared = args.input === 'lint-errors' ? new Set(input.files.keys()) : new Set(input.golden.keys());
  const only = (files: ReadonlyMap<string, string>) => new Map([...files].filter(([path]) => compared.has(path)));
  ctx.observations.set('input.bytes', input.files);
  ctx.observations.set('input.markerBytes', markerLines(input.files));
  ctx.observations.set('golden.linearForm', input.golden);
  ctx.observations.set('corpus.lintErrors', input.lintErrors);
  const passes = command === 'fix' ? Number(args.passes ?? 1) : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    const result = runFormatCommand(command, dir);
    if (result.status === COMMANDS[command].notImplementedExitCode && result.stderr.includes('not implemented')) throw new NotImplementedError(command);
    // 0: nothing to report; 1: findings or fixed files. Anything else (a crash, a signal, a usage error) is no result to compare.
    if (result.status !== 0 && result.status !== 1) throw new ProductError(`${command} exited with ${String(result.status)} on the ${String(args.input)} input`);
    ctx.observations.set(`${command}.exitCode`, result.status);
    if (command === 'lint') {
      const findings = parseFindings(result.stdout);
      ctx.observations.set('lint.leftOut', [...new Set(findings.map((finding) => finding.file))].sort());
      const fields = (['file', 'line', 'rule', 'message'] as const).filter((field) => findings.length > 0 && findings.every((finding) => finding[field] !== '' && !Number.isNaN(finding[field])));
      ctx.observations.set('lint.diagnostics.fields', fields);
      continue;
    }
    const output = readInput(dir, input.files.keys());
    if (pass === 0) {
      // Compared with Linear's recorded form, a file counts without its front matter, which stays in git.
      const reaching = new Map([...output].filter(([path]) => input.golden.has(path)).map(([path, text]) => [path, bodyOf(text)]));
      ctx.observations.set('fix.output', args.input === 'lint-errors' ? only(output) : reaching);
      ctx.observations.set('fix.validOutput', reaching);
      ctx.observations.set('fix.first.bytes', hashes(output));
      ctx.observations.set('fix.markerBytes', markerLines(output));
    } else {
      ctx.observations.set('fix.second.bytes', hashes(output));
    }
  }
}

async function runCommand(ctx: RunContext, command: CommandName, args: Record<string, unknown>): Promise<void> {
  if (ctx.live === null && (command === 'lint' || command === 'fix') && args.input !== undefined) return offlineFormat(ctx, command, args);
  if (ctx.live === null) {
    // Offline commands (lint, fix) run on the fixture bank and the corpus without credentials.
    const result = spawnSync(process.execPath, [engineEntry(), command], { encoding: 'utf8', cwd: ctx.runDir });
    if (result.status === COMMANDS[command].notImplementedExitCode && result.stderr.includes('not implemented')) throw new NotImplementedError(command);
    ctx.observations.set(`${command}.exitCode`, result.status);
    return;
  }
  const call = await engineCall(ctx, command, args);
  if (args.wait === false) {
    // The documents the run owns before this engine starts: a kill takes the ones the engine created from the rest.
    ctx.observations.set('pause.ownedBefore', new Set(ownedDocuments(ctx.owned).keys()));
    if (ctx.engine.pausedAt === undefined) {
      ctx.engine.pending = startEngine(call);
      return;
    }
    await startPaused(ctx, call, ctx.engine.pausedAt);
    ctx.observations.set('pause.reachedAt', Date.now());
    return;
  }
  const trigger = ctx.engine.trigger;
  if (trigger !== undefined) {
    // A fault that happens in the middle of this run: pause, act, go on. The fault's own
    // writes fall inside the run, so this run gives no quiet verdict.
    delete ctx.engine.trigger;
    ctx.checkpoints.pause(trigger.checkpoint);
    const running = await startPaused(ctx, call, trigger.checkpoint);
    await trigger.action();
    ctx.checkpoints.resume(trigger.checkpoint);
    delete ctx.engine.pending;
    settleResult(ctx, await running.done);
    return;
  }
  await watchRun(ctx, { throughProxy: true }, async () => settleResult(ctx, await runEngine(call)));
}

/**
 * Runs one engine invocation and snapshots the world around it as the
 * scenario's assertions need: in a scenario that asserts quiet, before and
 * after it, recording why the run was not quiet (`harness.quiet.<n>`, empty
 * when it was) for the `quiet.<n|last>` subject; in one that asserts on the
 * world right after a run, the view after it (`harness.runView.<n>`) for the
 * `runs.<n|last>.` document subjects.
 */
export async function watchRun(ctx: RunContext, options: { throughProxy: boolean }, run: () => Promise<void>): Promise<void> {
  const quiet = watchesQuiet(ctx);
  const views = watchesRunViews(ctx);
  if (!quiet && !views) return run();
  const before = quiet ? await snapshotWorld(ctx, options) : undefined;
  const count = ctx.engine.results.length;
  await run();
  const result = ctx.engine.results.at(-1);
  if (ctx.engine.results.length !== count + 1 || result === undefined) throw new Error('a watched invocation recorded no single engine run');
  const n = ctx.engine.results.length - 1 - ctx.engine.setupRuns;
  // The quiet window closes first: the slower full view must not widen it.
  if (before !== undefined) {
    const after = await snapshotWorld(ctx, options);
    ctx.observations.set(`harness.quiet.${n}`, quietFailures({ exitCode: result.exitCode, report: result.report, before, after, documentWrites: writesBetween(ctx, before, after) }));
  }
  if (views) await recordRunView(ctx, n);
}

/** Runs the sync until a run changes nothing more (at most `limit` runs). */
async function settle(ctx: RunContext, args: Record<string, unknown> = {}, limit = 4): Promise<void> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (ctx.scenario.setup.fixtures.includes(CANARY_FIXTURE)) await workflowRun(ctx, { event: 'workflow_dispatch' });
    else await runCommand(ctx, 'sync', args);
    const last = ctx.engine.results.at(-1);
    if (last?.report?.['changed'] === false) return;
  }
}

/**
 * The workflow templates of `examples/`, copied into the repository as a
 * deployer copies them and rendered for this run (its branches, refs,
 * concurrency group and the sandbox's runner and secret names), committed
 * as a person would. `MDBISYNC_TEST_ACTION_SHA` names the release commit
 * under test; without it the templates' own pin runs. Only the command's
 * workflow and the pull request check go in: a sync workflow in an initial
 * sync scenario would start on the scenario's own pushes, as a deployer is
 * told to avoid. The rendered initial sync starts on those pushes too, but
 * only to be registered: every job is skipped and its group is separate
 * (workflow-files.ts), and the harness waits for each command's runs by
 * workflow file.
 */
async function installWorkflows(ctx: RunContext, command: CommandName = 'sync'): Promise<void> {
  const installed = (ctx.observations.get('workflows.installed') as string[] | undefined) ?? [];
  const wanted = [workflowFor(command), WORKFLOW_FILES['pre-commit']].filter((file) => !installed.includes(file));
  if (wanted.length === 0) return;
  const git = await ctx.person();
  await pull(git, ctx);
  const actionSha = actionShaUnderTest();
  const files = runWorkflows({
    trackedBranch: ctx.names.trackedBranch,
    syncBranch: ctx.names.syncBranch,
    refPrefix: ctx.names.refPrefix,
    group: runGroup(ctx.names.runId),
    securityCanary: ctx.scenario.setup.fixtures.includes(CANARY_FIXTURE),
    ...(actionSha === undefined ? {} : { actionSha }),
  }, wanted);
  if (files.size === 0) return;
  mkdirSync(join(git.dir, '.github', 'workflows'), { recursive: true });
  for (const [file, text] of files) writeFileSync(join(git.dir, '.github', 'workflows', file), text);
  await git.run(['add', '--all']);
  await git.run(['commit', '--quiet', '--no-verify', '-m', 'Add the sync workflows']);
  await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
  ctx.ownCommits.push((await git.text(['rev-parse', 'HEAD'])).trim());
  ctx.observations.set('workflows.installed', [...installed, ...files.keys()]);
}

async function requireWorkflows(ctx: RunContext, command: CommandName = 'sync'): Promise<void> {
  const world = live(ctx);
  // Check-fault runs may already carry the harness's PR check workflow.
  await installWorkflows(ctx, command);
  const file = workflowFor(command);
  if (!(await world.rest.workflowExists(file, ctx.names.trackedBranch))) {
    throw new NotImplementedError(command, `the workflow template ${file} is not in examples/`);
  }
  if (world.githubTokenSource !== 'app') throw new EnvBlockedError('actions mode needs the GitHub App token');
}

/** A dispatch's inputs: the run's branches and refs are in the rendered workflow already. */
function workflowInputs(args: Record<string, unknown>): Record<string, string> {
  return {
    ...(typeof args.direction === 'string' ? { direction: args.direction } : {}),
    ...(args.command === 'initial-sync' ? { confirm: args.confirm === true ? 'true' : 'false' } : {}),
  };
}

function recordWorkflowRun(ctx: RunContext, run: { id: number; event: string }): void {
  const runs = (ctx.observations.get('workflows.runs') as Array<{ id: number; event: string }> | undefined) ?? [];
  ctx.observations.set('workflows.runs', [...runs, { id: run.id, event: run.event }]);
}

function seenRuns(ctx: RunContext): Set<number> {
  return new Set(((ctx.observations.get('workflows.runs') as Array<{ id: number }> | undefined) ?? []).map((run) => run.id));
}

async function trackedTipOnServer(ctx: RunContext): Promise<string> {
  const git = await ctx.person();
  await git.run(['fetch', '--quiet', 'origin', ctx.names.trackedBranch]);
  return (await git.text(['rev-parse', 'FETCH_HEAD'])).trim();
}

/** Starts (dispatch) or finds (push, pull request) a workflow run, waits for it and records its result as an engine run. */
async function workflowRun(ctx: RunContext, args: Record<string, unknown>): Promise<void> {
  live(ctx);
  const event = typeof args.event === 'string' ? args.event : 'workflow_dispatch';
  const command = (typeof args.command === 'string' ? args.command : 'sync') as CommandName;
  if (event === 'schedule' && command !== 'sync') throw new Error(`run.workflow cannot run ${command} on a schedule: only the sync workflow has one`);
  await requireWorkflows(ctx, command);
  // Only a dispatched or scheduled run starts after the snapshot before it (a scheduled one once the run asks
  // for it). A push or pull request run started on an earlier step and may already have written, so it gives
  // no quiet verdict.
  if (event === 'workflow_dispatch' || event === 'schedule') await watchRun(ctx, { throughProxy: false }, () => startWorkflowRun(ctx, event, command, args));
  else await startWorkflowRun(ctx, event, command, args);
}

async function startWorkflowRun(ctx: RunContext, event: string, command: CommandName, args: Record<string, unknown>): Promise<void> {
  const world = live(ctx);
  let run;
  if (event === 'workflow_dispatch') {
    // The push that installed the workflow registers it (workflow-files.ts).
    const workflow = workflowFor(command);
    const id = await waitForRegistration(world.rest, workflow);
    const after = Date.now();
    await world.rest.dispatchWorkflow(id, ctx.names.trackedBranch, workflowInputs(args));
    run = await waitForRun(world.rest, { branch: ctx.names.trackedBranch, event, after, exclude: seenRuns(ctx), workflow });
  } else if (event === 'push') {
    // The run the latest push to the tracked branch started, of the command's workflow.
    await recordPushRun(ctx, command, await trackedTipOnServer(ctx));
    return;
  } else if (event === 'pull_request') {
    const pr = ctx.observations.get('ci.pullRequest') as { number: number; head: string; openedAt: number } | undefined;
    if (pr === undefined) throw new Error('run.workflow on pull_request needs git.open-pr first');
    run = await waitForRun(world.rest, { branch: ctx.names.syncBranch, event, after: pr.openedAt, exclude: seenRuns(ctx) });
  } else if (event === 'schedule') {
    const after = await requestScheduledRun(ctx);
    run = await waitForScheduledRun(world.rest, { workflow: SCHEDULER_FILE, runId: ctx.names.runId, after, exclude: seenRuns(ctx) });
  } else {
    throw new Error(`run.workflow cannot start a ${event} run`);
  }
  recordWorkflowRun(ctx, run);
  await settleWorkflowRun(ctx, run, command);
}

/**
 * Waits for the sync workflow runs that the deployment starts on its own
 * after the scenario's steps, and records each one as an engine run. A sync
 * run takes in the tracked branch as it was when the run started. So the run
 * that merges the sync pull request leaves the merge commit to the next run,
 * which records it in `linear` without writing anything. In a deployment,
 * the merge's push starts that run (the template's push trigger). In a local
 * scenario, `run.settle` runs it. Without this wait, I6's extra run would
 * record the merge and move `linear`.
 *
 * It first takes every sync push run that no step recorded (an earlier
 * merge's run may still be queued). It then compares the tip with the commit
 * the latest sync run took in, and waits for the tip's push run while they
 * differ. A failed follow-up run fails the scenario, since it is the
 * deployment's run. The follow-up runs count for the request budgets and the
 * canary scan, but they are not the runs that `runs.<n|last>` name. Returns
 * how many runs it recorded.
 */
export async function settleFollowUpRuns(ctx: RunContext, limit = 3): Promise<number> {
  const sync = workflowFor('sync');
  const installed = (ctx.observations.get('workflows.installed') as string[] | undefined) ?? [];
  if (ctx.scenario.mode !== 'actions' || ctx.live === null || !installed.includes(sync)) return 0;
  const after = Number(ctx.observations.get('start.time') ?? 0);
  for (let count = 0; count < limit; count += 1) {
    const unrecorded = (await live(ctx).rest.workflowRuns(ctx.names.trackedBranch))
      .filter((run) => run.event === 'push' && run.path?.split('@')[0] === `.github/workflows/${sync}` && Date.parse(run.created_at) >= after - 5_000 && !seenRuns(ctx).has(run.id))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    let headSha = unrecorded?.head_sha;
    if (headSha === undefined) {
      const tip = await trackedTipOnServer(ctx);
      if (tip === latestTakenTip(ctx)) return count;
      headSha = tip;
    }
    // A follow-up run is the deployment's, not a step's: `runs.<n|last>` keep naming the steps' runs.
    if (!ctx.observations.has('scenario.stepRunsEnd')) ctx.observations.set('scenario.stepRunsEnd', ctx.engine.results.length);
    const run = await recordPushRun(ctx, 'sync', headSha);
    (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined)?.push(await snapshotRefs(ctx));
    const result = ctx.engine.results.at(-1);
    if (result?.exitCode !== 0) throw new ProductError(`the deployment's follow-up push run ${run.id} did not succeed (exit ${String(result?.exitCode)})`);
  }
  ctx.log(`the deployment still had follow-up runs after ${limit}: the checks see it moving`);
  return limit;
}

/** The tracked commit the latest sync run took in: a check run or a failed sync names none. */
function latestTakenTip(ctx: RunContext): string | undefined {
  for (let index = ctx.engine.results.length - 1; index >= 0; index -= 1) {
    const taken = ctx.engine.results[index]?.report?.['capturedTrackedTip'];
    if (typeof taken === 'string') return taken;
  }
  return undefined;
}

/** Waits for the push run of `headSha` of the command's workflow, and records it. */
async function recordPushRun(ctx: RunContext, command: CommandName, headSha: string): Promise<WorkflowRun> {
  const run = await waitForRun(live(ctx).rest, { branch: ctx.names.trackedBranch, event: 'push', after: Number(ctx.observations.get('start.time') ?? 0), exclude: seenRuns(ctx), headSha, workflow: workflowFor(command) });
  recordWorkflowRun(ctx, run);
  await settleWorkflowRun(ctx, run, command);
  return run;
}

/**
 * Asks the sandbox's scheduled workflow for one scheduled sync of this run
 * and returns once a scheduled run has taken the request, with the time
 * before the request. Its job for this run is queued or running then. The
 * scheduled workflow on the default branch must be this template's
 * rendering for the release under test: a run never installs it, since the
 * default branch is every run's (workflow-files.ts).
 */
async function requestScheduledRun(ctx: RunContext): Promise<number> {
  const world = live(ctx);
  // Checked before anything is created: a wrong setting must not leave a request behind.
  const byHand = scheduleTick() === 'workflow_dispatch';
  const wanted = renderScheduler(readTemplate(SYNC_WORKFLOW), actionShaUnderTest());
  const installed = await world.rest.fileText(`.github/workflows/${SCHEDULER_FILE}`);
  if (installed !== wanted) {
    throw new EnvBlockedError(`the sandbox's default branch holds ${installed === undefined ? 'no' : 'another'} ${SCHEDULER_FILE} than the sync template's for the release under test; install it with \`node test/e2e/harness/cli.ts scheduler --install\``);
  }
  const state = await world.rest.workflowState(SCHEDULER_FILE);
  if (state !== 'active') throw new EnvBlockedError(`the sandbox's scheduled workflow ${SCHEDULER_FILE} is ${state ?? 'not registered'}, not active`);
  const tip = await trackedTipOnServer(ctx);
  const after = Date.now();
  await world.rest.createBranch(ctx.names.scheduleRequest, tip);
  try {
    const defaultBranch = byHand ? (await world.rest.request<{ default_branch: string }>('GET', '')).default_branch : '';
    await waitForRequestTaken(world.rest, ctx.names.scheduleRequest, byHand ? { tick: () => world.rest.dispatchWorkflow(SCHEDULER_FILE, defaultBranch, {}) } : {});
  } catch (error) {
    // A request no tick took must not start a sync after the step. When a tick took it just now, the deletion
    // finds nothing: the step goes on to that tick's run rather than leave it writing behind the cleanup.
    if (await world.rest.deleteBranch(ctx.names.scheduleRequest)) throw error;
  }
  return after;
}

/**
 * Records a finished workflow run as an engine run. A proven environment
 * blocker (workflows.ts) stops the scenario at this run, with the run's
 * result and evidence kept: no later step edits Linear or starts another run,
 * and cleanup runs as after any stop. Any other failure is the run's result
 * for the scenario's checks.
 */
async function settleWorkflowRun(ctx: RunContext, run: WorkflowRun, command: CommandName): Promise<void> {
  const world = live(ctx);
  const logs = await runLogs(world.rest, run);
  const result = await runResult(world.rest, run, command, logs);
  if (ctx.scenario.setup.fixtures.includes(CANARY_FIXTURE)) {
    const facts = canaryFacts(result.securityCanary ?? '');
    if (/Security hooks: staged sets checked [1-9][0-9]*,/.test(result.stdout) && facts.length === 0) ctx.observations.set('securityCanary.missing', true);
    const previous = (ctx.observations.get('securityCanary.facts') as unknown[] | undefined) ?? [];
    ctx.observations.set('securityCanary.facts', [...previous, ...facts]);
    const dir = join(ctx.runDir, 'workflows', String(run.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'security-canary.json'), `${JSON.stringify(facts, null, 2)}\n`);
  }
  const blocker = run.conclusion === 'failure' ? environmentBlocker(run, await world.rest.runJobs(run.id), logs, prerequisiteErrors()) : undefined;
  if (blocker === undefined) {
    settleResult(ctx, result);
    return;
  }
  recordResult(ctx, result);
  const dir = join(ctx.runDir, 'workflows', String(run.id));
  mkdirSync(dir, { recursive: true });
  const { id, event, status, conclusion, head_branch, head_sha, html_url, created_at, updated_at } = run;
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ id, event, status, conclusion, head_branch, head_sha, html_url, created_at, updated_at }, null, 2)}\n`);
  writeFileSync(join(dir, 'blocker.json'), `${JSON.stringify(blocker, null, 2)}\n`);
  writeFileSync(join(dir, 'failed-step.txt'), logs.get(blocker.logFile) ?? '');
  ctx.observations.set('workflows.blocker', blocker);
  ctx.log(`first environment blocker: ${blocker.reason}; evidence in ${dir}`);
  throw new EnvBlockedError(blocker.reason);
}

// --- the executors -------------------------------------------------------

function loadDriver(ctx: RunContext, sync: () => Promise<void>): LoadDriver {
  return {
    ...realClock,
    linearEdit: async (actor, path) => {
      await editorEdit(ctx, actor, path, (text, token) => paragraphEdit(text, undefined, token));
    },
    gitEdit: async (paths) => {
      const git = await ctx.person();
      for (let attempt = 0; ; attempt += 1) {
        try {
          await pull(git, ctx);
          const changes = new Map<string, string>();
          const edits: RunContext['edits'] = [];
          for (const path of paths) {
            const token = nextToken(ctx);
            changes.set(path, paragraphEdit(await readWorking(git, path), undefined, token));
            edits.push({ side: 'git', path, token });
          }
          await commitAsPerson(ctx, changes, 'Update the review date');
          // Only an edit that reached the tracked branch counts for I2; a refused push's tokens never did.
          ctx.edits.push(...edits);
          return;
        } catch (error) {
          // The sync may push to the tracked branch between the pull and the push: try again on top of it.
          if (attempt >= 3) throw error;
          await git.run(['reset', '--quiet', '--hard', `origin/${ctx.names.trackedBranch}`], { okCodes: [0, 128] });
        }
      }
    },
    sync,
  };
}

/** Each tracked document's file and Linear content, the versions a load test's edit budget is measured on. */
async function loadCandidates(ctx: RunContext, test: 'burst' | 'soak'): Promise<Map<string, string[]>> {
  const sides = await readSides(ctx);
  const candidates = new Map<string, string[]>();
  for (const path of documentPaths(ctx)) {
    const file = sides.files.get(path);
    const id = sides.ids.get(path)?.id;
    const document = id === undefined ? undefined : sides.documents.get(id);
    if (file === undefined || document === undefined) throw new ProductError(`a ${test} target is missing from the tracked files or recorded Linear documents`);
    candidates.set(path, [file, document.content ?? '']);
  }
  return candidates;
}

/** The widest token a load test can write: git pushes can retry three times, consuming tokens even when their push fails. */
function lastLoadToken(ctx: RunContext, linearEdits: number, gitEdits: number): string {
  return `${ctx.names.runId}-${String(ctx.sequence + linearEdits + 4 * gitEdits).padStart(3, '0')}`;
}

/**
 * The documents left out at write for a linked file over the upload limit, when they are all that keeps an
 * incomplete sync run from completing and the run changed nothing: such a file stays out until git changes it,
 * so another run leaves it out again. An unreadable file (`upload-unreadable`) can become readable with no git
 * change, so a run that still has one resumes. Null otherwise.
 */
export function onlyLeftOutAtWrite(report: Record<string, unknown> | null | undefined): string | null {
  const sync = report?.['sync'] as Record<string, unknown> | null | undefined;
  if (report?.['ok'] !== true || report['changed'] !== false || sync === null || sync === undefined || sync['complete'] !== false) return null;
  const empty = (key: string) => !Array.isArray(sync[key]) || (sync[key] as unknown[]).length === 0;
  if (sync['stopped'] != null || !['failed', 'notAttempted', 'skipped', 'conflicts'].every(empty)) return null;
  const leftOut = Array.isArray(sync['leftOutAtWrite']) ? (sync['leftOutAtWrite'] as Array<{ path?: unknown; rule?: unknown }>) : [];
  if (leftOut.length === 0 || leftOut.some((entry) => entry.rule !== 'upload-too-large')) return null;
  return leftOut.map((entry) => `${String(entry.path)} (${String(entry.rule)})`).join(', ');
}

const RUN: Record<string, Executor> = {
  'run.sync': (ctx, args) => runCommand(ctx, 'sync', args),
  'run.initial-sync': (ctx, args) => runCommand(ctx, 'initial-sync', args),
  // The setup check a deployer runs before the first sync: it reads Linear and the repository and writes nothing.
  // It is a run like the others (`runs.<n>.exitCode`, `runs.<n>.setupChecks`); a failed check is its result, not a stop.
  // A fault armed for the middle of the next run belongs to a sync: the check never reaches its checkpoint.
  'run.check': (ctx) => {
    live(ctx);
    if (ctx.engine.trigger !== undefined || ctx.engine.pausedAt !== undefined) throw new Error('run.check cannot run while a checkpoint fault waits for the next sync run');
    return runCommand(ctx, 'check', {});
  },
  'run.settle': (ctx, args) => settle(ctx, args),
  'run.capture': (ctx) => runCommand(ctx, 'sync', {}),
  'run.lint': (ctx, args) => runCommand(ctx, 'lint', args),
  'run.fix': (ctx, args) => runCommand(ctx, 'fix', args),
  'run.resume-until-complete': async (ctx, args) => {
    // Recovery continues the sync unless the scenario names the initial sync (L1-16).
    const command = args.command === 'initial-sync' ? 'initial-sync' : 'sync';
    // A run that fails the same way twice in a row (a failed setup check, a refused sync) fails so on every
    // resume: stop there and name it. One such failure may be passing (Linear once showed a token no team).
    let previous: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await runCommand(ctx, command, args);
      const report = ctx.engine.results.at(-1)?.report;
      if (report?.['complete'] === true) return;
      const leftOut = onlyLeftOutAtWrite(report);
      if (leftOut !== null) throw new ProductError(`the run changed nothing and only left out at write ${leftOut}; resuming cannot clear it`);
      const stop = runFailure(report);
      if (stop !== null && stop === previous) throw new ProductError(`the run failed twice in a row ${stop}; resuming cannot clear it`);
      previous = stop;
    }
    throw new ProductError('the run did not complete after 20 resumes');
  },
  'run.parallel': async (ctx, args) => {
    const count = typeof args.count === 'number' ? args.count : 2;
    // Each run gets its own checkout, as parallel workflow runs do.
    const world = live(ctx);
    const calls = [];
    for (let index = 0; index < count; index += 1) {
      const call = await engineCall(ctx, 'sync', {});
      const cwd = join(ctx.runDir, `engine-parallel-${index}`);
      if (!existsSync(cwd)) await world.sandbox.clone(ctx.names, cwd);
      calls.push({ ...call, cwd, reportFile: `${call.reportFile}.${index}`, summaryFile: `${call.summaryFile}.${index}` });
    }
    const results = await Promise.all(calls.map((call) => runEngine(call)));
    for (const result of results) settleResult(ctx, result);
  },
  'run.probe': async (ctx) => {
    // The format probe (a test tool, not the engine) writes the fixture bank to
    // Linear as the OAuth app and reads it back; it cleans up its own projects.
    const world = live(ctx);
    const bankDir = ctx.observations.get('probe.bankDir');
    const bank = loadBank(typeof bankDir === 'string' ? bankDir : undefined);
    const index = Number(ctx.observations.get('probe.runs') ?? 0);
    ctx.observations.set('probe.runs', index + 1);
    let run;
    try {
      // The probe's own run-id form, so the probe's sweeper finds a project a killed run left.
      const probeRunId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${newRunId()}`;
      // No limit measurement: the app client refuses over-limit writes itself, so
      // it cannot measure Linear's limits, and the scenarios check forms and drift only.
      run = await runProbe({ client: world.app, bank, runId: probeRunId, facts: false, log: (line) => ctx.log(`probe: ${line}`) });
    } catch (error) {
      if (isProbeEnvironmentError(error)) throw new EnvBlockedError(`format probe could not finish: ${(error as Error).message}`);
      throw error;
    }
    if (run.cleanup.some((line) => line.includes('NOT deleted'))) throw new EnvBlockedError('format probe left a project behind');
    const constructOf = new Map(run.fixtures.map((fixture) => [fixture.file, fixture.construct]));
    const drift = [...new Set(findDrift(bank, run).map((entry) => constructOf.get(entry.file) ?? entry.file))].sort();
    const probed = run.fixtures.filter((fixture) => fixture.refused === undefined && fixture.first !== undefined);
    const golden = new Map(probed.map((fixture) => [fixture.file, readOptional(join(bank.dir, goldenMarkdownPath(fixture.file))) ?? null]));
    ctx.observations.set('probe.firstReadback', new Map(probed.map((fixture) => [fixture.file, fixture.first])));
    ctx.observations.set('probe.secondReadback', new Map(probed.map((fixture) => [fixture.file, fixture.second])));
    ctx.observations.set('golden.linearForm', golden);
    ctx.observations.set('probe.drift', drift);
    ctx.observations.set(`runs.${index}.probe.drift`, drift);
  },
  'run.pre-commit': async (ctx) => {
    const scratch = join(ctx.runDir, 'scratch');
    if (!existsSync(scratch)) throw new Error('run.pre-commit needs git.scratch-hook first');
    const before = spawnSync('git', ['diff', '--no-ext-diff', '--binary'], { cwd: scratch, encoding: 'utf8' }).stdout;
    const result = await runHooks(scratch, ctx.signal);
    const output = result.output;
    if (output.includes('not implemented')) throw new NotImplementedError('fix', 'through the Linear-format hook');
    const after = spawnSync('git', ['diff', '--no-ext-diff', '--binary'], { cwd: scratch, encoding: 'utf8' }).stdout;
    // Stage what the hook fixed, as a person does before the next try.
    spawnSync('git', ['add', '--all'], { cwd: scratch });
    const n = Number(ctx.observations.get('preCommit.runs') ?? 0);
    ctx.observations.set('preCommit.runs', n + 1);
    ctx.observations.set(`hook.runs.${n}.exitCode`, result.status);
    ctx.observations.set(`runs.${n}.exitCode`, result.status);
    ctx.observations.set(`runs.${n}.filesChanged`, before !== after);
    const rule = ctx.observations.get('fixture.rule');
    const named = typeof rule === 'string' && output.includes(rule) ? rule : (/\brule[: ]+([a-z][a-z-]+)/i.exec(output)?.[1] ?? null);
    ctx.observations.set(`runs.${n}.diagnosticRule`, named);
  },
  'run.scan-canaries': async () => {
    // The scan itself is a check (I5) and the subject scan.canaryMatches; this step marks where the scenario asks for it.
  },
  'run.cleanup': async (ctx) => {
    // The action's post step, which runs after every job, killed ones too: it must revoke the run's Linear token (L5-20).
    if (ctx.live !== null) {
      const call = await engineCall(ctx, 'sync', {});
      // On a runner, `main` keeps its token in the step state and the runner hands it to `post`
      // (checked offline in src/action/action.test.ts). The killed run here ran as the command
      // line, which keeps no step state, so the harness hands over the token the proxy saw it mint.
      const killed = (ctx.observations.get('tokens.byOutcome') as Record<string, string[]> | undefined)?.['killed'] ?? [];
      let before = 0;
      for (const token of killed) if (await tokenActive(token)) before++;
      ctx.observations.set('tokens.activeBeforeCleanup', before);
      const output = await cleanupKilledTokens(killed, { cwd: call.cwd, env: engineEnv(call), linearUrl: call.linearUrl });
      ctx.observations.set('cleanup.output', output);
      ctx.observations.set('cleanup.exitCode', 0);
      let after = 0;
      for (const token of killed) if (await tokenActive(token)) after++;
      ctx.observations.set('tokens.activeAfterCleanup', after);
    }
    ctx.observations.set('tokens.seen', [...(ctx.proxy?.tokens() ?? [])]);
  },
  'run.workflow': (ctx, args) => workflowRun(ctx, args),
  'run.workflow-parallel': async (ctx, args) => {
    const world = live(ctx);
    const events = Array.isArray(args.events) ? (args.events as string[]) : ['push', 'workflow_dispatch'];
    await requireWorkflows(ctx);
    // Start every event at once, plus one more when a pending run must be replaced by a newer one.
    const starts = [...events.filter((event) => event !== 'schedule'), ...(args.replacePending === true ? ['workflow_dispatch'] : [])];
    // The install push registered the sync workflow: its push trigger runs on the run's branch.
    const id = await waitForRegistration(world.rest, SYNC_WORKFLOW);
    // GitHub picks a schedule's moment: the others start once a scheduled run has taken the request, beside its job.
    const scheduledAfter = events.includes('schedule') ? await requestScheduledRun(ctx) : undefined;
    const after = Date.now();
    await Promise.all(starts.map(async (event) => {
      if (event === 'push') await loadDriver(ctx, async () => {}).gitEdit([targetPath(ctx)]);
      else await world.rest.dispatchWorkflow(id, ctx.names.trackedBranch, workflowInputs({}));
    }));
    const runs = [];
    if (scheduledAfter !== undefined) {
      const run = await waitForScheduledRun(world.rest, { workflow: SCHEDULER_FILE, runId: ctx.names.runId, after: scheduledAfter, exclude: seenRuns(ctx) });
      runs.push(run);
      recordWorkflowRun(ctx, run);
    }
    for (const event of starts) {
      const run = await waitForRun(world.rest, { branch: ctx.names.trackedBranch, event, after, exclude: new Set([...seenRuns(ctx), ...runs.map((candidate) => candidate.id)]), workflow: SYNC_WORKFLOW });
      runs.push(run);
      recordWorkflowRun(ctx, run);
    }
    ctx.observations.set('workflows.maxActiveInGroup', maxOverlap(await jobSpans(world.rest, runs)));
    for (const run of runs) {
      if (run.conclusion === 'cancelled') continue; // replaced by a newer run of the group
      await settleWorkflowRun(ctx, run, 'sync');
    }
  },
  'run.token-lifecycle': async (ctx, args) => {
    const proxy = ctx.proxy;
    if (proxy === null) throw new Error('token hygiene needs the Linear proxy');
    const outcomes = Array.isArray(args.outcomes) ? (args.outcomes as string[]) : ['success', 'failure', 'killed'];
    const byOutcome: Record<string, string[]> = {};
    for (const outcome of outcomes) {
      const known = new Set(proxy.tokens());
      if (outcome === 'success') {
        await runCommand(ctx, 'sync', {});
      } else if (outcome === 'failure') {
        // Fail document listing after token setup, leaving revocation available.
        proxy.setFaults([{ kind: 'http', operation: 'ListDocuments', status: 500, requestNumber: 1, retryAfterSeconds: null, times: 10_000 }]);
        try {
          await runCommand(ctx, 'sync', {});
          if (ctx.engine.results.at(-1)?.exitCode === 0) throw new Error('the token failure run unexpectedly succeeded');
        } finally {
          proxy.clearFaults();
        }
      } else if (outcome === 'killed') {
        ctx.checkpoints.pause('before-write');
        const running = await startPaused(ctx, await engineCall(ctx, 'sync', {}), 'before-write');
        running.kill();
        ctx.checkpoints.resume('before-write');
        delete ctx.engine.pending;
        ctx.engine.results.push(await running.done);
      }
      byOutcome[outcome] = proxy.tokens().filter((token) => !known.has(token));
    }
    ctx.observations.set('tokens.byOutcome', byOutcome);
  },
  'run.burst': async (ctx, args) => {
    const options = {
      durationMs: Number(args.durationSeconds ?? 900) * 1000,
      linearEditsPerMinute: Number(args.linearEditsPerMinute ?? 50),
      gitPushesPerMinute: Number(args.gitPushesPerMinute ?? 1),
    };
    const counts = burstEditCounts(options);
    const documents = burstDocuments(await loadCandidates(ctx, 'burst'), options, lastLoadToken(ctx, counts.linear, counts.git));
    const result = await burst(loadDriver(ctx, () => runCommand(ctx, 'sync', {})), { ...options, documents });
    ctx.observations.set('report.generatedLinearEdits', result.linearEdits);
    ctx.observations.set('report.generatedGitPushes', result.gitPushes);
  },
  'run.soak': async (ctx, args) => {
    // The sync runs every `scheduleSeconds`. In actions mode the harness starts
    // each run by dispatch, as an external trigger would (a schedule never runs
    // on a run's branch); the report says so.
    const actions = ctx.scenario.mode === 'actions';
    if (actions) await installWorkflows(ctx);
    const sync = actions ? () => workflowRun(ctx, { event: 'workflow_dispatch' }) : () => runCommand(ctx, 'sync', {});
    const driver = {
      ...loadDriver(ctx, sync),
      checkInvariants: async () => {
        const sides = await readSides(ctx);
        const lost = lostEdits(ctx, sides).length;
        const converged = await INVARIANT_CHECKS.I1(ctx, async () => sides);
        const checks = (ctx.observations.get('soak.checks') as Array<{ I1: boolean; lost: number }> | undefined) ?? [];
        ctx.observations.set('soak.checks', [...checks, { I1: converged.ok, lost }]);
        return { lostEdits: lost };
      },
    };
    const options = {
      durationMs: Number(args.durationSeconds ?? 86_400) * 1000,
      scheduleMs: Number(args.scheduleSeconds ?? 300) * 1000,
      invariantIntervalMs: Number(args.invariantIntervalSeconds ?? 3600) * 1000,
      actors: Array.isArray(args.actors) ? (args.actors as Actor[]) : (['editor-a', 'editor-b', 'git'] as Actor[]),
      seed: String(args.randomSeed ?? ctx.names.runId),
    };
    const documents = await loadCandidates(ctx, 'soak');
    const lastToken = (edits: Record<Actor, number>) => lastLoadToken(ctx, edits['editor-a'] + edits['editor-b'], edits.git);
    const result = await soak(driver, { ...options, documents, lastToken });
    ctx.observations.set('report.hourlyInvariantChecks', result.invariantChecks);
    const own = ctx.engine.results.slice(ctx.engine.setupRuns);
    const metrics = (ctx.observations.get('metrics') as Record<string, unknown> | undefined) ?? {};
    metrics.scheduleDelay = Math.max(0, ...result.scheduleDelays);
    metrics.runnerMinutes = Math.round(own.reduce((sum, run) => sum + run.durationMs, 0) / 600) / 100;
    // Tokens are visible to the harness only through its proxy (local runs).
    metrics.activeLinearTokens = actions ? null : ctx.proxy?.tokens().length ?? 0;
    metrics.trigger = actions ? 'dispatch' : 'local';
    metrics.hourlyLostEditsMax = result.lostEdits;
    ctx.observations.set('metrics', metrics);
    ctx.observations.set('soak.maxLostEdits', result.lostEdits);
    // An hourly check that failed fails the soak, even when later runs repaired the state.
    const failed = ((ctx.observations.get('soak.checks') as Array<{ I1: boolean; lost: number }> | undefined) ?? [])
      .flatMap((check, hour) => (check.I1 && check.lost === 0 ? [] : [`hour ${hour + 1}: ${check.I1 ? '' : 'I1 failed, '}${check.lost} edits lost`]));
    if (failed.length > 0) throw new ProductError(`hourly checks failed: ${failed.join('; ')}`);
  },
};

/** The sync branch checked out in a worktree of the person's clone; null when it does not exist. */
async function syncBranchWorktree(ctx: RunContext): Promise<Git | null> {
  const git = await ctx.person();
  const fetched = await git.run(['fetch', '--quiet', 'origin', `refs/heads/${ctx.names.syncBranch}`], { okCodes: [0, 128] });
  if (fetched.code !== 0) return null;
  const dir = join(ctx.runDir, `sync-worktree-${nextToken(ctx)}`);
  await git.run(['worktree', 'add', '--quiet', '--detach', dir, 'FETCH_HEAD']);
  return new Git(dir, live(ctx).sandbox.env(HARNESS));
}

async function commitToSyncBranch(ctx: RunContext, change: (git: Git) => Promise<void>, message: string): Promise<string> {
  const git = await syncBranchWorktree(ctx);
  if (git === null) throw new ProductError('the run has no sync branch');
  try {
    await change(git);
    await git.run(['commit', '--quiet', '--no-verify', '--all', '-m', message]);
    await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${ctx.names.syncBranch}`]);
    return (await git.text(['rev-parse', 'HEAD'])).trim();
  } finally {
    await (await ctx.person()).run(['worktree', 'remove', '--force', git.dir], { okCodes: [0, 128] });
  }
}

/** Files of a merge of three versions, as `git merge-file` makes it (the conflict oracle of L3-08). */
function gitMergeFile(ours: string, base: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-oracle-'));
  try {
    for (const [name, text] of [['ours', ours], ['base', base], ['theirs', theirs]] as const) writeFileSync(join(dir, name), text);
    return spawnSync('git', ['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' }).stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IMAGE_FOLDER = { lfs: 'media', regular: 'inline' } as const;

const GIT: Record<string, Executor> = {
  'git.edit': async (ctx, args) => {
    if (args.workflows === true) await installWorkflows(ctx);
    const git = await ctx.person();
    await pull(git, ctx);
    if (args.fixture === 'many-conflicts') {
      // Conflicting edits of the first paragraph of N documents and clean edits of M others, in one commit.
      const paths = documentPaths(ctx);
      const conflicting = paths.slice(0, Number(args.conflictingDocuments ?? 20));
      const clean = paths.slice(conflicting.length, conflicting.length + Number(args.cleanEdits ?? 100));
      if (conflicting.length + clean.length < Number(args.conflictingDocuments ?? 20) + Number(args.cleanEdits ?? 100)) throw new EnvBlockedError('the slice has too few documents for the conflicts and clean edits');
      const changes = new Map<string, string>();
      const cleanTokens: string[] = [];
      for (const [index, path] of [...conflicting, ...clean].entries()) {
        const token = nextToken(ctx);
        const text = await readWorking(git, path);
        changes.set(path, index < conflicting.length ? editParagraph(text, 0, token) : paragraphEdit(text, undefined, token));
        ctx.edits.push({ side: 'git', path, token });
        if (index >= conflicting.length) cleanTokens.push(token);
      }
      await commitAsPerson(ctx, changes, 'Update the weekly notes');
      ctx.observations.set('conflict.paths', conflicting);
      ctx.observations.set('edits.clean', cleanTokens);
      return;
    }
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    const token = nextToken(ctx);
    const text = await readWorking(git, path);
    const shaped = await fixtureEdit(ctx, args.fixture, 'git', path, text, token);
    const next = shaped?.text ?? paragraphEdit(text, args.target, token);
    const changes = new Map<string, string | Buffer>([[path, next], ...(shaped?.files ?? new Map())]);
    ctx.edits.push({ side: 'git', path, token });
    // Clean edits of other documents in the same commit (L3-02).
    const cleanTokens: string[] = [];
    for (const other of documentPaths(ctx).filter((candidate) => candidate !== path).slice(0, Number(args.cleanEdits ?? 0))) {
      const cleanToken = nextToken(ctx);
      changes.set(other, paragraphEdit(await readWorking(git, other), undefined, cleanToken));
      ctx.edits.push({ side: 'git', path: other, token: cleanToken });
      cleanTokens.push(cleanToken);
    }
    if (cleanTokens.length > 0) ctx.observations.set('edits.clean', cleanTokens);
    if (args.fixture === 'adjacent-paragraphs') ctx.observations.set('fixture.base', bodyOf(text));
    await commitAsPerson(ctx, changes, 'Update the review date');
    // The text as committed: the hooks may have fixed it.
    ctx.observations.set('edited.gitBody', bodyOf(await readWorking(git, path)));
  },
  'git.edit-many': async (ctx, args) => {
    const count = typeof args.documents === 'number' ? args.documents : 10;
    const git = await ctx.person();
    await pull(git, ctx);
    const changes = new Map<string, string>();
    for (const path of documentPaths(ctx).slice(0, count)) {
      const token = nextToken(ctx);
      changes.set(path, paragraphEdit(await readWorking(git, path), undefined, token));
      ctx.edits.push({ side: 'git', path, token });
    }
    await commitAsPerson(ctx, changes, 'Update review dates');
  },
  'git.add': async (ctx, args) => {
    const token = nextToken(ctx);
    if (ctx.live === null) {
      // Offline (L0-08): the file goes into the scratch repository, past the hook.
      const scratch = join(ctx.runDir, 'scratch');
      if (!existsSync(scratch)) throw new Error('git.add offline needs git.scratch-hook first');
      const unfixable = args.fixture === 'unfixable';
      writeFileSync(join(scratch, unfixable ? 'notes.md' : `notes-${token}.md`), unfixable ? '# Notes\n\nSee the note.[^1]\n\n[^1]: Added later.\n' : `# Notes\n\n${noteSentence(token)}\n`);
      if (unfixable) ctx.observations.set('fixture.rule', 'footnote');
      spawnSync('git', ['add', '--all'], { cwd: scratch });
      return;
    }
    const path = typeof args.path === 'string' ? resolveDestination(ctx, targetPath(ctx), args.path) : sibling(targetPath(ctx), `notes-${token}.md`);
    await commitAsPerson(ctx, new Map([[path, `# Notes\n\n${noteSentence(token)}\n`]]), 'Add notes', args.bypassHook === true);
    ctx.edits.push({ side: 'git', path, token });
    ctx.observations.set('git.added', path);
  },
  'git.delete': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    await commitAsPerson(ctx, new Map([[path, null]]), 'Remove an old page');
    ctx.observations.set('git.deleted', path);
  },
  'git.move': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    const git = await ctx.person();
    await ctx.personHooks();
    await pull(git, ctx);
    const destination = typeof args.destination === 'string' ? resolveDestination(ctx, path, args.destination) : sibling(path, `moved-${nextToken(ctx)}.md`);
    mkdirSync(join(git.dir, destination.split('/').slice(0, -1).join('/')), { recursive: true });
    await git.run(['mv', path, destination]);
    await commitStaged(git, [path, destination], 'Move a page', true);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    ctx.ownCommits.push((await git.text(['rev-parse', 'HEAD'])).trim());
    ctx.observations.set('git.moved', { from: path, to: destination });
  },
  'git.copy': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const copy = path.replace(/\.md$/, `-copy-${nextToken(ctx)}.md`);
    await commitAsPerson(ctx, new Map([[copy, await readWorking(git, path)]]), 'Copy a page');
    ctx.observations.set('git.copied', { from: path, to: copy });
  },
  'git.front-matter': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    const token = nextToken(ctx);
    const next = text.startsWith('---\n') ? text.replace(/^---\n/, `---\nreviewed: "${token}"\n`) : `---\nreviewed: "${token}"\n---\n${text}`;
    await commitAsPerson(ctx, new Map([[path, next]]), 'Mark the page reviewed');
  },
  'git.add-footnote': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    await commitAsPerson(ctx, new Map([[path, `${text.replace(/\n*$/, '\n')}\nSee the note.[^1]\n\n[^1]: Added later.\n`]]), 'Add a footnote', args.bypassHook === true);
  },
  'git.remove-footnote': async (ctx) => {
    const path = ctx.observations.get('fixture.leftOut') as string | undefined;
    if (path === undefined) throw new Error('git.remove-footnote needs the left-out document its setup adds');
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    const token = nextToken(ctx);
    const fixed = `${text.replace(/\[\^[^\]]+\](?!:)/g, '').replace(/^\[\^[^\]]+\]:.*\n?/gm, '').replace(/\n*$/, '\n')}\n${noteSentence(token)}\n`;
    await commitAsPerson(ctx, new Map([[path, fixed]]), 'Drop the footnote');
    ctx.edits.push({ side: 'git', path, token });
    ctx.observations.set('git.joined', path);
  },
  'git.move-rewrite': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    setTarget(ctx, path);
    const git = await ctx.person();
    await pull(git, ctx);
    const token = nextToken(ctx);
    const destination = sibling(path, `rewritten-${token}.md`);
    const text = bodyOf(await readWorking(git, path));
    const lines = text.split('\n');
    const keep = Math.floor(lines.length * (1 - Number(args.rewriteFraction ?? 1)));
    const body = [...lines.slice(0, keep), `# Rewritten notes`, '', noteSentence(token), '', 'Everything else on this page was replaced by the new plan.', ''].join('\n');
    await commitAsPerson(ctx, new Map<string, string | null>([[path, null], [destination, body]]), 'Rewrite and move a page');
    ctx.edits.push({ side: 'git', path: destination, token });
    ctx.observations.set('git.moved', { from: path, to: destination });
  },
  'git.move-folder': async (ctx) => {
    const folder = ctx.observations.get('fixture.folder') as { path: string; documents: string[] } | undefined;
    if (folder === undefined) throw new Error('git.move-folder needs the folder its setup prepares');
    const git = await ctx.person();
    await ctx.personHooks();
    await pull(git, ctx);
    const renamed = `${folder.path}-archive`;
    await git.run(['mv', folder.path, renamed]);
    await commitStaged(git, [folder.path, renamed], 'Rename a folder', true);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    ctx.ownCommits.push((await git.text(['rev-parse', 'HEAD'])).trim());
    ctx.observations.set('git.movedFolder', folder.documents.map((path) => ({ from: path, to: `${renamed}${path.slice(folder.path.length)}` })));
  },
  'git.annotation': async (ctx) => {
    // The folder moves to a project of its own team that no folder maps yet: the engine refuses a project
    // of another team (annotation-target-not-found, the folder still inherits its team) and one that another
    // folder already maps (annotation-target-shared). The project is a run helper, so cleanup deletes it.
    const own = projectFolders(ctx)[0];
    if (own === undefined) throw new EnvBlockedError('the slice has no project folder');
    const git = await ctx.person();
    await pull(git, ctx);
    const key = folderTeam(git.dir, own.folder);
    if (key === null) throw new EnvBlockedError(`no annotation names the team of ${own.folder}`);
    const target = await createHelperProject(ctx, 'annotation-target', 'ANNOTATION_TARGET', key);
    const readme = `${own.folder}/README.md`;
    await commitAsPerson(ctx, new Map([[readme, (await readWorking(git, readme)).split(own.project).join(target.name)]]), 'Move the folder to the other project');
    ctx.observations.set('git.annotation', { folder: own.folder, project: target.name });
  },
  'git.image-add': async (ctx, args) => {
    const storage = args.storage === 'regular' ? 'regular' : 'lfs';
    const count = Number(args.documents ?? 1);
    const git = await ctx.person();
    await pull(git, ctx);
    const token = nextToken(ctx);
    const bytes = seededPng(token);
    const documents = documentPaths(ctx).slice(0, count);
    const first = documents[0];
    if (first === undefined) throw new EnvBlockedError('the slice has no document');
    setTarget(ctx, first);
    const image = sibling(first, `${IMAGE_FOLDER[storage]}/diagram-${token}.png`);
    const changes = new Map<string, string | Buffer>([[image, bytes]]);
    for (const path of documents) {
      const relativeImage = [...path.split('/').slice(0, -1).map(() => '..'), image].join('/');
      changes.set(path, `${(await readWorking(git, path)).replace(/\n*$/, '\n')}\n![diagram ${token}](${relativeImage})\n`);
    }
    await commitAsPerson(ctx, changes, 'Add a diagram');
    for (const path of documents) ctx.edits.push({ side: 'git', path, token });
    ctx.observations.set('git.imagePath', image);
    ctx.observations.set('git.imageHash', sha256(bytes));
  },
  'git.image-change': async (ctx) => {
    const git = await ctx.person();
    await pull(git, ctx);
    for (const path of documentPaths(ctx)) {
      const text = await readWorking(git, path);
      const link = [...text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)].map((match) => match[1] as string).find((candidate) => !/^[a-z]+:/i.test(candidate));
      if (link === undefined) continue;
      const image = join(path, '..', decodeURI(link)).replace(/^\.\//, '');
      if (!existsSync(join(git.dir, image))) continue;
      setTarget(ctx, path);
      const bytes = seededPng(nextToken(ctx));
      await commitAsPerson(ctx, new Map([[image, bytes]]), 'Update the diagram');
      ctx.observations.set('git.imagePath', image);
      ctx.observations.set('git.imageHash', sha256(bytes));
      return;
    }
    throw new EnvBlockedError('the slice has no document with an image in the repository');
  },
  'git.delete-refs': async (ctx, args) => {
    const world = live(ctx);
    const stores = Array.isArray(args.names) ? (args.names as string[]) : ['linear', 'ids', 'uploads'];
    await world.sandbox.deleteRunRefs(ctx.names.runId, stores.map((store) => `${ctx.names.refPrefix}/${store}`));
  },
  'git.delete-suspended-branch': async (ctx) => {
    const branch = suspendedBranch(resolveStateConfig(ctx.names));
    await live(ctx).sandbox.deleteRunRefs(ctx.names.runId, [`refs/heads/${branch}`]);
  },
  'git.delete-sync-branch': async (ctx) => {
    await live(ctx).sandbox.deleteRunRefs(ctx.names.runId, [`refs/heads/${ctx.names.syncBranch}`]);
  },
  'git.close-pr': async (ctx) => {
    const world = live(ctx);
    const open = await world.rest.pullRequests(ctx.names.syncBranch, 'open');
    if (open.length === 0) throw new ProductError('no sync pull request is open');
    for (const pr of open) await world.rest.closePullRequest(pr.number);
  },
  'git.open-pr': async (ctx, args) => {
    // A person's pull request with a file the Linear-format hook fixes, for the CI example workflow (L0-09).
    const world = live(ctx);
    if (args.workflows === true) await installWorkflows(ctx);
    const git = await ctx.person();
    await pull(git, ctx);
    const token = nextToken(ctx);
    const folder = projectFolders(ctx)[0]?.folder ?? '';
    const path = `${folder === '' ? '' : `${folder}/`}guides/format-check-${token}.md`;
    const text = args.fixture === 'fixable' ? `${fixableSample().text.replace(/\n*$/, '\n')}\n${noteSentence(token)}\n` : `# Format check\n\n${noteSentence(token)}\n`;
    let commit: string;
    try {
      commit = await personCommit(git, ctx.names, new Map([[path, text]]), 'Add the format check page', { verify: false, branch: ctx.names.syncBranch });
    } finally {
      // The page belongs to the pull request's branch only: never leave it on the person's tracked branch.
      await git.run(['reset', '--quiet', '--hard', `origin/${ctx.names.trackedBranch}`], { okCodes: [0, 128] });
    }
    ctx.ownCommits.push(commit);
    const openedAt = Date.now();
    const pr = await world.rest.openPullRequest(ctx.names.syncBranch, ctx.names.trackedBranch, 'Add the format check page', 'A small page for the weekly review.');
    ctx.observations.set('ci.pullRequest', { number: pr.number, head: commit, openedAt });
  },
  'git.edit-sync-branch': async (ctx) => {
    const path = targetPath(ctx);
    const token = nextToken(ctx);
    const commit = await commitToSyncBranch(ctx, async (git) => {
      writeFileSync(join(git.dir, path), paragraphEdit(readFileSync(join(git.dir, path), 'utf8'), undefined, token));
    }, 'Add a note to the pending changes');
    ctx.edits.push({ side: 'git', path, token });
    ctx.observations.set('syncBranch.personCommit', commit);
  },
  'git.ci-fix': async (ctx, args) => {
    // Fix commits a CI job makes on the sync pull request's branch.
    const path = typeof args.target === 'string' ? targetPath(ctx, args.target) : targetPath(ctx);
    const fixes = Array.isArray(args.fixes) ? (args.fixes as string[]) : ['stable-fix'];
    const commits = (ctx.observations.get('ciFix.commits') as string[] | undefined) ?? [];
    const interleavings = (ctx.observations.get('report.interleavingsCovered') as string[] | undefined) ?? [];
    interleavings.push(ctx.engine.pausedAt === 'after-capture-push-before-pr' ? 'capture-before-fix' : 'fix-before-capture');
    for (const fix of fixes) {
      const token = nextToken(ctx);
      const id = fix === 'linear-would-undo' ? 'aligned-table' : 'stable-fix';
      const addition = fix === 'linear-would-undo'
        // Column alignment, which Linear drops (it keeps `| -- |` separators).
        ? `\n| Check | Result |\n|:--|--:|\n| ${token} | ok |\n`
        // Linear stores a final paragraph without a trailing newline.
        : `\nChecked by the format job, ref ${token}.`;
      commits.push(await commitToSyncBranch(ctx, async (git) => {
        writeFileSync(join(git.dir, path), `${readFileSync(join(git.dir, path), 'utf8').replace(/\n*$/, '\n')}${addition}`);
        // The simulated fixing hook must be configured, as in a real CI job.
        const config = join(git.dir, PRE_COMMIT_CONFIG);
        const text = readFileSync(config, 'utf8');
        if (!readHookConfig(text).hooks.some((hook) => hook.id === id)) {
          const data = parse(text);
          data.repos.push({ repo: 'local', hooks: [{ id, name: 'Format check', language: 'system', entry: 'true' }] });
          writeFileSync(config, stringify(data));
        }
      }, `Apply the format fixes\n\nPre-commit-fix: ${id}`));
      ctx.observations.set(fix === 'linear-would-undo' ? 'ciFix.unstable' : 'ciFix.stable', token);
    }
    ctx.observations.set('ciFix.commits', commits);
    ctx.observations.set('report.interleavingsCovered', interleavings);
  },
  'git.resolve': async (ctx) => {
    const path = targetPath(ctx);
    setTarget(ctx, path);
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    const resolved = resolveKeeping(text, 'git');
    if (resolved === text) throw new ProductError('the tracked branch holds no conflict markers to resolve');
    await commitAsPerson(ctx, new Map([[path, resolved]]), 'Resolve the conflict');
    // The text as committed: the hooks may have fixed it.
    const committed = await readWorking(git, path);
    retireDiscarded(ctx, text, committed);
    ctx.observations.set('resolved.body', bodyOf(committed));
  },
  'git.conflict-again': async (ctx) => {
    const path = targetPath(ctx);
    const git = await ctx.person();
    await pull(git, ctx);
    const token = nextToken(ctx);
    const next = editInsideMarkers(await readWorking(git, path), 'git', token);
    await commitAsPerson(ctx, new Map([[path, next]]), 'Rework the open question');
    ctx.edits.push({ side: 'git', path, token });
  },
  'git.remove-security-hooks': async (ctx) => {
    const git = await ctx.person();
    await pull(git, ctx);
    const file = '.pre-commit-config.yaml';
    if (!existsSync(join(git.dir, file))) throw new EnvBlockedError('the slice has no .pre-commit-config.yaml');
    const text = await readWorking(git, file);
    await commitAsPerson(ctx, new Map([[file, text.replace(/^\s*alias:\s*security\s*$/gm, '')]]), 'Drop the hook alias', true);
  },
  'git.scratch-hook': async (ctx, args) => {
    // A scratch repository whose only Linear-format hook is the one the scenario names:
    // `published`, the corpus's own configuration with the released hook it pins, installed
    // by pre-commit; `source`, a local hook that runs this checkout's command line.
    const source = args.source;
    if (source !== 'published' && source !== 'source') throw new Error(`git.scratch-hook needs source "published" or "source", not ${JSON.stringify(source)}`);
    const scratch = join(ctx.runDir, 'scratch');
    mkdirSync(scratch, { recursive: true });
    spawnSync('git', ['init', '--quiet', scratch]);
    if (source === 'published') {
      const text = await ctx.corpusFile(PRE_COMMIT_CONFIG);
      if (text === null) throw new EnvBlockedError(`the corpus has no ${PRE_COMMIT_CONFIG}, or the sandbox's cache could not fetch it`);
      const pin = publishedHookPin(text);
      ctx.log(`scratch hook: ${LINEAR_FORMAT_HOOK} from ${pin.repo} at ${pin.rev}`);
      // The corpus's file as it is, byte for byte: what a person who copies the corpus gets.
      writeFileSync(join(scratch, PRE_COMMIT_CONFIG), text);
    } else {
      writeFileSync(
        join(scratch, PRE_COMMIT_CONFIG),
        `repos:\n  - repo: local\n    hooks:\n      - id: linear-format\n        name: Linear format\n        entry: node ${engineEntry()} fix\n        language: system\n        files: \\.md$\n`,
      );
    }
    // A file the Linear-format hook fixes, from the fixture bank.
    writeFileSync(join(scratch, 'page.md'), fixableSample().text);
    spawnSync('git', ['add', '--all'], { cwd: scratch });
    // pre-commit fetches the pinned hook and builds its environment now, with no harness secret in sight.
    if (source === 'published') await installHooks(new Git(scratch), { signal: ctx.signal });
    // What the scratch repository holds now, not what was asked for: its configuration names the released hook, or not.
    ctx.observations.set('hook.source', hookSourceOf(readFileSync(join(scratch, PRE_COMMIT_CONFIG), 'utf8')));
  },
};

/**
 * `pre-commit run --all-files` in a scratch repository, without blocking the
 * harness's other workers. The hooks see the allowlisted environment only: a
 * released hook is code from outside this checkout.
 */
async function runHooks(cwd: string, signal: AbortSignal): Promise<{ status: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('pre-commit', ['run', '--all-files'], { cwd, env: hookEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: PRE_COMMIT_TIMEOUT_MS, signal });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; name?: unknown; stdout?: string; stderr?: string };
    if (failure.name === 'AbortError') throw error;
    if (failure.code === 'ENOENT') throw new EnvBlockedError('pre-commit is not installed on this host');
    if (failure.killed === true) throw new ProductError(`pre-commit did not finish within ${PRE_COMMIT_TIMEOUT_MS / 60_000} minutes`);
    if (typeof failure.code === 'number') return { status: failure.code, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    throw error;
  }
}

/** `published` when a pre-commit configuration takes the Linear-format hook from its release, else `source`. */
function hookSourceOf(text: string): 'published' | 'source' {
  try {
    publishedHookPin(text);
    return 'published';
  } catch {
    return 'source';
  }
}

/**
 * The released Linear-format hook a corpus pre-commit configuration pins:
 * exactly one entry defines it, from the project's own repository, at a full
 * commit SHA. A local or pre-commit-defined hook, another repository, a tag,
 * a branch or a placeholder is not the released hook, and the run cannot
 * claim to test it.
 */
export function publishedHookPin(text: string): { repo: string; rev: string } {
  let config: unknown;
  try {
    config = parse(text);
  } catch {
    throw new EnvBlockedError(`the corpus's ${PRE_COMMIT_CONFIG} is not valid YAML`);
  }
  const repos = (config as { repos?: unknown } | null)?.repos;
  const entries = (Array.isArray(repos) ? repos : []) as Array<{ repo?: unknown; rev?: unknown; hooks?: unknown } | null>;
  const owners = entries.filter((entry) => Array.isArray(entry?.hooks) && (entry.hooks as Array<{ id?: unknown } | null>).some((hook) => hook?.id === LINEAR_FORMAT_HOOK));
  if (owners.length !== 1) throw new EnvBlockedError(`the corpus's ${PRE_COMMIT_CONFIG} defines ${LINEAR_FORMAT_HOOK} ${owners.length} times, not once`);
  const owner = owners[0] as { repo?: unknown; rev?: unknown };
  const repo = String(owner.repo);
  if (LOCAL_REPOS.has(repo)) throw new EnvBlockedError(`the corpus's ${PRE_COMMIT_CONFIG} defines ${LINEAR_FORMAT_HOOK} as a ${repo} hook, not the released one`);
  if (repo !== HOOK_REPOSITORY) throw new EnvBlockedError(`the corpus's ${PRE_COMMIT_CONFIG} takes ${LINEAR_FORMAT_HOOK} from ${repo}, not from ${HOOK_REPOSITORY}`);
  try {
    validateSha(String(owner.rev));
    // The corpus generator's offline placeholder: no release has this commit.
    if (/^0+$/.test(String(owner.rev))) throw new Error('placeholder');
  } catch {
    throw new EnvBlockedError(`the corpus's ${PRE_COMMIT_CONFIG} pins ${LINEAR_FORMAT_HOOK} to "${String(owner.rev)}", not a released commit SHA`);
  }
  return { repo, rev: owner.rev as string };
}

/**
 * An edit of the first line of one version inside the markers: `git` edits
 * the tracked branch's version, `linear` Linear's. Both sides editing the
 * same line again makes a new conflict (L3-12); one side alone is an edit
 * inside open markers (L3-11).
 */
export function editInsideMarkers(text: string, version: 'git' | 'linear', token: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(version === 'git' ? MARKERS.git : MARKERS.linear);
  if (start < 0) throw new ProductError('the document holds no conflict markers');
  const line = lines.findIndex((candidate, index) => index > start && candidate.trim() !== '');
  if (line < 0 || Object.values(MARKERS).includes(lines[line] as never)) throw new ProductError('the conflict has an empty version');
  lines[line] = `${(lines[line] as string).replace(/\s+$/, '')} ${noteSentence(token)}`;
  return lines.join('\n');
}

/**
 * Marks the edits a resolution discarded on purpose: their tokens were in
 * the conflicted text and are not in the version kept. I2 then no longer
 * expects them on either side.
 */
export function retireDiscarded(ctx: RunContext, conflicted: string, resolved: string): void {
  for (const edit of ctx.edits) {
    if (!edit.removal && conflicted.includes(edit.token) && !resolved.includes(edit.token)) edit.retired = true;
  }
}

/** A tracked document's current content in Linear, read as an editor. */
async function linearContent(ctx: RunContext, path: string): Promise<{ id: string; content: string; icon: string | null; color: string | null }> {
  const world = live(ctx);
  const id = await documentId(ctx, path);
  const [document] = await world.editors['editor-a'].getDocuments([id], { withContent: true });
  if (document === undefined) throw new ProductError('a recorded document does not exist in Linear');
  return { id, content: document.content ?? '', icon: document.icon, color: document.color };
}

const LINEAR: Record<string, Executor> = {
  'linear.edit': async (ctx, args) => {
    const conflicting = ctx.observations.get('conflict.paths') as string[] | undefined;
    if (args.fixture === 'many-conflicts' && conflicting !== undefined) {
      for (const path of conflicting) await editorEdit(ctx, editorOf(args), path, (text, token) => editParagraph(text, 0, token));
      return;
    }
    const path = targetPath(ctx, args.target);
    await editorEdit(ctx, editorOf(args), path, async (text, token) => args.fixture === 'check-fix' ? `${text}\nApproved for review. ${token}\n` : (await fixtureEdit(ctx, args.fixture, 'linear', path, text, token))?.text ?? paragraphEdit(text, args.target, token));
    if (args.fixture === 'adjacent-paragraphs') {
      const base = ctx.observations.get('fixture.base') as string | undefined;
      const gitBody = ctx.observations.get('edited.gitBody') as string | undefined;
      if (base !== undefined && gitBody !== undefined) ctx.observations.set('oracle.gitMerge', gitMergeFile(gitBody, base, ctx.observations.get('edited.linearBody') as string));
    }
  },
  'linear.edit-many': async (ctx, args) => {
    const count = typeof args.documents === 'number' ? args.documents : 10;
    let paths = documentPaths(ctx);
    if (args.teams === 2) {
      // Spread over the two teams' folders.
      const byTeam = new Map<string, string[]>();
      for (const path of paths) byTeam.set(path.split('/')[0] as string, [...(byTeam.get(path.split('/')[0] as string) ?? []), path]);
      const lists = [...byTeam.values()];
      paths = [];
      for (let index = 0; paths.length < count && lists.some((list) => index < list.length); index += 1) for (const list of lists) if (list[index] !== undefined && paths.length < count) paths.push(list[index] as string);
    }
    if (paths.length < count) throw new EnvBlockedError(`the slice has only ${paths.length} documents; ${count} are required`);
    for (const path of paths.slice(0, count)) await editorEdit(ctx, editorOf(args), path, (text, token) => paragraphEdit(text, undefined, token));
  },
  'linear.repeated-edit': async (ctx, args) => {
    const count = typeof args.count === 'number' ? args.count : 5;
    const path = targetPath(ctx);
    const tokens: string[] = [];
    for (let index = 0; index < count; index += 1) tokens.push(await editorEdit(ctx, editorOf(args), path, (text, token) => paragraphEdit(text, undefined, token)));
    const reachedAt = Number(ctx.observations.get('pause.reachedAt') ?? Date.now());
    ctx.observations.set('race', { reachedAt, resumedAt: Date.now(), tokens });
  },
  'linear.rename': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const id = await documentId(ctx, path);
    setTarget(ctx, path, id);
    const title = String(args.title ?? `notes/renamed-${nextToken(ctx)}`);
    await world.editors[editorOf(args)].updateDocument(id, { title });
    ctx.observations.set('linear.renamed', { from: path, title });
  },
  'linear.trash': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const id = await documentId(ctx, path);
    setTarget(ctx, path, id);
    await world.editors[editorOf(args)].trashDocument(id);
    ctx.observations.set('linear.trashed', path);
    const trashed = (ctx.observations.get('linear.trashedDocuments') as Map<string, string> | undefined) ?? new Map<string, string>();
    trashed.set(path, id);
    const prior = (ctx.observations.get('linear.editsBeforeTrash') as Map<string, Set<string>> | undefined) ?? new Map<string, Set<string>>();
    prior.set(path, new Set(ctx.edits.filter((edit) => edit.path === path).map((edit) => edit.token)));
    ctx.observations.set('linear.editsBeforeTrash', prior);
    ctx.observations.set('linear.trashedDocuments', trashed);
  },
  'linear.restore': async (ctx, args) => {
    const world = live(ctx);
    const trashed = ctx.observations.get('fixture.trashedDocument') as { path: string; id: string } | undefined;
    const path = args.fixture === 'trashed-document' && trashed !== undefined ? trashed.path : targetPath(ctx, args.target);
    const id = args.fixture === 'trashed-document' && trashed !== undefined ? trashed.id : await documentId(ctx, path);
    setTarget(ctx, path, id);
    await world.editors[editorOf(args)].restoreDocument(id);
    (ctx.observations.get('linear.trashedDocuments') as Map<string, string> | undefined)?.delete(path);
    (ctx.observations.get('linear.editsBeforeTrash') as Map<string, Set<string>> | undefined)?.delete(path);
  },
  'linear.create': async (ctx, args) => {
    const world = live(ctx);
    const project = [...world.projects.values()][0];
    if (project === undefined) throw new EnvBlockedError('the slice maps no project');
    const token = nextToken(ctx);
    const title = typeof args.title === 'string' ? args.title : `guides/page-${token}`;
    const characters = typeof args.characters === 'number' ? args.characters : 0;
    const body = characters > 0 ? `${noteSentence(token)}\n\n${'Plain text line. '.repeat(Math.ceil(characters / 17)).slice(0, characters)}\n` : `${noteSentence(token)}\n`;
    const document = await world.editors[editorOf(args)].createDocument({ projectId: project.id }, { id: randomUUID(), title, content: body });
    const folder = projectFolders(ctx).find((candidate) => candidate.project === project.name)?.folder;
    setTarget(ctx, folder === undefined ? `${title}.md` : `${folder}/${title}.md`, document.id);
    ctx.observations.set('linear.created', document.id);
    ctx.edits.push({ side: 'linear', path: title, token });
  },
  'linear.move-project': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const { id } = await linearContent(ctx, path);
    setTarget(ctx, path, id);
    const own = projectFolders(ctx).filter((candidate) => path.startsWith(`${candidate.folder}/`))[0];
    const other = projectFolders(ctx).find((candidate) => candidate.project !== own?.project);
    const project = [...world.projects.values()].find((candidate) => candidate.name === other?.project);
    if (own === undefined || other === undefined || project === undefined) throw new EnvBlockedError('the slice needs a document in a project and a second project');
    await world.editors[editorOf(args)].updateDocument(id, { projectId: project.id });
    ctx.observations.set(MOVE_SOURCE_FOLDER, own.folder);
    ctx.observations.set('expected.destinationPath', [other.folder, path.slice(own.folder.length + 1)].filter((part) => part !== '').join('/'));
  },
  'linear.metadata': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const id = await documentId(ctx, path);
    setTarget(ctx, path, id);
    const editor = world.editors[editorOf(args)];
    const variants = Array.isArray(args.variants) ? (args.variants as string[]) : ['icon', 'color', 'comment'];
    if (variants.includes('icon')) await editor.updateDocument(id, { icon: 'Fire' });
    if (variants.includes('color')) await editor.updateDocument(id, { color: '#f2c94c' });
    if (variants.includes('comment')) {
      const [document] = await editor.getDocuments([id]);
      if (document?.documentContentId) await editor.commentOnDocument(document.documentContentId, 'Looks good to me.');
    }
  },
  'linear.out-of-scope': async (ctx, args) => {
    const world = live(ctx);
    const editor = world.editors[editorOf(args)];
    const variants = Array.isArray(args.variants) ? (args.variants as string[]) : ['unmapped-project', 'trash'];
    for (const [index, variant] of variants.entries()) {
      const path = targetPath(ctx, undefined, index);
      const id = await documentId(ctx, path);
      setTarget(ctx, path, id);
      if (variant === 'unmapped-project') {
        // A run project that no folder names; cleanup deletes it with the run's projects.
        const unmapped = await createHelperProject(ctx, 'unmapped', 'UNMAPPED');
        await editor.updateDocument(id, { projectId: unmapped.id });
      } else if (variant === 'trash') {
        await editor.trashDocument(id);
      }
    }
  },
  'linear.delete-permanently': async (ctx, args) => {
    const world = live(ctx);
    const trashed = ctx.observations.get('fixture.trashedDocument') as { path: string; id: string } | undefined;
    if (trashed === undefined) throw new Error('linear.delete-permanently needs the trashed-document fixture');
    setTarget(ctx, trashed.path, trashed.id);
    try {
      await world.editors[editorOf(args)].request('DeleteDocumentForGood', 'mutation', 'mutation DeleteDocumentForGood($id: String!) { documentDelete(id: $id, permanentlyDelete: true) { success } }', { id: trashed.id });
      ctx.observations.set('fault.documentGone', 'linear');
    } catch {
      // Linear's API cannot delete a document for good: the engine, which reaches Linear only
      // through the proxy, is told what Linear answers for such a document.
      if (ctx.proxy === null) throw new EnvBlockedError('Linear\'s API cannot delete a document for good and the run has no proxy');
      ctx.proxy.setFaults([{ kind: 'document-gone', id: trashed.id }]);
      ctx.observations.set('fault.documentGone', 'proxy');
    }
  },
  'linear.image-add': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const editor = world.editors[editorOf(args)];
    await editorEdit(ctx, editorOf(args), path, async (text, token) => {
      const upload = await editor.uploadFile({ filename: `diagram-${token}.png`, contentType: 'image/png', bytes: new Uint8Array(seededPng(token)) });
      ctx.observations.set('linear.imageUrl', upload.assetUrl);
      return `${text.replace(/\n*$/, '\n')}\n${noteSentence(token)}\n\n![diagram](${upload.assetUrl})\n`;
    });
    ctx.observations.set('linear.imageCapturedAtRequest', ctx.proxy?.requests.length ?? 0);
  },
  'linear.rich-edit': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const constructs = Array.isArray(args.constructs) ? (args.constructs as string[]) : ['table', 'mermaid', 'task-list'];
    await editorEdit(ctx, editorOf(args), path, (text, token) => {
      const blocks = [noteSentence(token)];
      if (constructs.includes('table')) blocks.push(`| Item | Owner |\n| -- | -- |\n| Budget ${token} | Ana |`);
      if (constructs.includes('mermaid')) blocks.push('```mermaid\nflowchart LR\n  Plan --> Review\n```');
      if (constructs.includes('task-list')) blocks.push(`- [ ] Send the notes ${token}\n- [x] Book the room`);
      return `${text.replace(/\n*$/, '\n')}\n${blocks.join('\n\n')}\n`;
    });
    // What Linear made of it: the form git must end up with.
    const [document] = await world.editors['editor-a'].getDocuments([await documentId(ctx, path)], { withContent: true });
    ctx.observations.set('golden.linearForm', document?.content ?? null);
  },
  'linear.resolve': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    await editorEdit(ctx, editorOf(args), path, (text) => {
      const resolved = resolveKeeping(text, 'linear');
      if (resolved === text) throw new ProductError('the document holds no conflict markers to resolve');
      ctx.observations.set('resolved.body', resolved);
      retireDiscarded(ctx, text, resolved);
      return resolved;
    });
  },
  'linear.remove-one-marker': async (ctx, args) => {
    await editorEdit(ctx, editorOf(args), targetPath(ctx, args.target), (text) => {
      if (!text.split('\n').includes(MARKERS.end)) throw new ProductError('the document holds no end marker');
      return text.split('\n').filter((line) => line !== MARKERS.end).join('\n');
    });
  },
  'linear.edit-inside-markers': async (ctx, args) => {
    await editorEdit(ctx, editorOf(args), targetPath(ctx, args.target), (text, token) => editInsideMarkers(text, 'linear', token));
  },
  'linear.conflict-again': async (ctx, args) => {
    // The same line as git.conflict-again: the first line of the git version.
    await editorEdit(ctx, editorOf(args), targetPath(ctx, args.target), (text, token) => editInsideMarkers(text, 'git', token));
  },
  'linear.remove-secret': async (ctx, args) => {
    const world = live(ctx);
    const secret = ctx.observations.get('secret.value') as string | undefined;
    const path = ctx.observations.get('secret.path') as string | undefined;
    if (secret === undefined || path === undefined) throw new Error('linear.remove-secret needs an edit with the fake-secret fixture first');
    // How the blocked document looks before alice fixes it (L2-35).
    const { id, icon, color } = await linearContent(ctx, path);
    ctx.observations.set('blocked.icon', icon);
    ctx.observations.set('blocked.color', color);
    const data = await world.app.request<{ document: { comments: { nodes: Array<{ body: string }> } } | null }>(
      'BlockedComments', 'query', 'query BlockedComments($id: String!) { document(id: $id) { comments(first: 100) { nodes { body } } } }', { id },
    );
    ctx.observations.set('blocked.comments', (data.document?.comments.nodes ?? []).map((comment) => comment.body));
    await editorEdit(ctx, editorOf(args), path, (text) => text.replace(` Access key ${secret}.`, ''));
  },
};

function http(ctx: RunContext): NonNullable<RunContext['proxy']> {
  if (ctx.proxy === null) throw new Error('this fault needs the Linear proxy');
  return ctx.proxy;
}

/** Commits a change to a file and registers the commit that puts it back for `fault.clear`. */
async function changeUntilClear(ctx: RunContext, path: string, change: (text: string) => string, message: string): Promise<void> {
  const git = await ctx.person();
  await pull(git, ctx);
  const original = await readWorking(git, path);
  const next = change(original);
  if (next === original) throw new Error(`the fault found nothing to change in ${path}`);
  await commitAsPerson(ctx, new Map([[path, next]]), message, true);
  ctx.engine.restores.push(async () => {
    await commitAsPerson(ctx, new Map([[path, original]]), 'Put the setting back', true);
  });
}

const FAULT: Record<string, Executor> = {
  'fault.pause': async (ctx, args) => {
    if (!isCheckpoint(args.checkpoint)) throw new Error(`unknown checkpoint ${String(args.checkpoint)}`);
    ctx.checkpoints.pause(args.checkpoint);
    ctx.engine.pausedAt = args.checkpoint;
  },
  'fault.resume': async (ctx) => {
    const pending = ctx.engine.pending;
    if (ctx.engine.pausedAt !== undefined) ctx.checkpoints.resume(ctx.engine.pausedAt);
    delete ctx.engine.pausedAt;
    if (pending !== undefined) {
      delete ctx.engine.pending;
      settleResult(ctx, await pending.done);
    }
  },
  'fault.clear': async (ctx) => {
    ctx.proxy?.clearFaults();
    ctx.engine.env = {};
    // An engine already started through the LFS proxy goes on through it; the run closes it at its end.
    ctx.engine.lfsProxy?.clear();
    delete ctx.engine.badCredential;
    delete ctx.engine.trigger;
    for (const restore of ctx.engine.restores.splice(0).reverse()) await restore();
  },
  'fault.http': async (ctx, args) => {
    if (args.target !== undefined && args.target !== 'graphql' && args.target !== 'oauth') throw new Error('unknown HTTP fault target');
    if (args.target === 'oauth' && args.operation !== undefined) throw new Error('OAuth faults cannot select a GraphQL operation');
    http(ctx).setFaults([{
      kind: 'http',
      target: args.target === 'oauth' ? 'oauth' : 'graphql',
      ...(typeof args.operation === 'string' ? { operation: args.operation } : {}),
      status: Number(args.status),
      requestNumber: typeof args.requestNumber === 'number' ? args.requestNumber : 1,
      retryAfterSeconds: typeof args.retryAfterSeconds === 'number' ? args.retryAfterSeconds : null,
      times: typeof args.times === 'number' ? args.times : 1,
    }]);
  },
  'fault.write-error': async (ctx, args) => {
    const variants = Array.isArray(args.variants) ? (args.variants as string[]) : ['server-error'];
    http(ctx).setFaults(variants.map((variant) => writeError(variant)));
  },
  'fault.budget-headers': async (ctx, args) => {
    http(ctx).setFaults([{ kind: 'budget-headers', remaining: typeof args.remaining === 'number' ? args.remaining : 10, includeEndpointLimits: args.includeEndpointLimits === true }]);
  },
  'fault.reject-document': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    // A create names the document by its title; an update of an existing one may carry only its id.
    const id = (await readRunIds(ctx))?.get(path)?.id;
    if (id === undefined && ['converged', 'conflicted'].includes(ctx.scenario.setup.state)) {
      throw new ProductError('the engine recorded no id for the document to reject, though the run started converged');
    }
    const name = path.replace(/\.md$/, '').split('/').pop() as string;
    http(ctx).setFaults([{ kind: 'reject-document', ids: id === undefined ? [] : [id], titles: [name] }]);
  },
  'fault.upload-error': async (ctx) => {
    http(ctx).setFaults([{ kind: 'upload-error', times: 1 }]);
  },
  'fault.budget': async (ctx, args) => {
    ctx.engine.env[STOP_AFTER_ENV] = String(args.stopAfterDocuments ?? 80);
  },
  'fault.credentials': async (ctx, args) => {
    if (args.valid === true) delete ctx.engine.badCredential;
    else ctx.engine.badCredential = args.service === 'github' ? 'github' : 'linear';
  },
  'fault.permissions': async () => {
    throw new EnvBlockedError('needs a second GitHub App without a permission; the harness does not create GitHub Apps');
  },
  'fault.merge-policy': async () => {
    throw new EnvBlockedError('needs the sandbox to refuse merge commits; the harness does not change repository settings');
  },
  'fault.checks': faultChecks,
  'fault.check-age': ageCheck,
  'git.rerun-suspended-check': rerunSuspendedCheck,
  'fault.stale-lease': async (ctx, args) => {
    // Someone else moves a state ref while the run is between its reads and its atomic push.
    const store = typeof args.ref === 'string' ? args.ref : 'ids';
    const ref = `${ctx.names.refPrefix}/${store}`;
    ctx.engine.trigger = {
      checkpoint: 'after-write-before-record',
      action: async () => {
        const git = await ctx.person();
        await git.run(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
        const tip = (await git.text(['rev-parse', ref])).trim();
        const tree = (await git.text(['rev-parse', `${tip}^{tree}`])).trim();
        const moved = (await git.text(['commit-tree', tree, '-p', tip, '-m', 'Unrelated update'])).trim();
        await git.run(['push', '--quiet', '--no-verify', 'origin', `${moved}:${ref}`]);
        ctx.observations.set('fault.staleLease', { ref: store, from: tip, to: moved });
      },
    };
  },
  'fault.hooks': async (ctx, args) => {
    if (args.linearFormat !== false) return;
    // The repository's pre-commit configuration without the Linear-format hook.
    await changeUntilClear(ctx, '.pre-commit-config.yaml', (text) => {
      const blocks = text.split(/(?=^ {2}- repo:)/m);
      return blocks.filter((block) => !/^\s*- id: linear-format\s*$/m.test(block)).join('');
    }, 'Drop the format hook');
  },
  'fault.annotation-target': async (ctx, args) => {
    const world = live(ctx);
    const variants = Array.isArray(args.variants) ? (args.variants as string[]) : ['missing-team', 'missing-project'];
    if (variants.includes('renamed-team')) throw new EnvBlockedError('renaming a team changes it for every run in the workspace; the harness does not change shared teams');
    const git = await ctx.person();
    await pull(git, ctx);
    if (variants.includes('missing-team')) {
      const readme = [...world.tree.teamZones.values()].map((folder) => `${folder.split('/').slice(0, -1).join('/')}/README.md`.replace(/^\//, ''))[0];
      const key = 'QZX';
      if (readme === undefined || !existsSync(join(git.dir, readme))) throw new EnvBlockedError('the slice has no team-zone annotation');
      if (world.teams.has(key)) throw new Error('the made-up team key exists');
      await changeUntilClear(ctx, readme, (text) => text.replace(/^linear-team:\s*\S+/m, `linear-team: ${key}`), 'Point the folder at another team');
    }
    if (variants.includes('missing-project')) {
      const folder = projectFolders(ctx)[0];
      if (folder === undefined) throw new EnvBlockedError('the slice has no project folder');
      await changeUntilClear(ctx, `${folder.folder}/README.md`, (text) => text.split(folder.project).join(`Retired plans ${ctx.names.runId}`), 'Point the folder at another project');
    }
    if (variants.includes('renamed-project')) {
      const folder = projectFolders(ctx).at(-1);
      const project = [...world.projects.values()].find((candidate) => candidate.name === folder?.project);
      if (project === undefined) throw new EnvBlockedError('the slice has no project to rename');
      const rename = (name: string) => world.world.client.request('RenameProject', 'mutation', 'mutation RenameProject($id: String!, $name: String!) { projectUpdate(id: $id, input: { name: $name }) { success } }', { id: project.id, name });
      await rename(`${project.name} old`);
      ctx.engine.restores.push(async () => {
        await rename(project.name);
      });
    }
  },
  'fault.missing-lfs-object': async (ctx) => {
    // The image changes to an LFS object the engine cannot download. GitHub refuses a push whose pointer names an
    // object it never received, so the object is uploaded with the push and the engine's clone reaches the LFS
    // server through a local proxy that answers 404 for that one object.
    const world = live(ctx);
    const image = ctx.observations.get('git.imagePath') as string | undefined;
    if (image === undefined) throw new Error('fault.missing-lfs-object needs git.image-add first');
    const bytes = seededPng(`missing ${nextToken(ctx)}`);
    const oid = sha256(bytes);
    const commit = await commitAsPerson(ctx, new Map([[image, bytes]]), 'Update the diagram', true);
    const pointer = await (await ctx.person()).run(['cat-file', 'blob', `${commit}:${image}`]);
    if (!pointer.stdout.toString('latin1').includes(`oid sha256:${oid}\n`)) throw new Error(`${image} is not stored in LFS`);
    const engine = new Git(await ctx.engineClone());
    const upstream = await lfsEndpoint(engine);
    if (upstream === null) throw new EnvBlockedError('the sandbox has no LFS server to pass on to');
    // The engine's own GitHub credential at the time of each request, as the engine would send it.
    const authorization = () => `basic ${Buffer.from(`x-access-token:${ctx.engine.badCredential === 'github' ? 'not-a-valid-token' : world.githubToken}`).toString('base64')}`;
    await ctx.engine.lfsProxy?.close();
    ctx.engine.lfsProxy = await startLfsFaultProxy(upstream, authorization, new Set([oid]));
    ctx.engine.env = { ...ctx.engine.env, ...lfsUrlEnv(ctx.engine.lfsProxy.url, ctx.engine.env) };
    ctx.observations.set('fault.missingLfsOid', oid);
  },
  'fault.golden-drift': async (ctx, args) => {
    // A recorded Linear form edited by hand, in a copy of the bank, so the next probe must report drift.
    const copy = join(ctx.runDir, 'bank');
    cpSync(BANK_DIR, copy, { recursive: true });
    const construct = String(args.construct ?? 'table');
    // The probe reports drift by construct, so the edited fixture's construct must be exactly the one asked for.
    // Only fixtures the probe writes have a recorded Linear form.
    const fixture = probedFixtures(loadBank(copy)).find((candidate) => candidate.construct === construct && existsSync(join(copy, goldenMarkdownPath(candidate.file))));
    // A construct no probed fixture has is a mistake in the scenario, not in the environment.
    if (fixture === undefined) throw new Error(`no recorded Linear form for a ${construct} fixture`);
    const golden = join(copy, goldenMarkdownPath(fixture.file));
    writeFileSync(golden, `${readFileSync(golden, 'utf8')}\nEdited by hand.\n`);
    ctx.observations.set('probe.bankDir', copy);
  },
};

const OTHER: Record<string, Executor> = {
  'kill.engine': async (ctx, args) => {
    const pending = ctx.engine.pending;
    if (pending === undefined || !isCheckpoint(args.checkpoint)) throw new Error('kill needs a paused asynchronous run');
    // The documents Linear confirmed creating for the paused engine, by their exact ids from the run's ownership
    // record (the proxy writes each answer there before the engine sees it), read before the kill.
    const before = ctx.observations.get('pause.ownedBefore') as Set<string> | undefined;
    if (before === undefined) throw new Error('kill needs the documents the run owned before the engine started');
    ctx.observations.set('kill.created', [...ownedDocuments(ctx.owned)].filter(([id, confirmed]) => confirmed && !before.has(id)).map(([id]) => id));
    pending.kill();
    delete ctx.engine.pending;
    ctx.checkpoints.resume(args.checkpoint as Checkpoint);
    delete ctx.engine.pausedAt;
    const result = await pending.done;
    ctx.engine.results.push(result);
    ctx.observations.set(`runs.${ctx.engine.results.length - 1 - ctx.engine.setupRuns}.killed`, true);
    await recordRunView(ctx, ctx.engine.results.length - 1 - ctx.engine.setupRuns);
  },
  'merge.pull-request': async (ctx) => {
    // A person merges the sync pull request (Linear → git initial sync).
    const world = live(ctx);
    const [pr] = await world.rest.pullRequests(ctx.names.syncBranch, 'open');
    if (pr === undefined) throw new ProductError('no sync pull request is open to merge');
    const merged = await world.rest.mergePullRequest(pr.number);
    ctx.observations.set('merge.commit', merged.sha);
  },
};

const UI_ACTIONS = [
  'ui.assert-dom', 'ui.inspect-blocked', 'ui.inspect-conflict', 'ui.inspect-rendering', 'ui.paste-image',
  'ui.rename-trash-restore', 'ui.resolve-markers', 'ui.type-during-write', 'ui.type-two-editors', 'ui.verify-editor',
];

/** Every step action the schema knows, with its executor. UI steps are run by the UI session, not here. */
export const STEP_ACTIONS: Record<string, Executor> = {
  ...RUN,
  ...GIT,
  ...LINEAR,
  ...FAULT,
  ...OTHER,
  ...Object.fromEntries(UI_ACTIONS.map((action) => [action, async () => {
    throw new EnvBlockedError('UI steps run in the UI session from its checklist');
  }])),
};

/**
 * Marks the edits of a document that the version kept no longer holds, when
 * a person resolved its conflict in the UI: the harness did not see the
 * conflicted text, but the conflict's edits are the document's own, and the
 * ones missing from the kept version were discarded on purpose. I2 then no
 * longer expects them.
 */
export function retireMissingFrom(ctx: Pick<RunContext, 'edits'>, path: string, kept: string): void {
  for (const edit of ctx.edits) {
    if (edit.path === path && !edit.removal && !kept.includes(edit.token)) edit.retired = true;
  }
}

/** What the harness does once the UI session answered a UI step with pass. */
const UI_AFTERMATH: Record<string, Executor> = {
  // The session kept one version of the conflict: the other version's edits are gone on purpose.
  'ui.resolve-markers': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    retireMissingFrom(ctx, path, (await linearContent(ctx, path)).content);
  },
};

export async function afterUiStep(ctx: RunContext, step: Step): Promise<void> {
  await UI_AFTERMATH[`${step.kind}.${step.action}`]?.(ctx, step.args);
}

export async function runStep(ctx: RunContext, step: Step): Promise<void> {
  const executor = STEP_ACTIONS[`${step.kind}.${step.action}`];
  if (executor === undefined) throw new HarnessGapError(`${step.kind}.${step.action}`);
  await executor(ctx, step.args);
}

export { snapshotRefs };
