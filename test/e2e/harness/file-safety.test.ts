import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { acquireLock, liveRuns, writeAtomically } from './locks.ts';
import { OwnershipLedger, readOwnership } from './ownership.ts';
import { updateStatusPage, type HarnessReport } from './report.ts';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'file-safety-'));
  roots.push(root);
  return root;
}
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

it('atomic writes replace the destination link without changing its target and keep private permissions', () => {
  const root = fixture();
  const target = join(root, 'target');
  const file = join(root, 'owner.json');
  writeFileSync(target, 'untouched');
  symlinkSync(target, file);
  writeAtomically(file, 'first');
  writeAtomically(file, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600 & ~process.umask());
  assert.deepEqual(readdirSync(root).sort(), ['owner.json', 'target']);
});

it('failed atomic replacement removes its temporary file', () => {
  const root = fixture();
  const destination = join(root, 'destination');
  mkdirSync(destination);
  assert.throws(() => writeAtomically(destination, 'contents'));
  assert.deepEqual(readdirSync(root), ['destination']);
});

it('ownership journals preserve entries across reopening and keep private permissions', () => {
  const root = fixture();
  new OwnershipLedger(root, 'abc123').scope(['team']);
  chmodSync(join(root, 'owned', 'abc123.jsonl'), 0o644);
  new OwnershipLedger(root, 'abc123').project({ id: 'project', name: 'Plan' });
  const owned = readOwnership(root, 'abc123');
  assert.deepEqual([...owned!.teamIds], ['team']);
  assert.deepEqual([...owned!.projects], [['project', 'Plan']]);
  if (process.platform !== 'win32') assert.equal(statSync(join(root, 'owned', 'abc123.jsonl')).mode & 0o777, 0o600);
});

it('invalid ownership data is rejected before creating a journal', () => {
  const root = fixture();
  const ledger = new OwnershipLedger(root, 'abc123');
  assert.throws(() => ledger.project({ id: '../outside', name: 'Plan' }));
  assert.throws(() => ledger.project({ id: 'project', name: 'x'.repeat(4097) }));
  assert.deepEqual(readdirSync(join(root, 'owned')), []);
});

it('keeps exact project names through safe journal serialization', () => {
  const root = fixture();
  const name = 'Plan\0\x85\nNext';
  new OwnershipLedger(root, 'abc123').project({ id: 'project', name });
  assert.equal(readOwnership(root, 'abc123')!.projects.get('project'), name);
  assert.doesNotMatch(readFileSync(join(root, 'owned', 'abc123.jsonl'), 'utf8'), /[\x00\x85]/);
});

it('unreadable state never permits taking a lock or treating its run as dead', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const root = fixture();
  const held = join(root, 'locks', 'held');
  mkdirSync(held, { recursive: true });
  const owner = join(held, 'owner.json');
  writeAtomically(owner, '{}');
  chmodSync(owner, 0);
  const runs = join(root, 'runs');
  mkdirSync(runs);
  const run = join(runs, 'abc123.json');
  writeAtomically(run, '{}');
  chmodSync(run, 0);
  try {
    await assert.rejects(acquireLock('held', { stateDir: root, runId: 'def456', timeoutMs: 0 }), { code: 'EACCES' });
    assert.throws(() => liveRuns(root), { code: 'EACCES' });
    assert.deepEqual(readdirSync(held), ['owner.json']);
  } finally {
    chmodSync(owner, 0o600);
    chmodSync(run, 0o600);
  }
});

it('ownership journals refuse a symlink instead of appending to another file', { skip: process.platform === 'win32' }, () => {
  const root = fixture();
  const target = join(root, 'target');
  writeFileSync(target, 'untouched');
  const ledger = new OwnershipLedger(root, 'abc123');
  symlinkSync(target, join(root, 'owned', 'abc123.jsonl'));
  assert.throws(() => ledger.scope(['team']), { code: 'ELOOP' });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

it('status pages create a missing file but propagate other read errors', () => {
  const root = fixture();
  const report: HarnessReport = {
    harnessRunId: 'run', startedAt: '2026-01-01', finishedAt: '2026-01-01',
    host: 'test', selection: {}, results: [],
  };
  const file = join(root, 'status.md');
  updateStatusPage(file, [], report);
  assert.match(readFileSync(file, 'utf8'), /# Test status/);
  assert.throws(() => updateStatusPage(root, [], report), { code: 'EISDIR' });
});
