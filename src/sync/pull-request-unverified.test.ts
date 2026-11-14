// How a head the sync leaves to a person ends the run and reads in the summary, next to the other lane's outcome.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type PullRequestResult, pullRequestFailure, renderPullRequest } from './pull-request.ts';

const base: PullRequestResult = { needed: true, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [], marked: [], decided: [] };
const suspendedUnverified = { paths: ['eng/plan.md'], checks: [], code: 'head-unverified' as const, unverified: ['.github/workflows/x.yml'] };

it("the normal lane's own setup and no-state endings come before a suspended head that waits for a person", () => {
  assert.equal(pullRequestFailure({ ...base, code: 'initial-pull-request-pending', suspended: suspendedUnverified })?.code, 'initial-pull-request-pending');
  assert.equal(pullRequestFailure({ ...base, code: 'merge-blocked', status: 405, reason: 'rule', suspended: suspendedUnverified })?.code, 'merge-blocked');
});

it('a head that waits for a person comes before a lane that only needs another run', () => {
  const failure = pullRequestFailure({ ...base, code: 'state-moved', suspended: suspendedUnverified });
  assert.equal(failure?.code, 'head-unverified');
  assert.equal(failure?.kind, 'setup');
  assert.match(failure?.message ?? '', /`\.github\/workflows\/x\.yml`/);
});

it("a suspended head that waits for a person keeps the normal lane's line in the summary", () => {
  const lines = renderPullRequest({ ...base, code: 'head-unverified', merged: 'a'.repeat(40), suspended: suspendedUnverified }).join('\n');
  assert.match(lines, /The suspended pull request also changes files/);
  assert.match(lines, /Merged the sync pull request with a merge commit/);
});
