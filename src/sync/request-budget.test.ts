// The sync's Linear request budget through the command line, against a
// local git remote and a fake GitHub and Linear: a converged start (a
// confirmed initial sync), one change in Linear of the kinds the capture
// scenarios make, a sync, runs until a run changes nothing (the pull request
// opened and merged on the way), and one more run. Every request that
// reaches Linear's API counts, the token's mint and revocation included:
// the whole scenario stays within 1.5 requests per written document plus 5
// per run (I9), and a run that changes nothing makes at most 5. A conflict
// episode on three documents also counts 2 per conflict notice set or
// resolved, as I9 does.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { detectConflicts } from '../merge/index.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, createFixture, mergeOnGitHub } from '../state/test-helpers.ts';

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

/** A slice of three documents in one team zone, smaller than any corpus slice. */
const THREE_DOCUMENTS: Record<string, string> = {
  '.pre-commit-config.yaml': PRE_COMMIT,
  '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n',
  'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
  'eng/runbook.md': '# Runbook\n\nRestart the service.\n',
  'eng/plan.md': '# Plan\n\nSteps one and two.\n',
};

/** I9's allowance per run: also the most a run that changes nothing may make. */
const PER_RUN = 5;
/** I9 as the scenarios check it. */
const allowance = (written: number, runs: number, conflictNotices = 0) => 1.5 * written + PER_RUN * runs + 2 * conflictNotices;

