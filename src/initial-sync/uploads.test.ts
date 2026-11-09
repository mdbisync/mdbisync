// Files that documents embed or link, through the command line against a
// local git remote with LFS and a fake Linear: each file is uploaded once by
// its content hash, its URL is written into the documents, the cache is
// recorded, and the recorded files map the URLs back to the tracked links.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { fixText } from '../format/index.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { Git } from '../state/index.ts';
import { type FakeUpload, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, countLocalLfsObjects, createFixture } from '../state/test-helpers.ts';
import { DEFAULT_UPLOAD_LIMIT, findFileLinks, resolveTarget, restoreFileLinks } from './uploads.ts';

const CANARY = 'kx-5d2a9e40';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const DIAGRAM = Buffer.from(`diagram bytes ${'x'.repeat(300)}`);
const PIXEL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const REPORT = Buffer.from('%PDF-1.4 report');
const HUGE = Buffer.alloc(DEFAULT_UPLOAD_LIMIT + 1, 7);
/** A pointer to an LFS object the remote does not have. */
const LOST_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${'ab'.repeat(32)}\nsize 42\n`;

const A_BODY = [
  '# A',
  '',
  `![Diagram](../media/diagram.png) ${CANARY}`,
  '',
  'The [report](<files/report 2026.pdf>), [the same](files/report%202026.pdf) and [its page](files/report%202026.pdf#page=2).',
  '',
  '[Other](b.md), [site](https://example.com/x.png), [missing](gone.png) and [section](#a).',
].join('\n');
const B_BODY = `# B\n\n![Diagram](../media/diagram.png)\n\n![Pixel](./pixel.png)\n\n${CANARY}`;
const SHARED = ['c1', 'c2', 'c3', 'c4', 'c5'];

const TREE: Record<string, string | Buffer> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}`,
  'eng/media/diagram.png': DIAGRAM,
  'eng/media/huge.png': HUGE,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}`,
  'eng/notes/a.md': A_BODY,
  'eng/notes/b.md': B_BODY,
  'eng/notes/big.md': `# Big\n\n![Huge](../media/huge.png) and ![Diagram](../media/diagram.png)\n\n${CANARY}`,
  'eng/notes/lost.md': `# Lost\n\n[Data](only-lost.csv)\n\n![Lost](lost.png)\n\n${CANARY}`,
  'eng/notes/lost.png': LOST_POINTER,
  'eng/notes/only-lost.csv': 'a,b\n1,2\n',
  'eng/notes/pixel.png': PIXEL,
  'eng/notes/files/report 2026.pdf': REPORT,
  ...Object.fromEntries(SHARED.map((name) => [`eng/notes/${name}.md`, `# ${name}\n\n![Diagram](../media/diagram.png)\n\n${CANARY}`])),
};
const LFS = ['eng/media/**', '*.pdf'];

const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');

