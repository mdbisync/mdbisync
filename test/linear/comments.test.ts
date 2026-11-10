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
  // The create whose answer was lost was applied: it is this run's write.
  assert.equal(linear.stats.writes.get('CommentOnDocument'), 1);
  await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id);
  assert.equal(comments.size, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'CommentOnDocument').length, 1);
  assert.equal(linear.stats.writes.get('CommentOnDocument'), 1);
});

test('a notice another caller created first is found, and the refused create is not counted as a write', async (t) => {
  const { fake, comments, linear } = await world(t);
  // Both callers looked before either created; the other caller's create won, so Linear refuses this one.
  fake.operations.set('CommentOnDocument', (request) => {
    const input = request.variables?.input as { id: string; documentContentId: string };
    comments.set(input.id, { id: input.id, documentContentId: input.documentContentId });
    return { body: { errors: [{ message: 'ID already exists', extensions: { code: 'INPUT_ERROR' } }], data: null } };
  });
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: false });
  assert.equal(linear.stats.writes.get('CommentOnDocument'), undefined);
});

test('a create Linear answers with success: false is not counted when the other caller\'s notice is found', async (t) => {
  const { fake, comments, linear } = await world(t);
  fake.operations.set('CommentOnDocument', (request) => {
    const input = request.variables?.input as { id: string; documentContentId: string };
    comments.set(input.id, { id: input.id, documentContentId: input.documentContentId });
    return { body: { data: { commentCreate: { success: false, comment: null } } } };
  });
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), { id, created: false });
  assert.equal(linear.stats.writes.get('CommentOnDocument'), undefined);
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

test('a mismatched creation response is not hidden by a later lookup', async (t) => {
  const { fake, comments, linear } = await world(t);
  fake.operations.set('CommentOnDocument', () => {
    comments.set(id, { id, documentContentId: 'content-one' });
    return { body: { data: { commentCreate: { success: true, comment: { id: 'other-id' } } } } };
  });
  await assert.rejects(linear.ensureDocumentComment('content-one', 'Resolve the conflicting text.', id), /identity does not match/);
});

test('changed notice text updates the existing comment instead of creating another', async (t) => {
  const { fake, linear } = await world(t);
  fake.operations.set('UpdateDocumentComment', (request) => {
    assert.equal(request.variables?.id, id);
    assert.deepEqual(request.variables?.input, { body: 'Hook check-key, line 13.' });
    return { body: { data: { commentUpdate: { success: true, comment: { id } } } } };
  });
  await linear.ensureDocumentComment('content-one', 'Hook check-key, line 12.', id);
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Hook check-key, line 13.', id, true), { id, created: false });
  assert.equal(fake.received.filter((request) => request.operation === 'CommentOnDocument').length, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'UpdateDocumentComment').length, 1);
});

test('a fresh notice is created without a lookup, and a refused duplicate id is found and updated', async (t) => {
  const { fake, comments, linear } = await world(t);
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'On hold.', id, true, true), { id, created: true });
  assert.equal(fake.received.filter((request) => request.operation === 'FindDocumentComment').length, 0);
  // Linear's answer to an id it already holds, measured on 2026-11-10.
  fake.operations.set('CommentOnDocument', () => ({ body: { errors: [{ message: 'conflict on insert of Comment', extensions: { code: 'INPUT_ERROR' } }], data: null } }));
  fake.operations.set('UpdateDocumentComment', () => ({ body: { data: { commentUpdate: { success: true, comment: { id } } } } }));
  assert.deepEqual(await linear.ensureDocumentComment('content-one', 'Still on hold.', id, true, true), { id, created: false });
  assert.equal(comments.size, 1);
  assert.equal(fake.received.filter((request) => request.operation === 'UpdateDocumentComment').length, 1);
  assert.equal(linear.stats.writes.get('CommentOnDocument'), 1);
});

test('resolving a comment sends commentResolve with its id and counts one write', async (t) => {
  const { fake, linear } = await world(t);
  fake.operations.set('ResolveComment', (request) => {
    assert.equal(request.variables?.id, id);
    return { body: { data: { commentResolve: { success: true } } } };
  });
  await linear.resolveComment(id);
  assert.equal(linear.stats.writes.get('ResolveComment'), 1);
  fake.operations.set('ResolveComment', () => ({ body: { data: { commentResolve: { success: false } } } }));
  await assert.rejects(linear.resolveComment(id));
});
