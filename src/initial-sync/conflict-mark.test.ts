// The confirmed initial sync from git to Linear sets the conflict mark on a
// document whose text holds a sync conflict, as the sync's write step does:
// the document's own icon and color go to `ids` first, then the mark and its
// one comment. Quoted lookalike markers are no conflict. Through the command
// line, against a local git remote and a fake GitHub and Linear.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type IdEntry } from '../state/index.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { CONFLICT_COMMENT, MARKS } from '../sync/marks.ts';

const fixtureText = (name: string) => readFile(new URL(`../../test/fixtures/conflict-markers/${name}`, import.meta.url), 'utf8');

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const CONFLICT = 'eng/backend/conflict.md';
const QUOTED = 'eng/backend/quoted.md';

describe('confirmed initial sync from git to Linear: the conflict mark', () => {
  let fixture: Fixture;
  let cwd: string;
  /** Each file's canary, which must not reach the output, report or summary. */
  const canaries: string[] = [];
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    const conflict = await fixtureText('sync-markers-code.md');
    // The same markers quoted: an example of a conflict, not one. (Git's own markers are left out by the format check, quoted or not.)
    const quoted = [
      '> **Sync conflict: git version**', '>', '> npm ci', '>',
      '> **Sync conflict: Linear version**', '>', '> npm install', '>',
      '> **Sync conflict: end**', '', 'Ref kx-0d3f8a61', '',
    ].join('\n');
    canaries.splice(0, canaries.length, ...[conflict, quoted].map((text) => (/kx-[0-9a-f]{8}/.exec(text) as RegExpExecArray)[0]));
    fixture = await createFixture();
    await fixture.seed({
      '.pre-commit-config.yaml': PRE_COMMIT,
      'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
      [CONFLICT]: conflict,
      [QUOTED]: quoted,
    });
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

  const readIds = async () => JSON.parse(await fixture.remote.text(['show', 'refs/mdbisync/ids:ids.json'])) as Record<string, IdEntry>;
  const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
  const documentOf = async (world: FakeWorld, path: string) => {
    const id = (await readIds())[path]?.id;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  };

  /**
   * Runs the initial sync and returns the Linear requests it made, by
   * operation. Before the mark replaces a document's icon, `ids` on the remote
   * must already hold the icon it replaces.
   */
  const run = async (world: FakeWorld) => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const mark = await markWorld(world, fixture);
    const operations: string[] = [];
    const inner = fakeFetch(world);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input) === `${LINEAR_API}/graphql`) {
        const { operationName, variables } = JSON.parse(String(init?.body)) as { operationName: string; variables: { id?: string; input?: { icon?: string } } };
        operations.push(operationName);
        if (operationName === 'UpdateDocument' && variables.input?.icon === MARKS.conflict.icon) {
          const saved = Object.values(await readIds()).find((entry) => entry.id === variables.id)?.saved;
          const before = world.linear.documents.find((d) => d.id === variables.id);
          assert.ok(saved !== undefined, 'the mark came before its saved icon was pushed');
          assert.deepEqual([saved.icon, saved.color], [before?.icon ?? null, before?.color ?? null], 'the saved icon is not the one the mark replaces');
        }
      }
      return inner(input, init);
    };
    const result = await runCli(['initial-sync'], { env: env(), cwd, fetch });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    for (const canary of canaries) {
      assert.ok(![result.stdout, result.stderr, summary, JSON.stringify(report)].some((text) => text.includes(canary)), 'content reached the output');
    }
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: world.linear.writes.rateLimitAt !== undefined });
    return { result, report, operations };
  };

  /** The conflicted document shows the mark and has exactly one conflict comment, which `ids` records as posted. */
  const assertMarked = async (world: FakeWorld, own: { icon: string | null; color: string | null }) => {
    const document = await documentOf(world, CONFLICT);
    assert.deepEqual([document.icon, document.color], [MARKS.conflict.icon, MARKS.conflict.color]);
    const comments = [...world.linear.comments.entries()].filter(([, comment]) => comment.documentContentId === `content-${document.id}`);
    assert.equal(comments.length, 1, 'not exactly one conflict comment');
    assert.equal(comments[0]?.[1].body, CONFLICT_COMMENT);
    const saved = (await readIds())[CONFLICT]?.saved;
    assert.deepEqual({ icon: saved?.icon, color: saved?.color }, own);
    assert.equal(saved?.notice?.kind, 'conflict');
    assert.equal(saved?.notice?.posted, true);
    assert.equal(saved?.notice?.id, comments[0]?.[0]);
  };

  /** Quoted lookalike markers are no conflict: no mark, no comment, no saved icon. */
  const assertQuotedClear = async (world: FakeWorld, own: { icon?: string; color?: string } = {}) => {
    const document = await documentOf(world, QUOTED);
    assert.equal(document.icon, own.icon);
    assert.equal(document.color, own.color);
    assert.ok(![...world.linear.comments.values()].some((comment) => comment.documentContentId === `content-${document.id}`));
    assert.equal((await readIds())[QUOTED]?.saved, undefined);
  };

  it('a created document with a conflict gets the mark and one comment; quoted lookalike markers do not', async () => {
    const world = fakeWorld();
    const { result, report, operations } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.initialSync?.created, ['eng/README.md', CONFLICT, QUOTED]);
    await assertMarked(world, { icon: null, color: null });
    await assertQuotedClear(world);
    // The mark's requests are its icon and its comment, for the conflicted document only.
    const counts = Object.fromEntries(['CreateDocument', 'UpdateDocument', 'FindDocumentComment', 'CommentOnDocument'].map((name) => [name, operations.filter((operation) => operation === name).length]));
    assert.deepEqual(counts, { CreateDocument: 3, UpdateDocument: 1, FindDocumentComment: 1, CommentOnDocument: 1 });
    // I9: at most 1.5 requests per written document plus 5 for the run.
    assert.ok(operations.length <= 1.5 * 3 + 5, `${operations.length} requests: ${operations.join(', ')}`);
  });

  it('an adopted document keeps its own icon in ids; a clear one keeps its icon in Linear', async () => {
    const world = fakeWorld();
    world.linear.documents = [
      { id: 'doc-conflict', title: 'backend/conflict', teamId: 'team-eng', createdAt: '2026-01-01T00:00:01Z', content: 'Old text.', icon: 'Book', color: '#5E6AD2' },
      { id: 'doc-quoted', title: 'backend/quoted', teamId: 'team-eng', createdAt: '2026-01-01T00:00:02Z', content: 'Old text.', icon: 'Book', color: '#5E6AD2' },
    ];
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.initialSync?.overwritten, [CONFLICT, QUOTED]);
    assert.equal((await readIds())[CONFLICT]?.id, 'doc-conflict');
    await assertMarked(world, { icon: 'Book', color: '#5E6AD2' });
    await assertQuotedClear(world, { icon: 'Book', color: '#5E6AD2' });
  });

  it('run again with nothing changed, it posts no second comment and leaves the refs as they are', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();
    const writes = world.linear.writes.count;
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.initialSync?.unchanged, ['eng/README.md', CONFLICT, QUOTED]);
    assert.equal(world.linear.writes.count, writes);
    assert.equal(await refs(), before);
    await assertMarked(world, { icon: null, color: null });
  });

  it('a run stopped between the write and the mark is resumed with the mark and one comment', async () => {
    const world = fakeWorld();
    // Mutations: the README, the conflicted document, then its mark, which is rate limited.
    world.linear.writes.rateLimitAt = 3;
    const first = await run(world);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.equal(first.report.code, 'stopped');
    assert.equal((await documentOf(world, CONFLICT)).icon, undefined);
    assert.equal(world.linear.comments.size, 0);

    delete world.linear.writes.rateLimitAt;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(second.report.resumed, true);
    assert.ok(second.report.initialSync?.skippedCompleted.includes(CONFLICT));
    await assertMarked(world, { icon: null, color: null });
    await assertQuotedClear(world);
  });

  it('with the state refs deleted, a recovery run keeps one comment and does not take the mark for the own icon', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.initialSync?.unchanged, ['eng/README.md', CONFLICT, QUOTED]);
    await assertMarked(world, { icon: null, color: null });
    await assertQuotedClear(world);
  });
});