describe('sync: the Linear request budget (I9)', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  /** Linear API requests by operation, in order. */
  let requests: string[];
  /** Engine runs. */
  let runs: number;
  const reportFile = () => join(fixture.root, 'report.json');

  /** A converged start: the tree seeded and synchronized to Linear by a confirmed initial sync. */
  async function start(tree: Record<string, string>, documents: number) {
    fixture = await createFixture();
    await fixture.seed(tree, { lfs: ['*.png'] });
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
    assert.equal(live().length, documents);
  }

  beforeEach(() => start(TREE, 12));
  afterEach(() => fixture.cleanup());

  async function rev(ref: string): Promise<string> {
    return (await fixture.remote.text(['rev-parse', ref])).trim();
  }

  const mergeOnRemote = (pr: { head: string; base: string; number: number }, sha: string) => mergeOnGitHub(fixture, pr, sha, `Merge pull request #${pr.number}`);

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
        MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_GITHUB_TOKEN: 'gh-token',
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

  /** I9 over the whole scenario; `notices` is the conflict notice changes the runs reported, when the scenario counts them. */
  function assertBudget(runReports: Array<{ requests: string[]; report: RunReport }>, notices = 0) {
    const limit = allowance(written(), runs, notices);
    process.stdout.write(`# ${requests.length} Linear requests for ${written()} written documents and ${notices} conflict notice changes in ${runs} runs (limit ${limit})\n`);
    assert.ok(requests.length <= limit, `${requests.length} requests for ${written()} written documents and ${notices} conflict notice changes in ${runs} runs (limit ${limit}): ${requests.join(', ')}`);
    // A run that changes nothing stays within one run's allowance on its own, so settled runs never eat into the budget.
    for (const run of runReports) {
      if (run.report.changed !== false) continue;
      assert.ok(run.requests.length <= PER_RUN, `a run that changed nothing made ${run.requests.length} requests: ${run.requests.join(', ')}`);
    }
  }

  const live = () => world.linear.documents.filter((document) => document.trashed !== true && document.archivedAt === undefined);
  const byTitle = (title: string) => world.linear.documents.find((document) => document.title === title) as FakeDocument;
  const tracked = async (path: string) => {
    const shown = await fixture.remote.run(['show', `refs/heads/main:${path}`], { okCodes: [0, 128] });
    return shown.code === 0 ? shown.stdout.toString('utf8') : undefined;
  };

  /** A person's commit on the tracked branch, straight into the remote: new text by path. */
  async function commitGit(files: Record<string, string>) {
    const base = await rev('refs/heads/main');
    const env = { GIT_INDEX_FILE: join(fixture.root, 'scratch.index'), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await fixture.remote.run(['read-tree', base], { env });
    for (const [path, text] of Object.entries(files)) {
      const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: text });
      await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    }
    const tree = await fixture.remote.text(['write-tree'], { env });
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-m', 'Edit'], { env });
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
  }

  /** A same-line conflict on the runbook, settled: the run that writes the markers, the pull request opened and merged, the run that takes the merge in. */
  async function conflictOnRunbook() {
    const document = byTitle('runbook');
    document.content = '# Runbook\n\nRestart the service, Linear.\n';
    touch(document);
    await commitGit({ 'eng/runbook.md': '# Runbook\n\nRestart the service, git.\n' });
    const runReports = await syncAndSettle();
    assert.equal(detectConflicts((await tracked('eng/runbook.md')) ?? '').length, 1);
    assert.equal(detectConflicts(byTitle('runbook').content ?? '').length, 1);
    return runReports;
  }

  /**
   * The runs that only take a merged sync pull request in: they move `linear` and nothing else, since Linear holds the
   * merge's text already. Each costs no more than a quiet run: capture's listing serves its capacity report.
   */
  function assertTakeIns(runReports: Array<{ requests: string[]; report: RunReport }>, expected: number) {
    const takeIns = runReports.filter((run) => run.report.changed !== false && Object.keys(run.report.writes.linear).length === 0 && run.report.writes.git.linear === 1 && Object.keys(run.report.writes.pullRequests).length === 0);
    assert.equal(takeIns.length, expected, 'runs that took a merged sync pull request in');
    for (const run of takeIns) assert.ok(run.requests.length <= PER_RUN, `a run that took the merge in made ${run.requests.length} requests: ${run.requests.join(', ')}`);
  }

  it('a conflict resolved in git: the run that takes the sync pull request\'s merge in costs no more than a quiet run (L3-10)', async () => {
    const conflict = await conflictOnRunbook();
    await commitGit({ 'eng/runbook.md': '# Runbook\n\nRestart the service, git.\n' });
    const resolve = await syncAndSettle();
    assert.equal(byTitle('runbook').content, '# Runbook\n\nRestart the service, git.\n');
    assertTakeIns([...conflict, ...resolve], 1);
    // Without the conflict notice allowance: on twelve documents the episode fits I9 even so, and this keeps it fitting.
    assertBudget([...conflict, ...resolve]);
  });

  it('a new conflict on both sides of an open one replaces it, and each merge is taken in as cheaply (L3-12)', async () => {
    const conflict = await conflictOnRunbook();
    const document = byTitle('runbook');
    document.content = (document.content ?? '').replace('Restart the service, git.', 'Restart the service, git, Linear again.');
    touch(document);
    await commitGit({ 'eng/runbook.md': ((await tracked('eng/runbook.md')) ?? '').replace('Restart the service, git.', 'Restart the service, git, git again.') });
    const again = await syncAndSettle();
    const text = (await tracked('eng/runbook.md')) ?? '';
    assert.equal(detectConflicts(text).length, 1, text);
    assert.equal(byTitle('runbook').content, text);
    assertTakeIns([...conflict, ...again], 2);
    assertBudget([...conflict, ...again]);
  });

  it('a conflict episode on a three-document slice stays within I9 with 2 requests per conflict notice set or resolved, and only its notice runs touch comments', async () => {
    await fixture.cleanup();
    await start(THREE_DOCUMENTS, 3);
    const conflict = await conflictOnRunbook();
    await commitGit({ 'eng/runbook.md': '# Runbook\n\nRestart the service, git.\n' });
    const resolve = await syncAndSettle();
    assert.equal(byTitle('runbook').content, '# Runbook\n\nRestart the service, git.\n');
    const episode = [...conflict, ...resolve];
    // The run that writes the markers sets the notice, the resolution run resolves it; no other run reports one.
    assert.deepEqual(episode.map((run) => run.report.conflictNotices).filter(({ set, resolved }) => set.length + resolved.length > 0), [
      { set: ['eng/runbook.md'], resolved: [] },
      { set: [], resolved: ['eng/runbook.md'] },
    ]);
    // Each notice change costs at most its two requests (the comment's lookup and its write or resolution), and a run
    // without one makes no comment request: the allowance follows the episode and nothing else.
    for (const run of episode) {
      const comments = run.requests.filter((operation) => /Comment/.test(operation));
      const notices = run.report.conflictNotices.set.length + run.report.conflictNotices.resolved.length;
      assert.ok(comments.length <= 2 * notices, `${comments.length} comment requests for ${notices} conflict notice changes: ${run.requests.join(', ')}`);
    }
    assertTakeIns(episode, 1);
    const notices = episode.reduce((sum, run) => sum + run.report.conflictNotices.set.length + run.report.conflictNotices.resolved.length, 0);
    assertBudget(episode, notices);
  });

  it('a run that writes lists the containers again before it writes', async () => {
    await commitGit({ 'eng/notes/added.md': '# Added\n\nWritten in git.\n' });
    const run = await cli('sync');
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.sync?.created, ['eng/notes/added.md']);
    assert.equal(run.requests.filter((operation) => operation === 'ListDocuments').length, 2, run.requests.join(', '));
    await commitGit({ 'eng/notes/added.md': '# Added\n\nChanged in git.\n' });
    const update = await cli('sync');
    assert.deepEqual(update.report.sync?.updated, ['eng/notes/added.md']);
    assert.equal(update.requests.filter((operation) => operation === 'ListDocuments').length, 2, update.requests.join(', '));
  });

  it('a settled run resolves its targets, lists its containers once and writes nothing', async () => {
    const run = await cli('sync');
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.changed, false);
    assert.deepEqual(run.requests.filter((operation) => operation !== 'GetDocuments'), ['oauth/token', 'SetupTargets', 'ListDocuments', 'oauth/revoke']);
    assert.ok(run.requests.length <= PER_RUN);
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
      // Every sync captures, so every report names the rule its file names follow.
      for (const run of runReports) assert.deepEqual(run.report.paths, { rule: 'percent-encode-unsafe-segments' });
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
    world.linear.uploads.push({ assetUrl: url, filename: 'diagram.png', contentType: 'image/png', size: 11, bytes: await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url)) });
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

  it('an icon, a color and a comment changed in Linear move no ref, and a later edit is still captured (L2-30)', async () => {
    const refs = async () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
    const before = await refs();
    Object.assign(byTitle('plan'), { icon: 'Fire' });
    touch(byTitle('plan'));
    Object.assign(byTitle('errors'), { color: '#123456' });
    touch(byTitle('errors'));
    // Linear moves a document's update time when someone comments on it.
    world.linear.comments.set('comment-review', { documentContentId: 'review-content', body: 'Looks good.' });
    touch(byTitle('review'));
    const runReports = await syncAndSettle();
    for (const run of runReports) assert.equal(run.report.changed, false, 'a run changed something');
    assert.equal(await refs(), before, 'a run moved a ref');
    assertBudget(runReports);

    // The documents read again find their edit, though no cursor was recorded for the edits above.
    const plan = byTitle('plan');
    plan.content = '# Plan\n\nSteps one, two and three.\n';
    touch(plan);
    await syncAndSettle();
    assert.match((await tracked('eng/notes/plan.md')) ?? '', /Steps one, two and three\./);
    assert.notEqual(await refs(), before);
  });
});
