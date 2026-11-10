import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Git, missingLfsObjects, parseLfsPointer } from './index.ts';
import { type FakeLfsServer, type Fixture, countLocalLfsObjects, createFixture, fakeLfsServer } from './test-helpers.ts';

const OID = 'a'.repeat(64);
const pointer = (body: string): Buffer => Buffer.from(`version https://git-lfs.github.com/spec/v1\n${body}`);

describe('LFS pointer', () => {
  it('parses a pointer file', () => {
    assert.deepEqual(parseLfsPointer(pointer(`oid sha256:${OID}\nsize 12345\n`)), { oid: OID, size: 12345, extensions: false });
  });

  it('accepts extension keys', () => {
    assert.deepEqual(parseLfsPointer(pointer(`ext-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 0\n`)), { oid: OID, size: 0, extensions: true });
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

describe('LFS objects missing from the remote', () => {
  const HELD = Buffer.from('an object the server holds\n');
  const LOCAL = Buffer.from('an object already in the local store\n');
  const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');
  const pointerOf = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
  const GONE = 'cd'.repeat(32);
  const ALSO_GONE = 'ce'.repeat(32);
  const TREE = {
    'held.bin': pointerOf(sha(HELD), HELD.length),
    'gone.bin': pointerOf(GONE, 42),
    'also gone, [1].bin': pointerOf(ALSO_GONE, 7),
    'local.bin': pointerOf(sha(LOCAL), LOCAL.length),
  };

  let fixture: Fixture;
  let server: FakeLfsServer;
  let clone: Git;
  /** Blob ids of the pointer files, by path. */
  const blobs = new Map<string, string>();
  before(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    server = await fakeLfsServer([HELD, LOCAL]);
    clone = await fixture.clone('work');
    await clone.run(['config', 'lfs.url', server.url]);
    for (const path of Object.keys(TREE)) blobs.set(path, await clone.text(['rev-parse', `origin/main:${path}`]));
    // An object already downloaded: nobody needs to ask the server about it.
    const local = join(clone.dir, '.git', 'lfs', 'objects', sha(LOCAL).slice(0, 2), sha(LOCAL).slice(2, 4));
    await mkdir(local, { recursive: true });
    await writeFile(join(local, sha(LOCAL)), LOCAL);
  });
  after(async () => {
    await server.close();
    await fixture.cleanup();
  });

  const ask = (paths: string[]) => missingLfsObjects(clone, 'origin', paths.map((path) => blobs.get(path) as string));

  it('names the objects the server does not have, asking only about the given pointers and downloading nothing', async () => {
    server.requests.length = 0;
    const missing = await ask(['held.bin', 'gone.bin', 'also gone, [1].bin', 'local.bin', 'gone.bin']);
    assert.deepEqual([...missing].sort(), [GONE, ALSO_GONE]);
    assert.deepEqual(server.requests, ['POST /info/lfs/objects/batch'], 'only the batch API is asked');
    assert.equal(await countLocalLfsObjects(clone), 1, 'an object was downloaded');
  });

  it('asks nothing when no pointer is given or all are in the local store', async () => {
    server.requests.length = 0;
    assert.deepEqual(await ask([]), new Set());
    assert.deepEqual(await ask(['local.bin']), new Set());
    assert.deepEqual(server.requests, []);
  });

  it('names no object when the server refuses the whole request', async () => {
    server.failBatch = 500;
    try {
      assert.deepEqual(await ask(['gone.bin', 'held.bin']), new Set());
    } finally {
      delete server.failBatch;
    }
  });

  it('names no object for a remote without a batch API (a local path)', async () => {
    const plain = await fixture.clone('plain');
    assert.deepEqual(await missingLfsObjects(plain, 'origin', [blobs.get('gone.bin') as string]), new Set());
    assert.equal(await countLocalLfsObjects(plain), 0);
  });
});
