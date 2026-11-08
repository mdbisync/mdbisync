// The preflight through the command line, against a local git remote and a
// fake GitHub and Linear: the same situations as the setup scenarios, with
// the writes counted on every side.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { CHECK_NAMES } from '../setup/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { type RunReport } from './finish.ts';

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
    const { result, report } = await run('initial-sync', world);
    assert.equal(report.ok, true);
    assert.equal(report.code, null);
    assert.deepEqual(report.setupChecks.map((check) => check.name), [...CHECK_NAMES]);
    assert.deepEqual(report.securityHooks, ['no-test-secrets']);
    assert.match(result.stdout, /\| security-hooks \| passed \| security hooks present: no-test-secrets \|/);
    assert.equal(result.stderr, 'initial-sync: not implemented\n');
    assert.equal(world.minted, 1);
    assert.equal(world.revoked, 1);
  });

  it('a Linear outage while minting is an error of the run, not a credential failure', async () => {
    const world = fakeWorld();
    world.linear.unavailable = true;
    await assert.rejects(runCli(['check'], { env: env(), cwd, fetch: fakeFetch(world) }), /oauth\.token: Linear refused the token request/);
    assert.deepEqual(world.writes, []);
  });

  it('check passes with exit code 0', async () => {
    const { result } = await run('check', fakeWorld());
    assert.equal(result.exitCode, 0);
  });

  describe('with sync state', () => {
    before(async () => {
      // Any commit stands in for the recorded state: the preflight only needs the ref.
      await fixture.remote.run(['update-ref', 'refs/mdbisync/linear', 'refs/heads/main']);
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
        assert.deepEqual(world.writes, []);
      } finally {
        await fixture.seed({ '.pre-commit-config.yaml': PRE_COMMIT });
      }
    });

    it('a correct setup lets the sync past the preflight', async () => {
      const { result, report } = await run('sync', fakeWorld());
      assert.equal(report.ok, true);
      assert.equal(result.stderr, 'sync: not implemented\n');
    });
  });
});
