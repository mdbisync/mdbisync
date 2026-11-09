import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitIds, commitTree, readIds, type IdEntry } from '../state/index.ts';
import { createFixture, IDENTITY } from '../state/test-helpers.ts';

const receipt = { id: '11111111-1111-4111-8111-111111111111', kind: 'conflict' as const, bodyHash: 'a'.repeat(64), posted: false };

test('pending and posted notice receipts survive ids commits and fresh reads', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const ids = new Map<string, IdEntry>([['notes.md', { id: 'document-one', saved: { icon: ':fire:', color: '#123456', notice: { ...receipt } } }]]);
  const pending = await commitIds(fixture.remote, null, ids, IDENTITY);
  assert.deepEqual(await readIds(fixture.remote, pending), ids);
  ids.get('notes.md')!.saved!.notice!.posted = true;
  const posted = await commitIds(fixture.remote, pending, ids, IDENTITY);
  assert.deepEqual(await readIds(fixture.remote, posted), ids);
  ids.set('notes.md', { id: 'document-one' });
  const clear = await commitIds(fixture.remote, posted, ids, IDENTITY);
  assert.deepEqual(await readIds(fixture.remote, clear), ids);
});

test('malformed notice receipts fail closed when ids are read', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  for (const invalid of [{ ...receipt, id: 'invalid' }, { ...receipt, posted: 'yes' }, { ...receipt, kind: 'other' }, { ...receipt, bodyHash: 'invalid' }]) {
    const data = { 'notes.md': { id: 'document-one', saved: { icon: null, color: null, notice: invalid } } };
    const commit = await commitTree(fixture.remote, { parents: [], base: null, changes: new Map([['ids.json', JSON.stringify(data)]]), message: 'Invalid receipt fixture', identity: IDENTITY });
    await assert.rejects(readIds(fixture.remote, commit), /invalid entry/);
  }
});
