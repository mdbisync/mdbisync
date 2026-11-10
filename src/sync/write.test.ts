// The sync's git → Linear direction through the command line, against a
// local git remote and a fake GitHub and Linear: after a confirmed initial
// sync, a person commits to the tracked branch and the sync takes the change
// to Linear and records it on `linear`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { Git } from '../state/index.ts';
import { fixText } from '../format/index.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, IDENTITY, createFixture } from '../state/test-helpers.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from './write.ts';

const CANARY = 'kx-5b1e0a94';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const TREE: Record<string, string> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\nFirst paragraph.\n\nSecond paragraph. ${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two. ${CANARY}\n`,
  'eng/notes/review.md': `# Review\n\nFindings of the review. ${CANARY}\n`,
  'eng/notes/draft.md': `# Draft\n\nA claim.[^1] ${CANARY}\n\n[^1]: A source.\n`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/guide.md': `# Guide\n\nHow to start. ${CANARY}\n`,
  'eng/media/diagram.png': Buffer.from('first diagram bytes').toString('latin1'),
  'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nWhat it shows. ${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
};

describe('sync: the tracked branch to Linear', () => {
  let fixture: Fixture;
  let cwd: string;
  let person: Git;
  let personDir: string;
  let world: FakeWorld;
  let fetchOverride: typeof fetch | undefined;
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    personDir = join(fixture.root, 'person');
    await new Git(fixture.root).run(['clone', '--quiet', fixture.url, personDir]);
    person = new Git(personDir, {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    });
    world = fakeWorld();
    fetchOverride = undefined;
    world.linear.projects.push({ id: 'project-archive', name: 'Archive', teamIds: ['team-eng'] });
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    // The footnote of `eng/notes/draft.md` leaves it out; an initial sync from git names no file from a title.
    assert.deepEqual(initial.report.leftOutRules, ['footnote']);
    assert.equal(initial.report.paths, null);
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

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const before = world.requests.length;
    const writesBefore = world.writes.length;
    const result = await runCli([command], { env: env(extra), cwd, fetch: fetchOverride ?? fakeFetch(world) });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    for (const text of [result.stdout, result.stderr, summary, JSON.stringify(report)]) assert.ok(!text.includes(CANARY), 'content reached the output');
    const graphql = world.requests.slice(before).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
    return { result, report, summary, graphql, writes: world.writes.slice(writesBefore) };
  }

  // Mutate after the capture, before the next Linear request in write. The capture lists the documents, then reads
  // the content of those that changed since the record, if any: a run whose record holds them all reads none.
  const afterCapture = (change: () => void) => {
    let listed = false;
    let read = false;
    world.linear.beforeQuery = (operation, variables) => {
      if (!listed) listed = operation === 'ListDocuments';
      else if (!read && operation === 'GetDocuments' && variables.withContent === true) read = true;
      else { delete world.linear.beforeQuery; change(); }
    };
  };

  const sync = (extra: Record<string, string> = {}) => cli('sync', extra);

  /** Commits as a person: files to write (null removes) and moves, then pushes to the tracked branch. */
  async function commit(changes: Record<string, string | null>, moves: Array<[string, string]> = []) {
    await person.run(['pull', '--quiet', '--ff-only']);
    for (const [from, to] of moves) {
      await mkdir(dirname(join(personDir, to)), { recursive: true });
      await rename(join(personDir, from), join(personDir, to));
    }
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) await rm(join(personDir, path));
      else {
        await mkdir(dirname(join(personDir, path)), { recursive: true });
        await writeFile(join(personDir, path), content);
      }
    }
    await person.run(['add', '--all']);
    await person.run(['commit', '--quiet', '-m', 'Edit']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:main']);
  }

  /** A file's exact bytes, final newline included. */
  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const ids = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const live = () => world.linear.documents.filter((d) => d.trashed !== true);
  const documentOf = async (path: string): Promise<FakeDocument> => {
    const id = (await ids())[path]?.id;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  };
  const body = (path: string, text: string) => text.slice(text.indexOf(`# `));

  /** Every live document holds its file's body; no title twice in a place. */
  async function assertConverged() {
    const map = await ids();
    const tracked = await rev('refs/heads/main');
    for (const [path, entry] of Object.entries(map)) {
      const document = world.linear.documents.find((d) => d.id === entry.id);
      assert.ok(document !== undefined && document.trashed !== true, `${path}: no live document`);
      const text = await show(`${tracked}:${path}`);
      // Left-out files keep an older text; images are compared in their own tests.
      if (!text.includes('[^1]') && !text.includes('![')) assert.equal(document.content, body(path, text), `${path}: content`);
    }
    const keys = live().map((d) => `${d.projectId ?? d.teamId}/${d.title}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate documents');
  }

  /** One more run changes nothing (I6). */
  async function assertIdempotent() {
    const before = await rev('refs/mdbisync/linear');
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(again.writes, []);
    assert.equal(again.report.changed, false);
    assert.equal(again.report.complete, true);
    assert.equal(await rev('refs/mdbisync/linear'), before);
  }

  /** The `linear` tip merges the tracked branch: parents (previous tip, tracked). */
  async function assertMergeRecord(previous: string) {
    const parents = (await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@'])).split('\n');
    assert.deepEqual(parents, [previous, await rev('refs/heads/main')]);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), MERGE_RECORD_MESSAGE);
  }

  it('with nothing new on the tracked branch the run writes nothing and records nothing', async () => {
    await assertIdempotent();
  });

  it('L2-01: an edited paragraph reaches its document in one request; the record is a merge commit', async () => {
    const previous = await rev('refs/mdbisync/linear');
    const before = await documentOf('eng/backend/notes.md');
    await commit({ 'eng/backend/notes.md': `# Notes\n\nFirst paragraph, edited.\n\nSecond paragraph. ${CANARY}\n` });
    const { result, report, writes, graphql } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument']);
    assert.deepEqual(report.sync?.updated, ['eng/backend/notes.md']);
    assert.equal(report.complete, true);
    assert.equal(report.sync?.record?.kind, 'merge');
    assert.equal((await documentOf('eng/backend/notes.md')).id, before.id);
    assert.match((await documentOf('eng/backend/notes.md')).content ?? '', /edited/);
    await assertMergeRecord(previous);
    // The record holds the tracked tree: Linear kept the text.
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    // I9: one read again and one write, plus setup and one capacity list per annotated container.
    const capacityLists = report.capacity.length;
    assert.equal(capacityLists, 3);
    assert.ok(graphql <= 1 * 1.5 + 5 + capacityLists, `requests: ${graphql}`);
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-02: a new file becomes a document in its project and its id is recorded', async () => {
    await commit({ 'eng/notes/guides/setup.md': `# Setup\n\nInstall it. ${CANARY}\n`, 'eng/ops.md': `# Ops\n\nRun it. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['CreateDocument', 'CreateDocument']);
    assert.deepEqual(report.sync?.created, ['eng/notes/guides/setup.md', 'eng/ops.md']);
    const setup = await documentOf('eng/notes/guides/setup.md');
    assert.equal(setup.title, 'guides/setup');
    assert.equal(setup.projectId, 'project-api');
    const ops = await documentOf('eng/ops.md');
    assert.equal(ops.title, 'ops');
    assert.equal(ops.teamId, 'team-eng');
    assert.equal(ops.projectId, undefined);
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-03: a removed file sends its document to the trash, from which it can be restored', async () => {
    const document = await documentOf('eng/notes/review.md');
    await commit({ 'eng/notes/review.md': null });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['TrashDocument']);
    assert.deepEqual(report.sync?.trashed, ['eng/notes/review.md']);
    assert.equal(document.trashed, true);
    assert.equal((await ids())['eng/notes/review.md'], undefined);
    assert.equal(report.sync?.record?.kind, 'merge');
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-04: a file moved inside its project renames its document; the id stays', async () => {
    const document = await documentOf('eng/notes/review.md');
    await commit({}, [['eng/notes/review.md', 'eng/notes/archive/review.md']]);
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument']);
    assert.deepEqual(report.sync?.relocated, [{ from: 'eng/notes/review.md', to: 'eng/notes/archive/review.md' }]);
    assert.deepEqual(report.sync?.created, []);
    assert.equal(document.title, 'archive/review');
    assert.equal(document.trashed, undefined);
    assert.equal((await ids())['eng/notes/archive/review.md']?.id, document.id);
    assert.equal((await ids())['eng/notes/review.md'], undefined);
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-05: a file moved to another team and project moves its document; the id stays', async () => {
    const document = await documentOf('eng/notes/review.md');
    const team = await documentOf('eng/backend/notes.md');
    await commit({}, [
      ['eng/notes/review.md', 'combined/review.md'],
      ['eng/backend/notes.md', 'eng/notes/backend-notes.md'],
    ]);
    const { result, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument', 'UpdateDocument']);
    assert.equal(document.projectId, 'project-handbook');
    assert.equal(document.title, 'review');
    assert.equal(team.projectId, 'project-api');
    assert.equal(team.teamId, undefined);
    assert.equal(team.title, 'backend-notes');
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-06: a move with a heavy rewrite creates a new document and trashes the old one', async () => {
    const old = await documentOf('eng/notes/review.md');
    await commit({ 'eng/notes/review.md': null, 'eng/notes/retro.md': `# Retro\n\nWhat went well, what did not, and what we change next time. ${CANARY}\n` });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.created, ['eng/notes/retro.md']);
    assert.deepEqual(report.sync?.trashed, ['eng/notes/review.md']);
    assert.equal(old.trashed, true);
    assert.notEqual((await documentOf('eng/notes/retro.md')).id, old.id);
    await assertConverged();
  });

  it('L2-07: a copied file is a new document; the original keeps its own', async () => {
    const original = await documentOf('eng/notes/review.md');
    await commit({ 'eng/notes/review-copy.md': TREE['eng/notes/review.md'] as string });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['CreateDocument']);
    assert.deepEqual(report.sync?.created, ['eng/notes/review-copy.md']);
    assert.equal((await documentOf('eng/notes/review.md')).id, original.id);
    await assertConverged();
  });

  it('L2-08: a README that names another project moves all its documents there', async () => {
    const before = await Promise.all(['eng/notes/README.md', 'eng/notes/figure.md', 'eng/notes/plan.md', 'eng/notes/review.md'].map(documentOf));
    await commit({ 'eng/notes/README.md': `---\nlinear-project: Archive\n---\n\n# Field notes\n\n${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument', 'UpdateDocument', 'UpdateDocument', 'UpdateDocument']);
    assert.deepEqual(report.sync?.updated, []);
    for (const document of before) assert.equal(document.projectId, 'project-archive');
    await assertConverged();
    await assertIdempotent();
  });

  it('L2-11: a change of front matter only writes nothing to Linear and is recorded', async () => {
    const previous = await rev('refs/mdbisync/linear');
    await commit({ 'eng/notes/plan.md': `---\nowner: someone-else\n---\n\n# Plan\n\nSteps one and two. ${CANARY}\n` });
    const { result, writes, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.equal(report.complete, true);
    await assertMergeRecord(previous);
    assert.match(await show('refs/mdbisync/linear:eng/notes/plan.md'), /someone-else/);
    await assertIdempotent();
  });

  it('L2-12: a left-out file that is fixed joins: a document is created', async () => {
    assert.equal(live().some((d) => d.title === 'draft'), false);
    await commit({ 'eng/notes/draft.md': `# Draft\n\nA claim. ${CANARY}\n` });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.created, ['eng/notes/draft.md']);
    await assertConverged();
  });

  it('L2-13: a synchronized file that gains a footnote is left out and its document stays as it was', async () => {
    const document = await documentOf('eng/notes/review.md');
    const content = document.content;
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings.[^1] ${CANARY}\n\n[^1]: A note.\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.ok(report.sync?.leftOut.some((entry) => entry.path === 'eng/notes/review.md' && entry.rules.includes('footnote')));
    assert.deepEqual(report.leftOutRules, ['footnote']);
    assert.equal(document.content, content);
    assert.equal(document.trashed, undefined);
    assert.equal((await ids())['eng/notes/review.md']?.id, document.id);
    assert.equal(report.complete, true);
    await assertIdempotent();

    // A run with nothing new still names the files that stay left out, and writes nothing.
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
    assert.equal(quiet.report.changed, false);
    assert.equal(quiet.report.writtenDocuments, 0);
    assert.deepEqual(quiet.report.sync?.leftOut, [
      { path: 'eng/notes/draft.md', rules: ['footnote'] },
      { path: 'eng/notes/review.md', rules: ['footnote'] },
    ]);
    assert.deepEqual(quiet.report.leftOutRules, ['footnote']);
    assert.match(quiet.summary, /^\| eng\/notes\/review\.md \| footnote \|$/m);
    assert.equal(document.content, content);

    // Fixed again: the same document gets the text.
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings, fixed. ${CANARY}\n` });
    const fixed = await sync();
    assert.deepEqual(fixed.writes, ['UpdateDocument']);
    assert.match(document.content ?? '', /fixed/);
  });

  it('L2-14: a renamed folder renames every document in it; ids stay', async () => {
    const files = Array.from({ length: 12 }, (_, index) => `eng/notes/topics/topic-${String(index).padStart(2, '0')}.md`);
    await commit(Object.fromEntries(files.map((path, index) => [path, `# Topic ${index}\n\nThe text of topic number ${index}, long enough to be found again. ${CANARY}\n`])));
    assert.equal((await sync()).result.exitCode, 0);
    const before = Object.fromEntries(await Promise.all(files.map(async (path) => [path, (await documentOf(path)).id] as const)));
    await commit({}, [['eng/notes/topics', 'eng/notes/subjects']]);
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(writes.length, files.length);
    assert.ok(writes.every((write) => write === 'UpdateDocument'));
    assert.equal(report.sync?.relocated.length, files.length);
    for (const path of files) assert.equal((await documentOf(path.replace('/topics/', '/subjects/'))).id, before[path]);
    await assertConverged();
  });

  it('a document edited in Linear since the capture is not overwritten; the record is an ordinary commit', async () => {
    const document = await documentOf('eng/notes/review.md');
    afterCapture(() => { document.content = `# Review\n\nTyped in Linear meanwhile. ${CANARY}`; touch(document); });
    const previous = await rev('refs/mdbisync/linear');
    await commit({
      'eng/notes/review.md': `# Review\n\nEdited in git. ${CANARY}\n`,
      'eng/backend/notes.md': `# Notes\n\nOther edit. ${CANARY}\n`,
    });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument']);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'edited-in-linear' }]);
    assert.equal(report.complete, false);
    assert.match(document.content ?? '', /Typed in Linear/);
    assert.equal(report.sync?.record?.kind, 'ordinary');
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@']), previous);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), PARTIAL_RECORD_MESSAGE);
    // The skipped document keeps what `linear` said before; the written one has its new text.
    assert.equal(await show('refs/mdbisync/linear:eng/notes/review.md'), TREE['eng/notes/review.md']);
    assert.match(await show('refs/mdbisync/linear:eng/backend/notes.md'), /Other edit/);
  });

  it('a rename in Linear after the capture, of a document that already holds the git text, reaches git', async () => {
    const document = await documentOf('eng/notes/review.md');
    const text = `# Review\n\nThe same words on both sides. ${CANARY}`;
    afterCapture(() => { Object.assign(document, { content: text, title: 'retro' }); touch(document); });
    await commit({ 'eng/notes/review.md': `${text}\n` });
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    // The record keeps the old title: the document is not named as recorded at its new time.
    assert.doesNotMatch(await fixture.remote.text(['log', '-1', '--format=%B', 'refs/mdbisync/ids']), new RegExp(`Document-recorded: ${document.id} ${document.updatedAt}`));
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.match(await show('refs/mdbisync/linear:eng/notes/retro.md'), /The same words on both sides/);
  });

  it('L2-15: a run that stops partway records what it wrote; the next run writes the rest and merges', async () => {
    const files = Array.from({ length: 6 }, (_, index) => `combined/part-${index}.md`);
    await commit(Object.fromEntries(files.map((path, index) => [path, `# Part ${index}\n\nPart ${index}. ${CANARY}\n`])));
    const previous = await rev('refs/mdbisync/linear');
    // The engine reads its test hooks from its own process environment.
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '4' };
    Object.assign(process.env, hooks);
    let first;
    try {
      first = await sync();
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(first.report.complete, false);
    assert.equal(first.report.sync?.created.length, 4);
    assert.equal(first.report.sync?.record?.kind, 'ordinary');
    assert.equal(Object.keys(await ids()).filter((path) => path.startsWith('combined/part-')).length, 4);

    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.deepEqual(second.writes, ['CreateDocument', 'CreateDocument']);
    assert.equal(second.report.complete, true);
    // The footnote file of the tree stays left out through the stop and the resume.
    assert.deepEqual(first.report.leftOutRules, ['footnote']);
    assert.equal(second.report.resumed, true);
    assert.deepEqual(second.report.leftOutRules, ['footnote']);
    const parents = (await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^@'])).split('\n');
    assert.equal(parents.length, 2);
    assert.equal(await fixture.remote.text(['rev-parse', 'refs/mdbisync/linear^^']), previous);
    await assertConverged();
    await assertIdempotent();
  });

  it('a document created by a run that died before recording its id is adopted by its title, not created twice', async () => {
    await commit({ 'combined/faq.md': `# FAQ\n\nAnswers. ${CANARY}\n` });
    afterCapture(() => world.linear.documents.push({ id: 'orphan', title: 'faq', projectId: 'project-handbook', createdAt: '2026-01-03T00:00:00.000Z', content: `# FAQ\n\nAnswers. ${CANARY}\n` }));
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.deepEqual(report.sync?.adopted, ['combined/faq.md']);
    assert.equal((await ids())['combined/faq.md']?.id, 'orphan');
    await assertConverged();
  });

  const uploadUrls = (text: string | null | undefined) => [...(text ?? '').matchAll(/https:\/\/uploads\.linear\.app\/[^)\s]+/g)].map((match) => match[0]);
  /** Upload requests, single or batched, whatever the operation is called. */
  const isUpload = (write: string) => /^FileUpload/.test(write);
  const kinds = (writes: string[]) => writes.map((write) => (isUpload(write) ? 'upload' : write));

  it('a document with an image whose text changed is written; the image is not uploaded again', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const [url] = uploadUrls(figure.content);
    assert.ok(url !== undefined, 'the initial sync did not upload the image');
    const uploadsBefore = world.linear.uploads.length;
    await commit({ 'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nWhat it shows, edited. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.skipped, []);
    assert.deepEqual(writes, ['UpdateDocument']);
    assert.equal(world.linear.uploads.length, uploadsBefore);
    assert.deepEqual(uploadUrls(figure.content), [url]);
    assert.match(figure.content ?? '', /edited/);
    // `linear` keeps the relative link: its tree is the tracked tree.
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    await assertIdempotent();
  });

  it('an image in angle brackets that Linear stores without them is recorded as the file spells it; no sync pull request, the next run writes nothing', async () => {
    // Like Linear: the stored text is in Linear's form, a link to an uploaded file stored as a file.
    world.linear.store = (content) => fixText(content.replaceAll(`${UPLOADS_HOST}/`, 'uploaded/')).replaceAll('uploaded/', `${UPLOADS_HOST}/`);
    await commit({
      'eng/media/chart copy.png': Buffer.from('chart copy bytes').toString('latin1'),
      'eng/notes/spaced.md': `# Spaced\n\n![Chart](<../media/chart copy.png>)\n\n${CANARY}\n`,
    });
    const { result } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    const [url] = uploadUrls((await documentOf('eng/notes/spaced.md')).content);
    assert.equal((await documentOf('eng/notes/spaced.md')).content, `# Spaced\n\n![Chart](${url})\n\n${CANARY}`, 'Linear dropped the brackets');
    // Linear's spelling of the same image is no change: the record keeps the file, brackets and all.
    assert.equal(await show('refs/mdbisync/linear:eng/notes/spaced.md'), `# Spaced\n\n![Chart](<../media/chart copy.png>)\n\n${CANARY}\n`);
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    // Nothing to carry to the tracked branch, and nothing to write again.
    assert.deepEqual((await sync()).writes, []);
    await assertIdempotent();
  });

  it("a document Linear reformats into other Markdown is recorded in Linear's form; its sync pull request merged, the next run writes nothing", async () => {
    // Like Linear: a reference link is stored inline.
    world.linear.store = (content) => fixText(content);
    const file = `# Refs\n\nSee [the site][s].\n\n[s]: https://example.com\n\n${CANARY}\n`;
    await commit({ 'eng/notes/refs.md': file });
    const { result } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/refs.md'), fixText(file));
    assert.notEqual(fixText(file), file);
    world.github.merge = async (pr, sha) => {
      const base = await rev(`refs/heads/${pr.base}`);
      const tree = (await fixture.remote.text(['merge-tree', '--write-tree', base, sha])).split('\n')[0] as string;
      const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-p', sha, '-m', `Merge pull request #${pr.number}`], {
        env: { GIT_AUTHOR_NAME: 'bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@example.com' },
      });
      await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
      return { sha: commit };
    };
    assert.deepEqual((await sync()).writes, ['POST /pulls']);
    assert.deepEqual((await sync()).writes, ['PUT /pulls/1/merge']);
    assert.equal(await show('refs/heads/main:eng/notes/refs.md'), fixText(file));
    // The run after the merge records it on `linear` and writes nothing to Linear; the next one changes nothing.
    assert.deepEqual((await sync()).writes, []);
    await assertIdempotent();
  });

  it('L2-09: a new image is uploaded once; a second document embedding it reuses the upload', async () => {
    const uploadsBefore = world.linear.uploads.length;
    await commit({
      'eng/media/chart.png': Buffer.from('chart bytes').toString('latin1'),
      'eng/notes/report.md': `# Report\n\n![Chart](../media/chart.png)\n\n${CANARY}\n`,
      'combined/summary.md': `# Summary\n\n![Chart](../eng/media/chart.png)\n\n${CANARY}\n`,
    });
    const { result, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(writes.filter(isUpload).length, 1, 'more than one upload request');
    assert.equal(world.linear.uploads.length, uploadsBefore + 1);
    const [report, summary] = await Promise.all([documentOf('eng/notes/report.md'), documentOf('combined/summary.md')]);
    assert.deepEqual(uploadUrls(report.content), uploadUrls(summary.content));
    assert.equal(uploadUrls(report.content).length, 1);
    const cache = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.ok(Object.values(cache).includes(uploadUrls(report.content)[0] as string));
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    await assertIdempotent();
  });

  it('L2-10: an image with new bytes at the same path is uploaded and its document gets the new URL', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const [before] = uploadUrls(figure.content);
    await commit({ 'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1') });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(kinds(writes), ['upload', 'UpdateDocument']);
    assert.deepEqual(report.sync?.updated, ['eng/notes/figure.md']);
    const [after] = uploadUrls(figure.content);
    assert.ok(after !== undefined && after !== before, 'the document kept the old image');
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    await assertIdempotent();
  });

  for (const failure of ['rejection', 'storage-http', 'storage-reset'] as const) {
    it(`L5-11: an image-only update with ${failure} keeps the old document, syncs other edits and retries`, async () => {
      const figure = await documentOf('eng/notes/figure.md');
      const before = figure.content;
      const recorded = await show('refs/mdbisync/linear:eng/media/diagram.png');
      const cacheBefore = await show('refs/mdbisync/uploads:uploads.json');
      await commit({
        'eng/media/diagram.png': 'replacement diagram bytes',
        'eng/notes/review.md': `# Review\n\nIndependent edit. ${CANARY}\n`,
      });
      if (failure === 'rejection') world.linear.writes.reject = (operation) => isUpload(operation);
      else {
        const base = fakeFetch(world);
        fetchOverride = async (input, init) => {
          if (init?.method === 'PUT' && String(input).startsWith(`${LINEAR_API}/storage/`)) {
            if (failure === 'storage-reset') throw new TypeError('connection reset');
            return new Response('', { status: 503 });
          }
          return base(input, init);
        };
      }
      const first = await sync();
      assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
      assert.equal(first.report.exitStatus, 'warning');
      assert.equal(first.writes.filter(isUpload).length, 1, 'only the write loop attempts the upload');
      assert.deepEqual(first.report.sync?.failed.map((entry) => entry.path), ['eng/notes/figure.md']);
      assert.deepEqual(first.report.sync?.updated, ['eng/notes/review.md']);
      assert.match(first.summary, /eng\/notes\/figure\.md/);
      assert.equal(figure.content, before, 'the complete previous document stays');
      assert.equal(await show('refs/mdbisync/linear:eng/media/diagram.png'), recorded);
      assert.equal(await show('refs/mdbisync/uploads:uploads.json'), cacheBefore, 'no failed upload URL cached');

      delete world.linear.writes.reject;
      fetchOverride = undefined;
      const second = await sync();
      assert.equal(second.result.exitCode, 0, second.result.stderr);
      assert.deepEqual(second.report.sync?.updated, ['eng/notes/figure.md']);
      assert.notEqual(figure.content, before);
      for (const url of uploadUrls(figure.content)) {
        assert.ok(world.linear.uploads.some((upload) => upload.assetUrl === url && upload.bytes?.equals(Buffer.from('replacement diagram bytes'))));
      }
      assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
      await assertIdempotent();
    });
  }

  it('L5-11: a failing shared image is attempted only in the write loop for each document', async () => {
    await commit({ 'eng/notes/shared.md': `# Shared\n\n![Diagram](../media/diagram.png)\n\n${CANARY}\n` });
    assert.equal((await sync()).result.exitCode, 0);
    const paths = ['eng/notes/figure.md', 'eng/notes/shared.md'];
    const before = await Promise.all(paths.map(async (path) => (await documentOf(path)).content));
    await commit({ 'eng/media/diagram.png': 'replacement shared diagram' });
    world.linear.writes.reject = (operation) => isUpload(operation);
    const failed = await sync();
    assert.equal(failed.result.exitCode, INCOMPLETE_EXIT_CODE, failed.result.stderr);
    assert.deepEqual(failed.report.sync?.failed.map((entry) => entry.path), paths);
    assert.equal(failed.writes.filter(isUpload).length, paths.length, 'no comparison uploads or automatic per-document retry');
    assert.deepEqual(await Promise.all(paths.map(async (path) => (await documentOf(path)).content)), before);
    delete world.linear.writes.reject;
    const recovered = await sync();
    assert.equal(recovered.result.exitCode, 0, recovered.result.stderr);
    assert.equal(recovered.writes.filter(isUpload).length, 1, 'the recovered shared image uploads once');
    assert.deepEqual(recovered.report.sync?.updated, paths);
    await assertIdempotent();
  });

  for (const create of [false, true]) {
    it(`L5-11: upload rejection leaves a ${create ? 'new' : 'changed'} document unwritten until the next run`, async () => {
      const path = create ? 'eng/notes/new-figure.md' : 'eng/notes/figure.md';
      const before = create ? undefined : (await documentOf(path)).content;
      const text = `# Figure\n\n![New](../media/new.png)\n\n${CANARY}\n`;
      await commit({ [path]: text, 'eng/media/new.png': 'new image bytes' });
      world.linear.writes.reject = (operation) => isUpload(operation);
      const first = await sync();
      assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
      assert.deepEqual(first.report.sync?.failed.map((entry) => entry.path), [path]);
      if (create) assert.equal((await ids())[path], undefined);
      else assert.equal((await documentOf(path)).content, before);
      delete world.linear.writes.reject;
      const second = await sync();
      assert.equal(second.result.exitCode, 0, second.result.stderr);
      assert.deepEqual(create ? second.report.sync?.created : second.report.sync?.updated, [path]);
      const url = uploadUrls((await documentOf(path)).content)[0];
      assert.ok(world.linear.uploads.some((upload) => upload.assetUrl === url && upload.bytes?.equals(Buffer.from('new image bytes'))));
      assert.equal(await show(`refs/mdbisync/linear:${path}`), text);
      await assertIdempotent();
    });
  }

  for (const imageOnly of [false, true]) {
    it(`L5-12: a missing LFS object leaves out its ${imageOnly ? 'unchanged' : 'new'} document while other edits sync`, async () => {
      const path = imageOnly ? 'eng/notes/figure.md' : 'eng/notes/new-figure.md';
      const before = imageOnly ? (await documentOf(path)).content : undefined;
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'ab'.repeat(32)}\nsize 42\n`;
      await commit({
        [imageOnly ? 'eng/media/diagram.png' : 'eng/media/missing.png']: pointer,
        ...(!imageOnly ? { [path]: `# New figure\n\n![Missing](../media/missing.png)\n\n${CANARY}\n` } : {}),
        'eng/notes/review.md': `# Review\n\nIndependent edit. ${CANARY}\n`,
      });
      const first = await sync();
      assert.equal(first.result.exitCode, 0, first.result.stderr);
      // An unreadable file can turn readable with no git change: the document waits, and the run stays partial.
      assert.equal(first.report.complete, false);
      assert.deepEqual(first.report.sync?.leftOutAtWrite, [{ path, rule: 'upload-unreadable', files: [imageOnly ? 'eng/media/diagram.png' : 'eng/media/missing.png'] }]);
      assert.deepEqual(first.report.sync?.updated, ['eng/notes/review.md']);
      assert.match(first.summary, /upload-unreadable/);
      if (imageOnly) assert.equal((await documentOf(path)).content, before);
      else assert.equal(live().some((document) => document.title === 'new-figure'), false);
      const again = await sync();
      assert.equal(again.result.exitCode, 0, again.result.stderr);
      assert.equal(again.report.complete, false);
      assert.deepEqual(again.report.sync?.leftOutAtWrite, first.report.sync?.leftOutAtWrite);
      assert.deepEqual(again.report.sync?.updated, []);
    });
  }

  it('a sync whose only remaining change is a new document over the upload limit completes, and the document joins once fixed', async () => {
    const path = 'eng/notes/scan.md';
    const text = `# Scan\n\n![Scan](../media/scan.png)\n\n${CANARY}\n`;
    const oversize = `version https://git-lfs.github.com/spec/v1\noid sha256:${'cd'.repeat(32)}\nsize ${11 * 1024 * 1024}\n`;
    await commit({ [path]: text, 'eng/media/scan.png': oversize });
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(first.report.complete, true, 'a file left out at write does not keep the run incomplete');
    assert.deepEqual(first.report.sync?.leftOutAtWrite, [{ path, rule: 'upload-too-large', files: ['eng/media/scan.png'] }]);
    assert.deepEqual(first.report.sync?.created, []);
    assert.equal(first.writes.filter(isUpload).length, 0, 'nothing over the limit is uploaded');
    assert.match(first.summary, /\| eng\/notes\/scan\.md \| upload-too-large \|/);
    assert.equal(live().some((document) => document.title === 'scan'), false);
    // The record merges the tracked branch, with the left-out file as git has it, and keeps the id the document gets.
    assert.equal(await rev('refs/mdbisync/linear^2'), await rev('refs/heads/main'));
    assert.equal(await show(`refs/mdbisync/linear:${path}`), text);
    assert.equal((await ids())[path], undefined);
    const reserved = (JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json')) as Record<string, string>)[path];
    assert.ok(reserved !== undefined, 'the left-out document keeps its id');
    // A resume has nothing left to do: it does not try the upload again.
    await assertIdempotent();

    // Fixed in git, the file joins under the id it kept.
    await commit({ 'eng/media/scan.png': 'scan bytes within the limit' });
    const fixed = await sync();
    assert.equal(fixed.result.exitCode, 0, fixed.result.stderr);
    assert.equal(fixed.report.complete, true);
    assert.deepEqual(fixed.report.sync?.created, [path]);
    assert.deepEqual(fixed.report.sync?.leftOutAtWrite, []);
    assert.equal((await documentOf(path)).id, reserved);
    await assertIdempotent();
  });

  it('a partial record keeps a new document over the upload limit as the tip has it', async () => {
    const path = 'eng/notes/scan.md';
    const text = `# Scan\n\n![Scan](../media/scan.png)\n\n${CANARY}\n`;
    const oversize = `version https://git-lfs.github.com/spec/v1\noid sha256:${'ef'.repeat(32)}\nsize ${11 * 1024 * 1024}\n`;
    await commit({ [path]: text, 'eng/media/scan.png': oversize, 'eng/notes/review.md': `# Review\n\nAnother edit. ${CANARY}\n` });
    world.linear.writes.reject = (operation) => operation === 'UpdateDocument';
    const first = await sync();
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.equal(first.report.complete, false);
    assert.deepEqual(first.report.sync?.failed.map((entry) => entry.path), ['eng/notes/review.md']);
    assert.deepEqual(first.report.sync?.leftOutAtWrite, [{ path, rule: 'upload-too-large', files: ['eng/media/scan.png'] }]);
    // The record does not take the tracked branch in, so it does not hold the left-out file either.
    await assert.rejects(show(`refs/mdbisync/linear:${path}`));
    delete world.linear.writes.reject;
    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(second.report.complete, true);
    assert.deepEqual(second.report.sync?.updated, ['eng/notes/review.md']);
    assert.deepEqual(second.report.sync?.leftOutAtWrite, first.report.sync?.leftOutAtWrite);
    assert.equal(await show(`refs/mdbisync/linear:${path}`), text);
    await assertIdempotent();
  });

  it('a renamed project folder needs no write, and the id map follows the files', async () => {
    const before = await documentOf('eng/notes/review.md');
    await commit({}, [['eng/notes', 'eng/fieldnotes']]);
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.writes, []);
    assert.equal((await ids())['eng/fieldnotes/review.md']?.id, before.id);
    assert.equal((await ids())['eng/notes/review.md'], undefined);
    // The next edit writes the same document; nothing is trashed or created.
    await commit({ 'eng/fieldnotes/review.md': `# Review\n\nLater edit. ${CANARY}\n` });
    const second = await sync();
    assert.deepEqual(second.writes, ['UpdateDocument']);
    assert.match(before.content ?? '', /Later edit/);
    await assertConverged();
  });

  /** Long enough that git still sees the rename after the footnote is added. */
  const LONG_REVIEW = `# Review\n\n${Array.from({ length: 12 }, (_, index) => `Finding number ${index} of the review, with its context.`).join('\n\n')}\n\n${CANARY}\n`;

  /**
   * Syncs a long review, then renames it to `eng/notes/review-notes.md` and adds a footnote, which leaves the new
   * file out: the rename waits. Returns the document, its record before the rename and the run that held it.
   */
  async function heldReview() {
    await commit({ 'eng/notes/review.md': LONG_REVIEW });
    assert.equal((await sync()).result.exitCode, 0);
    const document = await documentOf('eng/notes/review.md');
    const recorded = await show('refs/mdbisync/linear:eng/notes/review.md');
    await commit({ 'eng/notes/review.md': null, 'eng/notes/review-notes.md': LONG_REVIEW.replace('Finding number 0', 'Finding number 0.[^1]') + '\n[^1]: A note.\n' });
    return { document, recorded, held: await sync() };
  }

  it('a file renamed to one that is left out keeps its document where it is; the run is not complete', async () => {
    const { document, recorded, held: { result, report, writes } } = await heldReview();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.equal(document.trashed, undefined);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'renamed-to-unwritable' }]);
    assert.equal(report.complete, false);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/review.md'), recorded);
    assert.equal((await ids())['eng/notes/review.md']?.id, document.id);
  });

  it('a file moved so that its image no longer resolves is left out, and its document keeps the image it has', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const content = figure.content;
    const recorded = await show('refs/mdbisync/linear:eng/notes/figure.md');
    // From the new folder, `../media/diagram.png` names `eng/notes/media/diagram.png`, which the commit does not have.
    await commit({}, [['eng/notes/figure.md', 'eng/notes/old/figure.md']]);
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.ok(report.sync?.leftOut.some((entry) => entry.path === 'eng/notes/old/figure.md' && entry.rules.includes('image-file-missing')));
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/figure.md', reason: 'renamed-to-unwritable' }]);
    assert.equal(figure.content, content);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/figure.md'), recorded);
    assert.equal((await ids())['eng/notes/figure.md']?.id, figure.id);
  });

  it('a file renamed to one that is left out and then fixed is written at its new path, not taken for a conflict', async () => {
    const { document, held } = await heldReview();
    assert.deepEqual(held.report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'renamed-to-unwritable' }]);
    const fixed = LONG_REVIEW.replace('Finding number 0', 'Finding number 0, fixed');
    await commit({ 'eng/notes/review-notes.md': fixed });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.updated, ['eng/notes/review-notes.md']);
    assert.deepEqual(report.sync?.skipped, []);
    assert.equal(report.complete, true);
    assert.equal(document.trashed, undefined);
    assert.equal(document.title, 'review-notes');
    assert.ok((document.content ?? '').includes('Finding number 0, fixed'));
    assert.deepEqual(report.sync?.conflicts, []);
    assert.doesNotMatch(document.content ?? '', /Sync conflict/);
    assert.equal((await ids())['eng/notes/review-notes.md']?.id, document.id);
    assert.equal((await ids())['eng/notes/review.md'], undefined);
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
  });

  it('a Linear edit of a document whose rename waits still conflicts with the fix in git', async () => {
    const { document, held } = await heldReview();
    assert.deepEqual(held.report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'renamed-to-unwritable' }]);
    document.content = (document.content ?? '').replace('Finding number 0 of the review', 'Finding number 0, typed in Linear');
    touch(document);
    await commit({ 'eng/notes/review-notes.md': LONG_REVIEW.replace('Finding number 0 of the review', 'Finding number 0, fixed in git') });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(report.capture?.changed.includes('eng/notes/review.md'));
    assert.deepEqual(report.sync?.conflicts, ['eng/notes/review-notes.md']);
    assert.equal((await ids())['eng/notes/review-notes.md']?.id, document.id);
    for (const text of [document.content ?? '', await show('refs/mdbisync/linear:eng/notes/review-notes.md')]) {
      assert.match(text, /\*\*Sync conflict: git version\*\*\n\nFinding number 0, fixed in git[^\n]+\n\n\*\*Sync conflict: Linear version\*\*\n\nFinding number 0, typed in Linear[^\n]+\n\n\*\*Sync conflict: end\*\*/);
    }
  });

  it('files left out next to a waiting rename are written once fixed, not taken for conflicts', async () => {
    const plan = await documentOf('eng/notes/plan.md');
    const figure = await documentOf('eng/notes/figure.md');
    // The move leaves the figure out, so its rename waits and the record is partial; in the same commit an
    // existing file and a new one gain a footnote and are left out as well.
    await commit(
      {
        'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two.[^1] ${CANARY}\n\n[^1]: A note.\n`,
        'eng/notes/extra.md': `# Extra\n\nA claim.[^1] ${CANARY}\n\n[^1]: A source.\n`,
      },
      [['eng/notes/figure.md', 'eng/notes/old/figure.md']],
    );
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.report.sync?.skipped, [{ path: 'eng/notes/figure.md', reason: 'renamed-to-unwritable' }]);
    await commit({
      'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two, fixed. ${CANARY}\n`,
      'eng/notes/extra.md': `# Extra\n\nA claim, fixed. ${CANARY}\n`,
    });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.conflicts, []);
    assert.deepEqual(report.sync?.updated, ['eng/notes/plan.md']);
    assert.deepEqual(report.sync?.created, ['eng/notes/extra.md']);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/figure.md', reason: 'renamed-to-unwritable' }]);
    assert.match(plan.content ?? '', /Steps one and two, fixed\./);
    assert.doesNotMatch(plan.content ?? '', /Sync conflict/);
    assert.equal(figure.trashed, undefined);
  });

  it('a file moved so that its image no longer resolves and then fixed is written at its new path, not taken for a conflict', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    await commit({}, [['eng/notes/figure.md', 'eng/notes/old/figure.md']]);
    assert.deepEqual((await sync()).report.sync?.skipped, [{ path: 'eng/notes/figure.md', reason: 'renamed-to-unwritable' }]);
    await commit({ 'eng/notes/old/figure.md': `# Figure\n\n![Diagram](../../media/diagram.png)\n\nWhat it shows. ${CANARY}\n` });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.updated, ['eng/notes/old/figure.md']);
    assert.deepEqual(report.sync?.skipped, []);
    assert.equal(report.complete, true);
    assert.equal(figure.trashed, undefined);
    assert.deepEqual(report.sync?.conflicts, []);
    assert.equal(uploadUrls(figure.content).length, 1);
    assert.match(figure.content ?? '', /What it shows\./);
    assert.doesNotMatch(figure.content ?? '', /Sync conflict/);
    assert.equal((await ids())['eng/notes/old/figure.md']?.id, figure.id);
    assert.equal((await ids())['eng/notes/figure.md'], undefined);
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
  });

  it('with the upload cache lost, an edited document with an image is written, not taken for a Linear edit', async () => {
    const previousUrl = uploadUrls((await documentOf('eng/notes/figure.md')).content)[0]!;
    const uploadsBefore = world.linear.uploads.length;
    const empty = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: '{}\n' });
    const tree = await fixture.remote.text(['mktree'], { input: `100644 blob ${empty}\tuploads.json\n` });
    const lost = await fixture.remote.text(['commit-tree', tree, '-p', 'refs/mdbisync/uploads', '-m', 'Cache lost'], {
      env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.com' },
    });
    await fixture.remote.run(['update-ref', 'refs/mdbisync/uploads', lost]);
    await commit({ 'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nWhat it shows, edited. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.skipped, []);
    // The capture does not read the figure again: the record holds it as Linear does. Its image is not in the
    // cache, so it is uploaded once more, and the cache records the new upload.
    assert.deepEqual(kinds(writes), ['upload', 'UpdateDocument']);
    assert.equal(world.linear.uploads.length, uploadsBefore + 1);
    const [url] = uploadUrls((await documentOf('eng/notes/figure.md')).content);
    assert.ok(url !== undefined && url !== previousUrl, 'the figure does not link the new upload');
    assert.ok((await show('refs/mdbisync/uploads:uploads.json')).includes(url));
    assert.ok((await show('refs/mdbisync/linear:eng/notes/figure.md')).includes('../media/diagram.png'));
  });

  it('a write Linear rejects is listed, and the run exits to be run again', async () => {
    world.linear.writes.reject = (operation) => operation === 'UpdateDocument';
    await commit({ 'eng/notes/review.md': `# Review\n\nEdited. ${CANARY}\n` });
    const { result, report } = await sync();
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(report.code, 'write-failed');
    assert.deepEqual(report.sync?.failed.map((entry) => entry.path), ['eng/notes/review.md']);
    // Nothing was written, so `linear` stays where it was.
    assert.equal(report.sync?.record, null);
  });

  it('a caption edited in git after a partial run that changed its image reaches Linear', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const review = await documentOf('eng/notes/review.md');
    // The figure takes the new image; the review, edited in Linear meanwhile, is skipped: the record is partial and
    // keeps the old bytes.
    afterCapture(() => { review.content = `# Review\n\nTyped in Linear meanwhile. ${CANARY}`; touch(review); });
    await commit({
      'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1'),
      'eng/notes/review.md': `# Review\n\nEdited too. ${CANARY}\n`,
    });
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.report.sync?.updated, ['eng/notes/figure.md']);
    assert.deepEqual(first.report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'edited-in-linear' }]);
    await commit({ 'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nA new caption. ${CANARY}\n` });
    for (let run = 0; run < 3 && !/A new caption/.test(figure.content ?? ''); run += 1) assert.equal((await sync()).result.exitCode, 0);
    assert.match(figure.content ?? '', /A new caption/);
  });

  it('an image update Linear rejects is tried again by the next run', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const [before] = uploadUrls(figure.content);
    world.linear.writes.reject = (operation) => operation === 'UpdateDocument';
    await commit({
      'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1'),
      'eng/notes/review.md': `# Review\n\nEdited too. ${CANARY}\n`,
    });
    const first = await sync();
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.deepEqual(uploadUrls(figure.content), [before]);
    delete world.linear.writes.reject;
    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.notDeepEqual(uploadUrls(figure.content), [before]);
    assert.equal(second.report.complete, true);
    await assertIdempotent();
  });

  it('a document moved to another project in Linear since the capture is not moved or trashed by git', async () => {
    const document = await documentOf('eng/notes/review.md');
    afterCapture(() => { document.projectId = 'project-archive'; touch(document); });
    await commit({ 'eng/notes/review.md': null });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.equal(document.trashed, undefined);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'edited-in-linear' }]);
  });

  it('an image whose name is percent-encoded in its link is found when its bytes change', async () => {
    await commit({
      'eng/media/part#1.png': Buffer.from('part bytes').toString('latin1'),
      'eng/notes/part.md': `# Part\n\n![Part](../media/part%231.png)\n\n${CANARY}\n`,
    });
    assert.equal((await sync()).result.exitCode, 0);
    const part = await documentOf('eng/notes/part.md');
    const [before] = uploadUrls(part.content);
    assert.ok(before !== undefined, 'the image was not uploaded');
    await commit({ 'eng/media/part#1.png': Buffer.from('new part bytes').toString('latin1') });
    const { result, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(kinds(writes), ['upload', 'UpdateDocument']);
    assert.notDeepEqual(uploadUrls(part.content), [before]);
  });

  it('a written text with conflict markers gets the conflict mark; removing them restores the icon', async () => {
    const document = await documentOf('eng/notes/review.md');
    document.icon = 'Fire';
    document.color = '#123456';
    const conflicted = `# Review\n\n**Sync conflict: git version**\n\nOne way.\n\n**Sync conflict: Linear version**\n\nThe other way.\n\n**Sync conflict: end**\n\n${CANARY}\n`;
    await commit({ 'eng/notes/review.md': conflicted });
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(document.icon, 'Alert');
    assert.equal(world.linear.comments.size, 1);
    assert.ok(![...world.linear.comments.values()].some((comment) => comment.body.includes(CANARY)), 'a comment holds content');
    const saved = (await ids())['eng/notes/review.md'] as { id: string; saved?: { icon: string | null; color: string | null } };
    assert.deepEqual({ icon: saved.saved?.icon, color: saved.saved?.color }, { icon: 'Fire', color: '#123456' });

    await commit({ 'eng/notes/review.md': `# Review\n\nOne way. ${CANARY}\n` });
    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(document.icon, 'Fire');
    assert.equal(document.color, '#123456');
    assert.equal(((await ids())['eng/notes/review.md'] as { saved?: unknown }).saved, undefined);
    await assertIdempotent();
  });

  it('a left-out file fixed in git does not overwrite an edit made in Linear after capture', async () => {
    const document = await documentOf('eng/notes/review.md');
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings.[^1] ${CANARY}\n\n[^1]: A note.\n` });
    assert.deepEqual((await sync()).writes, []);
    afterCapture(() => { document.content = `# Review\n\nTyped in Linear meanwhile. ${CANARY}\n`; touch(document); });
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings, fixed in git. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'edited-in-linear' }]);
    assert.match(document.content ?? '', /Typed in Linear meanwhile/);
  });

  it('an edit of an excluded file made before capture is recorded and conflicts with a different git fix', async () => {
    const document = await documentOf('eng/notes/review.md');
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings.[^1] ${CANARY}\n\n[^1]: A note.\n` });
    assert.deepEqual((await sync()).writes, []);
    document.content = `# Review\n\nTyped in Linear meanwhile. ${CANARY}\n`;
    touch(document);
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings, fixed in git. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    // Both versions are written between the conflict markers, and the document gets the conflict mark and its notice.
    assert.deepEqual(writes, ['UpdateDocument', 'UpdateDocument', 'CommentOnDocument']);
    assert.deepEqual(report.sync?.skipped, []);
    assert.deepEqual(report.sync?.conflicts, ['eng/notes/review.md']);
    assert.ok(report.capture?.changed.includes('eng/notes/review.md'));
    for (const text of [document.content ?? '', await show('refs/mdbisync/linear:eng/notes/review.md')]) {
      assert.match(text, /\*\*Sync conflict: git version\*\*\n\nFindings, fixed in git\. [^\n]+\n\n\*\*Sync conflict: Linear version\*\*\n\nTyped in Linear meanwhile\. [^\n]+\n\n\*\*Sync conflict: end\*\*/);
    }
  });

  it('a left-out file is compared with what Linear was given, not with a git version it never received', async () => {
    const document = await documentOf('eng/notes/review.md');
    // Two git commits between runs: a clean version Linear never receives, then one the linter leaves out.
    await commit({ 'eng/notes/review.md': `# Review\n\nA version Linear never sees. ${CANARY}\n` });
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings.[^1] ${CANARY}\n\n[^1]: A note.\n` });
    assert.deepEqual((await sync()).writes, []);
    await commit({ 'eng/notes/review.md': `# Review\n\nFindings, fixed in git. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.skipped, []);
    assert.deepEqual(writes, ['UpdateDocument']);
    assert.match(document.content ?? '', /fixed in git/);
  });

  it('a link to another synchronized document is written as its Linear URL; `linear` keeps the relative link', async () => {
    const plan = await documentOf('eng/notes/plan.md');
    await commit({ 'eng/notes/review.md': `# Review\n\nSee [the plan](plan.md). ${CANARY}\n` });
    const { result, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, ['UpdateDocument']);
    const review = await documentOf('eng/notes/review.md');
    assert.ok((review.content ?? '').includes(plan.id) || (review.content ?? '').includes('linear.app'), 'the link was not written as a Linear URL');
    assert.ok(!(review.content ?? '').includes('](plan.md)'), 'the relative link reached Linear');
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    await assertIdempotent();
  });

  /** Leaves a file out with one commit, syncs, fixes it with another, syncs; the fix must reach the untouched document. */
  async function leftOutThenFixed(breaking: Record<string, string | null>, fixing: Record<string, string | null>, path: string) {
    const document = await documentOf(path);
    await commit(breaking);
    assert.equal((await sync()).result.exitCode, 0);
    await commit(fixing);
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.skipped, [], 'an untouched document was taken for a Linear edit');
    assert.equal(report.complete, true);
    return document;
  }

  it('a file left out for a title collision and then fixed reaches its untouched document', async () => {
    const document = await leftOutThenFixed(
      { 'eng/notes/review.md': `# Review\n\nAn edit made while colliding. ${CANARY}\n`, 'eng/notes/Review.md': `# Other\n\nSame title. ${CANARY}\n` },
      { 'eng/notes/Review.md': null, 'eng/notes/review.md': `# Review\n\nAfter the collision. ${CANARY}\n` },
      'eng/notes/review.md',
    );
    assert.match(document.content ?? '', /After the collision/);
  });

  it('a commit that skipped the hook with an image that is no file of the repository leaves its documents out until the image is committed', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const content = figure.content;
    const text = `# New figure\n\n![Missing](../media/missing.png)\n\n${CANARY}\n`;
    // The image of an existing document is removed, and a new document names one never committed.
    await commit({ 'eng/media/diagram.png': null, 'eng/notes/new-figure.md': text });
    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.deepEqual(first.writes, []);
    assert.deepEqual(first.report.sync?.leftOut, [
      { path: 'eng/notes/draft.md', rules: ['footnote'] },
      { path: 'eng/notes/figure.md', rules: ['image-file-missing'] },
      { path: 'eng/notes/new-figure.md', rules: ['image-file-missing'] },
    ]);
    assert.deepEqual(first.report.leftOutRules, ['footnote', 'image-file-missing']);
    assert.equal(figure.content, content);
    assert.equal(live().some((document) => document.title === 'new-figure'), false);
    assert.ok(!world.linear.documents.some((document) => (document.content ?? '').includes('missing.png')), 'an unresolved image path reached Linear');

    // Both images committed: the new document is created with its upload, the other keeps its document.
    await commit({ 'eng/media/diagram.png': Buffer.from('first diagram bytes').toString('latin1'), 'eng/media/missing.png': 'missing image bytes' });
    const second = await sync();
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.deepEqual(second.report.sync?.created, ['eng/notes/new-figure.md']);
    assert.deepEqual(second.report.sync?.leftOut, [{ path: 'eng/notes/draft.md', rules: ['footnote'] }]);
    assert.equal(uploadUrls((await documentOf('eng/notes/new-figure.md')).content).length, 1);
    assert.equal((await ids())['eng/notes/figure.md']?.id, figure.id);
    await assertIdempotent();
  });

  it('a document whose image is removed after an image-only update and then restored is not taken for a Linear edit', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    await commit({ 'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1') });
    assert.deepEqual(kinds((await sync()).writes), ['upload', 'UpdateDocument']);
    const content = figure.content;
    await commit({ 'eng/media/diagram.png': null });
    assert.deepEqual((await sync()).writes, []);
    // Restored with other bytes: the document gets the new image.
    await commit({ 'eng/media/diagram.png': Buffer.from('third diagram bytes').toString('latin1') });
    const { result, report } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.sync?.skipped, []);
    assert.deepEqual(report.sync?.updated, ['eng/notes/figure.md']);
    assert.equal(report.complete, true);
    assert.notEqual(figure.content, content);
    assert.ok(!report.sync?.leftOut.some((entry) => entry.path === 'eng/notes/figure.md'));
    await assertIdempotent();
  });

  it('a file left out for a missing image in the commit that moves its folder to another project is moved and written once fixed', async () => {
    const document = await leftOutThenFixed(
      {
        'eng/notes/README.md': `---\nlinear-project: Archive\n---\n\n# Field notes\n\n${CANARY}\n`,
        'eng/notes/review.md': `# Review\n\n![Chart](chart.png)\n\nFindings. ${CANARY}\n`,
      },
      { 'eng/notes/chart.png': 'chart bytes', 'eng/notes/review.md': `# Review\n\n![Chart](chart.png)\n\nFindings, fixed. ${CANARY}\n` },
      'eng/notes/review.md',
    );
    assert.equal(document.projectId, 'project-archive');
    assert.match(document.content ?? '', /fixed/);
  });

  it('a file left out in the commit that moves its folder to another project is moved and written once fixed', async () => {
    const document = await leftOutThenFixed(
      {
        'eng/notes/README.md': `---\nlinear-project: Archive\n---\n\n# Field notes\n\n${CANARY}\n`,
        'eng/notes/review.md': `# Review\n\nFindings.[^1] ${CANARY}\n\n[^1]: A note.\n`,
      },
      { 'eng/notes/review.md': `# Review\n\nFindings, fixed. ${CANARY}\n` },
      'eng/notes/review.md',
    );
    assert.equal(document.projectId, 'project-archive');
    assert.match(document.content ?? '', /fixed/);
  });

  it('a file left out in the commit that changes its image is written with the new image once fixed', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const [before] = uploadUrls(figure.content);
    await leftOutThenFixed(
      {
        'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1'),
        'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nWhat it shows.[^1] ${CANARY}\n\n[^1]: A note.\n`,
      },
      { 'eng/notes/figure.md': `# Figure\n\n![Diagram](../media/diagram.png)\n\nWhat it shows, fixed. ${CANARY}\n` },
      'eng/notes/figure.md',
    );
    const [after] = uploadUrls(figure.content);
    assert.ok(after !== undefined && after !== before, 'the document kept the old image');
  });

  it('a file that stopped being text and became text again reaches its untouched document', async () => {
    const document = await leftOutThenFixed(
      { 'eng/notes/review.md': `# Review\n\nBroken\u0000bytes. ${CANARY}\n` },
      { 'eng/notes/review.md': `# Review\n\nText again. ${CANARY}\n` },
      'eng/notes/review.md',
    );
    assert.match(document.content ?? '', /Text again/);
  });

  it('a move that makes a relative link point at another image writes the other image', async () => {
    await commit({ 'eng/notes/media/diagram.png': Buffer.from('a different diagram').toString('latin1') });
    assert.equal((await sync()).result.exitCode, 0);
    const figure = await documentOf('eng/notes/figure.md');
    const [before] = uploadUrls(figure.content);
    // From eng/notes/sub/, `../media/diagram.png` is eng/notes/media/diagram.png.
    await commit({}, [['eng/notes/figure.md', 'eng/notes/sub/figure.md']]);
    const { result, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(kinds(writes), ['upload', 'UpdateDocument']);
    const [after] = uploadUrls(figure.content);
    assert.ok(after !== undefined && after !== before, 'the moved document kept the old image');
    assert.equal(figure.title, 'sub/figure');
  });

  it('a file renamed in the same commit that changes its image is written with the new image', async () => {
    const figure = await documentOf('eng/notes/figure.md');
    const [before] = uploadUrls(figure.content);
    await commit({ 'eng/media/diagram.png': Buffer.from('second diagram bytes').toString('latin1') }, [['eng/notes/figure.md', 'eng/notes/illustration.md']]);
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(kinds(writes), ['upload', 'UpdateDocument']);
    assert.equal(figure.title, 'illustration');
    const [after] = uploadUrls(figure.content);
    assert.ok(after !== undefined && after !== before, 'the renamed document kept the old image');
    assert.equal(report.complete, true);
    assert.equal(await rev('refs/mdbisync/linear^{tree}'), await rev('refs/heads/main^{tree}'));
    await assertIdempotent();
  });

  /** What a capture does for an edit in Linear: the document's new text, committed onto `linear`. */
  async function captured(path: string, text: string) {
    const document = await documentOf(path);
    document.content = body(path, text);
    touch(document);
    await person.run(['fetch', '--quiet', 'origin', '+refs/mdbisync/linear:refs/captured']);
    await person.run(['checkout', '--quiet', '--detach', 'refs/captured']);
    await writeFile(join(personDir, path), text);
    await person.run(['commit', '--quiet', '-am', 'Captured']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:refs/mdbisync/linear']);
    await person.run(['checkout', '--quiet', 'main']);
  }

  it('edits of different paragraphs on both sides merge, and the merged text is written', async () => {
    await captured('eng/backend/notes.md', `# Notes\n\nFirst paragraph.\n\nSecond paragraph, edited in Linear. ${CANARY}\n`);
    const previous = await rev('refs/mdbisync/linear');
    await commit({ 'eng/backend/notes.md': `# Notes\n\nFirst paragraph, edited in git.\n\nSecond paragraph. ${CANARY}\n` });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    // The Linear edit goes to the tracked branch through the sync pull request; the git edit goes to Linear.
    assert.deepEqual(writes, ['POST /pulls', 'UpdateDocument']);
    assert.equal((await documentOf('eng/backend/notes.md')).content, `# Notes\n\nFirst paragraph, edited in git.\n\nSecond paragraph, edited in Linear. ${CANARY}\n`);
    assert.equal(report.complete, true);
    await assertMergeRecord(previous);
  });

  it('edits of the same paragraph on both sides are written with conflict markers; the record is a merge commit', async () => {
    const linearText = `# Notes\n\nFirst paragraph, Linear's way.\n\nSecond paragraph. ${CANARY}\n`;
    await captured('eng/backend/notes.md', linearText);
    await commit({
      'eng/backend/notes.md': `# Notes\n\nFirst paragraph, git's way.\n\nSecond paragraph. ${CANARY}\n`,
      'eng/notes/review.md': `# Review\n\nAnother edit. ${CANARY}\n`,
    });
    const { result, report, writes } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    // The marked text, the conflict mark and its notice, then the other document.
    assert.deepEqual(writes, ['UpdateDocument', 'UpdateDocument', 'CommentOnDocument', 'UpdateDocument']);
    assert.deepEqual(report.sync?.skipped, []);
    assert.deepEqual(report.sync?.conflicts, ['eng/backend/notes.md']);
    const marked = `# Notes\n\n**Sync conflict: git version**\n\nFirst paragraph, git's way.\n\n**Sync conflict: Linear version**\n\nFirst paragraph, Linear's way.\n\n**Sync conflict: end**\n\nSecond paragraph. ${CANARY}\n`;
    assert.equal((await documentOf('eng/backend/notes.md')).content, marked);
    assert.equal(report.sync?.record?.kind, 'merge');
    assert.equal(await show('refs/mdbisync/linear:eng/backend/notes.md'), marked);
    assert.match(await show('refs/mdbisync/linear:eng/notes/review.md'), /Another edit/);
  });

  it('a document trashed in Linear since the capture is not written; the run says so', async () => {
    const document = await documentOf('eng/notes/review.md');
    afterCapture(() => { document.trashed = true; touch(document); });
    await commit({ 'eng/notes/review.md': `# Review\n\nEdited in git. ${CANARY}\n` });
    const { result, report, writes, summary } = await sync();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(writes, []);
    assert.deepEqual(report.sync?.skipped, [{ path: 'eng/notes/review.md', reason: 'missing-in-linear' }]);
    assert.match(summary, /eng\/notes\/review\.md/);
    assert.doesNotMatch(summary, /nothing to write/);
    assert.equal(report.complete, false);
  });

  it('a state ref that moves under the run makes it record nothing and exit to be run again', async () => {
    await commit({ 'eng/backend/notes.md': `# Notes\n\nEdited. ${CANARY}\n` });
    world.linear.writes.reject = () => {
      // Another run records first, between this run's write and its record.
      execFileSync('git', ['update-ref', 'refs/mdbisync/ids', 'refs/mdbisync/linear'], { cwd: fixture.remote.dir });
      return false;
    };
    const linearBefore = await rev('refs/mdbisync/linear');
    const { result, report } = await sync();
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(report.code, 'state-moved');
    assert.equal(report.complete, false);
    assert.equal(await rev('refs/mdbisync/linear'), linearBefore, 'linear moved although the push was refused');
  });
});
