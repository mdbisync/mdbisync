import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinearError, type LinearDocument, type DocumentPatch } from '../linear/index.ts';
import type { IdEntry } from '../state/index.ts';
import { MARKERS } from '../merge/index.ts';
import { CONFLICT_COMMENT, MARKS, noConflictNotices, reconcileDocumentMark, type MarkClient } from './marks.ts';

const conflicted = `${MARKERS.git}\n\nfirst\n\n${MARKERS.linear}\n\nsecond\n\n${MARKERS.end}\n`;

class World implements MarkClient {
  document: LinearDocument = {
    id: 'document-one', title: 'Release notes', slugId: 'release-notes', icon: ':fire:', color: '#123456',
    content: conflicted, documentContentId: 'content-one', projectId: 'project-one', teamId: null,
    trashed: false, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  entry: IdEntry = { id: 'document-one' };
  events: string[] = [];
  comments = new Map<string, string>();
  failSave = false;
  failUpdate = false;
  failComment = false;
  async updateDocument(id: string, patch: DocumentPatch): Promise<LinearDocument> {
    assert.equal(id, this.document.id);
    this.events.push('update');
    if (this.failUpdate) throw new Error('update unavailable');
    this.document = { ...this.document, ...patch } as LinearDocument;
    return this.document;
  }
  async ensureDocumentComment(contentId: string, body: string, id: string) {
    assert.equal(contentId, this.document.documentContentId);
    this.events.push('comment');
    if (this.failComment) throw new Error('comment unavailable');
    const created = !this.comments.has(id);
    this.comments.set(id, body);
    return { id, created };
  }
  resolved: string[] = [];
  async commentExists(id: string) {
    this.events.push('find');
    return this.comments.has(id);
  }
  async resolveComment(id: string) {
    this.events.push('resolve');
    this.resolved.push(id);
  }
  async save(entry: IdEntry) {
    this.events.push('save');
    if (this.failSave) throw new Error('save unavailable');
    this.entry = structuredClone(entry);
  }
  reconcile(blocked?: readonly { hook: string; line: number }[]) {
    return reconcileDocumentMark({
      document: structuredClone(this.document), entry: structuredClone(this.entry), linear: this,
      persistEntry: (entry) => this.save(entry), ...(blocked ? { blocked } : {}),
    });
  }
}

test('L3-14: save the original decoration before showing the orange Alert and comment once', async () => {
  const world = new World();
  const result = await world.reconcile();
  assert.equal(result.state, 'conflict');
  assert.deepEqual(world.events, ['save', 'update', 'comment', 'save']);
  assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, { icon: ':fire:', color: '#123456' });
  assert.equal(world.document.icon, MARKS.conflict.icon);
  assert.equal(world.document.color, MARKS.conflict.color);
  assert.deepEqual([...world.comments.values()], [CONFLICT_COMMENT]);
  assert.equal(world.document.content, conflicted);
  await world.reconcile();
  assert.equal(world.comments.size, 1);
  assert.equal(world.events.filter((event) => event === 'update').length, 1);
});

for (const side of ['Linear', 'Git']) {
  test(`L3-09/10 module hook: observed resolution after a ${side} edit restores the original`, async () => {
    const world = new World();
    await world.reconcile();
    if (side === 'Git') await world.updateDocument(world.document.id, { content: 'Resolved text.\n' });
    else world.document.content = 'Resolved text.\n';
    world.events = [];
    const result = await world.reconcile();
    assert.equal(result.state, 'clear');
    assert.deepEqual(world.events, ['find', 'resolve', 'update', 'save']);
    assert.equal(world.document.icon, ':fire:');
    assert.equal(world.document.color, '#123456');
    assert.deepEqual(world.entry, { id: world.document.id });
    assert.equal(world.document.content, 'Resolved text.\n');
    await world.reconcile();
    assert.deepEqual(world.events, ['find', 'resolve', 'update', 'save']);
  });
}

