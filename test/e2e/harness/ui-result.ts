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
// A run that ends, whatever its result, is cleaned up and its hold released;
// its result is also saved as `ui-result.json` in the run folder.
//
// Problems before any step runs (a hold that ended, a checklist of another
// scenario or run, missing values, a configuration that cannot reach the
// run) change nothing: the run stays held and nothing is recorded.

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withAppRequests } from './app-reads.ts';
import { snapshotRefs } from './checks.ts';
import { runChecks } from './checks.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { OwnershipLedger } from './ownership.ts';
import { BudgetBlockedError, estimate } from './governor.ts';
import { githubToken } from './github.ts';
import { forgetHeldRun, heldRunOf, loadHeldRun, saveHeldRun, type HeldRun } from './held-run.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { readLatest, updateStatusPage, writeEvidence, writeRunReport, type HarnessReport } from './report.ts';
import { classify, EnvBlockedError, ProductError, type CheckOutcome, type ScenarioResult } from './results.ts';
import {
  captureCanaryEvidence,
  claimEditorBudgets,
  cleanupAndCount,
  createRunContext,
  failOnChecks,
  liveWorld,
  resultOf,
  retainPendingOutput,
  takeTeamLocks,
  type RunnerDeps,
} from './runner.ts';
import { Sandbox } from './sandbox.ts';
import type { Scenario, Step } from './spec.ts';
import { afterUiStep, runStep } from './steps.ts';
import { uiValueSubjects, type UiAnswers } from './ui-checklist.ts';

export const UI_RESULT_FILE = 'ui-result.json';

export interface UiResultDeps extends Omit<RunnerDeps, 'outDir'> {
  /** Makes the held run's live world again; by default from the test configuration. */
  attach?: (held: HeldRun, deps: UiResultDeps) => Promise<LiveWorld>;
  /** Runs one harness step; by default the harness's own. */
  runStep?: (ctx: RunContext, step: Step) => Promise<void>;
  /** What the harness does once a UI step was answered pass (for example retiring the edits a resolution discarded). */
  afterUiStep?: (ctx: RunContext, step: Step) => Promise<void>;
}

export type UiResultOutcome =
  /** Steps ran up to an item that is not answered yet; the run stays held. */
  | { state: 'waiting'; ran: string[]; nextItem: number }
  /** The run ended: its result counts the requests of every take-up, and the run is cleaned up. */
  | { state: 'done'; ran: string[]; result: ScenarioResult };

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
  const live = await liveWorld(deps, held.appName, {
    sandbox,
    token,
    manifest: held.live.manifest,
    tree: held.live.tree,
    known: { teams: held.live.teams, documentUrlBase: held.live.documentUrlBase },
    owned: new OwnershipLedger(deps.stateDir, held.runId),
  });
  live.projects = held.live.projects;
  live.seededDocuments = held.live.seededDocuments;
  return live;
}

