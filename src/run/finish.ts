// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names, paths and states only, no content.

import { type ContainerCapacity } from './capacity.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type CaptureResult } from '../sync/capture.ts';
import { type ConfirmedResult, type PlanReport, type ReverseResult, UPLOAD_TOO_LARGE, type WriteStop } from '../initial-sync/index.ts';
import { type PullRequestResult, type SyncRecord, type WriteResult } from '../sync/index.ts';
import { type ExitStatus, exitStatusOf, pullRequestEnding } from './exit.ts';
import { cell } from './summary.ts';
import { type OperationOutcome } from './operation.ts';
import { type PreflightOutcome } from './preflight.ts';

export interface RunReport {
  capacity: ContainerCapacity[];
  operation: PreflightOutcome['operation'];
  ok: boolean;
  /** Why the run stopped before writing, or why a confirmed initial sync or a sync run did not finish. */
  code: string | null;
  /** `warning` for a partial run (it recorded what it finished; the next run goes on), `failure` when it could not run. */
  exitStatus: ExitStatus;
  /** Why Linear stopped the run, with the rate-limit headers of the answer that stopped it; null when it did not stop. */
  stop: WriteStop | null;
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
  /** A sync run's step 2, the sync pull request; null for other runs and when capture stopped before it. */
  pullRequest: PullRequestResult | null;
  capture: Pick<CaptureResult, 'ok' | 'changed' | 'removed' | 'blocked' | 'leftOut' | 'stopped'> | null;
  /** Documents created or overwritten in Linear by this run. */
  writtenCount: number;
  /** Documents an unfinished earlier run had written, skipped by this one. */
  skippedCompletedCount: number;
  /** Files over the upload limit, by repository path; the documents that link them are left out. */
  oversizeFiles: string[];
  /** The run continued an unfinished initial sync, or a sync went on from a partial record an earlier run left. */
  resumed: boolean;
  /** Documents created or overwritten in Linear by this run (the same as `writtenCount`). */
  writtenDocuments: number;
  /** Writes the run tried after Linear stopped it (rate limit, low budget); each was refused without a request. */
  writesAfterLimit: number;
  /** A document whose write failed or was rejected is among those recorded as written; never true for a correct run. */
  failedWriteRecorded: boolean;
  /** The job summary gives Linear's endpoint rate-limit headers of the answer that stopped the run. */
  endpointLimitHeadersPresent: boolean;
  /** A document Linear rejected (an error answer, not a lost request) is named in the job summary. */
  rejectedDocumentNamed: boolean;
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
  pullRequest: { number: number; url: string; opened: boolean; updated: boolean } | null;
  /** An earlier run's pull request this run closed, because the tracked branch already equals Linear. */
  closedPullRequest: number | null;
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
  if (outcome.sync?.write !== undefined) return toSyncRunReport(outcome, outcome.sync.write);
  const confirmed = outcome.confirmed;
  const reverse = outcome.reverse;
  return {
    capacity: outcome.plan?.capacity ?? [],
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? outcome.captured?.code ?? pullRequestEnding(outcome)?.code ?? confirmed?.code ?? reverse?.code ?? (outcome.stopped === undefined ? null : 'stopped'),
    exitStatus: exitStatusOf(outcome),
    stop: outcome.stopped ?? outcome.captured?.stopped ?? confirmed?.stopped ?? reverse?.stopped ?? null,
    complete: outcome.sync?.complete ?? confirmed?.complete ?? reverse?.complete ?? false,
    changed:
      outcome.sync?.changed ??
      ((confirmed !== undefined && (confirmed.created.length + confirmed.overwritten.length + confirmed.trashed.length > 0 || confirmed.record?.moved === true)) ||
        (reverse !== undefined &&
          (reverse.record?.moved === true || reverse.progressPushes > 0 || reverse.pullRequest?.opened === true || reverse.pullRequest?.updated === true || reverse.closedPullRequest !== undefined))),
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: outcome.notImplemented,
    summary: outcome.plan ?? null,
    initialSync: confirmed === undefined ? null : toConfirmedReport(confirmed),
    capture: captureReport(outcome.captured),
    pullRequest: outcome.sync?.pullRequest ?? null,
    sync: null,
    writtenCount: confirmed === undefined ? 0 : confirmed.created.length + confirmed.overwritten.length,
    skippedCompletedCount: confirmed?.skippedCompleted.length ?? reverse?.skippedCompleted.length ?? 0,
    // A confirmed run finds them at the write; a dry run, before it, and lists them in its plan.
    oversizeFiles: [
      ...new Set(
        confirmed !== undefined
          ? confirmed.leftOutAtWrite.filter((entry) => entry.rule === UPLOAD_TOO_LARGE).flatMap((entry) => entry.files ?? [])
          : (outcome.plan?.leftOutFiles ?? []).filter((entry) => entry.rules.includes(UPLOAD_TOO_LARGE)).flatMap((entry) => entry.files ?? []),
      ),
    ].sort(),
    resumed: confirmed?.resumed ?? reverse?.resumed ?? false,
    ...faultFacts(outcome, outcome.stopped ?? outcome.captured?.stopped ?? confirmed?.stopped ?? reverse?.stopped, confirmed?.failed ?? [], [...(confirmed?.created ?? []), ...(confirmed?.overwritten ?? [])]),
    stoppedEarly: confirmed?.stopped !== undefined || reverse?.stopped !== undefined || outcome.stopped !== undefined || outcome.captured?.stopped !== undefined,
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
    pullRequest:
      result.pullRequest === null
        ? null
        : { number: result.pullRequest.number, url: result.pullRequest.url, opened: result.pullRequest.opened, updated: result.pullRequest.updated },
    closedPullRequest: result.closedPullRequest ?? null,
  };
}

