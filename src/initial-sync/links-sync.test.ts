// Links between synchronized documents through a confirmed initial sync,
// against a local git remote and a fake GitHub and Linear.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { fixText } from '../format/index.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { environmentName, readInputs } from '../run/inputs.ts';
import { runPreflight } from '../run/preflight.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { Git } from '../state/index.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { type ConfirmedResult, confirmInitialSync } from './confirm.ts';
import { documentLinks } from './links.ts';
import { type BodyTransform, LeaveOutError } from './transform.ts';

const CANARY = 'kx-7d1e0b52';
const BASE = 'https://linear.app/example-team/document';

const TREE: Record<string, string> = {
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}`,
  'eng/backend/notes.md': `# Notes\n\nFollow [the plan](<../notes/plan.md>). ${CANARY}`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}`,
  'eng/notes/guide.md': `# Guide\n\n## Setup\n\nBack to [the plan](plan.md). ${CANARY}`,
  'eng/notes/plan.md': `# Plan\n\nRead [the guide](<guide.md#setup>), [the overview](<../../overview.md>) and [the site](<https://example.com>). ${CANARY}`,
  // Above every annotation: not synchronized, so links to it stay as written.
  'overview.md': `# Overview\n\n${CANARY}`,
  '.pre-commit-config.yaml': `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`,
};
const SYNCED_PATHS = ['eng/README.md', 'eng/backend/notes.md', 'eng/notes/README.md', 'eng/notes/guide.md', 'eng/notes/plan.md'];

