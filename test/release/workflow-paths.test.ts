// Which jobs of release.yml run, and how the run ends, for each release path.
// The job conditions are read from the workflow and evaluated the way GitHub
// does: a condition without a status function is implicitly `success() && …`,
// and success() fails when any job upstream did not succeed (a skipped one
// included).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: { name?: string; if?: string; uses?: string; with?: Record<string, string>; run?: string; env?: Record<string, string> }[];
}
interface Context { ref: string; version: string; cancelled: boolean; results: Map<string, Result>; upstream: string[] }

const workflow = parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
const jobs = workflow.jobs as Record<string, Job>;

const needsOf = (name: string): string[] => [jobs[name]!.needs ?? []].flat();
const upstreamOf = (name: string): string[] => needsOf(name).flatMap((need) => [need, ...upstreamOf(need)]);

/** Evaluates the subset of GitHub's expression syntax that release.yml uses. */
function evaluate(expression: string, context: Context): unknown {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const tokens = source.match(/'[^']*'|==|!=|&&|\|\||[!(),]|[A-Za-z_][\w.-]*/g) ?? [];
  const withoutSpaces = source.replace(/'[^']*'|\s+/g, (match) => (match.startsWith("'") ? match : ''));
  assert.equal(tokens.join(''), withoutSpaces, `unsupported expression: ${expression}`);
  let position = 0;
  const next = (): string => tokens[position++]!;
  const expect = (token: string): void => assert.equal(next(), token, `expected ${token} in ${expression}`);
  const resultOf = (job: string): Result => {
    assert.ok(context.results.has(job), `job ${job} is read before it ran: order the jobs after their needs`);
    return context.results.get(job)!;
  };

  function primary(): unknown {
    const token = next();
    if (token === '!') return !primary();
    if (token === '(') { const value = or(); expect(')'); return value; }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (tokens[position] === '(') {
      next();
      const args: unknown[] = [];
      while (tokens[position] !== ')') { args.push(or()); if (tokens[position] === ',') next(); }
      expect(')');
      const upstream = context.upstream.map(resultOf);
      switch (token) {
        case 'always': return true;
        case 'cancelled': return context.cancelled;
        case 'success': return upstream.every((result) => result === 'success');
        case 'failure': return upstream.some((result) => result === 'failure');
        case 'contains': return String(args[0]).includes(String(args[1]));
        default: assert.fail(`unsupported function ${token}`);
      }
    }
    if (token === 'github.ref') return context.ref;
    if (token === 'inputs.version') return context.version;
    const need = /^needs\.([\w-]+)\.result$/.exec(token);
    if (need) return resultOf(need[1]!);
    return assert.fail(`unsupported value ${token}`);
  }
  function equality(): unknown {
    const left = primary();
    if (tokens[position] === '==') { next(); return left === primary(); }
    if (tokens[position] === '!=') { next(); return left !== primary(); }
    return left;
  }
  function and(): unknown { let value = equality(); while (tokens[position] === '&&') { next(); const right = equality(); value = Boolean(value) && Boolean(right); } return value; }
  function or(): unknown { let value = and(); while (tokens[position] === '||') { next(); const right = and(); value = Boolean(value) || Boolean(right); } return value; }

  const value = or();
  assert.equal(position, tokens.length, `unparsed tail in ${expression}`);
  return value;
}

/**
 * Runs the job graph in file order: each job's condition decides whether it
 * runs, `outcomes` gives the result of the jobs that do the release work, and
 * the final check job runs its own step. A `cancelled` outcome cancels the
 * run from that job on. The run fails when any job failed.
 */
function simulate(ref: string, version: string, outcomes: Partial<Record<string, Result>>) {
  const results = new Map<string, Result>();
  let cancelled = false;
  for (const name of Object.keys(jobs)) {
    const job = jobs[name]!;
    const context = { ref, version, cancelled, results, upstream: upstreamOf(name) };
    const condition = job.if ?? 'success()';
    const explicit = /\b(always|success|failure|cancelled)\(\)/.test(condition);
    const runs = (explicit || evaluate('success()', context)) && Boolean(evaluate(condition, context));
    if (!runs) { results.set(name, 'skipped'); continue; }
    if (name in outcomes) {
      results.set(name, outcomes[name]!);
      cancelled ||= outcomes[name] === 'cancelled';
      continue;
    }
    assert.equal(name, 'tagged', `no outcome given for job ${name}`);
    const step = job.steps[0]!;
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, String(evaluate(value, context))]));
    // GitHub's default bash shell stops at the first failed command.
    const run = spawnSync('bash', ['-e', '-c', step.run!], { env: { ...process.env, ...env } });
    results.set(name, run.status === 0 ? 'success' : 'failure');
  }
  const values = [...results.values()];
  const conclusion = values.includes('failure') ? 'failure' : cancelled ? 'cancelled' : 'success';
  return { results: Object.fromEntries(results), conclusion };
}