describe('uploads of linked files in an initial sync', () => {
  let fixture: Fixture;
  let cwd: string;
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE, { lfs: LFS });
    cwd = (await fixture.clone('work')).dir;
  });
  afterEach(() => fixture.cleanup());

  const run = async (world: FakeWorld, fetchOverride?: typeof fetch) => {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const env = {
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
    };
    const result = await runCli(['initial-sync'], { env, cwd, fetch: fetchOverride ?? fakeFetch(world) });
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), 'the output holds content');
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    assert.ok(!summary.includes(CANARY), 'the job summary holds content');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    return { result, report, summary };
  };

  const show = (spec: string) => fixture.remote.text(['show', spec]);
  const refs = async () => {
    const text = await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
    return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
  };
  const document = (world: FakeWorld, title: string) => world.linear.documents.find((d) => d.title === title && d.trashed !== true);
  const uploadOf = (world: FakeWorld, content: Buffer) => world.linear.uploads.filter((upload) => upload.bytes?.equals(content));

  it('L1-07 and L1-08: uploads each linked file once by content hash, writes its URL and records the cache', async () => {
    const world = fakeWorld();
    const { result, report, summary } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);

    // One upload per distinct file: the diagram linked from eight documents, the pixel, and the report linked twice.
    assert.equal(world.linear.uploads.length, 3);
    for (const content of [DIAGRAM, PIXEL, REPORT]) assert.equal(uploadOf(world, content).length, 1, 'uploaded once, bytes equal');
    // I9: the three files take one API request, before the first write; the over-limit and unreadable files are not sent.
    assert.deepEqual(world.writes.filter((operation) => operation.startsWith('FileUpload')), ['FileUploads']);
    // The batch goes out just before the first document that needs a file; a file only an unreadable document links is not sent.
    const createdA = world.writes.findIndex((operation, index) => operation === 'CreateDocument' && index > world.writes.indexOf('FileUploads'));
    assert.ok(createdA !== -1);
    assert.equal(world.linear.uploads.some((upload) => upload.filename === 'only-lost.csv'), false);
    const [diagram, pixel, report2026] = [DIAGRAM, PIXEL, REPORT].map((content) => uploadOf(world, content)[0]) as [FakeUpload, FakeUpload, FakeUpload];
    assert.equal(report2026.filename, 'report 2026.pdf');
    assert.equal(report2026.contentType, 'application/pdf');
    assert.equal(pixel.contentType, 'image/png');
    assert.ok(diagram.assetUrl.startsWith(UPLOADS_HOST));

    assert.equal(
      document(world, 'a')?.content,
      A_BODY.replace('../media/diagram.png', diagram.assetUrl).replace('<files/report 2026.pdf>', `<${report2026.assetUrl}>`).replace('(files/report%202026.pdf)', `(${report2026.assetUrl})`).replace('(files/report%202026.pdf#page=2)', `(${report2026.assetUrl}#page=2)`).replace('(b.md)', `(<https://linear.app/${world.linear.urlKey}/document/${document(world, 'b')!.id}>)`),
      'document and upload links use their URLs; sites, missing files and anchors stay as they are',
    );
    assert.equal(document(world, 'b')?.content, B_BODY.replace('../media/diagram.png', diagram.assetUrl).replace('./pixel.png', pixel.assetUrl));
    for (const name of SHARED) assert.ok(document(world, name)?.content?.includes(`![Diagram](${diagram.assetUrl})`));

    const cache = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.deepEqual(cache, Object.fromEntries([[sha(DIAGRAM), diagram.assetUrl], [sha(PIXEL), pixel.assetUrl], [sha(REPORT), report2026.assetUrl]].sort()));

    // The record maps the URLs back: every written file equals the tracked one.
    assert.equal(report.record?.reformattedCount, 0);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/a.md'), A_BODY);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/b.md'), B_BODY);

    // A file over the upload limit leaves its document out, unread and not uploaded; so does an LFS object that is missing.
    assert.deepEqual(report.initialSync?.leftOutAtWrite, [
      { path: 'eng/notes/big.md', rule: 'upload-too-large', files: ['eng/media/huge.png'] },
      { path: 'eng/notes/lost.md', rule: 'upload-unreadable', files: ['eng/notes/lost.png'] },
    ]);
    assert.deepEqual(report.oversizeFiles, ['eng/media/huge.png']);
    assert.equal(document(world, 'big'), undefined);
    assert.equal(document(world, 'lost'), undefined);
    assert.match(summary, /\| eng\/notes\/big\.md \| upload-too-large \|  \| eng\/media\/huge\.png \|/);
    assert.match(summary, /\| eng\/notes\/lost\.md \| upload-unreadable \|/);
    assert.equal(await countLocalLfsObjects(new Git(cwd)), 2, 'only the diagram and the report are downloaded');
  });

  it('L5-07: a run stopped by the rate limit after a batch records its uploads; the next run does not repeat them', async () => {
    const world = fakeWorld();
    // Mutations: two README documents, the batch of three files, document a; the fifth is refused.
    world.linear.writes.rateLimitAt = 5;
    const first = await run(world);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.equal(first.report.stoppedEarly, true);
    assert.equal(world.linear.uploads.length, 3);
    const cached = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.deepEqual(Object.keys(cached).sort(), [sha(DIAGRAM), sha(PIXEL), sha(REPORT)].sort());

    delete world.linear.writes.rateLimitAt;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(world.linear.uploads.length, 3, 'nothing is uploaded again');
    assert.equal(await show('refs/mdbisync/linear:eng/notes/b.md'), B_BODY);
  });

  it('L1-18: a file not in Linear form whose attachments Linear stores as files is not written again', async () => {
    await fixture.seed({ 'eng/notes/list.md': `# List\n\n* [Diagram](../media/diagram.png)\n* [Notes](b.md)\n\n${CANARY}` });
    const world = fakeWorld();
    // Like Linear: a link to an uploaded file is stored as a file, the form `fix` gives a relative link to a file.
    world.linear.store = (content) => fixText(content.replaceAll(`${UPLOADS_HOST}/`, 'uploaded/')).replaceAll('uploaded/', `${UPLOADS_HOST}/`);
    assert.equal((await run(world)).result.exitCode, 0);
    const stored = document(world, 'list')?.content ?? '';
    assert.ok(stored.startsWith('# List\n\n* \n'), 'the fake stores the list as files');
    const writes = world.linear.writes.count;

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote again');
    assert.ok(report.initialSync?.unchanged.includes('eng/notes/list.md'));
  });

  it("L1-18: an image in angle brackets that Linear reformats is recorded in Linear's form, still an image, and not written again", async () => {
    await fixture.seed({ 'eng/notes/spaced.md': `# Spaced\n\n![Pixel](<pixel copy.png>)\n\n${CANARY}`, 'eng/notes/pixel copy.png': PIXEL });
    const world = fakeWorld();
    // Like Linear: the stored text is in Linear's form, a link to an uploaded file stored as a file.
    world.linear.store = (content) => fixText(content.replaceAll(`${UPLOADS_HOST}/`, 'uploaded/')).replaceAll('uploaded/', `${UPLOADS_HOST}/`);
    const first = await run(world);
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    const pixel = uploadOf(world, PIXEL)[0] as FakeUpload;
    assert.equal(document(world, 'spaced')?.content, `# Spaced\n\n![Pixel](${pixel.assetUrl})\n\n${CANARY}`, 'Linear dropped the brackets');
    // The record is Linear's form of the file: the image keeps a destination that still makes it an image.
    const recorded = await show('refs/mdbisync/linear:eng/notes/spaced.md');
    assert.equal(recorded, `# Spaced\n\n![Pixel](pixel%20copy.png)\n\n${CANARY}`);
    assert.equal(recorded, fixText(`# Spaced\n\n![Pixel](<pixel copy.png>)\n\n${CANARY}`));
    assert.ok(first.report.record?.reformattedCount !== undefined && first.report.record.reformattedCount > 0);

    const writes = world.linear.writes.count;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(world.linear.writes.count, writes, 'the second run wrote again');
    assert.ok(second.report.initialSync?.unchanged.includes('eng/notes/spaced.md'));
    assert.equal(await show('refs/mdbisync/linear:eng/notes/spaced.md'), recorded);
  });

  it('a stop right after a batch records the new uploads even when no document was written since the last push', async () => {
    const world = fakeWorld();
    // First run: the two README documents, then a stop; their ids are pushed.
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '2' };
    Object.assign(process.env, hooks);
    try {
      assert.equal((await run(world)).result.exitCode, INCOMPLETE_EXIT_CODE);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(world.linear.uploads.length, 0);
    // Resumed run: the README documents are skipped, the batch for a is uploaded (mutation 3)
    // and the create of a is refused (mutation 4), with no document written since the last push.
    world.linear.writes.rateLimitAt = 4;
    const second = await run(world);
    assert.equal(second.result.exitCode, INCOMPLETE_EXIT_CODE, second.result.stderr);
    assert.equal(second.report.writtenCount, 0);
    assert.equal(world.linear.uploads.length, 3);
    const cached = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.equal(Object.keys(cached).length, 3, 'the batch uploaded before the stop is recorded');

    delete world.linear.writes.rateLimitAt;
    assert.equal((await run(world)).result.exitCode, 0);
    assert.equal(world.linear.uploads.length, 3, 'nothing is uploaded again');
  });

  it('L1-18: a second run uploads nothing and writes nothing', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    const before = await refs();
    const writes = world.linear.writes.count;

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(world.linear.uploads.length, 3);
    assert.equal(world.linear.writes.count, writes);
    assert.equal(report.writtenCount, 0);
    assert.deepEqual(await refs(), before);
  });

  it('L5-11: a failed upload writes no document with a broken link; the next run uploads and writes it', async () => {
    const world = fakeWorld();
    // Linear refuses the pixel, alone or in a batch: the batch before the first write fails, and each document then uploads its own.
    world.linear.writes.reject = (operation, variables) => operation.startsWith('FileUpload') && Object.values(variables).includes('pixel.png');
    const first = await run(world);
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.deepEqual(first.report.initialSync?.failed.map((failure) => failure.path), ['eng/notes/b.md']);
    assert.equal(document(world, 'b'), undefined);
    assert.equal(first.report.record, null);
    // The uploads that worked are recorded with the ids, so the next run does not repeat them.
    const cached = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
    assert.deepEqual(Object.keys(cached).sort(), [sha(DIAGRAM), sha(REPORT)].sort());

    delete world.linear.writes.reject;
    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.equal(uploadOf(world, PIXEL).length, 1);
    assert.equal(uploadOf(world, DIAGRAM).length, 1, 'the diagram is not uploaded again');
    assert.equal(document(world, 'b')?.content?.includes(uploadOf(world, PIXEL)[0]!.assetUrl), true);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/b.md'), B_BODY);
  });

  for (const failure of ['http', 'reset'] as const) {
    it(`L5-11: a storage ${failure} partway through a batch preserves existing content and caches only complete uploads`, async () => {
      const world = fakeWorld();
      const before = '# Existing\n\nPrevious complete content.';
      world.linear.documents.push({ id: 'existing-b', title: 'b', projectId: 'project-api', createdAt: '2026-01-01T00:00:00Z', content: before });
      const base = fakeFetch(world);
      const failingFetch: typeof fetch = async (input, init) => {
        const match = /\/storage\/(\d+)$/.exec(String(input));
        if (init?.method === 'PUT' && match !== null && world.linear.uploads[Number(match[1])]?.filename === 'pixel.png') {
          if (failure === 'reset') throw new TypeError('connection reset');
          return new Response('', { status: 503 });
        }
        return base(input, init);
      };
      const first = await run(world, failingFetch);
      assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
      assert.deepEqual(first.report.initialSync?.failed.map((entry) => entry.path), ['eng/notes/b.md']);
      assert.equal(document(world, 'b')?.content, before);
      assert.ok(document(world, 'a') !== undefined, 'an independent document was written');
      const cache = JSON.parse(await show('refs/mdbisync/uploads:uploads.json')) as Record<string, string>;
      assert.equal(cache[sha(PIXEL)], undefined, 'a signed URL with no bytes never enters the cache');
      for (const url of Object.values(cache)) assert.ok(world.linear.uploads.some((upload) => upload.assetUrl === url && upload.bytes !== undefined));

      const second = await run(world);
      assert.equal(second.result.exitCode, 0, second.result.stderr);
      assert.equal(document(world, 'b')?.id, 'existing-b');
      assert.ok(document(world, 'b')?.content?.includes(uploadOf(world, PIXEL)[0]!.assetUrl));
      assert.equal(await show('refs/mdbisync/linear:eng/notes/b.md'), B_BODY);
    });
  }

  it('L1-15: a resumed run maps the links of the documents it skipped back to the tracked text', async () => {
    const world = fakeWorld();
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '3' };
    Object.assign(process.env, hooks);
    let first;
    try {
      first = await run(world);
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(first.result.exitCode, INCOMPLETE_EXIT_CODE, first.result.stderr);
    assert.ok(document(world, 'a') !== undefined, 'a was written before the stop');

    const second = await run(world);
    assert.equal(second.result.exitCode, 0, second.result.stderr);
    assert.ok(second.report.initialSync?.skippedCompleted.includes('eng/notes/a.md'));
    assert.equal(second.report.record?.reformattedCount, 0);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/a.md'), A_BODY);
    assert.equal(world.linear.uploads.length, 3);
  });

  it('L5-14: with the upload cache lost, the files are uploaded again and the tracked branch stays', async () => {
    const world = fakeWorld();
    assert.equal((await run(world)).result.exitCode, 0);
    const tracked = (await refs())['refs/heads/main'];
    await fixture.remote.run(['update-ref', '-d', 'refs/mdbisync/uploads']);

    const { result, report } = await run(world);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(world.linear.uploads.length, 6);
    assert.equal(report.record?.reformattedCount, 0);
    assert.equal((await refs())['refs/heads/main'], tracked);
    assert.equal(await show('refs/mdbisync/linear:eng/notes/b.md'), B_BODY);
  });
});

