// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names, paths and states only, no content.

import { writeFile } from 'node:fs/promises';
import { type ConfirmedResult, type PlanReport, UPLOAD_TOO_LARGE, type WriteStop } from '../initial-sync/index.ts';
import { type SyncRecord, type WriteResult } from '../sync/index.ts';
import { type OperationOutcome } from './operation.ts';
import { type PreflightOutcome } from './preflight.ts';

export interface RunReport {
  operation: PreflightOutcome['operation'];
  ok: boolean;
  /** Why the run stopped before writing, or why a confirmed initial sync or a sync run did not finish. */
  code: string | null;
  /**
   * The run finished its work: a confirmed initial sync recorded the state,
   * or a sync run made every change and recorded it with a merge commit.
   * When false, another run with the same inputs goes on.
   */
  complete: boolean;
  /** The run wrote to Linear or moved a state ref; false when it found nothing to do. */
  changed: boolean;
  setupChecks: Array<{ name: string; state: string; detail: string }>;
  securityHooks: string[] | null;
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** An initial sync's plan: what its job summary lists, as data. */
  summary: PlanReport | null;
  /** A confirmed initial sync's writes, by path; null for other runs. */
  initialSync: ConfirmedReport | null;
  /** A sync run's writes to Linear, by path; null for other runs. */
  sync: SyncReport | null;
  /** Documents created or overwritten in Linear by this run. */
  writtenCount: number;
  /** Documents an unfinished earlier run had written, skipped by this one. */
  skippedCompletedCount: number;
  /** Files over the upload limit, by repository path; the documents that link them are left out. */
  oversizeFiles: string[];
  /** The run continued an unfinished initial sync. */
  resumed: boolean;
  /** The run stopped writing before it finished (rate limit, low budget, test threshold). */
  stoppedEarly: boolean;
  /** Every document this run wrote has its id in the `ids` state ref. */
  progressRecorded: boolean;
  /** The `linear` record this run made or confirmed; null when it recorded none. */
  record: { kind: 'initial'; commit: string; moved: boolean; hasTrackedParent: boolean; reformattedCount: number } | null;
}

/** A sync run's writes to Linear, by path. */
export interface SyncReport {
  complete: boolean;
  updated: string[];
  relocated: WriteResult['relocated'];
  created: string[];
  adopted: string[];
  trashed: string[];
  skipped: WriteResult['skipped'];
  leftOut: WriteResult['leftOut'];
  leftOutAtWrite: WriteResult['leftOutAtWrite'];
  failed: WriteResult['failed'];
  notAttempted: string[];
  stopped: WriteStop | null;
  /** The `linear` commit this run recorded: a merge of the tracked branch, or an ordinary commit when changes are left; null when it recorded none. */
  record: SyncRecord | null;
}

export interface ConfirmedReport {
  complete: boolean;
  created: string[];
  overwritten: string[];
  unchanged: string[];
  skippedCompleted: string[];
  trashed: string[];
  leftOutAtWrite: ConfirmedResult['leftOutAtWrite'];
  failed: ConfirmedResult['failed'];
  notAttempted: string[];
  stopped: WriteStop | null;
  progressPushes: number;
  reformatted: string[];
}

export function toRunReport(outcome: OperationOutcome): RunReport {
  if (outcome.sync !== undefined) return toSyncRunReport(outcome, outcome.sync.write);
  const confirmed = outcome.confirmed;
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? confirmed?.code ?? null,
    complete: confirmed?.complete ?? false,
    changed: confirmed !== undefined && (confirmed.created.length + confirmed.overwritten.length + confirmed.trashed.length > 0 || confirmed.record?.moved === true),
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: outcome.notImplemented,
    summary: outcome.plan ?? null,
    initialSync: confirmed === undefined ? null : toConfirmedReport(confirmed),
    sync: null,
    writtenCount: confirmed === undefined ? 0 : confirmed.created.length + confirmed.overwritten.length,
    skippedCompletedCount: confirmed?.skippedCompleted.length ?? 0,
    oversizeFiles: [...new Set((confirmed?.leftOutAtWrite ?? []).filter((entry) => entry.rule === UPLOAD_TOO_LARGE).flatMap((entry) => entry.files ?? []))].sort(),
    resumed: confirmed?.resumed ?? false,
    stoppedEarly: confirmed?.stopped !== undefined,
    // A stopped run pushes the ids it has before it ends; only a state ref that moved under it prevents that.
    progressRecorded: confirmed?.progressRecorded ?? false,
    record:
      confirmed?.record == null
        ? null
        : {
            kind: 'initial',
            commit: confirmed.record.linear,
            moved: confirmed.record.moved,
            hasTrackedParent: confirmed.record.hasTrackedParent,
            reformattedCount: confirmed.record.reformatted.length,
          },
  };
}

function toSyncRunReport(outcome: OperationOutcome, write: WriteResult): RunReport {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? write.code ?? null,
    complete: write.complete,
    changed: write.changed,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: false,
    summary: null,
    initialSync: null,
    sync: {
      complete: write.complete,
      updated: write.updated,
      relocated: write.relocated,
      created: write.created,
      adopted: write.adopted,
      trashed: write.trashed,
      skipped: write.skipped,
      leftOut: write.leftOut,
      leftOutAtWrite: write.leftOutAtWrite,
      failed: write.failed,
      notAttempted: write.notAttempted,
      stopped: write.stopped ?? null,
      record: write.record,
    },
    writtenCount: new Set([...write.updated, ...write.created, ...write.relocated.map((entry) => entry.to)]).size,
    skippedCompletedCount: 0,
    oversizeFiles: [...new Set(write.leftOutAtWrite.filter((entry) => entry.rule === UPLOAD_TOO_LARGE).flatMap((entry) => entry.files ?? []))].sort(),
    resumed: false,
    stoppedEarly: write.stopped !== undefined,
    progressRecorded: write.code !== 'state-moved',
    record: null,
  };
}

function toConfirmedReport(result: ConfirmedResult): ConfirmedReport {
  return {
    complete: result.complete,
    created: result.created,
    overwritten: result.overwritten,
    unchanged: result.unchanged,
    skippedCompleted: result.skippedCompleted,
    trashed: result.trashed,
    leftOutAtWrite: result.leftOutAtWrite,
    failed: result.failed,
    notAttempted: result.notAttempted,
    stopped: result.stopped ?? null,
    progressPushes: result.progressPushes,
    reformatted: result.record?.reformatted ?? [],
  };
}

export async function writeRunReport(path: string, outcome: OperationOutcome): Promise<void> {
  await writeFile(path, `${JSON.stringify(toRunReport(outcome), null, 2)}\n`);
}
