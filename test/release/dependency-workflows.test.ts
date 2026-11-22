// Contract tests for the workflows that run the dependency check: the scheduled
// dependency scan and the pull request dependency review.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { EXCEPTIONS_FILE } from '../../src/release/dependency-scan.ts';

interface Step { name?: string; id?: string; if?: string; uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }

const read = (file: string) => parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));

test('the dependency scan runs every six hours and on demand, with no permission by default', () => {
  const workflow = read('dependency-scan.yml');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule.length, 1);
  assert.match(workflow.on.schedule[0].cron, /^\d{1,2} \*\/6 \* \* \*$/);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ['scan', 'publish', 'findings']);
});

test('the scan job checks main and the latest final release with main\'s code and a read-only token', () => {
  const scan = read('dependency-scan.yml').jobs.scan as Job;
  assert.deepEqual(scan.permissions, { contents: 'read' });
  const checkout = scan.steps[0]!;
  assert.deepEqual(checkout.with, { ref: 'main', 'persist-credentials': false });
  assert.ok(scan.steps.filter((step) => step.uses?.startsWith('actions/checkout@')).length === 1, 'the release is fetched for its lock files, never checked out over main\'s code');
  const main = scan.steps.find((step) => step.id === 'main')!;
  assert.equal(main.run, 'node src/release/dependency-scan.ts --repository . --commit HEAD --target main --output "$RUNNER_TEMP/scan/main"');
  const release = scan.steps.find((step) => step.id === 'release')!;
  assert.equal(release.if, "${{ !cancelled() && steps.latest.outputs.tag != '' }}", 'the release is checked even when the check of main failed');
  assert.match(release.run!, /--release-tag "\$TAG" /);
  assert.equal(release.env!.TAG, '${{ steps.latest.outputs.tag }}', 'the tag reaches the shell as data, never as script text');
  const upload = scan.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!;
  assert.equal(upload.if, '${{ !cancelled() }}');
  assert.equal(upload.with!.name, 'dependency-scan');
});

test('the publish job writes only the status branch, never a release, and runs no repository code', () => {
  const workflow = read('dependency-scan.yml');
  const publish = workflow.jobs.publish as Job & { env: Record<string, string> };
  assert.equal(publish.needs, 'scan');
  assert.match(publish.if!, /needs\.scan\.outputs\.release != ''/);
  assert.match(publish.if!, /needs\.scan\.outputs\.release-blocking != ''/, 'only a completed check of the release is published');
  assert.deepEqual(publish.permissions, { 'contents': 'write' });
  assert.equal(publish.env.BRANCH, 'security-status');
  assert.ok(publish.steps.every((step) => !step.uses?.startsWith('actions/checkout@') && !/\bnode\b|\bnpm\b/.test(step.run ?? '')));
  for (const job of Object.values(workflow.jobs) as Job[]) {
    assert.ok(job.steps.every((step) => !/\bgh release\b|--clobber/.test(step.run ?? '')), 'no job changes a release');
  }
});

// The publish step's script, run against stand-ins for curl and gh that record every write.
const PARENT = 'b'.repeat(40);

