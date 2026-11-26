import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CREATE_ATTEMPTS, LinearClient, LinearCreateEditedError, LinearGraphQLError, LinearHttpError, LinearNetworkError, LinearStoppedError } from '../../src/linear/index.ts';
import { FakeLinear, type FakeReply, fakeDocument, rateLimited } from './fake-linear.ts';

const id = '22222222-2222-4222-8222-222222222222';
const place = { projectId: 'project-1' };

/** A fake Linear that keeps created documents by id; `answer` decides each create's reply after it was (or was not) applied. */
async function world(t: { after: (callback: () => Promise<void>) => void }, answer: (attempt: number) => { apply: boolean; reply?: FakeReply }) {
  const fake = await new FakeLinear().start();
  t.after(() => fake.stop());
  const documents = new Map<string, Record<string, unknown>>();
  let attempt = 0;
  fake.operations.set('CreateDocument', (request) => {
    attempt += 1;
    const input = request.variables?.input as { id: string; title: string; content: string; projectId?: string };
    const outcome = answer(attempt);
    if (outcome.apply) {
      if (documents.has(input.id)) return { body: { errors: [{ message: 'Entity already exists', extensions: { code: 'INPUT_ERROR' } }], data: null } };
      documents.set(input.id, fakeDocument(input.id, { title: input.title, content: input.content, project: { id: input.projectId } }));
    }
    return outcome.reply ?? { body: { data: { documentCreate: { success: true, document: documents.get(input.id) } } } };
  });
  fake.operations.set('GetDocuments', (request) => {
    const ids = request.variables?.ids as string[];
    return { body: { data: { documents: { nodes: ids.flatMap((one) => documents.get(one) ?? []) } } } };
  });
  const linear = new LinearClient({ token: 'test-token', baseUrl: fake.url, sleep: async () => {} });
  const sent = (operation: string) => fake.received.filter((request) => request.operation === operation);
  return { fake, documents, linear, sent };
}

test('a create applied before its answer was lost is read back by its id, not sent again', async (t) => {
  const { documents, linear, sent } = await world(t, () => ({ apply: true, reply: { reset: true } }));
  const created = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' });
  assert.equal(created.id, id);
  assert.equal(created.content, 'Body');
  assert.equal(documents.size, 1);
  assert.equal(sent('CreateDocument').length, 1);
  assert.equal(sent('GetDocuments').length, 1);
  // The lost create was applied: it counts as this run's write.
  assert.equal(linear.stats.writes.get('CreateDocument'), 1);
});

test('a create lost before Linear applied it is sent again with the same id', async (t) => {
  const { documents, linear, sent } = await world(t, (attempt) => attempt === 1 ? { apply: false, reply: { reset: true } } : { apply: true });
  const created = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' });
  assert.equal(created.id, id);
  assert.equal(documents.size, 1);
  assert.deepEqual(sent('CreateDocument').map((request) => (request.variables?.input as { id: string }).id), [id, id]);
  assert.equal(linear.stats.writes.get('CreateDocument'), 1);
});

test('a create answered with a server error is sent again with the same id', async (t) => {
  const { linear, sent } = await world(t, (attempt) => attempt === 1 ? { apply: false, reply: { status: 502 } } : { apply: true });
  const created = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' });
  assert.equal(created.id, id);
  assert.equal(sent('CreateDocument').length, 2);
});

test('a create still lost after its last try fails with the network error', async (t) => {
  const { documents, linear, sent } = await world(t, () => ({ apply: false, reply: { reset: true } }));
  await assert.rejects(linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), LinearNetworkError);
  assert.equal(documents.size, 0);
  assert.equal(sent('CreateDocument').length, CREATE_ATTEMPTS);
  assert.equal(sent('GetDocuments').length, CREATE_ATTEMPTS);
  assert.equal(linear.stats.writes.get('CreateDocument'), undefined);
});

test('a retry refused because the lost try took the id finds that document', async (t) => {
  const { fake, documents, linear, sent } = await world(t, (attempt) => attempt === 1 ? { apply: true, reply: { reset: true } } : { apply: true });
  // The first read-back does not see the document yet; the retry is refused for its id.
  let reads = 0;
  const read = fake.operations.get('GetDocuments')!;
  fake.operations.set('GetDocuments', (request) => (reads += 1) === 1 ? { body: { data: { documents: { nodes: [] } } } } : read(request));
  const created = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' });
  assert.equal(created.id, id);
  assert.equal(documents.size, 1);
  assert.equal(sent('CreateDocument').length, 2);
  assert.equal(linear.stats.writes.get('CreateDocument'), 1);
});

