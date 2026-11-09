// The confirmed initial sync from git to Linear through the command line,
// against a local git remote and a fake GitHub and Linear: what it writes,
// what it records, how it resumes and how it recovers.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { environmentName, readInputs } from '../run/inputs.ts';
import { runPreflight } from '../run/preflight.ts';
import { Git } from '../state/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { type ConfirmedResult, FINAL_IDS_MESSAGE, PROGRESS_MESSAGE, confirmInitialSync } from './confirm.ts';
import { type BodyTransform, LeaveOutError } from './transform.ts';

const CANARY = 'kx-3c9e51d7';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const TREE: Record<string, string> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}`,
  'eng/backend/notes.md': `# Notes\n\n${CANARY}`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}`,
  'eng/notes/plan.md': `# Plan\n\nSteps. ${CANARY}`,
  'eng/notes/formula.md': `# Formula\n\nWater is H~2~O. ${CANARY}`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}`,
  'combined/Guide.md': `# Guide\n\n${CANARY}`,
  'combined/guide.md': `# guide\n\n${CANARY}`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

/** Synchronized files: their bodies, without front matter, by Linear title and place. */
const SYNCED = {
  'combined/README.md': { title: 'README', projectId: 'project-handbook', body: `# Handbook\n\n${CANARY}` },
  'eng/README.md': { title: 'README', teamId: 'team-eng', body: `# Engineering\n\n${CANARY}` },
  'eng/backend/notes.md': { title: 'backend/notes', teamId: 'team-eng', body: `# Notes\n\n${CANARY}` },
  'eng/notes/README.md': { title: 'README', projectId: 'project-api', body: `# Field notes\n\n${CANARY}` },
  'eng/notes/plan.md': { title: 'plan', projectId: 'project-api', body: `# Plan\n\nSteps. ${CANARY}` },
} as const;
const SYNCED_PATHS = Object.keys(SYNCED).sort();