/** Checks the answers against the run before anything is taken up; returns the item each UI step answers to. */
function checkAnswers(scenario: Scenario, held: HeldRun, answers: UiAnswers): Map<number, number> {
  if (answers.scenarioId !== held.scenarioId || answers.runId !== held.runId) {
    throw new Error(`the checklist is of ${answers.scenarioId ?? 'no scenario'} run ${answers.runId ?? 'unknown'}, and the held run is ${held.scenarioId} run ${held.runId}`);
  }
  const itemOf = new Map<number, number>();
  scenario.steps.forEach((step, index) => {
    if (step.kind === 'ui') itemOf.set(index, itemOf.size + 1);
  });
  if (answers.items.length !== itemOf.size) {
    throw new Error(`the checklist has ${answers.items.length} items and ${scenario.id} has ${itemOf.size} UI steps`);
  }
  // The session works in order: no answer after an open item.
  const firstOpen = answers.items.find((item) => item.result === null);
  for (const item of answers.items) {
    if (firstOpen !== undefined && item.number > firstOpen.number && item.result !== null) {
      throw new Error(`item ${item.number} is answered but item ${firstOpen.number} before it is not: answer the items in order`);
    }
  }
  // Items after a harness step that has not run yet must be answered after it ran: what the session saw
  // before the step says nothing about the page after it. They come back in a later submission.
  const pending = scenario.steps.findIndex((step, index) => index >= held.stepIndex && step.kind !== 'ui');
  if (pending >= 0) {
    const early = [...itemOf.entries()].filter(([index, item]) => index > pending && answers.items[item - 1]?.result !== null).map(([, item]) => item);
    const blocking = scenario.steps[pending] as Step;
    if (early.length > 0) {
      throw new Error(`item ${early.join(', ')} comes after the harness step ${blocking.kind}.${blocking.action}, which has not run yet: hand back the items before it, then answer the rest once it ran`);
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
  // One taker at a time, and the held run read only once the lock is ours: a taker before may have moved it on.
  const runId = loadHeldRun(runDir).runId;
  let taker: Lock;
  try {
    taker = await acquireLock(`ui-result-${runId}`, { stateDir: deps.stateDir, runId, timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockTimeoutError) throw new Error(`run ${runId} is being taken up by another ui-result now`);
    throw error;
  }
  try {
    // The harness's app reads of this take-up: saved with the held run while it waits, added to the result once it ends.
    const { result, requests } = await withAppRequests(() => takeUp(runDir, answers, scenarios, deps));
    if (result.state === 'waiting') {
      addWaitingAppRequests(runDir, requests);
      return result;
    }
    return { ...result, result: { ...result.result, harnessAppRequests: result.result.harnessAppRequests + requests } };
  } finally {
    taker.release();
  }
}

async function takeUp(runDir: string, answers: UiAnswers, scenarios: readonly Scenario[], deps: UiResultDeps): Promise<UiResultOutcome> {
  const held = loadHeldRun(runDir);
  const scenario = scenarios.find((candidate) => candidate.id === held.scenarioId);
  if (scenario === undefined) throw new Error(`the held run is of scenario ${held.scenarioId}, which the scenario set no longer has`);
  if (held.holdUntil <= Date.now()) {
    throw new Error(`the hold of run ${held.runId} ended at ${new Date(held.holdUntil).toISOString()}; recover its retained reservation after verifying all writers stopped. Run ${scenario.id} again.`);
  }
  const itemOf = checkAnswers(scenario, held, answers);
  // Nothing new answered where the run stopped: nothing to take up.
  const next = itemOf.get(held.stepIndex);
  if (next !== undefined && answers.items[next - 1]?.result === null) return { state: 'waiting', ran: [], nextItem: next };

  // The hold stays while this process works: should it die, the run still waits for the UI session.
  const registration = registerRun(deps.stateDir, held.runId, { holdUntil: held.holdUntil });
  const heartbeat = setInterval(() => registration.heartbeat(), 60_000);
  const { ctx, logLines } = createRunContext(scenario, held.runId, runDir, { ...deps, outDir: reportDirOf(runDir) });
  const locks: Lock[] = [];
  let grant: Awaited<ReturnType<NonNullable<RunnerDeps['governor']>['admit']>> | undefined;
  /** Ends this process's part; a run that stays held keeps its team locks until its hold ends. */
  const release = (keepHeld: boolean) => {
    locks.splice(0).reverse().forEach((lock) => (keepHeld ? lock.hold(held.holdUntil) : lock.release()));
    if (grant?.owner === undefined) void grant?.release();
    clearInterval(heartbeat);
  };
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
        grant = await deps.governor.admit(scenario, held.runId, estimate(scenario), held.appName, held.observations.get('admission.owner') as string | undefined);
      } catch (blocked) {
        if (blocked instanceof BudgetBlockedError) throw new EnvBlockedError(blocked.message);
        throw blocked;
      }
      // The engine and the harness's reads go on through the run's own app, so its budget is the one to reserve.
      if (grant.owner !== undefined) ctx.observations.set('admission.owner', grant.owner);
      if (grant.app.name !== held.appName) throw new Error(`the governor admitted the run on app ${grant.app.name}, but it runs on app ${held.appName}`);
    }
    ctx.live = await (deps.attach ?? attachHeldRun)(held, deps);
    ctx.sandbox = ctx.live.sandbox;
    ctx.proxy = await startFaultProxy('https://api.linear.app', { history: held.proxyRequests, observer: ctx.owned });
    await claimEditorBudgets(ctx, grant);
    const zoneIds = [...held.live.tree.teams].map((key) => {
      const team = ctx.live!.teams.get(key);
      if (team === undefined) throw new EnvBlockedError('held run team is unavailable');
      return team.id;
    });
    await grant?.claimZones?.(zoneIds, ctx.signal);
    await takeTeamLocks(ctx, deps.stateDir, held.live.tree.teamZones.keys(), locks);
  } catch (error) {
    await ctx.proxy?.close();
    release(true);
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
        if (answer === undefined || answer.result === null) {
          waitingAt = index;
          break;
        }
        ctx.log(`ui item ${item} (${current.action}): ${answer.result}${answer.observed === '' ? '' : `: ${answer.observed}`}`);
        if (answer.result === 'fail') throw new ProductError(`UI step ${item} (${current.action}) failed${answer.observed === '' ? '' : `: ${answer.observed}`}`);
        await (deps.afterUiStep ?? afterUiStep)(ctx, current);
        continue;
      }
      ctx.log(`step ${current.kind}.${current.action}`);
      ran.push(`${current.kind}.${current.action}`);
      await step(ctx, current);
      history.push(await snapshotRefs(ctx));
    }
    if (waitingAt === undefined) {
      checks = await runChecks(ctx);
      failOnChecks(checks);
    }
  } catch (caught) {
    error = caught;
  }

  const budgetWaitMs = held.budgetWaitMs + (grant?.waitedMs ?? 0);
  const editorRequests = [...Object.values(ctx.live.editors)].reduce((sum, client) => sum + client.stats.total, 0);
  if (error === undefined && waitingAt !== undefined) {
    // Still waiting for the session: save how far the run got, with what this take-up used, and keep the hold.
    try {
      await retainPendingOutput(ctx);
      saveHeldRun(runDir, heldRunOf(ctx, {
        stepIndex: waitingAt,
        appName: held.appName,
        holdUntil: held.holdUntil,
        startedAt: held.startedAt,
        budgetWaitMs,
        // This take-up's app reads are added by `takeUpHeldRun`, which counts them.
        takeUpRequests: { harness: held.takeUpRequests.harness + editorRequests, harnessApp: held.takeUpRequests.harnessApp },
      }));
    } catch (saveError) {
      error = new EnvBlockedError(`the run could not be kept for the UI session: ${(saveError as Error).message}`);
    }
    if (error === undefined) {
      await ctx.proxy?.close();
      release(true);
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
  if (cleanup.ok && grant?.owner !== undefined) {
    try { await grant.release(); }
    catch { cleanup.ok = false; cleanup.detail = 'shared reservation release failed'; }
  }
  if (cleanup.ok) registration.done();
  // A run left half cleaned up is no longer held: once this process ends, the sweeper takes it as dead.
  else registration.hold(0);
  release(false);
  forgetHeldRun(runDir);
  cleanClones(runDir);
  const outcome = classify(error, deps.expectedRed.has(scenario.id));
  ctx.log(`${outcome.result}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`);
  appendFileSync(join(runDir, 'harness.log'), `\n${logLines.join('\n')}`);
  rmSync(join(runDir, 'canary-pending'), { force: true });
  const base = resultOf(ctx, outcome, { startedAt: Date.parse(held.startedAt), budgetWaitMs, checks, cleanup });
  const result: ScenarioResult = {
    ...base,
    harnessRequests: base.harnessRequests + held.takeUpRequests.harness,
    harnessAppRequests: held.takeUpRequests.harnessApp,
  };
  return { state: 'done', ran, result };
}

/** Saves the app reads of a take-up that ended waiting, so the run's result counts them. */
function addWaitingAppRequests(runDir: string, requests: number): void {
  if (requests === 0) return;
  const held = loadHeldRun(runDir);
  saveHeldRun(runDir, { ...held, takeUpRequests: { ...held.takeUpRequests, harnessApp: held.takeUpRequests.harnessApp + requests } });
}

function cleanClones(runDir: string): void {
  rmSync(join(runDir, 'person'), { recursive: true, force: true });
  rmSync(join(runDir, 'engine'), { recursive: true, force: true });
}

/** The harness run's report and the index of a run's result in it; throws when the report has none. */
export function reportEntry(reportDir: string, id: string, runId: string): { report: HarnessReport; index: number } {
  const file = join(reportDir, 'report.json');
  if (!existsSync(file)) throw new Error(`no report.json in ${reportDir}: is this run folder still in its harness run's output?`);
  const report = JSON.parse(readFileSync(file, 'utf8')) as HarnessReport;
  const index = report.results.findIndex((entry) => entry.id === id && entry.runId === runId);
  if (index < 0) throw new Error(`the report in ${reportDir} has no result of ${id} run ${runId}`);
  return { report, index };
}

/**
 * Records a taken-up run's result: in the run folder, over the env-blocked
 * result in its harness run's report, and in the status page and evidence
 * when given. Request counts add to what the run used before its hold. The
 * status page keeps a newer result of the same scenario from another run.
 */
export function recordUiResult(
  runDir: string,
  result: ScenarioResult,
  options: { statusPage?: string; evidenceDir?: string; catalog: readonly string[] },
): { files: { json: string; markdown: string }; statusPage: 'updated' | 'kept-newer' | 'not-given' } {
  writeFileSync(join(runDir, UI_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  const reportDir = reportDirOf(runDir);
  const { report, index } = reportEntry(reportDir, result.id, result.runId);
  const before = report.results[index] as ScenarioResult;
  const recorded: ScenarioResult = {
    ...result,
    harnessRequests: before.harnessRequests + result.harnessRequests,
    harnessAppRequests: before.harnessAppRequests + result.harnessAppRequests,
  };
  report.results[index] = recorded;
  report.finishedAt = new Date().toISOString();
  const files = writeRunReport(report, reportDir);
  if (options.evidenceDir !== undefined) writeEvidence(report, options.evidenceDir);
  if (options.statusPage === undefined) return { files, statusPage: 'not-given' };
  const latest = existsSync(options.statusPage) ? readLatest(readFileSync(options.statusPage, 'utf8')).find((entry) => entry.id === result.id) : undefined;
  if (latest !== undefined && latest.runId !== result.runId && latest.at > result.startedAt) return { files, statusPage: 'kept-newer' };
  updateStatusPage(options.statusPage, options.catalog, { ...report, results: [recorded] });
  return { files, statusPage: 'updated' };
}
