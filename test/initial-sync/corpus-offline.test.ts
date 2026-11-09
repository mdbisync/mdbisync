// The confirmed initial sync over the generated corpus slices, offline: a
// local git remote seeded with the slice and a fake Linear that stores what
// it is sent. Checks what the live scenarios check where a fake can show it:
// every synchronized file has exactly one document holding its body (I1, I7,
// I8), a second run writes nothing and moves no ref (I6), the request count
// stays within its budget (I9), and no canary leaves the run (I5).

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { fixText, splitFile } from '../../src/format/index.ts';
import { findFileLinks } from '../../src/initial-sync/index.ts';
import { collectAnnotations } from '../../src/mapping/index.ts';
import { type RunReport } from '../../src/run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld } from '../../src/setup/test-helpers.ts';
import { type Fixture, createFixture } from '../../src/state/test-helpers.ts';
import { type Corpus, buildCorpus } from '../corpus/generate.ts';

/** A relative folder standing in for the fake's upload host while the fake formats content. */
const UPLOAD_PLACEHOLDER = 'uploaded-file-placeholder/';

const LINEAR_FORMAT_HOOK = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

/** A fake Linear whose teams and projects are the ones the slice's annotations name. */
function worldFor(files: ReadonlyMap<string, Buffer>): FakeWorld {
  const readmes = new Map([...files].filter(([path]) => /(^|\/)README\.md$/.test(path)).map(([path, content]) => [path, content.toString('utf8')]));
  const { annotations } = collectAnnotations(readmes);
  const world = fakeWorld();
  const teams = new Map<string, string>();
  const projects = new Map<string, { id: string; name: string; teamIds: string[] }>();
  for (const annotation of annotations) {
    if (annotation.team === undefined) continue;
    if (!teams.has(annotation.team)) teams.set(annotation.team, `team-${teams.size + 1}`);
  }
  for (const annotation of annotations) {
    const team = annotation.team ?? [...annotations].find((other) => other.team !== undefined && annotation.folder.startsWith(`${other.folder}/`))?.team;
    if (annotation.project === undefined || team === undefined) continue;
    const key = `${team}\0${annotation.project}`;
    if (!projects.has(key)) projects.set(key, { id: `project-${projects.size + 1}`, name: annotation.project, teamIds: [teams.get(team) as string] });
  }
  world.linear.teams = [...teams].map(([ref, id]) => ({ id, key: ref, name: ref }));
  world.linear.projects = [...projects.values()];
  return world;
}

