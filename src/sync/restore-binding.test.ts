// A document id in the ids state is only as trustworthy as the refs anyone who
// can push holds. Restoring, decorating or commenting on a document must rest on
// Linear placing it in one of the configured places, never on the state alone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdEntry } from '../state/index.ts';
import { type FakeDocument, touch } from '../setup/test-helpers.ts';
import { pullRequestHarness } from './pull-request-test-helpers.ts';

const PATH = 'eng/backend/notes.md';
const NOTICE = '7d0c1e1a-3b2f-4c5d-8e9f-0a1b2c3d4e5f';
const HASH = 'a'.repeat(64);

describe('restores and marks stay inside the configured places', () => {
  const h = pullRequestHarness();

  /** A document in a project no folder names (the sync has no business with it), or in the configured team zone. */
  function outsider(state: 'live' | 'archived' | 'trashed', inside = false): FakeDocument {
    h.world.linear.projects.push({ id: 'project-private', name: 'Private', teamIds: ['team-eng'] });
    const document: FakeDocument = {
      id: 'outside-doc', title: 'Salaries', ...(inside ? { teamId: 'team-eng' } : { projectId: 'project-private' }), createdAt: '2026-01-01T00:00:00Z',
      content: 'Private text that stays as it is.\n', icon: 'Lock', color: '#123456',
      ...(state === 'archived' ? { archivedAt: '2026-01-02T00:00:00Z' } : {}),
      ...(state === 'trashed' ? { trashed: true, archivedAt: '2026-01-02T00:00:00Z' } : {}),
    };
    h.world.linear.documents.push(document);
    touch(document);
    return document;
  }

  /** Replaces the entry of `PATH` in the ids state; `withoutPath` names a commit the entry claims as its release base. */
  async function forge(entry: (id: string) => IdEntry, withoutPath = false): Promise<void> {
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json')) as Record<string, IdEntry>;
    // The document the path had is trashed, so the capture does not take it in again under a new path.
    const original = h.world.linear.documents.find((document) => document.id === ids[PATH]?.id)!;
    original.trashed = true;
    original.archivedAt = '2026-01-03T00:00:00Z';
    touch(original);
    let other: string | undefined;
    if (withoutPath) other = await h.commitFile(await h.rev('refs/mdbisync/linear'), PATH, null);
    ids[PATH] = entry('outside-doc');
    if (other !== undefined) ids[PATH] = { ...ids[PATH]!, releaseBase: other };
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify(ids), 'Edit', other);
  }

  async function assertUntouched(document: FakeDocument, before: FakeDocument, comments: unknown[] = []) {
    for (let run = 0; run < 2; run += 1) {
      const result = await h.sync();
      assert.ok(!(result.report.sync?.restored ?? []).includes(PATH), JSON.stringify(result.report.sync?.restored));
    }
    assert.deepEqual(document, before);
    assert.deepEqual(h.commentsOf(document), comments);
  }

  // The same recorded state restores a document Linear keeps in a configured place: the binding refuses only the outside.
  for (const route of ['a recorded release base', 'an earlier ids version'] as const) {
    it(`restores a trashed document of a configured place through ${route}`, async () => {
      const document = outsider('trashed', true);
      await forge((id) => ({ id }), route === 'a recorded release base');
      if (route === 'an earlier ids version') await h.gitEdit(PATH, '# Notes\n\nFirst paragraph, edited in git.\n');
      const run = await h.sync();
      assert.deepEqual(run.report.sync?.restored, [PATH]);
      assert.ok(!document.trashed);
      assert.match(document.content ?? '', /First paragraph/);
    });
  }

  for (const state of ['live', 'archived', 'trashed'] as const) {
    it(`does not restore a ${state} document outside the places through a recorded release base`, async () => {
      const document = outsider(state);
      await forge((id) => ({ id }), true);
      await assertUntouched(document, structuredClone(document));
    });

    it(`does not restore a ${state} document outside the places that an earlier ids version names`, async () => {
      const document = outsider(state);
      await forge((id) => ({ id }));
      await h.gitEdit(PATH, '# Notes\n\nFirst paragraph, edited in git.\n');
      await assertUntouched(document, structuredClone(document));
    });

    it(`gives no saved decoration back to a ${state} document outside the places`, async () => {
      const document = outsider(state);
      await forge((id) => ({ id, saved: { icon: 'Skull', color: '#000000' } }), true);
      await assertUntouched(document, structuredClone(document));
    });
  }

  it('clears no hold on a document outside the places', async () => {
    const document = outsider('live');
    await forge((id) => ({ id, saved: { icon: 'Skull', color: '#000000', hold: { id: NOTICE, bodyHash: HASH, posted: true } } }));
    await assertUntouched(document, structuredClone(document));
  });

  it('resolves no comment of its own on a document outside the places', async () => {
    const document = outsider('live');
    // A comment the sync's own user wrote there, as when the document was once in a configured place.
    const comment = { documentContentId: `content-${document.id}`, body: 'Changes to this document are on hold.', userId: 'integration-one' };
    h.world.linear.comments.set(NOTICE, comment);
    await forge((id) => ({ id, saved: { icon: 'Skull', color: '#000000', hold: { id: NOTICE, bodyHash: HASH, posted: true } } }));
    await assertUntouched(document, structuredClone(document), [structuredClone(comment)]);
  });

  it('restores a trashed document of the place a changed annotation left, and moves it to the new one', async () => {
    const path = 'eng/notes/plan.md';
    const document = await h.documentOf(path);
    h.world.linear.projects.push({ id: 'project-new', name: 'New', teamIds: ['team-eng'] });
    document.trashed = true;
    document.archivedAt = '2026-01-03T00:00:00Z';
    touch(document);
    await h.gitEdit('eng/notes/README.md', '---\nlinear-project: New\n---\n\n# New\n');
    await h.gitEdit(path, '# Plan\n\nUpdated in git.\n');
    const run = await h.sync();
    assert.ok(run.report.sync?.restored.includes(path), JSON.stringify(run.report.sync));
    assert.ok(!document.trashed);
    assert.equal(document.projectId, 'project-new');
  });

  it('puts no hold mark or comment on a document outside the places', async () => {
    const document = outsider('live');
    await forge((id) => ({ id, suspended: { noticeId: NOTICE, paths: [PATH], checks: ['ci'] } }));
    await assertUntouched(document, structuredClone(document));
  });
});