test('L3-11: edits inside open markers retain the mark and do not duplicate the comment', async () => {
  const world = new World();
  await world.reconcile();
  world.document.content = conflicted.replace('first', 'edited');
  await world.reconcile();
  assert.equal(world.document.icon, 'Alert');
  assert.equal(world.comments.size, 1);
  assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, { icon: ':fire:', color: '#123456' });
});

test('L3-13: each remaining marker keeps the conflict mark', async () => {
  for (const marker of Object.values(MARKERS)) {
    const world = new World();
    await world.reconcile();
    world.document.content = `${marker}\n`;
    await world.reconcile();
    assert.equal(world.document.icon, 'Alert');
    assert.ok(world.entry.saved);
  }
});

test('null icons and colors, including originals equal to a mark, restore exactly', async () => {
  for (const original of [{ icon: null, color: null }, MARKS.conflict, MARKS.blocked, { icon: null, color: '#abcdef' }]) {
    const world = new World();
    Object.assign(world.document, original);
    await world.reconcile();
    assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, original);
    world.document.content = '';
    await world.reconcile();
    assert.equal(world.document.icon, original.icon);
    assert.equal(world.document.color, original.color);
    assert.equal(world.comments.size, 1);
  }
});

test('blocked status takes precedence and shares the original decoration with the conflict mark', async () => {
  const world = new World();
  await world.reconcile();
  await world.reconcile([{ hook: 'check-secret', line: 12 }]);
  assert.equal(world.document.icon, 'Cross');
  assert.equal(world.document.color, MARKS.blocked.color);
  assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, { icon: ':fire:', color: '#123456' });
  assert.ok([...world.comments.values()].some((body) => body.includes('check-secret') && body.includes('12')));
  await world.reconcile();
  assert.equal(world.document.icon, 'Alert');
  assert.equal(world.comments.size, 3);
  world.document.content = 'Resolved.\n';
  await world.reconcile();
  assert.equal(world.document.icon, ':fire:');
  assert.equal(world.entry.saved, undefined);
});

test('failure to save the original decoration prevents any remote changes', async () => {
  const world = new World();
  world.failSave = true;
  await assert.rejects(world.reconcile(), /save unavailable/);
  assert.deepEqual(world.events, ['save']);
  assert.equal(world.document.icon, ':fire:');
});

test('failed mark and failed comment can resume without losing the original', async () => {
  const world = new World();
  world.failUpdate = true;
  await assert.rejects(world.reconcile(), /update unavailable/);
  assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, { icon: ':fire:', color: '#123456' });
  world.failUpdate = false;
  world.failComment = true;
  await assert.rejects(world.reconcile(), /comment unavailable/);
  world.failComment = false;
  await world.reconcile();
  assert.equal(world.comments.size, 1);
  assert.deepEqual({ icon: world.entry.saved?.icon, color: world.entry.saved?.color }, { icon: ':fire:', color: '#123456' });
});

test('failed restore retains the original decoration for the next attempt', async () => {
  const world = new World();
  await world.reconcile();
  world.document.content = 'Resolved.\n';
  world.failUpdate = true;
  await assert.rejects(world.reconcile(), /update unavailable/);
  assert.ok(world.entry.saved);
  world.failUpdate = false;
  await world.reconcile();
  assert.equal(world.document.icon, ':fire:');
  assert.equal(world.entry.saved, undefined);
});

test('lookalike markers in code do not set a mark or emit a comment', async () => {
  const world = new World();
  world.document.content = `~~~md\n${conflicted}~~~\n`;
  await world.reconcile();
  assert.deepEqual(world.events, []);
});

test('L3-24: twenty conflicting documents and one hundred clean documents remain independent', async () => {
  const worlds = Array.from({ length: 120 }, (_, index) => {
    const world = new World();
    world.document.id = `document-${index}`;
    world.document.documentContentId = `content-${index}`;
    world.document.content = index < 20 ? conflicted : `Clean edit ${index}.\n`;
    world.entry = { id: world.document.id };
    return world;
  });
  for (const world of worlds) await world.reconcile();
  assert.equal(worlds.filter((world) => world.document.icon === 'Alert').length, 20);
  assert.equal(worlds.reduce((count, world) => count + world.comments.size, 0), 20);
  for (const world of worlds.slice(20)) assert.deepEqual(world.events, []);
});

