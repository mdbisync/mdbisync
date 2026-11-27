// How a run ends when Linear's faults and the sync pull request's failures
// meet: a failure a person must fix comes first, and a pull request step the
// next run repeats on its own (a moved ref, a failed GitHub request) makes the
// run partial, after Linear's own partial code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReport, failed } from '../setup/report.ts';
import { exitStatusOf, partialCode, pullRequestEnding, stoppedBeforeWritingMessage } from './exit.ts';
import { type OperationOutcome } from './operation.ts';
import { PULL_REQUEST_CODES, type PullRequestCode } from '../codes.ts';
import { runScaleScript } from '../scale-test-helpers.ts';

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
    ['a GitHub server error alone makes the run partial', 'github-failed', undefined, 'github-failed', 'warning', undefined],
    ['a moved ref in the pull request step alone makes the run partial', 'state-moved', undefined, 'state-moved', 'warning', undefined],
    ['a container at its cap beats a moved ref in the pull request step', 'state-moved', 'container-cap', undefined, 'failure', undefined],
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

  it('a format problems pull request not brought up to date makes the run partial, after every other code', () => {
    for (const code of ['state-moved', 'github-failed'] as const) {
      const outcome = sync(undefined, undefined);
      (outcome.sync as unknown as { formatProblems: unknown }).formatProblems = { code };
      assert.equal(partialCode(outcome), code);
      assert.equal(exitStatusOf(outcome), 'warning');
    }
    const both = sync(undefined, 'write-failed');
    (both.sync as unknown as { formatProblems: unknown }).formatProblems = { code: 'github-failed' };
    assert.equal(partialCode(both), 'write-failed');
  });

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

describe('the exit status of each sync pull request code alone', () => {
  // What each code's result holds besides the code, so its failure message has what it names.
  const fields: Partial<Record<PullRequestCode, Record<string, unknown>>> = {
    'merge-blocked': { status: 405, reason: 'Required status check is expected' },
    'checks-missing': { checks: { missing: ['ci / test'] } },
    'merge-misplaced': { misplaced: { branch: 'release', commit: 'a'.repeat(40) } },
    'head-unverified': { unverified: ['.github/workflows/ci.yml'] },
    'push-rejected': { reason: 'refs/heads/mdbisync/linear: pre-receive hook declined' },
    'suspended-asset-discovery': { reason: 'an asset link points outside the folder' },
  };
  // Warn: the next run repeats the step with nothing for a person to do. Fail: a person must act.
  const expected: Record<PullRequestCode, 'success' | 'warning' | 'failure'> = {
    conflict: 'success',
    'merge-refused': 'success',
    'state-moved': 'warning',
    'github-failed': 'warning',
    'merge-blocked': 'failure',
    'checks-missing': 'failure',
    'initial-pull-request-pending': 'failure',
    'head-unverified': 'failure',
    'merge-misplaced': 'failure',
    'suspended-asset-discovery': 'failure',
    'push-rejected': 'failure',
  };
  for (const code of PULL_REQUEST_CODES) {
    it(`${code} ends the run with ${expected[code]}`, () => {
      const outcome = sync(code, undefined);
      Object.assign((outcome.sync as unknown as { pullRequest: object }).pullRequest, fields[code] ?? {});
      assert.equal(exitStatusOf(outcome), expected[code]);
    });
  }

  it('github-failed warns when the request may pass next time and fails when GitHub refused the request itself', () => {
    const cases: Array<[number | undefined, 'warning' | 'failure']> = [
      [undefined, 'warning'], [500, 'warning'], [502, 'warning'], [408, 'warning'], [429, 'warning'],
      [403, 'failure'], [404, 'failure'], [409, 'failure'], [422, 'failure'],
    ];
    for (const [status, ending] of cases) {
      const outcome = sync('github-failed', undefined);
      Object.assign((outcome.sync as unknown as { pullRequest: object }).pullRequest, { status });
      assert.equal(exitStatusOf(outcome), ending, String(status));
    }
    // A 403 GitHub gives for its rate limit passes like a 429.
    const limited = sync('github-failed', undefined);
    Object.assign((limited.sync as unknown as { pullRequest: object }).pullRequest, { status: 403, rateLimited: true });
    assert.equal(exitStatusOf(limited), 'warning');
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

describe('a detail on one line', () => {
  const refused = (detail: string): OperationOutcome =>
    ({ operation: 'sync', ok: false, summary: '', notImplemented: false, refusedPushes: [], writes: { linear: {}, git: {}, pullRequests: {} }, code: 'initial-sync-required', refusal: { code: 'initial-sync-required', message: detail } }) as OperationOutcome;

  it('joins lines as the regular expression did, for every short text of spaces, breaks and letters', () => {
    let texts = [''];
    for (let length = 1; length <= 6; length++) {
      texts = texts.flatMap((text) => [' ', '\t', '\n', '\r', ' ', 'a'].map((char) => text + char));
      for (const text of texts) {
        const joined = text.replace(/\s*[\r\n]+\s*/g, ' ');
        assert.equal(stoppedBeforeWritingMessage('sync', refused(text)), stoppedBeforeWritingMessage('sync', refused(joined)), JSON.stringify(text));
      }
    }
  });

  // A regular expression for the space around a break rescanned a long run
  // of spaces from each of its positions: a team name of a million spaces in
  // a README took minutes. A child process with a timeout runs it.
  it('is made from a detail holding a long run of spaces in linear time', () => {
    const result = runScaleScript<{ length: number }>({ exit: new URL('./exit.ts', import.meta.url) }, `
      const detail = 'not found in Linear: team "a' + ' '.repeat(1_000_000) + 'a"\\nnext';
      const outcome = { operation: 'sync', ok: false, summary: '', notImplemented: false, refusedPushes: [], writes: { linear: {}, git: {}, pullRequests: {} }, code: 'initial-sync-required', refusal: { code: 'initial-sync-required', message: detail } };
      console.log(JSON.stringify({ length: exit.stoppedBeforeWritingMessage('sync', outcome).length }));
    `, 30_000);
    assert.ok(result.length > 1_000_000);
  });
});
