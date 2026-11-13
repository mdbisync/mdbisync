// What a soak keeps so a failed hourly check can be explained without a live
// rerun: a ledger of every edit and sync invocation, appended as each one
// ends, and, when an hourly check fails, a self-contained report written
// before cleanup removes the run's clones, refs and documents. The run's
// classification (fail or expected-red) does not matter: both files stay in
// the run folder.

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor } from './load.ts';
import { redactCredentials } from './person-git.ts';

export const SOAK_EDITS_FILE = 'soak-edits.jsonl';
export const SOAK_SYNCS_FILE = 'soak-syncs.jsonl';

/** The report of the soak's failed hourly check `hour` (1 for the first check). */
export function soakFailureFile(hour: number): string {
  return `soak-failure-hour-${hour}.json`;
}

/** One edit that landed, with its measured write window. */
export interface SoakEditEntry {
  token: string;
  actor: Actor;
  side: 'git' | 'linear';
  path: string;
  /**
   * The edit call's window: from before it read the document or pulled the branch, through any retries, to when
   * the write was confirmed (Linear answered the update, or the push was accepted). `completedAt` is the write's
   * completion; a long window means reads or retries, not a slow write.
   */
  startedAt: string;
  completedAt: string;
  /** The commit a git edit pushed to the tracked branch. */
  commit?: string;
  /** How many sync invocations had ended when the write started: the edit falls between that one and the next. */
  syncsBefore: number;
}

/** One sync invocation of the soak, as it ended. */
export interface SoakSyncEntry {
  /** 1 for the soak's first invocation. */
  index: number;
  invokedAt: string;
  endedAt: string;
  /** The invocation produced an engine result (a workflow run that ended, or a local run). */
  completed: boolean;
  /** The Actions run it watched, when there was one. */
  workflowRunId?: number;
  exitCode?: number | null;
  /** The engine's step summary: what it captured, which pull requests wait and why, what it suspended. */
  summary?: string;
  error?: string;
  /** A run an hourly check waited for, with no edit made since the check's first look. */
  phase?: 'drain';
  /** The failure was a GitHub server error a later scheduled run may recover from (whether the soak tolerated it is in its result). */
  recoverable?: string;
}

/** JSON with credentials redacted in each string value, so redaction never runs across escapes or field boundaries. */
function redactedJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, (_, item: unknown) => (typeof item === 'string' ? redactCredentials(item) : item), indent);
}

/**
 * The soak's ledger. Each entry is appended to its file in the run folder as
 * one JSON line as soon as its event ends, so a crash or a stopped run keeps
 * every event that finished before it; the soak's own entries also stay in
 * memory for its failure report.
 */
export class SoakLedger {
  readonly #runDir: string;
  readonly #edits: SoakEditEntry[] = [];
  readonly #syncs: SoakSyncEntry[] = [];

  constructor(runDir: string) {
    this.#runDir = runDir;
  }

  /** Sync invocations recorded so far. */
  get syncs(): number {
    return this.#syncs.length;
  }