describe('confirmed initial sync over the generated corpus (offline)', () => {
  let corpus: Corpus;
  before(() => {
    // The hook revision only fills the corpus's .pre-commit-config.yaml, which this test replaces.
    corpus = buildCorpus("a".repeat(40));
  });

  for (const slice of ['mini', 'bank', 'mid'] as const) {
    describe(slice, () => {
      let fixture: Fixture;
      let cwd: string;
      let files: Map<string, Buffer>;
      let world: FakeWorld;

      before(async () => {
        const byPath = new Map(corpus.files.map((file) => [file.path, file.content]));
        files = new Map(corpus.slices[slice].map((path) => [path, byPath.get(path) as Buffer]));
        files.set('.pre-commit-config.yaml', Buffer.from(LINEAR_FORMAT_HOOK));
        fixture = await createFixture();
        const attributes = files.get('.gitattributes')?.toString('utf8') ?? '';
        const lfs = [...attributes.matchAll(/^(\S+)\s.*filter=lfs/gm)].map((match) => match[1] as string);
        await fixture.seed(Object.fromEntries(files), lfs.length > 0 ? { lfs } : {});
        cwd = (await fixture.clone('work')).dir;
        world = worldFor(files);
        // Like Linear, the fake stores Markdown in its own form; the corpus is not written in that form.
        // Linear stores a link to an uploaded file as a file, the form `fix` gives a relative link to a
        // file (format probe, attachments/several.md); so upload URLs are formatted as such links.
        world.linear.store = (content) => {
          const asFiles = content.replaceAll(`${UPLOADS_HOST}/`, UPLOAD_PLACEHOLDER);
          return fixText(asFiles).replaceAll(UPLOAD_PLACEHOLDER, `${UPLOADS_HOST}/`);
        };
      });
      after(() => fixture.cleanup());

      const run = async () => {
        const reportFile = join(fixture.root, 'report.json');
        await rm(reportFile, { force: true });
        const requestsBefore = world.requests.length;
        const result = await runCli(['initial-sync'], {
          cwd,
          fetch: fakeFetch(world),
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
            MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
            MDBISYNC_LINEAR_API_URL: LINEAR_API,
            MDBISYNC_GITHUB_TOKEN: 'gh-token',
            MDBISYNC_GITHUB_API_URL: GITHUB_API,
            MDBISYNC_REPOSITORY: 'owner/repo',
            MDBISYNC_REPORT_FILE: reportFile,
            MDBISYNC_DIRECTION: 'git-to-linear',
            MDBISYNC_CONFIRM: 'true',
          },
        });
        const report = JSON.parse(await readFile(reportFile, 'utf8')) as RunReport;
        const graphql = world.requests.slice(requestsBefore).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
        return { result, report, graphql };
      };
      const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);

      /**
       * The text Linear should hold for a file: each link to a file of the
       * slice points to the upload with that file's bytes (I1 maps links
       * this way), keeping the link's query and fragment.
       */
      const withUploadUrls = (path: string, text: string): string => {
        const isFile = (target: string) => files.has(target) && !target.endsWith('.md');
        let result = text;
        for (const link of findFileLinks(path, text, isFile).reverse()) {
          const bytes = files.get(link.target) as Buffer;
          const upload = world.linear.uploads.find((candidate) => candidate.bytes?.equals(bytes));
          assert.ok(upload !== undefined, `${link.target}, linked from ${path}, was not uploaded`);
          result = result.slice(0, link.from) + upload.assetUrl + link.suffix + result.slice(link.to);
        }
        return result;
      };

      it('writes every synchronized file once, records the state, and a second run changes nothing', async () => {
        const first = await run();
        assert.equal(first.result.exitCode, 0, `${first.result.stderr}\n${first.result.stdout.slice(0, 2000)}`);

        const canaries = corpus.manifest.files.filter((entry) => files.has(entry.path) && entry.canary !== null).map((entry) => entry.canary as string);
        // I5 as the harness checks it: the run's output and job summary (the summary is stdout here).
        const output = `${first.result.stdout}${first.result.stderr}`;
        assert.deepEqual(canaries.filter((canary) => output.includes(canary)), [], 'a canary left the run (I5)');

        const ids = JSON.parse(await fixture.remote.text(['show', 'refs/mdbisync/ids:ids.json'])) as Record<string, { id: string }>;
        const live = world.linear.documents.filter((d) => d.trashed !== true);
        assert.ok(Object.keys(ids).length > 0, 'nothing was synchronized');
        for (const [path, entry] of Object.entries(ids)) {
          const document = live.find((d) => d.id === entry.id);
          assert.ok(document !== undefined, `${path} has no document (I7)`);
          assert.equal(document.content, withUploadUrls(path, fixText(splitFile((files.get(path) as Buffer).toString('utf8')).body)), `${path} differs (I1, in Linear's form)`);
        }
        assert.equal(live.length, Object.keys(ids).length, 'documents without a path, or duplicates (I8)');
        const keys = live.map((d) => `${d.projectId ?? d.teamId}\0${d.title}`);
        assert.equal(new Set(keys).size, keys.length, 'duplicate titles in one place (I8)');

        const written = first.report.writtenCount;
        process.stdout.write(`# ${slice}: ${written} documents, ${first.graphql} GraphQL requests, ${first.report.summary?.leftOut.length ?? 0} left out\n`);
        assert.ok(first.graphql <= 1.5 * written + 5, `${first.graphql} requests for ${written} documents (I9)`);

        const before = await refs();
        const writes = world.linear.writes.count;
        const second = await run();
        assert.equal(second.result.exitCode, 0, second.result.stderr);
        assert.equal(world.linear.writes.count, writes, 'the second run wrote to Linear (I6)');
        assert.equal(await refs(), before, 'the second run moved a ref (I6)');
      });
    });
  }
});

