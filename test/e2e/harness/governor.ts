// The budget governor. Linear's budget belongs to an OAuth app (5,000
// requests and 2,000,000 complexity points an hour) and every run that uses
// the app shares it, also runs of other harness processes. Before a scenario
// the governor reads the app's `rateLimitStatus` and waits while what is
// left is below the scenario's estimate; it caps the workers per app with
// the shared Git admission store used by the live CLI. Local-only instances
// retain host slots for offline tests and exclusive drivers. Full slices
// exclude all other shared reservations.

import { randomUUID } from 'node:crypto';
import { zoneConcurrent } from './concurrency.ts';
import { ZoneBusyError, type AccountBudget, type SharedAdmission } from './shared-state.ts';
import { readRateLimitHeaders } from '../../../src/linear/rate-limit.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RateLimitStatus } from '../../../src/linear/index.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { acquireLock, acquireSlot, processAlive, type Lock } from './locks.ts';
import type { Scenario } from './spec.ts';

export const MAX_WORKERS_PER_APP = 4;
/** Documents per slice; the corpus manifest replaces these when it is known. */
export const SLICE_DOCUMENTS: Record<Scenario['slice'], number> = { mini: 12, bank: 270, mid: 212, full: 2030 };
/** I9: requests per written document, plus a fixed allowance per engine run. */
export const REQUESTS_PER_DOCUMENT = 1.5;
export const REQUESTS_PER_RUN = 5;
/** What the harness itself spends per scenario: projects, seeding, checks, cleanup. */
export const HARNESS_REQUESTS_PER_DOCUMENT = 2;
export const HARNESS_REQUESTS_FIXED = 30;
/** A conservative complexity per request until the format probe measures it. */
export const COMPLEXITY_PER_REQUEST = 400;
/** Left for other sessions sharing the app, never planned into a scenario. */
export const RESERVE = { requests: 200, complexity: 100_000 };
/** The most a scenario waits for before it starts; larger ones continue across windows. */
export const MAX_ADMISSION = { requests: 3_000, complexity: 1_200_000 };
/** How often a scenario held back only by other scenarios' reservations looks again. */
export const RESERVATION_POLL_MS = 5_000;
/** The longest wait for budget before a scenario is reported env-blocked. */
export const MAX_BUDGET_WAIT_MS = 65 * 60_000;
/** The pause between two attempts to claim a held team zone. */
const ZONE_POLL_MS = 500;

export interface Estimate {
  requests: number;
  complexity: number;
}

/** How many times the engine runs in a scenario: setup, its run steps and the I6 re-run. */
export function engineRuns(scenario: Scenario): number {
  const setup = { offline: 0, empty: 0, 'no-state': 0, 'linear-seeded': 0, converged: 1, conflicted: 2 }[scenario.setup.state];
  const steps = scenario.steps.reduce((count, step) => count + (step.kind !== 'run' || ['fix', 'lint', 'scan-canaries', 'cleanup', 'pre-commit'].includes(step.action) ? 0 : step.action === 'settle' ? 4 : 1), 0);
  return setup + steps + (scenario.checks.invariants.I6.required ? 1 : 0);
}

export function estimate(scenario: Scenario, documents: number = SLICE_DOCUMENTS[scenario.slice]): Estimate {
  if (scenario.setup.state === 'offline') return { requests: 0, complexity: 0 };
  const runs = engineRuns(scenario);
  const holds = scenario.steps.some((s) => s.kind === 'fault' && s.action === 'checks') ? 2 * documents * runs : 0;
  const requests = Math.ceil(holds + runs * (REQUESTS_PER_DOCUMENT * documents + REQUESTS_PER_RUN) + HARNESS_REQUESTS_PER_DOCUMENT * documents + HARNESS_REQUESTS_FIXED);
  return { requests, complexity: requests * COMPLEXITY_PER_REQUEST };
}

export interface Budget {
  requestsRemaining: number;
  complexityRemaining: number;
  /** When the tighter of the two limits is refilled, epoch milliseconds. */
  resetAt: number;
  /** What a full window of this credential allows, when the read reports it. */
  requestsAllowed?: number;
  complexityAllowed?: number;
}

