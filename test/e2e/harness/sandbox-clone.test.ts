import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Git } from '../../../src/state/index.ts';
import { runNames } from './isolation.ts';
import { Sandbox } from './sandbox.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

// The cache is a blob:none partial clone of main. A run branch whose file is a
// near copy of a file on main can be stored on the server as a delta against
// main's blob. A clone that offered main as already present (a reference to
// the cache) got that delta in a thin pack, without the base the cache never
// downloaded, and failed with "pack has unresolved deltas".
test('a run branch clones when the server stores its blob as a delta against a blob the partial cache lacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-clone-'));
  try {
    const remote = join(root, 'sandbox.git');
    await new Git(root).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await new Git(remote).run(['config', 'uploadpack.allowFilter', 'true']);
    const seed = new Git(join(root, 'seed'), IDENTITY);
    await new Git(root).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    const lines = Array.from({ length: 3000 }, (_, index) => `Line ${index}: ${((index * 7919) % 104729).toString(36)}\n`);
    writeFileSync(join(seed.dir, 'notes.md'), lines.join(''));
    await seed.run(['add', '--all']);
    await seed.run(['commit', '--quiet', '-m', 'Corpus']);
    await seed.run(['push', '--quiet', remote, 'main']);

    // A file:// URL, so the cache really is a partial clone, as it is against GitHub.
    const sandbox = new Sandbox({ url: `file://${remote}`, token: 'unused', stateDir: join(root, 'state'), runId: '5b2e0d' });
    await sandbox.refreshCache();
    assert.equal((await sandbox.cache.text(['config', '--get', 'remote.origin.partialclonefilter'])).trim(), 'blob:none');

    const names = runNames('5b2e0d');
    const text = lines.slice(0, 2900).join('');
    const blob = (await sandbox.cache.text(['hash-object', '-w', '--stdin'], { input: text })).trim();
    const tree = (await sandbox.cache.text(['mktree'], { input: `100644 blob ${blob}\tnotes.md\n` })).trim();
    const commit = (await sandbox.cache.text(['commit-tree', tree, '-m', 'Starting tree'])).trim();
    await sandbox.cache.run(['push', '--quiet', '--no-verify', sandbox.url, `${commit}:refs/heads/${names.trackedBranch}`]);
    // Repacking stores the smaller run blob as a delta against main's blob, as GitHub may.
    await new Git(remote).run(['repack', '-a', '-d', '-f', '--quiet']);
    const base = (await new Git(remote).text(['rev-parse', 'main:notes.md'])).trim();
    const stored = await new Git(remote).text(['cat-file', '--batch-check=%(objectname) %(deltabase)'], { input: `${blob}\n` });
    assert.equal(stored.trim(), `${blob} ${base}`, 'the run blob is stored as a delta against main\'s blob');

    const clone = await sandbox.clone(names, join(root, 'engine'));
    assert.equal(readFileSync(join(clone.dir, 'notes.md'), 'utf8'), text);
    assert.equal((await clone.text(['rev-parse', 'HEAD'])).trim(), commit);
    // The clone stands alone: nothing borrows objects from the partial cache.
    assert.equal(existsSync(join(clone.dir, '.git', 'objects', 'info', 'alternates')), false);
    await clone.run(['fsck', '--no-progress', '--connectivity-only']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
