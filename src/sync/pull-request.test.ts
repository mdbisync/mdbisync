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
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { detectConflicts, MARKERS } from '../merge/index.ts';
import { MARKS } from './marks.ts';
import { HOLD_MARK_LIMIT, HOLD_TIMED_OUT } from './hold.ts';
import { APP_PERMISSIONS } from '../setup/app.ts';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { FAKE_APP_IDENTITY, FAKE_APP_SLUG, type FakeCheck, type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { type Fixture, IDENTITY, createFixture } from '../state/test-helpers.ts';
import { DEFAULT_MERGE_GRACE_SECONDS, SYNC_PULL_REQUEST_TITLE } from './pull-request.ts';
import { type CheckClock } from '../pull-request/index.ts';
import { DEFAULT_CHECK_DEADLINE_MINUTES } from './deadline.ts';
import { CHECK_NAME } from '../../test/corpus/check-workflow.ts';

const CANARY = 'kx-3c9d1e72';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: stable-fix
      - id: aligned-table
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
  let fetchOverride: typeof fetch | undefined;
  let concurrentMove = false;
  let deletedSuspendedDuringRun = false;
  /** The tracked branch after initial sync: every later commit on it must be the scenario's own or a sync merge (I3). */
  let start: string;
  /** Every value the sync branch held, in order: it only moves forward (I4). */
  let syncValues: string[];
  let normalValues: string[];
  /** Every request that reached Linear (token, GraphQL, revocation), in order. */
  const linearRequests: string[] = [];
  /** Every request that reached GitHub, as `METHOD url`, in order. */
  const githubRequests: string[] = [];
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    world = fakeWorld();
    fetchOverride = undefined;
    concurrentMove = false;
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    start = await rev('refs/heads/main');
    syncValues = [];
    normalValues = [];
  });
  afterEach(() => fixture.cleanup());

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: reportFile(),
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  /**
   * A clock for a run's waits for checks that moves only when the run sleeps:
   * a read takes no time on it and is never cut off at the grace deadline, so
   * what a run reads within its grace never depends on how fast the machine
   * is, and a grace costs no real time.
   */
  function virtualClock(): CheckClock {
    let elapsed = 0;
    return { now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, timeout: () => new AbortController().signal };
  }

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const writesBefore = world.writes.length;
    deletedSuspendedDuringRun = false;
    const mark = await markWorld(world, fixture);
    const linearBefore = linearRequests.length;
    const counted = fetchOverride ?? fakeFetch(world);
    const clock = virtualClock();
    const result = await runCli([command], { env: env(extra), cwd, checkClock: clock, fetch: async (input, init) => { if (String(input).startsWith(LINEAR_API)) linearRequests.push(String(input)); if (String(input).startsWith(GITHUB_API)) githubRequests.push(`${init?.method ?? 'GET'} ${String(input)}`); return counted(input, init); } });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    const texts = [result.stdout, result.stderr, summary, JSON.stringify(report), ...world.github.pullRequests.map((pr) => `${pr.title}\n${pr.body}`)];
    for (const text of texts) assert.ok(!text.includes(CANARY), 'content reached the output or a pull request (I5)');
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: fetchOverride !== undefined, movedByOthers: [...(concurrentMove ? ['ids'] as const : []), ...(deletedSuspendedDuringRun ? ['suspendedBranch'] as const : [])] });
    return { result, report, summary, clock, writes: world.writes.slice(writesBefore), linearRequests: linearRequests.length - linearBefore };
  }

  /** One sync run, with the invariants every run keeps. */
  async function sync(extra: Record<string, string> = {}) {
    const run = await cli('sync', extra);
    const suspended = await fixture.remote.run(['rev-parse', '--verify', '--quiet', 'refs/heads/mdbisync/suspended'], { okCodes: [0, 1] });
    if (suspended.code === 0) syncValues.push(suspended.stdout.toString('utf8').trim());
    const head = await fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], { okCodes: [0, 1] });
    if (head.code === 0) {
      const value = head.stdout.toString('utf8').trim();
      const previous = normalValues.at(-1);
      if (previous !== undefined && previous !== value) {
        const forward = await fixture.remote.run(['merge-base', '--is-ancestor', previous, value], { okCodes: [0, 1] });
        assert.equal(forward.code, 0, 'the sync branch was force-pushed (I4)');
      }
      syncValues.push(value);
      normalValues.push(value);
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
  const commentsOf = (document: FakeDocument) => [...world.linear.comments.values()].filter((comment) => comment.documentContentId === `content-${document.id}`);
  const openPullRequests = () => world.github.pullRequests.filter((pr) => pr.state === 'open');

  it('keeps action and CLI merge-grace defaults aligned', async () => {
    const action = await readFile('action.yml', 'utf8');
    assert.match(action, new RegExp(`merge-grace-seconds:[\\s\\S]*?default: \"${DEFAULT_MERGE_GRACE_SECONDS}\"`));
    assert.match(action, new RegExp(`check-deadline-minutes:[\\s\\S]*?default: \"${DEFAULT_CHECK_DEADLINE_MINUTES}\"`));
  });

  it('merges a new pull request in the same run after checks pass', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const transport = fakeFetch(world);
    let observations = 0;
    fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?') && world.github.pullRequests.length > 0) {
        checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: ++observations === 1 ? 'in_progress' : 'completed', conclusion: 'success' }]);
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, ['POST /pulls', 'PUT /pulls/1/merge']);
    assert.ok(run.report.pullRequest?.merged);
    const head = await rev(SYNC_BRANCH);
    assert.equal((await fixture.remote.text(['show', '-s', '--format=%P', await rev('refs/heads/main')])).split(' ')[1], head);
  });

  it('merges an existing pull request in the run that advances its head', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nFirst edit.\n');
    await sync();
    const firstHead = await rev(SYNC_BRANCH);
    await editInLinear('eng/notes/plan.md', '# Plan\n\nSecond edit.\n');
    const transport = fakeFetch(world);
    fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?')) {
        const head = await rev(SYNC_BRANCH);
        checksOn(head, [{ name: 'ci', status: 'completed', conclusion: 'success' }]);
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.branchMoved, true);
    assert.ok(run.report.pullRequest?.merged);
    assert.notEqual(await rev(SYNC_BRANCH), firstHead);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('leaves pending checks open at the grace deadline, and suspends failed checks', async () => {
    for (const failed of [false, true]) {
      await editInLinear('eng/notes/plan.md', `# Plan\n\nReady ${failed}.\n`);
      const transport = fakeFetch(world);
      fetchOverride = async (input, init) => {
        if (String(input).includes('/check-runs?') && world.github.pullRequests.length > 0) checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: failed ? 'completed' : 'queued', conclusion: 'failure' }]);
        return transport(input, init);
      };
      const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '1' });
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.equal(run.report.pullRequest?.merged, null);
      assert.equal(await rev('refs/heads/main'), start);
      if (failed) assert.ok(run.report.pullRequest?.suspended);
      else assert.match(run.summary, /Waiting for `ci`/);
    }
  });

  it('merges a head with no checks after the registration settle time using the default grace', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '' });
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.ok(run.report.pullRequest?.merged);
    assert.ok(run.clock.now() >= 15_000, 'merged before the registration settle time');
    const quiet = await cli('sync');
    assert.deepEqual(quiet.writes, []);
  });

  // The deadline covers registered checks only. A required check that never
  // registers is not read as pending: the sync tries the merge, GitHub refuses
  // it for the missing check, and the repeated refusal is a setup error. Nothing
  // is suspended or marked, even past the deadline, because no check result
  // blames the batch's documents.
  for (const registered of [[], [{ name: 'build', status: 'completed', conclusion: 'success' }]] satisfies FakeCheck[][]) {
    it(`a required check that never registers ${registered.length === 0 ? 'on a head with no checks' : 'beside a passing check'} is a merge refusal, not a deadline suspension`, async () => {
      const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
      const path = 'eng/notes/plan.md';
      await editInLinear(path, `# Plan\n\nWaits for a check that never runs. ${CANARY}\n`);
      await sync(deadline);
      checksOn(await rev(SYNC_BRANCH), registered);
      const missing = 'Repository rule violations found\n\nRequired status check "lint" is expected.';
      const reason = 'Repository rule violations found Required status check "lint" is expected.';
      world.github.merge = async () => ({ status: 405, message: missing });

      const requestsBefore = githubRequests.length;
      const refused = await sync(deadline);
      assert.equal(refused.result.exitCode, 0, refused.result.stderr);
      assert.equal(refused.report.pullRequest?.code, 'merge-refused');
      assert.equal(refused.report.pullRequest?.reason, reason);
      assert.equal(refused.report.pullRequest?.suspended, undefined);
      assert.ok(githubRequests.slice(requestsBefore).some((request) => request.startsWith('PUT ') && request.endsWith('/pulls/1/merge')), 'the sync tried the merge');
      // The refusal is noted on the pull request, which is what lets the next run call it repeated.
      assert.deepEqual(refused.writes, ['PATCH /pulls/1']);
      assert.ok(openPullRequests()[0]?.body.includes('Required status check "lint" is expected.'), 'the pull request names the refusal');

      backdate('mdbisync/linear', 11);
      const blocked = await sync(deadline);
      assert.equal(blocked.result.exitCode, SETUP_FAILED_EXIT_CODE, blocked.result.stderr);
      assert.equal(blocked.report.pullRequest?.code, 'merge-blocked');
      assert.equal(blocked.report.pullRequest?.suspended, undefined);
      assert.ok(blocked.summary.includes(reason), blocked.summary);
      assert.match(blocked.summary, /make that check run on the sync pull request/);
      assert.deepEqual(blocked.writes, []);
      assert.deepEqual(openPullRequests().map((pr) => pr.head), ['mdbisync/linear']);
      assert.equal(await rev('refs/heads/main'), start);
      const document = await documentOf(path);
      assert.notEqual(document.icon, MARKS.suspended.icon);
      assert.deepEqual(commentsOf(document), []);
      assertNoRerun();
    });
  }

  // The time limit turns a wait that never ends into this test's own failure instead of a stalled suite.
  it('cannot merge a branch that moves while waiting using checks from its old head', { timeout: 60_000 }, async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nReady.\n');
    const transport = fakeFetch(world);
    let observations = 0;
    fetchOverride = async (input, init) => {
      if (String(input).includes('/check-runs?') && world.github.pullRequests.length > 0) {
        const head = await rev(SYNC_BRANCH);
        checksOn(head, [{ name: 'ci', status: ++observations === 1 ? 'queued' : 'completed', conclusion: 'success' }]);
        if (observations === 2) {
          const tree = await rev(`${head}^{tree}`);
          const next = await fixture.remote.text(['commit-tree', tree, '-p', head, '-m', 'Concurrent edit'], {
            env: { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email },
          });
          await fixture.remote.run(['update-ref', SYNC_BRANCH, next, head]);
        }
      }
      return transport(input, init);
    };
    const run = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '25' });
    assert.ok(observations >= 2, `the run read the checks ${observations} times, so the branch never moved while it waited`);
    assert.equal(run.report.pullRequest?.merged, null);
    assert.equal(run.report.pullRequest?.code, 'merge-refused');
    assert.equal(await rev('refs/heads/main'), start);
  });

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

  it('L5-17: a failed check suspends its batch, unrelated git writes go on, then it releases', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, `# Plan\n\nA new step. ${CANARY}\n`);
    await sync();
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    checksOn(await rev(SYNC_BRANCH), [{ name: CHECK_NAME, status: 'completed', conclusion: 'failure', annotations: [
      { path, start_line: 3, title: 'Lists', message: 'Expected a blank line before the list.' },
      { path, start_line: 3, message: `Found A new step. ${CANARY} here` },
      { path: 'combined/guide.md', start_line: 1, message: 'Another file.' },
    ] }]);
    const other = 'combined/guide.md';
    const content = `# Guide\n\nA tracked edit. ${CANARY}\n`;
    await gitEdit(other, content);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.ok(failed.report.pullRequest?.suspended);
    assert.match(failed.summary, /Suspended changes/);
    assert.equal(world.github.pullRequests[0]?.state, 'closed');
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal((await documentOf(other)).content, content);
    assert.doesNotMatch(await show(`refs/heads/main:${path}`), /A new step/);
    assert.match(await show(`refs/heads/mdbisync/suspended:${path}`), /A new step/);
    // The red mark and one comment: the check, a link to its run and its annotations on this file only.
    const held = await documentOf(path);
    assert.deepEqual({ icon: held.icon, color: held.color }, MARKS.suspended);
    const notes = commentsOf(held);
    assert.equal(notes.length, 1);
    const note = notes[0]?.body ?? '';
    assert.match(note, /^Changes to this document are on hold: a check failed/);
    assert.ok(note.includes(`- Check \`${CHECK_NAME}\`: [run](https://github.test/owner/repo/runs/`), note);
    assert.match(note, / {2}- Line 3: Lists: Expected a blank line before the list\./);
    // A message that repeats the document's text is left out: only its line is shown.
    assert.match(note, / {2}- Line 3\.\n/);
    assert.doesNotMatch(note, /Another file/);
    assert.deepEqual(failed.report.pullRequest?.holdMarks?.set, [path]);
    checksOn(await rev('refs/heads/mdbisync/suspended'), [{ name: CHECK_NAME, status: 'completed', conclusion: 'success' }]);
    const repaired = await sync();
    assert.equal(repaired.result.exitCode, 0, repaired.result.stderr);
    assert.ok(repaired.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().length, 0);
    assert.match(await show(`refs/heads/main:${path}`), /A new step/);
    // Release clears it: the document's own icon and color come back and the comment is resolved, not deleted.
    const released = await documentOf(path);
    assert.deepEqual({ icon: released.icon ?? null, color: released.color ?? null }, own);
    assert.equal(commentsOf(released).length, 1);
    assert.equal(commentsOf(released)[0]?.resolved, true);
    assert.deepEqual(repaired.report.pullRequest?.holdMarks?.cleared, [path]);
    assert.equal('saved' in ((await ids())[path] as object), false);
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
    assertNoRerun();
  });

  it('L5-35: a batch of 60 suspended documents is marked 50 in one run and 10 in the next, within I9', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nClosed.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nFinal.\n`);
    for (let i = 0; i < MANY; i += 1) {
      world.linear.documents.push({ id: `fresh-${i}`, title: `fresh-${i}`, projectId, content: `# Fresh ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    // I9: 1.5 per written document, 5 per run, and 2 per document whose suspended mark or comment changed.
    const withinBudget = (run: Awaited<ReturnType<typeof sync>>) => {
      const marks = run.report.pullRequest?.holdMarks;
      const changes = (marks?.set.length ?? 0) + (marks?.updated.length ?? 0) + (marks?.cleared.length ?? 0);
      const written = run.writes.filter((write) => write === 'CreateDocument').length + run.writes.filter((write) => write === 'UpdateDocument').length - changes;
      assert.ok(run.linearRequests <= 1.5 * Math.max(written, 0) + 5 + 2 * changes, `${run.linearRequests} Linear requests for ${changes} mark changes and ${written} written documents`);
    };
    const first = await sync();
    assert.ok(first.report.pullRequest?.suspended);
    assert.equal(first.report.pullRequest?.holdMarks?.set.length, HOLD_MARK_LIMIT);
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    assert.match(first.summary, /10 more suspended documents get their mark or comment in a later run/);
    withinBudget(first);
    checksOn(await rev(SUSPENDED), FAILED);
    const second = await sync();
    assert.equal(second.report.pullRequest?.holdMarks?.set.length, 60 - HOLD_MARK_LIMIT);
    assert.equal(second.report.pullRequest?.holdMarks?.deferred, 0);
    withinBudget(second);
    const held = Object.entries(await ids()).filter(([, entry]) => (entry as { suspended?: unknown }).suspended !== undefined).map(([path]) => path);
    assert.equal(held.length, 60);
    for (const path of held) {
      const document = await documentOf(path);
      assert.equal(document.icon, MARKS.suspended.icon);
      assert.equal(commentsOf(document).length, 1);
    }
    // A long suspension costs nothing per run: the held documents are not read again.
    const idle = await sync();
    assert.equal(idle.report.pullRequest?.holdMarks, undefined);
    assert.ok(idle.linearRequests <= 5, `an idle suspended run made ${idle.linearRequests} Linear requests`);
  });

  it('a batch that joins while earlier documents still wait for their mark describes only its own documents', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nClosed.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nFinal.\n`);
    for (let i = 0; i < MANY; i += 1) {
      world.linear.documents.push({ id: `fresh-${i}`, title: `fresh-${i}`, projectId, content: `# Fresh ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const first = await sync();
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    const waiting = Object.entries(await ids()).filter(([, entry]) => (entry as { suspended?: unknown; saved?: unknown }).suspended !== undefined && (entry as { saved?: unknown }).saved === undefined).map(([path]) => path);
    assert.equal(waiting.length, 60 - HOLD_MARK_LIMIT);
    // The suspended head fails `ci` again; a new normal batch fails `spelling` within the same run.
    checksOn(await rev(SUSPENDED), FAILED);
    const spelling: FakeCheck[] = [{ name: 'spelling', status: 'completed', conclusion: 'failure' }];
    const known = world.github.checks as Map<string, FakeCheck[]>;
    world.github.checks = new (class extends Map<string, FakeCheck[]> { override get(sha: string) { return super.get(sha) ?? spelling; } })(known);
    // The tracked branch's tip has no such failure: `spelling` is the new batch's own (not a red tracked branch).
    checksOn(await rev('refs/heads/main'), []);
    await editInLinear('eng/backend/notes.md', '# Notes\n\nA joining edit.\n');
    const joined = await cli('sync', { MDBISYNC_MERGE_GRACE_SECONDS: '5' });
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    assert.ok(joined.report.pullRequest?.suspended);
    assert.match(commentsOf(await documentOf('eng/backend/notes.md'))[0]?.body ?? '', /Check `spelling`/);
    for (const path of waiting) {
      const body = commentsOf(await documentOf(path))[0]?.body ?? '';
      assert.match(body, /Check `ci`: \[run\]/, path);
      assert.doesNotMatch(body, /spelling/, path);
    }
  });

  it('L5-25: a Linear edit of a suspended document reaches only the suspended pull request and releases it', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const normal = await rev(SYNC_BRANCH);
    const before = commentsOf(await documentOf(path)).map(({ body }) => body);
    await editInLinear(path, '# Plan\n\nThe fixed line.\n');
    const intake = await sync();
    assert.equal(intake.result.exitCode, 0, intake.result.stderr);
    assert.equal(await rev(SYNC_BRANCH), normal, 'the normal lane took a suspended edit');
    assert.doesNotMatch(await show(`${SYNC_BRANCH}:${path}`), /The fixed line/);
    assert.match(await show(`${SUSPENDED}:${path}`), /The fixed line/);
    // Still held while its checks run: the mark and the one comment stay.
    assert.deepEqual(commentsOf(await documentOf(path)).map(({ body }) => body), before);
    assert.equal((await documentOf(path)).icon, MARKS.suspended.icon);
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.match(await show(`refs/heads/main:${path}`), /The fixed line/);
    const document = await documentOf(path);
    assert.notEqual(document.icon, MARKS.suspended.icon);
    assert.equal(commentsOf(document).length, 1);
    assert.equal(commentsOf(document)[0]?.resolved, true);
  });

  it('edits the one comment of an episode when a later head fails differently, and starts a new one for a new episode', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const first = commentsOf(await documentOf(path));
    assert.equal(first.length, 1);
    assert.match(first[0]?.body ?? '', /Check `ci`/);
    // The suspended head fails on another check: the same comment says so, no second comment.
    await editInLinear(path, '# Plan\n\nAnother held edit.\n');
    await sync();
    checksOn(await rev(SUSPENDED), [{ name: 'format', status: 'completed', conclusion: 'failure', annotations: [{ path, start_line: 1, message: 'Heading level.' }] }]);
    const changed = await sync();
    assert.deepEqual(changed.report.pullRequest?.holdMarks?.updated, [path]);
    const edited = commentsOf(await documentOf(path));
    assert.equal(edited.length, 1);
    assert.match(edited[0]?.body ?? '', /Check `format`/);
    assert.match(edited[0]?.body ?? '', /Line 1: Heading level\./);
    // An unchanged failure writes nothing.
    const idle = await sync();
    assert.equal(idle.report.pullRequest?.holdMarks, undefined);
    assert.deepEqual(idle.writes.filter((write) => !write.startsWith('PATCH /pulls/')), []);
    await releaseHeld();
    assert.equal(commentsOf(await documentOf(path))[0]?.resolved, true);
    // Suspended again later: a new episode, a new comment.
    await suspendOne(path, '# Plan\n\nA second episode.\n');
    const again = commentsOf(await documentOf(path));
    assert.equal(again.length, 2);
    assert.equal(again.filter((comment) => comment.resolved !== true).length, 1);
  });

  it('a joining batch names its own failure on its own documents and leaves the earlier comments as they are', async () => {
    await suspendOne();
    const firstNote = commentsOf(await documentOf('eng/notes/plan.md'))[0]?.body;
    await editInLinear('combined/guide.md', '# Guide\n\nSecond held edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'spelling', status: 'completed', conclusion: 'failure' }]);
    const joined = await sync();
    assert.deepEqual(joined.report.pullRequest?.holdMarks?.set, ['combined/guide.md']);
    assert.deepEqual(joined.report.pullRequest?.holdMarks?.updated, []);
    assert.equal(commentsOf(await documentOf('eng/notes/plan.md'))[0]?.body, firstNote);
    assert.match(commentsOf(await documentOf('combined/guide.md'))[0]?.body ?? '', /Check `spelling`/);
  });

  it('a check run whose annotations GitHub refuses is named without them, and the marks go on', async () => {
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld Linear edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'lint', status: 'completed', conclusion: 'failure', annotationsStatus: 404, annotations: [{ path, start_line: 1, message: 'Unseen.' }] }]);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.pullRequest?.holdMarks?.set, [path]);
    assert.deepEqual(run.report.pullRequest?.holdMarks?.unreadAnnotations, ['lint']);
    assert.match(run.summary, /GitHub did not give the annotations of `lint`/);
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.match(note, /Check `lint`: \[run\]/);
    assert.doesNotMatch(note, /Unseen/);
  });

  async function gitEdit(path: string, content: string) {
    const base = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: content });
    start = await commitFile(base, path, blob);
    await fixture.remote.run(['update-ref', 'refs/heads/main', start, base]);
  }

  const SUSPENDED = 'refs/heads/mdbisync/suspended';
  const FAILED: FakeCheck[] = [{ name: 'ci', status: 'completed', conclusion: 'failure' }];
  const PASSED: FakeCheck[] = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
  async function suspendOne(path = 'eng/notes/plan.md', content = '# Plan\n\nHeld Linear edit.\n') {
    await editInLinear(path, content);
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.ok(held.report.pullRequest?.suspended);
    checksOn(await rev(SUSPENDED), FAILED);
  }
  async function releaseHeld() {
    // First take any new main or Linear tip, then mark that exact head green.
    checksOn(await rev(SUSPENDED), FAILED);
    await sync();
    checksOn(await rev(SUSPENDED), PASSED);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.ok(run.report.pullRequest?.suspended?.released);
    return run;
  }

  /** Moves the noted push time of the open pull request from `branch` back by `minutes`, as if its head had waited that long. */
  function backdate(branch: string, minutes: number) {
    const pr = openPullRequests().find((item) => item.head === branch);
    assert.ok(pr !== undefined, `no open pull request from ${branch}`);
    const body = pr.body.replace(/^(<!-- head: sha=[0-9a-f]+ since=)[^ ]+( -->)$/m, `$1${new Date(Date.now() - minutes * 60_000).toISOString()}$2`);
    assert.notEqual(body, pr.body, 'the description notes no push time');
    pr.body = body;
  }
  /** No request asked GitHub to rerun or cancel a workflow run or check (the sync never reruns a check). */
  const assertNoRerun = () => {
    for (const request of githubRequests) assert.doesNotMatch(request, /\/actions\/|rerun|rerequest|cancel/, request);
  };

  it('L5-26: a flaky check suspends its batch at once with no rerun request, and a rerun by a person that passes releases it', async () => {
    assert.equal('actions' in APP_PERMISSIONS, false, 'the App asks for no actions permission');
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nA flaky first attempt.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'completed', conclusion: 'failure' }]);
    const failed = await sync();
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.deepEqual(failed.report.pullRequest?.suspended?.checks, ['ci']);
    assert.equal(failed.report.pullRequest?.redMain, undefined);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal((await documentOf(path)).icon, MARKS.suspended.icon);
    // A person reruns the check on the suspended head; the latest run passes and counts.
    checksOn(await rev(SUSPENDED), PASSED);
    const released = await sync();
    assert.equal(released.result.exitCode, 0, released.result.stderr);
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.match(await show(`refs/heads/main:${path}`), /A flaky first attempt/);
    assert.equal(commentsOf(await documentOf(path))[0]?.resolved, true);
    assertNoRerun();
  });

  it('L5-27: a check that never finishes suspends its batch at the deadline, and the comment says it did not finish in time', async () => {
    const deadline = { MDBISYNC_CHECK_DEADLINE_MINUTES: '10' };
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nA change whose check never starts.\n');
    await sync(deadline);
    const head = await rev(SYNC_BRANCH);
    assert.match(openPullRequests()[0]?.body ?? '', new RegExp(`^<!-- head: sha=${head} since=\\S+ -->$`, 'm'));
    checksOn(head, [{ name: 'ci', status: 'queued' }]);
    const waiting = await sync(deadline);
    assert.equal(waiting.report.pullRequest?.suspended, undefined);
    assert.match(waiting.summary, /waits for `ci`/);
    // Short of the deadline the head still waits; the note keeps the push time, so a quiet run writes nothing.
    backdate('mdbisync/linear', 9);
    const early = await sync(deadline);
    assert.equal(early.report.pullRequest?.suspended, undefined);
    assert.deepEqual(early.writes, []);
    backdate('mdbisync/linear', 11);
    const late = await sync(deadline);
    assert.equal(late.result.exitCode, 0, late.result.stderr);
    assert.deepEqual(late.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.deepEqual(late.report.pullRequest?.suspended?.checks, []);
    assert.match(late.summary, /Checks that did not finish in time: `ci`/);
    assert.equal(world.github.pullRequests[0]?.state, 'closed');
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.equal(await rev('refs/heads/main'), start);
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.ok(note.startsWith(HOLD_TIMED_OUT), note);
    assert.match(note, /^- Check `ci` did not finish in time\.$/m);
    // The suspended head never finishes either: past its own deadline the comment already says so and stays.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'queued' }]);
    await sync(deadline);
    backdate('mdbisync/suspended', 11);
    const still = await sync(deadline);
    assert.deepEqual(still.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.equal(still.report.pullRequest?.holdMarks, undefined);
    assert.equal(commentsOf(await documentOf(path))[0]?.body, note);
    assertNoRerun();
  });

  it('the input check-deadline-minutes is noted per head: a new head starts its own clock', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nFirst.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'queued' }]);
    backdate('mdbisync/linear', 59);
    await editInLinear('combined/guide.md', '# Guide\n\nSecond.\n');
    const moved = await sync();
    assert.equal(moved.report.pullRequest?.branchMoved, true);
    const head = await rev(SYNC_BRANCH);
    checksOn(head, [{ name: 'ci', status: 'queued' }]);
    const since = /^<!-- head: sha=([0-9a-f]+) since=(\S+) -->$/m.exec(openPullRequests()[0]?.body ?? '');
    assert.equal(since?.[1], head);
    assert.ok(Date.now() - Date.parse(since?.[2] ?? '') < 60_000, 'a new head kept the old push time');
    backdate('mdbisync/linear', 59);
    const short = await sync();
    assert.equal(short.report.pullRequest?.suspended, undefined, 'suspended before the default deadline of 60 minutes');
    backdate('mdbisync/linear', 60);
    const due = await sync();
    assert.deepEqual(due.report.pullRequest?.suspended?.timedOut, ['ci']);
  });

  it('the suspended lane goes first: a passing normal head waits while the suspended checks run, up to the deadline', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    // A person reruns the suspended check; it runs.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'in_progress' }]);
    await editInLinear('combined/guide.md', '# Guide\n\nA normal edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), PASSED);
    const waiting = await sync();
    assert.equal(waiting.result.exitCode, 0, waiting.result.stderr);
    assert.equal(waiting.report.pullRequest?.waitsForSuspended, true);
    assert.equal(waiting.report.pullRequest?.merged, null);
    assert.match(waiting.summary, /merges after the suspended pull request, whose checks still run/);
    assert.doesNotMatch(await show('refs/heads/main:combined/guide.md'), /A normal edit/);
    // The suspended check never finishes: past the deadline it no longer holds the normal lane, and the comment says so.
    backdate('mdbisync/suspended', 61);
    const late = await sync();
    assert.equal(late.result.exitCode, 0, late.result.stderr);
    assert.ok(late.report.pullRequest?.merged);
    assert.deepEqual(late.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.match(await show('refs/heads/main:combined/guide.md'), /A normal edit/);
    assert.deepEqual(late.report.pullRequest?.holdMarks?.updated, [path]);
    assert.ok((commentsOf(await documentOf(path))[0]?.body ?? '').startsWith(HOLD_TIMED_OUT));
  });

  it('L5-28: a check that also fails on the tracked branch tip holds the sync pull request: nothing suspended, marked or written to Linear about it', async () => {
    const path = 'eng/notes/plan.md';
    const own = { icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null };
    await editInLinear(path, '# Plan\n\nAn edit that is not to blame.\n');
    await sync();
    const head = await rev(SYNC_BRANCH);
    checksOn(head, FAILED);
    const other = 'combined/guide.md';
    await gitEdit(other, '# Guide\n\nA tracked edit while checks fail there.\n');
    checksOn(await rev('refs/heads/main'), FAILED);
    const comments = world.linear.comments.size;
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.equal(held.report.pullRequest?.suspended, undefined);
    assert.deepEqual(held.report.pullRequest?.redMain?.map(({ name }) => name), ['ci']);
    assert.match(held.summary, /is held: `ci` \(\[run\]\(https:\/\/github\.test\/owner\/repo\/runs\/\d+\)\) also failed on the tracked branch's tip/);
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/linear');
    assert.match(openPullRequests()[0]?.body ?? '', /^<!-- red main: head=[0-9a-f]+ main=[0-9a-f]+ checks=ci -->$/m);
    assert.equal(await rev(SYNC_BRANCH), head);
    // Nothing about it in Linear: no mark and no comment; the tracked branch's own edit still reaches Linear.
    assert.equal(world.linear.comments.size, comments);
    assert.deepEqual({ icon: (await documentOf(path)).icon ?? null, color: (await documentOf(path)).color ?? null }, own);
    assert.equal(held.report.pullRequest?.holdMarks, undefined);
    assert.match((await documentOf(other)).content ?? '', /while checks fail there/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    // Past the deadline it still holds: the deadline never suspends a batch for a red tracked branch.
    backdate('mdbisync/linear', 61);
    const again = await sync();
    assert.equal(again.report.pullRequest?.suspended, undefined);
    assert.ok(again.report.pullRequest?.redMain);
    assert.equal(world.linear.comments.size, comments);
    // The check is fixed on the tracked branch: the sync branch merges it, and its checks run again on the new head.
    await gitEdit('ci/settings.txt', 'fixed\n');
    // The fix's checks have not registered on the new tip yet: the held head waits, it is neither merged nor suspended.
    const unregistered = await sync();
    assert.equal(unregistered.report.pullRequest?.suspended, undefined);
    assert.equal(unregistered.report.pullRequest?.branchMoved, false);
    assert.deepEqual(unregistered.report.pullRequest?.mainPending, ['ci']);
    checksOn(await rev('refs/heads/main'), PASSED);
    const fixed = await sync();
    assert.equal(fixed.result.exitCode, 0, fixed.result.stderr);
    assert.equal(fixed.report.pullRequest?.branchMoved, true);
    const merged = await rev(SYNC_BRANCH);
    assert.deepEqual((await fixture.remote.text(['show', '-s', '--format=%P', merged])).split(' '), [head, await rev('refs/heads/main')]);
    assert.doesNotMatch(openPullRequests()[0]?.body ?? '', /red main/);
    checksOn(merged, PASSED);
    const done = await sync();
    assert.ok(done.report.pullRequest?.merged);
    assert.match(await show(`refs/heads/main:${path}`), /not to blame/);
    assert.equal(world.linear.comments.size, comments);
    assertNoRerun();
  });

  it('L5-28: a Linear edit that joins a held branch in the run that the tracked branch turns green keeps the hold and takes the fix', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nHeld first.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    checksOn(await rev('refs/heads/main'), FAILED);
    const held = await sync();
    assert.ok(held.report.pullRequest?.redMain);
    await editInLinear('combined/guide.md', '# Guide\n\nJoins the held branch.\n');
    await gitEdit('ci/settings.txt', 'fixed\n');
    checksOn(await rev('refs/heads/main'), PASSED);
    const joined = await sync();
    assert.equal(joined.result.exitCode, 0, joined.result.stderr);
    assert.equal(joined.report.pullRequest?.suspended, undefined);
    const head = await rev(SYNC_BRANCH);
    const ancestor = await fixture.remote.run(['merge-base', '--is-ancestor', await rev('refs/heads/main'), head], { okCodes: [0, 1] });
    assert.equal(ancestor.code, 0, 'the joined head lacks the tracked branch fix');
    assert.match(await show(`${head}:combined/guide.md`), /Joins the held branch/);
    checksOn(head, PASSED);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
  });

  it('deferred notices of a batch that timed out still say the check did not finish in time', async () => {
    const projectId = (await documentOf('eng/notes/plan.md')).projectId as string;
    for (let i = 0; i < MANY; i += 1) await editInLinear(`eng/notes/item-${i}.md`, `# Item ${i}\n\nLate.\n`);
    for (let i = 0; i < MANY; i += 1) await editInLinear(`combined/page-${i}.md`, `# Page ${i}\n\nLate.\n`);
    for (let i = 0; i < MANY; i += 1) {
      world.linear.documents.push({ id: `late-${i}`, title: `late-${i}`, projectId, content: `# Late ${i}\n\nNew.\n`, createdAt: '2026-01-03T00:00:00Z' });
      touch(world.linear.documents.at(-1) as FakeDocument);
    }
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'ci', status: 'queued' }]);
    backdate('mdbisync/linear', 61);
    const first = await sync();
    assert.deepEqual(first.report.pullRequest?.suspended?.timedOut, ['ci']);
    assert.equal(first.report.pullRequest?.holdMarks?.deferred, 60 - HOLD_MARK_LIMIT);
    // The suspended head's own check still runs, short of its deadline: the deferred notices come from the episodes.
    checksOn(await rev(SUSPENDED), [{ name: 'ci', status: 'queued' }]);
    const second = await sync();
    assert.equal(second.report.pullRequest?.holdMarks?.set.length, 60 - HOLD_MARK_LIMIT);
    for (const path of second.report.pullRequest?.holdMarks?.set ?? []) {
      const body = commentsOf(await documentOf(path))[0]?.body ?? '';
      assert.ok(body.startsWith(HOLD_TIMED_OUT), body);
      assert.match(body, /^- Check `ci` did not finish in time\.$/m);
    }
  });

  it('L5-28: a failed check that still runs on the tracked branch tip waits for that result, up to the deadline', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nWaiting on the tracked branch.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    checksOn(await rev('refs/heads/main'), [{ name: 'ci', status: 'in_progress' }]);
    const waiting = await sync();
    assert.equal(waiting.report.pullRequest?.suspended, undefined);
    assert.deepEqual(waiting.report.pullRequest?.mainPending, ['ci']);
    assert.match(waiting.summary, /still runs on the tracked branch's tip/);
    backdate('mdbisync/linear', 61);
    const late = await sync();
    assert.deepEqual(late.report.pullRequest?.suspended?.checks, ['ci']);
  });

  it('L5-28: with a batch already suspended, its comments are not rewritten for a failure the tracked branch shares', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    await sync();
    const note = commentsOf(await documentOf(path))[0]?.body ?? '';
    assert.match(note, /Check `ci`/);
    const lint: FakeCheck[] = [{ name: 'lint', status: 'completed', conclusion: 'failure' }];
    checksOn(await rev(SUSPENDED), lint);
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'completed', conclusion: 'failure' }]);
    const red = await sync();
    assert.equal(red.result.exitCode, 0, red.result.stderr);
    assert.deepEqual(red.report.pullRequest?.suspended?.redMain?.map(({ name }) => name), ['lint']);
    assert.equal(red.report.pullRequest?.holdMarks, undefined);
    assert.equal(commentsOf(await documentOf(path))[0]?.body, note);
    assert.match(red.summary, /comments in Linear stay as they are: `lint`/);
    // While `lint` still runs on the tip, the comments wait for that result and the summary says so.
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'in_progress' }]);
    const pending = await sync();
    assert.deepEqual(pending.report.pullRequest?.suspended?.mainPending, ['lint']);
    assert.equal(pending.report.pullRequest?.holdMarks, undefined);
    assert.match(pending.summary, /comments in Linear wait: `lint` failed on the suspended pull request and still runs/);
    // The tracked branch passes `lint` again: now the failure is the batch's, and its comment says so.
    checksOn(await rev('refs/heads/main'), [{ name: 'lint', status: 'completed', conclusion: 'success' }]);
    const own = await sync();
    assert.deepEqual(own.report.pullRequest?.holdMarks?.updated, [path]);
    assert.match(commentsOf(await documentOf(path))[0]?.body ?? '', /Check `lint`/);
  });

  it('L5-23/L5-24: another batch merges and recorded bases keep the held batch at release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const heldHead = await rev(SUSPENDED);
    const episode = await show('refs/mdbisync/ids:ids.json');
    assert.match(episode, /"noticeId"/);
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Independent edit/);
    assert.doesNotMatch(await show(`refs/heads/main:${path}`), /Held Linear edit/);
    // This is the dangerous topology: main contains the capture through the
    // set-aside head, so git alone treats the missing batch as a deliberate undo.
    const wrong = await fixture.remote.text(['merge-tree', '--write-tree', await rev('refs/heads/main'), heldHead]);
    assert.doesNotMatch(await show(`${wrong.split('\n')[0]}:${path}`), /Held Linear edit/);
    await releaseHeld();
    assert.match(await show(`refs/heads/main:${path}`), /Held Linear edit/);
    assert.match((await documentOf(path)).content ?? '', /Held Linear edit/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
  });

  it('L5-29: a second failed batch joins the one suspended pull request', async () => {
    await suspendOne();
    const first = await rev(SUSPENDED);
    await editInLinear('combined/guide.md', '# Guide\n\nSecond held edit.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    await sync();
    assert.equal(openPullRequests().length, 1);
    assert.equal(openPullRequests()[0]?.head, 'mdbisync/suspended');
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Held Linear edit/);
    assert.match(await show(`${SUSPENDED}:combined/guide.md`), /Second held edit/);
    assert.equal((await fixture.remote.run(['merge-base', '--is-ancestor', first, await rev(SUSPENDED)], {okCodes:[0,1]})).code, 0);
    await releaseHeld();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Second held edit/);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('L5-30/L5-31: frozen git edits wait, merge records still advance, and release keeps both versions', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    await gitEdit(path, '# Plan\n\nA conflicting git edit.\n');
    const frozen = await sync();
    assert.equal(frozen.result.exitCode, 0, frozen.result.stderr);
    assert.ok(frozen.report.sync?.skipped.some((entry) => entry.path === path && entry.reason === 'suspended'));
    assert.equal(frozen.report.sync?.record?.kind, 'merge');
    assert.match((await documentOf(path)).content ?? '', /Held Linear edit/);
    assert.doesNotMatch((await documentOf(path)).content ?? '', /conflicting git/);
    assert.match(await show(`${SUSPENDED}:${path}`), /Sync conflict: git version/);
    await releaseHeld();
    const gitText = await show(`refs/heads/main:${path}`);
    const linearText = (await documentOf(path)).content ?? '';
    for (const text of [gitText, linearText]) {
      assert.match(text, /Held Linear edit/);
      assert.match(text, /A conflicting git edit/);
      assert.equal(detectConflicts(text).length, 1);
    }
  });

  it('takes later Linear edits only into the suspended lane with one parent and a Linear-base', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const previous = await rev(SUSPENDED);
    await editInLinear(path, '# Plan\n\nA repaired Linear edit.\n');
    await sync();
    assert.equal(await rev(SYNC_BRANCH), normalValues.at(-2));
    const head = await rev(SUSPENDED);
    const parents = (await fixture.remote.text(['show', '-s', '--format=%P', head])).split(' ');
    assert.deepEqual(parents, [previous]);
    assert.match(await show(head), /Linear-base: [0-9a-f]+/);
    assert.match(await show(`${SUSPENDED}:${path}`), /A repaired Linear edit/);
    await releaseHeld();
    assert.match(await show(`refs/heads/main:${path}`), /A repaired Linear edit/);
  });

  it('keeps newly captured assets with their suspended document through intake and release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const url = 'https://uploads.linear.app/workspace/photo.png';
    const bytes = Buffer.from('new image bytes');
    world.linear.uploads.push({ filename: 'photo.png', contentType: 'image/png', size: bytes.length, assetUrl: url, bytes });
    await editInLinear(path, `# Plan\n\nA repaired edit.\n\n![Photo](${url})\n`);
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    const captured = await show(`refs/mdbisync/linear:${path}`);
    const link = /!\[Photo\]\(<?([^)>]+)>?\)/.exec(captured)?.[1];
    assert.ok(link, captured);
    const asset = `eng/notes/${link}`;
    assert.equal(await show(`${SUSPENDED}:${asset}`), bytes.toString());
    assert.ok((await show('refs/mdbisync/ids:ids.json')).includes(asset));
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${SYNC_BRANCH}:${asset}`], { okCodes: [0, 128] })).code, 128);
    assert.match(await show(`${SYNC_BRANCH}:combined/guide.md`), /Independent edit/);
    checksOn(await rev(SUSPENDED), FAILED);
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/heads/main:${asset}`], { okCodes: [0, 128] })).code, 128);
    await releaseHeld();
    assert.equal(await show(`refs/heads/main:${asset}`), bytes.toString());
    assert.match((await documentOf(path)).content ?? '', /Photo/);
  });

  it('L5-32: a suspended Linear deletion releases as a deletion, and a restore stays in the lane', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await sync();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${SUSPENDED}:${path}`], {okCodes:[0,128]})).code, 128);
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    checksOn(await rev(SUSPENDED), FAILED);
    const idle = await sync();
    assert.equal(idle.report.changed, false);
    document.trashed = false;
    touch(document);
    await sync();
    assert.match(await show(`${SUSPENDED}:${path}`), /Held Linear edit/);
    // Back from the trash, it shows the cross again, with the same one comment.
    assert.equal(document.icon, MARKS.suspended.icon);
    assert.equal(commentsOf(document).length, 1);
    document.trashed = true;
    touch(document);
    await sync();
    await releaseHeld();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], {okCodes:[0,128]})).code, 128);
    assert.equal(document.trashed, true);
    assert.equal((await ids())[path], undefined);
    // Released while in the trash: its comment is resolved before its id is forgotten.
    assert.equal(commentsOf(document).length, 1);
    assert.equal(commentsOf(document)[0]?.resolved, true);
  });

  it('keeps suspended membership by id through a Linear rename', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.title = 'renamed';
    touch(document);
    await sync();
    assert.equal((await ids())['eng/notes/renamed.md']?.id, document.id);
    assert.match(await show(`${SUSPENDED}:eng/notes/renamed.md`), /Held Linear edit/);
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${SUSPENDED}:${path}`], {okCodes:[0,128]})).code, 128);
    await releaseHeld();
    assert.match(await show('refs/heads/main:eng/notes/renamed.md'), /Held Linear edit/);
    assert.equal(document.title, 'renamed');
  });

  it('L5-33: recreates a deleted suspended branch from current Linear text', async () => {
    await suspendOne();
    await fixture.remote.run(['update-ref', '-d', SUSPENDED]);
    const before = world.github.pullRequests.length;
    await editInLinear('eng/notes/plan.md', '# Plan\n\nCurrent held text.\n');
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Current held text/);
    assert.equal(world.github.pullRequests.length, before);
    await releaseHeld();
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Current held text/);
  });

  it('L5-34: a lost lease before the atomic suspension push moves neither lane nor episodes', async () => {
    await editInLinear('eng/notes/plan.md', '# Plan\n\nHeld Linear edit.\n');
    await sync();
    const normal = await rev(SYNC_BRANCH);
    checksOn(normal, FAILED);
    const transport = fakeFetch(world);
    let raced = false;
    fetchOverride = async (input, init) => {
      if (!raced && String(input).includes('/check-runs?')) {
        raced = true;
        concurrentMove = true;
        const before = await rev('refs/mdbisync/ids');
        const tree = await rev(`${before}^{tree}`);
        const next = await fixture.remote.text(['commit-tree', tree, '-p', before, '-m', 'Concurrent capture'], {env:{GIT_AUTHOR_NAME:IDENTITY.name,GIT_AUTHOR_EMAIL:IDENTITY.email,GIT_COMMITTER_NAME:IDENTITY.name,GIT_COMMITTER_EMAIL:IDENTITY.email}});
        await fixture.remote.run(['update-ref', 'refs/mdbisync/ids', next, before]);
      }
      return transport(input, init);
    };
    const run = await cli('sync');
    assert.equal(run.report.pullRequest?.code, 'state-moved');
    assert.equal(await rev(SYNC_BRANCH), normal);
    assert.equal((await fixture.remote.run(['rev-parse', '--verify', '--quiet', SUSPENDED], {okCodes:[0,1]})).code, 1);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    fetchOverride = undefined;
    concurrentMove = false;
    await sync();
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
  });

  it('releases while the normal pull request is open without reverting the released paths', async () => {
    await suspendOne();
    await editInLinear('combined/guide.md', '# Guide\n\nWaiting normal edit.\n');
    await sync();
    const normal = await rev(SYNC_BRANCH);
    checksOn(normal, [{name:'ci', status:'in_progress'}]);
    const released = await releaseHeld();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().filter((pr) => pr.head === 'mdbisync/linear').length, 1);
    assert.match(await show(`${SYNC_BRANCH}:eng/notes/plan.md`), /Held Linear edit/);
    assert.match(await show(`${SYNC_BRANCH}:combined/guide.md`), /Waiting normal edit/);
    // The normal branch now holds main's released text, so merging it does not undo the release.
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Held Linear edit/);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Waiting normal edit/);
  });

  it('recovers a release interrupted after GitHub merged and before ids were cleared', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    const pr = openPullRequests().find((pr) => pr.head === 'mdbisync/suspended')!;
    const merged = await mergeOnRemote(pr, head);
    assert.ok('sha' in merged);
    pr.state = 'closed';
    pr.merged = true;
    // The next run finds the head in main and completes the durable release.
    const healed = await sync();
    assert.equal(healed.result.exitCode, 0, healed.result.stderr);
    assert.ok(healed.report.pullRequest?.suspended?.released);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
  });

  it('suspends a batch that deletes a document using its historical id', async () => {
    const path = 'eng/notes/plan.md';
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const held = await sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.ok(held.report.pullRequest?.suspended);
    assert.match(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
    await releaseHeld();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], {okCodes:[0,128]})).code, 128);
    assert.equal(document.trashed, true);
    assert.equal((await ids())[path], undefined);
  });

  it('advances Linear-base when Linear adopts a CI repair without changing the selected tree', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne(path, '# Plan\n\nBad content.\n');
    await editRef(SUSPENDED, path, '# Plan\n\nFixed content.\n');
    await editInLinear(path, '# Plan\n\nFixed content.\n');
    await sync();
    checksOn(await rev(SUSPENDED), FAILED);
    await editInLinear(path, '# Plan\n\nNew content.\n');
    await sync();
    const text = await show(`${SUSPENDED}:${path}`);
    assert.equal(detectConflicts(text).length, 0);
    assert.match(text, /New content/);
  });

  it('a suspended non-document conflict leaves the normal lane moving', async () => {
    await suspendOne();
    await editRef(SUSPENDED, '.pre-commit-config.yaml', PRE_COMMIT + '# lane repair\n');
    await gitEdit('.pre-commit-config.yaml', PRE_COMMIT + '# tracked repair\n');
    await editInLinear('combined/guide.md', '# Guide\n\nIndependent edit.\n');
    const run = await sync();
    assert.ok(run.report.pullRequest?.suspended?.conflicts?.includes('.pre-commit-config.yaml'));
    assert.ok(openPullRequests().some((pr) => pr.head === 'mdbisync/linear'));
    checksOn(await rev(SYNC_BRANCH), PASSED);
    await sync();
    assert.match(await show('refs/heads/main:combined/guide.md'), /Independent edit/);
  });

  it('Linear intake ignores non-document conflicts outside the suspended paths', async () => {
    await suspendOne();
    await gitEdit('eng/notes/image.png', 'tracked bytes');
    await editRef('refs/mdbisync/linear', 'eng/notes/image.png', 'captured bytes');
    await editInLinear('eng/notes/plan.md', '# Plan\n\nLater held edit.\n');
    const run = await sync();
    assert.equal(run.report.pullRequest?.suspended?.conflicts, undefined);
    assert.match(await show(`${SUSPENDED}:eng/notes/plan.md`), /Later held edit/);
  });

  it('restores a suspended Linear delete when a git edit keeps its file at release', async () => {
    const path = 'eng/notes/plan.md';
    await suspendOne();
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await gitEdit(path, '# Plan\n\nGit edit while held.\n');
    await sync();
    const released = await releaseHeld();
    assert.notEqual(document.trashed, true);
    assert.match(document.content ?? '', /Git edit while held/);
    assert.ok(released.report.sync?.restored.includes(path));
    assert.equal((await ids())[path]?.id, document.id);
  });

  it('releases when GitHub automatically deletes the suspended branch after merging', async () => {
    await suspendOne();
    world.github.merge = async (pr, sha) => {
      const outcome = await mergeOnRemote(pr, sha);
      if ('sha' in outcome && pr.head === 'mdbisync/suspended') {
        await fixture.remote.run(['update-ref', '-d', SUSPENDED]);
        deletedSuspendedDuringRun = true;
      }
      return outcome;
    };
    const released = await releaseHeld();
    assert.ok(released.report.pullRequest?.suspended?.released);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('heals a release interrupted after GitHub merged and automatically deleted its branch', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    const pr = openPullRequests().find((pr) => pr.head === 'mdbisync/suspended')!;
    assert.ok('sha' in await mergeOnRemote(pr, head));
    await fixture.remote.run(['update-ref', '-d', SUSPENDED]);
    pr.state = 'closed'; pr.merged = true;
    const run = await sync();
    assert.ok(run.report.pullRequest?.suspended?.released);
    assert.equal(openPullRequests().length, 0);
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"|"releaseBase"/);
  });

  it('reports an idle failed suspended head as unchanged', async () => {
    await suspendOne();
    const run = await sync();
    assert.equal(run.report.changed, false);
    assert.deepEqual(run.report.writes.git, {});
    assert.deepEqual(run.writes.filter((write) => !write.startsWith('PATCH /pulls/')), []);
  });

  it('leaves a pre-existing unrelated suspended branch untouched', async () => {
    await fixture.remote.run(['update-ref', SUSPENDED, start]);
    await editInLinear('eng/notes/plan.md', '# Plan\n\nA changed page.\n');
    await sync();
    checksOn(await rev(SYNC_BRANCH), FAILED);
    const run = await sync();
    assert.equal(await rev(SUSPENDED), start);
    assert.equal(run.report.pullRequest?.code, 'conflict');
    assert.doesNotMatch(await show('refs/mdbisync/ids:ids.json'), /"suspended"/);
  });

  it('a repeated protection-rule refusal on the suspended lane stays a setup error', async () => {
    await suspendOne();
    ruleBlocks();
    checksOn(await rev(SUSPENDED), PASSED);
    const first = await sync();
    assert.equal(first.report.pullRequest?.suspended?.code, 'merge-refused');
    const second = await sync();
    assert.equal(second.report.pullRequest?.suspended?.code, 'merge-blocked');
    assert.equal(second.result.exitCode, SETUP_FAILED_EXIT_CODE);
    world.github.merge = mergeOnRemote;
    const released = await sync();
    assert.equal(released.result.exitCode, 0, released.result.stderr);
    assert.ok(released.report.pullRequest?.suspended?.released);
  });

  it('a GitHub failure for the suspended head still allows the normal lane to open', async () => {
    await suspendOne();
    const head = await rev(SUSPENDED);
    await editInLinear('combined/guide.md', '# Guide\n\nAn independent page.\n');
    const transport = fakeFetch(world);
    fetchOverride = async (input, init) => String(input).includes(`/commits/${head}/check-runs`)
      ? new Response('{}', {status:503}) : transport(input, init);
    const run = await sync();
    assert.equal(run.report.pullRequest?.suspended?.code, 'github-failed');
    assert.equal(run.report.pullRequest?.suspended?.status, 503);
    assert.ok(openPullRequests().some((pr) => pr.head === 'mdbisync/linear'));
    assert.match((await documentOf('eng/notes/plan.md')).content ?? '', /Held Linear edit/);
  });

  it('authors suspended lane, intake and release commits as the configured App', async () => {
    const initialRefs = await Promise.all(['refs/mdbisync/linear','refs/mdbisync/ids','refs/mdbisync/uploads','refs/heads/main'].map(rev));
    const extra = {MDBISYNC_APP_SLUG:FAKE_APP_SLUG};
    const path = 'eng/notes/plan.md';
    await editInLinear(path, '# Plan\n\nHeld App edit.\n');
    await cli('sync', extra);
    checksOn(await rev(SYNC_BRANCH), FAILED);
    await cli('sync', extra);
    await editInLinear(path, '# Plan\n\nLater held App edit.\n');
    await cli('sync', extra);
    const checkAuthors = async () => {
      const log = await fixture.remote.text(['log','--format=%s%x00%an <%ae>%x00%cn <%ce>', SUSPENDED,SYNC_BRANCH,'refs/mdbisync/linear','refs/mdbisync/ids','--not',...initialRefs,'refs/heads/main']);
      const expected = `${FAKE_APP_IDENTITY.name} <${FAKE_APP_IDENTITY.email}>`;
      for (const line of log.split('\n').filter(Boolean)) {
        const [subject, author, committer] = line.split('\0');
        assert.notEqual(subject, 'Merge input');
        assert.equal(author, expected, subject);
        assert.equal(committer, expected, subject);
      }
    };
    await checkAuthors();
    checksOn(await rev(SUSPENDED), PASSED);
    const run = await cli('sync', extra);
    assert.ok(run.report.pullRequest?.suspended?.released);
    await checkAuthors();
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

  it('the GitHub Action succeeds when a failed batch is suspended', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nA step for the action. ${CANARY}\n`);
    await sync();
    checksOn(await rev(SYNC_BRANCH), [{ name: 'secrets', status: 'completed', conclusion: 'failure' }]);

    const { output, exitCode } = await action();
    assert.equal(exitCode ?? 0, 0);
    assert.doesNotMatch(output, /::error::/);
    assert.equal(world.github.pullRequests[0]?.merged, false);
  });

  /** One sync run through the GitHub Action, with its output and exit code. */
  async function action(): Promise<{ output: string; exitCode: typeof process.exitCode }> {
    const saved = { env: { ...process.env }, fetch: globalThis.fetch, write: process.stdout.write, exitCode: process.exitCode };
    let output = '';
    try {
      for (const [name, value] of Object.entries(env({}))) {
        if (name.startsWith('MDBISYNC_')) process.env[`INPUT_${name.slice('MDBISYNC_'.length).replaceAll('_', '-')}`] = value;
      }
      Object.assign(process.env, { INPUT_OPERATION: 'sync', 'INPUT_APP-SLUG': FAKE_APP_SLUG, GITHUB_WORKSPACE: cwd, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' });
      process.exitCode = undefined;
      globalThis.fetch = fakeFetch(world);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      const { run } = await import('../action/main.ts');
      await run();
      return { output, exitCode: process.exitCode };
    } finally {
      process.stdout.write = saved.write;
      globalThis.fetch = saved.fetch;
      process.exitCode = saved.exitCode;
      for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
      Object.assign(process.env, saved.env);
    }
  }

  for (const reviewed of [false, true]) it(`a record left on the sync branch by a closed pull request is not carried into the next sync pull request (reviewed: ${reviewed})`, async () => {
    const main = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAbandoned text. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    const review = reviewed ? await commitFile(record, 'combined/guide.md', blob) : record;
    await fixture.remote.run(['update-ref', SYNC_BRANCH, review]);
    syncValues.push(review);
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
    assert.equal(failed.result.exitCode, 0, failed.result.stderr);
    assert.deepEqual(failed.report.pullRequest?.checks?.failed, ['ci/external']);
    assert.ok(failed.report.pullRequest?.suspended);
  });

  async function editRef(ref: string, path: string, text: string, message = 'Edit'): Promise<string> {
    const base = await rev(ref);
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: text });
    const commit = await commitFile(base, path, blob, undefined, message);
    await fixture.remote.run(['update-ref', ref, commit, base]);
    if (ref === SYNC_BRANCH || ref === SUSPENDED) syncValues.push(commit);
    else if (ref === 'refs/heads/main') start = commit;
    return commit;
  }

  it('L2-33: merges CI fixes, writes the stable file next run, and names the hook of a rejected fix', async () => {
    const stable = 'eng/notes/plan.md';
    const unstable = 'combined/guide.md';
    await editInLinear(stable, '# Plan\n\nReady for review.\n');
    await sync();
    const before = (await documentOf(unstable)).content;
    const fixed = '---\nowner: example\n---\n\n# Plan\n\nReviewed and corrected.\n';
    await editRef(SYNC_BRANCH, stable, fixed, 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix');
    const last = await editRef(SYNC_BRANCH, unstable, '# Guide\n\n| Check | Result |\n| :-- | --: |\n| Format | Ready |\n', 'Apply pre-commit fixes\n\nPre-commit-fix: aligned-table\nPre-commit-fix: unknown-output');
    checksOn(last, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
    const merged = await sync();
    assert.ok(merged.report.pullRequest?.merged);
    assert.deepEqual(merged.writes.filter((write) => !write.startsWith('PATCH /pulls/')), ['PUT /pulls/1/merge']);
    const written = await sync();
    assert.equal(written.result.exitCode, 0, written.result.stderr);
    assert.deepEqual(written.report.sync?.updated, [stable]);
    assert.equal((await documentOf(stable)).content, '# Plan\n\nReviewed and corrected.\n');
    assert.equal((await documentOf(unstable)).content, before);
    assert.deepEqual(written.report.sync?.leftOut, [{ path: unstable, rules: ['table-alignment'], hooks: ['aligned-table'] }]);
    assert.match(written.summary, /CI fixes not written/);
    assert.match(written.summary, /aligned-table/);
    assert.doesNotMatch(written.summary, /unknown-output/);
    // Later runs neither repeat the write nor lose the diagnostic.
    for (let n = 0; n < 2; n++) {
      const quiet = await sync();
      assert.deepEqual(quiet.writes, []);
      assert.match(quiet.summary, /aligned-table/);
    }
  });

  it('a revert on a closed sync branch reaches Linear through a history-only merge', async () => {
    const path = 'eng/notes/plan.md';
    const original = await show(`refs/heads/main:${path}`);
    await editInLinear(path, `# Plan\n\nChanged in Linear. ${CANARY}\n`);
    await sync();
    const commit = await editRef(SYNC_BRANCH, path, original);
    const first = world.github.pullRequests[0];
    assert.ok(first);
    first.state = 'closed';
    const opened = await sync();
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    assert.deepEqual(opened.report.pullRequest?.paths, []);
    await sync();
    await sync();
    const quiet = await sync();
    assert.equal(quiet.report.changed, false);
    assert.equal((await documentOf(path)).content, original.slice(original.indexOf('# ')));
    assert.equal((await fixture.remote.run(['merge-base', '--is-ancestor', commit, 'refs/heads/main'], { okCodes: [0, 1] })).code, 0);
  });

  // Pending sync-branch edits that conflict with a later edit (MDS-011-2C). The plan's paragraph is edited on the
  // sync branch by a person or CI, and later in Linear or on the tracked branch; a Linear edit of another document
  // opens the pull request first.
  const PLAN = 'eng/notes/plan.md';
  const planText = (paragraph: string) => `---\nowner: example\n---\n\n# Plan\n\n${paragraph} ${CANARY}\n`;
  const BRANCH_EDIT = 'Reviewed on the branch.';
  const LATER_EDIT = { linear: 'Edited again in Linear.', tracked: 'Edited on the tracked branch.' } as const;

  /** Runs until one run changes nothing and is complete (I6); returns that quiet run. */
  async function settle(limit = 6) {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      if (run.report.changed === false && run.report.complete) return run;
    }
    assert.fail(`the sync did not settle in ${limit} runs`);
  }

  /** One conflict in `text`, its git and Linear versions holding the given paragraphs. */
  function assertOneConflict(text: string, git: string, linear: string) {
    const found = detectConflicts(text);
    assert.equal(found.length, 1, 'expected exactly one conflict');
    assert.ok(found[0]?.git?.includes(git), 'the git version is not the expected one');
    assert.ok(found[0]?.linear?.includes(linear), 'the Linear version is not the expected one');
    assert.equal(text.split(MARKERS.git).length, 2, 'markers are nested or repeated');
  }

  const isAncestorOn = async (commit: string, ref: string) => (await fixture.remote.run(['merge-base', '--is-ancestor', commit, ref], { okCodes: [0, 1] })).code === 0;

  /** A pending sync-branch edit of the plan, with its pull request open or closed. */
  async function pendingBranchEdit(state: 'open' | 'closed'): Promise<string> {
    await editInLinear('combined/guide.md', `# Guide\n\nHow to start, edited in Linear. ${CANARY}\n`);
    const opened = await sync();
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    const commit = await editRef(SYNC_BRANCH, PLAN, planText(BRANCH_EDIT));
    if (state === 'closed') {
      const first = world.github.pullRequests[0];
      assert.ok(first);
      first.state = 'closed';
    }
    return commit;
  }

  for (const state of ['open', 'closed'] as const) for (const side of ['linear', 'tracked'] as const) {
    it(`MDS-011-2C: a pending sync-branch edit conflicting with a later ${side} edit, pull request ${state}: both versions kept between markers, then both sides converge`, async () => {
      const commit = await pendingBranchEdit(state);
      if (side === 'linear') await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
      else await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));

      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      assert.equal(run.report.pullRequest?.code, undefined, JSON.stringify(run.report.pullRequest));
      assert.deepEqual(run.report.pullRequest?.marked, [PLAN]);
      assert.equal(run.report.pullRequest?.branchMoved, true);
      assert.ok(run.report.pullRequest?.paths.includes(PLAN));
      assert.match(run.summary, /Both versions are kept between conflict markers/);
      assert.equal(world.github.pullRequests.length, state === 'open' ? 1 : 2);
      assert.equal(openPullRequests().length, 1);
      assert.equal(openPullRequests()[0]?.head, world.github.pullRequests[0]?.head);
      // The branch keeps the person's commit and gains a merge holding both versions: the git version is the
      // git-side edit (the branch's against Linear, the tracked branch's against the branch).
      assert.ok(await isAncestorOn(commit, SYNC_BRANCH), 'the sync branch lost the pending commit');
      const head = await rev(SYNC_BRANCH);
      assert.equal((await fixture.remote.text(['rev-parse', `${head}^@`])).split('\n').length, 2, 'the reconciliation is not a merge commit');
      const [git, linear] = side === 'linear' ? [BRANCH_EDIT, LATER_EDIT.linear] : [LATER_EDIT.tracked, BRANCH_EDIT];
      assertOneConflict(await show(`${SYNC_BRANCH}:${PLAN}`), git, linear);
      assert.match(await show(`${SYNC_BRANCH}:${PLAN}`), /^---\nowner: example\n---\n/, 'front matter was lost');
      // Linear's state ref holds only what Linear returned: no intended content, no markers yet.
      assert.ok(!(await show(`refs/mdbisync/linear:${PLAN}`)).includes(MARKERS.git), "markers reached Linear's state before Linear held them");

      const quiet = await settle();
      assert.deepEqual(quiet.writes, []);
      const tracked = await show(`refs/heads/main:${PLAN}`);
      assertOneConflict(tracked, git, linear);
      const document = await documentOf(PLAN);
      assert.equal(document.content, tracked.slice(tracked.indexOf('# ')), 'Linear and the tracked branch differ (I1)');
      assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);
      assert.ok(await isAncestorOn(commit, 'refs/heads/main'), 'the tracked branch lost the pending commit');
      assert.ok(await isAncestorOn(head, 'refs/heads/main'), 'the tracked branch lost the reconciliation');
      assert.equal(openPullRequests().length, 0);
      assert.match(await show('refs/heads/main:combined/guide.md'), /edited in Linear/);
    });
  }

  it('MDS-011-2C: a sync-branch edit conflicting with both a tracked edit and a Linear edit of the same paragraph converges, all three kept', async () => {
    await editInLinear(PLAN, `# Plan\n\nChanged in Linear. ${CANARY}\n`);
    await sync();
    const commit = await editRef(SYNC_BRANCH, PLAN, planText(BRANCH_EDIT));
    await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    await settle();
    const tracked = await show(`refs/heads/main:${PLAN}`);
    for (const text of [BRANCH_EDIT, LATER_EDIT.tracked, LATER_EDIT.linear]) assert.ok(tracked.includes(text), `the edit "${text}" was lost (I2)`);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    assert.ok(await isAncestorOn(commit, 'refs/heads/main'));
    assert.ok(tracked.split(MARKERS.git).length <= 2, 'markers are nested or repeated');
  });

  for (const [change, branchFile, expected] of [
    ['edit', planText(BRANCH_EDIT).replace('owner: example', 'owner: reviewer'), /^---\nowner: reviewer\n---\n/],
    ['removal', `# Plan\n\n${BRANCH_EDIT} ${CANARY}\n`, /^# Plan\n/],
  ] as const) {
    it(`MDS-011-2C: a front matter ${change} pending on the sync branch survives a merge with a conflicting tracked edit`, async () => {
      await pendingBranchEdit('open');
      await editRef(SYNC_BRANCH, PLAN, branchFile);
      await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
      const run = await sync();
      assert.deepEqual(run.report.pullRequest?.marked, [PLAN]);
      await settle();
      const tracked = await show(`refs/heads/main:${PLAN}`);
      assert.match(tracked, expected, `the pending front matter ${change} was lost`);
      assertOneConflict(tracked, LATER_EDIT.tracked, BRANCH_EDIT);
    });
  }

  it('MDS-011-2C: a Linear title change and rewrite against a pending sync-branch edit stays one document', async () => {
    await pendingBranchEdit('open');
    const document = await documentOf(PLAN);
    const live = () => world.linear.documents.filter((candidate) => candidate.trashed !== true).length;
    const before = live();
    document.title = 'Roadmap';
    document.content = `# Roadmap\n\nEverything here was rewritten in Linear, line by line, so git sees no rename at all. ${CANARY}\n`;
    touch(document);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    await settle();
    assert.equal(live(), before, 'a document was duplicated');
    const mapped = Object.entries(await ids()).filter(([, entry]) => entry.id === document.id).map(([path]) => path);
    assert.equal(mapped.length, 1, `the document is mapped at ${mapped.join(', ')}`);
    const tracked = await show(`refs/heads/main:${mapped[0]}`);
    for (const text of [BRANCH_EDIT, 'Everything here was rewritten in Linear']) assert.ok(tracked.includes(text), `the edit "${text}" was lost (I2)`);
    assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/heads/main:${PLAN}`], { okCodes: [0, 128] })).code === 0 && mapped[0] !== PLAN, false, 'the old path stayed as a second file');
  });

  it('MDS-011-2C: a pending delete on the sync branch against a later Linear edit is decided and reported, the edit kept', async () => {
    await pendingBranchEdit('open');
    const base = await rev(SYNC_BRANCH);
    const deleted = await commitFile(base, PLAN, null);
    await fixture.remote.run(['update-ref', SYNC_BRANCH, deleted, base]);
    syncValues.push(deleted);
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, undefined, JSON.stringify(run.report.pullRequest));
    assert.deepEqual(run.report.pullRequest?.decided, [PLAN]);
    assert.match(run.summary, /decided them by its structural conflict rules/);
    await settle();
    assert.match(await show(`refs/heads/main:${PLAN}`), /Edited again in Linear\./);
    assert.ok(await isAncestorOn(deleted, 'refs/heads/main'), 'the pending delete commit was lost from history');
  });

  it('MDS-011-2C: a person resolves the markers on the sync branch; the resolution is kept and reaches Linear', async () => {
    const commit = await pendingBranchEdit('open');
    await editInLinear(PLAN, `# Plan\n\n${LATER_EDIT.linear} ${CANARY}\n`);
    const reconciled = await sync();
    assert.deepEqual(reconciled.report.pullRequest?.marked, [PLAN]);
    const resolution = await editRef(SYNC_BRANCH, PLAN, planText('Reviewed on the branch and edited again in Linear.'));

    const quiet = await settle();
    assert.deepEqual(quiet.writes, []);
    const tracked = await show(`refs/heads/main:${PLAN}`);
    assert.equal(detectConflicts(tracked).length, 0);
    assert.match(tracked, /Reviewed on the branch and edited again in Linear\./);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    for (const kept of [commit, resolution]) assert.ok(await isAncestorOn(kept, 'refs/heads/main'), 'a commit was lost');
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('MDS-011-2C: a person merges the tracked branch into the sync branch by hand; the sync keeps that resolution', async () => {
    const commit = await pendingBranchEdit('open');
    await editRef('refs/heads/main', PLAN, planText(LATER_EDIT.tracked));
    // The person's own merge commit: parents (sync branch, tracked branch), one resolved paragraph, no markers.
    const parents = [await rev(SYNC_BRANCH), await rev('refs/heads/main')] as const;
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: planText('Resolved by a person.') });
    const resolution = await commitFile(parents[0], PLAN, blob, parents[1]);
    await fixture.remote.run(['update-ref', SYNC_BRANCH, resolution, parents[0]]);
    syncValues.push(resolution);

    const run = await sync();
    assert.deepEqual(run.report.pullRequest?.marked, []);
    assert.equal(await rev(SYNC_BRANCH), resolution, 'the sync replaced the resolution');
    const quiet = await settle();
    assert.deepEqual(quiet.writes, []);
    const tracked = await show(`refs/heads/main:${PLAN}`);
    assert.equal(detectConflicts(tracked).length, 0);
    assert.match(tracked, /Resolved by a person\./);
    assert.equal((await documentOf(PLAN)).content, tracked.slice(tracked.indexOf('# ')));
    for (const kept of [commit, resolution]) assert.ok(await isAncestorOn(kept, 'refs/heads/main'), 'a commit was lost');
  });

  it('MDS-011-2C: a conflicting file that is no document cannot hold markers: the branch is kept and a conflict reported', async () => {
    const path = '.pre-commit-config.yaml';
    await pendingBranchEdit('open');
    const commit = await editRef(SYNC_BRANCH, path, `${PRE_COMMIT}# changed on the branch\n`);
    await editRef('refs/heads/main', path, `${PRE_COMMIT}# changed on the tracked branch\n`);
    const run = await sync();
    assert.equal(run.report.pullRequest?.code, 'conflict');
    assert.deepEqual(run.report.pullRequest?.marked, []);
    assert.equal(await rev(SYNC_BRANCH), commit);
    assert.match(run.summary, /A conflicting file that is not a document waits/);
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
    assert.match(refused.summary, /GitHub did not merge the sync pull request \[#1\]\(.*\) \(HTTP 409: `Pull Request is not mergeable`\)/);
    assert.deepEqual(refused.writes, ['PATCH /pulls/1'], 'the refusal is noted on the pull request');
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(again.writes, ['PUT /pulls/1/merge']);
  });

  const RULE = 'Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access.';
  const RULE_TEXT = 'Repository rule violations found At least 1 approving review is required by reviewers with write access.';
  const ruleBlocks = () => {
    world.github.merge = async () => ({ status: 405, message: RULE });
  };

  it('a merge rule the App cannot satisfy fails the second run that meets it, with GitHub\'s reason; the merge follows once the rule is fixed', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNeeds a review. ${CANARY}\n`);
    await sync();
    ruleBlocks();

    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(first.report.pullRequest?.code, 'merge-refused');
    assert.equal(first.report.pullRequest?.reason, RULE_TEXT);
    assert.ok(first.summary.includes(`(HTTP 405: \`${RULE_TEXT}\`); a later run tries again`), first.summary);
    assert.ok(world.github.pullRequests[0]?.body.includes(`(HTTP 405: \`${RULE_TEXT}\`)`), 'the pull request names the refusal');
    // The note in the description is a write; the refused merge is not.
    assert.deepEqual(first.report.writes.pullRequests, { updated: 1 });

    const second = await sync();
    assert.equal(second.result.exitCode, SETUP_FAILED_EXIT_CODE, second.result.stderr);
    assert.ok(second.result.stderr.includes(`setup error (merge-blocked): GitHub refuses again to merge the sync pull request (HTTP 405: \`${RULE_TEXT}\`)`), second.result.stderr);
    assert.equal(second.report.pullRequest?.code, 'merge-blocked');
    assert.equal(second.report.exitStatus, 'failure');
    assert.ok(second.summary.includes(`Setup error: GitHub refused again to merge the sync pull request [#1]`), second.summary);
    assert.ok(second.summary.includes(RULE_TEXT), second.summary);
    assert.deepEqual(second.writes, [], 'a run that meets the same refusal changes nothing');
    assert.deepEqual(second.report.writes, { linear: {}, git: {}, pullRequests: {} });

    const fromAction = await action();
    assert.equal(fromAction.exitCode, 1);
    assert.ok(fromAction.output.includes(`::error::sync: setup error (merge-blocked): GitHub refuses again to merge the sync pull request (HTTP 405: \`${RULE_TEXT}\`)`), fromAction.output);
    assert.match(fromAction.output, /::set-output name=code::merge-blocked/);

    world.github.merge = mergeOnRemote;
    const fixed = await sync();
    assert.equal(fixed.result.exitCode, 0, fixed.result.stderr);
    assert.deepEqual(fixed.writes, ['PUT /pulls/1/merge']);
    assert.deepEqual(fixed.report.writes.pullRequests, { merged: 1 });
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Needs a review\./);
  });

  it('a refusal after the tracked branch or the head moved is a normal retry, not a setup error', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nWaits for a rule. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');

    // A person pushes to the tracked branch: the same refusal on the same head is new for that base.
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nMoved on. ${CANARY}\n` });
    const base = await rev('refs/heads/main');
    const commit = await commitFile(base, 'combined/guide.md', blob);
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    start = commit;
    const afterTracked = await sync();
    assert.equal(afterTracked.result.exitCode, 0, afterTracked.result.stderr);
    assert.equal(afterTracked.report.pullRequest?.code, 'merge-refused');

    // A new Linear edit moves the head; the run after it reads the new head's checks and is refused once more.
    await editInLinear('combined/page-1.md', `# Page 1\n\nRevised. ${CANARY}\n`);
    const moved = await sync();
    assert.equal(moved.report.pullRequest?.branchMoved, true);
    const afterHead = await sync();
    assert.equal(afterHead.result.exitCode, 0, afterHead.result.stderr);
    assert.equal(afterHead.report.pullRequest?.code, 'merge-refused');

    const repeated = await sync();
    assert.equal(repeated.result.exitCode, SETUP_FAILED_EXIT_CODE, repeated.result.stderr);
    assert.equal(repeated.report.pullRequest?.code, 'merge-blocked');
  });

  it('a refusal noted in a description saved with CRLF line endings is still read back', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nEdited on the web. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    const pr = world.github.pullRequests[0];
    assert.ok(pr !== undefined);
    pr.body = pr.body.replaceAll('\n', '\r\n');
    const repeated = await sync();
    assert.equal(repeated.result.exitCode, SETUP_FAILED_EXIT_CODE, repeated.result.stderr);
    assert.equal(repeated.report.pullRequest?.code, 'merge-blocked');
  });

  it('a refusal whose note cannot be written is still reported with its reason', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNote lost. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    world.github.reset = (request) => (request === 'PATCH /pulls/1' ? 'before' : undefined);
    const refused = await sync();
    assert.equal(refused.result.exitCode, 0, refused.result.stderr);
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    assert.equal(refused.report.pullRequest?.reason, RULE_TEXT);
    // The note's request never reached GitHub: no pull request write is counted.
    assert.deepEqual(refused.report.writes.pullRequests, {});
    delete world.github.reset;
    // Nothing was noted, so the next refusal is noted rather than reported as repeated.
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    assert.equal((await sync()).report.pullRequest?.code, 'merge-blocked');
  });

  it('a different reason on the same head is a normal retry', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nTwo reasons. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    world.github.merge = async () => ({ status: 405, message: 'Base branch was modified. Review and try the merge again.' });
    const other = await sync();
    assert.equal(other.result.exitCode, 0, other.result.stderr);
    assert.equal(other.report.pullRequest?.code, 'merge-refused');
    assert.deepEqual(other.writes, ['PATCH /pulls/1']);
  });

  it('a reset connection while opening the sync pull request: the write step runs, the run reports, and the next run opens it', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nAfter the outage. ${CANARY}\n`);
    // A person's git edit, which this run's write step takes to Linear.
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nWritten anyway. ${CANARY}\n` });
    const base = await rev('refs/heads/main');
    const commit = await commitFile(base, 'combined/guide.md', blob);
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    start = commit;
    world.github.reset = (request, body) => (request === 'POST /pulls' && body.head !== undefined ? 'before' : undefined);

    const broken = await sync();
    assert.equal(broken.result.exitCode, INCOMPLETE_EXIT_CODE, broken.result.stderr);
    assert.match(broken.result.stderr, /not finished \(github-failed\)/);
    assert.equal(broken.report.pullRequest?.code, 'github-failed');
    assert.equal(broken.report.pullRequest?.status, undefined);
    assert.match(broken.summary, /A request to GitHub for the sync pull request got no answer/);
    assert.equal((await documentOf('combined/guide.md')).content, `# Guide\n\nWritten anyway. ${CANARY}\n`, 'the write step did not run');
    assert.deepEqual(world.github.pullRequests, []);

    delete world.github.reset;
    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /After the outage\./);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Written anyway\./);
  });

  it('an answer lost after GitHub opened or merged the sync pull request: the next run converges without a second one', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nLost answers. ${CANARY}\n`);
    world.github.reset = (request, body) => (request === 'POST /pulls' && body.head !== undefined ? 'after' : undefined);
    const open = await sync();
    assert.equal(open.result.exitCode, INCOMPLETE_EXIT_CODE, open.result.stderr);
    assert.equal(open.report.pullRequest?.code, 'github-failed');
    assert.equal(openPullRequests().length, 1, 'GitHub opened it before the connection broke');

    world.github.reset = (request) => (request === 'PUT /pulls/1/merge' ? 'after' : undefined);
    const merge = await sync();
    assert.equal(merge.result.exitCode, INCOMPLETE_EXIT_CODE, merge.result.stderr);
    assert.equal(merge.report.pullRequest?.code, 'github-failed');
    assert.equal(world.github.pullRequests[0]?.merged, true, 'GitHub merged it before the connection broke');

    delete world.github.reset;
    const after = await sync();
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.deepEqual(after.writes, []);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(after.report.pullRequest?.needed, false);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Lost answers\./);
  });

  it('a reset connection on every request of the pull request step ends each run defined', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nEvery request. ${CANARY}\n`);
    await sync();
    // The step's own requests; the setup check reads check runs one at a time.
    const steps = ['GET /pulls', 'PATCH /pulls/1', 'GET /commits/', 'PUT /pulls/1/merge'];
    const ofStep = (request: string, step: string) => request.startsWith(step) && !request.endsWith('per_page=1');
    for (const step of steps) {
      // An edit in Linear changes the description, so the run sends its PATCH.
      if (step === 'PATCH /pulls/1') await editInLinear('combined/page-2.md', `# Page 2\n\nChanged for the description. ${CANARY}\n`);
      world.github.reset = (request) => (ofStep(request, step) ? 'before' : undefined);
      const broken = await sync();
      assert.equal(broken.result.exitCode, INCOMPLETE_EXIT_CODE, `${step}: ${broken.result.stderr}`);
      assert.equal(broken.report.pullRequest?.code, 'github-failed', step);
      assert.equal(broken.report.exitStatus, 'failure', step);
    }
    delete world.github.reset;
    let run = await sync();
    if (run.report.pullRequest?.branchMoved === true) run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(world.github.pullRequests[0]?.merged, true);
    assert.match(await show('refs/heads/main:combined/page-2.md'), /Changed for the description\./);
  });

  for (const reviewed of [false, true]) it(`never reuses a sync branch that holds an unmerged initial sync from Linear (reviewed: ${reviewed})`, async () => {
    // The sync branch holds such a record, which changes the tracked branch and
    // which a person has not merged, while `linear` has moved on.
    const main = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAs Linear holds it. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    const head = reviewed ? await commitFile(record, 'combined/guide.md', blob) : record;
    await fixture.remote.run(['update-ref', SYNC_BRANCH, head]);
    world.github.pullRequests.push({ number: 1, title: 'Initial sync from Linear', body: '', head: 'mdbisync/linear', base: 'main', state: 'open', merged: false });
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNot yet. ${CANARY}\n`);
    const linearWrites = world.linear.writes.count;

    const run = await sync();
    assert.equal(run.result.exitCode, NO_STATE_EXIT_CODE, run.result.stderr);
    assert.equal(run.report.pullRequest?.code, 'initial-pull-request-pending');
    assert.equal(await rev(SYNC_BRANCH), head);
    assert.deepEqual(run.writes, []);
    assert.equal(world.linear.writes.count, linearWrites);
    assert.match(run.summary, /a person has not merged yet/);
  });

  /** A commit on `base` with one file replaced, made on the bare remote; a merge when `other` is a second parent. */
  async function commitFile(base: string, path: string, blob: string | null, other?: string, message = 'Edit'): Promise<string> {
    const index = join(fixture.root, 'scratch.index');
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await fixture.remote.run(['read-tree', base], { env });
    // The bare remote has no work tree: a zero mode removes the entry.
    if (blob === null) await fixture.remote.run(['update-index', '--index-info'], { env, input: `0 ${'0'.repeat(40)}\t${path}\n` });
    else await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    const tree = await fixture.remote.text(['write-tree'], { env });
    return fixture.remote.text(['commit-tree', tree, '-p', base, ...(other === undefined ? [] : ['-p', other]), '-m', message], { env });
  }
});
