// The confirmed initial sync from git to Linear through the command line,
// against a local git remote and a fake GitHub and Linear: what it writes,
// what it records, how it resumes and how it recovers.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { environmentName, readInputs } from '../run/inputs.ts';
import { runPreflight } from '../run/preflight.ts';
import { Git, type IdEntry, NEUTRAL_IDENTITY, commitIds, readIds as readIdMap, readWrittenHashes, readWrittenMacs } from '../state/index.ts';
import { observedDigest } from '../sync/recorded.ts';
import { type LinearDocument, LinearClient, LinearResponseLimitError } from '../linear/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch, virtualCheckClock } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { type ConfirmedResult, FINAL_IDS_MESSAGE, PROGRESS_MESSAGE, confirmInitialSync, holdsBody } from './confirm.ts';
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
  'eng/notes/formula.md': `# Formula\n\nWater is wet.[^1] ${CANARY}\n\n[^1]: A note.`,
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

  const run = async (world: FakeWorld, extra: Record<string, string> = {}, wrap: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch = (fetch) => fetch) => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const requestsBefore = world.requests.length;
    const mark = await markWorld(world, fixture);
    const result = await runCli(['initial-sync'], { env: env(extra), cwd, fetch: wrap(fakeFetch(world)), checkClock: virtualCheckClock() });
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.ok(!JSON.stringify(report).includes(CANARY), 'the report holds content');
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: false });
    const graphql = world.requests.slice(requestsBefore).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
    return { result, report, summary, graphql };
  };

  const refs = async () => {
    const text = await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
    return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
  };
  const show = (spec: string) => fixture.remote.text(['show', spec]);
  const readIds = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, IdEntry>;
  const live = (world: FakeWorld) => world.linear.documents.filter((d) => d.trashed !== true && d.archivedAt === undefined);

  it('leaves an over-nested matched document out while initializing valid neighbors', async () => {
    const world = fakeWorld();
    const nested = '> '.repeat(130) + CANARY;
    world.linear.documents.push({id: 'deep', title: 'plan', projectId: 'project-api', content: nested, createdAt: '2026-01-01T00:00:00Z'});
    const {report} = await run(world);
    assert.ok(report.initialSync?.leftOutAtWrite.some((entry) => entry.path === 'eng/notes/plan.md' && entry.rule === 'markdown-complexity'));
    assert.equal(world.linear.documents.find((document) => document.id === 'deep')!.content, nested);
    assert.ok(world.linear.documents.some((document) => document.title === 'backend/notes'));
  });

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

  it('leaves out a file whose reference links would be too large written inline, and initializes the rest', { timeout: 120_000 }, async () => {
    // A few kilobytes of references to one long definition: `fix` would write the destination once per reference.
    const path = 'eng/notes/references.md';
    await fixture.seed({ [path]: `# References\n\n${'[a][r] '.repeat(2_000)}\n\n[r]: https://example.com/${'x'.repeat(1_000)}\n` });
    const world = fakeWorld();
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.summary?.leftOut, ['combined/Guide.md', 'combined/guide.md', 'eng/notes/formula.md', path]);
    assert.ok(report.leftOutRules?.includes('markdown-complexity'), JSON.stringify(report.leftOutRules));
    assert.equal(live(world).length, SYNCED_PATHS.length, 'not every other file was written');
    assert.ok(!live(world).some((d) => d.title === 'notes/references'), 'the left-out file reached Linear');
  });

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

    // This create-only run needs no final rereads and stays within the lower budget.
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
    assert.deepEqual(report.initialSync?.trashed, ['eng/doc-retired.md']);
    assert.match(summary, /^\| eng\/doc-retired\.md \|$/m);
    const archived = world.linear.documents.find((d) => d.id === 'doc-archived');
    assert.equal(archived?.trashed, undefined);
    assert.equal(archived?.content, undefined);
    // A left-out file's document is neither overwritten nor trashed.
    const formula = world.linear.documents.find((d) => d.id === 'doc-formula');
    assert.equal(formula?.content, 'Kept.');
    assert.equal(formula?.trashed, undefined);
  });

  /** Changes the document the next query after the read of every text, as a person can while the run plans. */
  const afterTextRead = (world: FakeWorld, change: () => void) => {
    let read = false;
    world.linear.beforeQuery = (operation) => {
      if (read) {
        delete world.linear.beforeQuery;
        change();
      } else if (operation === 'GetDocuments') read = true;
    };
  };
  /** The only document these runs could overwrite is `doc-plan`; the others are created. */
  const updates = (world: FakeWorld) => world.writes.filter((write) => write === 'UpdateDocument');

  for (const [label, change] of [
    ['moved to another project', (world: FakeWorld) => { world.linear.documents.find((d) => d.id === 'doc-plan')!.projectId = 'project-handbook'; }],
    ['trashed', (world: FakeWorld) => { const d = world.linear.documents.find((d) => d.id === 'doc-plan')!; d.trashed = true; touch(d); }],
    ['edited', (world: FakeWorld) => { const d = world.linear.documents.find((d) => d.id === 'doc-plan')!; d.content = `Edited. ${CANARY}`; touch(d); }],
    ['deleted', (world: FakeWorld) => { world.linear.documents = world.linear.documents.filter((d) => d.id !== 'doc-plan'); }],
  ] as const) it(`leaves out a matched document ${label} between the listing and the read of its text, and its file`, async () => {
    const world = fakeWorld();
    world.linear.documents = [{ id: 'doc-plan', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: `Old text. ${CANARY}` }];
    world.linear.beforeQuery = (operation) => {
      if (operation !== 'GetDocuments') return;
      delete world.linear.beforeQuery;
      change(world);
    };
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(report.summary?.leftOut.includes('eng/notes/plan.md'), JSON.stringify(report.summary?.leftOut));
    assert.ok(report.leftOutRules?.includes('changed-during-run'));
    assert.ok(!report.initialSync?.overwritten.includes('eng/notes/plan.md') && !report.initialSync?.created.includes('eng/notes/plan.md'));
    assert.deepEqual(updates(world), []);
    const plan = world.linear.documents.find((d) => d.id === 'doc-plan');
    if (label === 'deleted') assert.equal(plan, undefined);
    else assert.equal(plan?.content, label === 'edited' ? `Edited. ${CANARY}` : `Old text. ${CANARY}`);
    assert.ok(!live(world).some((d) => d.title === 'plan' && d.id !== 'doc-plan'), 'a second plan document');
    assert.equal((await readIds())['eng/notes/plan.md'], undefined);
    // The other files are written as usual.
    assert.ok(report.initialSync?.created.includes('eng/backend/notes.md'));
  });

  it('trashes no duplicate of a title whose matched document is gone before its write', async () => {
    const world = fakeWorld();
    world.linear.documents = [
      { id: 'doc-plan', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: `Old text. ${CANARY}` },
      { id: 'doc-plan-copy', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:02Z', content: `Copy. ${CANARY}` },
    ];
    afterTextRead(world, () => { world.linear.documents = world.linear.documents.filter((d) => d.id !== 'doc-plan'); });
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(updates(world), []);
    const copy = world.linear.documents.find((d) => d.id === 'doc-plan-copy');
    assert.equal(copy?.trashed, undefined, 'the only document left for the file was trashed');
    assert.deepEqual(report.initialSync?.trashed, []);
    assert.deepEqual(report.initialSync?.leftOutAtWrite.map((entry) => [entry.path, entry.rule]), [['eng/notes/plan.md', 'changed-during-run']]);
  });

  it('neither overwrites nor trashes a document that moves after the plan read it', async () => {
    const world = fakeWorld();
    world.linear.documents = [
      { id: 'doc-plan', title: 'plan', projectId: 'project-api', createdAt: '2026-01-01T00:00:01Z', content: `Old text. ${CANARY}` },
      { id: 'doc-retired', title: 'backend/retired', teamId: 'team-eng', createdAt: '2026-01-01T00:00:02Z', content: `Retired. ${CANARY}` },
    ];
    afterTextRead(world, () => {
      for (const d of world.linear.documents) if (d.id === 'doc-plan' || d.id === 'doc-retired') {
        delete d.teamId;
        d.projectId = 'project-handbook';
      }
    });
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(updates(world), []);
    const plan = world.linear.documents.find((d) => d.id === 'doc-plan');
    assert.equal(plan?.content, `Old text. ${CANARY}`);
    const retired = world.linear.documents.find((d) => d.id === 'doc-retired');
    assert.equal(retired?.trashed, undefined);
    assert.deepEqual(report.initialSync?.trashed, []);
    const leftOut = report.initialSync?.leftOutAtWrite.filter((entry) => entry.rule === 'changed-during-run').map((entry) => entry.path).sort();
    assert.deepEqual(leftOut, ['eng/doc-retired.md', 'eng/notes/plan.md']);
    assert.ok(report.initialSync?.created.includes('eng/backend/notes.md'));
  });

  for (const operation of ['UpdateDocument', 'TrashDocument'] as const) {
    it(`skips a later document moved to another project during the first ${operation}`, async () => {
      const world = fakeWorld();
      const overwrite = operation === 'UpdateDocument';
      const first = { id: 'doc-first', title: overwrite ? 'backend/notes' : 'retired-first', teamId: 'team-eng',
        createdAt: '2026-01-01T00:00:01Z', content: 'First text.' };
      const later = { id: 'doc-later', title: overwrite ? 'plan' : 'retired-later', projectId: 'project-api',
        createdAt: '2026-01-01T00:00:02Z', content: 'Later text.', trashed: false };
      world.linear.documents = [first, later];
      let moved = false;
      world.linear.writes.reject = (name, variables) => {
        if (name === operation && variables.id === first.id) {
          later.projectId = 'project-handbook';
          touch(later);
          moved = true;
        }
        return false;
      };

      const { result, report } = await run(world);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(moved, 'the earlier document reached its write');
      const path = overwrite ? 'eng/notes/plan.md' : 'eng/notes/doc-later.md';
      assert.deepEqual(report.initialSync?.leftOutAtWrite, [{ path, rule: 'changed-during-run' }]);
      assert.equal(later.content, 'Later text.');
      assert.equal(later.trashed, false);
      assert.equal(later.projectId, 'project-handbook');
      assert.equal(world.writes.filter((name) => name === operation).length, 1);
    });
  }

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
    const progressMessage = await fixture.remote.text(['show', '-s', '--format=%B', 'refs/mdbisync/ids']);
    assert.equal(progressMessage.split('\n')[0], PROGRESS_MESSAGE);
    assert.match(progressMessage, /^Direction: git-to-linear$/m);
    // The progress commit holds the written documents' ids and the ids chosen for the ones still to create.
    const progress = await readIds();
    assert.deepEqual(Object.keys(progress).sort(), SYNCED_PATHS);
    for (const path of SYNCED_PATHS.slice(0, 2)) assert.ok(live(world).some((d) => d.id === progress[path]?.id), `${path} is not written`);

    // The sync does not run on a half-written id map.
    const sync = await runCli(['sync'], { env: { ...env(), MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }, cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    assert.equal(sync.exitCode, NO_STATE_EXIT_CODE, sync.stderr);
    assert.match(sync.stdout, /An initial sync stopped before it finished/);

    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    // The resumed run creates the rest with the ids chosen before the stop, so links to them stay right.
    const completed = await readIds();
    assert.deepEqual(Object.keys(completed).sort(), SYNCED_PATHS);
    for (const path of SYNCED_PATHS) {
      assert.equal(completed[path]?.id, progress[path]?.id);
      assert.match(completed[path]?.observedDigest ?? '', /^[0-9a-f]{64}$/);
      if (progress[path]?.observedDigest !== undefined) assert.equal(completed[path]?.observedDigest, progress[path].observedDigest);
    }
    assert.equal(second.report.resumed, true);
    assert.equal(second.report.skippedCompletedCount, 2);
    assert.equal(second.report.writtenCount, SYNCED_PATHS.length - 2);
    assert.equal(await fixture.remote.text(['rev-list', '--count', 'refs/mdbisync/linear', '^refs/heads/main']), '1');
    await assertConverged(world);
  });

  it('a resumed run skips what the stopped run wrote, whatever form Linear stored it in', async () => {
    const world = fakeWorld();
    // A form the format module does not predict, as for some links to attachments.
    world.linear.store = (content) => `${content}\n\nStored.`;
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const written = JSON.parse(await show('refs/mdbisync/ids:written.json')) as Record<string, string>;
    assert.deepEqual(Object.keys(written).sort(), SYNCED_PATHS.slice(0, 2));
    // Each receipt carries the sync's signature: Linear's form alone does not show the document holds the text.
    const macs = JSON.parse(await show('refs/mdbisync/ids:written-macs.json')) as Record<string, string>;
    assert.deepEqual(Object.keys(macs).sort(), SYNCED_PATHS.slice(0, 2));

    delete world.linear.writes.rateLimitAt;
    const writes = world.linear.writes.count;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.skippedCompletedCount, 2);
    assert.equal(world.linear.writes.count - writes, SYNCED_PATHS.length - 2);
    // The finished state keeps no progress files.
    assert.equal((await fixture.remote.run(['cat-file', '-e', 'refs/mdbisync/ids:written.json'], { okCodes: [0, 128] })).code, 128);
    assert.equal((await fixture.remote.run(['cat-file', '-e', 'refs/mdbisync/ids:written-macs.json'], { okCodes: [0, 128] })).code, 128);
  });

  it('a resumed run writes again a document a member edited since the stop, so the edit is never recorded unchecked', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const [edited, untouched] = SYNCED_PATHS as [string, string];
    const progress = await readIds();
    const document = world.linear.documents.find((d) => d.id === progress[edited]?.id);
    assert.ok(document !== undefined, `${edited} was not written by the first run`);
    const added = 'unchecked-edit-5f1c08';
    document.content = `${document.content ?? ''}\n\n${added}`;
    touch(document);

    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.resumed, true);
    assert.ok(report.initialSync?.overwritten.includes(edited), `${edited} was skipped with its edit`);
    assert.deepEqual(report.initialSync?.skippedCompleted, [untouched]);
    assert.equal(report.record?.reformattedCount, 0);
    await assertConverged(world);

    // Neither the record nor any other pushed ref holds the edit, and the next sync proposes nothing.
    const holding = async () => {
      const all = Object.keys(await refs());
      const found = await fixture.remote.run(['grep', '-l', '-F', added, ...all], { okCodes: [0, 1] });
      return found.stdout.toString().trim();
    };
    assert.equal(await holding(), '');
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^{tree}']), await fixture.remote.text(['rev-parse', 'refs/heads/main^{tree}']));
    const sync = await runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    assert.equal(sync.exitCode, 0, sync.stderr);
    assert.deepEqual(world.github.pullRequests.filter((pr) => pr.head !== 'mdbisync/format-problems'), [], 'a sync pull request was opened');
    assert.equal(await holding(), '');
  });

  it('a resumed run does not trust a write receipt the sync did not sign, so a forged one never records a body unchecked', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const [forged, untouched] = SYNCED_PATHS as [string, string];
    // The stopped run signed the receipts of what it wrote.
    const git = fixture.remote;
    const tip = await git.revParse('refs/mdbisync/ids');
    assert.deepEqual([...(await readWrittenMacs(git, tip)).keys()].sort(), [forged, untouched]);

    // Someone who may push the state and edit the document puts another body in it and rewrites the progress
    // commit so its receipt matches the document as it is now: same text hash, the new observed digest, the old signatures.
    const ids = await readIdMap(git, tip);
    const document = world.linear.documents.find((d) => d.id === ids.get(forged)?.id);
    assert.ok(document !== undefined, `${forged} was not written by the first run`);
    const added = 'forged-body-7d2e41';
    document.content = `# Handbook\n\n${added}`;
    touch(document);
    ids.set(forged, { ...(ids.get(forged) as IdEntry), observedDigest: observedDigest({ ...document, updatedAt: document.updatedAt ?? document.createdAt } as unknown as LinearDocument) });
    const forgedTip = await commitIds(git, tip, ids, NEUTRAL_IDENTITY, {
      message: await git.text(['show', '-s', '--format=%B', tip]),
      always: true,
      written: await readWrittenHashes(git, tip),
      writtenMacs: await readWrittenMacs(git, tip),
    });
    await git.run(['update-ref', 'refs/mdbisync/ids', forgedTip, tip]);

    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.resumed, true);
    assert.ok(report.initialSync?.overwritten.includes(forged), `${forged} was trusted on the forged receipt`);
    assert.deepEqual(report.initialSync?.skippedCompleted, [untouched]);
    assert.equal(document.content, SYNCED[forged as keyof typeof SYNCED].body);
    await assertConverged(world);
    // No pushed ref holds the forged body: it was neither recorded nor signed.
    const all = Object.keys(await refs());
    assert.equal((await fixture.remote.run(['grep', '-l', '-F', added, ...all], { okCodes: [0, 1] })).stdout.toString().trim(), '');
  });

  it('a resume from progress without signatures or a direction writes again what it cannot compare', async () => {
    const world = fakeWorld();
    // A form the format module does not predict: the document cannot show it holds the file's text.
    world.linear.store = (content) => `${content}\n\nStored.`;
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const git = fixture.remote;
    const tip = await git.revParse('refs/mdbisync/ids');
    const unsigned = await commitIds(git, tip, await readIdMap(git, tip), NEUTRAL_IDENTITY, {
      message: (await git.text(['show', '-s', '--format=%B', tip])).replace(/^Direction: git-to-linear\n?/m, ''),
      always: true,
      written: await readWrittenHashes(git, tip),
    });
    assert.deepEqual(await readWrittenMacs(git, unsigned), new Map());
    await git.run(['update-ref', 'refs/mdbisync/ids', unsigned, tip]);

    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.resumed, true);
    assert.deepEqual(report.initialSync?.skippedCompleted, []);
    for (const path of SYNCED_PATHS.slice(0, 2)) assert.ok(report.initialSync?.overwritten.includes(path), `${path} was skipped on an unsigned receipt`);
  });

  it('a document found holding a newer text drops the stopped write, so a file that goes back to the written text is written again', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 3;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const [first] = SYNCED_PATHS as [string];
    const original = TREE[first] as string;
    const revised = `# Handbook\n\nRevised. ${CANARY}`;
    const firstId = (await readIds())[first]?.id;
    const document = world.linear.documents.find((d) => d.id === firstId);
    assert.ok(document !== undefined, `${first} was not written by the first run`);
    // Git and Linear both move to the same new text; the next run finds the document holding it and stops again.
    await fixture.seed({ [first]: `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n${revised}` });
    document.content = revised;
    touch(document);
    world.linear.writes.rateLimitAt = world.linear.writes.count + 2;
    const second = await run(world);
    assert.equal(second.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.ok(second.report.initialSync?.unchanged.includes(first), `${first} was not found holding its text`);

    // The file goes back to the text the first run wrote: Linear still holds the newer one, so it is written again.
    await fixture.seed({ [first]: original });
    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(report.initialSync?.overwritten.includes(first), `${first} was skipped holding the newer text`);
    assert.equal(report.record?.reformattedCount, 0);
    assert.equal(document.content, SYNCED[first as keyof typeof SYNCED].body);
    await assertConverged(world);
  });

  it('a run that stops while only trashing still marks the initial sync unfinished, so the sync waits', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    world.linear.documents.push({ id: 'doc-extra', title: 'extra', projectId: 'project-api', createdAt: '2026-01-03T00:00:00Z', content: 'Extra.' });
    world.linear.writes.rateLimitAt = world.linear.writes.count + 1;

    const { result, report } = await run(world);
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(report.writtenCount, 0);
    assert.equal(report.stoppedEarly, true);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/ids']), PROGRESS_MESSAGE);
    const sync = await runCli(['sync'], { env: { ...env(), MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }, cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    assert.equal(sync.exitCode, NO_STATE_EXIT_CODE, sync.stderr);
  });

  const changesSinceStop: { name: string; change: (document: FakeWorld['linear']['documents'][number]) => void }[] = [
    { name: 'renamed', change: (document) => { document.title = 'Renamed in Linear'; } },
    { name: 'moved out of the synchronized places', change: (document) => { document.teamId = 'team-docs'; } },
    { name: 'trashed', change: (document) => { document.trashed = true; document.archivedAt = new Date().toISOString(); } },
  ];
  for (const { name, change } of changesSinceStop) {
    it(`a resumed run keeps a document the stopped run created and a person ${name} since; the first sync takes the change in`, async () => {
      const world = fakeWorld();
      world.linear.writes.rateLimitAt = 4;
      assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
      const path = 'eng/backend/notes.md';
      const id = (await readIds())[path]?.id as string;
      const document = world.linear.documents.find((d) => d.id === id);
      assert.ok(document !== undefined && document.content === SYNCED[path].body, `${path} was not written by the first run`);
      change(document);
      touch(document);
      const changed = structuredClone(document);

      delete world.linear.writes.rateLimitAt;
      const { result, report } = await run(world);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(report.resumed, true);
      assert.ok(report.initialSync?.skippedCompleted.includes(path), JSON.stringify(report.initialSync));
      assert.ok(!report.initialSync?.created.includes(path) && !report.initialSync?.trashed.some((trashed) => trashed.includes(id)));
      assert.deepEqual(report.initialSync?.leftOutAtWrite, []);
      // One document holds the file's text, left as the person changed it.
      assert.deepEqual(world.linear.documents.filter((d) => d.content === SYNCED[path].body).map((d) => d.id), [id]);
      assert.deepEqual(world.linear.documents.find((d) => d.id === id), changed);
      assert.equal((await readIds())[path]?.id, id);

      const sync = await runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
      assert.equal(sync.exitCode, 0, sync.stderr);
      assert.deepEqual(world.linear.documents.filter((d) => d.content === SYNCED[path].body).map((d) => d.id), [id]);
      assert.deepEqual(world.linear.documents.find((d) => d.id === id), changed);
      assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/mdbisync/linear:${path}`], { okCodes: [0, 128] })).code, 128);
      // A renamed document's file follows it; a moved or trashed one leaves the synchronized files.
      const at = Object.entries(await readIds()).filter(([, entry]) => entry.id === id).map(([mapped]) => mapped);
      assert.deepEqual(at, name === 'renamed' ? ['eng/Renamed in Linear.md'] : []);
    });
  }

  for (const edit of ['edited in Linear', 'changed in git'] as const) {
    it(`a resumed run leaves out a document the stopped run created that a person renamed since and that was ${edit}; the first sync keeps one document`, async () => {
      const world = fakeWorld();
      world.linear.writes.rateLimitAt = 4;
      assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
      const path = 'eng/backend/notes.md';
      const id = (await readIds())[path]?.id as string;
      const document = world.linear.documents.find((d) => d.id === id);
      assert.ok(document !== undefined);
      document.title = 'Renamed in Linear';
      if (edit === 'edited in Linear') document.content = `${document.content ?? ''}\n\nTyped in Linear.`;
      else await fixture.seed({ [path]: `# Notes\n\nRevised. ${CANARY}` });
      touch(document);
      const changed = structuredClone(document);

      delete world.linear.writes.rateLimitAt;
      const { result, report } = await run(world);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(report.initialSync?.leftOutAtWrite, [{ path, rule: 'changed-during-run' }]);
      assert.deepEqual(report.initialSync?.trashed, []);
      assert.ok(!report.initialSync?.created.includes(path));
      // Neither overwritten, trashed nor duplicated; its id stays reserved for the path.
      assert.deepEqual(world.linear.documents.find((d) => d.id === id), changed);
      assert.equal(world.linear.documents.filter((d) => d.title === 'backend/notes').length, 0);
      assert.equal((await readIds())[path], undefined);
      assert.equal((JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json')) as Record<string, string>)[path], id);

      // The sync takes the document in at its new title as Linear holds it, and creates no document for the file,
      // on the first run or the next.
      for (let syncs = 0; syncs < 2; syncs += 1) {
        const sync = await runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
        assert.equal(sync.exitCode, 0, sync.stderr);
      }
      assert.deepEqual(world.linear.documents.filter((d) => d.content?.includes('# Notes') === true).map((d) => d.id), [id]);
      assert.deepEqual(world.linear.documents.find((d) => d.id === id), changed);
      const at = Object.entries(await readIds()).filter(([, entry]) => entry.id === id).map(([mapped]) => mapped);
      assert.deepEqual(at, ['eng/Renamed in Linear.md']);
    });
  }

  it('a resumed run that Linear rate limits while it reads the stopped run\'s documents stops and runs again', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 4;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const path = 'eng/backend/notes.md';
    const id = (await readIds())[path]?.id as string;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined);
    document.trashed = true;
    touch(document);
    delete world.linear.writes.rateLimitAt;

    let limited = false;
    const wrap = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
      const request = String(input) === `${LINEAR_API}/graphql` ? JSON.parse(String(init?.body)) as { operationName?: string; variables?: { ids?: string[] } } : undefined;
      if (!limited && request?.operationName === 'GetDocuments' && request.variables?.ids?.includes(id) === true) {
        limited = true;
        return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return fetch(input, init);
    };
    const stopped = await run(world, {}, wrap);
    assert.ok(limited, 'the fault never fired');
    assert.equal(stopped.result.exitCode, INCOMPLETE_EXIT_CODE, stopped.result.stderr);
    assert.equal(stopped.report.code, 'stopped');

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(report.initialSync?.skippedCompleted.includes(path));
    assert.deepEqual(world.linear.documents.filter((d) => d.content?.includes('# Notes') === true).map((d) => d.id), [id]);
  });

  it('a resumed run does not keep a document the stopped run created that a person gave another file\'s title: it is that title\'s newer duplicate', async () => {
    const world = fakeWorld();
    world.linear.writes.rateLimitAt = 4;
    assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    const path = 'eng/backend/notes.md';
    const id = (await readIds())[path]?.id as string;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined);
    document.title = 'README';
    touch(document);

    delete world.linear.writes.rateLimitAt;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(report.initialSync?.trashed.includes('eng/README.md'), JSON.stringify(report.initialSync));
    assert.ok(report.initialSync?.created.includes(path));
    assert.notEqual((await readIds())[path]?.id, id);
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

  for (const applied of [false, true]) {
    it(`L1-08: a create whose connection drops ${applied ? 'after' : 'before'} Linear applies it is completed in the same run, once`, async () => {
      const world = fakeWorld();
      let dropped: string | undefined;
      // The first CreateDocument for one file loses its connection; every other request is answered.
      const wrap = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
        const request = String(input) === `${LINEAR_API}/graphql` ? JSON.parse(String(init?.body)) as { operationName?: string; variables?: { input?: { id?: string; title?: string } } } : undefined;
        if (dropped === undefined && request?.operationName === 'CreateDocument' && request.variables?.input?.title === 'backend/notes') {
          dropped = request.variables.input.id;
          if (applied) await fetch(input, init);
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
        }
        return fetch(input, init);
      };
      const { result, report } = await run(world, {}, wrap);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(dropped !== undefined, 'the fault never fired');
      assert.deepEqual(report.initialSync?.failed, []);
      assert.deepEqual(report.initialSync?.created, SYNCED_PATHS);
      assert.equal((await readIds())['eng/backend/notes.md']?.id, dropped, 'the document keeps the id of the lost create');
      assert.equal(report.writes.linear['CreateDocument'], SYNCED_PATHS.length);
      await assertConverged(world);
    });
  }

  /** A fetch wrapper: the first CreateDocument of `backend/notes` is applied, its answer is lost, and a person edits the new document before the client reads it back. */
  const editedLostCreate = (world: FakeWorld) => {
    const fault = { dropped: undefined as string | undefined, wrap: (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
      const request = String(input) === `${LINEAR_API}/graphql` ? JSON.parse(String(init?.body)) as { operationName?: string; variables?: { input?: { id?: string; title?: string } } } : undefined;
      if (fault.dropped === undefined && request?.operationName === 'CreateDocument' && request.variables?.input?.title === 'backend/notes') {
        fault.dropped = request.variables.input.id;
        await fetch(input, init);
        const document = world.linear.documents.find((d) => d.id === fault.dropped);
        assert.ok(document !== undefined);
        document.content = `${document.content ?? ''}\n\nTyped in Linear.`;
        touch(document);
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return fetch(input, init);
    } };
    return fault;
  };

  it('a resumed run leaves out a document the stopped run created and found edited, and does not overwrite it', async () => {
    const world = fakeWorld();
    const path = 'eng/backend/notes.md';
    const fault = editedLostCreate(world);
    // The write after the edited create is rate limited: the run stops before it records anything final.
    world.linear.writes.rateLimitAt = 4;
    const first = await run(world, {}, fault.wrap);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.equal(first.report.code, 'stopped');
    assert.ok(fault.dropped !== undefined, 'the fault never fired');
    assert.deepEqual(first.report.initialSync?.leftOutAtWrite, [{ path, rule: 'changed-during-run' }]);

    delete world.linear.writes.rateLimitAt;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(second.report.resumed, true);
    assert.deepEqual(second.report.initialSync?.leftOutAtWrite, [{ path, rule: 'changed-during-run' }]);
    assert.ok(!second.report.initialSync?.overwritten.includes(path));
    assert.match(world.linear.documents.find((d) => d.id === fault.dropped)?.content ?? '', /Typed in Linear\./, 'the edit was overwritten');
    assert.equal(world.linear.documents.filter((d) => d.title === 'backend/notes' && d.trashed !== true).length, 1);
    assert.equal((await readIds())[path], undefined);
    // Its id stays reserved for the path, as when the run had not stopped: links written to it stay right.
    assert.equal((JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json')) as Record<string, string>)[path], fault.dropped);
  });

  it('a create whose lost answer is read back after a person edited the document is not recorded as written', async () => {
    const world = fakeWorld();
    const path = 'eng/backend/notes.md';
    const fault = editedLostCreate(world);
    const { result, report } = await run(world, {}, fault.wrap);
    const { dropped } = fault;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(dropped !== undefined, 'the fault never fired');
    assert.deepEqual(report.initialSync?.failed, []);
    assert.deepEqual(report.initialSync?.created, SYNCED_PATHS.filter((synced) => synced !== path));
    assert.deepEqual(report.initialSync?.leftOutAtWrite, [{ path, rule: 'changed-during-run' }]);
    // Created once and not sent again; the person's text stays in Linear.
    assert.equal(world.linear.documents.filter((d) => d.title === 'backend/notes').length, 1);
    assert.match(world.linear.documents.find((d) => d.id === dropped)?.content ?? '', /Typed in Linear\./);
    // Not recorded as this run's write: the path has no id, and the id stays reserved for it.
    assert.equal((await readIds())[path], undefined);
    assert.equal((JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json')) as Record<string, string>)[path], dropped);

    // The first sync takes the document in as a change made in Linear, with the person's text: git's file at the
    // path is not the document's, so it comes in at a path of its own. Linear keeps one document.
    const sync = await runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    assert.equal(sync.exitCode, 0, sync.stderr);
    const taken = Object.entries(await readIds()).find(([, entry]) => entry.id === dropped);
    assert.ok(taken !== undefined && taken[0] !== path, JSON.stringify(taken));
    assert.match(await show(`refs/mdbisync/linear:${taken[0]}`), /Typed in Linear\./);
    assert.equal(world.linear.documents.filter((d) => d.title === 'backend/notes').length, 1);
  });

  /** A fetch wrapper: the first CreateDocument of `backend/notes` is applied, its answer is lost, and `change` runs on the new document before the client reads it back. */
  const changedLostCreate = (world: FakeWorld, change: (document: FakeWorld['linear']['documents'][number]) => void) => {
    const fault = { dropped: undefined as string | undefined, wrap: (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
      const request = String(input) === `${LINEAR_API}/graphql` ? JSON.parse(String(init?.body)) as { operationName?: string; variables?: { input?: { id?: string; title?: string } } } : undefined;
      if (fault.dropped === undefined && request?.operationName === 'CreateDocument' && request.variables?.input?.title === 'backend/notes') {
        fault.dropped = request.variables.input.id;
        await fetch(input, init);
        const document = world.linear.documents.find((d) => d.id === fault.dropped);
        assert.ok(document !== undefined);
        change(document);
        touch(document);
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return fetch(input, init);
    } };
    return fault;
  };

  const changesBeforeRead: { name: string; change: Parameters<typeof changedLostCreate>[1] }[] = [
    { name: 'renamed', change: (document) => { document.title = 'Renamed in Linear'; } },
    { name: 'moved out of the synchronized places', change: (document) => { document.teamId = 'team-docs'; } },
    { name: 'trashed', change: (document) => { document.trashed = true; document.archivedAt = new Date().toISOString(); } },
  ];
  for (const { name, change } of changesBeforeRead) {
    it(`a create whose lost answer is read back after a person ${name} the document is the file's; the first sync takes the change in`, async () => {
      const world = fakeWorld();
      const path = 'eng/backend/notes.md';
      const fault = changedLostCreate(world, change);
      const { result, report } = await run(world, {}, fault.wrap);
      const { dropped } = fault;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(dropped !== undefined, 'the fault never fired');
      assert.deepEqual(report.initialSync?.failed, []);
      assert.deepEqual(report.initialSync?.leftOutAtWrite, []);
      assert.deepEqual(report.initialSync?.created, SYNCED_PATHS);
      assert.equal((await readIds())[path]?.id, dropped);
      const before = structuredClone(world.linear.documents.find((d) => d.id === dropped));

      const sync = await runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
      assert.equal(sync.exitCode, 0, sync.stderr);
      // One document, left as the person changed it; Linear's side no longer holds the file at its first path.
      assert.deepEqual(world.linear.documents.filter((d) => d.content?.includes('# Notes') === true).map((d) => d.id), [dropped]);
      assert.deepEqual(world.linear.documents.find((d) => d.id === dropped), before);
      assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/mdbisync/linear:${path}`], { okCodes: [0, 128] })).code, 128);
      // A renamed document's file follows it; a moved or trashed one leaves the synchronized files.
      const at = Object.entries(await readIds()).filter(([, entry]) => entry.id === dropped).map(([mapped]) => mapped);
      assert.deepEqual(at, name === 'renamed' ? ['eng/Renamed in Linear.md'] : []);
    });
  }

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
    const outcome = await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, log: () => undefined, fetch: fakeFetch(world) }, async (context) => {
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
    await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, log: () => undefined, fetch: fakeFetch(world) }, async (context) => {
      result = (await confirmInitialSync(context, { config: inputs.state, transforms: [marker, leaveOut], stopAfterDocuments: undefined })).result;
    });
    assert.equal(result?.complete, true);
    assert.deepEqual(preparedIds, firstIds);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote to Linear');
    assert.deepEqual(await refs(), refsBefore);
  });

  it('stops before any write when the bodies of the documents already in Linear are over the body budget', async () => {
    const world = fakeWorld();
    for (let i = 0; i < 3; i += 1) world.linear.documents.push({ id: `old-${i}`, title: `Old ${i}`, projectId: 'project-api', content: 'x'.repeat(20_000), createdAt: '2026-01-01T00:00:00Z' });
    const values = env();
    const inputs = readInputs((name) => values[environmentName(name) as keyof typeof values] ?? '');
    const before = await refs();
    const writes = world.linear.writes.count;
    let refused: unknown;
    await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, log: () => undefined, fetch: fakeFetch(world) }, async (context) => {
      const linear = new LinearClient({ token: 'test', baseUrl: LINEAR_API, fetch: fakeFetch(world), limits: { bodyBytes: 30_000 } });
      refused = await confirmInitialSync({ ...context, linear }, { config: inputs.state }).then(() => undefined, (error: unknown) => error);
    });
    assert.ok(refused instanceof LinearResponseLimitError, String(refused));
    assert.equal(refused.code, 'linear-body-budget');
    assert.match(refused.message, /30000-byte budget/);
    assert.equal(world.linear.writes.count, writes);
    assert.deepEqual(await refs(), before);
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

  it('records the file as it is when Linear stores it in a form past the Markdown limits, and records the rest', async () => {
    const world = fakeWorld();
    // A chain of tables `fix` cannot end within its budget: putting Linear's form into the file's form would stop.
    world.linear.store = (content) => (content.startsWith('# Engineering') ? `${content}\n\n${'| A |\n| -- |\ntext\n'.repeat(2_000)}` : content);
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.initialSync?.reformatted, []);
    assert.equal(await show('refs/mdbisync/linear:eng/README.md'), TREE['eng/README.md']);
    const ids = await readIds();
    assert.deepEqual(Object.keys(ids).sort(), SYNCED_PATHS);
    assert.match(ids['eng/README.md']?.observedMac ?? '', /^[0-9a-f]{64}$/);
    const sync = () => runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    // Until someone edits it, the sync leaves it alone: nothing written, recorded or left out.
    const writes = world.linear.writes.count;
    const linear = (await refs())['refs/mdbisync/linear'];
    const quiet = await sync();
    assert.equal(quiet.exitCode, 0, quiet.stderr);
    const quietReport = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.deepEqual(quietReport.capture?.leftOut, []);
    assert.equal(world.linear.writes.count, writes);
    assert.equal((await refs())['refs/mdbisync/linear'], linear);
    // An edit in Linear since: the capture leaves the one document out.
    const document = world.linear.documents.find((d) => d.id === ids['eng/README.md']?.id)!;
    document.content = `${document.content}\nEdited.\n`;
    touch(document);
    const edited = await sync();
    assert.equal(edited.exitCode, 0, edited.stderr);
    const next = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.deepEqual(next.capture?.leftOut, [{ id: ids['eng/README.md']?.id, rule: 'markdown-complexity' }]);
    assert.equal(await show('refs/mdbisync/linear:eng/README.md'), TREE['eng/README.md']);
  });

  describe("Linear's own spelling of the same document", () => {
    // Shapes Linear was seen to return for documents a confirmed initial sync
    // wrote from a lint-clean corpus: a final newline the file does not have,
    // and a backslash before a `-` that opens a table cell.
    const TABLE = `# Readings\n\n| Day | Change |\n| -- | -- |\n| Monday | -6 |\n| Tuesday | +2 |\n\n${CANARY}`;
    const respell = (content: string) => `${content.replace(/\| -(?=\d)/g, '| \\-')}\n`;
    let world: FakeWorld;
    const sync = () => runCli(['sync'], { env: env({ MDBISYNC_DIRECTION: '', MDBISYNC_CONFIRM: '' }), cwd, fetch: fakeFetch(world), checkClock: virtualCheckClock() });
    const document = async (path: string) => {
      const ids = await readIds();
      return world.linear.documents.find((d) => d.id === ids[path]?.id) as FakeWorld['linear']['documents'][number];
    };
    const respellAll = () => {
      for (const each of live(world)) {
        each.content = respell(each.content ?? '');
        touch(each);
      }
    };

    beforeEach(async () => {
      await fixture.seed({ 'eng/notes/readings.md': TABLE });
      world = fakeWorld();
    });

    /** No sync pull request, no write to Linear, and `linear` still holds the tracked files. */
    const assertQuiet = async () => {
      const writes = world.linear.writes.count;
      const result = await sync();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(world.github.pullRequests.filter((pr) => pr.head !== 'mdbisync/format-problems'), [], 'a sync pull request was opened');
      assert.equal(world.linear.writes.count, writes, 'the sync wrote to Linear');
      assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^{tree}']), await fixture.remote.text(['rev-parse', 'refs/heads/main^{tree}']));
    };

    it('stored so at the write: the record keeps the files and the first sync opens no pull request', async () => {
      world.linear.store = respell;
      const { result, report } = await run(world);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal((await document('eng/notes/readings.md')).content, respell(TABLE));
      assert.deepEqual(report.initialSync?.reformatted ?? [], []);
      await assertQuiet();
      await assertQuiet();
    });

    it('spelled so later: the sync captures nothing, while a real edit is still captured', async () => {
      assert.equal((await run(world)).result.exitCode, 0);
      respellAll();
      await assertQuiet();

      const readings = await document('eng/notes/readings.md');
      readings.content = (readings.content ?? '').replace('| Tuesday | +2 |', '| Tuesday | +3 |');
      touch(readings);
      const edited = await sync();
      assert.equal(edited.exitCode, 0, edited.stderr);
      assert.equal(world.github.pullRequests.filter((pr) => pr.head !== 'mdbisync/format-problems').length, 1, 'the edit opened no sync pull request');
      const changed = await fixture.remote.text(['diff', '--name-only', 'refs/heads/main', 'refs/mdbisync/linear']);
      assert.equal(changed.trim(), 'eng/notes/readings.md');
    });

    it('a file changed in git is written although Linear holds its earlier version in its own spelling', async () => {
      assert.equal((await run(world)).result.exitCode, 0);
      respellAll();
      await fixture.seed({ 'eng/notes/readings.md': TABLE.replace('| Tuesday | +2 |', '| Tuesday | +4 |') });
      const synced = await sync();
      assert.equal(synced.exitCode, 0, synced.stderr);
      assert.match((await document('eng/notes/readings.md')).content ?? '', /\| Tuesday \| \+4 \|/);
      await assertQuiet();
    });
  });
});

describe('holdsBody', () => {
  it('matches a shortcode in the file with its emoji in Linear only where Linear converts it', () => {
    assert.ok(holdsBody('Due \u{1F5D3}\u{FE0F} soon', 'Due :spiral_calendar_pad: soon\n'));
    assert.ok(holdsBody('[\u{1F5D3}\u{FE0F} plan](<https://example.com/a>)', '[:spiral_calendar_pad: plan](<https://example.com/a>)\n'));
    assert.ok(holdsBody('Flag \u{1F1E6}\u{1F1F1}', 'Flag :flag-al:\n'));
    // Linear keeps a GitHub-only name as text, so its emoji is another document.
    assert.ok(!holdsBody('Trip \u{1F1E6}\u{1F1F1}', 'Trip :albania:\n'));
  });
});
