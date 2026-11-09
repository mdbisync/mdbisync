// The preflight through the command line, against a local git remote and a
// fake GitHub and Linear: the same situations as the setup scenarios, with
// the writes counted on every side.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LogEntry } from '../linear/index.ts';
import { runCli } from '../cli.ts';
import { NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { CHECK_NAMES } from '../setup/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { commitIds, commitUploads } from '../state/index.ts';
import { IDENTITY, type Fixture, createFixture } from '../state/test-helpers.ts';
import { type RunReport } from './finish.ts';
import { INPUT_NAMES, environmentName } from './inputs.ts';

const CANARY = 'kx-5e7c0a11';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: no-test-secrets
        alias: security
        name: no test secrets
        language: pygrep
        entry: 'TESTKEY-[0-9a-f]{24}'
`;

const MINI = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'loose/notes.md': `# Loose\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\n${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `# Plan\n\n${CANARY}\n`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/guide.md': `# Guide\n\n${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

describe('preflight', () => {
  let fixture: Fixture;
  let cwd: string;

  before(async () => {
    fixture = await createFixture();
    await fixture.seed(MINI);
    cwd = (await fixture.clone('work')).dir;
  });
  after(() => fixture.cleanup());

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: join(fixture.root, 'report.json'),
    ...extra,
  });

  const run = async (command: string, world: FakeWorld, extra: Record<string, string> = {}) => {
    const result = await runCli([command], { env: env(extra), cwd, fetch: fakeFetch(world) });
    const report = JSON.parse(await readFile(join(fixture.root, 'report.json'), 'utf8')) as RunReport;
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    assert.ok(!JSON.stringify(report).includes(CANARY), 'the report holds content');
    assert.deepEqual(world.writes, [], 'the run wrote');
    return { result, report };
  };

  it('L1-01: the sync without state writes nothing, asks for initial sync and talks to no service', async () => {
    const world = fakeWorld();
    const { result, report } = await run('sync', world);
    assert.equal(result.exitCode, NO_STATE_EXIT_CODE);
    assert.equal(report.code, 'initial-sync-required');
    assert.match(result.stdout, /run initial sync first/);
    assert.deepEqual(world.requests, []);
    assert.deepEqual(await fixture.remote.text(['for-each-ref', '--format=%(refname)']), 'refs/heads/main');
  });

  it('L1-02: a correct setup passes; the summary lists every item and the security hooks', async () => {
    const world = fakeWorld();
    const { result, report } = await run('initial-sync', world, { MDBISYNC_DIRECTION: 'git-to-linear' });
    assert.equal(report.ok, true);
    assert.equal(report.code, null);
    assert.deepEqual(report.setupChecks.map((check) => check.name), [...CHECK_NAMES]);
    assert.deepEqual(report.securityHooks, ['no-test-secrets']);
    assert.match(result.stdout, /\| security-hooks \| passed \| security hooks present: no-test-secrets \|/);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(world.minted, 1);
    assert.equal(world.revoked, 1);
  });

  it('a Linear outage while minting is an error of the run, not a credential failure', async () => {
    const world = fakeWorld();
    world.linear.unavailable = true;
    await assert.rejects(runCli(['check'], { env: env(), cwd, fetch: fakeFetch(world) }), /oauth\.token: Linear refused the token request/);
    assert.deepEqual(world.writes, []);
  });

  it('emits safe complete lifecycle diagnostics from the setup caller', async () => {
    const entries: LogEntry[] = [];
    const log = (entry: LogEntry) => { entries.push(entry); };
    const world = fakeWorld();
    const request = fakeFetch(world);
    let next = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await request(input, init);
      if (String(input).startsWith(LINEAR_API)) {
        response.headers.set('x-request-id', `setup-request-${++next}`);
        response.headers.set('x-ratelimit-requests-limit', '5000');
        response.headers.set('x-ratelimit-requests-remaining', '4500');
        response.headers.set('set-cookie', 'private-cookie-canary');
      }
      return response;
    };
    const result = await runCli(['check'], { env: env(), cwd, fetch, log });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(entries.map(e => e.operation), ['oauth.token', 'SetupTargets', 'oauth.revoke']);
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.status, 200);
      assert.equal(entry.requestId, `setup-request-${index + 1}`);
      assert.equal(entry.grantType, 'client_credentials');
      assert.deepEqual(entry.requestedScopes, ['read', 'write']);
      assert.deepEqual(entry.returnedScopes, ['read', 'write']);
      assert.equal(new Date(entry.startedAt).toISOString(), entry.startedAt);
      assert.equal(new Date(entry.finishedAt).toISOString(), entry.finishedAt);
      assert.equal(entry.rateLimitHeaders['x-ratelimit-requests-remaining'], '4500');
    }
    assert.equal(entries.at(-1)?.revocationConfirmed, true);
    for (const secret of ['client-id', 'client-secret', 'fake-token', 'gh-token', 'private-cookie-canary', CANARY, 'Field notes', 'Handbook', 'team-eng', 'project-api']) {
      assert.ok(!JSON.stringify(entries).includes(secret), secret);
    }
    assert.deepEqual(world.writes, []);
    assert.equal(world.revoked, 1);
  });

  it('emits the rejected mint even when setup returns a credential failure', async () => {
    const entries: LogEntry[] = [];
    const log = (entry: LogEntry) => { entries.push(entry); };
    const world = fakeWorld();
    world.linear.credentialsValid = false;
    const result = await runCli(['check'], { env: env(), cwd, fetch: fakeFetch(world), log });
    assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.operation, 'oauth.token');
    assert.equal(entries[0]?.status, 401);
    assert.deepEqual(entries[0]?.errorCodes, ['invalid_client']);
    assert.equal(world.minted, 0);
    assert.equal(world.revoked, 0);
  });

  it('retains query and failed-revocation diagnostics when setup throws', async () => {
    const entries: LogEntry[] = [];
    const log = (entry: LogEntry) => { entries.push(entry); };
    const world = fakeWorld();
    const request = fakeFetch(world);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === `${LINEAR_API}/graphql`) return new Response(JSON.stringify({ errors: [{ message: 'Entity not found: User', extensions: { code: 'INPUT_ERROR' } }] }), { status: 400, headers: { 'x-request-id': 'setup-query-failed' } });
      if (url === `${LINEAR_API}/oauth/revoke`) return new Response('{}', { status: 401, headers: { 'x-request-id': 'setup-revoke-failed' } });
      return request(input, init);
    };
    const warnings: string[] = [];
    await assert.rejects(runCli(['check'], { env: env(), cwd, fetch, log, warn: message => { warnings.push(message); } }), /Entity not found: User/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /token could not be revoked/);
    assert.deepEqual(entries.map(e => [e.operation, e.status]), [['oauth.token', 200], ['SetupTargets', 400], ['oauth.revoke', 401]]);
    assert.equal(entries[1]?.requestId, 'setup-query-failed');
    assert.deepEqual(entries[1]?.errorCodes, ['INPUT_ERROR']);
    assert.equal(entries[2]?.requestId, 'setup-revoke-failed');
    assert.equal(entries[2]?.revocationConfirmed, false);
    assert.deepEqual(world.writes, []);
  });

  for (const [entry, action] of [['../cli.ts', false], ['../../dist/cli.js', false], ['../action/main.ts', true], ['../../dist/action-main.js', true]] as const) {
    it(`the entry process retains diagnostics and cleanup warnings on failure (${entry})`, async () => {
      const injection = join(fixture.root, 'setup-fake-fetch.mjs');
      const helpers = new URL('../setup/test-helpers.ts', import.meta.url).href;
      await writeFile(injection, `
        import { fakeFetch, fakeWorld } from ${JSON.stringify(helpers)};
        const original = fakeFetch(fakeWorld());
        globalThis.fetch = async (input, init) => {
          if (String(input).endsWith('/graphql')) return new Response(JSON.stringify({ errors: [{ message: 'Entity not found: User', extensions: { code: 'INPUT_ERROR' } }] }), { status: 400 });
          if (String(input).endsWith('/oauth/revoke')) return new Response('{}', { status: 401 });
          return original(input, init);
        };
      `);
      await writeFile(join(fixture.root, 'action-state'), '');
      const fakeEnv: Record<string, string> = env();
      const actionEnv = Object.fromEntries(INPUT_NAMES.map(name => [`INPUT_${name.toUpperCase()}`, fakeEnv[environmentName(name)] ?? '']));
      const child = spawnSync(process.execPath, ['--import', injection, fileURLToPath(new URL(entry, import.meta.url)), 'check'], {
        cwd, env: action ? { ...fakeEnv, ...actionEnv, INPUT_OPERATION: 'initial-sync', INPUT_DIRECTION: 'git-to-linear', GITHUB_WORKSPACE: cwd, GITHUB_OUTPUT: '', GITHUB_STATE: join(fixture.root, 'action-state'), GITHUB_STEP_SUMMARY: '' } : fakeEnv,
        encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(child.status, 1, child.stderr);
      const stream = action ? child.stdout : child.stderr;
      const lines = stream.trim().split('\n');
      const events = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line) as LogEntry);
      assert.deepEqual(events.map(e => [e.operation, e.status]), [['oauth.token', 200], ['SetupTargets', 400], ['oauth.revoke', 401]]);
      const warning = lines.findIndex(line => line.startsWith(action ? '::warning' : 'warning:'));
      const primary = lines.findIndex(line => line.startsWith(action ? '::error' : 'error:'));
      assert.ok(warning >= 0 && primary > warning, child.stderr);
      assert.match(lines[warning]!, /token could not be revoked/);
      assert.match(lines[primary]!, /Entity not found: User/);
      // The runner consumes mask commands; it never logs them.
      const logged = `${child.stdout.replace(/^::add-mask::.*$/gm, '')}${child.stderr}`;
      for (const secret of ['client-id', 'client-secret', 'fake-token', 'gh-token', CANARY]) assert.ok(!logged.includes(secret), secret);
    });
  }

  it('the programmatic CLI does not write diagnostic events to the global console', async (t) => {
    const consoleError = t.mock.method(console, 'error', () => {});
    const { result } = await run('check', fakeWorld());
    assert.equal(result.exitCode, 0);
    assert.equal(consoleError.mock.callCount(), 0);
  });

  it('check passes with exit code 0', async () => {
    const { result } = await run('check', fakeWorld());
    assert.equal(result.exitCode, 0);
  });

  describe('with sync state', () => {
    before(async () => {
      // Any commit stands in for the recorded state: the preflight only needs the ref. The map and the cache are
      // empty, as an initial sync of no documents records them; a missing one would be recovered as lost.
      await fixture.remote.run(['update-ref', 'refs/mdbisync/linear', 'refs/heads/main']);
      await fixture.remote.run(['update-ref', 'refs/mdbisync/ids', await commitIds(fixture.remote, null, new Map(), IDENTITY)]);
      await fixture.remote.run(['update-ref', 'refs/mdbisync/uploads', await commitUploads(fixture.remote, null, new Map(), IDENTITY)]);
    });

    const cases: Array<[string, (world: FakeWorld) => void, string, RegExp]> = [
      ['L5-01 bad Linear credentials', (world) => (world.linear.credentialsValid = false), 'linear-credential-failed', /client credentials/],
      ['L5-02 GitHub App without contents:write', (world) => world.github.missing.add('contents:write'), 'missing-permission', /lacks contents:write/],
      ['L5-03 merge commits not allowed', (world) => (world.github.allowMergeCommit = false), 'merge-commits-required', /merge commits are not allowed/],
      ['L5-05 annotated team missing', (world) => (world.linear.teams = world.linear.teams.filter((team) => team.key !== 'ENG')), 'annotation-target-not-found', /team "ENG"/],
      ['L5-05 annotated project renamed', (world) => ((world.linear.projects[1] as { name: string }).name = 'Guide'), 'annotation-target-not-found', /project "Handbook"/],
    ];
    for (const [label, change, code, named] of cases) {
      it(`${label}: stops before any write and names it`, async () => {
        const world = fakeWorld();
        change(world);
        const { result, report } = await run('sync', world);
        assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE);
        assert.equal(report.code, code);
        assert.ok(report.setupChecks.some((check) => check.state === 'failed' && named.test(check.detail)), JSON.stringify(report.setupChecks));
        // The run's own error line names what failed too: the job summary is not always at hand.
        const line = result.stderr.split('\n').find((text) => text.startsWith('sync: stopped before any write')) ?? '';
        assert.ok(line.startsWith(`sync: stopped before any write (${code}): `), result.stderr);
        assert.match(line, named);
        assert.equal(world.minted, world.revoked, 'a minted token was not revoked');
      });
    }

    it('L5-04 no Linear-format hook: stops before any write and names it', async () => {
      const hookless = PRE_COMMIT.slice(PRE_COMMIT.indexOf('  - repo: local'));
      assert.ok(!hookless.includes('linear-format'));
      await fixture.seed({ '.pre-commit-config.yaml': `repos:\n${hookless}` });
      try {
        const world = fakeWorld();
        const result = await runCli(['sync'], { env: env(), cwd, fetch: fakeFetch(world) });
        const report = JSON.parse(await readFile(join(fixture.root, 'report.json'), 'utf8')) as RunReport;
        assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE);
        assert.equal(report.code, 'linear-format-hook-required');
        assert.ok(report.setupChecks.some((check) => check.name === 'linear-format-hook' && check.state === 'failed' && /no linear-format hook/.test(check.detail)));
        assert.match(result.stderr, /sync: stopped before any write \(linear-format-hook-required\): .*no linear-format hook/);
        assert.deepEqual(world.writes, []);
      } finally {
        await fixture.seed({ '.pre-commit-config.yaml': PRE_COMMIT });
      }
    });

    it('a correct setup lets the sync past the preflight; with the state at the tracked branch it has nothing to do', async () => {
      // Earlier cases commit to the tracked branch; the state takes it in again.
      await fixture.remote.run(['update-ref', 'refs/mdbisync/linear', 'refs/heads/main']);
      const { result, report } = await run('sync', fakeWorld());
      assert.equal(report.ok, true);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(report.complete, true);
      assert.equal(report.changed, false);
      assert.match(result.stdout, /nothing to write/);
    });

    /** The fake world with every Linear query's operation name recorded. */
    const counted = (change: (world: FakeWorld) => void) => {
      const world = fakeWorld();
      change(world);
      const operations: string[] = [];
      world.linear.beforeQuery = (operation) => operations.push(operation);
      return { world, operations };
    };

    it('a token that once sees no team is asked again, and the sync goes on when it then sees them', async () => {
      const { world, operations } = counted((world) => (world.linear.teamsHidden = 1));
      const { result, report } = await run('sync', world);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(report.ok, true);
      assert.match(result.stdout, /nothing to write/);
      assert.equal(operations.filter((operation) => operation === 'SetupTargets').length, 2);
    });

    it('a token that sees no team in two lookups stops the sync and says the app sees no team, not that every team is missing', async () => {
      const { world, operations } = counted((world) => (world.linear.teamsHidden = Infinity));
      const { result, report } = await run('sync', world);
      assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE);
      assert.equal(report.code, 'linear-teams-not-visible');
      assert.equal(operations.filter((operation) => operation === 'SetupTargets').length, 2);
      const detail = report.setupChecks.find((check) => check.name === 'annotation-targets')?.detail ?? '';
      assert.match(detail, /the Linear app saw no team in two lookups/);
      assert.match(detail, /"Docs", "ENG"/);
      assert.match(detail, /check the app's team access in Linear/);
      assert.doesNotMatch(detail, /not found in Linear/);
      assert.match(result.stderr, /sync: stopped before any write \(linear-teams-not-visible\): the Linear app saw no team/);
      assert.equal(world.minted, world.revoked, 'a minted token was not revoked');
    });

    it('when the token sees teams but none of the annotated ones, the teams are named as not found', async () => {
      const { world, operations } = counted((world) => (world.linear.teams = [{ id: 'team-other', key: 'OPS', name: 'Operations' }]));
      const { result, report } = await run('sync', world);
      assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE);
      assert.equal(report.code, 'annotation-target-not-found');
      assert.equal(operations.filter((operation) => operation === 'SetupTargets').length, 1, 'a token that sees teams is asked once');
      assert.match(result.stderr, /not found in Linear: team "Docs", team "ENG"/);
    });
  });
});
