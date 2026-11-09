// Races inside a sync run and its pull request (L4-01 to L4-09), against a local git remote and
// a fake GitHub and Linear served over HTTP. Every run is a real engine
// process in its own clone, as a workflow job is: a test pauses it at a
// checkpoint (test hooks on), acts as a person meanwhile, then resumes it or
// kills it; two runs can overlap. After each scenario the next runs settle
// and the usual checks hold: both sides converge (I1), no edit is lost (I2),
// the tracked branch changes only by the person's commits and sync merges
// (I3), refs only move forward (I4), and one more run changes nothing (I6).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { CheckpointControl } from '../../test/e2e/harness/checkpoints.ts';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { Git } from '../state/index.ts';
import { type Fixture, IDENTITY, createFixture } from '../state/test-helpers.ts';
import { type Checkpoint, HOOKS_DIR_ENV, HOOKS_ENV } from '../test-hooks.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from './write.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const CANARY = 'kx-8e2f4c61';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const NOTES = 'eng/backend/notes.md';
const REVIEW = 'eng/notes/review.md';

const TREE: Record<string, string> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  [NOTES]: `# Notes\n\nFirst paragraph.\n\nSecond paragraph. ${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two. ${CANARY}\n`,
  [REVIEW]: `# Review\n\nFindings of the review. ${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

const STATE_REFS = ['refs/mdbisync/linear', 'refs/mdbisync/ids', 'refs/mdbisync/uploads', 'refs/heads/mdbisync/linear'] as const;
const RUN_TIMEOUT_MS = 60_000;

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  summary: string;
  /** Null when the process was killed before it wrote one. */
  report: RunReport | null;
}

interface Running {
  hooks: CheckpointControl;
  ended: Promise<Ended>;
  kill(): void;
}

describe('sync: races inside a run', { timeout: 240_000 }, () => {
  let fixture: Fixture;
  let world: FakeWorld;
  let server: Served;
  let person: Git;
  let personDir: string;
  /** The tracked branch after initial sync: every later commit on it is the person's or a sync merge (I3). */
  let start: string;
  /** The person's commits on the tracked branch. */
  let personCommits: string[];
  /** Every value each state ref held, in order: each only moves forward (I4). */
  let history: Map<string, string[]>;
  let runs = 0;

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    world = fakeWorld();
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    server = await serve(world);
    personDir = join(fixture.root, 'person');
    await new Git(fixture.root).run(['clone', '--quiet', fixture.url, personDir]);
    person = new Git(personDir, {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    });
    const engine = await fixture.clone('initial');
    const initial = await runCli(['initial-sync'], {
      env: { ...env('initial', ''), MDBISYNC_LINEAR_API_URL: LINEAR_API, MDBISYNC_GITHUB_API_URL: GITHUB_API, MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' },
      cwd: engine.dir,
      fetch: fakeFetch(world),
    });
    assert.equal(initial.exitCode, 0, initial.stderr);
    start = await rev('refs/heads/main');
    personCommits = [];
    history = new Map();
    await observeRefs();
  });
  afterEach(async () => {
    await server.close();
    await fixture.cleanup();
  });

  function env(name: string, url: string): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
      MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
      MDBISYNC_LINEAR_API_URL: `${url}/linear`,
      MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_GITHUB_TOKEN: 'gh-token',
      MDBISYNC_GITHUB_API_URL: `${url}/github`,
      MDBISYNC_REPOSITORY: 'owner/repo',
      MDBISYNC_REPORT_FILE: join(fixture.root, `${name}.json`),
      GITHUB_STEP_SUMMARY: join(fixture.root, `${name}.md`),
    };
  }

  /** Starts a sync run in a fresh clone, paused at `pause` when given. */
  async function startRun(pause?: Checkpoint): Promise<Running> {
    runs += 1;
    const name = `run-${runs}`;
    const clone = await fixture.clone(name);
    const hooks = new CheckpointControl(join(fixture.root, `hooks-${name}`));
    if (pause !== undefined) hooks.pause(pause);
    const child = spawn(process.execPath, [CLI, 'sync'], {
      cwd: clone.dir,
      env: { ...env(name, server.url), [HOOKS_ENV]: '1', [HOOKS_DIR_ENV]: hooks.dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    const ended = new Promise<Ended>((resolve, reject) => {
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        // A failed check rejects `ended`, so the test that awaits the run fails with it.
        const finish = async (): Promise<Ended> => {
          const summary = await readFile(join(fixture.root, `${name}.md`), 'utf8').catch(() => '');
          const text = await readFile(join(fixture.root, `${name}.json`), 'utf8').catch(() => null);
          const report = text === null ? null : (JSON.parse(text) as RunReport);
          for (const output of [stderr, summary, text ?? '']) assert.ok(!output.includes(CANARY), 'content reached the output (I5)');
          await observeRefs();
          return { code, signal, stderr, summary, report };
        };
        finish().then(resolve, reject);
      });
    });
    // Waiting for a checkpoint watches `ended` without awaiting it; a rejection still fails the test that awaits it.
    ended.catch(() => {});
    return { hooks, ended, kill: () => child.kill('SIGKILL') };
  }

  /** A run that goes through without a pause. */
  async function sync(): Promise<Ended> {
    return (await startRun()).ended;
  }

  /** Waits until the paused run reaches its checkpoint. */
  async function reached(running: Running, name: Checkpoint): Promise<void> {
    const ok = await running.hooks.waitReached(name, { timeoutMs: RUN_TIMEOUT_MS, exited: running.ended });
    if (!ok) assert.fail(`the run did not reach ${name}: ${(await running.ended).stderr}`);
  }

  /** Runs until a run finds nothing to do; returns the runs, the last of them the idle one (I6). */
  async function settle(): Promise<Ended[]> {
    const done: Ended[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await sync();
      assert.equal(run.code, 0, run.stderr);
      done.push(run);
      if (run.report?.changed === false && run.report.complete) {
        assert.equal(run.report.atomicPushRefused, false);
        return done;
      }
    }
    assert.fail('the sync did not settle in five runs');
  }

  /** I4: every state ref only moved forward since the last look. */
  async function observeRefs(): Promise<void> {
    for (const ref of STATE_REFS) {
      const value = await remoteRef(ref);
      if (value === null) continue;
      const seen = history.get(ref) ?? [];
      const previous = seen.at(-1);
      if (previous !== undefined && previous !== value) {
        const forward = await fixture.remote.run(['merge-base', '--is-ancestor', previous, value], { okCodes: [0, 1] });
        assert.equal(forward.code, 0, `${ref} moved backwards (I4)`);
      }
      if (previous !== value) seen.push(value);
      history.set(ref, seen);
    }
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

  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  async function remoteRef(ref: string): Promise<string | null> {
    const found = await fixture.remote.run(['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] });
    return found.code === 0 ? found.stdout.toString('utf8').trim() : null;
  }
  const refTips = async () => Object.fromEntries(await Promise.all(STATE_REFS.map(async (ref) => [ref, await remoteRef(ref)] as const)));
  const ids = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const body = (text: string) => text.slice(text.indexOf('# '));
  async function documentOf(path: string): Promise<FakeDocument> {
    const id = (await ids())[path]?.id;
    const document = world.linear.documents.find((candidate) => candidate.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  }

  /** An edit a person makes in Linear: replaces `from` with `to` in the document's text. */
  async function editInLinear(path: string, from: string, to: string): Promise<void> {
    const document = await documentOf(path);
    assert.ok(document.content?.includes(from), `${path} does not hold the text to edit`);
    document.content = (document.content ?? '').replace(from, to);
    touch(document);
  }

  /** A person's commit on the tracked branch: replaces `from` with `to` in a file, then pushes. */
  async function editInGit(path: string, from: string, to: string): Promise<string> {
    await person.run(['pull', '--quiet', '--ff-only']);
    const file = join(personDir, path);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes(from), `${path} does not hold the text to edit`);
    await writeFile(file, text.replace(from, to));
    await person.run(['commit', '--quiet', '--all', '-m', 'Edit']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:main']);
    const commit = await person.text(['rev-parse', 'HEAD']);
    personCommits.push(commit);
    return commit;
  }

  /** I1 and I2: every document holds its file's body on the tracked branch, which holds each of `edits`. */
  async function assertConverged(edits: readonly string[]): Promise<void> {
    const tracked = await rev('refs/heads/main');
    for (const [path, entry] of Object.entries(await ids())) {
      const document = world.linear.documents.find((candidate) => candidate.id === entry.id);
      assert.ok(document !== undefined && document.trashed !== true, `${path}: no live document`);
      assert.equal(document.content, body(await show(`${tracked}:${path}`)), `${path}: Linear and the tracked branch differ (I1)`);
    }
    const all = (await Promise.all(Object.keys(TREE).map((path) => show(`${tracked}:${path}`)))).join('\n');
    for (const edit of edits) assert.ok(all.includes(edit), `the edit "${edit}" was lost (I2)`);
    const keys = world.linear.documents.filter((document) => document.trashed !== true).map((document) => `${document.projectId ?? document.teamId}/${document.title}`);
    assert.equal(new Set(keys).size, keys.length, 'a document exists twice');
  }

  /** I3: every commit the tracked branch gained is the person's or a merge of the sync branch. */
  async function assertTrackedHistory(): Promise<void> {
    const syncHeads = history.get('refs/heads/mdbisync/linear') ?? [];
    const lines = (await fixture.remote.text(['rev-list', '--first-parent', '--parents', `${start}..refs/heads/main`])).split('\n').filter(Boolean);
    for (const line of lines) {
      const [commit, ...parents] = line.split(' ');
      if (personCommits.includes(commit as string)) continue;
      assert.equal(parents.length, 2, `${commit} on the tracked branch is neither the person's nor a merge (I3)`);
      assert.ok(syncHeads.includes(parents[1] as string), `${commit} merges something other than the sync branch (I3)`);
    }
  }

  /** The checks every scenario ends with. */
  async function assertSettled(edits: readonly string[]): Promise<Ended[]> {
    const settled = await settle();
    await assertConverged(edits);
    await assertTrackedHistory();
    return settled;
  }

  /** A person or CI pushes a normal commit onto the pending sync branch. */
  async function editSyncBranch(path: string, from: string, to: string): Promise<string> {
    await person.run(['fetch', '--quiet', 'origin']);
    await person.run(['checkout', '--quiet', '-B', 'pending', 'origin/mdbisync/linear']);
    const file = join(personDir, path);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes(from));
    await writeFile(file, text.replace(from, to));
    await person.run(['commit', '--quiet', '--all', '-m', 'Apply review changes']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:refs/heads/mdbisync/linear']);
    await observeRefs();
    return person.text(['rev-parse', 'HEAD']);
  }

  async function assertRetained(commit: string): Promise<void> {
    for (const ref of ['refs/heads/main', 'refs/heads/mdbisync/linear']) {
      assert.equal((await fixture.remote.run(['merge-base', '--is-ancestor', commit, ref], { okCodes: [0, 1] })).code, 0, `${ref} lost the commit`);
    }
  }

  it('L4-07: closing a pending pull request opens a replacement from the same branch, retaining its edits', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    const opened = await sync();
    assert.equal(opened.report?.pullRequest?.pullRequest?.opened, true);
    const commit = await editSyncBranch(NOTES, 'First paragraph.', 'First paragraph, reviewed by a person.');
    const first = world.github.pullRequests[0];
    assert.ok(first);
    first.state = 'closed';
    const replacement = await sync();
    assert.equal(replacement.code, 0, replacement.stderr);
    assert.equal(replacement.report?.pullRequest?.pullRequest?.opened, true);
    assert.equal(world.github.pullRequests.length, 2);
    assert.equal(world.github.pullRequests[1]?.head, first.head);
    assert.equal(world.github.pullRequests[1]?.base, first.base);
    await assertSettled(['Findings, edited in Linear.', 'First paragraph, reviewed by a person.']);
    await assertRetained(commit);
  });

  it('L4-07: a replacement carries a pending person edit even when Linear has no remaining changes', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await sync();
    const commit = await editSyncBranch(NOTES, 'First paragraph.', 'First paragraph, reviewed by a person.');
    const first = world.github.pullRequests[0];
    assert.ok(first);
    first.state = 'closed';
    await editInLinear(REVIEW, 'Findings, edited in Linear.', 'Findings of the review.');
    const replacement = await sync();
    assert.equal(replacement.code, 0, replacement.stderr);
    assert.equal(replacement.report?.pullRequest?.pullRequest?.opened, true);
    assert.deepEqual(replacement.report?.pullRequest?.paths, [NOTES]);
    await assertSettled(['First paragraph, reviewed by a person.', 'Findings of the review.']);
    await assertRetained(commit);
  });

  it('L4-08: a person pushes to the pending sync branch; the commit and a later capture both converge', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await sync();
    const commit = await editSyncBranch(NOTES, 'First paragraph.', 'First paragraph, reviewed by a person.');
    await editInLinear(NOTES, 'Second paragraph.', 'Second paragraph, edited in Linear.');
    await assertSettled(['Findings, edited in Linear.', 'First paragraph, reviewed by a person.', 'Second paragraph, edited in Linear.']);
    await assertRetained(commit);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('L4-09: CI fixes before and after a new capture survive, including a push after the run fetched its head', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await sync();
    const first = await editSyncBranch(REVIEW, 'Findings, edited in Linear.', 'Findings, checked by CI.');
    await editInLinear(NOTES, 'First paragraph.', 'First paragraph, edited in Linear.');
    const captured = await sync();
    assert.equal(captured.code, 0, captured.stderr);
    assert.equal(captured.report?.pullRequest?.branchMoved, true);
    await editInLinear(NOTES, 'Second paragraph.', 'Second paragraph, edited in Linear.');
    const running = await startRun('after-capture-push-before-pr');
    await reached(running, 'after-capture-push-before-pr');
    const second = await editSyncBranch('eng/notes/plan.md', 'Steps one and two.', 'Steps one and two, checked by CI.');
    running.hooks.resume('after-capture-push-before-pr');
    const raced = await running.ended;
    assert.equal(raced.report?.pullRequest?.code, 'state-moved');
    assert.equal(raced.report?.pullRequest?.merged, null);
    await assertSettled(['Findings, checked by CI.', 'Steps one and two, checked by CI.', 'First paragraph, edited in Linear.', 'Second paragraph, edited in Linear.']);
    await assertRetained(first);
    await assertRetained(second);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('L4-01: of two overlapping runs one lease push is refused, nothing partial is written to the refs, and the next run converges', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    // The first run writes and waits before its record; the second runs from start to end meanwhile.
    const first = await startRun('after-write-before-record');
    await reached(first, 'after-write-before-record');
    const second = await sync();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.report?.atomicPushRefused, false);
    const afterSecond = await refTips();
    first.hooks.resume('after-write-before-record');
    const refused = await first.ended;

    // The refused run ends cleanly: a warning, a summary that says why, and every ref as the other run left it.
    assert.equal(refused.code, INCOMPLETE_EXIT_CODE, refused.stderr);
    assert.equal(refused.report?.atomicPushRefused, true);
    assert.equal(refused.report?.partialRefUpdates, 0);
    assert.equal(refused.report?.exitStatus, 'warning');
    assert.equal(refused.report?.code, 'state-moved');
    assert.match(refused.summary, /A state ref moved while this run was writing, so it recorded nothing/);
    assert.deepEqual(await refTips(), afterSecond);
    assert.equal([refused, second].filter((run) => run.report?.atomicPushRefused).length, 1);

    await assertSettled(['Findings, edited in Linear.', 'Second paragraph, edited in git.']);
  });

  it('L4-01: two runs started together both end cleanly, and the next run converges', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    const both = await Promise.all([startRun(), startRun()]);
    const ended = await Promise.all(both.map((run) => run.ended));
    for (const run of ended) {
      assert.ok(run.code === 0 || run.code === INCOMPLETE_EXIT_CODE, run.stderr);
      assert.equal(run.report?.partialRefUpdates, 0, run.stderr);
      if (run.code === INCOMPLETE_EXIT_CODE) assert.equal(run.report?.atomicPushRefused, true, run.stderr);
    }
    await assertSettled(['Findings, edited in Linear.', 'Second paragraph, edited in git.']);
  });

  it('L4-02: a document edited in Linear while the run waits to write is skipped; the record is an ordinary commit and the next run merges the edit', async () => {
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    // Another document the run does write, so it records what it did.
    await editInGit(REVIEW, 'Findings of the review.', 'Findings, revised in git.');
    const linearBefore = await rev('refs/mdbisync/linear');
    const running = await startRun('before-write');
    await reached(running, 'before-write');
    await editInLinear(NOTES, 'First paragraph.', 'First paragraph, typed in Linear meanwhile.');
    running.hooks.resume('before-write');
    const run = await running.ended;

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.report?.skippedConcurrentDocument, true);
    assert.deepEqual(run.report?.sync?.skipped, [{ path: NOTES, reason: 'edited-in-linear' }]);
    assert.deepEqual(run.report?.sync?.updated, [REVIEW]);
    assert.equal(run.report?.record?.kind, 'ordinary');
    assert.equal(run.report?.record?.hasTrackedParent, false);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), PARTIAL_RECORD_MESSAGE);
    assert.deepEqual((await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@'])).split('\n'), [linearBefore]);
    // Her edit stays in Linear: nothing overwrote it.
    assert.match((await documentOf(NOTES)).content ?? '', /typed in Linear meanwhile/);

    await assertSettled(['First paragraph, typed in Linear meanwhile.', 'Second paragraph, edited in git.', 'Findings, revised in git.']);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), MERGE_RECORD_MESSAGE);
  });

  it('L4-03: an edit inside the window between re-read and write is overwritten; the run reports the window', async (t: TestContext) => {
    // The window without a pause: what a run leaves to chance.
    await editInGit(REVIEW, 'Findings of the review.', 'Findings, revised in git.');
    const natural = await sync();
    assert.equal(natural.code, 0, natural.stderr);
    const naturalWindow = natural.report?.rereadWindowMs;
    assert.equal(typeof naturalWindow, 'number');

    // Edits typed while the run is held inside the window.
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    const running = await startRun('after-reread-before-write');
    await reached(running, 'after-reread-before-write');
    const heldFrom = performance.now();
    // Each edit adds its own paragraph and keeps the earlier ones: twenty edits that should all survive.
    const tokens = Array.from({ length: 20 }, (_, index) => `Typed in the window (${index}).`);
    for (const token of tokens) await editInLinear(NOTES, 'First paragraph.', `First paragraph.\n\n${token}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    running.hooks.resume('after-reread-before-write');
    const heldMs = performance.now() - heldFrom;
    const run = await running.ended;
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.report?.skippedConcurrentDocument, false);
    assert.deepEqual(run.report?.sync?.updated, [NOTES]);
    const window = run.report?.rereadWindowMs ?? 0;
    assert.ok(window >= heldMs - 1, `the reported window ${window} ms is shorter than the ${Math.round(heldMs)} ms the run was held`);

    await assertSettled(['Second paragraph, edited in git.']);
    const tracked = await show(`refs/heads/main:${NOTES}`);
    const linearText = (await documentOf(NOTES)).content ?? '';
    const lost = tokens.filter((token) => !tracked.includes(token) && !linearText.includes(token));
    const metrics = { raceWindowMs: Math.round(heldMs), engineWindowMs: window, naturalWindowMs: naturalWindow, raceOutcome: lost.length === 0 ? 'no-loss' : 'edits-lost', lostEditCount: lost.length };
    t.diagnostic(`L4-03 metrics: ${JSON.stringify(metrics)}`);
    // Linear takes the write without a version and this fake replaces the whole text, so every edit typed in the window is
    // lost: the accepted risk of the window. Live Linear merges a write into its stored text and may keep them.
    assert.equal(metrics.lostEditCount, tokens.length);
  });

  it('L4-03: a write retried after a rate limit counts its wait in the reported window', async () => {
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    // The first write is answered with a rate limit and a short Retry-After; the client waits and sends it again.
    let limited = false;
    server.fault = (body) => {
      if (limited || !body.includes('UpdateDocument')) return undefined;
      limited = true;
      return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      });
    };
    const run = await sync();
    delete server.fault;
    assert.equal(run.code, 0, run.stderr);
    assert.ok(limited, 'the write was not rate limited');
    assert.deepEqual(run.report?.sync?.updated, [NOTES]);
    const window = run.report?.rereadWindowMs ?? 0;
    assert.ok(window >= 1000, `the reported window ${window} ms leaves out the one-second retry`);
  });

  it('L4-04: a run killed between write and record heals: the next capture takes the written documents equal to the tracked branch, and they add nothing to the pull request', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    const gitEdit = await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    const running = await startRun('after-write-before-record');
    await reached(running, 'after-write-before-record');
    const capturedTip = await rev('refs/mdbisync/linear');
    running.kill();
    const killed = await running.ended;
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(killed.report, null);
    // Written to Linear, not recorded.
    assert.equal((await documentOf(NOTES)).content, body(await show(`${gitEdit}:${NOTES}`)));
    assert.equal(await rev('refs/mdbisync/linear'), capturedTip);

    const [next] = await assertSettled(['Findings, edited in Linear.', 'Second paragraph, edited in git.']);
    assert.ok(next?.report?.capture?.changed.includes(NOTES), 'the next capture did not take the written document');
    assert.equal(body(await show(`refs/mdbisync/linear:${NOTES}`)), body(await show(`${gitEdit}:${NOTES}`)));
    assert.deepEqual(next?.report?.sync?.updated, []);
    // The sync pull request carries only the Linear edit.
    for (const run of [next]) assert.ok(!(run?.report?.pullRequest?.paths ?? []).includes(NOTES), 'the written document reached the pull request');
  });

  it('L4-05: a run killed after its capture push and before the pull request: the next run opens the pull request', async () => {
    await editInLinear(REVIEW, 'Findings of the review.', 'Findings, edited in Linear.');
    await editInGit(NOTES, 'Second paragraph.', 'Second paragraph, edited in git.');
    const running = await startRun('after-capture-push-before-pr');
    await reached(running, 'after-capture-push-before-pr');
    running.kill();
    const killed = await running.ended;
    assert.equal(killed.signal, 'SIGKILL');
    assert.match(await show(`refs/mdbisync/linear:${REVIEW}`), /edited in Linear/);
    assert.deepEqual(world.github.pullRequests, []);

    const [next] = await assertSettled(['Findings, edited in Linear.', 'Second paragraph, edited in git.']);
    assert.equal(next?.report?.pullRequest?.pullRequest?.opened, true);
    assert.deepEqual(next?.report?.pullRequest?.paths, [REVIEW]);
    assert.equal(world.github.pullRequests.length, 1);
  });

  it('L4-06: a push to the tracked branch during a run: the record merges the commit the run took in, and the next run takes the new one', async () => {
    const first = await editInGit(NOTES, 'First paragraph.', 'First paragraph, edited in git.');
    const linearBefore = await rev('refs/mdbisync/linear');
    const running = await startRun('after-local-merge-before-record');
    await reached(running, 'after-local-merge-before-record');
    const second = await editInGit(REVIEW, 'Findings of the review.', 'Findings, pushed during the run.');
    running.hooks.resume('after-local-merge-before-record');
    const run = await running.ended;

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.report?.capturedTrackedTip, first);
    assert.equal(run.report?.record?.kind, 'merge');
    assert.deepEqual((await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@'])).split('\n'), [linearBefore, first]);
    assert.deepEqual(run.report?.sync?.updated, [NOTES]);
    assert.match((await documentOf(REVIEW)).content ?? '', /Findings of the review/);

    const [next] = await assertSettled(['First paragraph, edited in git.', 'Findings, pushed during the run.']);
    assert.equal(next?.report?.capturedTrackedTip, second);
    assert.deepEqual(next?.report?.sync?.updated, [REVIEW]);
  });
});

/** Serves the fake world over HTTP for engine processes: `/github/...` and `/linear/...`. */
interface Served {
  url: string;
  /** Answers a request before the fake world does, for a fault; undefined lets the world answer. */
  fault?: (body: string) => Response | undefined;
  close: () => Promise<void>;
}

async function serve(world: FakeWorld): Promise<Served> {
  const answer = fakeFetch(world);
  const served: Served = { url: '', close: async () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const path = request.url ?? '/';
      const target = path.startsWith('/github/') ? `${GITHUB_API}${path.slice('/github'.length)}` : `${LINEAR_API}${path.slice('/linear'.length)}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string' && name !== 'host' && name !== 'content-length') headers.set(name, value);
      const method = request.method ?? 'GET';
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const reply = served.fault?.(body) ?? (await answer(target, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) }));
        const bytes = Buffer.from(await reply.arrayBuffer());
        response.writeHead(reply.status, { ...Object.fromEntries(reply.headers), 'content-type': reply.headers.get('content-type') ?? 'application/json', 'content-length': String(bytes.length) });
        response.end(bytes);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  served.url = `http://127.0.0.1:${port}`;
  served.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return served;
}