/** Reads the requests and complexity limits from `rateLimitStatus`. */
export function budgetFromStatus(status: RateLimitStatus, now: number): Budget {
  let requests: { remaining: number; allowed: number | undefined; reset: number } | undefined;
  let complexity: { remaining: number; allowed: number | undefined; reset: number } | undefined;
  for (const limit of status.limits) {
    // A missing or non-positive allowance is unknown, never a zero-sized window.
    const allowed = typeof limit.allowedAmount === 'number' && limit.allowedAmount > 0 ? limit.allowedAmount : undefined;
    const entry = { remaining: limit.remainingAmount, allowed, reset: limit.reset };
    if (/complex/i.test(limit.type)) complexity = entry;
    else if (/request/i.test(limit.type)) requests = entry;
  }
  if (requests === undefined || complexity === undefined) {
    throw new Error(`rateLimitStatus lacks a requests or complexity limit (types: ${status.limits.map((limit) => limit.type).join(', ')})`);
  }
  // Linear gives reset as epoch milliseconds; a small number would be seconds from now.
  const at = (reset: number) => (reset > 1e12 ? reset : now + reset * 1000);
  return {
    requestsRemaining: requests.remaining, complexityRemaining: complexity.remaining, resetAt: Math.max(at(requests.reset), at(complexity.reset)),
    ...(requests.allowed === undefined ? {} : { requestsAllowed: requests.allowed }),
    ...(complexity.allowed === undefined ? {} : { complexityAllowed: complexity.allowed }),
  };
}

export interface App {
  /** A neutral label, never the client id. */
  name: string;
  /** Stable identity shared across configurations, never a credential. */
  key?: string;
  readBudget(): Promise<Budget>;
}

export interface GovernorOptions {
  apps: readonly App[];
  shared?: SharedAdmission;
  stateDir: string;
  maxWorkersPerApp?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface Grant {
  app: App;
  waitedMs: number;
  budgetBefore: Budget;
  owner?: string;
  /** Waits at most `maxWaitMs` (default: the governor's longest wait) for the accounts' budgets. */
  claimBudgets?(accounts: readonly AccountBudget[], signal?: AbortSignal, maxWaitMs?: number): Promise<void>;
  /**
   * Waits at most the governor's longest wait for the zones. After each attempt that found a zone held by
   * another run, and before the pause after it, `onHeld` is told how long both take: a setup deadline does
   * not count it.
   */
  claimZones?(zones: readonly string[], signal?: AbortSignal, onHeld?: (waitedMs: number) => void): Promise<void>;
  release(): void | Promise<void>;
}

/** Whether a scenario's shared reservation excludes every other one: all but the audited zone-concurrent contracts. */
export function holdsFullSlot(scenario: Scenario): boolean {
  return !zoneConcurrent(scenario);
}

export class BudgetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetBlockedError';
  }
}

// The budget ledger: what running scenarios of every harness process on the
// host were admitted with, per app. Their budget is spoken for until they
// end, so two processes cannot both admit against the same remaining budget.
// It counts conservatively: a running scenario's spending shows in Linear's
// remaining budget and in its reservation at once.

interface LedgerEntry extends Estimate {
  runId: string;
  pid: number;
  host: string;
}

function sumLedger(ledger: readonly LedgerEntry[]): Estimate {
  return ledger.reduce((sum, entry) => ({ requests: sum.requests + entry.requests, complexity: sum.complexity + entry.complexity }), { requests: 0, complexity: 0 });
}

