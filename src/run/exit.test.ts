// How a run ends when Linear's faults and the sync pull request's failures
// meet: a failure a person must fix comes first, a transient pull request
// failure yields to a partial ending, and alone it fails the run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReport, failed } from '../setup/report.ts';
import { exitStatusOf, partialCode, pullRequestEnding, stoppedBeforeWritingMessage } from './exit.ts';
import { type OperationOutcome } from './operation.ts';

/** A sync outcome with only the fields the ending reads. */
function sync(pullRequestCode: string | undefined, writeCode: string | undefined): OperationOutcome {
  return {
    operation: 'sync',
    ok: true,
    summary: '',
    notImplemented: false,
    sync: {
      complete: writeCode === undefined,
      changed: true,
      ...(pullRequestCode === undefined ? {} : { pullRequest: { code: pullRequestCode } }),
      ...(writeCode === undefined ? {} : { write: { code: writeCode } }),
    },
  } as unknown as OperationOutcome;
}

describe('the ending of a sync run', () => {
  const cases: Array<[string, string | undefined, string | undefined, string | undefined, string, string | undefined]> = [
    // name, pull request code, write code, partial code, exit status, pull request ending
    ['a suspended batch allows a partial write', undefined, 'stopped', 'stopped', 'warning', undefined],
    ['an initial pull request waiting for a person beats a partial write', 'initial-pull-request-pending', 'write-failed', undefined, 'failure', 'initial-pull-request-pending'],
    ['a GitHub server error yields to a partial write', 'github-failed', 'stopped', 'stopped', 'warning', undefined],
    ['a lost pull request lease yields to a partial write', 'state-moved', 'write-failed', 'write-failed', 'warning', undefined],
    ['a GitHub server error alone fails the run', 'github-failed', undefined, undefined, 'failure', 'github-failed'],
    ['a partial write alone is partial', undefined, 'stopped', 'stopped', 'warning', undefined],
    ['a container at its cap is a failure', undefined, 'container-cap', undefined, 'failure', undefined],
    ['a finished run succeeds', undefined, undefined, undefined, 'success', undefined],
  ];
  for (const [name, pullRequest, write, partial, status, ending] of cases) {
    it(name, () => {
      const outcome = sync(pullRequest, write);
      assert.equal(partialCode(outcome), partial);
      assert.equal(exitStatusOf(outcome), status);
      assert.equal(pullRequestEnding(outcome)?.code, ending);
    });
  }

  it('suspended marks that stopped part way make the run partial with their code', () => {
    for (const code of ['write-failed', 'stopped', 'state-moved'] as const) {
      const outcome = sync(undefined, undefined);
      (outcome.sync as unknown as { pullRequest: unknown }).pullRequest = { holdMarks: { set: [], updated: [], cleared: [], deferred: 0, removed: [], code } };
      assert.equal(partialCode(outcome), code);
      assert.equal(exitStatusOf(outcome), 'warning');
    }
    // A write step's own failure names the run first.
    const both = sync(undefined, 'stopped');
    (both.sync as unknown as { pullRequest: unknown }).pullRequest = { holdMarks: { set: [], updated: [], cleared: [], deferred: 0, removed: [], code: 'write-failed' } };
    assert.equal(partialCode(both), 'stopped');
  });
});

describe('the message of a run stopped before any write', () => {
  const stopped = (fields: Record<string, unknown>): OperationOutcome =>
    ({ operation: 'sync', ok: false, summary: '', notImplemented: false, refusedPushes: [], writes: { linear: {}, git: {}, pullRequests: {} }, ...fields }) as OperationOutcome;

  it('names the failed setup check, the first failure as the report records it', () => {
    const setup = buildReport([
      failed('annotation-targets', 'annotation-target-not-found', 'not found in Linear: project "Platform" of team "Engineering"'),
      failed('left-out-files', 'invalid-annotation', 'a later failure'),
    ], []);
    assert.equal(
      stoppedBeforeWritingMessage('sync', stopped({ code: setup.code, setup })),
      'sync: stopped before any write (annotation-target-not-found): not found in Linear: project "Platform" of team "Engineering". How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#folder-annotations',
    );
  });

  it('gives a state refusal its message', () => {
    const refusal = { code: 'initial-sync-required' as const, message: 'the sync has no recorded state: run the initial sync first' };
    assert.equal(
      stoppedBeforeWritingMessage('sync', stopped({ code: refusal.code, refusal })),
      'sync: stopped before any write (initial-sync-required): the sync has no recorded state: run the initial sync first. How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#initial-sync',
    );
  });

  it('ends a message that is a sentence with one period before its fix link', () => {
    const refusal = { code: 'initial-sync-required' as const, message: 'refs/mdbisync/linear does not exist: run initial sync first. The sync wrote nothing.' };
    assert.equal(
      stoppedBeforeWritingMessage('sync', stopped({ code: refusal.code, refusal })),
      'sync: stopped before any write (initial-sync-required): refs/mdbisync/linear does not exist: run initial sync first. The sync wrote nothing. How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#initial-sync',
    );
  });

  it('keeps a name with line breaks on one line', () => {
    const setup = buildReport([failed('annotation-targets', 'annotation-target-not-found', 'not found in Linear: team "A\r\n::notice::B"')], []);
    assert.equal(
      stoppedBeforeWritingMessage('sync', stopped({ code: setup.code, setup })),
      'sync: stopped before any write (annotation-target-not-found): not found in Linear: team "A ::notice::B". How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#folder-annotations',
    );
  });

  it('is the code and its fix link when nothing explains it', () => {
    assert.equal(
      stoppedBeforeWritingMessage('check', stopped({ operation: 'check', code: 'no-annotations' })),
      'check: stopped before any write (no-annotations). How to fix it: https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#folder-annotations',
    );
    assert.equal(stoppedBeforeWritingMessage('sync', stopped({ code: 'stopped' })), 'sync: stopped before any write (stopped)');
  });
});