describe('file links in a document', () => {
  const files = new Set(['docs/img/a.png', 'docs/files/a b.pdf', 'docs/x(1).png', 'top.zip', 'docs/guide/a&b.png']);
  const isFile = (path: string) => files.has(path);
  const targets = (body: string) => findFileLinks('docs/guide/page.md', body, isFile).map((link) => [link.written, link.target]);

  it('finds images, links and definitions to files, with the destination as written', () => {
    assert.deepEqual(targets('![a](../img/a.png)'), [['../img/a.png', 'docs/img/a.png']]);
    assert.deepEqual(targets('[a](<../files/a b.pdf>)'), [['<../files/a b.pdf>', 'docs/files/a b.pdf']], 'with its angle brackets');
    assert.deepEqual(targets('[a](../files/a%20b.pdf)'), [['../files/a%20b.pdf', 'docs/files/a b.pdf']]);
    assert.deepEqual(targets('[a](../x\\(1\\).png)'), [['../x\\(1\\).png', 'docs/x(1).png']]);
    assert.deepEqual(targets('[a](../x(1).png)'), [['../x(1).png', 'docs/x(1).png']]);
    assert.deepEqual(targets('[a](../../top.zip#part)'), [['../../top.zip#part', 'top.zip']]);
    assert.deepEqual(targets('![a][r]\n\n[r]: ../img/a.png'), [['../img/a.png', 'docs/img/a.png']]);
    assert.deepEqual(targets('| x |\n| -- |\n| ![a](../img/a.png) |'), [['../img/a.png', 'docs/img/a.png']]);
    assert.deepEqual(targets('[**bold** text](../img/a.png)'), [['../img/a.png', 'docs/img/a.png']]);
    assert.deepEqual(targets('![x](a&amp;b.png)'), [['a&amp;b.png', 'docs/guide/a&b.png']], 'character references');
    assert.deepEqual(targets('![see [x](y) here](../img/a.png)'), [['../img/a.png', 'docs/img/a.png']], 'brackets in the alt text');
    const same = '![see [x](../img/a.png) here](../img/a.png)';
    assert.deepEqual(
      findFileLinks('docs/guide/page.md', same, isFile).map((link) => link.from),
      [same.lastIndexOf('../img/a.png')],
      'a link in the alt text to the same file: the image destination is the one replaced',
    );
    assert.deepEqual(targets('[a](../img/a.png "Title")'), [['../img/a.png', 'docs/img/a.png']]);
  });

  it('keeps the query and fragment to write after the upload URL', () => {
    const [link] = findFileLinks('docs/guide/page.md', '[spec](../files/a%20b.pdf#page=3)', isFile);
    assert.equal(link?.suffix, '#page=3');
    assert.equal(link?.target, 'docs/files/a b.pdf');
  });

  it('leaves other links alone', () => {
    for (const body of [
      '[a](https://example.com/a.png)',
      '[a](/docs/img/a.png)',
      '[a](#part)',
      '[a](other.md)',
      '[a](../img/missing.png)',
      '[a](../../../outside.png)',
      '`![a](../img/a.png)`',
      '    ![a](../img/a.png)',
      '<https://example.com/a.png>',
    ]) {
      assert.deepEqual(targets(body), [], body);
    }
  });

  it('resolves destinations against the document folder', () => {
    assert.equal(resolveTarget('a/b.md', './c.png'), 'a/c.png');
    assert.equal(resolveTarget('b.md', 'c%2Fd.png'), 'c/d.png');
    assert.equal(resolveTarget('b.md', '%E0%A4%A.png'), '%E0%A4%A.png');
    assert.equal(resolveTarget('b.md', 'mailto:x@example.com'), null);
    assert.equal(resolveTarget('b.md', '../c.png'), null);
    assert.equal(resolveTarget('b.md', 'dir/'), null);
  });

  it('maps upload URLs back to each link as it was written, in order', () => {
    const uploads = new Map([
      ['1'.repeat(64), 'https://uploads.example.test/1'],
      ['2'.repeat(64), 'https://uploads.example.test/12'],
    ]);
    const links = [
      { written: 'a.png', hash: '1'.repeat(64), suffix: '' },
      { written: './a.png', hash: '1'.repeat(64), suffix: '' },
      { written: '<b.png#p>', hash: '2'.repeat(64), suffix: '#p' },
      { written: '<c d.png>', hash: '1'.repeat(64), suffix: '' },
      { written: 'e.png#q', hash: '2'.repeat(64), suffix: '#q' },
    ];
    const stored = [
      'Pasted: `https://uploads.example.test/1` and ![old](https://uploads.example.test/1?v=2)',
      '![x](https://uploads.example.test/1) ![y](https://uploads.example.test/1) [z](<https://uploads.example.test/12#p>)',
      // Linear dropped the brackets: the spelling keeps its own, so the image stays an image.
      '![w](https://uploads.example.test/1)',
      // Linear added brackets the file did not have: the file's spelling comes back without them.
      '[v](<https://uploads.example.test/12#q>)',
    ].join('\n\n');
    assert.equal(
      restoreFileLinks(stored, links, uploads),
      'Pasted: `https://uploads.example.test/1` and ![old](https://uploads.example.test/1?v=2)\n\n![x](a.png) ![y](./a.png) [z](<b.png#p>)\n\n![w](<c d.png>)\n\n[v](e.png#q)',
      'only the written destinations are mapped back',
    );
  });
});
