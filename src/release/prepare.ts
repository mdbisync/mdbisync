import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { stageRelease } from './package.ts';

// Called after the source checkout has passed its ordinary build and tests.
export async function prepareRelease(sourceSha: string, version: string, output: string): Promise<void> {
  const source = process.cwd();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== sourceSha) throw new Error('Source SHA must match the checked-out source');
  const action: unknown = parse(await readFile('action.yml', 'utf8'));
  const hooks: unknown = parse(await readFile('.pre-commit-hooks.yaml', 'utf8'));
  await stageRelease({ source, output: resolve(output), sourceSha, version, action, hooks });
}

if (import.meta.main) {
  const [sourceSha, version, output] = process.argv.slice(2);
  if (!sourceSha || !version || !output) throw new Error('Usage: prepare.ts SOURCE_SHA VERSION OUTPUT_DIRECTORY');
  await prepareRelease(sourceSha, version, output);
}
