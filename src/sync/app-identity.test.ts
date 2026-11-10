// Who the sync's commits are by, through the command line against a local
// git remote and a fake GitHub and Linear: given the App's slug, every
// commit the initial sync and the sync make (the state refs, the capture
// of Linear's changes, the sync branch and its merges, the record of what
// was written to Linear) names the App's bot account as author and
// committer; without it, the neutral identity.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { FAKE_APP_IDENTITY, FAKE_APP_SLUG, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { NEUTRAL_IDENTITY } from '../setup/github.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { Git } from '../state/index.ts';

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const TREE: Record<string, string> = {
  'README.md': '# Repository\n',
  'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
  'eng/notes/README.md': '---\nlinear-project: Field notes\n---\n\n# Field notes\n',
  'eng/notes/plan.md': '# Plan\n\nSteps one and two.\n',
  'eng/notes/review.md': '# Review\n\nOpen.\n',
  'combined/README.md': '---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n',
  'combined/guide.md': '# Guide\n\nHow to start.\n',
  '.pre-commit-config.yaml': PRE_COMMIT,
};

const SYNC_REFS = ['refs/mdbisync/linear', 'refs/mdbisync/ids', 'refs/mdbisync/uploads', 'refs/heads/mdbisync/linear'];
const SYNC_BRANCH = 'refs/heads/mdbisync/linear';
const CI_FIX = 'Apply pre-commit fixes';
const CI_IDENTITY = {
  GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

describe('the commit identity of the sync', () => {
  let fixture: Fixture;
  let cwd: string;
  let person: Git;
  let personDir: string;
  let world: FakeWorld;

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    personDir = join(fixture.root, 'person');
    await new Git(fixture.root).run(['clone', '--quiet', fixture.url, personDir]);
    person = new Git(personDir, { GIT_AUTHOR_NAME: 'A person', GIT_AUTHOR_EMAIL: 'person@example.com', GIT_COMMITTER_NAME: 'A person', GIT_COMMITTER_EMAIL: 'person@example.com' });
    world = fakeWorld();
    world.github.checks = new Map();
  });
  afterEach(() => fixture.cleanup());

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_MERGE_GRACE_SECONDS: '0',
    MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    ...extra,
  });

  /** A run whose sync pull request waits on a queued check, so the sync branch keeps its own commits. */
  async function cli(command: string, extra: Record<string, string>) {
    const transport = fakeFetch(world);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes('/check-runs?')) {
        const head = await fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], { okCodes: [0, 1] });
        if (head.code === 0) world.github.checks?.set(head.stdout.toString('utf8').trim(), [{ name: 'ci', status: 'queued', conclusion: 'success' }]);
      }
      return transport(input, init);
    };
    const result = await runCli([command], { env: env(extra), cwd, fetch: fetchImpl });
    assert.equal(result.exitCode, 0, result.stderr);
  }

  async function editInLinear(path: string, content: string) {
    const ids = JSON.parse(await fixture.remote.text(['show', 'refs/mdbisync/ids:ids.json'])) as Record<string, { id: string }>;
    const document = world.linear.documents.find((candidate) => candidate.id === ids[path]?.id);
    assert.ok(document !== undefined, `${path} has no document`);
    document.content = content;
    touch(document);
  }

  async function editInGit(path: string, content: string) {
    await person.run(['pull', '--quiet', '--ff-only']);
    await writeFile(join(personDir, path), content);
    await person.run(['commit', '--quiet', '--all', '-m', 'Edit']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:main']);
  }

  /** A fixing commit CI pushes onto the sync branch under its own name, as the pre-commit example does. */
  async function fixOnSyncBranch() {
    await person.run(['fetch', '--quiet', 'origin', `${SYNC_BRANCH}:refs/remotes/origin/sync`]);
    await person.run(['checkout', '--quiet', '-B', 'sync', 'refs/remotes/origin/sync']);
    await writeFile(join(personDir, 'combined/guide.md'), '# Guide\n\nHow to start.\n\nFixed.\n');
    await person.run(['commit', '--quiet', '--all', '-m', CI_FIX], { env: CI_IDENTITY });
    await person.run(['push', '--quiet', 'origin', `HEAD:${SYNC_BRANCH}`]);
    await person.run(['checkout', '--quiet', 'main']);
  }

  /** Every commit on the sync's refs that the tracked branch does not hold, as `subject|parents|author|committer`. */
  async function syncCommits(): Promise<Array<{ subject: string; parents: number; author: string; committer: string }>> {
    const present: string[] = [];
    for (const ref of SYNC_REFS) if ((await fixture.remote.run(['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] })).code === 0) present.push(ref);
    const log = await fixture.remote.text(['log', '--format=%s%x00%P%x00%an <%ae>%x00%cn <%ce>', ...present, '--not', 'refs/heads/main']);
    return log.split('\n').filter(Boolean).map((line) => {
      const [subject, parents, author, committer] = line.split('\0') as [string, string, string, string];
      return { subject, parents: parents.split(' ').filter(Boolean).length, author, committer };
    });
  }

  /** The initial sync, a capture that opens the sync pull request, then edits on both sides while it waits. */
  async function cycle(extra: Record<string, string>) {
    await cli('initial-sync', { ...extra, MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    await editInLinear('eng/notes/plan.md', '# Plan\n\nSteps one, two and three.\n');
    await cli('sync', extra);
    await fixOnSyncBranch();
    await editInLinear('eng/notes/plan.md', '# Plan\n\nSteps one to four.\n');
    await editInGit('eng/notes/review.md', '# Review\n\nClosed.\n');
    await cli('sync', extra);
    // The git edit reached Linear, so the run recorded what it wrote.
    const review = world.linear.documents.find((document) => document.content?.includes('Closed.'));
    assert.ok(review !== undefined, 'the git edit did not reach Linear');
    // CI's fixing commit keeps CI's name; every other commit is the sync's.
    const commits = await syncCommits();
    assert.equal(commits.filter((commit) => commit.subject === CI_FIX && commit.author.startsWith('github-actions[bot] ')).length, 1);
    return commits.filter((commit) => commit.subject !== CI_FIX);
  }

  it('names the App\'s bot account on every commit, given the App slug', async () => {
    const commits = await cycle({ MDBISYNC_APP_SLUG: FAKE_APP_SLUG });
    const app = `${FAKE_APP_IDENTITY.name} <${FAKE_APP_IDENTITY.email}>`;
    assert.equal(app, 'sync-app[bot] <1001+sync-app[bot]@users.noreply.github.com>');
    for (const commit of commits) {
      assert.equal(commit.author, app, commit.subject);
      assert.equal(commit.committer, app, commit.subject);
    }
    const subjects = new Set(commits.map((commit) => commit.subject));
    // Every kind of commit the sync makes is among them.
    assert.ok(subjects.has('Capture Linear changes'), [...subjects].join(', '));
    assert.ok(subjects.has("Merge Linear's latest changes"), [...subjects].join(', '));
    assert.ok(subjects.has('Sync: document ids'), [...subjects].join(', '));
    assert.ok(commits.length >= 8, `${commits.length} commits`);
    assert.ok(world.requests.includes(`GET ${GITHUB_API}/users/sync-app%5Bbot%5D`));
  });

  it('names the neutral identity on every commit without an App slug, and never a person', async () => {
    const commits = await cycle({});
    const neutral = `${NEUTRAL_IDENTITY.name} <${NEUTRAL_IDENTITY.email}>`;
    assert.ok(commits.length >= 8, `${commits.length} commits`);
    for (const commit of commits) {
      assert.equal(commit.author, neutral, commit.subject);
      assert.equal(commit.committer, neutral, commit.subject);
    }
    assert.ok(!world.requests.some((request) => request.includes('/users/')));
  });

  it('stops before writing when GitHub has no account for the App slug', async () => {
    const result = await runCli(['initial-sync'], { env: env({ MDBISYNC_APP_SLUG: 'other-app', MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true', GITHUB_STEP_SUMMARY: join(fixture.root, 'summary.md') }), cwd, fetch: fakeFetch(world) });
    assert.notEqual(result.exitCode, 0);
    assert.match(await readFile(join(fixture.root, 'summary.md'), 'utf8'), /GitHub has no App account other-app\[bot\]/);
    assert.deepEqual(world.writes, []);
    assert.deepEqual(await syncCommits(), []);
  });
});
