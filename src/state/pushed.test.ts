import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushedKey } from './pushed.ts';

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

  it('refuses a record without its signature, for another head, branch or repository, or under another secret', () => {
    const record = key.record(ref, head);
    assert.equal(key.verified(ref, undefined), undefined);
    assert.equal(key.verified(ref, { head }), undefined);
    assert.equal(key.verified(ref, { head: 'b'.repeat(40), mac: record.mac }), undefined);
    assert.equal(key.verified('refs/heads/mdbisync/suspended', record), undefined);
    assert.equal(new PushedKey('secret', 'owner/other').verified(ref, record), undefined);
    assert.equal(new PushedKey('another secret', 'owner/repo').verified(ref, record), undefined);
    assert.equal(key.verified(ref, { head, mac: `${record.mac.slice(0, 63)}${record.mac.endsWith('0') ? '1' : '0'}` }), undefined);
    assert.equal(key.verified(ref, { head, mac: 'not hex' }), undefined);
  });

  it('keeps the secret out of its serialized form', () => {
    assert.equal(JSON.stringify(key), '{}');
  });
});