test('a failed ids cleanup after restoration resumes without losing the original', async () => {
  const world = new World();
  await world.reconcile();
  world.document.content = 'Resolved.\n';
  world.failSave = true;
  await assert.rejects(world.reconcile(), /save unavailable/);
  assert.equal(world.document.icon, ':fire:');
  assert.ok(world.entry.saved);
  world.failSave = false;
  world.events = [];
  await world.reconcile();
  assert.deepEqual(world.events, ['find', 'resolve', 'save']);
  assert.equal(world.entry.saved, undefined);
});

test('blocked findings are neutral, stable under reordering, and never include matched values', async () => {
  const world = new World();
  world.document.content = 'Clean text.\n';
  const findings = [{ hook: 'check-key', line: 3, matched: 'private-value' }, { hook: 'bad\nprivate-value', line: 4 }];
  await world.reconcile(findings);
  await world.reconcile([...findings].reverse());
  assert.equal(world.comments.size, 1);
  const body = [...world.comments.values()][0]!;
  assert.ok(body.includes('check-key'));
  assert.ok(!body.includes('private-value'));
  assert.ok(!body.includes('bad\n'));
});

test('missing content, identity mismatches, and missing comment targets cannot mutate remote state', async () => {
  for (const scenario of ['content', 'identity', 'comment']) {
    const world = new World();
    if (scenario === 'content') delete world.document.content;
    if (scenario === 'identity') world.entry.id = 'other-document';
    if (scenario === 'comment') world.document.documentContentId = null;
    await assert.rejects(world.reconcile());
    assert.deepEqual(world.events, []);
  }
});

test('trashed or archived documents are left unchanged', async () => {
  for (const scenario of ['trashed', 'archived']) {
    const world = new World();
    if (scenario === 'trashed') world.document.trashed = true;
    else world.document.archivedAt = '2026-01-02T00:00:00Z';
    await world.reconcile();
    assert.deepEqual(world.events, []);
  }
});

test('a new conflict episode gets a new notice after resolution', async () => {
  const world = new World();
  await world.reconcile();
  world.document.content = 'Resolved.\n';
  await world.reconcile();
  world.document.content = conflicted;
  await world.reconcile();
  assert.equal(world.comments.size, 2);
});

test('settled marks need no comment lookup or ids write on repeated runs', async () => {
  const world = new World();
  await world.reconcile();
  world.events = [];
  await world.reconcile();
  assert.deepEqual(world.events, []);
});

test('blocked line shifts update one notice instead of creating stale duplicate notices', async () => {
  const world = new World();
  await world.reconcile([{ hook: 'check-key', line: 12 }]);
  await world.reconcile([{ hook: 'check-key', line: 13 }]);
  assert.equal(world.comments.size, 1);
  assert.ok([...world.comments.values()][0]?.includes('line 13'));
});

test('a deleted settled notice does not make the document fail reconciliation', async () => {
  const world = new World();
  await world.reconcile();
  world.comments.clear();
  world.failComment = true;
  world.events = [];
  await world.reconcile();
  assert.deepEqual(world.events, []);
  assert.equal(world.document.icon, 'Alert');
});

test('a failed posted-receipt save retries the same notice id without duplication', async () => {
  const world = new World();
  const save = world.save.bind(world);
  let writes = 0;
  world.save = async (entry) => {
    if (++writes === 2) throw new Error('receipt unavailable');
    await save(entry);
  };
  await assert.rejects(world.reconcile(), /receipt unavailable/);
  const pendingId = world.entry.saved?.notice?.id;
  assert.ok(pendingId);
  assert.equal(world.entry.saved?.notice?.posted, false);
  assert.equal(world.comments.size, 1);
  await world.reconcile();
  assert.equal(world.entry.saved?.notice?.id, pendingId);
  assert.equal(world.entry.saved?.notice?.posted, true);
  assert.equal(world.comments.size, 1);
});

