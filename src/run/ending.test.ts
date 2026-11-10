// Every ending a run can have, read the three ways a run reports it: the
// command line's exit code and last line, the action's `code` output with
// its warning or failure, and the run report's `exitStatus`. All three come
// from `runEnding`, so they agree on each row.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { endedRun } from '../cli.ts';
import { type EndingSink, reportEnding } from '../action/main.ts';
import { buildReport, failed } from '../setup/report.ts';
import { toRunReport } from './finish.ts';
import { type OperationOutcome } from './operation.ts';

const STOP = { kind: 'rate-limit', limits: {} };

function outcome(fields: Record<string, unknown>): OperationOutcome {
  return {
    operation: 'sync',
    ok: true,
    summary: 'summary\n',
    notImplemented: false,
    refusedPushes: [],
    writes: { linear: {}, git: {}, pullRequests: {} },
    ...fields,
  } as unknown as OperationOutcome;
}

function capture(fields: Record<string, unknown> = {}) {
  return { ok: true, changed: [], removed: [], heldRemovals: [], blocked: [], leftOut: [], writeBackWarnings: [], ...fields };
}

function write(fields: Record<string, unknown> = {}) {
  return {
    complete: true, changed: false, resumed: false, updated: [], relocated: [], created: [], trashed: [], adopted: [], restored: [], conflicts: [],
    decided: [], skipped: [], leftOut: [], leftOutAtWrite: [], failed: [], notAttempted: [], rereadWindowMs: null, record: null, ...fields,
  };
}

/** A sync run that reached its write step, with the pull request's code and the write's fields. */
function syncRun(pullRequestCode: string | undefined, writeFields: Record<string, unknown> = {}, captureFields: Record<string, unknown> = {}): OperationOutcome {
  const result = write(writeFields);
  return outcome({
    captured: capture(captureFields),
    sync: {
      complete: result.complete,
      changed: true,
      trackedTip: 'tip',
      capture: capture(),
      pullRequest: { needed: true, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [], marked: [], decided: [], ...(pullRequestCode === undefined ? {} : { code: pullRequestCode }) },
      write: result,
    },
  });
}

function confirmed(fields: Record<string, unknown>) {
  return {
    complete: true, resumed: false, created: [], overwritten: [], unchanged: [], skippedCompleted: [], trashed: [], leftOutAtWrite: [], failed: [],
    notAttempted: [], progressPushes: 0, progressRecorded: true, record: null, ...fields,
  };
}

function reverse(fields: Record<string, unknown>) {
  return {
    complete: true, resumed: false, overwritten: [], created: [], skippedCompleted: [], removed: [], leftOutAtRecord: [], notAttempted: [],
    progressPushes: 0, record: null, pullRequest: null, ...fields,
  };
}

const setupFailure = buildReport([failed('annotation-targets', 'annotation-target-not-found', 'not found in Linear: team "Engineering"')], []);

interface Row {
  name: string;
  outcome: OperationOutcome;
  status: 'success' | 'warning' | 'failure';
  exitCode: number;
  /** The ending's line; the command line prefixes a warning's with `warning: `. */
  message: string | undefined;
  code: string;
}

