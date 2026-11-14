import assert from 'node:assert/strict';
import { it } from 'node:test';
import { writeFileSync } from 'node:fs';
import { ContentSpool, contentBytes } from './content.ts';

it('bounds temporary storage, detects changed bytes, and cleans up', () => {
  const spool = new ContentSpool(4, 2);
  try {
    const file = spool.put(Buffer.from('test'));
    assert.deepEqual(contentBytes(file), Buffer.from('test'));
    assert.throws(() => spool.put(Buffer.from('x')), /budget/);
    writeFileSync(file.file, 'edit');
    assert.throws(() => contentBytes(file), /changed/);
    spool.close();
    assert.throws(() => contentBytes(file), /ENOENT/);
  } finally { spool.close(); }
});
