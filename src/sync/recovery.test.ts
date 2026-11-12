// Recovery from lost state, through the command line against a local git
// remote and a fake GitHub and Linear: each of the sync's state refs
// deleted, a ref moved by someone else during a run, the sync branch
// deleted by a person, and a document removed from Linear for good. Each
// ends in a defined result, nothing half-written, and the next runs
// converge with no duplicate document.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { Git, UPLOADS_REBUILDING, UPLOADS_REBUILT } from '../state/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, IDENTITY, createFixture, remoteRef } from '../state/test-helpers.ts';
import { MERGE_RECORD_MESSAGE } from './write.ts';

const CANARY = 'kx-0e5b7a31';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;
const DIAGRAM = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));

const TREE: Record<string, string | Buffer> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\nFirst paragraph. ${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `---\nowner: example\n---\n\n# Plan\n\nSteps one and two. ${CANARY}\n`,
  'eng/notes/review.md': `# Review\n\nFindings. See the [plan](plan.md). ${CANARY}\n`,
  'eng/notes/diagram.md': `# Diagram\n\n![Diagram](../media/diagram.png)\n\n${CANARY}\n`,
  'eng/notes/chart.md': `# Chart\n\n![Chart](../media/diagram.png)\n\n${CANARY}\n`,
  'eng/media/diagram.png': DIAGRAM,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/guide.md': `# Guide\n\nHow to start. ${CANARY}\n`,
  'combined/topics/setup.md': `# Setup\n\nInstall it. ${CANARY}\n`,
};

const SYNC_BRANCH = 'refs/heads/mdbisync/linear';
const STATE = (store: 'linear' | 'ids' | 'uploads') => `refs/mdbisync/${store}`;