const main = 'refs/heads/main';
const passing = { gate: 'success', build: 'success', attest: 'success', tag: 'success' } as const;

test('release.yml has the gate, build, attest, tag and final check jobs in that order', () => {
  assert.deepEqual(Object.keys(jobs), ['gate', 'build', 'attest', 'tag', 'tagged']);
  assert.deepEqual(needsOf('attest'), ['gate', 'build']);
  assert.deepEqual(needsOf('tag'), ['gate', 'build', 'attest']);
  assert.deepEqual(needsOf('tagged'), ['tag']);
  assert.deepEqual(jobs.tagged!.permissions, {});
});

test('the tag job itself requires a passed gate and attestations for a final version, whatever the build condition says', () => {
  const tags = (version: string, gate: Result, attest: Result) => evaluate(jobs.tag!.if!, {
    ref: main, version, cancelled: false, upstream: ['gate', 'build', 'attest'],
    results: new Map<string, Result>([['gate', gate], ['build', 'success'], ['attest', attest]]),
  });
  for (const gate of ['failure', 'skipped', 'cancelled'] as const) assert.equal(tags('v0.1.0', gate, 'success'), false, gate);
  for (const attest of ['failure', 'skipped', 'cancelled'] as const) assert.equal(tags('v0.1.0', 'success', attest), false, attest);
  assert.equal(tags('v0.1.0', 'success', 'success'), true);
  assert.equal(tags('v0.1.0-rc.9', 'skipped', 'skipped'), true);
});

test('a pre-release skips the gate and the attestations, then builds and tags', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0-rc.9', passing);
  assert.deepEqual(results, { gate: 'skipped', build: 'success', attest: 'skipped', tag: 'success', tagged: 'success' });
  assert.equal(conclusion, 'success');
});

test('a final release that passed the gate builds, attests and tags', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0', passing);
  assert.deepEqual(results, { gate: 'success', build: 'success', attest: 'success', tag: 'success', tagged: 'success' });
  assert.equal(conclusion, 'success');
});

test('a final release that failed the gate builds, attests and tags nothing and fails', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0', { ...passing, gate: 'failure' });
  assert.deepEqual(results, { gate: 'failure', build: 'skipped', attest: 'skipped', tag: 'skipped', tagged: 'failure' });
  assert.equal(conclusion, 'failure');
});

test('a final release whose attestation failed tags nothing and fails', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0', { ...passing, attest: 'failure' });
  assert.deepEqual(results, { gate: 'success', build: 'success', attest: 'failure', tag: 'skipped', tagged: 'failure' });
  assert.equal(conclusion, 'failure');
});

test('a failed build tags nothing, for a pre-release and a final release', () => {
  for (const version of ['v0.1.0-rc.9', 'v0.1.0']) {
    const { results, conclusion } = simulate(main, version, { ...passing, build: 'failure' });
    assert.equal(results.tag, 'skipped', version);
    assert.equal(conclusion, 'failure', version);
  }
});

test('a failed tag fails the run', () => {
  for (const version of ['v0.1.0-rc.9', 'v0.1.0']) {
    const { results, conclusion } = simulate(main, version, { ...passing, tag: 'failure' });
    assert.equal(results.tagged, 'failure', version);
    assert.equal(conclusion, 'failure', version);
  }
});

test('a cancelled build tags nothing and the run ends cancelled, without a failed check', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0-rc.9', { ...passing, build: 'cancelled' });
  assert.deepEqual(results, { gate: 'skipped', build: 'cancelled', attest: 'skipped', tag: 'skipped', tagged: 'skipped' });
  assert.equal(conclusion, 'cancelled');
});

