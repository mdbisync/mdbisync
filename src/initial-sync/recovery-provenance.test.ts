// An initial sync from git that rebuilds the state keeps the provenance of
// plain links that came from Linear: a repository path a Linear member wrote
// as an image, repaired into a plain link, never uploads the file.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pullRequestHarness } from '../sync/pull-request-test-helpers.ts';

const PLAN = 'eng/notes/plan.md';
const ITEM = 'eng/notes/item-0.md';
const SECRET = 'records.csv';
const PUBLIC = 'public.csv';

describe('initial sync from git keeps plain-link provenance', () => {
  const h = pullRequestHarness();

  /** A Linear member's image of a repository file, repaired into a plain link and merged; a repository-authored plain link beside it. */
  async function repairedLink() {
    await h.editRef('refs/heads/main', SECRET, 'name,value\nExample,42\n');
    await h.editRef('refs/heads/main', PUBLIC, 'name,value\nShared,7\n');
    await h.gitEdit(ITEM, '# Item 0\n\n[Shared data](../../public.csv)\n');
    await h.settle();
    assert.match((await h.documentOf(ITEM)).content!, /uploads\.linear\.app/, 'a repository-authored plain link should upload');
    await h.editInLinear(PLAN, `# Plan\n\n![Report](../../${SECRET})\n`);
    await h.settle();
    assert.doesNotMatch((await h.documentOf(PLAN)).content!, /uploads\.linear\.app/);
    assert.ok(!h.world.linear.uploads.some((upload) => upload.filename === SECRET), 'the repaired link uploaded before recovery');
  }

  const initialSync = (extra: Record<string, string> = {}) => h.cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true', ...extra });
  const deleteRef = (name: string) => h.fixture.remote.run(['update-ref', '-d', `refs/mdbisync/${name}`]);

  async function assertProvenanceKept() {
    assert.ok(!h.world.linear.uploads.some((upload) => upload.filename === SECRET), 'recovery uploaded the file a Linear member linked');
    const document = await h.documentOf(PLAN);
    assert.match(document.content!, /records\.csv/);
    assert.doesNotMatch(document.content!, /uploads\.linear\.app/);
    const ids = await h.ids() as Record<string, { id: string; plainFiles?: string[] }>;
    assert.deepEqual(ids[PLAN]?.plainFiles, [SECRET]);
    const record = await h.fixture.remote.text(['log', '-1', '--format=%B', 'refs/mdbisync/linear']);
    assert.match(record, new RegExp(`^Plain-link: ${ids[PLAN]!.id} ${SECRET}$`, 'm'));
    // Later ordinary writes keep it too.
    await h.editInLinear(PLAN, `${document.content}\nAnother paragraph.\n`);
    await h.settle();
    await h.gitEdit(PLAN, `${await h.show(`refs/heads/main:${PLAN}`)}\nA repository edit.\n`);
    await h.settle();
    assert.ok(!h.world.linear.uploads.some((upload) => upload.filename === SECRET), 'a sync after recovery uploaded the file');
  }

  it('in a normal confirmed run', async () => {
    await repairedLink();
    const run = await initialSync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    await assertProvenanceKept();
  });

  it('in a run resumed after a stop', async () => {
    await repairedLink();
    // Two documents to write before the plan, so the first run stops between them.
    for (const page of ['combined/page-0.md', 'combined/page-1.md']) await h.editRef('refs/heads/main', page, `# ${page}\n\nRevised.\n`);
    const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(h.fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '1' };
    Object.assign(process.env, hooks);
    let stopped;
    try {
      stopped = await initialSync();
    } finally {
      for (const name of Object.keys(hooks)) delete process.env[name];
    }
    assert.equal(stopped.report.initialSync?.complete, false, JSON.stringify(stopped.report.initialSync));
    const resumed = await initialSync();
    assert.equal(resumed.result.exitCode, 0, resumed.result.stderr);
    assert.equal(resumed.report.resumed, true);
    await assertProvenanceKept();
  });

  it('with the ids and uploads refs deleted, and still uploads a repository-authored link', async () => {
    await repairedLink();
    await deleteRef('ids');
    await deleteRef('uploads');
    const before = h.world.linear.uploads.length;
    const dry = await initialSync({ MDBISYNC_CONFIRM: 'false' });
    assert.deepEqual(dry.report.summary?.leftOutFiles ?? [], []);
    const run = await initialSync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.initialSync?.leftOutAtWrite, []);
    assert.deepEqual(h.world.linear.uploads.slice(before).map((upload) => upload.filename), [PUBLIC]);
    await assertProvenanceKept();
  });

  it('with every state ref deleted: the dry run and the confirmed run leave out a plain link of unknown provenance', async () => {
    await repairedLink();
    for (const name of ['ids', 'uploads', 'linear']) await deleteRef(name);
    const before = h.world.linear.uploads.length;
    const expected = [{ path: ITEM, rule: 'link-provenance-unknown', files: [PUBLIC] }];
    const dry = await initialSync({ MDBISYNC_CONFIRM: 'false' });
    assert.equal(dry.result.exitCode, 0, dry.result.stderr);
    assert.deepEqual(dry.report.summary?.leftOutFiles.map(({ path, rules, files }) => ({ path, rule: rules.join(','), files })), expected);
    const run = await initialSync();
    assert.deepEqual(run.report.initialSync?.leftOutAtWrite, expected);
    // The repaired link's provenance comes back from the tracked branch's history.
    assert.equal(h.world.linear.uploads.length, before, 'recovery uploaded a file');
    assert.doesNotMatch((await h.documentOf(PLAN)).content!, /uploads\.linear\.app/);
    assert.deepEqual((await h.ids() as Record<string, { plainFiles?: string[] }>)[PLAN]?.plainFiles, [SECRET]);
    // The record keeps the document's provenance unknown: running the recovery again leaves it out again.
    const again = await initialSync({ MDBISYNC_CONFIRM: 'false' });
    assert.deepEqual(again.report.summary?.leftOutFiles.map(({ path, rules, files }) => ({ path, rule: rules.join(','), files })), expected);
    const confirmed = await initialSync();
    assert.deepEqual(confirmed.report.initialSync?.leftOutAtWrite, expected);
    assert.equal(h.world.linear.uploads.length, before, 'a second recovery uploaded the left-out link');
    // Once the link no longer needs provenance (written as an image), the document is written and stays known.
    await h.editRef('refs/heads/main', ITEM, '# Item 0\n\n![Shared data](../../public.csv)\n');
    const fixed = await initialSync();
    assert.deepEqual(fixed.report.initialSync?.leftOutAtWrite, []);
    assert.equal(h.world.linear.uploads.length, before + 1);
    assert.match((await h.documentOf(ITEM)).content!, /uploads\.linear\.app/);
  });

  it('with the ids ref deleted and the document renamed in Linear, so the run creates it anew', async () => {
    await repairedLink();
    const document = await h.documentOf(PLAN);
    document.title = 'Plan renamed';
    await deleteRef('ids');
    const run = await initialSync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.ok(run.report.initialSync?.created.includes(PLAN), JSON.stringify(run.report.initialSync));
    assert.ok(!h.world.linear.uploads.some((upload) => upload.filename === SECRET), 'recovery uploaded the file into the new document');
    assert.doesNotMatch((await h.documentOf(PLAN)).content!, /uploads\.linear\.app/);
  });

  for (const resumed of [false, true]) it(`with the ids ref deleted and the document replaced in Linear by another with its title (resumed ${resumed})`, async () => {
    await repairedLink();
    const original = await h.documentOf(PLAN);
    original.trashed = true;
    original.archivedAt = new Date().toISOString();
    const { archivedAt: _archived, ...kept } = original;
    const replacement = { ...kept, id: 'replacement-plan', trashed: false, content: '# Plan\n\nDraft.\n', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    h.world.linear.documents.push(replacement);
    await deleteRef('ids');
    if (resumed) {
      // A first run stops after writing one document before the plan: its progress commit holds ids again.
      for (const page of ['combined/page-0.md', 'combined/page-1.md']) await h.editRef('refs/heads/main', page, `# ${page}\n\nRevised.\n`);
      const hooks = { MDBISYNC_TEST_HOOKS: '1', MDBISYNC_TEST_HOOKS_DIR: join(h.fixture.root, 'hooks'), MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '1' };
      Object.assign(process.env, hooks);
      try {
        assert.equal((await initialSync()).report.initialSync?.complete, false);
      } finally {
        for (const name of Object.keys(hooks)) delete process.env[name];
      }
    }
    const run = await initialSync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.resumed, resumed);
    assert.ok(run.report.initialSync?.overwritten.includes(PLAN), JSON.stringify(run.report.initialSync));
    assert.ok(!h.world.linear.uploads.some((upload) => upload.filename === SECRET), 'recovery uploaded the file into the replacement');
    assert.doesNotMatch(replacement.content ?? '', /uploads\.linear\.app/);
  });
});
