// The daily drift workflow of the format probe (drift-workflow.yml): what it
// runs and where, and that its probe step fails on drift or an unfinished run
// and names each drifted fixture.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

interface Step { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }

const workflow = parse(readFileSync(new URL('./drift-workflow.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.probe as { 'runs-on': string[]; steps: Step[] };
const probeStep = job.steps.find((step) => step.name === "Probe Linear's forms against the recorded ones")!;

test('runs daily and on demand on the sandbox runner, read-only, one run at a time', () => {
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['ref']);
  assert.equal(workflow.on.workflow_dispatch.inputs.ref.default, 'main');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'format-probe', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(workflow.jobs), ['probe']);
  assert.deepEqual(job['runs-on'], ['self-hosted', 'mdbisync-sandbox']);
});

test('checks out this repository at main unless a manual run names a ref, and pins every action', () => {
  for (const step of job.steps.filter((s) => s.uses)) assert.match(step.uses!, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
  const checkout = job.steps[0]!;
  assert.match(checkout.uses!, /^actions\/checkout@/);
  assert.deepEqual(checkout.with, {
    repository: 'mdbisync/mdbisync',
    ref: "${{ inputs.ref || 'main' }}",
    'persist-credentials': false,
  });
  assert.ok(job.steps.some((step) => step.run === 'npm ci --ignore-scripts'));
});

test('probes without the fact measurements, with the app credentials from secrets', () => {
  assert.match(probeStep.run!, /npm run probe:format -- --no-facts --report "\$OUT\/report.md" --json "\$OUT\/result.json"/);
  assert.equal(probeStep.env!.LINEAR_TEST_APP_CLIENT_ID, '${{ secrets.LINEAR_TEST_APP_CLIENT_ID }}');
  assert.equal(probeStep.env!.LINEAR_TEST_APP_CLIENT_SECRET, '${{ secrets.LINEAR_TEST_APP_CLIENT_SECRET }}');
  assert.equal(probeStep.env!.OUT, '${{ runner.temp }}/format-probe');
});

test('uploads the report as an artifact also when the probe failed', () => {
  const upload = job.steps.at(-1)!;
  assert.match(upload.uses!, /^actions\/upload-artifact@/);
  assert.equal(upload.if, '${{ always() }}');
  assert.equal(upload.with!.path, '${{ runner.temp }}/format-probe');
});

/** Runs the probe step's script with an `npm` that prints `stderr` and exits with `code`. */
function runProbeStep(code: number, stderr: string) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-workflow-'));
  try {
    writeFileSync(join(dir, 'stderr.txt'), stderr);
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "$@" > "${dir}/args"\ncat "${dir}/stderr.txt" >&2\nexit ${code}\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    // GitHub's default bash shell for run steps.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', probeStep.run!], {
      env: { PATH: `${dir}:${process.env.PATH}`, OUT: join(dir, 'out') },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, args: readFileSync(join(dir, 'args'), 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DIAGNOSTIC = '{"runId":"r","operation":"DocumentCreate","status":200}\n';

test('the probe step passes when nothing drifted', () => {
  const run = runProbeStep(0, `${DIAGNOSTIC}format probe: 120 fixtures, 0 refused, 0 without a fixed point, 0 drifted, 1400 API requests\n`);
  assert.equal(run.status, 0);
  assert.match(run.args, /^run probe:format -- --no-facts --report \S+\/report\.md --json \S+\/result\.json$/);
  assert.ok(!run.stdout.includes('::error'));
  assert.ok(!run.stdout.includes('"runId"'), 'request diagnostics stay in the uploaded log');
});

test('the probe step fails on drift and names each drifted fixture', () => {
  const run = runProbeStep(1, `${DIAGNOSTIC}format probe: 120 fixtures, 0 refused, 0 without a fixed point, 1 drifted, 1400 API requests\n` +
    'drift: construct-singles/table.md: markdown: line 3: recorded "| 50% |", now "| 50 % |"\n');
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error title=Format drift::construct-singles\/table\.md: markdown: line 3: recorded "\| 50%25 \|", now "\| 50 %25 \|"$/m);
  assert.match(run.stdout, /^::error title=Format probe::exit 1 /m);
});

test('the probe step fails when the run could not finish', () => {
  const run = runProbeStep(2, `${DIAGNOSTIC}format probe: run r failed: stopped by a rate limit\n`);
  assert.equal(run.status, 2);
  assert.match(run.stdout, /^format probe: run r failed: stopped by a rate limit$/m);
  assert.match(run.stdout, /^::error title=Format probe::exit 2 /m);
});