describe('sync: lost state and deleted branches', () => {
  let fixture: Fixture;
  let cwd: string;
  let person: Git;
  let personDir: string;
  let world: FakeWorld;
  /** Stands in front of the fake worlds when a test sets it. */
  let fetchOverride: typeof fetch | undefined;
  /** State refs the test moves itself while a run works, which the run's report does not count. */
  let movedByOthers: Array<'linear' | 'ids' | 'uploads' | 'syncBranch'> = [];
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  /** Seeds the remote, one commit per tree, and runs initial sync and the runs that settle it. */
  async function start(seeds: ReadonlyArray<Record<string, string | Buffer>>) {
    fixture = await createFixture();
    for (const seed of seeds) await fixture.seed(seed);
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
    movedByOthers = [];
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    // Settle: Linear's form of the initial text reaches the tracked branch and the state converges.
    await settle();
  }

  beforeEach(() => start([TREE]));
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
    MDBISYNC_REPORT_FILE: reportFile(),
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const writesBefore = world.writes.length;
    const uploadsBefore = world.linear.uploads.length;
    const mark = await markWorld(world, fixture);
    const result = await runCli([command], { env: env(extra), cwd, fetch: fetchOverride ?? fakeFetch(world) });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    const texts = [result.stdout, result.stderr, summary, JSON.stringify(report), ...world.github.pullRequests.map((pr) => `${pr.title}\n${pr.body}`)];
    for (const text of texts) assert.ok(!text.includes(CANARY), 'content reached the output or a pull request (I5)');
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: fetchOverride !== undefined, movedByOthers });
    return { result, report, summary, writes: world.writes.slice(writesBefore), uploads: world.linear.uploads.length - uploadsBefore };
  }

  const sync = () => cli('sync');

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

  /** Passes every check on every commit, so the sync merges its pull request on the run after it opens or moves it. */
  function passAllChecks() {
    world.github.checks = new Proxy(new Map(), { get: (target, key) => (key === 'get' ? () => [{ name: 'ci', status: 'completed', conclusion: 'success' }] : Reflect.get(target, key)) });
  }

  /** Runs the sync until a run changes nothing, at most five runs. */
  async function settle() {
    passAllChecks();
    for (let index = 0; index < 5; index += 1) {
      const run = await sync();
      assert.equal(run.result.exitCode, 0, run.result.stderr);
      if (!run.report.changed) return run;
    }
    assert.fail('the sync did not settle in five runs');
  }

  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  const ids = async () => JSON.parse(await show(`${STATE('ids')}:ids.json`)) as Record<string, { id: string }>;
  const live = () => world.linear.documents.filter((document) => document.trashed !== true && document.archivedAt === undefined);

  async function commit(changes: Record<string, string | Buffer | null>) {
    await person.run(['pull', '--quiet', '--ff-only']);
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

  /** I1, I7, I8: every mapped document holds its file's body; one live document per title in a place, each mapped. */
  async function assertConverged() {
    const map = await ids();
    const tracked = await rev('refs/heads/main');
    for (const [path, entry] of Object.entries(map)) {
      const document = world.linear.documents.find((d) => d.id === entry.id);
      assert.ok(document !== undefined && document.trashed !== true, `${path}: no live document`);
      const text = await show(`${tracked}:${path}`);
      const body = text.slice(text.indexOf('# '));
      // Links and images are in Linear's form; compare the text around them.
      const plain = (value: string) => value.replace(/\]\([^)]*\)/g, '](…)').replace(/\]\(<[^>]*>\)/g, '](…)');
      assert.equal(plain(document.content ?? ''), plain(body), `${path}: content`);
    }
    const keys = live().map((d) => `${d.projectId ?? d.teamId}/${d.title}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate documents');
    assert.equal(live().length, Object.keys(map).length, 'a live document without an id');
  }

  /** One more run writes nothing and moves no ref. */
  async function assertQuiet() {
    const refs = async () => Promise.all([SYNC_BRANCH, 'refs/heads/main', STATE('linear'), STATE('ids'), STATE('uploads')].map((ref) => remoteRef(fixture, ref)));
    const before = await refs();
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(again.writes, []);
    assert.equal(again.uploads, 0);
    assert.deepEqual(await refs(), before);
  }

  it('L5-13: a lost ids ref is rebuilt by matching titles to paths, with no duplicate and no write', async () => {
    const before = await ids();
    const documents = world.linear.documents.length;
    const tracked = await rev('refs/heads/main');
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.exitStatus, 'success');
    assert.deepEqual(run.writes, [], 'nothing is written to Linear or GitHub');
    assert.deepEqual(await ids(), before, 'every path has its old id again');
    assert.equal(world.linear.documents.length, documents, 'no document is created');
    assert.equal(await rev('refs/heads/main'), tracked);
    assert.match(run.summary, /rebuilt/i);
    assert.deepEqual(run.report.capture?.rebuiltIds, { matched: Object.keys(before).length, files: Object.keys(before).length });
    await assertConverged();
    await assertQuiet();

    // The rebuilt map works: a git edit reaches its document, a Linear edit reaches the tracked branch.
    await commit({ 'combined/guide.md': `# Guide\n\nHow to start, edited. ${CANARY}\n` });
    const notes = world.linear.documents.find((document) => document.id === before['eng/backend/notes.md']?.id)!;
    notes.content = `# Notes\n\nFirst paragraph, edited in Linear. ${CANARY}\n`;
    touch(notes);
    await settle();
    assert.match(world.linear.documents.find((document) => document.id === before['combined/guide.md']?.id)?.content ?? '', /edited\./);
    assert.match(await show('refs/heads/main:eng/backend/notes.md'), /edited in Linear/);
    await assertConverged();
  });

  /** Every path of the tracked branch and the sync branch. */
  async function paths(): Promise<string[]> {
    const list = async (ref: string) => (await remoteRef(fixture, ref)) === null ? [] : (await fixture.remote.text(['ls-tree', '-r', '--name-only', ref])).split('\n');
    return [...new Set([...(await list('refs/heads/main')), ...(await list(SYNC_BRANCH))])].filter(Boolean).sort();
  }

  /**
   * Loses the ids ref and runs: every left-out file gets its document back, and no second file or document appears.
   * `unmatched` files of the count never had a document.
   */
  async function assertLeftOutKeepDocuments(left: string[], unmatched = 0) {
    await settle();
    const before = await ids();
    for (const path of left) assert.ok(before[path] !== undefined, `${path} keeps its id while left out`);
    const documents = world.linear.documents.length;
    const files = await paths();
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.report.capture?.rebuiltIds, { matched: Object.keys(before).length, files: Object.keys(before).length + unmatched });
    assert.deepEqual(await ids(), before, 'every path has its old id again');
    await settle();
    assert.deepEqual(await ids(), before);
    assert.deepEqual(await paths(), files, 'no second file');
    assert.equal(world.linear.documents.length, documents, 'no document is created');
    return before;
  }

  it('L5-13: files left out for a missing image keep their documents when the ids ref is rebuilt, as the run keeps them', async () => {
    await commit({ 'eng/media/diagram.png': null });
    const left = await sync();
    assert.equal(left.result.exitCode, 0, left.result.stderr);
    assert.deepEqual(left.writes, []);
    assert.deepEqual(left.report.sync?.leftOut, [
      { path: 'eng/notes/chart.md', rules: ['image-file-missing'] },
      { path: 'eng/notes/diagram.md', rules: ['image-file-missing'] },
    ]);
    const before = await assertLeftOutKeepDocuments(['eng/notes/chart.md', 'eng/notes/diagram.md']);

    // Fixed, the file updates its original document.
    await commit({ 'eng/media/diagram.png': DIAGRAM, 'eng/notes/diagram.md': `# Diagram\n\n![Diagram](../media/diagram.png)\n\nEdited in git. ${CANARY}\n` });
    const documents = world.linear.documents.length;
    await settle();
    assert.match(world.linear.documents.find((document) => document.id === before['eng/notes/diagram.md']?.id)?.content ?? '', /Edited in git\./);
    assert.equal(world.linear.documents.length, documents);
    assert.deepEqual(await ids(), before);
    await assertConverged();
  });

  it('L5-13: a file left out for a footnote keeps its document when the ids ref is rebuilt; fixed, it updates that document', async () => {
    await commit({ 'eng/backend/notes.md': `# Notes\n\nFirst paragraph.[^1] ${CANARY}\n\n[^1]: A remark.\n` });
    const left = await sync();
    assert.equal(left.result.exitCode, 0, left.result.stderr);
    assert.deepEqual(left.report.sync?.leftOut, [{ path: 'eng/backend/notes.md', rules: ['footnote'] }]);
    const before = await assertLeftOutKeepDocuments(['eng/backend/notes.md']);

    await commit({ 'eng/backend/notes.md': `# Notes\n\nFirst paragraph, edited in git. ${CANARY}\n` });
    const documents = world.linear.documents.length;
    await settle();
    assert.match(world.linear.documents.find((document) => document.id === before['eng/backend/notes.md']?.id)?.content ?? '', /edited in git/);
    assert.equal(world.linear.documents.length, documents);
    assert.deepEqual(await ids(), before);
    await assertConverged();
  });

  it('L5-13: a file left out for a duplicate title keeps its document when the ids ref is rebuilt; the new file gets none', async () => {
    await commit({ 'combined/Guide.md': `# Guide\n\nAnother guide. ${CANARY}\n` });
    const left = await sync();
    assert.equal(left.result.exitCode, 0, left.result.stderr);
    assert.deepEqual(left.report.sync?.leftOut, [
      { path: 'combined/Guide.md', rules: ['duplicate-title'] },
      { path: 'combined/guide.md', rules: ['duplicate-title'] },
    ]);
    const before = await assertLeftOutKeepDocuments(['combined/guide.md'], 1);
    assert.equal(before['combined/Guide.md'], undefined);

    await commit({ 'combined/Guide.md': null, 'combined/guide.md': `# Guide\n\nHow to start, edited in git. ${CANARY}\n` });
    const documents = world.linear.documents.length;
    await settle();
    assert.match(world.linear.documents.find((document) => document.id === before['combined/guide.md']?.id)?.content ?? '', /edited in git/);
    assert.equal(world.linear.documents.length, documents);
    assert.deepEqual(await ids(), before);
    await assertConverged();
  });

  it('L5-13: a left-out file added where a removed file was gets no id from the rebuild; the trashed document stays the old file\'s', async () => {
    const old = (await ids())['eng/backend/notes.md']!.id;
    await commit({ 'eng/backend/notes.md': null });
    await settle();
    assert.equal(world.linear.documents.find((document) => document.id === old)?.trashed, true);
    await commit({ 'eng/backend/notes.md': `# Notes\n\nA new page.[^1] ${CANARY}\n\n[^1]: A remark.\n` });
    await settle();
    const before = await ids();
    assert.equal(before['eng/backend/notes.md'], undefined);
    const files = await paths();
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(await ids(), before);
    await settle();
    assert.deepEqual(await paths(), files, 'the new file stays');
    assert.match(await show('refs/heads/main:eng/backend/notes.md'), /A new page/);
  });

  it('L5-13: a file left out since the initial sync gets no id from the rebuild, though it was synchronizable before it and a document has its title', async () => {
    await fixture.cleanup();
    // Before the initial sync the file had no footnote: the tracked history before the record does not count.
    await start([{ ...TREE, 'combined/aside.md': `# Aside\n\nA remark. ${CANARY}\n` }, { 'combined/aside.md': `# Aside\n\nA remark.[^1] ${CANARY}\n\n[^1]: The note.\n` }]);
    assert.equal((await ids())['combined/aside.md'], undefined);
    // A document of that title written in Linear, never the file's: capture takes it as a file of its own.
    world.linear.documents.push({ id: 'doc-aside', title: 'aside', projectId: 'project-handbook', createdAt: '2026-01-03T00:00:00.000Z', content: `# Aside\n\nWritten in Linear. ${CANARY}\n` });
    await settle();
    const before = await ids();
    assert.equal(before['combined/aside.md'], undefined);
    const path = Object.keys(before).find((key) => before[key]?.id === 'doc-aside');
    assert.ok(path !== undefined, 'the document is captured as a file');
    const files = await paths();
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(await ids(), before, 'the left-out file stays unmapped; the document keeps its own file');
    await settle();
    assert.deepEqual(await paths(), files);
    assert.equal(world.linear.documents.find((document) => document.id === 'doc-aside')?.content, `# Aside\n\nWritten in Linear. ${CANARY}\n`, 'the document is untouched');
  });

  it('L5-13: a document renamed in Linear while the ids ref was lost comes back as a new file with its id; the old file keeps a document of its own', async () => {
    const before = await ids();
    const documents = world.linear.documents.length;
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);
    const guide = world.linear.documents.find((document) => document.id === before['combined/guide.md']?.id)!;
    guide.title = 'Getting started';
    touch(guide);

    await settle();
    const after = await ids();
    assert.equal(after['combined/Getting started.md']?.id, guide.id, 'the renamed document keeps its id under its new path');
    // The rename is what the lost map held: the old file stays and gets a document again, one per title.
    assert.notEqual(after['combined/guide.md']?.id, guide.id);
    assert.equal(Object.values(after).filter((entry) => entry.id === guide.id).length, 1);
    assert.equal(world.linear.documents.length, documents + 1);
    assert.match(await show('refs/heads/main:combined/Getting started.md'), /How to start/);
    await assertConverged();
    await assertQuiet();
  });

  it('L5-13: a folder README whose document was renamed in Linear while the ids ref was lost keeps a document of its own', async () => {
    const before = await ids();
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);
    const readme = world.linear.documents.find((document) => document.id === before['combined/README.md']?.id)!;
    readme.title = 'Handbook home';
    touch(readme);

    await settle();
    const after = await ids();
    assert.equal(after['combined/Handbook home.md']?.id, readme.id, 'the renamed document keeps its id under its new path');
    // The README holds a body and an annotation: as any other file the lost map held, it gets a document again.
    assert.ok(after['combined/README.md'] !== undefined && after['combined/README.md'].id !== readme.id, 'the README has no document of its own');
    await assertConverged();
    await assertQuiet();
  });

  it('L5-14: a lost uploads ref: the images are uploaded again and the tracked branch does not change', async () => {
    const tracked = await rev('refs/heads/main');
    const linear = await rev(STATE('linear'));
    await fixture.remote.run(['update-ref', '-d', STATE('uploads')]);

    // The rebuild's pushes of the uploads ref and the image stored again are counted.
    const rebuilt = await sync();
    assert.equal(rebuilt.report.writes.git.uploads, 2);
    assert.equal(rebuilt.report.writes.linear['FileUpload'], 1);
    const run = await settle();
    assert.ok(world.linear.uploads.filter((upload) => upload.bytes?.equals(DIAGRAM)).length >= 2, 'the image is uploaded again');
    assert.notEqual(await remoteRef(fixture, STATE('uploads')), null, 'the cache is recorded again');
    assert.equal(await rev('refs/heads/main'), tracked, 'the tracked branch does not change');
    assert.equal(await show(`${STATE('linear')}:eng/notes/diagram.md`), await show(`${linear}:eng/notes/diagram.md`));
    assert.equal(run.report.exitStatus, 'success');
    const diagram = live().find((document) => document.title === 'diagram');
    assert.ok(diagram !== undefined);
    await assertConverged();
    await assertQuiet();
  });

  it('L5-14: a re-upload that stops partway goes on in the next run until every linking document has a fresh upload', async () => {
    const tracked = await rev('refs/heads/main');
    await fixture.remote.run(['update-ref', '-d', STATE('uploads')]);
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '1' };
    Object.assign(process.env, hooks);
    let first;
    try {
      first = await sync();
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(first.report.stoppedEarly, true);
    assert.equal(first.report.sync?.updated.length, 1);
    const fresh = () => world.linear.uploads.filter((upload) => upload.bytes?.equals(DIAGRAM)).map((upload) => upload.assetUrl);
    const subject = () => fixture.remote.text(['log', '-1', '--format=%s', '--fixed-strings', `--grep=${UPLOADS_REBUILDING}`, `--grep=${UPLOADS_REBUILT}`, STATE('uploads')]);
    assert.equal(await subject(), UPLOADS_REBUILDING, 'the stopped run leaves the rebuild to the next');

    await settle();
    assert.equal(await subject(), UPLOADS_REBUILT);
    // The image is in the cache again under its one fresh upload, and every document that links it holds that URL.
    const cache = JSON.parse(await show(`${STATE('uploads')}:uploads.json`)) as Record<string, string>;
    const latest = fresh().at(-1)!;
    assert.equal(cache[createHash('sha256').update(DIAGRAM).digest('hex')], latest);
    assert.equal(fresh().length, 2, 'uploaded once more, then taken from the cache');
    for (const title of ['diagram', 'chart']) assert.ok(live().find((d) => d.title === title)?.content?.includes(latest), `${title} links the fresh upload`);
    assert.equal(await rev('refs/heads/main'), tracked, 'the tracked branch does not change');
    // A git edit of a linking document reaches Linear afterwards: it is not taken for an edit made in Linear.
    await commit({ 'eng/notes/chart.md': `# Chart\n\n![Chart](../media/diagram.png)\n\nEdited in git. ${CANARY}\n` });
    await settle();
    assert.match(live().find((d) => d.title === 'chart')?.content ?? '', /Edited in git/);
    await assertQuiet();
  });

  it('L5-13: a file capture named from an encoded title gets its document back, with no second file', async () => {
    world.linear.documents.push({ id: 'doc-why', title: 'Why now?', projectId: 'project-handbook', createdAt: '2026-01-03T00:00:00.000Z', content: `# Why\n\nBecause. ${CANARY}\n` });
    await settle();
    const before = await ids();
    const path = Object.keys(before).find((key) => before[key]?.id === 'doc-why');
    assert.ok(path !== undefined && path !== 'combined/Why now?.md', `captured under an encoded name: ${path}`);
    const tracked = await rev('refs/heads/main');
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(await ids(), before);
    assert.deepEqual(run.writes, []);
    await settle();
    assert.equal(await rev('refs/heads/main'), tracked, 'no second file');
    await assertConverged();
  });

  it('L5-14: a re-upload whose search for the documents to relink is stopped by a rate limit stays pending', async () => {
    await fixture.remote.run(['update-ref', '-d', STATE('uploads')]);
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '1' };
    Object.assign(process.env, hooks);
    try {
      assert.equal((await sync()).report.stoppedEarly, true);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    const subject = () => fixture.remote.text(['log', '-1', '--format=%s', '--fixed-strings', `--grep=${UPLOADS_REBUILDING}`, `--grep=${UPLOADS_REBUILT}`, STATE('uploads')]);
    assert.equal(await subject(), UPLOADS_REBUILDING);

    // The next run's read of every linking document is answered with a rate limit.
    const linking = live().filter((d) => d.title === 'diagram' || d.title === 'chart').map((d) => d.id).sort();
    const base = fakeFetch(world);
    let limited = 0;
    fetchOverride = async (input, init) => {
      const body = String(input).endsWith('/graphql') ? (JSON.parse(String(init?.body)) as { operationName?: string; variables?: { ids?: string[]; withContent?: boolean } }) : undefined;
      if (body?.operationName === 'GetDocuments' && body.variables?.withContent === true && JSON.stringify([...(body.variables.ids ?? [])].sort()) === JSON.stringify(linking)) {
        limited += 1;
        return new Response(JSON.stringify({ errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return base(input, init);
    };
    const stopped = await sync();
    fetchOverride = undefined;
    assert.equal(limited, 1, 'the read of the documents to relink was limited');
    assert.equal(stopped.report.stoppedEarly, true);
    assert.equal(await subject(), UPLOADS_REBUILDING, 'the rebuild stays pending');

    await settle();
    assert.equal(await subject(), UPLOADS_REBUILT);
    const latest = world.linear.uploads.filter((upload) => upload.bytes?.equals(DIAGRAM)).at(-1)!.assetUrl;
    for (const title of ['diagram', 'chart']) assert.ok(live().find((d) => d.title === title)?.content?.includes(latest), `${title} links the fresh upload`);
    await assertQuiet();
  });

  it('L5-18: a rule that refuses the sync branch does not stop the record; the branch is left out', async () => {
    await fixture.remote.run(['update-ref', '-d', SYNC_BRANCH], { okCodes: [0, 1] });
    const hook = join(fixture.root, 'remote.git', 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = "refs/heads/mdbisync/linear" ] && { echo "branch refused by rule" >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 });
    await commit({ 'combined/guide.md': `# Guide\n\nHow to start, edited. ${CANARY}\n` });

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.complete, true);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', STATE('linear')]), MERGE_RECORD_MESSAGE);
    assert.equal(await remoteRef(fixture, SYNC_BRANCH), null);
    assert.match(live().find((d) => d.title === 'guide')?.content ?? '', /edited\./);
    // Later runs try the branch again and go on without it.
    await settle();
    assert.equal(await remoteRef(fixture, SYNC_BRANCH), null);
    await assertQuiet();
  });

  it('L5-13: a document trashed in Linear while the ids ref was lost is removed, not created again', async () => {
    const before = await ids();
    const documents = world.linear.documents.length;
    await fixture.remote.run(['update-ref', '-d', STATE('ids')]);
    const guide = world.linear.documents.find((document) => document.id === before['combined/guide.md']?.id)!;
    guide.trashed = true;
    guide.archivedAt = new Date().toISOString();
    touch(guide);

    await settle();
    assert.equal((await ids())['combined/guide.md'], undefined);
    assert.equal((await fixture.remote.run(['cat-file', '-e', 'refs/heads/main:combined/guide.md'], { okCodes: [0, 128] })).code, 128, 'the file is removed');
    assert.equal(world.linear.documents.length, documents, 'nothing is created');
    await assertConverged();
    await assertQuiet();
  });

  it('L5-15: a lost linear ref: the sync refuses and asks for initial sync, which restores it', async () => {
    const documents = structuredClone(world.linear.documents);
    await fixture.remote.run(['update-ref', '-d', STATE('linear')]);

    const refused = await sync();
    assert.equal(refused.result.exitCode, NO_STATE_EXIT_CODE);
    assert.equal(refused.report.code, 'initial-sync-required');
    assert.deepEqual(refused.writes, []);
    assert.deepEqual(world.linear.documents, documents, 'Linear is untouched');
    assert.match(refused.summary, /run initial sync first/);

    const restored = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(restored.result.exitCode, 0, restored.result.stderr);
    assert.notEqual(await remoteRef(fixture, STATE('linear')), null);
    await settle();
    await assertConverged();
    await assertQuiet();
  });

  it('L5-16: a ref moved by someone else during a run refuses the atomic push; nothing is half-updated and the next run converges', async () => {
    await commit({ 'combined/guide.md': `# Guide\n\nHow to start, edited. ${CANARY}\n` });
    const hooks = join(fixture.root, 'hooks');
    const pause = join(hooks, 'pause', 'after-write-before-record');
    await mkdir(dirname(pause), { recursive: true });
    await writeFile(pause, '');
    const linearBefore = await rev(STATE('linear'));
    const uploadsBefore = await rev(STATE('uploads'));
    // Someone else moves `ids` when the run has written to Linear and is about to record.
    const hooked = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: hooks };
    Object.assign(process.env, hooked);
    let run;
    let moved = '';
    movedByOthers = ['ids'];
    try {
      const running = sync();
      while (!existsSync(join(hooks, 'reached', 'after-write-before-record'))) await sleep(20);
      const tip = await rev(STATE('ids'));
      moved = await fixture.remote.text(['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'Unrelated update'], {
        env: { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com' },
      });
      await fixture.remote.run(['update-ref', STATE('ids'), moved, tip]);
      await rm(pause);
      run = await running;
    } finally {
      for (const name of Object.keys(hooked)) delete process.env[name];
      movedByOthers = [];
    }
    assert.match(run.report.sync?.updated.join() ?? '', /combined\/guide\.md/, 'the run wrote before it tried to record');
    assert.equal(run.report.atomicPushRefused, true);
    // The refused push moved nothing, so the run reports no ref moved; the document it wrote first is counted.
    assert.deepEqual(run.report.writes.git, {});
    assert.equal(run.report.writes.linear['UpdateDocument'], 1);
    assert.equal(run.report.partialRefUpdates, 0);
    assert.equal(run.report.code, 'state-moved');
    assert.equal(run.report.exitStatus, 'warning');
    // Nothing is half-updated: every ref is where the run found it, or where the other writer left it.
    assert.equal(await rev(STATE('ids')), moved);
    assert.equal(await rev(STATE('linear')), linearBefore);
    assert.equal(await rev(STATE('uploads')), uploadsBefore);

    await settle();
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', STATE('linear')]), MERGE_RECORD_MESSAGE);
    await assertConverged();
    await assertQuiet();
  });

  it('L5-18: a sync branch deleted by a person is recreated from linear by the next run', async () => {
    // A Linear edit goes to the tracked branch through a sync pull request, which makes the branch.
    const notes = world.linear.documents.find((document) => document.title === 'backend/notes')!;
    notes.content = `# Notes\n\nFirst paragraph, edited in Linear. ${CANARY}\n`;
    touch(notes);
    await settle();
    assert.notEqual(await remoteRef(fixture, SYNC_BRANCH), null);
    await fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    const branch = await remoteRef(fixture, SYNC_BRANCH);
    const linear = await rev(STATE('linear'));
    assert.ok(branch !== null, 'the branch is back');
    const fromLinear = branch === linear || (await fixture.remote.run(['merge-base', '--is-ancestor', linear, branch], { okCodes: [0, 1] })).code === 0;
    assert.ok(fromLinear, 'the branch holds linear');
    await assertQuiet();
  });

  it('L5-18: a sync branch deleted while its pull request waits: the next run recreates it and opens a new pull request; nothing lost', async () => {
    world.github.checks = new Map();
    const notes = world.linear.documents.find((document) => document.title === 'backend/notes')!;
    notes.content = `# Notes\n\nFirst paragraph, edited in Linear. ${CANARY}\n`;
    touch(notes);
    const opened = await sync();
    assert.equal(opened.report.pullRequest?.pullRequest?.opened, true);
    // A person deletes the branch; GitHub closes its pull request.
    await fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);
    for (const pr of world.github.pullRequests) pr.state = 'closed';

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.pullRequest?.pullRequest?.opened, true, 'a new pull request');
    assert.equal(await rev(SYNC_BRANCH), await rev(STATE('linear')));
    await settle();
    assert.match(await show('refs/heads/main:eng/backend/notes.md'), /edited in Linear/);
    await assertConverged();
  });

  it('L5-19: a document removed from Linear for good is treated as deleted', async () => {
    const before = await ids();
    const gone = before['eng/notes/review.md']!.id;
    // In the trash first, and the trash captured; then removed from the trash for good.
    const document = world.linear.documents.find((d) => d.id === gone)!;
    world.linear.documents.splice(world.linear.documents.indexOf(document), 1);

    await settle();
    const after = await ids();
    assert.ok(!Object.values(after).some((entry) => entry.id === gone), 'the id is no longer mapped');
    assert.equal(await remoteRef(fixture, 'refs/heads/main').then(async (tip) => (await fixture.remote.run(['cat-file', '-e', `${tip}:eng/notes/review.md`], { okCodes: [0, 128] })).code), 128, 'the file is removed from the tracked branch');
    assert.equal(world.linear.documents.length, Object.keys(before).length - 1, 'nothing is created in its place');
    await assertConverged();
    await assertQuiet();
  });

  it('L5-19: a trashed document later removed for good stays deleted', async () => {
    const before = await ids();
    const gone = before['combined/topics/setup.md']!.id;
    const document = world.linear.documents.find((d) => d.id === gone)!;
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    await settle();
    assert.ok(!Object.values(await ids()).some((entry) => entry.id === gone));
    world.linear.documents.splice(world.linear.documents.indexOf(document), 1);

    await settle();
    assert.equal((await fixture.remote.run(['cat-file', '-e', 'refs/heads/main:combined/topics/setup.md'], { okCodes: [0, 128] })).code, 128);
    await assertConverged();
    await assertQuiet();
  });

  /** Whether the tracked branch has the file. */
  const tracks = async (path: string) => (await fixture.remote.run(['cat-file', '-e', `refs/heads/main:${path}`], { okCodes: [0, 128] })).code === 0;

  it('MDS-009-21: a run whose every document read comes back blank removes no file, ends partial, and the next run finds them all', async () => {
    const before = await ids();
    const paths = Object.keys(before).sort();
    const documents = world.linear.documents.length;
    world.linear.blankAnswer = () => true;

    const blank = await sync();
    assert.equal(blank.result.exitCode, INCOMPLETE_EXIT_CODE, blank.result.stderr);
    assert.equal(blank.report.exitStatus, 'warning');
    assert.equal(blank.report.code, 'removal-held');
    assert.match(blank.result.stderr, /partial, will continue \(removal-held\)/);
    assert.deepEqual(blank.report.capture?.removed, []);
    assert.deepEqual([...blank.report.capture!.heldRemovals].sort(), paths);
    assert.match(blank.result.stdout, /Removal held for \d+ files/);
    assert.deepEqual(await ids(), before, 'every id stays mapped');
    for (const path of paths) assert.ok(await tracks(path), `${path} stays on the tracked branch`);
    assert.deepEqual(blank.writes, [], 'nothing is written to Linear on a blank answer');
    // The held removal is recorded on the ids ref: the one write of this run, which its report counts.
    assert.deepEqual(blank.report.writes, { linear: {}, git: { ids: 1 }, pullRequests: {} });

    // A blank answer that lasts into the next run does not confirm the held removals: no place lists anything.
    const still = await sync();
    assert.equal(still.result.exitCode, INCOMPLETE_EXIT_CODE, still.result.stderr);
    assert.deepEqual(still.report.capture?.removed, []);
    assert.deepEqual([...still.report.capture!.heldRemovals].sort(), paths);
    assert.deepEqual(await ids(), before, 'every id stays mapped');

    delete world.linear.blankAnswer;
    await settle();
    assert.deepEqual(await ids(), before);
    for (const path of paths) assert.ok(await tracks(path), `${path} stays on the tracked branch`);
    assert.equal(world.linear.documents.length, documents, 'nothing is created');
    await assertConverged();
    await assertQuiet();
  });

  it('MDS-009-21: a place whose every document is removed for good loses its files on the next run, which confirms it', async () => {
    const before = await ids();
    const handbook = new Set(world.linear.documents.filter((d) => d.projectId === 'project-handbook').map((d) => d.id));
    const paths = Object.entries(before).filter(([, entry]) => handbook.has(entry.id)).map(([path]) => path).sort();
    assert.ok(paths.length >= 2, 'the project holds several files');
    world.linear.documents = world.linear.documents.filter((d) => !handbook.has(d.id));

    // Its place now lists nothing, as a blank answer would: the first run holds the removal.
    const first = await sync();
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.deepEqual([...first.report.capture!.heldRemovals].sort(), paths);
    assert.deepEqual(first.report.capture?.removed, []);
    for (const path of paths) assert.ok(await tracks(path), `${path} stays while the removal is held`);

    // The next run finds them gone again and removes them.
    const second = await sync();
    assert.deepEqual(second.report.capture?.heldRemovals, []);
    assert.deepEqual([...second.report.capture!.removed].sort(), paths);
    await settle();
    for (const path of paths) {
      // The folder's README keeps its annotation; its body goes with the document.
      if (path.endsWith('README.md')) assert.doesNotMatch(await show(`refs/heads/main:${path}`), /# Handbook/, `${path} loses its body`);
      else assert.equal(await tracks(path), false, `${path} is removed from the tracked branch`);
    }
    const after = await ids();
    assert.ok(!Object.values(after).some((entry) => handbook.has(entry.id)), 'no removed id stays mapped');
    await assertConverged();
    await assertQuiet();
  });

  it('MDS-009-21: a blank answer that clears before the next run leaves no held removal behind', async () => {
    const before = await ids();
    const notes = new Set(world.linear.documents.filter((d) => d.projectId === 'project-api').map((d) => d.id));
    world.linear.blankAnswer = (d) => notes.has(d.id);
    const blank = await sync();
    assert.equal(blank.result.exitCode, INCOMPLETE_EXIT_CODE, blank.result.stderr);
    assert.ok(blank.report.capture!.heldRemovals.length > 0);
    delete world.linear.blankAnswer;

    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.deepEqual(next.report.capture?.heldRemovals, []);
    assert.deepEqual(next.report.capture?.removed, []);
    // A later blank answer is held again, not taken as a confirmation of the first.
    world.linear.blankAnswer = (d) => notes.has(d.id);
    const again = await sync();
    assert.equal(again.result.exitCode, INCOMPLETE_EXIT_CODE, again.result.stderr);
    assert.deepEqual(again.report.capture?.removed, []);
    assert.deepEqual(again.report.capture?.heldRemovals, blank.report.capture?.heldRemovals);
    delete world.linear.blankAnswer;
    await settle();
    assert.deepEqual(await ids(), before);
    await assertConverged();
    await assertQuiet();
  });
});
