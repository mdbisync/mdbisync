import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLfsPointer } from './index.ts';

const OID = 'a'.repeat(64);
const pointer = (body: string): Buffer => Buffer.from(`version https://git-lfs.github.com/spec/v1\n${body}`);

describe('LFS pointer', () => {
  it('parses a pointer file', () => {
    assert.deepEqual(parseLfsPointer(pointer(`oid sha256:${OID}\nsize 12345\n`)), { oid: OID, size: 12345 });
  });

  it('accepts extension keys', () => {
    assert.deepEqual(parseLfsPointer(pointer(`ext-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 0\n`)), { oid: OID, size: 0 });
  });

  it('returns null for content that is not a pointer', () => {
    assert.equal(parseLfsPointer(Buffer.from('# A document\n')), null);
    assert.equal(parseLfsPointer(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
    assert.equal(parseLfsPointer(pointer(`oid sha256:${OID}\n`)), null, 'no size');
    assert.equal(parseLfsPointer(pointer(`size 3\n`)), null, 'no oid');
    assert.equal(parseLfsPointer(pointer(`oid sha256:${OID}\nsize 3`)), null, 'no final newline');
    assert.equal(parseLfsPointer(pointer(`oid md5:${OID}\nsize 3\n`)), null, 'other hash');
    assert.equal(parseLfsPointer(pointer(`oid sha256:${OID}\nsize 03\n`)), null, 'leading zero');
    const long = pointer(`oid sha256:${OID}\nsize 3\nx-pad ${'p'.repeat(1100)}\n`);
    assert.equal(parseLfsPointer(long), null, 'a pointer is under 1024 bytes');
  });
});