describe('confirmed initial sync from git to Linear', () => {
  let fixture: Fixture;
  let cwd: string;
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('work')).dir;
  });
  afterEach(() => fixture.cleanup());

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: reportFile(),
    MDBISYNC_DIRECTION: 'git-to-linear',
    MDBISYNC_CONFIRM: 'true',
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  const run = async (world: FakeWorld, extra: Record<string, string> = {}) => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const requestsBefore = world.requests.length;
    const result = await runCli(['initial-sync'], { env: env(extra), cwd, fetch: fakeFetch(world) });
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.ok(!JSON.stringify(report).includes(CANARY), 'the report holds content');
    const graphql = world.requests.slice(requestsBefore).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
    return { result, report, summary, graphql };
  };

  const refs = async () => {
    const text = await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
    return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
  };
  const show = (spec: string) => fixture.remote.text(['show', spec]);
  const readIds = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const live = (world: FakeWorld) => world.linear.documents.filter((d) => d.trashed !== true && d.archivedAt === undefined);

  /** Every synchronized file has exactly one live document holding its body, in its place, under its title. */
  const assertConverged = async (world: FakeWorld) => {
    const ids = await readIds();
    assert.deepEqual(Object.keys(ids).sort(), SYNCED_PATHS);
    for (const [path, expected] of Object.entries(SYNCED)) {
      const document = world.linear.documents.find((d) => d.id === ids[path]?.id);
      assert.ok(document !== undefined && document.trashed !== true, `${path} has no live document`);
      assert.equal(document.title, expected.title);
      assert.equal(document.content, expected.body, `${path}: content`);
      assert.equal(document.projectId, 'projectId' in expected ? expected.projectId : undefined);
      assert.equal(document.teamId, 'teamId' in expected ? expected.teamId : undefined);
    }
    const keys = live(world).map((d) => `${d.projectId ?? d.teamId}/${d.title}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate documents');
  };

  it('L1-04 and L1-06: creates a document per synchronized file, without front matter, and records the state', async () => {
    const world = fakeWorld();
    const { result, report, summary, graphql } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);

    await assertConverged(world);
    assert.ok(live(world).every((d) => !(d.content ?? '').startsWith('---')), 'front matter reached Linear');
    assert.equal(live(world).length, SYNCED_PATHS.length, 'a left-out file reached Linear');

    const after = await refs();
    const tracked = after['refs/heads/main'] as string;
    // `linear` is one commit whose parent is the tracked branch; Linear kept every body, so its tree is the tracked tree.
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@']), tracked);
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^{tree}']), await fixture.remote.text(['rev-parse', `${tracked}^{tree}`]));
    assert.equal(await show('refs/mdbisync/linear:eng/README.md'), TREE['eng/README.md']);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/ids']), FINAL_IDS_MESSAGE);
    assert.equal(await show('refs/mdbisync/uploads:uploads.json'), '{}');
    assert.equal(after['refs/heads/mdbisync/linear'], undefined, 'a sync branch was pushed');

    assert.equal(report.writtenCount, SYNCED_PATHS.length);
    assert.deepEqual(report.initialSync?.created, SYNCED_PATHS);
    assert.equal(report.record?.hasTrackedParent, true);
    assert.equal(report.record?.reformattedCount, 0);
    assert.deepEqual(report.summary?.leftOut, ['combined/Guide.md', 'combined/guide.md', 'eng/notes/formula.md']);
    assert.match(summary, /Linear now equals the tracked branch/);

    // I9: at most 1.5 requests per written document plus 5 for the run.
    assert.ok(graphql <= 1.5 * SYNCED_PATHS.length + 5, `${graphql} requests`);
  });

  it('L1-14: a matched document keeps its id and gets the text; an archived one is ignored; a Linear-only one goes to trash', async () => {
    const world = fakeWorld();
    world.linear.documents = [
      { id: 'doc-plan', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: 'Old text.' },
      { id: 'doc-retired', title: 'backend/retired', teamId: 'team-eng', createdAt: '2026-01-01T00:00:02Z', content: 'Retired.' },
      { id: 'doc-archived', title: 'backend/notes', teamId: 'team-eng', createdAt: '2026-01-01T00:00:03Z', archivedAt: '2026-01-02T00:00:00Z' },
      { id: 'doc-formula', title: 'formula', projectId: 'project-api', createdAt: '2026-01-01T00:00:04Z', content: 'Kept.' },
    ];
    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);

    await assertConverged(world);
    assert.equal((await readIds())['eng/notes/plan.md']?.id, 'doc-plan');
    assert.deepEqual(report.initialSync?.overwritten, ['eng/notes/plan.md']);
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-retired')?.trashed, true);
    assert.deepEqual(report.initialSync?.trashed, ['eng/backend/retired.md']);
    assert.match(summary, /^\| eng\/backend\/retired\.md \|$/m);
    const archived = world.linear.documents.find((d) => d.id === 'doc-archived');
    assert.equal(archived?.trashed, undefined);
    assert.equal(archived?.content, undefined);
    // A left-out file's document is neither overwritten nor trashed.
    const formula = world.linear.documents.find((d) => d.id === 'doc-formula');
    assert.equal(formula?.content, 'Kept.');
    assert.equal(formula?.trashed, undefined);
  });

  it('L1-18: run again with nothing changed writes nothing and leaves the refs as they are', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();
    const documents = structuredClone(world.linear.documents);
    const writes = world.linear.writes.count;

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(await refs(), before);
    assert.deepEqual(world.linear.documents, documents);
    assert.equal(world.linear.writes.count, writes);
    assert.equal(report.writtenCount, 0);
    assert.deepEqual(report.initialSync?.unchanged, SYNCED_PATHS);
    assert.equal(report.record?.moved, false);
  });

  it('L1-19: with the state refs deleted, a new run rebuilds them without duplicates', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    const idsBefore = await readIds();
    for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    const after = await refs();
    for (const store of ['linear', 'ids', 'uploads']) assert.ok(after[`refs/mdbisync/${store}`] !== undefined, `${store} was not rebuilt`);
    assert.deepEqual(await readIds(), idsBefore);
    assert.equal(world.linear.documents.length, SYNCED_PATHS.length);
    assert.equal(report.writtenCount, 0);
    await assertConverged(world);
  });

  it('L1-15: a run stopped after some documents records them; the next run skips them and records the state once', async () => {
    const world = fakeWorld();
    // The engine reads its test hooks from its own process environment.
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '2' };
    Object.assign(process.env, hooks);
    let first;
    try {
      first = await run(world);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.equal(first.report.code, 'stopped');
    assert.equal(first.report.writtenCount, 2);
    assert.equal(first.report.stoppedEarly, true);
    assert.equal(first.report.progressRecorded, true);
    assert.match(first.summary, /Run initial sync again with the same inputs/);
    const after = await refs();
    assert.equal(after['refs/mdbisync/linear'], undefined, 'a stopped run recorded linear');
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/ids']), PROGRESS_MESSAGE);
    // The progress commit holds the written documents' ids and the ids chosen for the ones still to create.
    const progress = await readIds();
    assert.deepEqual(Object.keys(progress).sort(), SYNCED_PATHS);
    for (const path of SYNCED_PATHS.slice(0, 2)) assert.ok(live(world).some((d) => d.id === progress[path]?.id), `${path} is not written`);

    // The sync does not run on a half-written id map.
    const sync = await runCli(['sync'], { env: { ...env(), MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }, cwd, fetch: fakeFetch(world) });
    assert.equal(sync.exitCode, NO_STATE_EXIT_CODE, sync.stderr);
    assert.match(sync.stdout, /An initial sync stopped before it finished/);

    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    // The resumed run creates the rest with the ids chosen before the stop, so links to them stay right.
    assert.deepEqual(await readIds(), progress);
    assert.equal(second.report.resumed, true);
    assert.equal(second.report.skippedCompletedCount, 2);
    assert.equal(second.report.writtenCount, SYNCED_PATHS.length - 2);
    assert.equal(await fixture.remote.text(['rev-list', '--count', 'refs/mdbisync/linear', '^refs/heads/main']), '1');
    await assertConverged(world);
  });

  it('a resumed run writes again a document whose file changed after the stop', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const [changed] = SYNCED_PATHS as [string];
    assert.ok(live(world).some((d) => d.content === SYNCED[changed as keyof typeof SYNCED].body), `${changed} was not written by the first run`);
    await fixture.seed({ [changed]: `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\nRevised. ${CANARY}` });

    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.resumed, true);
    assert.ok(report.initialSync?.overwritten.includes(changed), `${changed} was skipped`);
    const id = (await readIds())[changed]?.id;
    assert.equal(world.linear.documents.find((d) => d.id === id)?.content, `# Handbook\n\nRevised. ${CANARY}`);
    assert.equal(report.record?.reformattedCount, 0);
  });

  it('L1-17: a document created before its id was pushed is adopted by its title, not created again', async () => {
    const world = fakeWorld();
    // What a run killed right after creating the document leaves behind: the document, and no state.
    world.linear.documents = [{ id: 'doc-orphan', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: SYNCED['eng/notes/plan.md'].body }];
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((await readIds())['eng/notes/plan.md']?.id, 'doc-orphan');
    assert.deepEqual(report.initialSync?.unchanged, ['eng/notes/plan.md']);
    await assertConverged(world);
  });

  it('a rate limit stops the run; what it wrote is recorded and the next run finishes', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 3;
    const first = await run(world);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(first.report.code, 'stopped');
    assert.equal(first.report.writtenCount, 2);
    const progress = await readIds();
    for (const path of SYNCED_PATHS.slice(0, 2)) assert.ok(live(world).some((d) => d.id === progress[path]?.id), `${path} is not recorded`);
    // The client stops at the 429 and sends nothing after it.
    assert.equal(world.linear.writes.count, 3);

    delete world.linear.writes.rateLimitAt;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    await assertConverged(world);
  });

  it('a rejected write is named; the rest are written, but nothing is trashed or recorded until it succeeds', async () => {
    const world = fakeWorld();
    world.linear.documents = [{ id: 'doc-retired', title: 'retired', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: 'Retired.' }];
    world.linear.writes.reject = (operation, variables) =>
      operation === 'CreateDocument' && (variables.input as { title: string }).title === 'backend/notes';
    const first = await run(world);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(first.report.code, 'write-failed');
    assert.deepEqual(first.report.initialSync?.failed.map((entry) => entry.path), ['eng/backend/notes.md']);
    assert.match(first.summary, /^\| eng\/backend\/notes\.md \| CreateDocument \| LinearGraphQLError/m);
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-retired')?.trashed, undefined);
    assert.equal((await refs())['refs/mdbisync/linear'], undefined);

    delete world.linear.writes.reject;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-retired')?.trashed, true);
    await assertConverged(world);
  });

  it('runs each body through the transforms before writing, and their inverses before recording', async () => {
    const world = fakeWorld();
    const values = env();
    const inputs = readInputs((name) => values[environmentName(name) as keyof typeof values] ?? '');
    let preparedIds: Map<string, string> | undefined;
    let writesAtPrepare = -1;
    const marker: BodyTransform = {
      name: 'marker',
      prepare: async (context) => {
        preparedIds = new Map(context.documentIds);
        writesAtPrepare = world.linear.writes.count;
      },
      apply: async ({ path, body }) => `${body}\n\n(from ${path})`,
      restore: ({ path, body }) => body.replace(`\n\n(from ${path})`, ''),
    };
    const leaveOut: BodyTransform = {
      name: 'leave-out',
      apply: async ({ path, body }) => {
        if (path === 'eng/notes/plan.md') throw new LeaveOutError('upload-too-large', 'an embedded file is over the upload limit');
        // A body a transform makes longer than Linear accepts is left out, not sent.
        if (path === 'eng/README.md') return body + 'x'.repeat(250_001);
        return body;
      },
      restore: ({ body }) => body,
    };
    let result: ConfirmedResult | undefined;
    const outcome = await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, fetch: fakeFetch(world) }, async (context) => {
      result = (await confirmInitialSync(context, { config: inputs.state, transforms: [marker, leaveOut], stopAfterDocuments: undefined })).result;
    });
    assert.equal(outcome.ok, true);
    assert.equal(result?.complete, true);
    assert.deepEqual(result?.leftOutAtWrite, [
      { path: 'eng/README.md', rule: 'content-too-long' },
      { path: 'eng/notes/plan.md', rule: 'upload-too-large' },
    ]);
    assert.deepEqual(result?.failed, []);
    const notes = world.linear.documents.find((d) => d.title === 'backend/notes');
    assert.equal(notes?.content, `${SYNCED['eng/backend/notes.md'].body}\n\n(from eng/backend/notes.md)`);
    assert.equal(world.linear.documents.some((d) => d.title === 'plan'), false);
    // Restored, the recorded files equal the tracked ones; the left-out file keeps the tracked version.
    assert.deepEqual(result?.record?.reformatted, []);
    assert.equal(await show('refs/mdbisync/linear:eng/backend/notes.md'), TREE['eng/backend/notes.md']);
    assert.equal((await readIds())['eng/notes/plan.md'], undefined);
    // Before the first write, the transforms knew the id every new document was then created with.
    assert.equal(writesAtPrepare, 0);
    assert.deepEqual([...(preparedIds ?? new Map()).keys()].sort(), SYNCED_PATHS);
    for (const [path, entry] of Object.entries(await readIds())) assert.equal(entry.id, preparedIds?.get(path), path);

    // The left-out new documents keep their ids beside the id map, so links to them do not change from run to run.
    const reserved = JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json')) as Record<string, string>;
    assert.deepEqual(reserved, { 'eng/README.md': preparedIds?.get('eng/README.md'), 'eng/notes/plan.md': preparedIds?.get('eng/notes/plan.md') });
    const firstIds = preparedIds;
    const refsBefore = await refs();
    const writes = world.linear.writes.count;
    await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, fetch: fakeFetch(world) }, async (context) => {
      result = (await confirmInitialSync(context, { config: inputs.state, transforms: [marker, leaveOut], stopAfterDocuments: undefined })).result;
    });
    assert.equal(result?.complete, true);
    assert.deepEqual(preparedIds, firstIds);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote to Linear');
    assert.deepEqual(await refs(), refsBefore);
  });

  it("records Linear's form of a file it reformatted, with the file's front matter, and leaves the tracked branch alone", async () => {
    const world = fakeWorld();
    world.linear.store = (content) => content.replace('# Engineering', '# Engineering team');
    const tracked = (await refs())['refs/heads/main'];
    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.record?.reformattedCount, 1);
    assert.deepEqual(report.initialSync?.reformatted, ['eng/README.md']);
    assert.match(summary, /Linear stores 1 file in a different form/);
    assert.equal(await show('refs/mdbisync/linear:eng/README.md'), `---\nlinear-team: ENG\n---\n\n# Engineering team\n\n${CANARY}`);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/formula.md'), TREE['eng/notes/formula.md']);
    assert.equal((await refs())['refs/heads/main'], tracked);
  });
});
