import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDocumentWrite, QUIET_SUBJECT, quietFailures, type PullRequestFacts, type QuietInput, type RunWorld } from './quiet.ts';

const SHA = (n: number) => String(n).repeat(40).slice(0, 40);

/** The world right after a sync pull request merged, as a following run finds it. */
function world(overrides: Partial<RunWorld> = {}): RunWorld {
  return {
    trackedTip: SHA(1),
    trackedTree: SHA(2),
    syncTip: SHA(3),
    stateTips: { linear: SHA(4), ids: SHA(5), uploads: null },
    pullRequests: [{ number: 30, state: 'closed', headSha: SHA(3), mergedAt: '2026-01-01T00:00:00Z', title: 'Changes from Linear', body: 'One document.' }],
    proxyIndex: 10,
    ...overrides,
  };
}

/** The report of a sync that only recorded the merge: the shape the live follow-up run gave. */
function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'sync',
    ok: true,
    complete: true,
    changed: true,
    capture: { ok: true, changed: [], removed: [], heldRemovals: [], blocked: [], leftOut: [], writeBackWarnings: [] },
    pullRequest: { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [] },
    sync: { complete: true, updated: [], relocated: [], created: [], adopted: [], restored: [], trashed: [], conflicts: [], record: { commit: SHA(6), kind: 'merge', parents: [SHA(3), SHA(1)] } },
    writtenCount: 0,
    writtenDocuments: 0,
    ...overrides,
  };
}

/** A metadata-only catch-up: only the `linear` state ref moves. */
function catchUp(overrides: Partial<QuietInput> = {}): QuietInput {
  const before = world();
  return { exitCode: 0, report: report(), before, after: world({ stateTips: { ...before.stateTips, linear: SHA(6) }, proxyIndex: 14 }), documentWrites: 0, ...overrides };
}

function pr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return { ...(world().pullRequests[0] as PullRequestFacts), ...overrides };
}

describe('quiet run', () => {
  it('accepts the internal metadata-only merge record that sets changed=true', () => {
    const input = catchUp();
    assert.equal(input.report?.['changed'], true, 'the broad flag the old assertion rejected');
    assert.deepEqual(quietFailures(input), []);
  });

  it('accepts a fully unchanged run', () => {
    const before = world();
    assert.deepEqual(quietFailures({ exitCode: 0, report: report({ changed: false }), before, after: world(), documentWrites: 0 }), []);
  });

  it('accepts a run the proxy did not see, on its report alone', () => {
    assert.deepEqual(quietFailures(catchUp({ documentWrites: null })), []);
  });

  describe('rejects content writes', () => {
    it('document writes the proxy saw', () => {
      assert.deepEqual(quietFailures(catchUp({ documentWrites: 1 })), ['1 document writes reached Linear']);
    });
    it('document writes the report counts', () => {
      assert.deepEqual(quietFailures(catchUp({ report: report({ writtenCount: 2, writtenDocuments: 2 }) })), ['the report counts 2 writtenCount', 'the report counts 2 writtenDocuments']);
    });
    it('a report without write counts', () => {
      const { writtenCount: _count, ...rest } = report();
      assert.deepEqual(quietFailures(catchUp({ report: rest })), ['the report gives no writtenCount']);
    });
    for (const list of ['created', 'updated', 'relocated', 'adopted', 'restored', 'trashed']) it(`documents the sync ${list}`, () => {
      const base = report();
      const sync = { ...(base['sync'] as Record<string, unknown>), [list]: ['a.md'] };
      assert.deepEqual(quietFailures(catchUp({ report: { ...base, sync } })), [`the run ${list} documents`]);
    });
    it('Linear changes captured into git', () => {
      const base = report();
      const capture = { ...(base['capture'] as Record<string, unknown>), changed: ['a.md'] };
      assert.deepEqual(quietFailures(catchUp({ report: { ...base, capture } })), ['the run captured changed documents into git']);
    });
  });

  describe('rejects tracked-tree differences', () => {
    it('a new tracked tree', () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, trackedTip: SHA(7), trackedTree: SHA(8) } }), ['the tracked content changed', 'the tracked branch moved']);
    });
    it('a tracked commit with the same tree', () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, trackedTip: SHA(7) } }), ['the tracked branch moved']);
    });
  });

  describe('rejects pull request activity', () => {
    it('a new pull request', () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, pullRequests: [pr(), pr({ number: 31, state: 'open', mergedAt: null })] } }), ['pull request #31 was opened']);
    });
    for (const [name, change] of [['head', { headSha: SHA(9) }], ['state', { state: 'open' }], ['body', { body: 'Two documents.' }], ['title', { title: 'Other' }]] as const) it(`an update of its ${name}`, () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, pullRequests: [pr(change)] } }), ['pull request #30 was updated']);
    });
    it('a sync branch that moved', () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, syncTip: SHA(9) } }), ['the sync branch moved']);
    });
    it('a report that moved the branch, opened or merged a pull request', () => {
      const pullRequest = { needed: true, pullRequest: { number: 31, url: 'u', opened: true }, branchMoved: true, checks: null, merged: SHA(9), paths: ['a.md'] };
      assert.deepEqual(quietFailures(catchUp({ report: report({ pullRequest }) })), ['the report says it opened a pull request', 'the sync branch moved', 'the run merged a pull request']);
    });
    it('a pull request that disappeared', () => {
      const input = catchUp();
      assert.deepEqual(quietFailures({ ...input, after: { ...input.after, pullRequests: [] } }), ['pull request #30 disappeared']);
    });
  });

  describe('rejects runs that prove nothing', () => {
    it('changed=true that no state ref write explains', () => {
      const before = world();
      assert.deepEqual(quietFailures({ exitCode: 0, report: report(), before, after: world(), documentWrites: 0 }), ['the run reports changed=true, but no state ref moved']);
    });
    it('a failed or unfinished run', () => {
      assert.deepEqual(quietFailures(catchUp({ exitCode: 1, report: report({ ok: false }) })), ['the run exited with 1', 'the run did not finish a complete sync']);
      assert.deepEqual(quietFailures(catchUp({ report: report({ complete: false }) })), ['the run did not finish a complete sync']);
    });
    it('a run without a report', () => {
      assert.deepEqual(quietFailures(catchUp({ report: null })), ['the run wrote no report']);
    });
  });

  it('names its subject per run', () => {
    assert.ok(QUIET_SUBJECT.test('quiet.last'));
    assert.ok(QUIET_SUBJECT.test('quiet.2'));
    assert.ok(!QUIET_SUBJECT.test('quiet.last.reasons'));
    assert.ok(!QUIET_SUBJECT.test('runs.last.quiet'));
  });

  it('counts document mutations that Linear accepted, not reads, injected answers or other mutations', () => {
    const base = { n: 1, at: 0, injected: false, status: 200 as const };
    assert.equal(isDocumentWrite({ ...base, kind: 'mutation', operation: 'documentUpdate' }), true);
    assert.equal(isDocumentWrite({ ...base, kind: 'mutation', operation: 'CreateDocument' }), true);
    assert.equal(isDocumentWrite({ ...base, kind: 'query', operation: 'documents' }), false);
    assert.equal(isDocumentWrite({ ...base, kind: 'mutation', operation: 'documentUpdate', injected: true }), false);
    assert.equal(isDocumentWrite({ ...base, kind: 'mutation', operation: 'commentCreate' }), false);
    assert.equal(isDocumentWrite({ ...base, kind: 'mutation', operation: 'documentUpdate', status: 500 }), false);
  });
});