function publishStatus(options: { head: number; status: object; parent?: string; current?: string; raw?: string }) {
  const step = (read('dependency-scan.yml').jobs.publish as Job).steps.find((s) => s.run?.includes('git/commits'))!;
  const directory = mkdtempSync(join(tmpdir(), 'dependency-publish-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    mkdirSync(join(directory, 'scan', 'release'), { recursive: true });
    writeFileSync(join(directory, 'scan', 'release', 'dependency-scan.json'), options.raw ?? JSON.stringify(options.status));
    const log = join(directory, 'log');
    writeFileSync(log, '');
    writeFileSync(join(bin, 'curl'), [
      '#!/bin/sh',
      'out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done',
      'jq -cn --arg url "$a" \'{read: $url}\' >> "$STUB_LOG"',
      'case "$a" in',
      '  */contents/*) printf %s "$STUB_CURRENT" > "$out"; printf 200 ;;',
      '  *) [ "$STUB_HEAD" = 200 ] && jq -cn --arg sha "$STUB_PARENT" \'{object: {sha: $sha}}\' > "$out"; printf %s "$STUB_HEAD" ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      'jq -c --arg args "$*" \'{args: $args, body: .}\' >> "$STUB_LOG"',
      'case "$*" in *git/blobs*) echo blob-sha ;; *git/trees*) echo tree-sha ;; *git/commits*) echo commit-sha ;; esac',
    ].join('\n'), { mode: 0o755 });
    const env = {
      PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_HEAD: String(options.head), STUB_PARENT: options.parent ?? PARENT, STUB_CURRENT: options.current ?? JSON.stringify(older), RUNNER_TEMP: directory,
      GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'owner/repo', TAG: 'v1.2.3', BRANCH: 'security-status',
    };
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run!], { env, encoding: 'utf8' });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { read?: string; args?: string; body?: Record<string, unknown> });
    return { status: result.status, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const status = { schema: 1, release: 'v1.2.3', commit: 'a'.repeat(40), checked: '2026-11-22T06:23:00Z', run: 'https://github.com/owner/repo/actions/runs/2', high: 0, critical: 1 };
const older = { ...status, checked: '2026-11-22T00:23:00Z', run: 'https://github.com/owner/repo/actions/runs/1' };

test('the first status creates the branch as one commit with no parent, holding only the status file', () => {
  const { status: exit, calls } = publishStatus({ head: 404, status });
  assert.equal(exit, 0);
  assert.deepEqual(calls.map((call) => call.read ?? call.args), [
    'https://api.github.com/repos/owner/repo/git/ref/heads/security-status',
    'api repos/owner/repo/git/blobs --input - --jq .sha',
    'api repos/owner/repo/git/trees --input - --jq .sha',
    'api repos/owner/repo/git/commits --input - --jq .sha',
    'api repos/owner/repo/git/refs --input -',
  ]);
  assert.deepEqual(JSON.parse(calls[1]!.body!.content as string), status);
  assert.deepEqual(calls[2]!.body, { tree: [{ path: 'dependency-scan.json', mode: '100644', type: 'blob', sha: 'blob-sha' }] }, 'no base tree: the branch holds this file only');
  assert.deepEqual(calls[3]!.body, { message: 'Dependency status of v1.2.3', tree: 'tree-sha', parents: [] });
  assert.deepEqual(calls[4]!.body, { ref: 'refs/heads/security-status', sha: 'commit-sha' });
});

test('a later status moves the branch forward on top of its head, never by force', () => {
  for (const current of [JSON.stringify(older), 'not a status']) {
    const { status: exit, calls } = publishStatus({ head: 200, status, current });
    assert.equal(exit, 0);
    assert.equal(calls[1]!.read, `https://api.github.com/repos/owner/repo/contents/dependency-scan.json?ref=${PARENT}`);
    assert.deepEqual(calls[4]!.body, { message: 'Dependency status of v1.2.3', tree: 'tree-sha', parents: [PARENT] });
    assert.equal(calls[5]!.args, 'api -X PATCH repos/owner/repo/git/refs/heads/security-status --input -');
    assert.deepEqual(calls[5]!.body, { sha: 'commit-sha', force: false });
  }
});

test('a rerun of an older run leaves a newer or equal status in place', () => {
  for (const checked of ['2026-11-22T12:23:00Z', status.checked]) {
    const { status: exit, calls } = publishStatus({ head: 200, status, current: JSON.stringify({ ...status, checked }) });
    assert.equal(exit, 0);
    assert.equal(calls.length, 2, 'only the two reads');
  }
});

test('a status of another release, or a branch that cannot be read, writes nothing', () => {
  for (const [options, reads] of [
    [{ head: 200, status: { ...status, release: 'v1.2.4' } }, 0],
    [{ head: 200, status: { ...status, schema: 2 } }, 0],
    [{ head: 500, status }, 1],
    [{ head: 200, status, parent: 'null' }, 1],
    [{ head: 200, status, parent: '' }, 1],
    [{ head: 200, status, raw: `${JSON.stringify(status)}\n${JSON.stringify(status)}` }, 0],
  ] as const) {
    const { status: exit, calls } = publishStatus(options);
    assert.equal(exit, 1);
    assert.equal(calls.length, reads, JSON.stringify(calls));
  }
});

test('the findings job ends the run red for a finding on main or the release, or a scan that did not complete', () => {
  const findings = read('dependency-scan.yml').jobs.findings as Job;
  assert.deepEqual(findings.permissions, {});
  const step = findings.steps[0]!;
  const run = (env: Record<string, string>) => spawnSync('bash', ['-e', '-c', step.run!], { env: { ...process.env, SCAN_RESULT: 'success', MAIN_BLOCKING: '0', RELEASE: 'v1.0.0', RELEASE_BLOCKING: '0', ...env } }).status;
  assert.equal(run({}), 0);
  assert.equal(run({ RELEASE: '', RELEASE_BLOCKING: '' }), 0);
  assert.equal(run({ MAIN_BLOCKING: '2' }), 1);
  assert.equal(run({ RELEASE_BLOCKING: '1' }), 1);
  assert.equal(run({ SCAN_RESULT: 'failure' }), 1);
});

test('dependency review reads the exceptions of the base commit and allows only unexpired GHSA ids', () => {
  const job = read('dependency-review.yml').jobs['dependency-review'] as Job;
  const checkout = job.steps[0]!;
  assert.deepEqual(checkout.with, {
    ref: '${{ github.event.pull_request.base.sha }}', 'sparse-checkout': EXCEPTIONS_FILE, 'sparse-checkout-cone-mode': false, 'persist-credentials': false,
  });
  const review = job.steps.find((step) => step.uses?.startsWith('actions/dependency-review-action@'))!;
  assert.equal(review.with!['allow-ghsas'], '${{ steps.exceptions.outputs.ghsas }}');
  assert.equal(review.with!['fail-on-severity'], 'moderate');

  const exceptions = job.steps.find((step) => step.id === 'exceptions')!;
  const directory = mkdtempSync(join(tmpdir(), 'dependency-review-'));
  try {
    const ghsas = (file: string | null) => {
      rmSync(join(directory, 'security'), { recursive: true, force: true });
      if (file !== null) {
        mkdirSync(join(directory, 'security'));
        writeFileSync(join(directory, EXCEPTIONS_FILE), file);
      }
      const output = join(directory, 'output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', exceptions.run!], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, 'utf8');
    };
    assert.equal(ghsas(null), 'ghsas=\n', 'a base commit without the file allows nothing');
    assert.equal(ghsas(JSON.stringify({ exceptions: [
      { advisory: 'GHSA-xvch-5gv4-984h', package: 'a', reason: 'r', review: '2999-01-01' },
      { advisory: 'GHSA-xvch-5gv4-984h', package: 'b', reason: 'r', review: '2999-01-01' },
      { advisory: 'GHSA-35jh-r3h4-6jhm', package: 'c', reason: 'r', review: '2000-01-01' },
      { advisory: 'GHSA-29mw-wpgm-hmr9\nx=y', package: 'd', reason: 'r', review: '2999-01-01' },
      { advisory: 'GHSA-r5fr-rjxr-66jc', package: 'e', reason: 'r', review: 'never' },
      { advisory: 'GHSA-xxjr-mmjv-4gpg', package: 'f', reason: 'r', review: 3000 },
    ] })), 'ghsas=GHSA-xvch-5gv4-984h\n');
    // The repository's own file gives every advisory still before its review date.
    cpSync(new URL(`../../${EXCEPTIONS_FILE}`, import.meta.url), join(directory, 'real.json'));
    const real = JSON.parse(readFileSync(join(directory, 'real.json'), 'utf8')) as { exceptions: { advisory: string; review: string }[] };
    const today = new Date().toISOString().slice(0, 10);
    const expected = [...new Set(real.exceptions.filter((e) => e.review >= today).map((e) => e.advisory))].sort().join(', ');
    assert.equal(ghsas(readFileSync(join(directory, 'real.json'), 'utf8')), `ghsas=${expected}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
