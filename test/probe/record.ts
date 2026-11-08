// Recorded Linear forms: `<name>.linear.md` and `<name>.linear.yjs.json`
// beside each fixture, and a manifest with each fixture's fixed point and
// refusal. A run is compared with them (drift) or written over them (update).

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, goldenMarkdownPath, goldenYjsPath, readOptional, type Bank } from './bank.ts';
import type { FixtureResult, ProbeRun } from './probe.ts';

export interface ManifestEntry {
  fixedPoint?: boolean;
  refused?: string;
  yjs: 'recorded' | 'none';
}

export interface Manifest {
  version: 1;
  fixtures: Record<string, ManifestEntry>;
}

export interface Drift {
  file: string;
  kind: 'markdown' | 'yjs' | 'fixed-point' | 'refusal' | 'not-recorded';
  detail: string;
}

export function readManifest(bank: Bank): Manifest | undefined {
  const text = readOptional(join(bank.dir, MANIFEST_FILE));
  return text === undefined ? undefined : (JSON.parse(text) as Manifest);
}

export function yjsText(result: FixtureResult): string | undefined {
  return result.yjs === undefined ? undefined : `${JSON.stringify(result.yjs, null, 2)}\n`;
}

function entryOf(result: FixtureResult): ManifestEntry {
  const entry: ManifestEntry = { yjs: result.yjs === undefined ? 'none' : 'recorded' };
  if (result.fixedPoint !== undefined) entry.fixedPoint = result.fixedPoint;
  if (result.refused !== undefined) entry.refused = refusalKey(result.refused);
  return entry;
}

/** Linear's error code, without the message text that may name values. */
function refusalKey(refusal: string): string {
  return refusal.match(/^Linear error ([A-Za-z_]+)/)?.[1] ?? refusal;
}

/**
 * Compares a run with the recorded forms. Yjs is compared only when the run
 * could read it, so a disappeared internal field does not count as drift.
 */
export function findDrift(bank: Bank, run: ProbeRun): Drift[] {
  const manifest = readManifest(bank);
  const drifts: Drift[] = [];
  for (const result of run.fixtures) {
    const recorded = manifest?.fixtures[result.file];
    if (!recorded) {
      drifts.push({ file: result.file, kind: 'not-recorded', detail: 'no recorded Linear form; run the probe with --update' });
      continue;
    }
    const observed = entryOf(result);
    if ((recorded.refused ?? '') !== (observed.refused ?? '')) {
      drifts.push({
        file: result.file,
        kind: 'refusal',
        detail: `recorded ${recorded.refused ?? 'accepted'}, now ${observed.refused ?? 'accepted'}`,
      });
      continue;
    }
    if (result.refused !== undefined) continue;
    const markdown = readOptional(join(bank.dir, goldenMarkdownPath(result.file)));
    if (markdown !== result.first) {
      drifts.push({ file: result.file, kind: 'markdown', detail: firstDifference(markdown ?? '', result.first ?? '') });
    }
    if (recorded.fixedPoint !== observed.fixedPoint) {
      drifts.push({ file: result.file, kind: 'fixed-point', detail: `recorded ${recorded.fixedPoint}, now ${observed.fixedPoint}` });
    }
    if (!run.yjsBlocked && recorded.yjs === 'recorded') {
      const yjs = readOptional(join(bank.dir, goldenYjsPath(result.file)));
      const now = yjsText(result);
      if (now !== undefined && yjs !== now) {
        drifts.push({ file: result.file, kind: 'yjs', detail: firstDifference(yjs ?? '', now) });
      }
    }
  }
  return drifts;
}

/** Writes the run's forms as the new record. Fixtures not in the run keep theirs. */
export function writeRecord(bank: Bank, run: ProbeRun): void {
  const manifest: Manifest = readManifest(bank) ?? { version: 1, fixtures: {} };
  for (const result of run.fixtures) {
    const markdownPath = join(bank.dir, goldenMarkdownPath(result.file));
    const yjsPath = join(bank.dir, goldenYjsPath(result.file));
    if (result.first === undefined) rmSync(markdownPath, { force: true });
    else writeFileSync(markdownPath, result.first);
    const yjs = yjsText(result);
    if (yjs !== undefined) writeFileSync(yjsPath, yjs);
    else if (!run.yjsBlocked) rmSync(yjsPath, { force: true });
    const previous = manifest.fixtures[result.file];
    const entry = entryOf(result);
    // A run without Yjs keeps the earlier Yjs record.
    if (run.yjsBlocked && previous) entry.yjs = previous.yjs;
    manifest.fixtures[result.file] = entry;
  }
  // Entries of fixtures that left the bank go with them.
  const inBank = new Set(bank.fixtures.map((fixture) => fixture.file));
  manifest.fixtures = Object.fromEntries(
    Object.entries(manifest.fixtures)
      .filter(([file]) => inBank.has(file))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(join(bank.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Where two texts first differ: line number and both lines, shortened. */
export function firstDifference(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let line = 0; line < Math.max(a.length, b.length); line += 1) {
    if (a[line] !== b[line]) {
      return `line ${line + 1}: recorded ${quote(a[line])}, now ${quote(b[line])}`;
    }
  }
  return 'same lines, different bytes';
}

function quote(line: string | undefined): string {
  if (line === undefined) return '(none)';
  return JSON.stringify(line.length > 80 ? `${line.slice(0, 77)}...` : line);
}
