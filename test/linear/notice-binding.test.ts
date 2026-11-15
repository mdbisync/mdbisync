import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { LinearClient, type LinearDocument } from '../../src/linear/index.ts';
import { CONFLICT_COMMENT, reconcileDocumentMark, resolveHold } from '../../src/sync/marks.ts';
import { MARKERS } from '../../src/merge/index.ts';
import { FakeLinear } from './fake-linear.ts';

const id = '11111111-1111-4111-8111-111111111111';
const document: LinearDocument = {
  id: 'document-one', documentContentId: 'content-one', title: 'Notes', slugId: 'notes',
  content: 'Resolved text.', icon: 'Alert', color: '#F2994A', projectId: null, teamId: 'team-one',
  trashed: false, archivedAt: null, createdAt: '', updatedAt: '',
};

for (const mismatch of ['document', 'author', 'missing-author', 'missing-document', 'missing-viewer', 'none'] as const) {
  for (const path of ['notice', 'hold-posted', 'hold-pending', 'notice-update', 'notice-repaint'] as const) {
    test(`${path} binds a saved comment to its document and author: ${mismatch}`, async (t) => {
      const fake = await new FakeLinear().start();
      t.after(() => fake.stop());
      const comment = {
        id, documentContentId: mismatch === 'document' ? 'content-other' : 'content-one',
        documentContent: mismatch === 'missing-document' ? null : { document: { id: mismatch === 'document' ? 'document-other' : document.id } },
        user: mismatch === 'missing-author' ? null : { id: mismatch === 'author' ? 'person-other' : 'integration-one' },
      };
      const found = () => ({ body: { data: {
        comments: { nodes: [comment] }, viewer: mismatch === 'missing-viewer' ? null : { id: 'integration-one' },
      } } });
      fake.operations.set('FindComment', found);
      fake.operations.set('FindDocumentComment', found);
      fake.operations.set('ResolveComment', () => ({ body: { data: { commentResolve: { success: true } } } }));
      fake.operations.set('UpdateDocument', () => ({ body: { data: { documentUpdate: { success: true, document } } } }));
      fake.operations.set('UpdateDocumentComment', () => ({ body: { data: { commentUpdate: { success: true, comment: { id } } } } }));
      const linear = new LinearClient({ token: 'test-token', baseUrl: fake.url });
      const receipt = { id, bodyHash: path === 'notice-repaint' ? createHash('sha256').update(CONFLICT_COMMENT).digest('hex') : 'a'.repeat(64), posted: path !== 'hold-pending' };
      const target = path === 'notice-repaint'
        ? { ...document, icon: null, color: null, content: `${MARKERS.git}\n\nFirst\n\n${MARKERS.linear}\n\nSecond\n\n${MARKERS.end}\n` }
        : document;
      const run = () => path.startsWith('hold')
        ? resolveHold(linear, receipt, document.id)
        : reconcileDocumentMark({
          document: target, entry: { id: document.id, saved: { icon: null, color: null, notice: { ...receipt, kind: path === 'notice-update' ? 'blocked' : 'conflict' } } },
          ...(path === 'notice-update' ? { blocked: [{ hook: 'check-key', line: 1 }] } : {}),
          linear, persistEntry: async () => {},
        });
      if (mismatch === 'none') {
        await run();
        const mutation = path === 'notice-update' ? 'UpdateDocumentComment' : path === 'notice-repaint' ? 'UpdateDocument' : 'ResolveComment';
        assert.ok(fake.received.some((r) => r.operation === mutation));
      } else {
        await assert.rejects(run(), /identity does not match/);
        assert.deepEqual(fake.received.filter((r) => !r.operation?.startsWith('Find')), []);
      }
    });
  }
}

for (const invalid of [false, true]) {
  test(`comment ownership batches include every requested id across pages: ${invalid ? 'reject a mismatch' : 'accept owned comments'}`, async (t) => {
    const fake = await new FakeLinear().start();
    t.after(() => fake.stop());
    const expected = new Map(Array.from({ length: 251 }, (_, index) => [`comment-${index}`, `document-${index}`]));
    fake.operations.set('FindComments', (request) => {
      const ids = request.variables?.ids as string[];
      assert.ok(ids.length <= 250);
      assert.equal(request.variables?.first, ids.length);
      return { body: { data: { viewer: { id: 'integration-one' }, comments: { nodes: ids.map((id) => ({
        id, user: { id: invalid && id === 'comment-250' ? 'person-other' : 'integration-one' },
        documentContent: { document: { id: expected.get(id) } },
      })) } } } };
    });
    const linear = new LinearClient({ token: 'test-token', baseUrl: fake.url });
    if (invalid) await assert.rejects(linear.documentCommentIds(expected), /identity does not match/);
    else assert.deepEqual(await linear.documentCommentIds(expected), new Set(expected.keys()));
    assert.deepEqual(fake.received.map((request) => request.operation), ['FindComments', 'FindComments']);
  });
}
