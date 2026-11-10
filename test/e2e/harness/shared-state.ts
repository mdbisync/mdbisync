// Cross-host admission uses a single Git branch. Competing children of the
// observed tip cannot both fast-forward it. Reservations never expire:
// cleanup must finish before another writer can use the same zone.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Git } from '../../../src/state/git.ts';
import type { Budget, Estimate } from './governor.ts';

export const CONTROL_REF = 'refs/heads/scenario-control';
export interface Reservation extends Estimate {
  runId: string;
  owner: string;
  app: string;
  /** Global exclusion, including full slices and workspace-wide scenarios. */
  full: boolean;
  zones: string[];
  revision?: string;
  recovering?: boolean;
  resources?: Array<Estimate & { key: string }>;
}
export interface AccountBudget {
  key: string;
  need: Estimate;
  readBudget(): Promise<Budget>;
}
export interface SharedState { version: 1; runs: Reservation[] }
/**
 * The most of one account's window a run reserves: the share the app's
 * admission cap takes of the app's window (3,000 of 5,000 requests, 1.2M of
 * 2M points). A larger run continues across windows. Reading the budget spends a request, so the whole window
 * minus the reserve would never be free.
 */
export const ACCOUNT_WINDOW_SHARE = 0.6;

/** Caps a need to the account's share of a full window, when the read reports the window. */
export function windowNeed(need: Estimate, budget: Budget): Estimate {
  const cap = (value: number, allowed: number | undefined) => (allowed === undefined ? value : Math.min(value, Math.floor(allowed * ACCOUNT_WINDOW_SHARE)));
  return { requests: cap(need.requests, budget.requestsAllowed), complexity: cap(need.complexity, budget.complexityAllowed) };
}

/** Why a need can never be admitted, even on a full window; undefined when it can. */
export function neverFits(need: Estimate, budget: Budget, reserve: Estimate): string | undefined {
  for (const [kind, allowed, wanted, kept] of [
    ['requests', budget.requestsAllowed, need.requests, reserve.requests],
    ['complexity points', budget.complexityAllowed, need.complexity, reserve.complexity],
  ] as const) {
    if (allowed !== undefined && allowed - kept < wanted) return `a window of the account allows ${allowed} ${kind}, too few for ${wanted} plus the reserve of ${kept}`;
  }
  return undefined;
}
export interface StateStore {
  close?(): Promise<void>;
  read(): Promise<SharedState>;
  update<T>(change: (state: SharedState) => T | Promise<T>): Promise<T>;
}

export function parseSharedState(text: string): SharedState {
  const state = JSON.parse(text) as SharedState;
  if (state?.version !== 1 || !Array.isArray(state.runs)) throw new Error('invalid shared admission state');
  const ids = new Set<string>();
  const zones = new Set<string>();
  for (const entry of state.runs) {
    if (!/^[0-9a-f]{6}$/.test(entry.runId) || ids.has(entry.runId) || typeof entry.owner !== 'string' || entry.owner.length < 16 ||
        (entry.revision !== undefined && typeof entry.revision !== 'string') || (entry.recovering !== undefined && typeof entry.recovering !== 'boolean') ||
        typeof entry.app !== 'string' || entry.app.length === 0 || typeof entry.full !== 'boolean' || !Array.isArray(entry.zones) ||
        !Number.isFinite(entry.requests) || entry.requests < 0 || !Number.isFinite(entry.complexity) || entry.complexity < 0) {
      throw new Error('invalid shared admission reservation');
    }
    const accounts = new Set<string>();
    if (entry.resources !== undefined) {
      if (!Array.isArray(entry.resources)) throw new Error('invalid shared account reservations');
      for (const resource of entry.resources) {
        if (typeof resource.key !== 'string' || resource.key === '' || accounts.has(resource.key) || !Number.isFinite(resource.requests) || resource.requests < 0 || !Number.isFinite(resource.complexity) || resource.complexity < 0) throw new Error('invalid shared account reservation');
        accounts.add(resource.key);
      }
    }
    ids.add(entry.runId);
    for (const zone of entry.zones) {
      if (typeof zone !== 'string' || zone === '' || zones.has(zone)) throw new Error('invalid shared zone claims');
      zones.add(zone);
    }
  }
  if (state.runs.some((entry) => entry.full) && state.runs.length !== 1) throw new Error('invalid full reservation');
  return state;
}

export class ZoneBusyError extends Error {}

/** Only known optimistic-update conflicts are retried; other failures stop. */
export function isConcurrentPush(output: string): boolean {
  return /\[rejected\].*(fetch first|non-fast-forward)|\[remote rejected\].*(failed to update ref|reference already exists|incorrect old value provided)/.test(output) ||
    /cannot lock ref[^\n]*is at [0-9a-f]+ but expected [0-9a-f]+/.test(output);
}