test('a run outside main skips every release job and does not end as success', () => {
  for (const version of ['v0.1.0-rc.9', 'v0.1.0']) {
    const { results, conclusion } = simulate('refs/heads/other', version, passing);
    assert.deepEqual(results, { gate: 'skipped', build: 'skipped', attest: 'skipped', tag: 'skipped', tagged: 'failure' }, version);
    assert.equal(conclusion, 'failure', version);
  }
});

// Steps of the build job that run only for a final version, by their condition.
const finalOnly = (job: string) => jobs[job]!.steps
  .filter((step) => step.if !== undefined)
  .map((step) => {
    const run = (version: string) => Boolean(evaluate(step.if!, { ref: main, version, cancelled: false, results: new Map(), upstream: [] }));
    assert.equal(run('v0.1.0-rc.9'), false, `a pre-release must skip ${step.name ?? step.uses}`);
    assert.equal(run('v0.1.0'), true, `a final version must run ${step.name ?? step.uses}`);
    return step;
  });

test('only a final version writes and uploads the SBOM, after the release tree is staged and uploaded', () => {
  const steps = jobs.build!.steps;
  const conditional = finalOnly('build');
  assert.equal(conditional.length, 2, 'the SBOM is written and uploaded, and nothing else in build depends on the version');
  assert.match(conditional[0]!.run!, /^node src\/release\/sbom\.ts "\$GITHUB_REPOSITORY" "\$RUNNER_TEMP\/release" "\$RUNNER_TEMP\/sbom\.spdx\.json"$/);
  assert.match(conditional[1]!.uses!, /^actions\/upload-artifact@/);
  assert.equal(conditional[1]!.with!.name, 'release-sbom');
  const stage = steps.findIndex((step) => step.run?.includes('src/release/prepare.ts'));
  assert.ok(stage >= 0 && steps.indexOf(conditional[0]!) > stage, 'the SBOM reads the staged release');
});

test('the attest job signs provenance and the SBOM for the release files with only the permissions it needs', () => {
  const job = jobs.attest!;
  assert.equal(job.if, undefined, 'it runs only when the gate and the build succeeded, so only for a final version');
  assert.deepEqual(job.permissions, { 'id-token': 'write', attestations: 'write' });
  const downloads = job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@')).map((step) => step.with!.name);
  assert.deepEqual(downloads, ['release-tree', 'release-sbom']);
  // No checkout and no repository script: the job that can mint an identity token runs only pinned actions and coreutils.
  assert.ok(job.steps.every((step) => !step.uses?.startsWith('actions/checkout@') && !/\bnode\b|\bnpm\b/.test(step.run ?? '')));
  const attests = job.steps.filter((step) => step.uses?.startsWith('actions/attest@'));
  assert.deepEqual(attests.map((step) => step.with), [
    { 'subject-checksums': '${{ runner.temp }}/subjects.sha256' },
    { 'subject-checksums': '${{ runner.temp }}/subjects.sha256', 'sbom-path': '${{ runner.temp }}/sbom.spdx.json' },
  ]);
  for (const [name, other] of Object.entries(jobs)) {
    if (name !== 'attest') assert.ok(!other.permissions || !('id-token' in other.permissions), `${name} must not get id-token`);
  }
});

test('every action in release.yml is pinned to a full commit SHA', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (step.uses !== undefined) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
    }
  }
});

test('the attestation subjects are every file of the release tree, by path', () => {
  const step = jobs.attest!.steps.find((each) => each.name === 'List the release files as attestation subjects')!;
  const directory = mkdtempSync(join(tmpdir(), 'release-subjects-'));
  try {
    mkdirSync(join(directory, 'tree/dist'), { recursive: true });
    writeFileSync(join(directory, 'tree/dist/cli.js'), 'cli\n');
    writeFileSync(join(directory, 'tree/action.yml'), 'action\n');
    writeFileSync(join(directory, 'tree/.pre-commit-hooks.yaml'), 'hooks\n');
    execFileSync('tar', ['-C', join(directory, 'tree'), '-cf', join(directory, 'release.tar'), '.']);
    const run = spawnSync('bash', ['-e', '-c', step.run!], { env: { ...process.env, RUNNER_TEMP: directory }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    assert.equal(readFileSync(join(directory, 'subjects.sha256'), 'utf8'), [
      `${digest('hooks\n')}  .pre-commit-hooks.yaml`,
      `${digest('action\n')}  action.yml`,
      `${digest('cli\n')}  dist/cli.js`,
      '',
    ].join('\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
