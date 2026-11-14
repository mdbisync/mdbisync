// Shared local Git and fake API fixture for sync pull request scenarios.
// Each suite registers its own hooks and retains the per-run write, privacy
// and branch-history invariants.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { runCli } from '../cli.ts';
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { detectConflicts, MARKERS } from '../merge/index.ts';
import { type RunReport } from '../run/finish.ts';
import { FAKE_APP_SLUG, type FakeCheck, type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, createFixture, mergeOnGitHub } from '../state/test-helpers.ts';
import { type CheckClock } from '../pull-request/index.ts';

export const CANARY = 'kx-3c9d1e72';

export const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: stable-fix
      - id: aligned-table
`;

export const MANY = 20;

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

export const SYNC_BRANCH = 'refs/heads/mdbisync/linear';

/** Registers a fresh fixture and invariant checks for each scenario in a suite. */
export function pullRequestHarness() {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  let fetchOverride: typeof fetch | undefined;
  let concurrentMove = false;
  let concurrentSyncMove = false;
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
    concurrentSyncMove = false;
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    world.github.pullRequestHead = (pr) => rev(`refs/heads/${pr.head}`);
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
    // Most tests give the head no checks; the ones about missing checks clear this.
    MDBISYNC_MERGE_WITHOUT_CHECKS: 'true',
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
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: fetchOverride !== undefined, movedByOthers: [...(concurrentMove ? ['ids'] as const : []), ...(deletedSuspendedDuringRun ? ['suspendedBranch'] as const : []), ...(concurrentSyncMove ? ['syncBranch'] as const : [])] });
    assertNoRerun();
    return { result, report, summary, clock, writes: world.writes.slice(writesBefore), linearRequests: linearRequests.length - linearBefore, linearApiRequests: linearRequests.slice(linearBefore).filter((url) => !url.startsWith(`${LINEAR_API}/oauth/`)).length };
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
  const mergeOnRemote = (pr: { head: string; base: string; number: number }, sha: string) => mergeOnGitHub(fixture, pr, sha);

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
    const body = pr.body.replace(/^(<!-- head: sha=[0-9a-f]+ since=)[^ ]+((?: checks=\S*)? -->)$/m,`$1${new Date(Date.now() - minutes * 60_000).toISOString()}$2`);
    assert.notEqual(body, pr.body, 'the description notes no push time');
    pr.body = body;
  }
  /** No request asked GitHub to rerun or cancel a workflow run or check (the sync never reruns a check). */
  const assertNoRerun = () => {
    for (const request of githubRequests) assert.doesNotMatch(request, /\/actions\/|rerun|rerequest|cancel/, request);
  };

  /** Suspends the plan, then trashes its document in Linear, so the batch releases while it is in the trash. */
  async function suspendThenTrash(path: string): Promise<FakeDocument> {
    await suspendOne(path);
    const document = await documentOf(path);
    document.trashed = true;
    touch(document);
    await sync();
    return document;
  }
  /** Answers Linear's `ResolveComment` with `answer` while it returns a response; other requests reach the fakes. */
  function onResolve(answer: () => Response | undefined): { calls: number } {
    const seen = { calls: 0 };
    const inner = fakeFetch(world);
    fetchOverride = async (input, init) => {
      if (String(input).startsWith(LINEAR_API) && String(init?.body ?? '').includes('mutation ResolveComment')) {
        seen.calls += 1;
        const response = answer();
        if (response !== undefined) return response;
      }
      return inner(input, init);
    };
    return seen;
  }
  const linearAnswer = (status: number, code: string) => new Response(JSON.stringify({ data: null, errors: [{ message: 'injected', extensions: { code } }] }), { status, headers: { 'content-type': 'application/json' } });

  /** Answers Linear's `mutation` with `answer` while it returns a response; other requests reach the fakes. */
  function onMutation(mutation: string, answer: () => Response | undefined): { calls: number } {
    const seen = { calls: 0 };
    const inner = fakeFetch(world);
    fetchOverride = async (input, init) => {
      if (String(input).startsWith(LINEAR_API) && String(init?.body ?? '').includes(`mutation ${mutation}(`)) {
        seen.calls += 1;
        const response = answer();
        if (response !== undefined) return response;
      }
      return inner(input, init);
    };
    return seen;
  }
  const refusal = (message: string) => new Response(JSON.stringify({ data: null, errors: [{ message, extensions: { code: 'INPUT_ERROR' } }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-35' } });

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

  async function editRef(ref: string, path: string, text: string, message = 'Edit'): Promise<string> {
    const base = await rev(ref);
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: text });
    const commit = await commitFile(base, path, blob, undefined, message);
    await fixture.remote.run(['update-ref', ref, commit, base]);
    if (ref === SYNC_BRANCH || ref === SUSPENDED) syncValues.push(commit);
    else if (ref === 'refs/heads/main') start = commit;
    return commit;
  }

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

  const RULE = 'Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access.';
  const RULE_TEXT = 'Repository rule violations found At least 1 approving review is required by reviewers with write access.';
  const ruleBlocks = () => {
    world.github.merge = async () => ({ status: 405, message: RULE });
  };

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
  return {
    get fixture() { return fixture; },
    get world() { return world; },
    get fetchOverride() { return fetchOverride; },
    set fetchOverride(value: typeof fetchOverride) { fetchOverride = value; },
    get concurrentMove() { return concurrentMove; },
    set concurrentMove(value: typeof concurrentMove) { concurrentMove = value; },
    get concurrentSyncMove() { return concurrentSyncMove; },
    set concurrentSyncMove(value: typeof concurrentSyncMove) { concurrentSyncMove = value; },
    get deletedSuspendedDuringRun() { return deletedSuspendedDuringRun; },
    set deletedSuspendedDuringRun(value: typeof deletedSuspendedDuringRun) { deletedSuspendedDuringRun = value; },
    get start() { return start; },
    set start(value: typeof start) { start = value; },
    get syncValues() { return syncValues; },
    get normalValues() { return normalValues; },
    githubRequests,
    cli,
    sync,
    mergeOnRemote,
    rev,
    show,
    ids,
    documentOf,
    editInLinear,
    checksOn,
    commentsOf,
    openPullRequests,
    gitEdit,
    SUSPENDED,
    FAILED,
    PASSED,
    suspendOne,
    releaseHeld,
    backdate,
    assertNoRerun,
    suspendThenTrash,
    onResolve,
    linearAnswer,
    onMutation,
    refusal,
    action,
    editRef,
    PLAN,
    planText,
    BRANCH_EDIT,
    LATER_EDIT,
    settle,
    assertOneConflict,
    isAncestorOn,
    pendingBranchEdit,
    RULE_TEXT,
    ruleBlocks,
    commitFile,
  };
}
