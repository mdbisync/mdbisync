// How a run ends when Linear's faults and the sync pull request's failures
// meet: a failure a person must fix comes first, a transient pull request
// failure yields to a partial ending, and alone it fails the run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exitStatusOf, partialCode, pullRequestEnding } from './exit.ts';
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
    ['a failed check on the sync pull request beats a partial write', 'check-failed', 'stopped', undefined, 'failure', 'check-failed'],
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
});
