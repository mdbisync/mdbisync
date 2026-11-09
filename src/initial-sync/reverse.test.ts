// The initial sync from Linear to the tracked branch through the command
// line, against a local git remote and a fake GitHub and Linear: the dry run,
// the pull request left for a person, the refusal of the sync until it is
// merged, resume and recovery.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { COMMANDS, INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { FINAL_IDS_MESSAGE, PROGRESS_MESSAGE } from './confirm.ts';
import { type ReversePlanInput, PULL_REQUEST_TITLE, REVERSE_RECORD_MESSAGE, isPlainTitle, planLinearToGit } from './reverse.ts';

const CANARY = 'kx-7d20b4e1';
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
  'eng/notes/plan.md': `---\nowner: platform\n---\n\n# Plan\n\nOld steps. ${CANARY}`,
  'eng/notes/formula.md': `# Formula\n\nWater is H~2~O. ${CANARY}`,
  'eng/notes/diagram.png': 'not really a picture',
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}`,
  'combined/Guide.md': `# Guide\n\n${CANARY}`,
  'combined/guide.md': `# guide\n\n${CANARY}`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

let clock = 0;
const doc = (id: string, title: string, place: { projectId: string } | { teamId: string }, content: string): FakeDocument => ({
  id,
  title,
  ...place,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, (clock += 1))).toISOString(),
  content,
});

/** Linear's side: the team zone's README, a matched plan, a project README, two documents only in Linear, and one unsafe title. */
const linearDocuments = (): FakeDocument[] => [
  doc('doc-eng-readme', 'README', { teamId: 'team-eng' }, `# Engineering\n\nThe team's home. ${CANARY}`),
  doc('doc-notes-readme', 'README', { projectId: 'project-api' }, `# Field notes\n\n${CANARY}`),
  doc('doc-plan', 'plan', { projectId: 'project-api' }, `# Plan\n\nNew steps. ${CANARY}`),
  doc('doc-handbook', 'README', { projectId: 'project-handbook' }, `# Handbook\n\n${CANARY}`),
  doc('doc-runbook', 'ops/runbook', { teamId: 'team-eng' }, `# Runbook\n\nRestart it. ${CANARY}`),
  doc('doc-faq', 'faq', { projectId: 'project-api' }, `# FAQ\n\n${CANARY}`),
  doc('doc-unsafe', 'Q3: plans?', { projectId: 'project-api' }, `# Q3\n\n${CANARY}`),
];

const OVERWRITE = ['combined/README.md', 'eng/README.md', 'eng/notes/README.md', 'eng/notes/plan.md'];
const CREATE = ['eng/notes/faq.md', 'eng/ops/runbook.md'];
const REMOVE = ['eng/backend/notes.md'];
const IDS = {
  'combined/README.md': 'doc-handbook',
  'eng/README.md': 'doc-eng-readme',
  'eng/notes/README.md': 'doc-notes-readme',
  'eng/notes/faq.md': 'doc-faq',
  'eng/notes/plan.md': 'doc-plan',
  'eng/ops/runbook.md': 'doc-runbook',
};

