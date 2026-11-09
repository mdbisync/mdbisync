// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names, paths and states only, no content.

import { writeFile } from 'node:fs/promises';
import { type ConfirmedResult, type PlanReport, type ReverseResult, type WriteStop } from '../initial-sync/index.ts';
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
  /** The `linear` record an initial sync from git to Linear made or confirmed; null otherwise (a run from Linear reports its record under `linearToGit`). */
  record: { kind: 'initial'; commit: string; moved: boolean; hasTrackedParent: boolean; reformattedCount: number } | null;
  /** A confirmed initial sync from Linear: what it took and the pull request it left for a person; null for other runs. */
  linearToGit: ReverseReport | null;
}

export interface ReverseReport {
  complete: boolean;
  overwritten: string[];
  created: string[];
  skippedCompleted: string[];
  removed: string[];
  leftOutAtRecord: Array<{ path: string; rule: string }>;
  notAttempted: string[];
  stopped: WriteStop | null;
  progressPushes: number;
  /** The record commit, which is also the pull request's head. */
  record: { commit: string; moved: boolean; hasTrackedParent: boolean; changesTracked: boolean } | null;
  pullRequest: { number: number; url: string; opened: boolean } | null;
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
  const reverse = outcome.reverse;
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? confirmed?.code ?? reverse?.code ?? null,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: outcome.notImplemented,
    summary: outcome.plan ?? null,
    initialSync: confirmed === undefined ? null : toConfirmedReport(confirmed),
    writtenCount: confirmed === undefined ? 0 : confirmed.created.length + confirmed.overwritten.length,
    skippedCompletedCount: confirmed?.skippedCompleted.length ?? reverse?.skippedCompleted.length ?? 0,
    resumed: confirmed?.resumed ?? reverse?.resumed ?? false,
    stoppedEarly: confirmed?.stopped !== undefined || reverse?.stopped !== undefined,
    // A stopped run pushes the ids it has before it ends; only a state ref that moved under it prevents that.
    progressRecorded: confirmed?.progressRecorded ?? (reverse !== undefined && reverse.code !== 'state-moved'),
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
    linearToGit: reverse === undefined ? null : toReverseReport(reverse),
  };
}

function toReverseReport(result: ReverseResult): ReverseReport {
  return {
    complete: result.complete,
    overwritten: result.overwritten,
    created: result.created,
    skippedCompleted: result.skippedCompleted,
    removed: result.removed,
    leftOutAtRecord: result.leftOutAtRecord,
    notAttempted: result.notAttempted,
    stopped: result.stopped ?? null,
    progressPushes: result.progressPushes,
    record:
      result.record === null
        ? null
        : { commit: result.record.linear, moved: result.record.moved, hasTrackedParent: result.record.hasTrackedParent, changesTracked: result.record.changesTracked },
    pullRequest: result.pullRequest === null ? null : { number: result.pullRequest.number, url: result.pullRequest.url, opened: result.pullRequest.opened },
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
