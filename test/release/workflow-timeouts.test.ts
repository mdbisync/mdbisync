import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

for (const [file, job] of [['ci.yml', 'check'], ['release.yml', 'build']] as const) {
  test(`${file} ${job} allows at least 20 minutes for the full test suite and surrounding steps`, async () => {
    const workflow = parse(await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const timeout = workflow.jobs?.[job]?.['timeout-minutes'];
    assert.ok(Number.isInteger(timeout) && timeout >= 20, `${file} ${job} must set timeout-minutes to at least 20`);
  });
}