const ROWS: Row[] = [
  {
    name: 'a finished sync',
    outcome: syncRun(undefined),
    status: 'success', exitCode: 0, message: undefined, code: '',
  },
  {
    name: 'the stage step of the security hooks',
    outcome: outcome({ staged: { sets: 2 } }),
    status: 'success', exitCode: 0, message: undefined, code: '',
  },
  {
    name: 'a failed check on the sync pull request, before a partial write',
    outcome: syncRun('check-failed', { complete: false, code: 'stopped', stopped: STOP }),
    status: 'failure', exitCode: 3, message: 'sync: setup error (check-failed): a check failed on the sync pull request', code: 'check-failed',
  },
  {
    name: 'an initial sync from Linear waiting for a person to merge it',
    outcome: syncRun('initial-pull-request-pending'),
    status: 'failure', exitCode: 4, message: 'sync: stopped short (initial-pull-request-pending): an initial sync from Linear waits for a person to merge it', code: 'initial-pull-request-pending',
  },
  {
    name: 'a GitHub failure in the sync pull request step alone',
    outcome: syncRun('github-failed'),
    status: 'failure', exitCode: 5, message: 'sync: not finished (github-failed); run it again', code: 'github-failed',
  },
  {
    name: 'a GitHub failure yields to a partial write',
    outcome: syncRun('github-failed', { complete: false, code: 'write-failed' }),
    status: 'warning', exitCode: 5, message: 'sync: partial, will continue (write-failed)', code: 'write-failed',
  },
  {
    name: 'a sync Linear stopped while capturing',
    outcome: outcome({ captured: capture({ ok: false, code: 'stopped', stopped: STOP }) }),
    status: 'warning', exitCode: 5, message: 'sync: partial, will continue (stopped)', code: 'stopped',
  },
  {
    name: 'a sync that held a removal it could not confirm',
    outcome: syncRun(undefined, {}, { heldRemovals: [{ path: 'a.md' }] }),
    status: 'warning', exitCode: 5, message: 'sync: partial, will continue (removal-held)', code: 'removal-held',
  },
  {
    name: 'a check Linear stopped before any write',
    outcome: outcome({ operation: 'check', ok: false, stopped: STOP }),
    status: 'failure', exitCode: 5, message: 'check: stopped by Linear before any write; run it again once the limit has reset', code: 'stopped',
  },
  {
    name: 'a failed setup check',
    outcome: outcome({ ok: false, code: setupFailure.code, setup: setupFailure }),
    status: 'failure', exitCode: 3,
    message: 'sync: stopped before any write (annotation-target-not-found): not found in Linear: team "Engineering". How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#folder-annotations',
    code: 'annotation-target-not-found',
  },
  {
    name: 'a sync without recorded state',
    outcome: outcome({ ok: false, code: 'initial-sync-required', refusal: { code: 'initial-sync-required', message: 'the sync has no recorded state: run the initial sync first' } }),
    status: 'failure', exitCode: 4,
    message: 'sync: stopped before any write (initial-sync-required): the sync has no recorded state: run the initial sync first. How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#initial-sync',
    code: 'initial-sync-required',
  },
  {
    name: 'a sync whose container is at its cap',
    outcome: syncRun(undefined, { complete: false, code: 'container-cap' }),
    status: 'failure', exitCode: 5, message: 'sync: stopped before any write (container-cap); reduce additions or check document-cap', code: 'container-cap',
  },
  {
    name: 'an initial sync whose container is at its cap',
    outcome: outcome({ operation: 'initial-sync', confirmed: confirmed({ complete: false, code: 'container-cap' }) }),
    status: 'failure', exitCode: 5, message: 'initial-sync: stopped before any write (container-cap); reduce additions or check document-cap', code: 'container-cap',
  },
  {
    name: 'an unfinished initial sync from git',
    outcome: outcome({ operation: 'initial-sync', confirmed: confirmed({ complete: false, code: 'stopped', stopped: STOP }) }),
    status: 'failure', exitCode: 5, message: 'initial-sync: not finished (stopped); run it again with the same inputs', code: 'stopped',
  },
  {
    name: 'an unfinished initial sync from Linear whose sync branch a person changed',
    outcome: outcome({ operation: 'initial-sync', reverse: reverse({ complete: false, code: 'sync-branch-changed' }) }),
    status: 'failure', exitCode: 5,
    message: 'initial-sync: not finished (sync-branch-changed); merge or close the pull request of the sync branch and delete the branch, then run it again',
    code: 'sync-branch-changed',
  },
  {
    name: 'an operation that is not built yet',
    outcome: outcome({ operation: 'check', notImplemented: true }),
    status: 'failure', exitCode: 15, message: 'check: not implemented', code: '',
  },
];

/** What the action reported: its `code` output and its warnings and failures. */
function actionEnding(outcome: OperationOutcome) {
  const reported = { code: undefined as string | undefined, warnings: [] as string[], failures: [] as string[] };
  const sink: EndingSink = {
    setOutput: (name, value) => { if (name === 'code') reported.code = String(value); },
    warning: (message) => { reported.warnings.push(String(message)); },
    setFailed: (message) => { reported.failures.push(String(message)); },
  };
  reportEnding(outcome, sink);
  return reported;
}

describe('how a run ends, on the command line, in the action and in the report', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const cli = endedRun(row.outcome, 'warning: earlier\n');
      assert.equal(cli.exitCode, row.exitCode, 'exit code');
      assert.equal(cli.stdout, row.outcome.summary);
      const line = row.message === undefined ? '' : `${row.status === 'warning' ? 'warning: ' : ''}${row.message}\n`;
      assert.equal(cli.stderr, `warning: earlier\n${line}`, 'command line message');

      const action = actionEnding(row.outcome);
      assert.equal(action.code, row.code, 'action code');
      assert.deepEqual(action.warnings, row.status === 'warning' ? [row.message] : [], 'action warning');
      assert.deepEqual(action.failures, row.status === 'failure' ? [row.message] : [], 'action failure');

      const report = toRunReport(row.outcome);
      assert.equal(report.exitStatus, row.status, 'report exit status');
      assert.equal(report.code ?? '', row.code, 'report code');
      // A run that ends well exits 0 and says nothing more; any other ending says why.
      assert.equal(row.exitCode === 0, row.status === 'success');
      assert.equal(row.message === undefined, row.status === 'success');
    });
  }
});