describe('links between synchronized documents in a confirmed initial sync', () => {
  let fixture: Fixture;
  let cwd: string;
  const reportFile = () => join(fixture.root, 'report.json');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('work')).dir;
  });
  afterEach(() => fixture.cleanup());

  const run = async (world: FakeWorld, extra: Record<string, string> = {}) => {
    await rm(reportFile(), { force: true });
    const requestsBefore = world.requests.length;
    const env = {
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
      GITHUB_STEP_SUMMARY: join(fixture.root, 'summary.md'),
      ...extra,
    };
    const result = await runCli(['initial-sync'], { env, cwd, fetch: fakeFetch(world) });
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    const graphql = world.requests.slice(requestsBefore).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
    return { result, report, graphql };
  };

  const show = (spec: string) => fixture.remote.text(['show', spec]);
  const readIds = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const content = (world: FakeWorld, id: string | undefined) => world.linear.documents.find((d) => d.id === id)?.content;

  /** Each document holds its file's body with links to documents as their URLs; `linear` equals the tracked tree. */
  const assertLinked = async (world: FakeWorld) => {
    const ids = await readIds();
    assert.deepEqual(Object.keys(ids).sort(), SYNCED_PATHS);
    const id = (path: string) => ids[path]?.id as string;
    assert.equal(content(world, id('eng/notes/plan.md')), `# Plan\n\nRead [the guide](<${BASE}/${id('eng/notes/guide.md')}#setup>), [the overview](<../../overview.md>) and [the site](<https://example.com>). ${CANARY}`);
    assert.equal(content(world, id('eng/notes/guide.md')), `# Guide\n\n## Setup\n\nBack to [the plan](<${BASE}/${id('eng/notes/plan.md')}>). ${CANARY}`);
    assert.equal(content(world, id('eng/backend/notes.md')), `# Notes\n\nFollow [the plan](<${BASE}/${id('eng/notes/plan.md')}>). ${CANARY}`);
    const tracked = await fixture.remote.text(['rev-parse', 'refs/heads/main^{tree}']);
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^{tree}']), tracked, 'the recorded files differ from the tracked ones');
    assert.equal(await show('refs/mdbisync/linear:eng/notes/guide.md'), TREE['eng/notes/guide.md']);
  };

  it('L1-12: writes links to documents, also ones created later in the run, as their URLs and records the files as they were', async () => {
    const world = fakeWorld();
    const { result, report, graphql } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    await assertLinked(world);
    assert.equal(report.record?.reformattedCount, 0);
    // I9: one request for the workspace's URL key stays within the run's allowance.
    assert.ok(graphql <= 1.5 * SYNCED_PATHS.length + 5, `${graphql} requests`);

    // I6: nothing to write on the next run.
    const writes = world.linear.writes.count;
    const again = await run(world);
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.equal(world.linear.writes.count, writes);
    assert.deepEqual(again.report.initialSync?.unchanged, SYNCED_PATHS);
  });

  it("L1-18 with links: files not in Linear's form, stored in Linear's form, are not written again", async () => {
    const world = fakeWorld();
    // Like Linear: the stored text is the sent text in Linear's form (references inline, destinations in brackets).
    world.linear.store = (stored) => fixText(stored);
    await fixture.seed({ 'eng/notes/refs.md': `# Refs\n\nSee [the plan][p], [again][p] and [the guide](./guide.md#setup).\n\n[p]: plan.md\n\n${CANARY}` });
    const first = await run(world);
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    const ids = await readIds();
    const refs = content(world, ids['eng/notes/refs.md']?.id);
    const plan = `<${BASE}/${ids['eng/notes/plan.md']?.id}>`;
    assert.equal(refs, `# Refs\n\nSee [the plan](${plan}), [again](${plan}) and [the guide](<${BASE}/${ids['eng/notes/guide.md']?.id}#setup>).\n\n${CANARY}`);
    // The record holds Linear's form of each file, links included.
    assert.equal(await show('refs/mdbisync/linear:eng/notes/refs.md'), fixText(`# Refs\n\nSee [the plan][p], [again][p] and [the guide](./guide.md#setup).\n\n[p]: plan.md\n\n${CANARY}`));

    const writes = world.linear.writes.count;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote again');
  });

  it('a rate limit on the workspace URL key stops the run like a write; the next run finishes', async () => {
    const world = fakeWorld();
    const fake = fakeFetch(world);
    let limited = 0;
    const limitKey: typeof fetch = async (input, init) => {
      if (String(init?.body ?? '').includes('"operationName":"WorkspaceUrlKey"') && limited === 0) {
        limited += 1;
        world.requests.push(`POST ${String(input)}`);
        return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }), { status: 429 });
      }
      return fake(input, init);
    };
    await rm(reportFile(), { force: true });
    const env = {
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
      GITHUB_STEP_SUMMARY: join(fixture.root, 'summary.md'),
    };
    const first = await runCli(['initial-sync'], { env, cwd, fetch: limitKey });
    assert.equal(limited, 1);
    assert.equal(first.exitCode, INCOMPLETE_EXIT_CODE, first.stderr);
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.equal(report.code, 'stopped');
    // The document before the first link was written; nothing after the stop.
    assert.deepEqual(report.initialSync?.created, ['eng/README.md']);

    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    await assertLinked(world);
  });

  it('a document left out while writing keeps its id, so a run after it writes nothing to the documents linking it', async () => {
    const world = fakeWorld();
    const values: Record<string, string> = {
      MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
      MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
      MDBISYNC_LINEAR_API_URL: LINEAR_API,
      MDBISYNC_GITHUB_TOKEN: 'gh-token',
      MDBISYNC_GITHUB_API_URL: GITHUB_API,
      MDBISYNC_REPOSITORY: 'owner/repo',
      MDBISYNC_DIRECTION: 'git-to-linear',
      MDBISYNC_CONFIRM: 'true',
    };
    const inputs = readInputs((name) => values[environmentName(name)] ?? '');
    const leaveOutPlan: BodyTransform = {
      name: 'leave-out',
      apply: async ({ path, body }) => {
        if (path === 'eng/notes/plan.md') throw new LeaveOutError('upload-too-large', 'an embedded file is over the upload limit');
        return body;
      },
      restore: ({ body }) => body,
    };
    const confirm = async () => {
      let result: ConfirmedResult | undefined;
      const outcome = await runPreflight('initial-sync', inputs, { git: new Git(cwd), warn: () => undefined, log: () => undefined, fetch: fakeFetch(world) }, async (context) => {
        result = (await confirmInitialSync(context, { config: inputs.state, transforms: [leaveOutPlan, documentLinks()], stopAfterDocuments: undefined })).result;
      });
      assert.equal(outcome.ok, true);
      return result as ConfirmedResult;
    };
    const linkedFromGuide = () => /document\/([^>#]+)>/.exec(world.linear.documents.find((d) => d.title === 'guide')?.content ?? '')?.[1];

    const first = await confirm();
    assert.equal(first.complete, true);
    assert.deepEqual(first.leftOutAtWrite.map(({ path, rule }) => ({ path, rule })), [{ path: 'eng/notes/plan.md', rule: 'upload-too-large' }]);
    const linked = linkedFromGuide();
    assert.ok(linked !== undefined, 'the guide does not link the plan');
    // The recorded guide is the tracked file: its link comes back as it was written.
    assert.deepEqual(first.record?.reformatted, []);

    const writes = world.linear.writes.count;
    const second = await confirm();
    assert.equal(second.complete, true);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote again');
    assert.equal(linkedFromGuide(), linked);
  });

  it('L1-15 with links: a resumed run creates the documents a recorded one links with the ids that run chose', async () => {
    const world = fakeWorld();
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '2' };
    Object.assign(process.env, hooks);
    let first;
    try {
      first = await run(world);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    // `eng/backend/notes.md` is written, linking the plan by the id this run chose for it; the plan is not created yet.
    const recorded = await readIds();
    const planId = recorded['eng/notes/plan.md']?.id;
    assert.ok(planId !== undefined, 'the chosen id of the plan was not recorded');
    assert.equal(world.linear.documents.some((d) => d.id === planId), false);
    assert.equal(content(world, recorded['eng/backend/notes.md']?.id), `# Notes\n\nFollow [the plan](<${BASE}/${planId}>). ${CANARY}`);

    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(second.report.resumed, true);
    // The link written by the stopped run is already right: the plan is created with the id it chose.
    assert.deepEqual(second.report.initialSync?.skippedCompleted, ['eng/README.md', 'eng/backend/notes.md']);
    assert.equal((await readIds())['eng/notes/plan.md']?.id, planId);
    await assertLinked(world);
  });
});
