// What a scenario run holds while its steps execute.

import type { LinearClient } from '../../../src/linear/index.ts';
import type { Git } from '../../../src/state/index.ts';
import type { Checkpoint } from '../../../src/test-hooks.ts';
import type { CheckpointControl } from './checkpoints.ts';
import type { Manifest, RunTree } from './corpus.ts';
import type { EngineResult, RunningEngine } from './engine.ts';
import type { FaultProxy } from './fault-proxy.ts';
import type { SandboxRest } from './github.ts';
import type { RunNames } from './isolation.ts';
import type { LinearWorld, Project, Team } from './linear-world.ts';
import type { Sandbox } from './sandbox.ts';
import type { Scenario } from './spec.ts';

export type Editor = 'editor-a' | 'editor-b';

/** An edit a step made, for I2: its token must end up on both sides. */
export interface EditRecord {
  side: 'git' | 'linear';
  path: string;
  token: string;
  /** The edit was a removal: the token must be gone on both sides. */
  removal?: boolean;
  /** A conflict resolution discarded this edit on purpose (it kept the other version): I2 does not expect it. */
  retired?: boolean;
}

export interface LiveWorld {
  sandbox: Sandbox;
  rest: SandboxRest;
  githubToken: string;
  githubTokenSource: 'app' | 'host';
  /** owner/name of the sandbox. */
  repository: string;
  manifest: Manifest;
  tree: RunTree;
  /** Placeholder → the run's project in Linear. */
  projects: Map<string, Project>;
  /** Team key → team. */
  teams: Map<string, Team>;
  /** The harness's reads, as the OAuth app (its requests count against the app's budget). */
  app: LinearClient;
  editors: Record<Editor, LinearClient>;
  /** Project creation and cleanup, as editor-a. */
  world: LinearWorld;
  /** The OAuth app the engine uses in this run. */
  engineApp: { clientId: string; clientSecret: string };
  /** Team-zone documents seeded by the harness, for cleanup. */
  seededDocuments: string[];
  /** The URL prefix of the test workspace's documents (`https://linear.app/<url key>/document`). */
  documentUrlBase: string;
  /** Downloads an upload URL as editor-a (uploads need an authenticated request). */
  download(url: string): Promise<Buffer>;
}

export interface RunContext {
  scenario: Scenario;
  names: RunNames;
  runDir: string;
  live: LiveWorld | null;
  /** The sandbox, known before the live world is complete, so cleanup can remove an early branch. */
  sandbox?: Sandbox;
  proxy: FaultProxy | null;
  checkpoints: CheckpointControl;
  engine: {
    results: EngineResult[];
    /** How many of `results` the setup made; `runs.N` in assertions counts from the scenario's first own run. */
    setupRuns: number;
    pending?: RunningEngine;
    pausedAt?: Checkpoint;
    /** Extra environment for the engine set by faults (test hooks only). */
    env: Record<string, string>;
    /** Credentials override set by a credentials fault. */
    badCredential?: 'linear' | 'github';
    /** Something the harness does while the next run waits at a checkpoint (a fault in the middle of a run). */
    trigger?: { checkpoint: Checkpoint; action: () => Promise<void> };
    /** Undo steps of faults that changed the repository or Linear; `fault.clear` runs them. */
    restores: Array<() => Promise<void>>;
  };
  edits: EditRecord[];
  /** Commits the scenario's own git steps pushed to the tracked branch (I3). */
  ownCommits: string[];
  /** Values the steps observed, for assertions by subject. */
  observations: Map<string, unknown>;
  /** UI steps the scenario holds, for the checklist. */
  uiSteps: number;
  /** Counter for edit tokens. */
  sequence: number;
  log(line: string): void;
  /** Names the setup phase now running, for the log and for a setup that does not finish. Throws once setup was told to stop. */
  phase(name: string): void;
  /** Aborted when setup missed its deadline. */
  signal: AbortSignal;
  /** A clone of the tracked branch where people commit; made on first use. */
  person(): Promise<Git>;
  /** Installs the repository's pre-commit hooks in the person's clone, once; commits that do not bypass the hooks call it first. */
  personHooks(): Promise<void>;
  /** The working clone the engine runs in; made on first use. */
  engineClone(): Promise<string>;
}

export function nextToken(ctx: RunContext): string {
  ctx.sequence += 1;
  return `${ctx.names.runId}-${String(ctx.sequence).padStart(3, '0')}`;
}