/** Reads, changes and writes an app's ledger under its lock; entries of dead local processes are dropped. */
export async function withLedger<T>(stateDir: string, app: string, runId: string, change: (ledger: LedgerEntry[]) => T): Promise<T> {
  const lock = await acquireLock(`budget-${app}`, { stateDir, runId, timeoutMs: 60_000, pollMs: 50 });
  try {
    const dir = join(stateDir, 'budget');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${app}.json`);
    let ledger: LedgerEntry[] = [];
    try {
      ledger = JSON.parse(readFileSync(file, 'utf8')) as LedgerEntry[];
    } catch {
      ledger = [];
    }
    ledger = ledger.filter((entry) => entry.host !== hostname() || processAlive(entry.pid));
    const result = change(ledger);
    writeFileSync(file, JSON.stringify(ledger));
    return result;
  } finally {
    lock.release();
  }
}

export class Governor {
  readonly #options: GovernorOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #next = 0;
  readonly #observed = new Map<string, Partial<Record<'requests' | 'complexity', { remaining: number; resetAt: number; at: number }>>>();

  /** Record real GraphQL evidence. A later fresh budget read supersedes it;
   * evidence arriving during that read can still constrain its admission.
   */
  observeRateLimits(app: string, headers: Record<string, string>, observedAt = this.#now()): void {
    let parsed: Headers;
    try { parsed = new Headers(headers); } catch { return; }
    const limit = readRateLimitHeaders(parsed);
    const observed = this.#observed.get(app) ?? {};
    for (const [kind, remaining, resetAt] of [
      ['requests', limit.requestsRemaining, limit.requestsReset],
      ['complexity', limit.complexityRemaining, limit.complexityReset],
    ] as const) {
      if (remaining === undefined || resetAt === undefined || !Number.isFinite(remaining) || !Number.isFinite(resetAt) || !Number.isFinite(observedAt) || remaining < 0 || resetAt <= this.#now()) continue;
      const previous = observed[kind];
      if (previous === undefined || observedAt > previous.at || (observedAt === previous.at && remaining < previous.remaining)) {
        observed[kind] = { remaining, resetAt, at: observedAt };
      }
    }
    this.#observed.set(app, observed);
  }

  #withObserved(app: string, fresh: Budget, readStartedAt: number): Budget {
    const observed = this.#observed.get(app);
    const result = { ...fresh };
    for (const [kind, field] of [['requests', 'requestsRemaining'], ['complexity', 'complexityRemaining']] as const) {
      const limit = observed?.[kind];
      if (limit !== undefined && limit.at >= readStartedAt && limit.resetAt > this.#now() && limit.remaining < result[field]) {
        result[field] = limit.remaining;
        result.resetAt = Math.max(result.resetAt, limit.resetAt);
      }
    }
    return result;
  }

  constructor(options: GovernorOptions) {
    if (options.apps.length === 0) throw new Error('the governor needs at least one OAuth app');
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => sleep(ms).then(() => undefined));
  }

  /**
   * Whether two scenarios cannot hold admission at the same time, so a
   * worker of the same batch should not wait in admission for one while the
   * other runs. Offline scenarios are never admitted. Shared admission keeps
   * every live scenario apart except two zone-concurrent ones; host-local
   * admission keeps only full slices apart.
   */
  conflicts(a: Scenario, b: Scenario): boolean {
    if (a.setup.state === 'offline' || b.setup.state === 'offline') return false;
    if (this.#options.shared !== undefined) return holdsFullSlot(a) || holdsFullSlot(b);
    return a.slice === 'full' && b.slice === 'full';
  }

  async #admitShared(scenario: Scenario, runId: string, estimated: Estimate, appName?: string, resumeOwner?: string): Promise<Grant> {
    const options = this.#options;
    const shared = options.shared!;
    const started = this.#now();
    const deadline = started + (options.maxWaitMs ?? MAX_BUDGET_WAIT_MS);
    const owner = resumeOwner ?? randomUUID();
    const apps = options.apps.filter((app) => appName === undefined || app.name === appName);
    if (apps.length === 0) throw new Error('unknown OAuth app');
    const need = { requests: Math.min(estimated.requests, MAX_ADMISSION.requests), complexity: Math.min(estimated.complexity, MAX_ADMISSION.complexity) };
    for (;;) {
      let retryAt = Infinity;
      for (const app of apps) {
        const admission = await shared.reserve({ runId, owner, app: app.key ?? app.name, full: holdsFullSlot(scenario), ...(resumeOwner === undefined ? {} : { resume: true }), need, maxWorkers: Math.min(options.maxWorkersPerApp ?? MAX_WORKERS_PER_APP, MAX_WORKERS_PER_APP), reserve: RESERVE,
          readBudget: async () => {
            const at = this.#now();
            return this.#withObserved(app.name, await app.readBudget(), at);
          },
        });
        if (!admission.admitted) {
          const budget = admission.budget;
          const shortage = budget !== undefined && (budget.requestsRemaining - RESERVE.requests < need.requests || budget.complexityRemaining - RESERVE.complexity < need.complexity);
          retryAt = Math.min(retryAt, shortage ? Math.max(budget!.resetAt + 1000, this.#now() + 5000) : this.#now() + RESERVATION_POLL_MS);
          continue;
        }
        return {
          app, owner, waitedMs: this.#now() - started, budgetBefore: admission.budget!,
          claimBudgets: async (accounts, signal, maxWaitMs) => {
            const until = this.#now() + (maxWaitMs ?? options.maxWaitMs ?? MAX_BUDGET_WAIT_MS);
            for (;;) {
              signal?.throwIfAborted();
              const result = await shared.reserveAccounts(runId, owner, accounts, RESERVE);
              if (result.admitted) return;
              if (result.never !== undefined) throw new BudgetBlockedError(`editor budget can never be admitted: ${result.never}`);
              const wake = Math.max(result.wakeAt ?? this.#now() + RESERVATION_POLL_MS, this.#now() + RESERVATION_POLL_MS);
              if (wake > until) throw new BudgetBlockedError(`editor budget unavailable: it frees up in ${Math.ceil((wake - this.#now()) / 60_000)} minutes, after the longest wait`);
              await sleep(Math.max(0, wake - this.#now()), undefined, signal === undefined ? {} : { signal });
            }
          },
          claimZones: async (zones, signal, onHeld) => {
            const until = this.#now() + (options.maxWaitMs ?? MAX_BUDGET_WAIT_MS);
            for (;;) {
              signal?.throwIfAborted();
              const attempt = this.#now();
              try { await shared.claim(runId, owner, zones); return; }
              catch (error) {
                if (!(error instanceof ZoneBusyError)) throw error;
                if (this.#now() >= until) throw new BudgetBlockedError('shared team zone remained held');
                // Only an attempt that ended with the zone held is a wait: a stalled attempt never reaches here.
                // The fixed pause is reported before it starts, so a deadline cannot expire during it.
                onHeld?.(this.#now() - attempt + ZONE_POLL_MS);
                await sleep(ZONE_POLL_MS, undefined, signal === undefined ? {} : { signal });
              }
            }
          },
          release: () => shared.release(runId, owner),
        };
      }
      if (retryAt > deadline) throw new BudgetBlockedError('shared admission: budget, worker slots or full slice remained reserved');
      options.log?.('shared admission: waiting for app budget, worker slot or exclusive full slice');
      await this.#sleep(Math.max(0, retryAt - this.#now()));
    }
  }

  /**
   * Waits for a worker slot on some app and for that app's budget to cover
   * the estimate. The grant holds the slot (and the full-run lock) until
   * released. Throws BudgetBlockedError after the longest wait.
   */
  async admit(scenario: Scenario, runId: string, estimated: Estimate, appName?: string, owner?: string): Promise<Grant> {
    if (this.#options.shared !== undefined) return this.#admitShared(scenario, runId, estimated, appName, owner);
    const options = this.#options;
    // A scenario bigger than one window (L1-16) starts on a mostly full
    // window and goes on by resume in the next ones.
    const need = { requests: Math.min(estimated.requests, MAX_ADMISSION.requests), complexity: Math.min(estimated.complexity, MAX_ADMISSION.complexity) };
    const started = this.#now();
    const deadline = started + (options.maxWaitMs ?? MAX_BUDGET_WAIT_MS);
    const held: Lock[] = [];
    const releaseAll = () => held.splice(0).reverse().forEach((lock) => lock.release());
    try {
      if (scenario.slice === 'full') {
        held.push(await acquireLock('slice-full', { stateDir: options.stateDir, runId, timeoutMs: Math.max(0, deadline - this.#now()), onWait: (holder) => options.log?.(`full slice: waiting for run ${holder?.runId ?? 'unknown'}`) }));
      }
      // Try the apps in turn, starting after the last one used.
      const apps = appName === undefined
        ? options.apps.map((_, index) => options.apps[(this.#next + index) % options.apps.length] as App)
        : options.apps.filter((app) => app.name === appName);
      if (apps.length === 0) throw new Error(`unknown OAuth app ${appName}`);
      this.#next = (this.#next + 1) % options.apps.length;
      let slot: { app: App; lock: Lock } | undefined;
      while (slot === undefined) {
        for (const app of apps) {
          try {
            const lock = await acquireSlot(`app-${app.name}`, options.maxWorkersPerApp ?? MAX_WORKERS_PER_APP, { stateDir: options.stateDir, runId, timeoutMs: 0 });
            slot = { app, lock };
            break;
          } catch {
            // Every slot of this app is taken.
          }
        }
        if (slot === undefined) {
          if (this.#now() >= deadline) throw new BudgetBlockedError('no worker slot became free on any OAuth app');
          await this.#sleep(2_000);
        }
      }
      held.push(slot.lock);
      let loggedReservationWait = false;
      for (;;) {
        const readStartedAt = this.#now();
        const budget = this.#withObserved(slot.app.name, await slot.app.readBudget(), readStartedAt);
        const app = slot.app;
        const admitted = await withLedger(options.stateDir, app.name, runId, (ledger) => {
          const reserved = sumLedger(ledger);
          const enough =
            budget.requestsRemaining - RESERVE.requests - reserved.requests >= need.requests &&
            budget.complexityRemaining - RESERVE.complexity - reserved.complexity >= need.complexity;
          if (enough) ledger.push({ runId, pid: process.pid, host: hostname(), ...need });
          return enough;
        });
        if (admitted) {
          const lock = held;
          let released = false;
          return {
            app,
            waitedMs: this.#now() - started,
            budgetBefore: budget,
            release: () => {
              if (released) return;
              released = true;
              lock.splice(0).reverse().forEach((item) => item.release());
              // The reservation goes a moment later; until then the ledger only counts more conservatively.
              void withLedger(options.stateDir, app.name, runId, (ledger) => {
                const index = ledger.findIndex((entry) => entry.runId === runId && entry.pid === process.pid);
                if (index >= 0) ledger.splice(index, 1);
              }).catch(() => {});
            },
          };
        }
        // Linear's own budget covers the scenario and only running scenarios' reservations stand in the way:
        // those free up as the scenarios end, so look again soon instead of waiting for the window to refill.
        const linearCovers =
          budget.requestsRemaining - RESERVE.requests >= need.requests && budget.complexityRemaining - RESERVE.complexity >= need.complexity;
        if (linearCovers) {
          if (this.#now() + RESERVATION_POLL_MS > deadline) {
            throw new BudgetBlockedError(`budget: app ${slot.app.name} stayed reserved by running scenarios for the longest wait`);
          }
          if (!loggedReservationWait) options.log?.(`budget: waiting for running scenarios on app ${slot.app.name} to end (their reservations hold the budget)`);
          loggedReservationWait = true;
          await this.#sleep(RESERVATION_POLL_MS);
          continue;
        }
        const wake = Math.max(budget.resetAt + 1_000, this.#now() + 5_000);
        if (wake > deadline) {
          throw new BudgetBlockedError(
            `budget: app ${slot.app.name} has ${budget.requestsRemaining} requests and ${budget.complexityRemaining} points left, the scenario needs about ${need.requests} and ${need.complexity}`,
          );
        }
        options.log?.(`budget: waiting ${Math.round((wake - this.#now()) / 1000)} s for app ${slot.app.name} (needs ${need.requests} requests, has ${budget.requestsRemaining})`);
        await this.#sleep(wake - this.#now());
      }
    } catch (error) {
      releaseAll();
      throw error;
    }
  }
}
