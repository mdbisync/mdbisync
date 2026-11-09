// User-facing capacity checks against a fake Linear and a real local Git remote.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from './finish.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';

const TREE = {
  'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
  'eng/notes/README.md': '---\nlinear-project: Field notes\n---\n\n# Notes\n',
  '.pre-commit-config.yaml': `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`,
};

describe('container document capacity', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('work')).dir;
    world = fakeWorld();
  });
  afterEach(() => fixture.cleanup());
  const refs = () => fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
  async function run(command = 'initial-sync', confirm = false, cap = '10', fetchOverride?: typeof fetch, beforeCapacity?: () => void) {
    const reportFile = join(fixture.root, 'report.json');
    let refsBeforeWrite: string | undefined;
    let listings = 0;
    const normal = fetchOverride ?? fakeFetch(world);
    const request: typeof fetch = async (url, init) => {
      if (command === 'sync' && refsBeforeWrite === undefined && String(url).endsWith('/graphql')) {
        const query = JSON.parse(String(init?.body)) as {operationName?:string};
        // Capture lists the containers first (one page here: fewer than 250 documents); a run with
        // something to write lists them again before writing.
        if (query.operationName === 'ListDocuments' && ++listings === 2) {
          refsBeforeWrite = await refs();
          beforeCapacity?.();
        }
      }
      return normal(url, init);
    };
    const result = await runCli([command], { cwd, fetch: request, env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      MDBISYNC_LINEAR_CLIENT_ID: 'client-id', MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
      MDBISYNC_LINEAR_API_URL: LINEAR_API, MDBISYNC_GITHUB_TOKEN: 'gh-token',
      MDBISYNC_GITHUB_API_URL: GITHUB_API, MDBISYNC_REPOSITORY: 'owner/repo',
      MDBISYNC_REPORT_FILE: reportFile, MDBISYNC_DOCUMENT_CAP: cap,
      // Keep these capacity journeys in deferred-merge mode.
      MDBISYNC_MERGE_GRACE_SECONDS: '0',
      MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: String(confirm),
    } });
    return { ...result, refsBeforeWrite, report: JSON.parse(await readFile(reportFile, 'utf8')) as RunReport };
  }
  function populate(count: number) {
    for (const place of [{ teamId: 'team-eng' }, { projectId: 'project-api' }]) {
      for (let index = 0; index < count; index++) world.linear.documents.push({
        ...place, id: `${Object.values(place)[0]}-${index}`, title: `Older ${index}`,
        createdAt: '2026-01-01T00:00:00Z',
        ...(index === 0 ? {} : index === 1 ? { archivedAt: '2026-01-02T00:00:00Z' } : { trashed: true, archivedAt: '2026-01-02T00:00:00Z' }),
      });
    }
  }
  it('dry run lists every over-cap container with live, trash and planned counts; confirmation writes nothing', async () => {
    populate(10);
    const before = await refs();
    const dry = await run();
    assert.equal(dry.exitCode, 0, dry.stderr);
    assert.equal(dry.report.capacity.length, 2);
    for (const c of dry.report.capacity) assert.deepEqual(
      [c.live, c.trashed, c.archived, c.planned, c.total, c.cap, c.status], [1, 8, 1, 1, 11, 10, 'over-cap']);
    const confirmed = await run('initial-sync', true);
    assert.equal(confirmed.exitCode, INCOMPLETE_EXIT_CODE, confirmed.stderr);
    assert.equal(confirmed.report.code, 'container-cap');
    assert.equal(confirmed.report.changed, false);
    assert.deepEqual(confirmed.report.capacity, dry.report.capacity);
    assert.deepEqual(world.writes, []);
    assert.equal(await refs(), before);
    for (const output of [dry.stdout, confirmed.stdout]) {
      assert.match(output, /Stopped before any write/);
      assert.match(output, /team "ENG"/);
      assert.match(output, /project "Field notes"/);
      assert.match(output, /\| 1 \| 8 \| 1 \| 1 \| 11 \| 10 \| over-cap \|/);
    }
  });
  it('warns at 90% in dry run and confirmed run, and proceeds', async () => {
    populate(8);
    const dry = await run();
    const confirmed = await run('initial-sync', true);
    for (const result of [dry, confirmed]) {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Warning: a container is within 10%/);
      assert.ok(result.report.capacity.every((c) => c.status === 'warning' && c.total === 9));
    }
    assert.deepEqual(confirmed.report.capacity, dry.report.capacity);
    assert.equal(confirmed.report.writtenCount, 2);
    assert.equal(confirmed.report.complete, true);
  });
  it('allows additions exactly at the cap and uses 1000 by default, including paginated trash', async () => {
    populate(999);
    const dry = await run('initial-sync', false, '');
    assert.equal(dry.exitCode, 0, dry.stderr);
    assert.ok(dry.report.capacity.every((c) => c.cap === 1000 && c.total === 1000 && c.status === 'warning'));
    const confirmed = await run('initial-sync', true, '');
    assert.equal(confirmed.exitCode, 0, confirmed.stderr);
    assert.equal(confirmed.report.writtenCount, 2);
  });
  for (const [count, blocked] of [[9, true], [7, false]] as const) {
    it(`sync cycle ${blocked ? 'stops before every write above the cap' : 'warns and proceeds near the cap'}`, async () => {
      assert.equal((await run('initial-sync', true)).exitCode, 0);
      populate(count);
      await fixture.seed({ 'eng/new.md': '# New\n', 'eng/notes/new.md': '# New\n' });
      const writesBefore = world.writes.length;
      const result = await run('sync');
      assert.equal(result.exitCode, blocked ? INCOMPLETE_EXIT_CODE : 0, result.stderr);
      assert.equal(result.report.capacity.length, 2);
      assert.ok(result.report.capacity.every((c) => c.planned === 1 && c.total === count + 2 && c.status === (blocked ? 'over-cap' : 'warning')));
      if (blocked) {
        assert.equal(result.report.code, 'container-cap');
        // The cap stops every Linear write; the sync pull request takes what capture found to the tracked branch.
        assert.deepEqual(world.writes.slice(writesBefore).filter((write) => !write.endsWith(' /pulls')), []);
        assert.equal(await refs(), result.refsBeforeWrite, 'the capacity stop must leave the captured state untouched');
        assert.equal(result.report.changed, true, 'capture records the newly observed live documents');
        assert.equal(result.report.capture?.changed.length, 2);
        assert.equal(result.report.sync?.record, null);
      } else {
        assert.match(result.stdout, /Warning: a container is within 10%/);
        assert.equal(result.report.writtenCount, 2);
        assert.equal(result.report.complete, true);
      }
    });
  }
  it('reports capacity even when the tracked branch has no new changes', async () => {
    assert.equal((await run('initial-sync', true)).exitCode, 0);
    populate(8);
    const warning = await run('sync');
    assert.equal(warning.exitCode, 0, warning.stderr);
    assert.match(warning.stdout, /Warning: a container is within 10%/);
    assert.equal(warning.report.changed, true, 'the new live documents were captured');
    assert.equal(warning.report.capture?.changed.length, 2);
    assert.equal(warning.report.writtenCount, 0);
    assert.equal(warning.report.sync?.record, null);
    assert.ok(warning.report.capacity.every((c) => c.total === 9 && c.planned === 0));
    world.linear.documents.push({ id: 'extra-a', teamId: 'team-eng', title: 'Extra A', trashed: true, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'extra-b', teamId: 'team-eng', title: 'Extra B', trashed: true, createdAt: '2026-01-01T00:00:00Z' });
    const writesBefore = world.writes.length;
    const blocked = await run('sync');
    assert.equal(blocked.exitCode, INCOMPLETE_EXIT_CODE, blocked.stderr);
    assert.equal(blocked.report.code, 'container-cap');
    // Nothing reaches Linear; the sync pull request step may note GitHub's refused merge on its pull request.
    assert.deepEqual(world.writes.slice(writesBefore).filter((write) => !write.includes('/pulls')), []);
  });
  it('a previously left-out document already at the destination is not counted as an addition', async () => {
    assert.equal((await run('initial-sync', true)).exitCode, 0);
    await fixture.seed({ 'eng/README.md': '---\nlinear-team: ENG\n---\n\nA note.[^1]\n\n[^1]: Source.\n' });
    assert.equal((await run('sync', false, '1')).exitCode, 0);
    await fixture.seed({ 'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n\nUpdated.\n' });
    const result = await run('sync', false, '1');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.report.capacity.find((c) => c.place.kind === 'team')?.planned, 0);
    assert.deepEqual(result.report.sync?.updated, ['eng/README.md']);
    assert.equal(result.report.complete, true);
  });
  for (const rateLimited of [true, false]) {
    it(`a failed capacity read ${rateLimited ? 'reports a rate-limit stop' : 'reports an API failure'} before writing`, async () => {
      assert.equal((await run('initial-sync', true)).exitCode, 0);
      await fixture.seed({ 'eng/new.md': '# New\n' });
      const writesBefore = world.writes.length;
      const normal = fakeFetch(world);
      let listings = 0;
      // The writer's listing: the run's second, after capture's.
      const failedRead: typeof fetch = async (url, init) => {
        const query = String(url).endsWith('/graphql') ? JSON.parse(String(init?.body)) : undefined;
        if (query?.operationName === 'ListDocuments' && ++listings === 2) {
          return new Response(JSON.stringify({ errors: [{ message: 'Request refused', extensions: { code: rateLimited ? 'RATELIMITED' : 'FORBIDDEN' } }] }), {
            status: rateLimited ? 429 : 400, headers: { 'content-type': 'application/json', 'retry-after': '60' },
          });
        }
        return normal(url, init);
      };
      const result = await run('sync', false, '10', failedRead);
      assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE, result.stderr);
      assert.equal(result.report.code, rateLimited ? 'stopped' : 'write-failed');
      assert.equal(result.report.changed, false);
      assert.equal(result.report.complete, false);
      assert.equal(world.writes.length, writesBefore);
      assert.equal(await refs(), result.refsBeforeWrite, 'a failed capacity read must not publish writer state');
      assert.equal(world.revoked, 2);
    });
  }
  it('an image-only change lists the containers again and stops above the cap before writing', async () => {
    await fixture.seed({ 'eng/media/diagram.png': 'first diagram bytes', 'eng/figure.md': '# Figure\n\n![Diagram](media/diagram.png)\n' });
    assert.equal((await run('initial-sync', true)).exitCode, 0);
    // Only the image changes: no Markdown file differs, yet the document linking it is updated.
    await fixture.seed({ 'eng/media/diagram.png': 'second diagram bytes' });
    const writesBefore = world.writes.length;
    const result = await run('sync', false, '4', undefined, () => populate(3));
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE, result.stderr);
    assert.equal(result.report.code, 'container-cap');
    assert.deepEqual(world.writes.slice(writesBefore).filter((write) => !write.endsWith(' /pulls')), []);
  });
  it('does not count an adopted document as an additional create', async () => {
    assert.equal((await run('initial-sync', true)).exitCode, 0);
    populate(8);
    await fixture.seed({ 'eng/new.md': '# New\n' });
    const result = await run('sync', false, '10', undefined, () => {
      world.linear.documents.push({ id: 'unrecorded', teamId: 'team-eng', title: 'new', content: '# New\n', createdAt: '2026-01-01T00:00:00Z' });
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const team = result.report.capacity.find((c) => c.place.kind === 'team');
    assert.equal(team?.planned, 0);
    assert.equal(team?.total, 10);
    assert.deepEqual(result.report.sync?.adopted, ['eng/new.md']);
  });
});
