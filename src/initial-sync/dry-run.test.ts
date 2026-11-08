// The initial sync's dry run through the command line, against a local git
// remote and a fake GitHub and Linear: it lists what a confirmed run would
// do and writes nothing anywhere (L1-03, and the left-out part of L1-13).

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { COMMANDS, SETUP_FAILED_EXIT_CODE, USAGE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';

const CANARY = 'kx-7a2b9c40';
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

const TREE = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'loose/notes.md': `# Loose\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\n${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `# Plan\n\n${CANARY}\n`,
  'eng/notes/formula.md': `# Formula\n\nWater is H~2~O. ${CANARY}\n`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/Guide.md': `# Guide\n\n${CANARY}\n`,
  'combined/guide.md': `# guide\n\n${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

describe('initial sync dry run', () => {
  let fixture: Fixture;
  let cwd: string;
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  before(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('work')).dir;
  });
  after(() => fixture.cleanup());

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: reportFile(),
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);

  const run = async (world: FakeWorld, extra: Record<string, string>) => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const before = await refs();
    const result = await runCli(['initial-sync'], { env: env(extra), cwd, fetch: fakeFetch(world) });
    assert.deepEqual(world.writes, [], 'the run wrote to GitHub or Linear');
    assert.equal(await refs(), before, 'the run moved a branch or ref');
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    return result;
  };
  const readReport = async () => JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;

  /** Linear holds one document of the tree, one only in Linear, and one of a left-out file. */
  const linearWithDocuments = () => {
    const world = fakeWorld();
    world.linear.documents = [
      { id: 'doc-notes', title: 'backend/notes', teamId: 'team-eng', createdAt: '2026-01-01T00:00:01Z' },
      { id: 'doc-retired', title: 'backend/retired', teamId: 'team-eng', createdAt: '2026-01-01T00:00:02Z' },
      { id: 'doc-archived', title: 'backend/archived', teamId: 'team-eng', createdAt: '2026-01-01T00:00:03Z', archivedAt: '2026-01-02T00:00:00Z' },
      { id: 'doc-formula', title: 'formula', projectId: 'project-api', createdAt: '2026-01-01T00:00:04Z' },
      { id: 'doc-elsewhere', title: 'plan', projectId: 'project-other', createdAt: '2026-01-01T00:00:05Z' },
    ];
    return world;
  };

  it('L1-03: lists by path what it would create, overwrite and trash, and the left-out files; writes nothing', async () => {
    const world = linearWithDocuments();
    const result = await run(world, { MDBISYNC_DIRECTION: 'git-to-linear' });
    assert.equal(result.exitCode, 0, result.stderr);

    const report = await readReport();
    assert.equal(report.ok, true);
    assert.equal(report.notImplemented, false);
    assert.deepEqual(report.summary?.plan, {
      create: ['combined/README.md', 'eng/README.md', 'eng/notes/README.md', 'eng/notes/plan.md'],
      overwrite: ['eng/backend/notes.md'],
      trash: ['eng/backend/retired.md'],
      paths: ['combined/README.md', 'eng/README.md', 'eng/backend/notes.md', 'eng/backend/retired.md', 'eng/notes/README.md', 'eng/notes/plan.md'],
    });
    assert.deepEqual(report.summary?.leftOut, ['combined/Guide.md', 'combined/guide.md', 'eng/notes/formula.md']);
    assert.deepEqual(report.summary?.collisionPaths, ['combined/Guide.md', 'combined/guide.md']);
    assert.deepEqual(report.summary?.leftOutFiles.find((entry) => entry.path === 'eng/notes/formula.md'), {
      path: 'eng/notes/formula.md',
      rules: ['subscript'],
      lines: [3],
      documentId: 'doc-formula',
    });

    const summary = await readFile(summaryFile(), 'utf8');
    assert.equal(summary, result.stdout);
    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    assert.match(summary, /## Setup check/);
    assert.match(summary, /## Initial sync from git to Linear: dry run\n\nNothing was written\./);
    assert.match(summary, /^\| eng\/backend\/retired\.md \| team "ENG" \|$/m);
    assert.match(summary, /^\| combined\/Guide\.md \| duplicate-title \|  \| combined\/guide\.md \|$/m);

    // Mint, two setup reads, one list per place (three), revoke; nothing else.
    const graphql = world.requests.filter((request) => request === `POST ${LINEAR_API}/graphql`);
    assert.equal(graphql.length, 5);
    assert.equal(world.minted, 1);
    assert.equal(world.revoked, 1);
  });

  it('L1-13 (dry run): every lint error and both colliding files are left out, with their rules', async () => {
    await run(fakeWorld(), { MDBISYNC_DIRECTION: 'git-to-linear' });
    const report = await readReport();
    assert.deepEqual(
      report.summary?.leftOutFiles.map((entry) => [entry.path, entry.rules, entry.collidesWith ?? []]),
      [
        ['combined/Guide.md', ['duplicate-title'], ['combined/guide.md']],
        ['combined/guide.md', ['duplicate-title'], ['combined/Guide.md']],
        ['eng/notes/formula.md', ['subscript'], []],
      ],
    );
    assert.deepEqual(report.summary?.plan.trash, []);
  });

  it('any confirm other than "true" is a dry run', async () => {
    const result = await run(fakeWorld(), { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'yes' });
    assert.equal(result.exitCode, 0);
    assert.equal((await readReport()).summary?.confirm, false);
  });

  it('direction is required and has no default; nothing is contacted without it', async () => {
    for (const direction of ['', 'both']) {
      const world = fakeWorld();
      const result = await run(world, { MDBISYNC_DIRECTION: direction });
      assert.equal(result.exitCode, USAGE_EXIT_CODE);
      assert.match(result.stderr, /the input direction (is required|must be one of git-to-linear, linear-to-git)/);
      assert.deepEqual(world.requests, []);
    }
  });

  it('two folders naming one team (by key and by name) stop the run before any document is listed', async () => {
    const aliased = await createFixture();
    try {
      await aliased.seed({
        'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n`,
        'eng/notes.md': '# Notes\n',
        'more/README.md': `---\nlinear-team: Engineering\n---\n\n# More\n`,
        'more/notes.md': '# Notes\n',
        '.pre-commit-config.yaml': PRE_COMMIT,
      });
      const world = fakeWorld();
      world.linear.documents = [{ id: 'doc-notes', title: 'notes', teamId: 'team-eng', createdAt: '2026-01-01T00:00:01Z' }];
      const result = await runCli(['initial-sync'], { env: env({ MDBISYNC_DIRECTION: 'git-to-linear' }), cwd: (await aliased.clone('work')).dir, fetch: fakeFetch(world) });
      assert.equal(result.exitCode, SETUP_FAILED_EXIT_CODE, result.stderr);
      assert.equal((await readReport()).code, 'annotation-target-shared');
      assert.equal((await readReport()).summary, null);
      assert.deepEqual(world.writes, []);
    } finally {
      await aliased.cleanup();
    }
  });

  for (const [label, extra] of [
    ['a confirmed run from git to Linear', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' }],
    ['a run from Linear to git', { MDBISYNC_DIRECTION: 'linear-to-git' }],
  ] as const) {
    it(`${label} is not built yet: it says so after the preflight and writes nothing`, async () => {
      const result = await run(fakeWorld(), extra);
      assert.equal(result.exitCode, COMMANDS['initial-sync'].notImplementedExitCode);
      assert.match(result.stderr, /initial-sync: not implemented/);
      const report = await readReport();
      assert.equal(report.notImplemented, true);
      assert.equal(report.summary, null);
    });
  }
});
