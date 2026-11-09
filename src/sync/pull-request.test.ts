// Step 2 of the sync through the command line, against a local git remote
// and a fake GitHub and Linear: after a confirmed initial sync, people edit
// documents in Linear; the sync captures the edits onto `linear`, opens the
// one sync pull request, and merges it with a merge commit in a later run,
// once every check on its head has finished and passed.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeCheck, type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { SYNC_PULL_REQUEST_TITLE } from './pull-request.ts';
import { CHECK_NAME } from '../../test/corpus/check-workflow.ts';

const CANARY = 'kx-3c9d1e72';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;
const MANY = 20;

const TREE: Record<string, string> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\nFirst paragraph.\n\nSecond paragraph. ${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two. ${CANARY}\n`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/guide.md': `# Guide\n\nHow to start. ${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
  ...Object.fromEntries(Array.from({ length: MANY }, (_, i) => [`eng/notes/item-${i}.md`, `# Item ${i}\n\nOpen. ${CANARY}\n`])),
  ...Object.fromEntries(Array.from({ length: MANY }, (_, i) => [`combined/page-${i}.md`, `# Page ${i}\n\nDraft. ${CANARY}\n`])),
};

const SYNC_BRANCH = 'refs/heads/mdbisync/linear';

describe('sync: the sync pull request', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  /** The tracked branch after initial sync: every later commit on it must be the scenario's own or a sync merge (I3). */
  let start: string;
  /** Every value the sync branch held, in order: it only moves forward (I4). */
  let syncValues: string[];
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    world = fakeWorld();
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    start = await rev('refs/heads/main');
    syncValues = [];
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
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const writesBefore = world.writes.length;
    const result = await runCli([command], { env: env(extra), cwd, fetch: fakeFetch(world) });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    const texts = [result.stdout, result.stderr, summary, JSON.stringify(report), ...world.github.pullRequests.map((pr) => `${pr.title}\n${pr.body}`)];
    for (const text of texts) assert.ok(!text.includes(CANARY), 'content reached the output or a pull request (I5)');
    return { result, report, summary, writes: world.writes.slice(writesBefore) };
  }

  /** One sync run, with the invariants every run keeps. */
  async function sync() {
    const run = await cli('sync');
    const head = await fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], { okCodes: [0, 1] });
    if (head.code === 0) {
      const value = head.stdout.toString('utf8').trim();
      const previous = syncValues.at(-1);
      if (previous !== undefined && previous !== value) {
        const forward = await fixture.remote.run(['merge-base', '--is-ancestor', previous, value], { okCodes: [0, 1] });
        assert.equal(forward.code, 0, 'the sync branch was force-pushed (I4)');
      }
      syncValues.push(value);
    }
    await assertTrackedHistory();
    return run;
  }

  /** GitHub's merge with a merge commit, done on the bare remote: parents (base, head), refused when the head moved. */
  async function mergeOnRemote(pr: { head: string; base: string; number: number }, sha: string): Promise<{ sha: string } | { status: number }> {
    if ((await rev(`refs/heads/${pr.head}`)) !== sha) return { status: 409 };
    const base = await rev(`refs/heads/${pr.base}`);
    const merged = await fixture.remote.run(['merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
    if (merged.code !== 0) return { status: 405 };
    const tree = merged.stdout.toString('utf8').split('\n')[0] as string;
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-p', sha, '-m', `Merge pull request #${pr.number} from owner/${pr.head}`], {
      env: { GIT_AUTHOR_NAME: 'sync-app[bot]', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.com' },
    });
    await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
    return { sha: commit };
  }

  /** I3: every commit the tracked branch gained is a two-parent merge whose second parent was a head of the sync branch. */
  async function assertTrackedHistory() {
    const lines = (await fixture.remote.text(['rev-list', '--first-parent', '--parents', `${start}..refs/heads/main`])).split('\n').filter(Boolean);
    for (const line of lines) {
      const [commit, ...parents] = line.split(' ');
      assert.equal(parents.length, 2, `${commit} on the tracked branch is not a merge commit (I3)`);
      assert.ok(syncValues.includes(parents[1] as string), `${commit} merges something other than the sync branch (I3)`);
    }
  }

  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  const ids = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const documentOf = async (path: string): Promise<FakeDocument> => {
    const id = (await ids())[path]?.id;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  };
  /** An edit made in Linear by a person. */
  async function editInLinear(path: string, content: string) {
    const document = await documentOf(path);
    document.content = content;
    touch(document);
  }
  const checksOn = (sha: string, checks: FakeCheck[]) => world.github.checks?.set(sha, checks);
  const openPullRequests = () => world.github.pullRequests.filter((pr) => pr.state === 'open');

  it('L2-20: a Linear edit reaches the tracked branch through the sync pull request, merged with a merge commit, front matter kept', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps one, two and three. ${CANARY}\n`);

    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.writes, ['POST /pulls'], 'the first run opens the pull request and writes nothing to Linear');
    const [pr] = world.github.pullRequests;
    assert.ok(pr !== undefined);
    assert.deepEqual({ head: pr.head, base: pr.base, title: pr.title, state: pr.state }, { head: 'mdbisync/linear', base: 'main', title: SYNC_PULL_REQUEST_TITLE, state: 'open' });
    assert.match(pr.body, /eng\/notes\/plan\.md/);
    assert.equal(await rev('refs/heads/main'), start, 'the tracked branch moved before the merge');
    assert.equal(first.report.pullRequest?.pullRequest?.opened, true);
    assert.match(first.summary, /Opened the sync pull request/);

    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.deepEqual(second.writes, ['PUT /pulls/1/merge']);
    assert.equal(pr.merged, true);
    const main = await rev('refs/heads/main');
    assert.equal((await fixture.remote.text(['show', '-s', '--format=%P', main])).split(' ').length, 2, 'not a merge commit');
    assert.equal(await show('refs/heads/main:eng/notes/plan.md'), `---\nowner: example\n---\n\n# Plan\n\nSteps one, two and three. ${CANARY}\n`);
    assert.match(second.summary, /Merged the sync pull request with a merge commit/);
  });

  it('L2-34: the run started by the merge writes nothing and opens no pull request', async () => {
    await editInLinear('eng/backend/notes.md', `# Notes\n\nFirst paragraph.\n\nSecond paragraph, longer. ${CANARY}\n`);
    await sync();
    await sync();
    assert.equal(world.github.pullRequests[0]?.merged, true);

    const linearWrites = world.linear.writes.count;
    const after = await sync();
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.deepEqual(after.writes, []);
    assert.equal(world.linear.writes.count, linearWrites, 'the run after the merge wrote to Linear');
    assert.equal(world.github.pullRequests.length, 1);
    assert.match(after.summary, /no pull request is needed/);
    assert.equal(after.report.pullRequest?.needed, false);

    const again = await sync();
    assert.deepEqual(again.writes, []);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('L2-31: edits to many documents in two teams arrive in one pull request, merged once', async () => {
    for (let i = 0; i < MANY; i += 1) {
      await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nDone. ${CANARY}\n`);
      await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nPublished. ${CANARY}\n`);
    }
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(first.report.pullRequest?.paths.length, 2 * MANY);
    const second = await sync();
    assert.deepEqual(second.writes, ['PUT /pulls/1/merge']);
    assert.equal(world.github.pullRequests.length, 1);
    const merges = (await fixture.remote.text(['rev-list', '--merges', `${start}..refs/heads/main`])).split('\n').filter(Boolean);
    assert.equal(merges.length, 1);
    for (let i = 0; i < MANY; i += 1) {
      assert.match(await show(`refs/heads/main:eng/notes/item-${i}.md`), /Done\./);
      assert.match(await show(`refs/heads/main:combined/page-${i}.md`), /Published\./);
    }
  });

  it('L2-32: new edits while the pull request waits for checks join its branch; one pull request, never force-pushed', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps one and two, reviewed. ${CANARY}\n`);
    await sync();
    const firstHead = await rev(SYNC_BRANCH);
    checksOn(firstHead, [{ name: 'lint', status: 'in_progress' }]);

    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.deepEqual(waiting.writes, [], 'a run merged or changed something while checks ran');
    assert.match(waiting.summary, /waits for `lint`/);
    assert.deepEqual(waiting.report.pullRequest?.checks?.pending, ['lint']);

    await editInLinear('combined/guide.md', `# Guide\n\nHow to start, step by step. ${CANARY}\n`);
    const joined = await sync();
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    const secondHead = await rev(SYNC_BRANCH);
    assert.notEqual(secondHead, firstHead);
    assert.equal(openPullRequests().length, 1);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(joined.report.pullRequest?.branchMoved, true);
    assert.ok(!joined.writes.includes('PUT /pulls/1/merge'), 'merged a head whose checks had not run');
    assert.match(world.github.pullRequests[0]?.body ?? '', /combined\/guide\.md/);

    checksOn(secondHead, [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
      { name: 'ci/external', status: 'completed', conclusion: 'success', commitStatus: true },
    ]);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /reviewed/);
    assert.match(await show('refs/heads/main:combined/guide.md'), /step by step/);
  });

  it('L5-17: a failed check leaves the pull request open and Linear untouched, then merges after repair', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nA new step. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: CHECK_NAME, status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'in_progress' },
    ]);
    // A tracked edit would write to Linear if the failed check did not stop
    // the write step. It must remain pending until the check is repaired.
    const path = 'combined/guide.md';
    const content = `# Guide\n\nA pending tracked edit. ${CANARY}\n`;
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], {input:content});
    const commit = await commitFile(start, path, blob);
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, start]);
    start = commit;
    const before = structuredClone(world.linear.documents);
    const failed = await sync();
    assert.equal(failed.result.exitCode, SETUP_FAILED_EXIT_CODE, failed.result.stderr);
    assert.match(failed.result.stderr, /setup error \(check-failed\)/);
    assert.match(failed.summary, /Setup error: a check failed on the sync pull request \[#1\]\(.*\): `format`/);
    assert.equal(failed.report.pullRequest?.code, 'check-failed');
    assert.deepEqual(failed.writes, []);
    assert.equal(world.github.pullRequests[0]?.merged, false);
    assert.equal(openPullRequests().length, 1);
    assert.deepEqual(world.linear.documents, before);
    assert.equal(failed.report.sync, null);
    assert.equal(await rev('refs/heads/main'), start);
    checksOn(await rev(SYNC_BRANCH), [{name:CHECK_NAME, status:'completed', conclusion:'success'}]);
    const repaired = await sync();
    assert.equal(repaired.result.exitCode, 0, repaired.result.stderr);
    assert.ok(repaired.report.pullRequest?.merged);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(openPullRequests().length, 0);
    assert.equal((await documentOf(path)).content, content);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /A new step/);
  });

  it('L5-22: captures a huge Linear document byte for byte, warns, and never writes an oversized git edit back', async () => {
    const path = 'eng/notes/large.md';
    const content = `${CANARY}\n\n${'a'.repeat(260_000)}\n`;
    world.linear.documents.push({id:'large', title:'large', content, projectId:'project-api', createdAt:'2026-02-01T00:00:00Z'});
    const before = structuredClone(world.linear.documents);
    const captured = await sync();
    assert.equal(captured.result.exitCode, 0, captured.result.stderr);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), content);
    assert.deepEqual(captured.report.capture?.writeBackWarnings, [{path, code:'linear-content-too-large-to-write-back', length:content.length, limit:250_000}]);
    assert.match(captured.summary, /Linear will not accept it back if it is changed in git/);
    assert.match(captured.summary, /eng\/notes\/large\.md/);
    assert.deepEqual(captured.writes, ['POST /pulls']);
    checksOn(await rev(SYNC_BRANCH), [{name:CHECK_NAME, status:'completed', conclusion:'success'}]);
    const merged = await sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.equal(await show(`refs/heads/main:${path}`), content);
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.deepEqual(world.linear.documents, before);

    const base = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], {input:content + 'Another paragraph.\n'});
    start = await commitFile(base, path, blob);
    await fixture.remote.run(['update-ref', 'refs/heads/main', start, base]);
    const edited = await sync();
    assert.equal(edited.result.exitCode, 0, edited.result.stderr);
    assert.ok(edited.report.sync?.leftOut.some((entry) => entry.path === path && entry.rules.includes('content-too-long')));
    assert.deepEqual(edited.writes, []);
    assert.deepEqual(world.linear.documents, before);
  });

  it('the GitHub Action fails on a failed check too, with the code as its output', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nA step for the action. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'secrets', status: 'completed', conclusion: 'failure' }]);

    const saved = { env: { ...process.env }, fetch: globalThis.fetch, write: process.stdout.write, exitCode: process.exitCode };
    let output = '';
    try {
      for (const [name, value] of Object.entries(env({}))) {
        if (name.startsWith('MDBISYNC_')) process.env[`INPUT_${name.slice('MDBISYNC_'.length).replaceAll('_', '-')}`] = value;
      }
      Object.assign(process.env, { INPUT_OPERATION: 'sync', GITHUB_WORKSPACE: cwd, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' });
      globalThis.fetch = fakeFetch(world);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      const { run } = await import('../action/main.ts');
      await run();
      assert.equal(process.exitCode, 1);
    } finally {
      process.stdout.write = saved.write;
      globalThis.fetch = saved.fetch;
      process.exitCode = saved.exitCode;
      for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
      Object.assign(process.env, saved.env);
    }
    assert.match(output, /::error::sync: setup error \(check-failed\)/);
    assert.match(output, /::set-output name=code::check-failed/);
    assert.equal(world.github.pullRequests[0]?.merged, false);
  });

  it('a record left on the sync branch by a closed pull request is not carried into the next sync pull request', async () => {
    const main = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAbandoned text. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    await fixture.remote.run(['update-ref', SYNC_BRANCH, record]);
    syncValues.push(record);
    world.github.pullRequests.push({ number: 1, title: 'Initial sync from Linear', body: '', head: 'mdbisync/linear', base: 'main', state: 'closed', merged: false });
    await editInLinear('eng/notes/plan.md', `# Plan\n\nCarried. ${CANARY}\n`);

    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.report.pullRequest?.paths, ['eng/notes/plan.md']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/2/merge'], JSON.stringify(merged.report.pullRequest));
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Carried\./);
    assert.doesNotMatch(await show('refs/heads/main:combined/guide.md'), /Abandoned/);
  });

  it('a sync branch holding an initial sync from Linear that changed nothing is reused', async () => {
    // Such a record needed no pull request, so the tracked branch never merges it.
    const main = await rev('refs/heads/main');
    const record = await fixture.remote.text(['commit-tree', `${main}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    await fixture.remote.run(['update-ref', SYNC_BRANCH, record]);
    syncValues.push(record);
    await editInLinear('eng/notes/plan.md', `# Plan\n\nReused. ${CANARY}\n`);
    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Reused\./);
  });

  it('a commit status that fails counts as a failed check', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nAnother step. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci/external', status: 'completed', conclusion: 'error', commitStatus: true }]);
    const failed = await sync();
    assert.equal(failed.result.exitCode, SETUP_FAILED_EXIT_CODE, failed.result.stderr);
    assert.deepEqual(failed.report.pullRequest?.checks?.failed, ['ci/external']);
  });

  it('git edits alone open no pull request, run after run (L2-01)', async () => {
    for (const text of ['Edited once.', 'Edited twice.']) {
      const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\n${text} ${CANARY}\n` });
      const base = await rev('refs/heads/main');
      const commit = await commitFile(base, 'combined/guide.md', blob);
      await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
      // The person's commit is the scenario's own (I3), not a sync merge.
      start = commit;
      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.deepEqual(run.writes.filter((write) => write.includes('/pulls')), []);
      assert.equal(run.report.pullRequest?.needed, false);
    }
    assert.deepEqual(world.github.pullRequests, []);
    assert.equal((await documentOf('combined/guide.md')).content, `# Guide\n\nEdited twice. ${CANARY}\n`);
  });

  it('a merge GitHub refuses because the head moved is tried again by a later run', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps, refined. ${CANARY}\n`);
    await sync();
    let refuse = true;
    world.github.merge = async (pr, sha) => (refuse ? ((refuse = false), { status: 409 }) : mergeOnRemote(pr, sha));
    const refused = await sync();
    assert.equal(refused.result.exitCode, 0, refused.result.stderr);
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    assert.match(refused.summary, /GitHub did not merge the sync pull request \[#1\]\(.*\) \(HTTP 409\)/);
    const again = await sync();
    assert.deepEqual(again.writes, ['PUT /pulls/1/merge']);
  });

  it('never reuses a sync branch that holds an unmerged initial sync from Linear', async () => {
    // The sync branch holds such a record, which changes the tracked branch and
    // which a person has not merged, while `linear` has moved on.
    const main = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAs Linear holds it. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    await fixture.remote.run(['update-ref', SYNC_BRANCH, record]);
    world.github.pullRequests.push({ number: 1, title: 'Initial sync from Linear', body: '', head: 'mdbisync/linear', base: 'main', state: 'open', merged: false });
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNot yet. ${CANARY}\n`);
    const linearWrites = world.linear.writes.count;

    const run = await sync();
    assert.equal(run.result.exitCode, NO_STATE_EXIT_CODE, run.result.stderr);
    assert.equal(run.report.pullRequest?.code, 'initial-pull-request-pending');
    assert.equal(await rev(SYNC_BRANCH), record);
    assert.deepEqual(run.writes, []);
    assert.equal(world.linear.writes.count, linearWrites);
    assert.match(run.summary, /a person has not merged yet/);
  });

  /** A commit on `base` with one file replaced, made on the bare remote. */
  async function commitFile(base: string, path: string, blob: string): Promise<string> {
    const index = join(fixture.root, 'scratch.index');
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await fixture.remote.run(['read-tree', base], { env });
    await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    const tree = await fixture.remote.text(['write-tree'], { env });
    return fixture.remote.text(['commit-tree', tree, '-p', base, '-m', 'Edit'], { env });
  }
});
