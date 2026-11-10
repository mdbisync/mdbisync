// Which jobs of release.yml run, and how the run ends, for each release path.
// The job conditions are read from the workflow and evaluated the way GitHub
// does: a condition without a status function is implicitly `success() && …`,
// and success() fails when any job upstream did not succeed (a skipped one
// included).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: { run?: string; env?: Record<string, string> }[];
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
const passing = { gate: 'success', build: 'success', tag: 'success' } as const;

test('release.yml has the gate, build, tag and final check jobs in that order', () => {
  assert.deepEqual(Object.keys(jobs), ['gate', 'build', 'tag', 'tagged']);
  assert.deepEqual(needsOf('tagged'), ['tag']);
  assert.deepEqual(jobs.tagged!.permissions, {});
});

test('the tag job itself requires a passed gate for a final version, whatever the build condition says', () => {
  const tags = (version: string, gate: Result) => evaluate(jobs.tag!.if!, {
    ref: main, version, cancelled: false, upstream: ['gate', 'build'],
    results: new Map<string, Result>([['gate', gate], ['build', 'success']]),
  });
  for (const gate of ['failure', 'skipped', 'cancelled'] as const) assert.equal(tags('v0.1.0', gate), false, gate);
  assert.equal(tags('v0.1.0', 'success'), true);
  assert.equal(tags('v0.1.0-rc.9', 'skipped'), true);
});

test('a pre-release skips the gate, then builds and tags', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0-rc.9', passing);
  assert.deepEqual(results, { gate: 'skipped', build: 'success', tag: 'success', tagged: 'success' });
  assert.equal(conclusion, 'success');
});

test('a final release that passed the gate builds and tags', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0', passing);
  assert.deepEqual(results, { gate: 'success', build: 'success', tag: 'success', tagged: 'success' });
  assert.equal(conclusion, 'success');
});

test('a final release that failed the gate builds and tags nothing and fails', () => {
  const { results, conclusion } = simulate(main, 'v0.1.0', { ...passing, gate: 'failure' });
  assert.deepEqual(results, { gate: 'failure', build: 'skipped', tag: 'skipped', tagged: 'failure' });
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
  assert.deepEqual(results, { gate: 'skipped', build: 'cancelled', tag: 'skipped', tagged: 'skipped' });
  assert.equal(conclusion, 'cancelled');
});

test('a run outside main skips every release job and does not end as success', () => {
  for (const version of ['v0.1.0-rc.9', 'v0.1.0']) {
    const { results, conclusion } = simulate('refs/heads/other', version, passing);
    assert.deepEqual(results, { gate: 'skipped', build: 'skipped', tag: 'skipped', tagged: 'failure' }, version);
    assert.equal(conclusion, 'failure', version);
  }
});
