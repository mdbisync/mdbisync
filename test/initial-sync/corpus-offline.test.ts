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
import { collectAnnotations } from '../../src/mapping/index.ts';
import { type RunReport } from '../../src/run/finish.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../../src/setup/test-helpers.ts';
import { type Fixture, createFixture } from '../../src/state/test-helpers.ts';
import { type Corpus, buildCorpus } from '../corpus/generate.ts';

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
        world.linear.store = (content) => fixText(content);
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
          assert.equal(document.content, fixText(splitFile((files.get(path) as Buffer).toString('utf8')).body), `${path} differs (I1, in Linear's form)`);
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
