// Cross-host admission uses a single Git branch. Competing children of the
// observed tip cannot both fast-forward it. Reservations never expire:
// cleanup must finish before another writer can use the same zone.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Git } from '../../../src/state/git.ts';
import type { Budget, Estimate } from './governor.ts';

export const CONTROL_REF = 'refs/heads/scenario-control';
export interface Reservation extends Estimate {
  runId: string;
  owner: string;
  app: string;
  full: boolean;
  zones: string[];
  revision?: string;
}
export interface SharedState { version: 1; runs: Reservation[] }
export interface StateStore {
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
        typeof entry.app !== 'string' || entry.app.length === 0 || typeof entry.full !== 'boolean' || !Array.isArray(entry.zones) ||
        !Number.isFinite(entry.requests) || entry.requests < 0 || !Number.isFinite(entry.complexity) || entry.complexity < 0) {
      throw new Error('invalid shared admission reservation');
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

export class GitStateStore implements StateStore {
  readonly #git: Git;
  readonly #url: string;
  readonly #ready: Promise<unknown>;
  constructor(options: { stateDir: string; url: string; env?: Record<string, string> }) {
    // Each process gets its own object directory: no fetch/index locks can
    // serialize unrelated hosts or accidentally overwrite another fetch.
    const dir = join(options.stateDir, 'control', randomUUID());
    mkdirSync(dir, { recursive: true });
    this.#git = new Git(dir, { ...options.env, GIT_AUTHOR_NAME: 'Scenario Harness', GIT_AUTHOR_EMAIL: 'harness@example.com', GIT_COMMITTER_NAME: 'Scenario Harness', GIT_COMMITTER_EMAIL: 'harness@example.com' });
    this.#url = options.url;
    this.#ready = this.#git.run(['init', '--bare', '--quiet']);
  }
  async #snapshot(): Promise<{ tip: string | null; state: SharedState }> {
    await this.#ready;
    const listing = await this.#git.text(['ls-remote', '--refs', this.#url, CONTROL_REF]);
    const tip = listing.trim().split(/\s+/)[0] || null;
    if (tip === null) return { tip, state: { version: 1, runs: [] } };
    if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error('invalid shared admission ref');
    await this.#git.run(['fetch', '--quiet', '--no-write-fetch-head', this.#url, tip]);
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
        const pushed = await this.#git.run(['push', '--porcelain', this.#url, `${commit}:${CONTROL_REF}`], { okCodes: [0, 1] });
        if (pushed.code === 0) return result;
        // Retry only a proven competing ref update, never access failures.
        if (!/\[rejected\].*(fetch first|non-fast-forward)|\[remote rejected\].*(failed to update ref|reference already exists|incorrect old value provided)/.test(pushed.stdout.toString())) {
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
  async reserve(options: { runId: string; owner: string; app: string; full: boolean; resume?: boolean; need: Estimate; maxWorkers: number; reserve: Estimate; readBudget: () => Promise<Budget> }): Promise<{ admitted: boolean; budget: Budget }> {
    return this.store.update(async (state) => {
      const existing = state.runs.find((entry) => entry.runId === options.runId);
      if (existing !== undefined && !(options.resume && existing.owner === options.owner && existing.app === options.app)) throw new Error('run id already has a shared reservation');
      if (options.resume && existing === undefined) throw new Error('held run has no matching shared reservation');
      // Read afresh after every conflicting state update, including releases:
      // a stale read must not forget spending of a just-completed run.
      const budget = await options.readBudget();
      const others = state.runs.filter((entry) => entry !== existing);
      const sameApp = others.filter((entry) => entry.app === options.app);
      const used = sameApp.reduce((sum, entry) => ({ requests: sum.requests + entry.requests, complexity: sum.complexity + entry.complexity }), { requests: 0, complexity: 0 });
      const admitted = !(options.full ? others.length > 0 : others.some((entry) => entry.full)) &&
        sameApp.length < options.maxWorkers &&
        budget.requestsRemaining - options.reserve.requests - used.requests >= options.need.requests &&
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
      if (state.runs.some((run) => run !== entry && run.zones.some((zone) => wanted.includes(zone)))) throw new Error('team zone held by another run');
      entry.zones = [...new Set([...entry.zones, ...wanted])].sort();
    });
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
