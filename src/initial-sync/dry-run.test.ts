// The initial sync's dry run through the command line, against a local git
// remote and a fake GitHub and Linear: it lists what a confirmed run would
// do and writes nothing anywhere (L1-03, and the left-out part of L1-13),
// including the documents its uploads would leave out.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { COMMANDS, SETUP_FAILED_EXIT_CODE, USAGE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Git } from '../state/index.ts';
import { type Fixture, countLocalLfsObjects, createFixture } from '../state/test-helpers.ts';

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
    assert.match(summary, /^\| eng\/backend\/retired\.md \| team "ENG" \| doc-retired \|$/m);
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

  for (const [label, extra] of [['a run from Linear to git', { MDBISYNC_DIRECTION: 'linear-to-git' }]] as const) {
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

describe('initial sync dry run: documents the uploads would leave out', () => {
  const MB = 1024 * 1024;
  /** A pointer to an LFS object the remote does not have: only the pointer can tell its size. */
  const pointer = (size: number, oid: string, extension = '') => `version https://git-lfs.github.com/spec/v1\n${extension}oid sha256:${oid}\nsize ${size}\n`;
  const EXTENSION = `ext-0-foo sha256:${'ef'.repeat(32)}\n`;
  const LOGO = Buffer.alloc(2048, 3);
  const MARK = Buffer.alloc(1500, 5);
  const SEAL = Buffer.alloc(1600, 6);
  const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');
  const UPLOAD_TREE = {
    '.pre-commit-config.yaml': PRE_COMMIT,
    'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
    // A file over the 10 MB limit, stored in git, next to a small one.
    'eng/big.md': `# Big\n\n![Scan](files/scan.bin) and [the small one](files/small.pdf)\n\n${CANARY}\n`,
    'eng/files/scan.bin': Buffer.alloc(10 * MB + 1, 7),
    // A small file stored in LFS: its document is written as usual.
    'eng/small.md': `# Small\n\n[Report](files/small.pdf)\n\n${CANARY}\n`,
    'eng/files/small.pdf': Buffer.from('%PDF-1.4 small report\n'),
    // An LFS pointer of 20 MB whose object is not on the remote.
    'eng/video.md': `# Video\n\n[Recording](raw/recording.mp4)\n\n${CANARY}\n`,
    'eng/raw/recording.mp4': pointer(20 * MB, 'cd'.repeat(32)),
    // LFS pointers naming an LFS extension: the run cannot read their objects. Listed in link order.
    'eng/packed.md': `# Packed\n\n[Second](raw/second.zip) and [Archive](raw/archive.zip)\n\n${CANARY}\n`,
    'eng/raw/second.zip': pointer(512, 'ab'.repeat(32), EXTENSION),
    'eng/raw/archive.zip': pointer(512, 'ce'.repeat(32), EXTENSION),
    // A pointer with an extension whose content an earlier document uploads from git: the run never reads it.
    'eng/a-logo.md': `# Logo\n\n![Logo](files/logo.bin)\n\n${CANARY}\n`,
    'eng/files/logo.bin': LOGO,
    'eng/b-logo.md': `# Logo again\n\n![Logo](raw/logo.bin)\n\n${CANARY}\n`,
    'eng/raw/logo.bin': pointer(LOGO.length, sha(LOGO), EXTENSION),
    // A second document linking the same file in git, larger than a pointer.
    'eng/c-logo.md': `# Logo once more\n\n![Logo](files/logo.bin)\n\n${CANARY}\n`,
    // One document links a file in git and a pointer with an extension to the same content, in both orders: the file is uploaded.
    'eng/d-both.md': `# Both\n\n![Mark](files/mark.bin) ![Mark](raw/mark.bin)\n\n${CANARY}\n`,
    'eng/files/mark.bin': MARK,
    'eng/raw/mark.bin': pointer(MARK.length, sha(MARK), EXTENSION),
    'eng/e-both.md': `# Both again\n\n![Seal](raw/seal.bin) ![Seal](files/seal.bin)\n\n${CANARY}\n`,
    'eng/files/seal.bin': SEAL,
    'eng/raw/seal.bin': pointer(SEAL.length, sha(SEAL), EXTENSION),
  };

  let fixture: Fixture;
  let clone: Git;
  before(async () => {
    fixture = await createFixture();
    await fixture.seed(UPLOAD_TREE, { lfs: ['*.pdf'] });
    clone = await fixture.clone('work');
  });
  after(() => fixture.cleanup());

  const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);

  const run = async (world: FakeWorld, confirm: boolean) => {
    const reportFile = join(fixture.root, 'report.json');
    const summaryFile = join(fixture.root, 'summary.md');
    await rm(reportFile, { force: true });
    await rm(summaryFile, { force: true });
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
      MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
      MDBISYNC_LINEAR_API_URL: LINEAR_API,
      MDBISYNC_GITHUB_TOKEN: 'gh-token',
      MDBISYNC_GITHUB_API_URL: GITHUB_API,
      MDBISYNC_REPOSITORY: 'owner/repo',
      MDBISYNC_REPORT_FILE: reportFile,
      MDBISYNC_DIRECTION: 'git-to-linear',
      MDBISYNC_CONFIRM: String(confirm),
      GITHUB_STEP_SUMMARY: summaryFile,
    };
    const result = await runCli(['initial-sync'], { env, cwd: clone.dir, fetch: fakeFetch(world) });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    return { report: JSON.parse(await readFile(reportFile, 'utf8')) as RunReport, summary: await readFile(summaryFile, 'utf8') };
  };

  /** Linear holds the document of the file over the limit. */
  const linearWithBig = () => {
    const world = fakeWorld();
    world.linear.documents = [{ id: 'doc-big', title: 'big', teamId: 'team-eng', createdAt: '2026-01-01T00:00:01Z' }];
    return world;
  };

  const LEFT_OUT = [
    { path: 'eng/big.md', rule: 'upload-too-large', files: ['eng/files/scan.bin'] },
    { path: 'eng/packed.md', rule: 'upload-unreadable', files: ['eng/raw/second.zip', 'eng/raw/archive.zip'] },
    { path: 'eng/video.md', rule: 'upload-too-large', files: ['eng/raw/recording.mp4'] },
  ];

  const WRITTEN = ['eng/README.md', 'eng/a-logo.md', 'eng/b-logo.md', 'eng/c-logo.md', 'eng/d-both.md', 'eng/e-both.md', 'eng/small.md'];

  it('lists a document linking a file over 10 MB as left out with upload-too-large and the file; uploads, downloads and writes nothing', async () => {
    const world = linearWithBig();
    const refsBefore = await refs();
    const { report, summary } = await run(world, false);

    assert.deepEqual(world.writes, [], 'the dry run wrote to GitHub or Linear');
    assert.equal(await refs(), refsBefore, 'the dry run moved a ref');
    assert.equal(await countLocalLfsObjects(clone), 0, 'the dry run downloaded an LFS object');

    assert.deepEqual(report.summary?.plan.create, WRITTEN);
    assert.deepEqual(report.summary?.plan.overwrite, []);
    assert.deepEqual(report.summary?.plan.trash, [], 'the document of a left-out file is not trashed');
    assert.deepEqual(
      report.summary?.leftOutFiles,
      LEFT_OUT.map(({ path, rule, files }) => ({ path, rules: [rule], lines: [], files, ...(path === 'eng/big.md' ? { documentId: 'doc-big' } : {}) })),
    );
    assert.deepEqual(report.oversizeFiles, ['eng/files/scan.bin', 'eng/raw/recording.mp4']);

    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    assert.match(summary, /- leave out 3 files, which stay in git only until they are fixed\./);
    assert.match(summary, /^\| eng\/big\.md \| upload-too-large \|  \| eng\/files\/scan\.bin \|$/m);
    assert.match(summary, /^\| eng\/video\.md \| upload-too-large \|  \| eng\/raw\/recording\.mp4 \|$/m);
    assert.match(summary, /^\| eng\/packed\.md \| upload-unreadable \|  \| eng\/raw\/second\.zip, eng\/raw\/archive\.zip \|$/m);
  });

  it('lists the same documents, rules and files that the confirmed run leaves out at the write', async () => {
    const { report } = await run(linearWithBig(), true);
    assert.deepEqual(report.initialSync?.created, WRITTEN);
    assert.deepEqual(report.initialSync?.leftOutAtWrite, LEFT_OUT);
  });
});