describe('initial sync from Linear to the tracked branch', () => {
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
    MDBISYNC_DIRECTION: 'linear-to-git',
    MDBISYNC_CONFIRM: 'true',
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  const run = async (world: FakeWorld, extra: Record<string, string> = {}, command = 'initial-sync') => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const result = await runCli([command], { env: env(extra), cwd, fetch: fakeFetch(world) });
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    assert.ok(!JSON.stringify(report).includes(CANARY), 'the report holds content');
    for (const pr of world.github.pullRequests) assert.ok(!`${pr.title}\n${pr.body}`.includes(CANARY), 'a pull request holds content');
    return { result, report, summary };
  };

  const refs = async () => {
    const text = await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
    return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
  };
  const show = (spec: string) => fixture.remote.text(['show', spec]);
  const files = async (commit: string) => (await fixture.remote.text(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(Boolean).sort();
  const readIds = async () => {
    const data = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
    return Object.fromEntries(Object.entries(data).map(([path, entry]) => [path, entry.id]));
  };
  const linearMutations = (world: FakeWorld) => world.writes.filter((write) => !write.includes(' '));

  /** A person merges the pull request with a merge commit. */
  const merge = async (world: FakeWorld) => {
    const head = await fixture.remote.text(['rev-parse', 'refs/heads/mdbisync/linear']);
    const main = await fixture.remote.text(['rev-parse', 'refs/heads/main']);
    const commit = await fixture.remote.text(['commit-tree', `${head}^{tree}`, '-p', main, '-p', head, '-m', 'Merge the initial sync'], {
      env: { GIT_AUTHOR_NAME: 'A person', GIT_AUTHOR_EMAIL: 'person@example.com', GIT_COMMITTER_NAME: 'A person', GIT_COMMITTER_EMAIL: 'person@example.com' },
    });
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit]);
    for (const pr of world.github.pullRequests) Object.assign(pr, { state: 'closed', merged: true });
  };

  it('L1R-01: a dry run lists the files to overwrite, create and remove, and writes nothing', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    const before = await refs();

    const { result, report, summary } = await run(world, { MDBISYNC_CONFIRM: '' });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.summary?.plan.overwrite, OVERWRITE);
    assert.deepEqual(report.summary?.plan.create, CREATE);
    assert.deepEqual(report.summary?.plan.remove, REMOVE);
    assert.deepEqual(report.summary?.plan.trash, []);
    assert.deepEqual(report.summary?.plan.paths, [...OVERWRITE, ...CREATE, ...REMOVE].sort());
    assert.deepEqual(report.summary?.leftOut, ['combined/Guide.md', 'combined/guide.md', 'eng/notes/Q3: plans?.md', 'eng/notes/formula.md']);
    assert.deepEqual(report.summary?.leftOutFiles.find((entry) => entry.path === 'eng/notes/Q3: plans?.md')?.rules, ['title-not-a-path']);
    assert.equal(report.summary?.direction, 'linear-to-git');
    assert.equal(report.linearToGit, null);

    assert.match(summary, /dry run/);
    assert.match(summary, /^\| eng\/backend\/notes\.md \|$/m);
    assert.match(summary, /^\| eng\/ops\/runbook\.md \| team "ENG" \| doc-runbook \|$/m);
    assert.deepEqual(await refs(), before);
    assert.deepEqual(world.writes, []);
    assert.deepEqual(world.github.pullRequests, []);
  });

  it('L1R-02: confirmed, it records every id and opens one pull request a person merges', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    const documents = structuredClone(world.linear.documents);

    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(world.linear.documents, documents, 'Linear changed');
    assert.deepEqual(linearMutations(world), []);

    // One pull request from the sync branch, open, not merged.
    assert.equal(world.github.pullRequests.length, 1);
    const [pr] = world.github.pullRequests;
    assert.deepEqual({ head: pr?.head, base: pr?.base, title: pr?.title, state: pr?.state, merged: pr?.merged }, { head: 'mdbisync/linear', base: 'main', title: PULL_REQUEST_TITLE, state: 'open', merged: false });
    assert.match(pr?.body ?? '', /eng\/backend\/notes\.md/);
    assert.equal(report.linearToGit?.pullRequest?.number, 1);
    assert.equal(report.linearToGit?.pullRequest?.opened, true);
    assert.match(summary, /pull request #1 is open/);

    // `linear` is the pull request's head, one commit whose parent is the tracked branch.
    const after = await refs();
    const main = after['refs/heads/main'] as string;
    assert.equal(after['refs/heads/mdbisync/linear'], after['refs/mdbisync/linear']);
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@']), main);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), REVERSE_RECORD_MESSAGE);
    assert.equal(report.linearToGit?.record?.hasTrackedParent, true);
    assert.equal(after['refs/mdbisync/linear'], report.linearToGit?.record?.commit);

    // The synchronized folders equal Linear; front matter, left-out and unsynced files stay.
    const head = 'refs/mdbisync/linear';
    assert.equal(await show(`${head}:eng/notes/plan.md`), `---\nowner: platform\n---\n\n# Plan\n\nNew steps. ${CANARY}`);
    assert.equal(await show(`${head}:eng/README.md`), `---\nlinear-team: ENG\n---\n\n# Engineering\n\nThe team's home. ${CANARY}`);
    assert.equal(await show(`${head}:eng/ops/runbook.md`), `# Runbook\n\nRestart it. ${CANARY}`);
    assert.equal(await show(`${head}:eng/notes/faq.md`), `# FAQ\n\n${CANARY}`);
    for (const kept of ['README.md', 'eng/notes/formula.md', 'combined/Guide.md', 'combined/guide.md', 'eng/notes/diagram.png']) {
      assert.equal(await show(`${head}:${kept}`), (TREE[kept] as string).replace(/\n$/, ''), kept);
    }
    const tree = await files(head);
    assert.ok(!tree.includes('eng/backend/notes.md'), 'the git-only file was not removed');
    assert.deepEqual(tree, [...Object.keys(TREE).filter((path) => path !== 'eng/backend/notes.md'), ...CREATE].sort());

    // `ids` records every document that has a file, in a final commit; `uploads` exists.
    assert.deepEqual(await readIds(), IDS);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/ids']), FINAL_IDS_MESSAGE);
    assert.equal(await show('refs/mdbisync/uploads:uploads.json'), '{}');
    assert.deepEqual(report.linearToGit?.removed, REMOVE);
    assert.equal(report.writtenCount, 0);
  });

  it('L1R-02: the sync refuses to run, writing nothing, until a person merges the pull request', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();
    const writes = world.writes.length;

    const refused = await run(world, {}, 'sync');
    assert.equal(refused.result.exitCode, NO_STATE_EXIT_CODE, refused.result.stderr);
    assert.equal(refused.report.code, 'initial-pull-request-pending');
    assert.match(refused.summary, /a person reviews and merges it/);
    assert.deepEqual(await refs(), before);
    assert.equal(world.writes.length, writes);
    assert.equal(world.github.pullRequests[0]?.merged, false);

    // L1R-03: after the merge the sync runs, and finds nothing to write to Linear (I6).
    await merge(world);
    const mutationsBefore = linearMutations(world).length;
    const after = await run(world, {}, 'sync');
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.equal(after.report.code, null);
    assert.equal(after.report.writtenCount, 0);
    assert.equal(linearMutations(world).length, mutationsBefore, 'the sync wrote to Linear after the merge');
    // Merged, the tracked branch holds Linear's state: the synchronized folders equal `linear`.
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/heads/main^{tree}']), await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^{tree}']));

    // Running initial sync again with nothing new opens nothing and leaves the merged pull request's branch alone.
    const syncBranch = (await refs())['refs/heads/mdbisync/linear'];
    const rerun = await run(world);
    assert.equal(rerun.result.exitCode, 0, rerun.result.stderr);
    assert.equal(rerun.report.linearToGit?.pullRequest, null);
    assert.equal((await refs())['refs/heads/mdbisync/linear'], syncBranch);
    assert.equal(world.github.pullRequests.length, 1);
    const afterRerun = await run(world, {}, 'sync');
    assert.equal(afterRerun.result.exitCode, 0, afterRerun.result.stderr);
    assert.equal(afterRerun.report.code, null);
  });

  it('runs again with nothing changed: refs stay, no second pull request', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(await refs(), before);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(report.linearToGit?.pullRequest?.opened, false);
    assert.equal(report.linearToGit?.record?.moved, false);
  });

  it('L1R-06: a stopped run records the ids it took and resumes without duplicate files', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '2' };

    // The engine reads its test hooks from its own process environment.
    Object.assign(process.env, hooks);
    let stopped;
    try {
      stopped = await run(world);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(stopped.result.exitCode, INCOMPLETE_EXIT_CODE, stopped.result.stderr);
    assert.equal(stopped.report.code, 'stopped');
    assert.equal(stopped.report.stoppedEarly, true);
    assert.deepEqual(Object.keys(await readIds()), ['combined/README.md', 'eng/README.md']);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/ids']), PROGRESS_MESSAGE);
    const afterStop = await refs();
    assert.equal(afterStop['refs/mdbisync/linear'], undefined);
    assert.equal(afterStop['refs/heads/mdbisync/linear'], undefined);
    assert.deepEqual(world.github.pullRequests, []);
    assert.match(stopped.summary, /Run initial sync again with the same inputs/);

    // The sync does not run on half a map.
    assert.equal((await run(world, {}, 'sync')).report.code, 'initial-sync-required');

    const resumed = await run(world);
    assert.equal(resumed.result.exitCode, 0, resumed.result.stderr);
    assert.equal(resumed.report.resumed, true);
    assert.deepEqual(resumed.report.linearToGit?.skippedCompleted, ['combined/README.md', 'eng/README.md']);
    assert.deepEqual([...(resumed.report.linearToGit?.overwritten ?? []), ...(resumed.report.linearToGit?.created ?? [])].sort(), ['eng/notes/README.md', 'eng/notes/faq.md', 'eng/notes/plan.md', 'eng/ops/runbook.md']);
    assert.deepEqual(await readIds(), IDS);
    assert.equal(world.github.pullRequests.length, 1);
    // No duplicate files: exactly one file per document.
    const tree = await files('refs/mdbisync/linear');
    assert.deepEqual(tree.filter((path) => path.endsWith('runbook.md') || path.endsWith('faq.md')), CREATE);
  });

  it('a refused pull request leaves the state recorded; running again opens it', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    world.github.refusePullRequests = true;
    const failed = await run(world);
    assert.equal(failed.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(failed.report.code, 'pull-request-failed');
    assert.match(failed.summary, /HTTP 422/);
    const recorded = await refs();
    assert.ok(recorded['refs/mdbisync/linear'] !== undefined);

    world.github.refusePullRequests = false;
    const again = await run(world);
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(await refs(), recorded);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('a title that lands in another annotated folder is left out, not filed there', async () => {
    const world = fakeWorld();
    // A team document titled like a path into the project folder `eng/notes`.
    world.linear.documents = [...linearDocuments(), doc('doc-stray', 'notes/stray', { teamId: 'team-eng' }, `# Stray\n\n${CANARY}`)];
    // The dry run already says so, as the confirmed run does.
    const dry = await run(world, { MDBISYNC_CONFIRM: '' });
    assert.deepEqual(dry.report.summary?.leftOutFiles.find((entry) => entry.path === 'eng/notes/stray.md')?.rules, ['title-not-a-path']);
    assert.ok(!(dry.report.summary?.plan.create ?? []).includes('eng/notes/stray.md'));
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.summary?.leftOutFiles.find((entry) => entry.path === 'eng/notes/stray.md')?.rules, ['title-not-a-path']);
    assert.ok(!(await files('refs/mdbisync/linear')).includes('eng/notes/stray.md'));
    assert.equal((await readIds())['eng/notes/stray.md'], undefined);
  });

  it('keeps a folder annotation that has no document, and recovers after the state is lost', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments().filter((d) => d.id !== 'doc-handbook');
    const first = await run(world);
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(await show('refs/mdbisync/linear:combined/README.md'), TREE['combined/README.md']);
    assert.ok(!(first.report.summary?.plan.remove ?? []).includes('combined/README.md'));

    for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);
    const again = await run(world);
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(Object.keys(await readIds()).sort(), Object.keys(IDS).filter((path) => path !== 'combined/README.md'));
    assert.equal(world.github.pullRequests.length, 1, 'a second pull request was opened');
  });

  it('leaves out a document whose text would read as front matter, and keeps a header that ends the file', async () => {
    const world = fakeWorld();
    world.linear.documents = [
      ...linearDocuments(),
      doc('doc-fenced', 'fenced', { projectId: 'project-api' }, `---\nlinear-team: DOCS\n---\nLooks like metadata. ${CANARY}`),
      doc('doc-sub-readme', 'sub/README', { teamId: 'team-eng' }, `---\nlinear-project: Handbook\n---\n${CANARY}`),
    ];
    await fixture.seed({ 'eng/notes/README.md': '---\nlinear-project: Field notes\n---' });
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.linearToGit?.leftOutAtRecord, [
      { path: 'eng/notes/fenced.md', rule: 'front-matter-boundary' },
      { path: 'eng/sub/README.md', rule: 'front-matter-boundary' },
    ]);
    const tree = await files('refs/mdbisync/linear');
    assert.ok(!tree.includes('eng/notes/fenced.md') && !tree.includes('eng/sub/README.md'));
    assert.equal((await readIds())['eng/notes/fenced.md'], undefined);
    // The annotation-only README ended at its fence: the body starts on the next line.
    assert.equal(await show('refs/mdbisync/linear:eng/notes/README.md'), `---\nlinear-project: Field notes\n---\n# Field notes\n\n${CANARY}`);
    // The description counts only the files the pull request carries.
    assert.match(world.github.pullRequests[0]?.body ?? '', /- 2 files are new/);
  });

  it('keeps an existing file and its document id when the document reads as front matter', async () => {
    const world = fakeWorld();
    // The tracked file has no front matter, so the document's fence would become one.
    world.linear.documents = [...linearDocuments(), doc('doc-notes', 'backend/notes', { teamId: 'team-eng' }, `---\nstatus: draft\n---\nNotes. ${CANARY}`)];
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.linearToGit?.leftOutAtRecord, [{ path: 'eng/backend/notes.md', rule: 'front-matter-boundary' }]);
    assert.ok(!(report.linearToGit?.overwritten ?? []).includes('eng/backend/notes.md'));
    // The file keeps the tracked text, and stays the document's file.
    assert.equal(await show('refs/mdbisync/linear:eng/backend/notes.md'), TREE['eng/backend/notes.md']);
    assert.equal((await readIds())['eng/backend/notes.md'], 'doc-notes');
    assert.match(world.github.pullRequests[0]?.body ?? '', /- 4 files take Linear's text/);
  });

  it('a rerun that finds the tracked branch equal to Linear closes the earlier open pull request, and the sync runs', async () => {
    const world = fakeWorld();
    assert.equal((await run(world, { MDBISYNC_DIRECTION: 'git-to-linear' })).result.exitCode, 0);
    for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);
    const plan = world.linear.documents.find((d) => d.title === 'plan' && d.projectId === 'project-api') as FakeDocument;
    const original = plan.content as string;
    plan.content = `# Plan\n\nChanged in Linear. ${CANARY}`;
    assert.equal((await run(world)).result.exitCode, 0);
    assert.equal(world.github.pullRequests[0]?.state, 'open');
    const branch = (await refs())['refs/heads/mdbisync/linear'];

    plan.content = original;
    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.linearToGit?.closedPullRequest, 1);
    assert.equal(world.github.pullRequests[0]?.state, 'closed');
    assert.equal((await refs())['refs/heads/mdbisync/linear'], branch, 'the sync branch moved');
    assert.match(summary, /Pull request #1 of an earlier run had nothing left to carry and is closed/);
    const sync = await run(world, {}, 'sync');
    assert.equal(sync.result.exitCode, 0, sync.result.stderr);
  });

  it('records its own marker even when an earlier record from the other direction has the same tree', async () => {
    const world = fakeWorld();
    // Linear stores the text in its own form, so the record differs from the tracked branch.
    world.linear.store = (content) => content.replace('# ', '#  ');
    world.github.pullRequests = [];
    const gitToLinear = await run(world, { MDBISYNC_DIRECTION: 'git-to-linear' });
    assert.equal(gitToLinear.result.exitCode, 0, gitToLinear.result.stderr);
    const { result } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), REVERSE_RECORD_MESSAGE);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal((await run(world, {}, 'sync')).report.code, 'initial-pull-request-pending');
  });

  it('opens no pull request when the tracked branch already equals Linear, and the sync then runs after other commits', async () => {
    const world = fakeWorld();
    assert.equal((await run(world, { MDBISYNC_DIRECTION: 'git-to-linear' })).result.exitCode, 0);
    for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);
    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(report.linearToGit?.record?.changesTracked, false);
    assert.equal(report.linearToGit?.pullRequest, null);
    assert.deepEqual(world.github.pullRequests, []);
    assert.equal((await refs())['refs/heads/mdbisync/linear'], undefined);
    assert.match(summary, /no pull request is needed/);

    await fixture.seed({ 'src/app.txt': 'unrelated work\n' });
    const sync = await run(world, {}, 'sync');
    assert.equal(sync.result.exitCode, 0, sync.result.stderr);
    assert.notEqual(sync.report.code, 'initial-pull-request-pending');
  });

  it('does not overwrite commits a person pushed to the open pull request', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    assert.equal((await run(world)).result.exitCode, 0);
    const head = await fixture.remote.text(['rev-parse', 'refs/heads/mdbisync/linear']);
    const fix = await fixture.remote.text(['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'Fix a typo'], {
      env: { GIT_AUTHOR_NAME: 'A person', GIT_AUTHOR_EMAIL: 'person@example.com', GIT_COMMITTER_NAME: 'A person', GIT_COMMITTER_EMAIL: 'person@example.com' },
    });
    await fixture.remote.run(['update-ref', 'refs/heads/mdbisync/linear', fix]);
    world.linear.documents.push(doc('doc-later', 'later', { projectId: 'project-api' }, `# Later\n\n${CANARY}`));
    const before = await refs();

    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(report.code, 'sync-branch-changed');
    assert.match(summary, /holds commits this sync did not make/);
    assert.deepEqual(await refs(), before);
    // The pull request with the person's commit still waits for its merge.
    assert.equal((await run(world, {}, 'sync')).report.code, 'initial-pull-request-pending');
  });

  it('a rerun after Linear changed moves the pull request to the new record and rewrites its description', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    assert.equal((await run(world)).result.exitCode, 0);
    world.linear.documents = world.linear.documents.filter((d) => d.id !== 'doc-plan');
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(report.linearToGit?.pullRequest?.opened, false);
    assert.match(world.github.pullRequests[0]?.body ?? '', /eng\/notes\/plan\.md/);
    assert.equal((await refs())['refs/heads/mdbisync/linear'], report.linearToGit?.record?.commit);
    assert.ok(!(await files('refs/heads/mdbisync/linear')).includes('eng/notes/plan.md'));
  });

  it('an initial sync from git to Linear waits while that pull request is open', async () => {
    const world = fakeWorld();
    world.linear.documents = linearDocuments();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();
    const writes = world.writes.length;
    const { result, report } = await run(world, { MDBISYNC_DIRECTION: 'git-to-linear' });
    assert.equal(result.exitCode, NO_STATE_EXIT_CODE, result.stderr);
    assert.equal(report.code, 'initial-pull-request-pending');
    assert.deepEqual(await refs(), before);
    assert.equal(world.writes.length, writes);
    // Its dry run still shows what it would do.
    assert.equal((await run(world, { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: '' })).result.exitCode, 0);
  });
});

