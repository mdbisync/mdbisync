import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PushedKey } from './pushed.ts';
import { commitIds, readSyncPushed, readWrittenMacs } from './state.ts';
import { commitTree } from './objects.ts';
import { type Fixture, IDENTITY, createFixture } from './test-helpers.ts';

describe('state: signed records of the sync\'s own pushes', () => {
  const head = 'a'.repeat(40);
  const ref = 'refs/heads/mdbisync/linear';
  const key = new PushedKey('secret', 'Owner/Repo');

  it('takes a record it signed for the same branch and repository', () => {
    const record = key.record(ref, head);
    assert.match(record.mac, /^[0-9a-f]{64}$/);
    assert.equal(key.verified(ref, record), head);
    // GitHub compares repository names without case.
    assert.equal(new PushedKey('secret', 'owner/repo').verified(ref, record), head);
  });

  it('signs an initial sync\'s write receipt for its path, document, text and observed digest only', () => {
    const [path, id, hash, digest] = ['docs/plan.md', 'doc-1', 'b'.repeat(64), 'c'.repeat(64)];
    const mac = key.writtenMac(path, id, hash, digest);
    assert.match(mac, /^[0-9a-f]{64}$/);
    assert.equal(key.verifiesWritten(path, id, hash, digest, mac), true);
    assert.equal(key.verifiesWritten(path, id, hash, digest, undefined), false);
    assert.equal(key.verifiesWritten('docs/other.md', id, hash, digest, mac), false);
    assert.equal(key.verifiesWritten(path, 'doc-2', hash, digest, mac), false);
    assert.equal(key.verifiesWritten(path, id, 'd'.repeat(64), digest, mac), false);
    assert.equal(key.verifiesWritten(path, id, hash, 'e'.repeat(64), mac), false);
    assert.equal(new PushedKey('secret', 'owner/other').verifiesWritten(path, id, hash, digest, mac), false);
    assert.equal(new PushedKey('another secret', 'owner/repo').verifiesWritten(path, id, hash, digest, mac), false);
    assert.equal(key.verifiesWritten(path, id, hash, digest, mac.toUpperCase()), false);
  });

  it('binds capture checkpoints to their message, commit and repository', () => {
    const parents = ['b'.repeat(40)];
    const text = 'Capture document ids';
    const mac = key.idsTrailersMac(head, parents, text);
    assert.equal(key.verifiesIdsTrailers(head, parents, text, mac), true);
    assert.equal(key.verifiesIdsTrailers(head, parents, 'Record document ids', mac), false);
    assert.equal(key.verifiesIdsTrailers('c'.repeat(40), parents, text, mac), false);
    assert.equal(key.verifiesIdsTrailers(head, [], text, mac), false);
    assert.equal(key.verifiesObservation(head, parents, text, mac), false);
    assert.equal(key.verifiesIdsTrailers(head, parents, text, key.observationMac(head, parents, text)), false);
    assert.equal(new PushedKey('secret', 'owner/other').verifiesIdsTrailers(head, parents, text, mac), false);
  });

  it('refuses a record without its signature, for another head, branch or repository, or under another secret', () => {
    const record = key.record(ref, head);
    assert.equal(key.verified(ref, undefined), undefined);
    assert.equal(key.verified(ref, { head }), undefined);
    assert.equal(key.verified(ref, { head: 'b'.repeat(40), mac: record.mac }), undefined);
    assert.equal(key.verified('refs/heads/mdbisync/suspended', record), undefined);
    assert.equal(new PushedKey('secret', 'owner/other').verified(ref, record), undefined);
    assert.equal(new PushedKey('another secret', 'owner/repo').verified(ref, record), undefined);
    assert.equal(key.verified(ref, { head, mac: `${record.mac.slice(0, 63)}${record.mac.endsWith('0') ? '1' : '0'}` }), undefined);
    assert.equal(key.verified(ref, { head, mac: record.mac.toUpperCase() }), undefined);
    assert.equal(key.verified(ref, { head, mac: 'not hex' }), undefined);
  });

  it('keeps the secret out of its serialized form', () => {
    assert.equal(JSON.stringify(key), '{}');
  });

  describe('in the state', () => {
    let fixture: Fixture;
    before(async () => { fixture = await createFixture(); });
    after(() => fixture.cleanup());
    const stored = (text: string) => commitTree(fixture.remote, { parents: [], base: null, changes: new Map([['sync-pushed.json', text]]), message: 'Record', identity: IDENTITY });

    it('reads a record as written and keeps it as it is when the ids change', async () => {
      const record = key.record(ref, head);
      const signed = await commitIds(fixture.remote, null, new Map(), IDENTITY, { syncPushed: record });
      assert.deepEqual(await readSyncPushed(fixture.remote, signed), record);
      const next = await commitIds(fixture.remote, signed, new Map([['docs/a.md', { id: 'doc-a' }]]), IDENTITY);
      assert.deepEqual(await readSyncPushed(fixture.remote, next), record);
    });

    it('reads a signature in any other form as none, so the record counts as none', async () => {
      for (const mac of ['ABC', 'F'.repeat(64), 42]) {
        const record = await readSyncPushed(fixture.remote, await stored(JSON.stringify({ head, mac })));
        assert.deepEqual(record, { head });
        assert.equal(key.verified(ref, record), undefined);
      }
      assert.deepEqual(await readSyncPushed(fixture.remote, await stored(JSON.stringify({ head }))), { head });
    });

    it('reads write receipt signatures in any other form as none, so a resume only compares those documents', async () => {
      const mac = key.writtenMac('docs/a.md', 'doc-a', 'b'.repeat(64), 'c'.repeat(64));
      const macs = (text: string) => commitTree(fixture.remote, { parents: [], base: null, changes: new Map([['written-macs.json', text]]), message: 'Progress', identity: IDENTITY })
        .then((commit) => readWrittenMacs(fixture.remote, commit));
      assert.deepEqual(await macs(JSON.stringify({ 'docs/a.md': mac, 'docs/b.md': '', 'docs/c.md': 42, 'docs/d.md': mac.toUpperCase() })), new Map([['docs/a.md', mac]]));
      for (const text of ['not json', '[]', 'null', '"text"']) assert.deepEqual(await macs(text), new Map());
      const written = await commitIds(fixture.remote, null, new Map([['docs/a.md', { id: 'doc-a' }]]), IDENTITY, { written: new Map([['docs/a.md', 'b'.repeat(64)]]), writtenMacs: new Map([['docs/a.md', mac]]) });
      assert.deepEqual(await readWrittenMacs(fixture.remote, written), new Map([['docs/a.md', mac]]));
      assert.deepEqual(await readWrittenMacs(fixture.remote, null), new Map());
    });
  });
});
