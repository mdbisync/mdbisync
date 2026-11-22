// Runs a scale check in a child process, so the parent's timeout stops a
// stall that a test timeout could not interrupt (a synchronous loop never
// yields to the test runner).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * Runs `script`, an ES module that prints one JSON value on its last line,
 * and returns that value. `imports` maps names to module URLs; each module's
 * exports are bound under its name (`const fix = await import(...)`).
 * Fails when the child does not finish within `timeoutMs`.
 */
export function runScaleScript<T>(imports: Record<string, URL>, script: string, timeoutMs: number): T {
  const prelude = Object.entries(imports).map(([name, url]) => `const ${name} = await import(${JSON.stringify(url.href)});`).join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `${prelude}\n${script}`], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.signal, null, `the scale check did not finish within ${timeoutMs} ms`);
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1)!) as T;
}
