// A run held for its UI steps, saved so a later harness process can take it
// up again. When a scenario reaches a UI step, the runner keeps the run's
// branches and projects and writes `held-run.json` next to the checklist:
// where the scenario stopped, what its steps recorded so far and how to find
// its Linear projects and teams again. `ui-result` reads it back, applies the
// UI session's answers and goes on from that step.
//
// The file holds no credentials: tokens and clients are made again from the
// test configuration. It stays in the run's local output folder and is
// removed once the run is cleaned up.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineResult } from './engine.ts';
import type { ProxyRequestRecord } from './fault-proxy.ts';
import type { EditRecord, RunContext } from './context.ts';
import type { Manifest, RunTree } from './corpus.ts';
import type { Project, Team } from './linear-world.ts';

export const HELD_RUN_FILE = 'held-run.json';
export const UI_CHECKLIST_FILE = 'ui-checklist.md';

export interface HeldRun {
  version: 1;
  scenarioId: string;
  runId: string;
  /** The index in the scenario's steps of the first step not done yet (a UI step). */
  stepIndex: number;
  /** The OAuth app the engine and the harness's reads used. */
  appName: string;
  /** The run's resources stay until then, epoch milliseconds. */
  holdUntil: number;
  startedAt: string;
  budgetWaitMs: number;
  /** Harness requests of earlier take-ups that ended waiting; the run's report counts the part before the hold. */
  takeUpRequests: { harness: number; harnessApp: number };
  engine: { results: EngineResult[]; setupRuns: number };
  edits: EditRecord[];
  ownCommits: string[];
  sequence: number;
  uiSteps: number;
  observations: Map<string, unknown>;
  /** The Linear proxy's records so far, so I9 counts the whole run. */
  proxyRequests: ProxyRequestRecord[];
  live: {
    githubTokenSource: 'app' | 'host';
    repository: string;
    manifest: Manifest;
    tree: RunTree;
    projects: Map<string, Project>;
    teams: Map<string, Team>;
    seededDocuments: string[];
    documentUrlBase: string;
  };
}

// JSON with the types the run's state holds besides plain data: Map, Set and Buffer.
const TAG = '$held';

function replacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Map) return { [TAG]: 'Map', entries: [...raw.entries()] };
  if (raw instanceof Set) return { [TAG]: 'Set', values: [...raw.values()] };
  if (Buffer.isBuffer(raw)) return { [TAG]: 'Buffer', base64: raw.toString('base64') };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, TAG)) return value;
  const tagged = value as Record<string, unknown>;
  switch (tagged[TAG]) {
    case 'Map':
      return new Map(tagged.entries as Array<[unknown, unknown]>);
    case 'Set':
      return new Set(tagged.values as unknown[]);
    case 'Buffer':
      return Buffer.from(String(tagged.base64), 'base64');
    default:
      throw new Error(`unknown tagged value in ${HELD_RUN_FILE}: ${String(tagged[TAG])}`);
  }
}

export function encodeHeldRun(held: HeldRun): string {
  return `${JSON.stringify(held, replacer)}\n`;
}

export function decodeHeldRun(text: string): HeldRun {
  const held = JSON.parse(text, reviver) as HeldRun;
  if (held.version !== 1) throw new Error(`${HELD_RUN_FILE} has version ${String(held.version)}, not 1`);
  return held;
}

/** Observations that hold credentials (the engine's bearer tokens): never written to disk, so a run holding them is not kept. */
const NEVER_SAVED = ['tokens.seen'];

/** What the run holds now, for `held-run.json`. */
export function heldRunOf(ctx: RunContext, extra: Pick<HeldRun, 'stepIndex' | 'appName' | 'holdUntil' | 'startedAt' | 'budgetWaitMs' | 'takeUpRequests'>): HeldRun {
  const live = ctx.live;
  if (live === null) throw new Error('only a live run can be held for its UI steps');
  const credentials = NEVER_SAVED.filter((key) => ctx.observations.has(key));
  if (credentials.length > 0) throw new Error(`the run recorded credentials (${credentials.join(', ')}), which are never written to disk`);
  // Faults live in this process (the proxy's armed faults, the engine's extra environment, undo steps): a later
  // process could not go on with them, and a run that went on without them could pass falsely.
  const faults = [
    ...((ctx.proxy?.armedFaults() ?? 0) > 0 ? ['armed proxy faults'] : []),
    ...(Object.keys(ctx.engine.env).length > 0 ? ['engine environment of a fault'] : []),
    ...(ctx.engine.badCredential !== undefined ? ['a credentials fault'] : []),
    ...(ctx.engine.restores.length > 0 ? ['undo steps of a fault'] : []),
    ...(ctx.engine.trigger !== undefined || ctx.engine.pausedAt !== undefined ? ['a run paused at a checkpoint'] : []),
  ];
  if (faults.length > 0) throw new Error(`the run holds state that cannot be saved: ${faults.join(', ')}`);
  return {
    version: 1,
    scenarioId: ctx.scenario.id,
    runId: ctx.names.runId,
    ...extra,
    engine: { results: ctx.engine.results, setupRuns: ctx.engine.setupRuns },
    edits: ctx.edits,
    ownCommits: ctx.ownCommits,
    sequence: ctx.sequence,
    uiSteps: ctx.uiSteps,
    // Remote texts read for the canary scan, and the documents they came from, are read again after the
    // take-up: steps run then may add to them.
    observations: new Map([...ctx.observations].filter(([key]) => key !== 'canary.remoteTexts' && key !== 'canary.documents')),
    proxyRequests: [...(ctx.proxy?.requests ?? [])],
    live: {
      githubTokenSource: live.githubTokenSource,
      repository: live.repository,
      manifest: live.manifest,
      tree: live.tree,
      projects: live.projects,
      teams: live.teams,
      seededDocuments: live.seededDocuments,
      documentUrlBase: live.documentUrlBase,
    },
  };
}

export function saveHeldRun(runDir: string, held: HeldRun): void {
  const file = join(runDir, HELD_RUN_FILE);
  writeFileSync(`${file}.tmp`, encodeHeldRun(held));
  renameSync(`${file}.tmp`, file);
}

export function loadHeldRun(runDir: string): HeldRun {
  let text: string;
  try {
    text = readFileSync(join(runDir, HELD_RUN_FILE), 'utf8');
  } catch {
    throw new Error(`${runDir} holds no run waiting for its UI steps (no ${HELD_RUN_FILE}): it was never held, or it was already taken up and cleaned up`);
  }
  return decodeHeldRun(text);
}

export function forgetHeldRun(runDir: string): void {
  rmSync(join(runDir, HELD_RUN_FILE), { force: true });
}
