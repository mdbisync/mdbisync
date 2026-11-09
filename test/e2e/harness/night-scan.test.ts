import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { scanNight } from './night-scan.ts';

it('scans all snapshots with the union of content canaries, including failed earlier runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-scan-'));
  try {
    mkdirSync(join(dir, 'failed'));
    mkdirSync(join(dir, 'later'));
    writeFileSync(join(dir, 'failed', 'canary-evidence.json'), JSON.stringify({ canaries: ['kx-secret-note'], texts: { 'run stdout': 'safe', 'pull request': 'kx-later-note' } }));
    writeFileSync(join(dir, 'later', 'canary-evidence.json'), JSON.stringify({ canaries: ['kx-later-note'], texts: { 'comments': 'safe' } }));
    const result = scanNight(dir);
    assert.equal(result.snapshots, 2);
    assert.equal(result.sources, 3);
    assert.equal(result.matches.length, 1);
    assert.match(result.matches[0]!.source, /failed.*pull request/);
    assert.throws(() => scanNight(join(dir, 'missing')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses an empty evidence root rather than calling it clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-empty-'));
  try { assert.throws(() => scanNight(dir), /no canary evidence/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses a snapshot whose remote output could not be collected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-incomplete-'));
  try {
    writeFileSync(join(dir, 'canary-evidence.json'), JSON.stringify({ canaries: [], texts: {}, error: 'read failed' }));
    assert.throws(() => scanNight(dir), /incomplete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not report an offline-only batch with no content canaries as clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-none-'));
  try {
    writeFileSync(join(dir, 'canary-evidence.json'), JSON.stringify({ canaries: [], texts: { log: 'safe' } }));
    assert.throws(() => scanNight(dir), /no content canaries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('uses the same canary union for current and persisted output and ignores fixture clones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-current-'));
  try {
    mkdirSync(join(dir, 'engine'));
    writeFileSync(join(dir, 'engine', 'fixture.log'), 'kx-stored-canary');
    writeFileSync(join(dir, 'canary-evidence.json'), JSON.stringify({ canaries: ['kx-stored-canary'], texts: { old: 'kx-current-canary' } }));
    const result = scanNight(dir, { directory: join(dir, 'current'), evidence: { canaries: ['kx-current-canary'], texts: { log: 'kx-stored-canary' } } });
    assert.equal(result.matches.length, 2);
    assert.equal(result.sources, 2);
    writeFileSync(join(dir, 'canary-pending'), '');
    assert.throws(() => scanNight(dir), /still being produced/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses historical run directories without collected evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-history-'));
  try {
    mkdirSync(join(dir, 'runs', 'old-run'), { recursive: true });
    assert.throws(() => scanNight(dir), /missing canary evidence/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