test('a fetched null body is empty content and clears the mark', async () => {
  const world = new World();
  await world.reconcile();
  world.document.content = null;
  await world.reconcile();
  assert.equal(world.document.icon, ':fire:');
  assert.equal(world.entry.saved, undefined);
});

test('restoration uses the exact saved original decoration', async () => {
  const world = new World();
  await world.reconcile();
  world.document.icon = ':rocket:';
  world.document.color = '#654321';
  world.document.content = 'Resolved.\n';
  await world.reconcile();
  assert.equal(world.document.icon, ':fire:');
  assert.equal(world.document.color, '#123456');
});

test('resolving one of several regions keeps the document marked without another notice', async () => {
  const world = new World();
  world.document.content = `${conflicted}\n${conflicted}`;
  await world.reconcile();
  world.document.content = `Resolved first region.\n\n${conflicted}`;
  world.events = [];
  await world.reconcile();
  assert.equal(world.document.icon, 'Alert');
  assert.equal(world.comments.size, 1);
  assert.deepEqual(world.events, []);
});

test('a released suspension comment is left to the hold step, like a suspended one, while the text is clear', async () => {
  const world = new World();
  world.document.content = 'Plain text.\n';
  world.document.icon = 'Cross';
  world.document.color = '#EB5757';
  const hold = { id: '22222222-2222-4222-8222-222222222222', bodyHash: 'a'.repeat(64), posted: true };
  world.entry = { id: 'document-one', suspended: { noticeId: hold.id, paths: ['notes.md'], checks: ['lint'] }, saved: { icon: ':fire:', color: '#123456', hold } };
  await world.reconcile();
  assert.deepEqual(world.events, []);
  // Released, its comment still to be resolved (the per-run limit, a failed write): the hold step clears and reports it.
  world.entry = { id: 'document-one', saved: { icon: ':fire:', color: '#123456', hold } };
  await world.reconcile();
  assert.deepEqual(world.events, []);
  assert.equal(world.document.icon, 'Cross');
  assert.deepEqual(world.entry.saved, { icon: ':fire:', color: '#123456', hold });
});

test('a conflict mark resolves a released suspension comment before it takes the document', async () => {
  const world = new World();
  const hold = { id: '22222222-2222-4222-8222-222222222222', bodyHash: 'a'.repeat(64), posted: true };
  world.entry = { id: 'document-one', saved: { icon: ':fire:', color: '#123456', hold } };
  await world.reconcile();
  assert.deepEqual(world.resolved, [hold.id]);
  assert.equal(world.document.icon, MARKS.conflict.icon);
  assert.equal(world.entry.saved?.hold, undefined);
  assert.equal(world.entry.saved?.notice?.kind, 'conflict');
  assert.equal(world.entry.saved?.icon, ':fire:');
});

test('a cleared conflict takes over a released suspension comment, so the document gets its own icon back at once', async () => {
  const world = new World();
  world.document.content = 'Plain text.\n';
  world.document.icon = MARKS.conflict.icon;
  world.document.color = MARKS.conflict.color;
  const hold = { id: '22222222-2222-4222-8222-222222222222', bodyHash: 'a'.repeat(64), posted: true };
  const notice = { id: '44444444-4444-4444-8444-444444444444', kind: 'conflict' as const, bodyHash: 'b'.repeat(64), posted: true };
  world.entry = { id: 'document-one', saved: { icon: ':fire:', color: '#123456', hold, notice } };
  await world.reconcile();
  assert.ok(world.resolved.includes(hold.id));
  assert.equal(world.document.icon, ':fire:');
  assert.equal(world.entry.saved, undefined);
});

