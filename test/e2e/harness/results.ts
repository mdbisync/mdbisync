// Scenario results and how a run's outcome becomes one.
//
// - pass: every step ran and every check held.
// - fail: a check failed or a step broke on a scenario that is not on the
//   expected-red list, or the harness itself broke.
// - expected-red: the scenario is on the expected-red list and failed for a
//   product reason: the engine answered "not implemented", a product step
//   failed, or a check did not hold.
// - env-blocked: the environment could not run it (budget, runner,
//   corpus, browser, credentials; an engine stopped at its setup check on the
//   test environment's credentials, unless the scenario's credentials fault
//   caused it), with the reason.
// - skipped: not run (stopped before its turn, or not selected for this host).
//
// A scenario on the expected-red list that passes is reported, so the list
// shrinks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EngineResult } from './engine.ts';

export type Result = 'pass' | 'fail' | 'expected-red' | 'env-blocked' | 'skipped';
export const RESULTS: readonly Result[] = ['pass', 'fail', 'expected-red', 'env-blocked', 'skipped'];

/** The engine answered "not implemented" for a command. */
export class NotImplementedError extends Error {
  readonly command: string;
  constructor(command: string, detail = '') {
    super(`not implemented: ${command}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'NotImplementedError';
    this.command = command;
  }
}

/** A product step or check failed: the engine did not do what the scenario expects. */
export class ProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductError';
  }
}

/** The environment cannot run the scenario now. */
export class EnvBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvBlockedError';
  }
}

/** The harness cannot perform a step yet; this is the harness's failure, never the product's. */
export class HarnessGapError extends Error {
  constructor(step: string) {
    super(`the harness cannot run step ${step} yet`);
    this.name = 'HarnessGapError';
  }
}

export interface CheckOutcome {
  /** An invariant id (I1 to I9) or an assertion subject. */
  name: string;
  ok: boolean;
  /** Why it failed or was not evaluated; never content. */
  detail?: string;
}

export interface ScenarioResult {
  /** Present only for partial-corpus team-scoped runs. */
  corpusTeams?: string[];
  /** Content hashes and mapping for solo/parallel equivalence, without resource ids. */
  isolationSnapshot?: unknown;
  id: string;
  level: string;
  slice: string;
  mode: string;
  runId: string;
  result: Result;
  reason?: string;
  /** Set when an expected-red scenario passed. */
  unexpectedPass?: boolean;
  startedAt: string;
  durationMs: number;
  /** Local proxy requests plus deduplicated remote GraphQL attempts, for I9. */
  engineRequests: number;
  requestBuckets?: ReturnType<typeof import('./request-accounting.ts').requestBuckets>;
  /** Requests of the harness's editors (personal API keys). */
  harnessRequests: number;
  /** The harness's own requests through the OAuth app (reads of both sides, budget checks), retries included. */
  harnessAppRequests: number;
  budgetWaitMs: number;
  checks: CheckOutcome[];
  cleanup: { ok: boolean; detail?: string };
  /** Set when the run's shared admission reservation outlives this result: a UI hold, a setup that did not stop or a failed release. */
  sharedReservationKept?: boolean;
  /** Measurements the scenario records for the report (durations, budget, race windows); never content. */
  metrics?: Record<string, unknown>;
  /** Trashed documents per team zone the run used, before it and after its cleanup; a run should leave them unchanged. */
  teamZoneTrash?: Record<string, { before: number; after?: number }>;
  /** Per operation, the largest and slowest answer the engine got through the local proxy; sizes only. */
  answerSizes?: Record<string, import('./request-accounting.ts').AnswerSize>;
  /** The mapped documents Linear shows with the conflict mark after the checks; absent when the run did not reach them or the read failed. */
  conflictMarks?: { mapped: number; marked: import('./subjects.ts').ConflictMarkRecord[] };
}

export const EXPECTED_RED_FILE = fileURLToPath(new URL('../expected-red.json', import.meta.url));

/** The scenarios whose feature has not landed. Implementing tasks remove their ids. */
export function loadExpectedRed(file: string = EXPECTED_RED_FILE): Set<string> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as { scenarios: string[] };
  return new Set(value.scenarios);
}

/** Turns what happened into a result. `error` is the first error, or undefined when every step and check passed. */
export function classify(
  error: unknown,
  expectedRed: boolean,
): { result: Result; reason?: string; unexpectedPass?: boolean } {
  if (error === undefined) return expectedRed ? { result: 'pass', unexpectedPass: true, reason: 'passes while on the expected-red list' } : { result: 'pass' };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof EnvBlockedError) return { result: 'env-blocked', reason: message };
  if (error instanceof NotImplementedError || error instanceof ProductError) {
    return expectedRed ? { result: 'expected-red', reason: message } : { result: 'fail', reason: message };
  }
  if (error instanceof HarnessGapError) return { result: 'fail', reason: `harness: ${message}` };
  return { result: 'fail', reason: `harness error: ${message}` };
}

/**
 * How a run failed: at its failed setup check (named with the code and detail) or with its code. Null for a
 * run that did not fail (a partial run is `ok`, and the next one goes on) or failed without a code.
 */
export function runFailure(report: Record<string, unknown> | null | undefined): string | null {
  if (report?.['ok'] !== false || typeof report['code'] !== 'string') return null;
  const checks = Array.isArray(report['setupChecks']) ? (report['setupChecks'] as Array<{ name?: unknown; state?: unknown; detail?: unknown }>) : [];
  const check = checks.find((candidate) => candidate.state === 'failed');
  return check === undefined ? `with ${report['code']}` : `at the setup check ${String(check.name)} (${report['code']}): ${String(check.detail)}`;
}

/** The setup stops that come from a run's credentials, with the service whose credential each one is about. */
const CREDENTIAL_STOPS: Readonly<Record<string, 'linear' | 'github'>> = {
  'linear-credential-failed': 'linear',
  'github-credential-failed': 'github',
  'missing-permission': 'github',
  'github-app-not-found': 'github',
};

/**
 * The error a scenario's run is classified by. When the last engine run that wrote a report stopped at its
 * setup check on its credentials, and no credentials fault of the scenario made that credential invalid,
 * the test environment's own credentials stopped it (a GitHub token without `checks:read`, say): nothing was
 * synced, and the checks that fail after it say nothing about the scenario. Such a product failure becomes
 * env-blocked, naming the run, the setup item and its detail. A stop a later run got past is not one; other
 * setup stops (annotations, merge policy, hooks) and harness errors stay as they are. The first `setupRuns`
 * results are setup's runs.
 */
export function blockedBySetupStop(error: unknown, results: readonly EngineResult[], setupRuns: number): unknown {
  if (!(error instanceof ProductError)) return error;
  const index = results.findLastIndex((result) => result.report !== null);
  const last = results[index];
  const code = last?.report?.['code'];
  if (last === undefined || typeof code !== 'string' || !Object.hasOwn(CREDENTIAL_STOPS, code) || last.credentialFault === CREDENTIAL_STOPS[code]) return error;
  const stop = runFailure(last.report);
  if (stop === null) return error;
  const run = index < setupRuns ? `setup run ${index}` : `run ${index - setupRuns}`;
  return new EnvBlockedError(`the engine's ${run} (${last.command}) stopped ${stop}; the test environment's credentials do not let the scenario run`);
}
