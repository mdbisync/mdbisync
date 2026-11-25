import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Git } from './git.ts';

const IDENTITY_ENV = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.invalid' };

async function repository(prefix: string): Promise<{ dir: string; git: Git }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const git = new Git(dir);
  await git.run(['init', '--quiet', '--bare']);
  return { dir, git };
}

describe('Long-lived git processes', () => {
  it('answer many reads at once, each with its own object, large ones included', async () => {
    const { dir, git } = await repository('batch-read-');
    try {
      const contents = Array.from({ length: 50 }, (_, index) => index % 10 === 0 ? `${index}\n`.repeat(100000) : `object ${index}\n`);
      const oids = await Promise.all(contents.map((content) => git.objectWriter().blob(Buffer.from(content))));
      for (const [index, oid] of oids.entries()) assert.equal(oid, await git.text(['hash-object', '--stdin'], { input: contents[index] as string }));
      const read = await Promise.all(oids.flatMap((oid) => [git.readObject(oid), git.objectInfo(oid), git.readObject(`${oid}-not-a-name`)]));
      for (const [index, oid] of oids.entries()) {
        const content = Buffer.from(contents[index] as string);
        assert.deepEqual(read[index * 3], { oid, type: 'blob', size: content.length, content });
        assert.deepEqual(read[index * 3 + 1], { oid, type: 'blob', size: content.length });
        assert.equal(read[index * 3 + 2], null);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answer each request at once even when the caller turns off GIT_FLUSH', { timeout: 20_000 }, async () => {
    const { dir } = await repository('batch-flush-');
    try {
      const git = new Git(dir, { GIT_FLUSH: '0' });
      const oid = await git.objectWriter().blob(Buffer.from('flushed\n'));
      assert.equal((await git.readBlob(oid))?.toString(), 'flushed\n');
      assert.match(await git.objectWriter().tree([{ mode: '100644', type: 'blob', oid, name: Buffer.from('file') }]), /^[0-9a-f]{40}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('start again after each pause, however often they end for lack of requests', async () => {
    const { dir, git } = await repository('batch-pause-');
    try {
      for (const text of ['first\n', 'second\n', 'third\n']) {
        const oid = await git.objectWriter().blob(Buffer.from(text));
        assert.equal((await git.readBlob(oid))?.toString(), text);
        // Longer than a process waits for its next request.
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('read a repository made again under the same path, not the one before', async () => {
    const { dir, git } = await repository('batch-again-');
    try {
      const before = await git.objectWriter().blob(Buffer.from('before\n'));
      assert.equal((await git.readBlob(before))?.toString(), 'before\n');
      await rm(dir, { recursive: true, force: true });
      await new Git(tmpdir()).run(['init', '--quiet', '--bare', dir]);
      assert.equal(await git.readObject(before), null);
      const after = await git.objectWriter().blob(Buffer.from('after\n'));
      assert.equal((await git.readBlob(after))?.toString(), 'after\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leave no files behind, and let the program end while they wait', async () => {
    const { dir } = await repository('batch-exit-');
    const temp = await mkdtemp(join(tmpdir(), 'batch-temp-'));
    try {
      const script = `
        import { Git } from ${JSON.stringify(fileURLToPath(new URL('./git.ts', import.meta.url)))};
        const git = new Git(${JSON.stringify(dir)});
        const oid = await git.objectWriter().blob(Buffer.from('x\\n'));
        console.log((await git.readBlob(oid)).toString().trim(), await git.objectWriter().tree([{ mode: '100644', type: 'blob', oid, name: Buffer.from('x') }]));
      `;
      const started = Date.now();
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: temp }, stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const code = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(code, 0);
      assert.match(output, /^x [0-9a-f]{40}\n$/);
      // The processes end a moment after their last answer; the program does not wait for that.
      assert.ok(Date.now() - started < 5000, 'the program waited for the long-lived processes');
      assert.deepEqual(await readdir(temp), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('Long-lived git processes and repository settings', () => {
  it('make written blobs visible at once under batched fsync and a low big-file threshold', async () => {
    const { dir, git } = await repository('batch-settings-');
    try {
      await git.run(['config', 'core.fsyncMethod', 'batch']);
      await git.run(['config', 'core.fsync', 'loose-object']);
      await git.run(['config', 'core.bigFileThreshold', '1k']);
      const large = Buffer.alloc(64 * 1024, 7);
      const oid = await git.objectWriter().blob(large);
      // Another process sees it before the writer ends.
      assert.equal((await git.run(['cat-file', '-s', oid])).stdout.toString().trim(), String(large.length));
      assert.match(await git.objectWriter().tree([{ mode: '100644', type: 'blob', oid, name: Buffer.from('large.bin') }]), /^[0-9a-f]{40}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('write a tree of objects a fetch brought in a new pack after the tree writer started', async () => {
    const { dir, git } = await repository('batch-pack-');
    const other = await repository('batch-pack-source-');
    try {
      const first = await git.objectWriter().blob(Buffer.from('first\n'));
      await git.objectWriter().tree([{ mode: '100644', type: 'blob', oid: first, name: Buffer.from('first') }]);
      const blob = await other.git.text(['hash-object', '-w', '--stdin'], { input: 'fetched\n' });
      const tree = await other.git.text(['mktree'], { input: `100644 blob ${blob}\tfetched\n` });
      const commit = await other.git.text(['commit-tree', tree, '-m', 'fetched'], { env: IDENTITY_ENV });
      await other.git.run(['update-ref', 'refs/heads/main', commit]);
      // Kept as a pack, not unpacked into loose objects.
      await git.run(['-c', 'fetch.unpackLimit=1', 'fetch', '--quiet', other.dir, 'refs/heads/main:refs/heads/fetched']);
      assert.match(await git.objectWriter().tree([{ mode: '100644', type: 'blob', oid: blob, name: Buffer.from('fetched') }]), /^[0-9a-f]{40}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other.dir, { recursive: true, force: true });
    }
  });

  it('fail only the command that cannot start, not the others running at the same time', async () => {
    const { dir, git } = await repository('batch-nul-');
    try {
      const [bad, good] = await Promise.allSettled([git.run(['rev-parse', 'bad\0name']), git.text(['rev-parse', '--git-dir'])]);
      assert.equal(bad.status, 'rejected');
      assert.equal(good.status, 'fulfilled');
      assert.equal(await git.text(['rev-parse', '--is-bare-repository']), 'true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
