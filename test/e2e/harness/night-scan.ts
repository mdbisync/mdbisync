import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface CanaryEvidence {
  canaries: string[];
  texts: Record<string, string>;
  /** A failed remote read must never turn into a clean scan. */
  error?: string;
}

/** Scan only collected output, never fixture bodies or the canary index itself. */
export function scanNight(root: string) {
  const snapshots: Array<{ path: string; evidence: CanaryEvidence }> = [];
  const logs: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
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
  if (snapshots.length === 0) throw new Error('no canary evidence in the selected root');
  const canaries = new Set(snapshots.flatMap(({ evidence }) => evidence.canaries));
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