// The initial sync from Linear over the same slices: Linear first gets one
// document per synchronized file (as the live scenarios seed it), then one
// document is edited, one trashed and one added only in Linear, and the state
// refs are dropped. The run must leave Linear as it is, record every id, and
// open one pull request whose synchronized folders equal Linear.
describe('confirmed initial sync from Linear over the generated corpus (offline)', () => {
  let corpus: Corpus;
  before(() => {
    corpus = buildCorpus("a".repeat(40));
  });

  for (const slice of ['mini', 'mid'] as const) {
    describe(slice, () => {
      let fixture: Fixture;
      let cwd: string;
      let files: Map<string, Buffer>;
      let world: FakeWorld;

      before(async () => {
        const byPath = new Map(corpus.files.map((file) => [file.path, file.content]));
        files = new Map(corpus.slices[slice].map((path) => [path, byPath.get(path) as Buffer]));
        files.set('.pre-commit-config.yaml', Buffer.from(LINEAR_FORMAT_HOOK));
        fixture = await createFixture();
        const attributes = files.get('.gitattributes')?.toString('utf8') ?? '';
        const lfs = [...attributes.matchAll(/^(\S+)\s.*filter=lfs/gm)].map((match) => match[1] as string);
        await fixture.seed(Object.fromEntries(files), lfs.length > 0 ? { lfs } : {});
        cwd = (await fixture.clone('work')).dir;
        world = worldFor(files);
      });
      after(() => fixture.cleanup());

      const run = async (direction: string, confirm = 'true') => {
        const reportFile = join(fixture.root, 'report.json');
        await rm(reportFile, { force: true });
        const requestsBefore = world.requests.length;
        const result = await runCli(['initial-sync'], {
          cwd,
          fetch: fakeFetch(world),
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
            MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
            MDBISYNC_LINEAR_API_URL: LINEAR_API,
            MDBISYNC_GITHUB_TOKEN: 'gh-token',
            MDBISYNC_GITHUB_API_URL: GITHUB_API,
            MDBISYNC_REPOSITORY: 'owner/repo',
            MDBISYNC_REPORT_FILE: reportFile,
            MDBISYNC_DIRECTION: direction,
            MDBISYNC_CONFIRM: confirm,
          },
        });
        const report = JSON.parse(await readFile(reportFile, 'utf8')) as RunReport;
        const graphql = world.requests.slice(requestsBefore).filter((request) => request === `POST ${LINEAR_API}/graphql`).length;
        return { result, report, graphql };
      };
      const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
      const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');

      it('opens one pull request that makes the synchronized folders equal to Linear', async () => {
        // Seed Linear through the other direction, then change it as people would.
        assert.equal((await run('git-to-linear')).result.exitCode, 0);
        const seeded = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
        const pages = Object.keys(seeded).filter((path) => !path.endsWith('README.md')).sort();
        const byPath = (path: string) => world.linear.documents.find((d) => d.id === seeded[path]?.id) as FakeDocument;
        const edited = pages[0] as string;
        const trashed = pages.at(-1) as string;
        byPath(edited).content = 'Rewritten in Linear.\n';
        byPath(trashed).trashed = true;
        const home = byPath(edited);
        const place = home.projectId !== undefined ? { projectId: home.projectId } : { teamId: home.teamId as string };
        world.linear.documents.push({ id: 'doc-linear-only', title: 'from-linear/new-page', ...place, createdAt: '2026-03-01T00:00:00Z', content: 'Only in Linear.\n' });
        for (const store of ['linear', 'ids', 'uploads']) await fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${store}`]);
        const documents = structuredClone(world.linear.documents);
        const writes = world.linear.writes.count;

        const dry = await run('linear-to-git', '');
        assert.equal(dry.result.exitCode, 0, dry.result.stderr);
        assert.deepEqual(dry.report.summary?.plan.remove, [trashed]);
        assert.equal(dry.report.summary?.plan.create.length, 1);
        assert.equal(world.linear.writes.count, writes, 'the dry run wrote to Linear');

        const confirmed = await run('linear-to-git');
        assert.equal(confirmed.result.exitCode, 0, `${confirmed.result.stderr}\n${confirmed.result.stdout.slice(0, 2000)}`);
        assert.deepEqual(world.linear.documents, documents, 'Linear changed');
        assert.equal(world.linear.writes.count, writes, 'the run wrote to Linear');
        assert.equal(world.github.pullRequests.length, 1);
        assert.equal(confirmed.report.linearToGit?.created.length, 1);
        const canaries = corpus.manifest.files.filter((entry) => files.has(entry.path) && entry.canary !== null).map((entry) => entry.canary as string);
        const output = `${confirmed.result.stdout}${confirmed.result.stderr}${world.github.pullRequests[0]?.body ?? ''}`;
        assert.deepEqual(canaries.filter((canary) => output.includes(canary)), [], 'a canary left the run (I5)');

        // The pull request's head: every live document is a file holding its text (I1, I7).
        const ids = JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
        const live = world.linear.documents.filter((d) => d.trashed !== true);
        assert.equal(Object.keys(ids).length, live.length, `a live document has no id (I7): ${JSON.stringify(confirmed.report.linearToGit?.leftOutAtRecord)}`);
        for (const [path, entry] of Object.entries(ids)) {
          const document = live.find((d) => d.id === entry.id);
          assert.ok(document !== undefined, `${path} has no live document`);
          assert.equal(splitFile(await show(`refs/heads/mdbisync/linear:${path}`)).body, document.content, `${path} differs from Linear (I1)`);
        }
        const tree = (await fixture.remote.text(['ls-tree', '-r', '--name-only', 'refs/heads/mdbisync/linear'])).split('\n');
        assert.ok(!tree.includes(trashed), 'a file without a document stayed');
        process.stdout.write(`# ${slice} from Linear: ${Object.keys(ids).length} documents, ${confirmed.graphql} GraphQL requests\n`);

        const before = await refs();
        const again = await run('linear-to-git');
        assert.equal(again.result.exitCode, 0, again.result.stderr);
        assert.equal(await refs(), before, 'a second run moved a ref (I6)');
        assert.equal(world.github.pullRequests.length, 1, 'a second pull request was opened (I6)');
      });
    });
  }
});
