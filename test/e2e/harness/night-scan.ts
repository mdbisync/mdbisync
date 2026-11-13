import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ScannedDocument } from './checks.ts';

export interface CanaryEvidence {
  canaries: string[];
  texts: Record<string, string>;
  /** The document behind each `comments on <id>` text, keyed by id; never comment text. */
  documents?: Record<string, ScannedDocument>;
  /** A failed remote read must never turn into a clean scan. */
  error?: string;
}

/** Scan only collected output, never fixture bodies or the canary index itself. */
export function scanNight(root: string, current?: { directory: string; evidence: CanaryEvidence }) {
  const snapshots: Array<{ path: string; evidence: CanaryEvidence }> = [];
  const logs: string[] = [];
  function visit(dir: string): void {
    if (current && resolve(dir) === resolve(current.directory)) return;
    if (basename(dirname(dir)) === 'runs' && !existsSync(join(dir, 'canary-evidence.json'))) throw new Error('run is missing canary evidence');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !['engine', 'person', 'scratch', 'hooks', 'hook-npm', 'node_modules', '.git'].includes(entry.name)) visit(path);
      else if (entry.isFile() && entry.name === 'canary-pending') throw new Error('canary evidence still being produced');
      else if (entry.isFile() && /(?:\.log|\.stdout|\.stderr)$/.test(entry.name)) logs.push(path);
      else if (entry.isFile() && entry.name === 'canary-evidence.json') {
        const evidence = JSON.parse(readFileSync(path, 'utf8')) as CanaryEvidence;
        if (evidence.error) throw new Error(`incomplete canary evidence: ${relative(root, path)}`);
        if (!Array.isArray(evidence.canaries) || evidence.texts === null || typeof evidence.texts !== 'object') throw new Error('invalid canary evidence');
        snapshots.push({ path, evidence });
      }
    }
  }
  visit(root);
  if (current) snapshots.push({ path: join(current.directory, 'canary-evidence.json'), evidence: current.evidence });
  if (snapshots.length === 0) throw new Error('no canary evidence in the selected root');
  const canaries = new Set(snapshots.flatMap(({ evidence }) => evidence.canaries.filter((canary) => canary.length >= 6)));
  if (canaries.size === 0) throw new Error('no content canaries in the selected evidence');
  const matches: Array<{ source: string; canary: string }> = [];
  let sources = 0;
  for (const { path, evidence } of snapshots) for (const [source, text] of Object.entries(evidence.texts)) {
    sources++;
    for (const canary of canaries) if (text.includes(canary)) matches.push({ source: `${relative(root, path)}: ${source}`, canary });
  }
  for (const path of logs) {
    sources++;
    const text = readFileSync(path, 'utf8');
    for (const canary of canaries) if (text.includes(canary)) matches.push({ source: relative(root, path), canary });
  }
  return { snapshots: snapshots.length, sources, canaries: canaries.size, matches };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: night-scan.ts <evidence-root>');
  const result = scanNight(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.matches.length === 0 ? 0 : 1;
}
