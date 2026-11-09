import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinearClient } from '../../src/linear/index.ts';
import { FakeLinear } from './fake-linear.ts';

const id = '11111111-1111-4111-8111-111111111111';

async function world(t: { after: (callback: () => Promise<void>) => void }) {
  const fake = await new FakeLinear().start();
  t.after(() => fake.stop());
  const comments = new Map<string, { id: string; documentContentId: string }>();
  fake.operations.set('FindDocumentComment', (request) => {
    const found = comments.get(String(request.variables?.id));
    return { body: { data: { comments: { nodes: found ? [found] : [] } } } };
  });
  fake.operations.set('CommentOnDocument', (request) => {
    const input = request.variables?.input as { id: string; documentContentId: string; body: string };
    assert.equal(input.id, id);
    const comment = { id: input.id, documentContentId: input.documentContentId };
    comments.set(input.id, comment);
    return { body: { data: { commentCreate: { success: true, comment: { id: input.id } } } } };
  });
  const linear = new LinearClient({ token: 'test-token', baseUrl: fake.url });
  return { fake, comments, linear };
}

test('document notices use a caller-supplied id and do not repeat on a later run', async (t) => {
  const { fake, comments, linear } = await world(t);
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: true });
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: false });
  assert.equal(comments.size, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'CommentOnDocument').length, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'FindDocumentComment').length, 2);
});

test('a notice creation with a lost response recovers by its remote id', async (t) => {
  const { fake, comments, linear } = await world(t);
  fake.operations.set('CommentOnDocument', (request) => {
    const input = request.variables?.input as { id: string; documentContentId: string };
    comments.set(input.id, { id: input.id, documentContentId: input.documentContentId });
    return { reset: true };
  });
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: false });
  await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id);
  assert.equal(comments.size, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'CommentOnDocument').length, 1);
});

test('an unconfirmed failed notice can be retried without losing its id', async (t) => {
  const { fake, comments, linear } = await world(t);
  const create = fake.operations.get('CommentOnDocument')!;
  fake.operations.set('CommentOnDocument', () => ({ status: 502 }));
  await assert.rejects(linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id));
  assert.equal(comments.size, 0);
  fake.operations.set('CommentOnDocument', create);
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: true });
});

test('existing comment ids belonging to another document are rejected before writing', async (t) => {
  const { fake, comments, linear } = await world(t);
  comments.set(id, { id, documentContentId: 'other-content' });
  await assert.rejects(linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), /identity does not match/);
  assert.equal(fake.received.filter((request) => request.operation === 'CommentOnDocument').length, 0);
});
