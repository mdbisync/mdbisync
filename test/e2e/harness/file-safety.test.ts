import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { writeAtomically } from './locks.ts';
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
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root).sort(), ['owner.json', 'target']);
});

it('failed atomic replacement removes its temporary file', () => {
  const root = fixture();
  assert.throws(() => writeAtomically(root, 'contents'));
  assert.deepEqual(readdirSync(root), []);
});

it('ownership journals preserve entries across reopening and use private permissions', () => {
  const root = fixture();
  new OwnershipLedger(root, 'abc123').scope(['team']);
  new OwnershipLedger(root, 'abc123').project({ id: 'project', name: 'Plan' });
  const owned = readOwnership(root, 'abc123');
  assert.deepEqual([...owned!.teamIds], ['team']);
  assert.deepEqual([...owned!.projects], [['project', 'Plan']]);
  if (process.platform !== 'win32') assert.equal(statSync(join(root, 'owned', 'abc123.jsonl')).mode & 0o777, 0o600);
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
