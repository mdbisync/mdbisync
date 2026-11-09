// Takes up a run held for its UI steps with the UI session's answers
// (`cli.ts ui-result <run folder> <answered checklist>`).
//
// The run goes on from the step where it stopped. Each UI step needs its
// item answered: `pass` lets the run go on, `fail` ends it as a product
// failure. The harness runs the steps between the answered items (for
// example `run.settle`). When it reaches an item that is not answered yet,
// it saves the run again and keeps the hold, so the session can answer the
// next items and hand the checklist back once more. When every step has run,
// it runs the scenario's checks with the session's `ui.*` values, and the
// result (pass, fail or expected-red) replaces the run's env-blocked one.
// A run that ends, whatever its result, is cleaned up and its hold released.
//
// Problems before any step runs (a hold that ended, a checklist that does
// not fit the scenario, missing values, a configuration that cannot reach
// the run) change nothing: the run stays held and nothing is recorded.

import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LiveWorld, RunContext } from './context.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { BudgetBlockedError, estimate } from './governor.ts';
import { githubToken } from './github.ts';
import { forgetHeldRun, heldRunOf, loadHeldRun, saveHeldRun, type HeldRun } from './held-run.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { updateStatusPage, writeEvidence, writeRunReport, type HarnessReport } from './report.ts';
import { classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import {
  captureCanaryEvidence,
  checksHold,
  cleanupAndCount,
  createRunContext,
  liveWorld,
  resultOf,
  retainPendingOutput,
  takeTeamLocks,
  type RunnerDeps,
} from './runner.ts';
import { Sandbox } from './sandbox.ts';
import type { Scenario, Step } from './spec.ts';
import { runStep } from './steps.ts';
import { snapshotRefs } from './checks.ts';
import { uiValueSubjects, type UiAnswers } from './ui-checklist.ts';

export interface UiResultDeps extends Omit<RunnerDeps, 'outDir'> {
  /** Makes the held run's live world again; by default from the test configuration. */
  attach?: (held: HeldRun, deps: UiResultDeps) => Promise<LiveWorld>;
  /** Runs one harness step; by default the harness's own. */
  runStep?: (ctx: RunContext, step: Step) => Promise<void>;
}

export type UiResultOutcome =
  /** Steps ran up to an item that is not answered yet; the run stays held. */
  | { state: 'waiting'; ran: string[]; nextItem: number }
  /** The run ended: its result, and the run is cleaned up. */
  | { state: 'done'; ran: string[]; result: Omit<ScenarioResult, 'harnessAppRequests'> };

/** The run's report folder: run folders are `<report folder>/runs/<scenario>-<run>`. */
export function reportDirOf(runDir: string): string {
  return dirname(dirname(runDir));
}

/** The default `attach`: tokens, the sandbox and the Linear clients made again for the held run. */
export async function attachHeldRun(held: HeldRun, deps: UiResultDeps): Promise<LiveWorld> {
  const { config } = deps;
  if (config.missing.length > 0) throw new EnvBlockedError(`test configuration is missing: ${config.missing.join(', ')}`);
  const token = await githubToken(config, 'local');
  const sandbox = new Sandbox({ url: config.gitUrl, token: token.token, stateDir: deps.stateDir, runId: held.runId });
  await sandbox.refreshCache();
  const live = await liveWorld(deps, held.appName, { sandbox, token, manifest: held.live.manifest, tree: held.live.tree });
  live.projects = held.live.projects;
  live.teams = held.live.teams;
  live.seededDocuments = held.live.seededDocuments;
  live.documentUrlBase = held.live.documentUrlBase;
  return live;
}

/** Checks the answers against the scenario before anything is taken up; returns the item each UI step answers to. */
function checkAnswers(scenario: Scenario, held: HeldRun, answers: UiAnswers): Map<number, number> {
  const itemOf = new Map<number, number>();
  scenario.steps.forEach((step, index) => {
    if (step.kind === 'ui') itemOf.set(index, itemOf.size + 1);
  });
  if (answers.items.length !== itemOf.size) {
    throw new Error(`the checklist has ${answers.items.length} items and ${scenario.id} has ${itemOf.size} UI steps: is it this run's checklist?`);
  }
  // Items after a missing answer do not count: the session works in order.
  const firstOpen = answers.items.find((item) => item.result === null);
  for (const item of answers.items) {
    if (firstOpen !== undefined && item.number > firstOpen.number && item.result !== null) {
      throw new Error(`item ${item.number} is answered but item ${firstOpen.number} before it is not: answer the items in order`);
    }
  }
  const failed = answers.items.some((item) => item.result === 'fail');
  if (firstOpen === undefined && !failed) {
    const missing = uiValueSubjects(scenario).filter((subject) => !answers.values.has(subject));
    if (missing.length > 0) throw new Error(`every item is answered, but these values are not: ${missing.join(', ')}`);
  }
  const done = [...itemOf.entries()].filter(([index]) => index < held.stepIndex).map(([, item]) => item);
  for (const item of done) {
    if (answers.items[item - 1]?.result !== 'pass') throw new Error(`item ${item} was answered pass before; the checklist now says otherwise`);
  }
  return itemOf;
}

/** Takes up the held run in `runDir` with the session's answers. */
export async function takeUpHeldRun(runDir: string, answers: UiAnswers, scenarios: readonly Scenario[], deps: UiResultDeps): Promise<UiResultOutcome> {
  const held = loadHeldRun(runDir);
  const scenario = scenarios.find((candidate) => candidate.id === held.scenarioId);
  if (scenario === undefined) throw new Error(`the held run is of scenario ${held.scenarioId}, which the scenario set no longer has`);
  if (held.holdUntil <= Date.now()) {
    throw new Error(`the hold of run ${held.runId} ended at ${new Date(held.holdUntil).toISOString()}; the sweeper removes what it kept. Run ${scenario.id} again.`);
  }
  const itemOf = checkAnswers(scenario, held, answers);

  // One taker at a time: a second `ui-result` on the same run waits for nothing and stops.
  let taker: Lock;
  try {
    taker = await acquireLock(`ui-result-${held.runId}`, { stateDir: deps.stateDir, runId: held.runId, timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockTimeoutError) throw new Error(`run ${held.runId} is being taken up by another ui-result now`);
    throw error;
  }
  const registration = registerRun(deps.stateDir, held.runId);
  // The hold stays while this process works: should it die, the run still waits for the UI session.
  registration.hold(held.holdUntil);
  const heartbeat = setInterval(() => registration.heartbeat(), 60_000);
  const { ctx, logLines } = createRunContext(scenario, held.runId, runDir, { ...deps, outDir: reportDirOf(runDir) });
  const locks: Lock[] = [];
  let grant: Awaited<ReturnType<NonNullable<RunnerDeps['governor']>['admit']>> | undefined;
  const ran: string[] = [];
  try {
    // Taking the run up: nothing here changes it, so a problem leaves it held as it was.
    ctx.engine.results = held.engine.results;
    ctx.engine.setupRuns = held.engine.setupRuns;
    ctx.edits = held.edits;
    ctx.ownCommits = held.ownCommits;
    ctx.sequence = held.sequence;
    ctx.uiSteps = held.uiSteps;
    ctx.observations = held.observations;
    for (const [subject, value] of answers.values) ctx.observations.set(subject, value);
    if (deps.governor !== null) {
      try {
        grant = await deps.governor.admit(scenario, held.runId, estimate(scenario));
      } catch (blocked) {
        if (blocked instanceof BudgetBlockedError) throw new EnvBlockedError(blocked.message);
        throw blocked;
      }
    }
    ctx.live = await (deps.attach ?? attachHeldRun)(held, deps);
    ctx.sandbox = ctx.live.sandbox;
    ctx.proxy = await startFaultProxy('https://api.linear.app', { history: held.proxyRequests });
    await takeTeamLocks(ctx, deps.stateDir, held.live.tree.teamZones.keys(), locks);
  } catch (error) {
    await ctx.proxy?.close();
    release(locks, grant, heartbeat, taker);
    throw error;
  }

  ctx.log(`taken up for the UI session's answers at step ${held.stepIndex + 1}`);
  const step = deps.runStep ?? runStep;
  const history = (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined) ?? [];
  ctx.observations.set('refHistory', history);
  let error: unknown;
  let checks: CheckOutcome[] = [];
  let waitingAt: number | undefined;
  try {
    for (let index = held.stepIndex; index < scenario.steps.length; index += 1) {
      const current = scenario.steps[index] as Step;
      if (current.kind === 'ui') {
        const item = itemOf.get(index) as number;
        const answer = answers.items[item - 1];
        if (answer?.result === null || answer === undefined) {
          waitingAt = index;
          break;
        }
        ctx.log(`ui item ${item} (${current.action}): ${answer.result}${answer.observed === '' ? '' : `: ${answer.observed}`}`);
        if (answer.result === 'fail') throw new ProductError(`UI step ${item} (${current.action}) failed${answer.observed === '' ? '' : `: ${answer.observed}`}`);
        continue;
      }
      ctx.log(`step ${current.kind}.${current.action}`);
      ran.push(`${current.kind}.${current.action}`);
      await step(ctx, current);
      history.push(await snapshotRefs(ctx));
    }
    if (waitingAt === undefined) checks = await checksHold(ctx);
  } catch (caught) {
    error = caught;
  }

  const appName = held.appName;
  const budgetWaitMs = held.budgetWaitMs + (grant?.waitedMs ?? 0);
  if (error === undefined && waitingAt !== undefined) {
    // Still waiting for the session: save how far the run got and keep the hold.
    try {
      await retainPendingOutput(ctx);
      saveHeldRun(runDir, heldRunOf(ctx, { stepIndex: waitingAt, appName, holdUntil: held.holdUntil, startedAt: held.startedAt, budgetWaitMs }));
    } catch (saveError) {
      error = new EnvBlockedError(`the run could not be kept for the UI session: ${(saveError as Error).message}`);
    }
    if (error === undefined) {
      await ctx.proxy?.close();
      release(locks, grant, heartbeat, taker);
      appendFileSync(join(runDir, 'harness.log'), `\n${logLines.join('\n')}`);
      cleanClones(runDir);
      return { state: 'waiting', ran, nextItem: itemOf.get(waitingAt) as number };
    }
  }

  // The run ends here: its output, then cleanup, then the hold goes.
  writeFileSync(join(runDir, 'canary-pending'), '');
  await retainPendingOutput(ctx);
  await captureCanaryEvidence(ctx);
  const cleanup = await cleanupAndCount(ctx);
  await ctx.proxy?.close();
  if (cleanup.ok) registration.done();
  // A run left half cleaned up is no longer held: once this process ends, the sweeper takes it as dead.
  else registration.hold(0);
  release(locks, grant, heartbeat, taker);
  forgetHeldRun(runDir);
  cleanClones(runDir);
  const outcome = classify(error, deps.expectedRed.has(scenario.id));
  ctx.log(`${outcome.result}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`);
  appendFileSync(join(runDir, 'harness.log'), `\n${logLines.join('\n')}`);
  rmSync(join(runDir, 'canary-pending'), { force: true });
  return { state: 'done', ran, result: resultOf(ctx, outcome, { startedAt: Date.parse(held.startedAt), budgetWaitMs, checks, cleanup }) };
}

function release(locks: Lock[], grant: { release(): void } | undefined, heartbeat: NodeJS.Timeout, taker: Lock): void {
  locks.splice(0).reverse().forEach((lock) => lock.release());
  grant?.release();
  clearInterval(heartbeat);
  taker.release();
}

function cleanClones(runDir: string): void {
  rmSync(join(runDir, 'person'), { recursive: true, force: true });
  rmSync(join(runDir, 'engine'), { recursive: true, force: true });
}

/**
 * Records a taken-up run's result in its harness run's report, replacing the
 * env-blocked one, and in the status page and evidence when given. The
 * request counts add to what the run used before it was held.
 */
export function recordUiResult(
  reportDir: string,
  result: Omit<ScenarioResult, 'harnessAppRequests'>,
  harnessAppRequests: number,
  options: { statusPage?: string; evidenceDir?: string; catalog: readonly string[] },
): { report: HarnessReport; files: { json: string; markdown: string } } {
  const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8')) as HarnessReport;
  const index = report.results.findIndex((entry) => entry.id === result.id && entry.runId === result.runId);
  if (index < 0) throw new Error(`the report in ${reportDir} has no result of ${result.id} run ${result.runId}`);
  const before = report.results[index] as ScenarioResult;
  report.results[index] = {
    ...result,
    harnessRequests: before.harnessRequests + result.harnessRequests,
    harnessAppRequests: before.harnessAppRequests + harnessAppRequests,
  };
  report.finishedAt = new Date().toISOString();
  const files = writeRunReport(report, reportDir);
  if (options.statusPage !== undefined) updateStatusPage(options.statusPage, options.catalog, { ...report, results: [report.results[index] as ScenarioResult] });
  if (options.evidenceDir !== undefined) writeEvidence(report, options.evidenceDir);
  return { report, files };
}