test('a document marked blocked while suspended keeps its suspension comment', async () => {
  const world = new World();
  world.document.content = 'Plain text.\n';
  const hold = { id: '22222222-2222-4222-8222-222222222222', bodyHash: 'a'.repeat(64), posted: true };
  world.entry = { id: 'document-one', suspended: { noticeId: hold.id, paths: ['notes.md'], checks: ['lint'] }, saved: { icon: ':fire:', color: '#123456', hold } };
  await world.reconcile([{ hook: 'secrets', line: 2 }]);
  assert.equal(world.document.icon, MARKS.blocked.icon);
  assert.deepEqual(world.entry.saved?.hold, hold);
  assert.equal(world.entry.saved?.notice?.kind, 'blocked');
  assert.deepEqual(world.resolved, []);
});

test('a released comment never confirmed posted is looked up and resolved when it exists, as a conflict mark takes over', async () => {
  const world = new World();
  const hold = { id: '33333333-3333-4333-8333-333333333333', bodyHash: 'a'.repeat(64), posted: false };
  world.comments.set(hold.id, 'On hold.');
  world.entry = { id: 'document-one', saved: { icon: ':fire:', color: '#123456', hold } };
  await world.reconcile();
  assert.deepEqual(world.resolved, [hold.id]);
  // One that was never created is only looked up.
  const other = new World();
  other.entry = { id: 'document-one', saved: { icon: ':fire:', color: '#123456', hold } };
  await other.reconcile();
  assert.deepEqual(other.resolved, []);
  assert.ok(other.events.includes('find'));
  assert.equal(other.entry.saved?.hold, undefined);
});

for (const missing of [false, true]) {
  test(`clearing a notice whose resolution fails ${missing ? 'tolerates a deleted comment' : 'retries while the comment exists'}`, async () => {
    const world = new World();
    world.document.content = 'Rejected.\n';
    await world.reconcile([{hook:'check-key', line:1}]);
    if (missing) world.comments.clear();
    world.document.content = 'Corrected.\n';
    world.resolveComment = async () => {throw new LinearError('ResolveComment', 'Unavailable');};
    if (missing) {
      await world.reconcile();
      assert.equal(world.document.icon, ':fire:');
      assert.equal(world.entry.saved, undefined);
    } else {
      await assert.rejects(world.reconcile(), /Unavailable/);
      assert.equal(world.document.icon, 'Cross');
      assert.ok(world.entry.saved?.notice);
    }
  });
}

test('a mark reports the conflict notice it set or resolved, and never a blocked notice', async () => {
  const world = new World();
  const notices = noConflictNotices();
  const reconcile = (blocked?: readonly { hook: string; line: number }[]) => reconcileDocumentMark({
    document: structuredClone(world.document), entry: structuredClone(world.entry), linear: world,
    persistEntry: (entry) => world.save(entry), onConflictNotice: (change) => notices[change].push('notes.md'),
    ...(blocked ? { blocked } : {}),
  });
  // The conflict notice is posted once; the next run finds it posted and reports nothing.
  await reconcile();
  await reconcile();
  assert.deepEqual(notices, { set: ['notes.md'], resolved: [] });
  // A blocked finding replaces it: the conflict notice is resolved, the blocked notice is not a conflict notice.
  await reconcile([{ hook: 'secret-scan', line: 3 }]);
  assert.deepEqual(notices, { set: ['notes.md'], resolved: ['notes.md'] });
  // Cleared from blocked: a blocked notice's resolution is not counted either.
  world.document.content = 'Resolved text.\n';
  assert.equal((await reconcile()).state, 'clear');
  assert.deepEqual(notices, { set: ['notes.md'], resolved: ['notes.md'] });
});

test('a conflict notice posted before a failed save is still reported: its requests were made', async () => {
  const world = new World();
  const notices: string[] = [];
  let saves = 0;
  await assert.rejects(reconcileDocumentMark({
    document: structuredClone(world.document), entry: structuredClone(world.entry), linear: world,
    // The save before the mark succeeds; the save of the posted receipt fails (a lost lease).
    persistEntry: async (entry) => { saves += 1; if (saves > 1) throw new Error('lease lost'); await world.save(entry); },
    onConflictNotice: (change) => notices.push(change),
  }), /lease lost/);
  assert.equal(world.comments.size, 1);
  assert.deepEqual(notices, ['set']);
});
