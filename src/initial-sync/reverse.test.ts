// The initial sync from Linear to the tracked branch through the command
// line, against a local git remote and a fake GitHub and Linear: the dry run,
// the pull request left for a person, the refusal of the sync until it is
// merged, resume and recovery.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { COMMANDS, INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { LinearClient } from '../linear/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { resolveTargets } from '../setup/linear.ts';
import { fetchState, resolveStateConfig } from '../state/index.ts';
import { type SecurityGate } from '../sync/security.ts';
import { FINAL_IDS_MESSAGE, PROGRESS_MESSAGE } from './confirm.ts';
import { type ReversePlanInput, PULL_REQUEST_TITLE, REVERSE_RECORD_MESSAGE, confirmLinearToGit, planLinearToGit } from './reverse.ts';

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
const UNSAFE = 'eng/notes/Q3%3A plans%3F.md';
const CREATE = [UNSAFE, 'eng/notes/faq.md', 'eng/ops/runbook.md'];
const REMOVE = ['eng/backend/notes.md'];
const IDS = {
  'combined/README.md': 'doc-handbook',
  'eng/README.md': 'doc-eng-readme',
  [UNSAFE]: 'doc-unsafe',
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
    // L1R-05: a title a path cannot hold gets a file by the naming rule, not left out.
    assert.deepEqual(report.summary?.leftOut, ['combined/Guide.md', 'combined/guide.md', 'eng/notes/formula.md']);
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

  it('L1R-04: downloads the files documents embed next to them, stored as .gitattributes decides, linked relatively and cached', async () => {
    await fixture.seed({ '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n' });
    const world = fakeWorld();
    const shot = Buffer.from('png bytes of a screenshot');
    const spec = Buffer.from('%PDF-1.4 a specification');
    // The same bytes as a file the tracked branch already holds (committed before the LFS pattern).
    const diagram = Buffer.from(TREE['eng/notes/diagram.png'] as string);
    const upload = (name: string, contentType: string, bytes: Buffer) => {
      const assetUrl = `${UPLOADS_HOST}/${world.linear.uploads.length}/${name}`;
      world.linear.uploads.push({ filename: name, contentType, size: bytes.length, assetUrl, bytes });
      return assetUrl;
    };
    const shotUrl = upload('shot.png', 'image/png', shot);
    const specUrl = upload('spec.pdf', 'application/pdf', spec);
    const diagramUrl = upload('diagram.png', 'image/png', diagram);
    const contents: Record<string, string> = {
      'doc-runbook': `# Runbook\n\n![Shot](${shotUrl})\n\nRead [the spec](${specUrl}#page=2).\n`,
      'doc-plan': `# Plan\n\n![Diagram](${diagramUrl})\n`,
    };
    world.linear.documents = linearDocuments().map((d) => (contents[d.id] === undefined ? d : { ...d, content: contents[d.id] as string }));
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.linearToGit?.leftOutAtRecord, []);
    const head = 'refs/mdbisync/linear';
    // Next to the document, named by content hash, linked relatively; a file the branch holds is linked, not copied.
    assert.equal(await show(`${head}:eng/ops/runbook.md`), `# Runbook\n\n![Shot](${sha(shot)}.png)\n\nRead [the spec](${sha(spec)}.pdf#page=2).`);
    assert.equal(await show(`${head}:eng/notes/plan.md`), `---\nowner: platform\n---\n\n# Plan\n\n![Diagram](diagram.png)`);
    const tree = await files(head);
    assert.deepEqual(tree.filter((path) => /\.(png|pdf)$/.test(path)), [`eng/notes/diagram.png`, `eng/ops/${sha(shot)}.png`, `eng/ops/${sha(spec)}.pdf`].sort());
    // `.gitattributes` routes PNG files to LFS: a pointer in git, the object in the remote's LFS store. The PDF is a plain file.
    const pointer = await show(`${head}:eng/ops/${sha(shot)}.png`);
    assert.equal(pointer, `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(shot)}\nsize ${shot.length}`);
    const remoteDir = await fixture.remote.text(['rev-parse', '--absolute-git-dir']);
    assert.deepEqual(await readFile(join(remoteDir, 'lfs', 'objects', sha(shot).slice(0, 2), sha(shot).slice(2, 4), sha(shot))), shot);
    assert.deepEqual((await fixture.remote.run(['show', `${head}:eng/ops/${sha(spec)}.pdf`])).stdout, spec);
    // The upload cache maps each file's hash to its Linear URL.
    const uploads = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.equal(uploads[sha(shot)], shotUrl);
    assert.equal(uploads[sha(spec)], specUrl);
    assert.equal(uploads[sha(diagram)], diagramUrl);

    // Merged, the sync finds every file already in Linear: nothing is uploaded again, no document changes.
    await merge(world);
    const writes = world.writes.length;
    const after = await run(world, {}, 'sync');
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.equal(after.report.writtenCount, 0);
    assert.deepEqual(world.writes.slice(writes).filter((write) => !write.startsWith('GET ') && !write.includes('/pulls')), []);
    assert.equal(world.linear.uploads.length, 3, 'a file was uploaded again');
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-runbook')?.content, contents['doc-runbook']);
  });

  it('maps links to synchronized documents back to relative links, keeping the tracked spelling', async () => {
    // The tracked plan already links the README in its own spelling; Linear holds the document URL.
    await fixture.seed({ 'eng/notes/plan.md': `---\nowner: platform\n---\n\n# Plan\n\nSee [the notes](./README.md#top). ${CANARY}` });
    const world = fakeWorld();
    const url = (id: string) => `https://linear.app/${world.linear.urlKey}/document/${id}`;
    const contents: Record<string, string> = {
      'doc-plan': `# Plan\n\nSee [the notes](${url('doc-notes-readme')}#top). ${CANARY}`,
      'doc-faq': `# FAQ\n\nRead [the plan](${url('doc-plan')}#steps) and [the runbook](${url('doc-runbook')}). Elsewhere: [a stranger](${url('doc-unknown')}).\n`,
    };
    world.linear.documents = linearDocuments().map((d) => (contents[d.id] === undefined ? d : { ...d, content: contents[d.id] as string }));
    const { result } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/plan.md'), `---\nowner: platform\n---\n\n# Plan\n\nSee [the notes](./README.md#top). ${CANARY}`);
    assert.equal(
      await show('refs/mdbisync/linear:eng/notes/faq.md'),
      `# FAQ\n\nRead [the plan](<plan.md#steps>) and [the runbook](<../ops/runbook.md>). Elsewhere: [a stranger](${url('doc-unknown')}).`,
    );
  });

  it('keeps a link to a new document left out as its Linear URL, and stores a file whose bytes equal a removed page', async () => {
    const world = fakeWorld();
    const url = (id: string) => `https://linear.app/${world.linear.urlKey}/document/${id}`;
    // The bytes of the git-only page the pull request removes: the attachment must not point at it.
    const bytes = Buffer.from(TREE['eng/backend/notes.md'] as string);
    const attachment = `${UPLOADS_HOST}/0/notes.txt`;
    world.linear.uploads.push({ filename: 'notes.txt', contentType: 'text/plain', size: bytes.length, assetUrl: attachment, bytes });
    const contents: Record<string, string> = {
      // Reads as front matter: left out, so it has no file to link to.
      'doc-faq': `---\nlinear-team: DOCS\n---\nLooks like metadata. ${CANARY}`,
      'doc-runbook': `# Runbook\n\nSee [the FAQ](${url('doc-faq')}) and [the notes](${attachment}).\n`,
    };
    world.linear.documents = linearDocuments().map((d) => (contents[d.id] === undefined ? d : { ...d, content: contents[d.id] as string }));
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.linearToGit?.leftOutAtRecord, [{ path: 'eng/notes/faq.md', rule: 'front-matter-boundary' }]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await show('refs/mdbisync/linear:eng/ops/runbook.md'), `# Runbook\n\nSee [the FAQ](${url('doc-faq')}) and [the notes](${hash}.txt).`);
    assert.deepEqual((await fixture.remote.run(['show', `refs/mdbisync/linear:eng/ops/${hash}.txt`])).stdout, bytes);
    assert.ok(!(await files('refs/mdbisync/linear')).includes('eng/backend/notes.md'));
  });

  it('a file that cannot be downloaded keeps the tracked file, which stays its document', async () => {
    const world = fakeWorld();
    const gone = `![Gone](${UPLOADS_HOST}/9/gone.png)\n`;
    world.linear.documents = linearDocuments().map((d) => (d.id === 'doc-plan' || d.id === 'doc-faq' ? { ...d, content: `# Page\n\n${gone}` } : d));
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    // A new file is left out with its id; an existing one keeps the tracked text and its id.
    assert.deepEqual(report.linearToGit?.leftOutAtRecord.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'eng/notes/faq.md', rule: 'download-failed' },
      { path: 'eng/notes/plan.md', rule: 'download-failed' },
    ]);
    assert.equal((await readIds())['eng/notes/faq.md'], undefined);
    assert.ok(!(await files('refs/mdbisync/linear')).includes('eng/notes/faq.md'));
    assert.equal(await show('refs/mdbisync/linear:eng/notes/plan.md'), (TREE['eng/notes/plan.md'] as string).replace(/\n$/, ''));
    assert.equal((await readIds())['eng/notes/plan.md'], 'doc-plan');
  });

  it('L1R-05: titles a path cannot hold become files by one rule, and stay unchanged in Linear', async () => {
    const world = fakeWorld();
    const project = { projectId: 'project-api' };
    const unsafe = [
      doc('doc-colon', 'Q4: goals', project, `# Goals\n\n${CANARY}`),
      doc('doc-star', 'a*b?', project, `# Star\n\n${CANARY}`),
      doc('doc-lead', '  indented', project, `# Indented\n\n${CANARY}`),
      doc('doc-trail', 'trailing. ', project, `# Trailing\n\n${CANARY}`),
      doc('doc-slash', 'guides/setup: v2', project, `# Setup\n\n${CANARY}`),
      doc('doc-root', '/rooted', project, `# Rooted\n\n${CANARY}`),
    ];
    world.linear.documents = [...linearDocuments(), ...unsafe];
    const titles = structuredClone(world.linear.documents.map((d) => [d.id, d.title]));
    const expected: Record<string, string> = {
      'doc-colon': 'eng/notes/Q4%3A goals.md',
      'doc-star': 'eng/notes/a%2Ab%3F.md',
      'doc-lead': 'eng/notes/  indented.md',
      'doc-trail': 'eng/notes/trailing%2E%20.md',
      'doc-slash': 'eng/notes/guides/setup%3A v2.md',
      'doc-root': 'eng/notes/%00/rooted.md',
    };

    const dry = await run(world, { MDBISYNC_CONFIRM: '' });
    for (const path of Object.values(expected)) assert.ok(dry.report.summary?.plan.create.includes(path), path);
    const { result } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    const ids = await readIds();
    for (const [id, path] of Object.entries(expected)) {
      assert.equal(ids[path], id, path);
      assert.match(await show(`refs/mdbisync/linear:${path}`), /^# /, path);
    }

    // Merged, the sync and a second initial sync leave Linear, its titles and the tracked branch alone.
    await merge(world);
    const mutations = linearMutations(world).length;
    const after = await run(world, {}, 'sync');
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.equal(linearMutations(world).length, mutations, 'the sync wrote to Linear');
    assert.deepEqual(world.linear.documents.map((d) => [d.id, d.title]), titles);
    const again = await run(world);
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.equal(again.report.linearToGit?.pullRequest, null);
    assert.equal(world.github.pullRequests.length, 1);
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
    assert.deepEqual([...(resumed.report.linearToGit?.overwritten ?? []), ...(resumed.report.linearToGit?.created ?? [])].sort(), [UNSAFE, 'eng/notes/README.md', 'eng/notes/faq.md', 'eng/notes/plan.md', 'eng/ops/runbook.md']);
    assert.deepEqual(await readIds(), IDS);
    assert.equal(world.github.pullRequests.length, 1);
    // No duplicate files: exactly one file per document.
    const tree = await files('refs/mdbisync/linear');
    assert.deepEqual(tree.filter((path) => path.endsWith('runbook.md') || path.endsWith('faq.md') || path.includes('Q3')), CREATE);
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

  it('a title that lands in another annotated folder is filed in its own folder under a suffixed name', async () => {
    const world = fakeWorld();
    // A team document titled like a path into the project folder `eng/notes`.
    world.linear.documents = [...linearDocuments(), doc('doc-stray', 'notes/stray', { teamId: 'team-eng' }, `# Stray\n\n${CANARY}`)];
    // Its slash is encoded and the id suffix added, so the file stays in the team folder; the dry run says so too.
    const stray = `eng/notes%2Fstray~${createHash('sha256').update('doc-stray').digest('hex').slice(0, 12)}.md`;
    const dry = await run(world, { MDBISYNC_CONFIRM: '' });
    assert.ok((dry.report.summary?.plan.create ?? []).includes(stray));
    assert.ok(!(dry.report.summary?.plan.create ?? []).includes('eng/notes/stray.md'));
    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(report.linearToGit?.leftOutAtRecord, []);
    assert.ok(!(await files('refs/mdbisync/linear')).includes('eng/notes/stray.md'));
    assert.equal(await show(`refs/mdbisync/linear:${stray}`), `# Stray\n\n${CANARY}`);
    assert.equal((await readIds())[stray], 'doc-stray');
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-stray')?.title, 'notes/stray');

    // Merged, the sync finds the file is that document's and changes nothing in Linear, its title included.
    await merge(world);
    const mutations = linearMutations(world).length;
    const after = await run(world, {}, 'sync');
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.equal(linearMutations(world).length, mutations);
    assert.equal(world.linear.documents.find((d) => d.id === 'doc-stray')?.title, 'notes/stray');
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
    assert.match(world.github.pullRequests[0]?.body ?? '', /- 3 files are new/);
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
  const suffix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
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

  it('gives a title shared by two documents to the older one, and the newer a name with its id suffix', () => {
    const plan = planLinearToGit(input([listed('new', 'faq', '2026-01-02T00:00:00Z'), listed('old', 'faq', '2026-01-01T00:00:00Z')]));
    assert.deepEqual(plan.create.map((entry) => [entry.documentId, entry.path, entry.title]), [
      ['old', 'notes/faq.md', 'faq'],
      ['new', `notes/faq~${suffix('new')}.md`, 'faq'],
    ]);
    assert.deepEqual(plan.leftOut, []);
  });

  it('does not create a file that differs from an existing one only in case', () => {
    const plan = planLinearToGit(input([listed('plan', 'plan', '2026-01-01T00:00:00Z'), listed('Plan', 'Plan', '2026-01-02T00:00:00Z')], { 'notes/plan.md': '# Plan\n' }));
    assert.deepEqual(plan.overwrite.map((entry) => entry.documentId), ['plan']);
    assert.deepEqual(plan.create.map((entry) => [entry.documentId, entry.path]), [['Plan', `notes/Plan~${suffix('Plan')}.md`]]);
    assert.deepEqual(plan.leftOut, []);
  });

  it('gives a name that differs only in case to the older document', () => {
    const plan = planLinearToGit(input([listed('newer', 'Plan', '2026-01-02T00:00:00Z'), listed('older', 'plan', '2026-01-01T00:00:00Z')]));
    assert.deepEqual(plan.create.map((entry) => [entry.documentId, entry.path]).sort(), [
      ['newer', `notes/Plan~${suffix('newer')}.md`],
      ['older', 'notes/plan.md'],
    ]);
  });

  it('gives an encoded name to the title it encodes, not to a title that reads as that name', () => {
    const files = { 'notes/Q3%3A goals.md': '# Goals\n', 'notes/Q3%253A goals.md': '# Literal\n' };
    const plan = planLinearToGit(input([listed('literal', 'Q3%3A goals', '2026-01-01T00:00:00Z'), listed('colon', 'Q3: goals', '2026-01-02T00:00:00Z')], files));
    assert.deepEqual(plan.overwrite.map((entry) => [entry.documentId, entry.path]).sort(), [
      ['colon', 'notes/Q3%3A goals.md'],
      ['literal', 'notes/Q3%253A goals.md'],
    ]);
    assert.deepEqual([plan.create, plan.remove], [[], []]);
  });

  it('removes a file without a document but keeps the folder annotation', () => {
    const plan = planLinearToGit(input([], { 'notes/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n', 'notes/old.md': '# Old\n' }));
    assert.deepEqual(plan.remove, ['notes/old.md']);
    assert.deepEqual(plan.kept, [{ path: 'notes/README.md', reason: 'annotation' }]);
  });

  it('names files for titles a path cannot hold by the rule the capture uses, and keeps the titles', () => {
    const titles = ['Q3: plans?', 'a*b', ' lead', 'guides/setup', '/root', 'a/../b', 'end.', '50%', 'CON', 'pipe|and\\slash'];
    const plan = planLinearToGit(input(titles.map((title, index) => listed(`doc-${index}`, title, `2026-01-01T00:00:0${index}Z`))));
    const byId = new Map(plan.create.map((entry) => [entry.documentId, entry]));
    assert.deepEqual(
      titles.map((title, index) => [title, byId.get(`doc-${index}`)?.path]),
      [
        ['Q3: plans?', 'notes/Q3%3A plans%3F.md'],
        ['a*b', 'notes/a%2Ab.md'],
        [' lead', 'notes/ lead.md'],
        ['guides/setup', 'notes/guides/setup.md'],
        ['/root', 'notes/%00/root.md'],
        ['a/../b', 'notes/a/%2E%2E/b.md'],
        ['end.', 'notes/end%2E.md'],
        ['50%', 'notes/50%25.md'],
        ['CON', 'notes/%43ON.md'],
        ['pipe|and\\slash', 'notes/pipe%7Cand%5Cslash.md'],
      ],
    );
    // The title stays the document's; the file's own title is its encoded path.
    assert.equal(byId.get('doc-0')?.title, 'Q3: plans?');
    assert.equal(byId.get('doc-0')?.fileTitle, 'Q3%3A plans%3F');
    assert.deepEqual(plan.leftOut, []);
  });
});

describe('the security gate of an initial sync from Linear', () => {
  it("keeps Linear's text and the files it embeds out of the record when a hook finds a secret", async () => {
    const fixture = await createFixture();
    try {
      await fixture.seed(TREE);
      const config = resolveStateConfig({});
      const git = await fixture.clone('gate');
      const fetched = await fetchState(git, config);
      const mapping = await loadMapping(git, fetched.tracked);
      const world = fakeWorld();
      const SECRET = ['blocked', 'value', '731'].join('-');
      const leak = `${UPLOADS_HOST}/0/env.txt`;
      const bytes = Buffer.from(`token: ${SECRET}\n`);
      world.linear.uploads.push({ filename: 'env.txt', contentType: 'text/plain', size: bytes.length, assetUrl: leak, bytes });
      world.linear.documents = linearDocuments().map((d) =>
        d.id === 'doc-plan' ? { ...d, content: `# Plan\n\n[env](${leak})\n` } : d.id === 'doc-faq' ? { ...d, content: `# FAQ\n\n${SECRET}\n` } : d,
      );
      const linear = new LinearClient({ token: 'test', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
      const { targets } = await resolveTargets(linear, mapping.zones.values());
      assert.ok(targets);
      const checked: string[][] = [];
      const security: SecurityGate = {
        configured: true,
        async check(files) {
          checked.push([...files.keys()]);
          return [...files.values()].some((content) => content.toString().includes(SECRET)) ? [{ hook: 'secret-check', line: 1 }] : [];
        },
      };
      const { result } = await confirmLinearToGit(
        { git, fetched, mapping, targets, linear },
        { config, github: { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) }, security, stopAfterDocuments: undefined },
      );
      assert.equal(result.complete, true, result.code);
      assert.deepEqual(result.leftOutAtRecord.sort((a, b) => a.path.localeCompare(b.path)), [
        { path: 'eng/notes/faq.md', rule: 'security-hook' },
        { path: 'eng/notes/plan.md', rule: 'security-hook' },
      ]);
      // The hooks saw the downloaded file with its document.
      assert.ok(checked.some((paths) => paths.includes('eng/notes/plan.md') && paths.some((path) => path.endsWith('.txt'))));
      const tree = (await fixture.remote.text(['ls-tree', '-r', '--name-only', 'refs/mdbisync/linear'])).split('\n');
      assert.ok(!tree.includes('eng/notes/faq.md') && !tree.some((path) => path.endsWith('.txt')));
      // The existing file keeps the tracked text and stays its document's.
      const ids = JSON.parse(await fixture.remote.text(['show', 'refs/mdbisync/ids:ids.json'])) as Record<string, { id: string }>;
      assert.equal(ids['eng/notes/plan.md']?.id, 'doc-plan');
      assert.equal(ids['eng/notes/faq.md'], undefined);
      const objects = await fixture.remote.text(['cat-file', '--batch-all-objects', '--batch']);
      assert.ok(!objects.includes(SECRET), 'blocked bytes reached the remote');
    } finally {
      await fixture.cleanup();
    }
  });
});