test('a refusal of the first try is not retried or read back', async (t) => {
  const { linear, sent } = await world(t, () => ({ apply: false, reply: { body: { errors: [{ message: 'Invalid', extensions: { code: 'INPUT_ERROR' } }], data: null } } }));
  await assert.rejects(linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), LinearGraphQLError);
  assert.equal(sent('CreateDocument').length, 1);
  assert.equal(sent('GetDocuments').length, 0);
});

test('a create without its own id is not retried', async (t) => {
  const { linear, sent } = await world(t, () => ({ apply: false, reply: { status: 502 } }));
  await assert.rejects(linear.createDocument(place, { title: 'Plans', content: 'Body' }), LinearHttpError);
  assert.equal(sent('CreateDocument').length, 1);
  assert.equal(sent('GetDocuments').length, 0);
});

test('a document with the id under another title or in another place is not taken as the create', async (t) => {
  for (const other of [{ title: 'Other' }, { project: { id: 'project-2' } }]) {
    const { documents, linear, sent } = await world(t, () => ({ apply: false, reply: { reset: true } }));
    documents.set(id, fakeDocument(id, { title: 'Plans', content: 'Body', ...other }));
    await assert.rejects(linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), LinearNetworkError);
    assert.equal(sent('CreateDocument').length, 1);
    assert.equal(linear.stats.writes.get('CreateDocument'), undefined);
  }
});

test('a stop during the read-back stops the create without another try', async (t) => {
  const { fake, linear, sent } = await world(t, () => ({ apply: false, reply: { reset: true } }));
  fake.operations.set('GetDocuments', () => rateLimited());
  await assert.rejects(linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), LinearStoppedError);
  assert.equal(sent('CreateDocument').length, 1);
});

test('a read-back that fails outside Linear is thrown as it is, not as the create', async (t) => {
  const { fake, linear } = await world(t, () => ({ apply: false, reply: { reset: true } }));
  // A payload the client cannot read is a fault of its own, not a lost create.
  fake.operations.set('GetDocuments', () => ({ body: { data: { documents: { nodes: [null] } } } }));
  await assert.rejects(linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), TypeError);
});

/** A world whose create is applied and its answer lost, and in which the document holds `content` when it is read back. */
async function readBackHolding(t: Parameters<typeof world>[0], content: string) {
  const setup = await world(t, () => ({ apply: true, reply: { reset: true } }));
  const read = setup.fake.operations.get('GetDocuments')!;
  setup.fake.operations.set('GetDocuments', (request) => {
    setup.documents.set(id, fakeDocument(id, { title: 'Plans', content, project: { id: place.projectId } }));
    return read(request);
  });
  return setup;
}

test('a lost create whose document was edited before the read-back is not returned as the create', async (t) => {
  // A person edits the new document between the lost answer and the read.
  const { linear, sent } = await readBackHolding(t, 'Body\n\nTyped in Linear.');
  const error = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' }).then(
    () => assert.fail('the edited document was returned as the create'),
    (rejection: unknown) => rejection,
  );
  assert.ok(error instanceof LinearCreateEditedError);
  assert.equal(error.document.id, id);
  assert.doesNotMatch(error.message, /Typed in Linear/, 'the error names no content');
  assert.equal(sent('CreateDocument').length, 1, 'not sent again: the id is taken');
  // The create was applied: it counts as this run's write.
  assert.equal(linear.stats.writes.get('CreateDocument'), 1);
});

test("a lost create's document holding the content in Linear's own form is the create", async (t) => {
  const exact = await readBackHolding(t, 'Body\n');
  await assert.rejects(exact.linear.createDocument(place, { id, title: 'Plans', content: 'Body' }), LinearCreateEditedError, 'exact equality without sameContent');
  const { linear } = await readBackHolding(t, 'Body\n');
  const sameContent = (stored: string, sent: string) => stored.trimEnd() === sent;
  const created = await linear.createDocument(place, { id, title: 'Plans', content: 'Body' }, { sameContent });
  assert.equal(created.content, 'Body\n');
});