  edit(entry: SoakEditEntry): void {
    this.#edits.push(entry);
    appendFileSync(join(this.#runDir, SOAK_EDITS_FILE), `${redactedJson(entry)}\n`);
  }

  sync(entry: Omit<SoakSyncEntry, 'index'>): void {
    const indexed = { index: this.#syncs.length + 1, ...entry };
    this.#syncs.push(indexed);
    appendFileSync(join(this.#runDir, SOAK_SYNCS_FILE), `${redactedJson(indexed)}\n`);
  }

  edits(): readonly SoakEditEntry[] {
    return this.#edits;
  }

  syncEntries(): readonly SoakSyncEntry[] {
    return this.#syncs;
  }
}

/** Where an edit's token stands at a failed check. */
export interface TokenVerdict extends SoakEditEntry {
  /** The indexes (in the report's `syncs`) of the sync invocations around the write: the last that ended before it, and the next. */
  syncBefore: number | null;
  syncAfter: number | null;
  /** I2's verdict for this edit: its token is not on both sides. */
  lost: boolean;
  /** The token on the tracked branch's synchronized files and in Linear's documents, as I2 reads them. */
  inGit: boolean;
  inLinear: boolean;
  /** Which files and which documents (by their mapped path, or by id) hold the token. */
  gitPaths: string[];
  linearDocuments: string[];
  /** The token in the edited path on the sync branch and on the suspended branch; null when that branch does not exist. */
  inSyncBranch: boolean | null;
  inSuspendedBranch: boolean | null;
}

/** The versions of one edited path at a failed check; null where that side or branch has none. */
export interface PathVersions {
  path: string;
  documentId: string | null;
  /** The path's entry in the ids state ref, with any suspension the engine holds on it. */
  idsEntry: unknown;
  documentTrashed: boolean | null;
  trackedFile: string | null;
  document: string | null;
  syncBranchFile: string | null;
  suspendedBranchFile: string | null;
}

/** What the presence verdicts read: both sides, and the edited paths' texts on the sync and suspended branches. */
export interface PresenceInput {
  files: ReadonlyMap<string, string>;
  /** Document id → content and trash state. */
  documents: ReadonlyMap<string, { content?: string | null; trashed?: boolean | null }>;
  /** Path → mapped document id. */
  ids: ReadonlyMap<string, { id: string }>;
  /** Path → text on that branch, for each edited path it has; null when the branch does not exist. */
  syncBranch: ReadonlyMap<string, string> | null;
  suspendedBranch: ReadonlyMap<string, string> | null;
  /** Tokens I2 counts as lost. */
  lostTokens: ReadonlySet<string>;
  holdsToken: (text: string, token: string) => boolean;
}

/** Each ledger edit's token on each side and branch, with the sync invocations around its write. */
export function tokenVerdicts(edits: readonly SoakEditEntry[], syncs: readonly SoakSyncEntry[], input: PresenceInput): TokenVerdict[] {
  const pathOf = new Map([...input.ids].map(([path, entry]) => [entry.id, path] as const));
  const branch = (texts: ReadonlyMap<string, string> | null, path: string, token: string) => (texts === null ? null : input.holdsToken(texts.get(path) ?? '', token));
  return edits.map((edit) => {
    const gitPaths = [...input.files].filter(([, text]) => input.holdsToken(text, edit.token)).map(([path]) => path);
    const linearDocuments = [...input.documents]
      .filter(([, document]) => document.trashed !== true && input.holdsToken(document.content ?? '', edit.token))
      .map(([id]) => pathOf.get(id) ?? id);
    return {
      ...edit,
      syncBefore: syncs.some((sync) => sync.index === edit.syncsBefore) ? edit.syncsBefore : null,
      syncAfter: syncs.some((sync) => sync.index === edit.syncsBefore + 1) ? edit.syncsBefore + 1 : null,
      lost: input.lostTokens.has(edit.token),
      inGit: gitPaths.length > 0,
      inLinear: linearDocuments.length > 0,
      gitPaths,
      linearDocuments,
      inSyncBranch: branch(input.syncBranch, edit.path, edit.token),
      inSuspendedBranch: branch(input.suspendedBranch, edit.path, edit.token),
    };
  });
}

/** The versions of each path, on both sides and both sync lanes. */
export function pathVersions(paths: Iterable<string>, input: Omit<PresenceInput, 'lostTokens' | 'holdsToken'>): PathVersions[] {
  return [...new Set(paths)].sort().map((path) => {
    const id = input.ids.get(path)?.id ?? null;
    const document = id === null ? undefined : input.documents.get(id);
    return {
      path,
      documentId: id,
      idsEntry: input.ids.get(path) ?? null,
      documentTrashed: document === undefined ? null : document.trashed === true,
      trackedFile: input.files.get(path) ?? null,
      document: document === undefined ? null : document.content ?? '',
      syncBranchFile: input.syncBranch?.get(path) ?? null,
      suspendedBranchFile: input.suspendedBranch?.get(path) ?? null,
    };
  });
}

/**
 * Where the lost edits' tokens are at a failed check. A retained edit is still on one side or on the sync or
 * suspended branch: pending, not propagated, and still a failure. An absent edit is found nowhere: destroyed.
 * When a sync lane could not be read, an edit on neither side is unknown, never called destroyed. An edit
 * outside the soak's ledger (an earlier step's) is named on its own. I2 counts every one of them all the same.
 */
export interface SoakPresence {
  retainedPending: string[];
  absentEverywhere: string[];
  unknown: string[];
  unledgered: string[];
}

/**
 * The lost edits of the verdicts by presence; `unledgered` are the lost tokens the ledger does not hold.
 * `lanesRead` says every existing sync lane was read: a null lane then means the branch does not exist.
 */
export function presenceOf(verdicts: readonly TokenVerdict[], unledgered: readonly string[], lanesRead: boolean): SoakPresence {
  const lost = verdicts.filter((verdict) => verdict.lost);
  const retained = (verdict: TokenVerdict) => verdict.inGit || verdict.inLinear || verdict.inSyncBranch === true || verdict.inSuspendedBranch === true;
  const rest = lost.filter((verdict) => !retained(verdict)).map((verdict) => verdict.token);
  return {
    retainedPending: lost.filter(retained).map((verdict) => verdict.token),
    absentEverywhere: lanesRead ? rest : [],
    unknown: lanesRead ? [] : rest,
    unledgered: [...unledgered],
  };
}

export interface SoakFailureReport {
  hour: number;
  at: string;
  verdict: { I1: boolean; I1Detail?: string; lostEdits: number };
  /** How many sync runs the check waited for before this verdict, of the most it may. */
  boundary: { drainSyncs: number; drainLimit: number };
  /** The lost edits by where their tokens still are. */
  presence: SoakPresence;
  /** The tracked branch's tip the sides were read at. */
  trackedTip: string;
  /** The run's branches and state refs on the remote: ref → commit. */
  refs: Record<string, string>;
  /** The run's sync and suspended pull requests, with their heads and states. */
  pullRequests: unknown[];
  /** Workflow runs on the sync and suspended branches (the checks of their heads), with the jobs of the current heads. */
  checks: unknown[];
  syncs: readonly SoakSyncEntry[];
  tokens: TokenVerdict[];
  /** Missing-side edits in short: token, actor, path and where the token is. */
  missing: Array<{ token: string; actor: Actor; path: string; completedAt: string; inGit: boolean; inLinear: boolean; inSyncBranch: boolean | null; inSuspendedBranch: boolean | null }>;
  payloads: PathVersions[];
  /** Reads that failed while the report was gathered; the rest of the report still holds. */
  evidenceErrors: string[];
}

/** Writes the report in the run folder, credentials redacted; returns its file name. */
export function writeSoakFailure(runDir: string, report: SoakFailureReport): string {
  const name = soakFailureFile(report.hour);
  writeFileSync(join(runDir, name), `${redactedJson(report, 2)}\n`);
  return name;
}

/** The short list of missing-side edits a report leads with. */
export function missingEdits(verdicts: readonly TokenVerdict[]): SoakFailureReport['missing'] {
  return verdicts.filter((verdict) => verdict.lost).map(({ token, actor, path, completedAt, inGit, inLinear, inSyncBranch, inSuspendedBranch }) => ({ token, actor, path, completedAt, inGit, inLinear, inSyncBranch, inSuspendedBranch }));
}