function toSyncRunReport(outcome: OperationOutcome, write: WriteResult): RunReport {
  return {
    capacity: write.capacity ?? [],
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? pullRequestEnding(outcome)?.code ?? write.code ?? null,
    exitStatus: exitStatusOf(outcome),
    stop: write.stopped ?? null,
    complete: outcome.sync!.complete,
    changed: outcome.sync!.changed,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: false,
    summary: null,
    initialSync: null,
    capture: captureReport(outcome.captured),
    pullRequest: outcome.sync?.pullRequest ?? null,
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
    resumed: write.resumed,
    ...faultFacts(outcome, write.stopped, write.failed, [...write.updated, ...write.created, ...write.relocated.map((entry) => entry.to)]),
    stoppedEarly: write.stopped !== undefined,
    progressRecorded: write.code !== 'state-moved',
    record: null,
    linearToGit: null,
  };
}

/**
 * What the run did about Linear's faults, read from its results and its
 * job summary: the summary is what a person reads, so a fact about it is
 * checked in its text.
 */
/** The requests that write a document; a failed read is never a rejection of a document. */
const WRITES = new Set(['CreateDocument', 'UpdateDocument', 'TrashDocument']);

function faultFacts(outcome: OperationOutcome, stop: WriteStop | undefined, failed: ReadonlyArray<{ path: string; operation: string; error: string }>, written: readonly string[]) {
  const recorded = new Set(written);
  const limits = stop === undefined || stop.kind === 'test-threshold' ? {} : (stop.limits ?? {});
  const endpointHeaders = Object.keys(limits).filter((name) => name.startsWith('x-ratelimit-endpoint-'));
  // A rejection is Linear's error answer to the write; a lost request or a server error is not.
  const rejected = failed.filter((entry) => WRITES.has(entry.operation) && entry.error.startsWith('LinearGraphQLError') && !/HTTP 5\d\d/.test(entry.error));
  return {
    writtenDocuments: recorded.size,
    writesAfterLimit: outcome.writesAfterStop ?? 0,
    failedWriteRecorded: failed.some((entry) => recorded.has(entry.path)),
    endpointLimitHeadersPresent: endpointHeaders.length > 0 && endpointHeaders.every((name) => outcome.summary.includes(`| ${name} |`)),
    rejectedDocumentNamed: rejected.length > 0 && rejected.every((entry) => outcome.summary.includes(cell(entry.path))),
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

/** The one-line failure of an initial sync that did not finish: why, and what to do next. */
export function unfinishedMessage(command: string, code: string | undefined): string {
  if (code === 'sync-branch-changed') {
    return `${command}: not finished (${code}); merge or close the pull request of the sync branch and delete the branch, then run it again`;
  }
  return `${command}: not finished (${code}); run it again with the same inputs`;
}

export async function writeRunReport(path: string, outcome: OperationOutcome): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(toRunReport(outcome), null, 2)}\n`);
}

function captureReport(captured: CaptureResult | undefined): RunReport['capture'] {
  return captured === undefined ? null : {ok:captured.ok, changed:captured.changed, removed:captured.removed, blocked:captured.blocked, leftOut:captured.leftOut, ...(captured.stopped ? {stopped:captured.stopped} : {})};
}
