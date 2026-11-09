// The sync's Linear request budget through the command line, against a
// local git remote and a fake GitHub and Linear: a converged start (a
// confirmed initial sync), one change in Linear of the kinds the capture
// scenarios make, a sync, runs until a run changes nothing (the pull request
// opened and merged on the way), and one more run. Every request that
// reaches Linear's API counts, the token's mint and revocation included:
// the whole scenario stays within 1.5 requests per written document plus 5
// per run (I9), and a run that changes nothing makes at most 5.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

/** Two teams, three projects and both team zones: five containers, twelve documents. */
const TREE: Record<string, string> = {
  '.pre-commit-config.yaml': PRE_COMMIT,
  '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n',
  'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
  'eng/runbook.md': '# Runbook\n\nRestart the service.\n',
  'eng/notes/README.md': '---\nlinear-project: Field notes\n---\n\n# Field notes\n',
  'eng/notes/plan.md': '# Plan\n\nSteps one and two.\n',
  'eng/notes/review.md': '# Review\n\nWhat went well.\n',
  'eng/api/README.md': '---\nlinear-project: Interfaces\n---\n\n# Interfaces\n',
  'eng/api/errors.md': '# Errors\n\nEvery error has a code.\n',
  'docs/README.md': '---\nlinear-team: DOCS\n---\n\n# Docs\n',
  'docs/style.md': '# Style\n\nShort sentences.\n',
  'docs/handbook/README.md': '---\nlinear-project: Handbook\n---\n\n# Handbook\n',
  'docs/handbook/welcome.md': '# Welcome\n\nStart here.\n',
  'docs/handbook/tools.md': '# Tools\n\nThe editor and the terminal.\n',
};

/** I9 as the scenarios check it. */
const allowance = (written: number, runs: number) => 1.5 * written + 5 * runs;

