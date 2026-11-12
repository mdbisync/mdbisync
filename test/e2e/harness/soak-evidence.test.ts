import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { holdsToken } from './checks.ts';
import { pathVersions, SOAK_EDITS_FILE, SOAK_SYNCS_FILE, SoakLedger, tokenVerdicts } from './soak-evidence.ts';

describe('soak ledger', () => {
  it('places each edit between the sync invocations around its write and keeps credentials out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ledger-'));
    const ledger = new SoakLedger(dir);
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
    ledger.edit({ token: 'run-001', actor: 'editor-a', side: 'linear', path: 'a.md', startedAt: at(1), completedAt: at(1), syncsBefore: ledger.syncs });
    ledger.sync({ invokedAt: at(5), endedAt: at(7), completed: true, workflowRunId: 11, exitCode: 0, summary: 'Cloned https://x-access-token:abc123@example.com/repo.git' });
    ledger.edit({ token: 'run-002', actor: 'git', side: 'git', path: 'b.md', startedAt: at(8), completedAt: at(9), commit: 'c0ffee', syncsBefore: ledger.syncs });
    // A query credential at the end of a value, and a URL followed by an @ on the next line, as file text may hold.
    ledger.sync({ invokedAt: at(10), endedAt: at(12), completed: false, summary: 'See https://example.com/x?access_token=abc456', error: 'Docs: https://example.com\n@alice reviewed' });

    const lines = readFileSync(join(dir, SOAK_SYNCS_FILE), 'utf8').trim().split('\n');
    assert.doesNotMatch(lines.join('\n'), /abc123|abc456/);
    // Each line stays valid JSON, and redaction never runs across a value's end or an escape.
    const last = JSON.parse(lines[1] ?? '') as { summary: string; error: string };
    assert.deepEqual([last.summary, last.error], ['See https://example.com/x?access_token=***', 'Docs: https://example.com\n@alice reviewed']);
    assert.equal(readFileSync(join(dir, SOAK_EDITS_FILE), 'utf8').trim().split('\n').length, 2);
    const input = {
      files: new Map([['a.md', 'A'], ['b.md', 'B run-002']]),
      documents: new Map([['doc-a', { content: 'A run-001' }], ['doc-b', { content: 'B' }]]),
      ids: new Map([['a.md', { id: 'doc-a' }], ['b.md', { id: 'doc-b' }]]),
      syncBranch: new Map([['a.md', 'A run-001']]),
      suspendedBranch: null,
    };
    const verdicts = tokenVerdicts(ledger.edits(), ledger.syncEntries(), { ...input, lostTokens: new Set(['run-001', 'run-002']), holdsToken });
    assert.deepEqual(verdicts.map((verdict) => [verdict.token, verdict.syncBefore, verdict.syncAfter]), [['run-001', null, 1], ['run-002', 1, 2]]);
    assert.deepEqual(verdicts.map((verdict) => [verdict.inGit, verdict.inLinear, verdict.inSyncBranch, verdict.inSuspendedBranch]), [[false, true, true, null], [true, false, false, null]]);
    assert.deepEqual(verdicts[0]?.linearDocuments, ['a.md']);
    assert.deepEqual(pathVersions(['b.md', 'a.md'], input).map((versions) => [versions.path, versions.trackedFile, versions.document, versions.syncBranchFile]), [['a.md', 'A', 'A run-001', 'A run-001'], ['b.md', 'B run-002', 'B', null]]);
  });
});
