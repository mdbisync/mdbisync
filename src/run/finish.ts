// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names, paths and states only, no content.

import { writeFile } from 'node:fs/promises';
import { type ConfirmedResult, type PlanReport, type WriteStop } from '../initial-sync/index.ts';
import { type OperationOutcome } from './operation.ts';
import { type PreflightOutcome } from './preflight.ts';

export interface RunReport {
  operation: PreflightOutcome['operation'];
  ok: boolean;
  /** Why the run stopped before writing, or why a confirmed initial sync did not finish. */
  code: string | null;
  setupChecks: Array<{ name: string; state: string; detail: string }>;
  securityHooks: string[] | null;
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** An initial sync's plan: what its job summary lists, as data. */
  summary: PlanReport | null;
  /** A confirmed initial sync's writes, by path; null for other runs. */
  initialSync: ConfirmedReport | null;
  /** Documents created or overwritten in Linear by this run. */
  writtenCount: number;
  /** Documents an unfinished earlier run had written, skipped by this one. */
  skippedCompletedCount: number;
  /** The run continued an unfinished initial sync. */
  resumed: boolean;
  /** The run stopped writing before it finished (rate limit, low budget, test threshold). */
  stoppedEarly: boolean;
  /** Every document this run wrote has its id in the `ids` state ref. */
  progressRecorded: boolean;
  /** The `linear` record this run made or confirmed; null when it recorded none. */
  record: { kind: 'initial'; commit: string; moved: boolean; hasTrackedParent: boolean; reformattedCount: number } | null;
}

export interface ConfirmedReport {
  complete: boolean;
  created: string[];
  overwritten: string[];
  unchanged: string[];
  skippedCompleted: string[];
  trashed: string[];
  leftOutAtWrite: Array<{ path: string; rule: string }>;
  failed: ConfirmedResult['failed'];
  notAttempted: string[];
  stopped: WriteStop | null;
  progressPushes: number;
  reformatted: string[];
}

export function toRunReport(outcome: OperationOutcome): RunReport {
  const confirmed = outcome.confirmed;
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? confirmed?.code ?? null,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: outcome.notImplemented,
    summary: outcome.plan ?? null,
    initialSync: confirmed === undefined ? null : toConfirmedReport(confirmed),
    writtenCount: confirmed === undefined ? 0 : confirmed.created.length + confirmed.overwritten.length,
    skippedCompletedCount: confirmed?.skippedCompleted.length ?? 0,
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