describe('planning an initial sync from Linear', () => {
  const place = { kind: 'project', team: 'ENG', project: 'Field notes' } as const;
  const listed = (id: string, title: string, createdAt: string) => ({
    id,
    title,
    slugId: id,
    icon: null,
    color: null,
    content: '',
    documentContentId: null,
    projectId: 'project-api',
    teamId: null,
    trashed: false,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  const input = (documents: ReturnType<typeof listed>[], files: Record<string, string> = {}): ReversePlanInput => ({
    mapping: {
      annotations: [{ folder: 'notes', readme: 'notes/README.md', team: 'ENG', project: 'Field notes' }],
      zones: new Map([['notes', { team: 'ENG', project: 'Field notes', teamFolder: 'notes', projectFolder: 'notes' }]]) as never,
      problems: [],
      documents: Object.keys(files).map((path) => ({ path, oid: path, title: path.slice('notes/'.length, -3), place })),
      unsynced: [],
      leftOut: [],
    },
    texts: new Map(Object.entries(files)),
    places: [{ place, documents }],
    treePaths: new Set(['notes/README.md', ...Object.keys(files)]),
  });

  it('gives a title shared by two documents to the older one', () => {
    const plan = planLinearToGit(input([listed('new', 'faq', '2026-01-02T00:00:00Z'), listed('old', 'faq', '2026-01-01T00:00:00Z')]));
    assert.deepEqual(plan.create.map((entry) => entry.documentId), ['old']);
    assert.deepEqual(plan.leftOut.map((entry) => [entry.documentId, entry.rules, entry.collidesWith]), [['new', ['duplicate-title'], ['notes/faq.md']]]);
  });

  it('does not create a file that differs from an existing one only in case', () => {
    const plan = planLinearToGit(input([listed('plan', 'plan', '2026-01-01T00:00:00Z'), listed('Plan', 'Plan', '2026-01-02T00:00:00Z')], { 'notes/plan.md': '# Plan\n' }));
    assert.deepEqual(plan.overwrite.map((entry) => entry.documentId), ['plan']);
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.leftOut.map((entry) => [entry.path, entry.rules]), [['notes/Plan.md', ['duplicate-title']]]);
  });

  it('removes a file without a document but keeps the folder annotation', () => {
    const plan = planLinearToGit(input([], { 'notes/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n', 'notes/old.md': '# Old\n' }));
    assert.deepEqual(plan.remove, ['notes/old.md']);
    assert.deepEqual(plan.kept, [{ path: 'notes/README.md', reason: 'annotation' }]);
  });

  it('accepts only titles that are plain paths as they are', () => {
    for (const title of ['plan', 'guides/setup/install', 'Notes (draft) v2', 'Ελληνικά', 'kx 中文']) assert.ok(isPlainTitle(title), title);
    for (const title of ['a:b', 'why?', 'a*b', ' lead', 'trail ', 'end.', 'a//b', '../up', '.git', 'CON', 'a\\b', '50%', 'x'.repeat(181)]) {
      assert.ok(!isPlainTitle(title), title);
    }
  });
});