/** Cache short-lived installation credentials, sharing in-flight refreshes. */
export function refreshingGitEnv(load: () => Promise<Record<string, string>>, now: () => number = Date.now): () => Promise<Record<string, string>> {
  let cached: { until: number; value: Promise<Record<string, string>> } | undefined;
  return async () => {
    if (cached === undefined || now() >= cached.until) cached = { until: now() + 45 * 60_000, value: Promise.resolve().then(load) };
    const current = cached;
    try { return await current.value; }
    catch (error) { if (cached === current) cached = undefined; throw error; }
  };
}

export class GitStateStore implements StateStore {
  readonly #git: Git;
  readonly #url: string;
  readonly #dir: string;
  readonly #env: Record<string, string> | (() => Promise<Record<string, string>>);
  readonly #ready: Promise<unknown>;
  constructor(options: { stateDir: string; url: string; env?: Record<string, string> | (() => Promise<Record<string, string>>) }) {
    // Each process gets its own object directory: no fetch/index locks can
    // serialize unrelated hosts or accidentally overwrite another fetch.
    const dir = join(options.stateDir, 'control', randomUUID());
    mkdirSync(dir, { recursive: true });
    this.#dir = dir;
    this.#env = options.env ?? {};
    this.#git = new Git(dir, { GIT_AUTHOR_NAME: 'Scenario Harness', GIT_AUTHOR_EMAIL: 'harness@example.com', GIT_COMMITTER_NAME: 'Scenario Harness', GIT_COMMITTER_EMAIL: 'harness@example.com' });
    this.#url = options.url;
    this.#ready = this.#git.run(['init', '--bare', '--quiet']);
  }
  async #auth(): Promise<Record<string, string>> { return typeof this.#env === 'function' ? this.#env() : this.#env; }
  async close(): Promise<void> {
    try { await this.#ready; } finally { rmSync(this.#dir, { recursive: true, force: true }); }
  }
  async #snapshot(): Promise<{ tip: string | null; state: SharedState }> {
    await this.#ready;
    const listing = await this.#git.text(['ls-remote', '--refs', this.#url, CONTROL_REF], { env: await this.#auth() });
    const tip = listing.trim().split(/\s+/)[0] || null;
    if (tip === null) return { tip, state: { version: 1, runs: [] } };
    if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error('invalid shared admission ref');
    await this.#git.run(['fetch', '--quiet', '--no-write-fetch-head', this.#url, tip], { env: await this.#auth() });
    return { tip, state: parseSharedState(await this.#git.text(['show', `${tip}:state.json`])) };
  }
  async read(): Promise<SharedState> {
    try { return (await this.#snapshot()).state; }
    catch { throw new Error('shared admission state unavailable or invalid'); }
  }
  async update<T>(change: (state: SharedState) => T | Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 30; attempt++) {
      let snapshot;
      try { snapshot = await this.#snapshot(); }
      catch { throw new Error('shared admission state unavailable or invalid'); }
      const before = JSON.stringify(snapshot.state);
      const result = await change(snapshot.state);
      const content = JSON.stringify(snapshot.state);
      parseSharedState(content);
      if (before === content) return result;
      try {
        const blob = (await this.#git.text(['hash-object', '-w', '--stdin'], { input: content })).trim();
        const tree = (await this.#git.text(['mktree'], { input: `100644 blob ${blob}\tstate.json\n` })).trim();
        // The nonce also distinguishes identical concurrent updates.
        const commit = (await this.#git.text(['commit-tree', tree, ...(snapshot.tip === null ? [] : ['-p', snapshot.tip]), '-m', `Scenario admission ${randomUUID()}`])).trim();
        const pushed = await this.#git.run(['push', '--porcelain', this.#url, `${commit}:${CONTROL_REF}`], { okCodes: [0, 1], env: await this.#auth() });
        if (pushed.code === 0) return result;
        // Retry only a proven competing ref update, never access failures.
        if (!isConcurrentPush(pushed.stdout.toString() + pushed.stderr)) {
          throw new Error('shared admission push failed');
        }
      } catch { throw new Error('shared admission update failed'); }
      await sleep(10 + Math.floor(Math.random() * 40));
    }
    throw new Error('shared admission contention; retry later');
  }
}

export class SharedAdmission {
  readonly store: StateStore;
  constructor(store: StateStore) { this.store = store; }
  async reserve(options: { runId: string; owner: string; app: string; full: boolean; resume?: boolean; need: Estimate; maxWorkers: number; reserve: Estimate; readBudget: () => Promise<Budget> }): Promise<{ admitted: boolean; budget?: Budget }> {
    return this.store.update(async (state) => {
      const existing = state.runs.find((entry) => entry.runId === options.runId);
      if (existing !== undefined && !(options.resume && !existing.recovering && existing.owner === options.owner && existing.app === options.app && existing.full === options.full)) throw new Error('run id already has a shared reservation');
      if (options.resume && existing === undefined) throw new Error('held run has no matching shared reservation');
      // Read afresh after every conflicting state update, including releases:
      // a stale read must not forget spending of a just-completed run.
      const others = state.runs.filter((entry) => entry !== existing);
      const sameApp = others.filter((entry) => entry.app === options.app);
      if ((options.full ? others.length > 0 : others.some((entry) => entry.full)) || sameApp.length >= options.maxWorkers) return { admitted: false };
      const budget = await options.readBudget();
      const used = sameApp.reduce((sum, entry) => ({ requests: sum.requests + entry.requests, complexity: sum.complexity + entry.complexity }), { requests: 0, complexity: 0 });
      const admitted = budget.requestsRemaining - options.reserve.requests - used.requests >= options.need.requests &&
        budget.complexityRemaining - options.reserve.complexity - used.complexity >= options.need.complexity;
      if (admitted) {
        if (existing === undefined) state.runs.push({ runId: options.runId, owner: options.owner, app: options.app, full: options.full, zones: [], ...options.need });
        else {
          existing.requests = Math.max(existing.requests, options.need.requests);
          existing.complexity = Math.max(existing.complexity, options.need.complexity);
          // A resume spends budget again, so it must commit even if its
          // estimate is unchanged and retry competing updates with fresh reads.
          existing.revision = randomUUID();
        }
      }
      return { admitted, budget };
    });
  }
  async claim(runId: string, owner: string, zones: readonly string[]): Promise<void> {
    await this.store.update((state) => {
      const entry = state.runs.find((run) => run.runId === runId && run.owner === owner);
      if (entry === undefined) throw new Error('shared reservation ownership lost');
      const wanted = [...new Set(zones)].sort();
      if (state.runs.some((run) => run !== entry && run.zones.some((zone) => wanted.includes(zone)))) throw new ZoneBusyError('team zone held by another run');
      entry.zones = [...new Set([...entry.zones, ...wanted])].sort();
    });
  }
  /**
   * Reserves personal editor budgets by viewer identity, across all apps.
   * Each need is capped to what one window of that account can grant;
   * `never` explains a need that no window could ever admit.
   */
  async reserveAccounts(runId: string, owner: string, accounts: readonly AccountBudget[], reserve: Estimate): Promise<{ admitted: boolean; wakeAt?: number; never?: string }> {
    return this.store.update(async (state) => {
      const entry = state.runs.find((run) => run.runId === runId && run.owner === owner && !run.recovering);
      if (entry === undefined) throw new Error('shared reservation ownership lost');
      const grouped = new Map<string, AccountBudget>();
      for (const account of accounts) {
        const prior = grouped.get(account.key);
        grouped.set(account.key, { ...account, need: { requests: account.need.requests + (prior?.need.requests ?? 0), complexity: account.need.complexity + (prior?.need.complexity ?? 0) } });
      }
      const resources: NonNullable<Reservation['resources']> = [];
      let admitted = true;
      let wakeAt: number | undefined;
      for (const account of grouped.values()) {
        const old = entry.resources?.find((resource) => resource.key === account.key);
        const budget = await account.readBudget();
        const need = windowNeed({ requests: Math.max(account.need.requests, old?.requests ?? 0), complexity: Math.max(account.need.complexity, old?.complexity ?? 0) }, budget);
        const never = neverFits(need, budget, reserve);
        if (never !== undefined) return { admitted: false, never };
        const used = state.runs.filter((run) => run !== entry).flatMap((run) => run.resources ?? []).filter((resource) => resource.key === account.key).reduce((sum, resource) => ({ requests: sum.requests + resource.requests, complexity: sum.complexity + resource.complexity }), { requests: 0, complexity: 0 });
        if (budget.requestsRemaining - reserve.requests - used.requests < need.requests || budget.complexityRemaining - reserve.complexity - used.complexity < need.complexity) {
          admitted = false;
          if (budget.requestsRemaining - reserve.requests < need.requests || budget.complexityRemaining - reserve.complexity < need.complexity) wakeAt = Math.max(wakeAt ?? 0, budget.resetAt + 1000);
        }
        resources.push({ key: account.key, ...need });
      }
      if (admitted) {
        entry.resources = resources;
        entry.revision = randomUUID();
      }
      return { admitted, ...(wakeAt === undefined ? {} : { wakeAt }) };
    });
  }
  /** Only after the caller has verified the writer and all children stopped.
   * Rotate ownership so an old saved UI hold cannot resume during recovery. */
  async beginRecovery(runId: string, previousOwner: string, verifyStopped?: () => void): Promise<string> {
    const owner = randomUUID();
    await this.store.update((state) => {
      const entry = state.runs.find((run) => run.runId === runId && run.owner === previousOwner);
      if (entry === undefined) throw new Error('shared reservation changed before recovery');
      verifyStopped?.();
      entry.owner = owner;
      entry.recovering = true;
    });
    return owner;
  }
  async release(runId: string, owner: string): Promise<void> {
    await this.store.update((state) => {
      const entry = state.runs.find((run) => run.runId === runId);
      if (entry === undefined) return;
      if (entry.owner !== owner) throw new Error('shared reservation ownership lost');
      state.runs.splice(state.runs.indexOf(entry), 1);
    });
  }
  async liveRuns(): Promise<Set<string>> { return new Set((await this.store.read()).runs.map((entry) => entry.runId)); }
}