describe('sync: the Linear request budget (I9)', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  /** Linear API requests by operation, in order. */
  let requests: string[];
  /** Engine runs. */
  let runs: number;
  const reportFile = () => join(fixture.root, 'report.json');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE, { lfs: ['*.png'] });
    cwd = (await fixture.clone('engine')).dir;
    world = fakeWorld();
    world.linear.teams = [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }, { id: 'team-docs', key: 'DOCS', name: 'Docs' }];
    world.linear.projects = [
      { id: 'project-notes', name: 'Field notes', teamIds: ['team-eng'] },
      { id: 'project-api', name: 'Interfaces', teamIds: ['team-eng'] },
      { id: 'project-handbook', name: 'Handbook', teamIds: ['team-docs'] },
      { id: 'project-elsewhere', name: 'Elsewhere', teamIds: ['team-eng'] },
    ];
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    requests = [];
    runs = 0;
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    assert.equal(live().length, 12);
  });
  afterEach(() => fixture.cleanup());

  async function rev(ref: string): Promise<string> {
    return (await fixture.remote.text(['rev-parse', ref])).trim();
  }

  async function mergeOnRemote(pr: { head: string; base: string; number: number }, sha: string): Promise<{ sha: string } | { status: number }> {
    if ((await rev(`refs/heads/${pr.head}`)) !== sha) return { status: 409 };
    const base = await rev(`refs/heads/${pr.base}`);
    const merged = await fixture.remote.run(['merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
    if (merged.code !== 0) return { status: 405 };
    const tree = merged.stdout.toString('utf8').split('\n')[0] as string;
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-p', sha, '-m', `Merge pull request #${pr.number}`]);
    await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit.trim(), base]);
    return { sha: commit.trim() };
  }

  /** Counts what reaches Linear's API; uploads and downloads go to other hosts. */
  const counting = (inner: typeof fetch): typeof fetch => async (input, init) => {
    const url = String(input);
    if (url === `${LINEAR_API}/graphql`) requests.push((JSON.parse(String(init?.body)) as { operationName: string }).operationName);
    else if (url.startsWith(`${LINEAR_API}/oauth/`)) requests.push(url.slice(LINEAR_API.length + 1));
    return inner(input, init);
  };

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    const before = requests.length;
    runs += 1;
    const result = await runCli([command], {
      cwd,
      fetch: counting(fakeFetch(world)),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
        MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
        MDBISYNC_LINEAR_API_URL: LINEAR_API,
        MDBISYNC_GITHUB_TOKEN: 'gh-token',
        MDBISYNC_GITHUB_API_URL: GITHUB_API,
        MDBISYNC_REPOSITORY: 'owner/repo',
        MDBISYNC_REPORT_FILE: reportFile(),
        ...extra,
      },
    });
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    return { result, report, requests: requests.slice(before) };
  }

  /** The scenario's runs after the change: sync, then until a run changes nothing (at most 4), then once more. */
  async function syncAndSettle() {
    const runReports: Array<Awaited<ReturnType<typeof cli>>> = [await cli('sync')];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = await cli('sync');
      runReports.push(run);
      if (run.report.changed === false) break;
    }
    assert.equal(runReports.at(-1)?.report.changed, false, 'the sync did not settle');
    runReports.push(await cli('sync'));
    for (const run of runReports) assert.equal(run.result.exitCode, 0, run.result.stderr);
    return runReports;
  }

  /** The documents written in the whole scenario, counted as I9 counts them. */
  const written = () => world.writes.filter((operation) => /document(Create|Update)|(Create|Update)Document/i.test(operation)).length;

  function assertBudget(runReports: Array<{ requests: string[]; report: RunReport }>) {
    process.stdout.write(`# ${requests.length} Linear requests for ${written()} written documents in ${runs} runs (limit ${allowance(written(), runs)})\n`);
    assert.ok(requests.length <= allowance(written(), runs), `${requests.length} requests for ${written()} written documents in ${runs} runs (limit ${allowance(written(), runs)}): ${requests.join(', ')}`);
    // A run that changes nothing stays within one run's allowance on its own, so settled runs never eat into the budget.
    for (const run of runReports) {
      if (run.report.changed !== false) continue;
      assert.ok(run.requests.length <= 5, `a run that changed nothing made ${run.requests.length} requests: ${run.requests.join(', ')}`);
    }
  }

  const live = () => world.linear.documents.filter((document) => document.trashed !== true && document.archivedAt === undefined);
  const byTitle = (title: string) => world.linear.documents.find((document) => document.title === title) as FakeDocument;
  const tracked = async (path: string) => {
    const shown = await fixture.remote.run(['show', `refs/heads/main:${path}`], { okCodes: [0, 128] });
    return shown.code === 0 ? shown.stdout.toString('utf8') : undefined;
  };

  it('a settled run resolves its targets, lists its containers once and writes nothing', async () => {
    const run = await cli('sync');
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.changed, false);
    assert.deepEqual(run.requests.filter((operation) => operation !== 'GetDocuments'), ['oauth/token', 'SetupTargets', 'ListDocuments', 'oauth/revoke']);
    assert.ok(run.requests.length <= 5);
  });

  it('the initial sync lists its five containers in one request', async () => {
    assert.equal(requests.filter((operation) => operation === 'ListDocuments').length, 1);
    assert.equal(requests.filter((operation) => operation === 'SetupTargets').length, 1);
  });

  it('a document created in Linear (L2-21)', async () => {
    world.linear.documents.push({ id: 'created', title: 'guides/new-page', projectId: 'project-notes', content: 'A new page.\n', createdAt: '2026-01-03T00:00:00Z' });
    touch(byTitle('guides/new-page'));
    const runReports = await syncAndSettle();
    assert.equal(await tracked('eng/notes/guides/new-page.md'), 'A new page.\n');
    assertBudget(runReports);
  });

  for (const [scenario, title, path] of [
    ['L2-22', 'Notes: draft?*', 'eng/notes/Notes%3A draft%3F%2A.md'],
    ['L2-23', 'guides/renamed', 'eng/notes/guides/renamed.md'],
    ['L2-24', 'other-folder/notes', 'eng/notes/other-folder/notes.md'],
  ] as const) {
    it(`a document renamed in Linear to "${title}" (${scenario})`, async () => {
      const document = byTitle('plan');
      document.title = title;
      touch(document);
      const runReports = await syncAndSettle();
      assert.equal(await tracked('eng/notes/plan.md'), undefined);
      assert.match((await tracked(path)) ?? '', /Steps one and two\./);
      assertBudget(runReports);
    });
  }

  it('a document moved to another mapped project (L2-25)', async () => {
    const document = byTitle('plan');
    document.projectId = 'project-handbook';
    touch(document);
    const runReports = await syncAndSettle();
    assert.equal(await tracked('eng/notes/plan.md'), undefined);
    assert.match((await tracked('docs/handbook/plan.md')) ?? '', /Steps one and two\./);
    assertBudget(runReports);
  });

  it('documents moved out of scope and trashed (L2-26)', async () => {
    const moved = byTitle('plan');
    moved.projectId = 'project-elsewhere';
    touch(moved);
    const trashed = byTitle('review');
    Object.assign(trashed, { trashed: true, archivedAt: '2026-02-01T00:00:00Z' });
    touch(trashed);
    const runReports = await syncAndSettle();
    assert.equal(await tracked('eng/notes/plan.md'), undefined);
    assert.equal(await tracked('eng/notes/review.md'), undefined);
    assertBudget(runReports);
  });

  it('a trashed document restored (L2-27)', async () => {
    const document = byTitle('review');
    Object.assign(document, { trashed: true, archivedAt: '2026-02-01T00:00:00Z' });
    touch(document);
    const trashRuns = await syncAndSettle();
    assert.equal(await tracked('eng/notes/review.md'), undefined);
    delete document.trashed;
    delete document.archivedAt;
    touch(document);
    const runReports = await syncAndSettle();
    assert.match((await tracked('eng/notes/review.md')) ?? '', /What went well\./);
    assertBudget([...trashRuns, ...runReports]);
  });

  it('an image pasted in Linear (L2-28)', async () => {
    const url = `${UPLOADS_HOST}/workspace/diagram.png`;
    world.linear.uploads.push({ assetUrl: url, filename: 'diagram.png', contentType: 'image/png', size: 11, bytes: Buffer.from('image-bytes') });
    const document = byTitle('plan');
    document.content = `${document.content ?? ''}\n![Diagram](${url})\n`;
    touch(document);
    const runReports = await syncAndSettle();
    assert.match((await tracked('eng/notes/plan.md')) ?? '', /!\[Diagram\]\([^)]*\.png\)/);
    assertBudget(runReports);
  });

  it('a table, a diagram and a task list added in Linear (L2-29)', async () => {
    const document = byTitle('plan');
    document.content = '# Plan\n\n| Step | Owner |\n| --- | --- |\n| One | Ana |\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n- [ ] Write it\n- [x] Read it\n';
    touch(document);
    const runReports = await syncAndSettle();
    const text = (await tracked('eng/notes/plan.md')) ?? '';
    assert.match(text, /\| One \| Ana \|/);
    assert.match(text, /```mermaid/);
    assert.match(text, /- \[x\] Read it/);
    assertBudget(runReports);
  });

  it('an icon and a color changed in Linear (L2-30)', async () => {
    const document = byTitle('plan');
    Object.assign(document, { icon: 'Fire', color: '#123456' });
    touch(document);
    const runReports = await syncAndSettle();
    assertBudget(runReports);
  });
});
