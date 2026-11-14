import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Git } from './git.ts';
import { checkRepoPath, isGitDirectoryName } from './objects.ts';

// Names that open the Git directory on Windows: `.git` itself, its 8.3 short
// name `GIT~1` (and the later short names a busy folder hands out), in any
// case, with the trailing dots and spaces Windows drops from a name, with an
// NTFS stream suffix after a colon, and with code points HFS+ ignores.
const aliases = ['.git', '.GIT', '.git.', '.git .', 'git~1', 'GIT~1', 'Git~1. ', 'git~2', 'GIT~9', 'git~10', '.git:x', '.git::$INDEX_ALLOCATION', 'git~1:x', 'GIT~1 .:x', 'GIT~1:x y', 'git~1:\n', '.g‌it', '﻿.GIT', '.gi⁪t'];
// Near misses that name ordinary files.
const ordinary = ['git', 'git~', 'git~a', 'git~1x', 'git~1.md', '.git~1', '.gitignore', '.github', 'x.git', 'git1', '.git.md', 'a.git~1'];

describe('Git directory names', () => {
  it('recognizes .git and its NTFS short names', () => {
    for (const name of aliases) assert.equal(isGitDirectoryName(name), true, name);
    for (const name of ordinary) assert.equal(isGitDirectoryName(name), false, name);
  });

  it('rejects repository paths with a Git directory part anywhere', () => {
    for (const name of aliases) {
      for (const path of [name, `${name}/hooks/post-checkout`, `docs/${name}/config`, `docs/${name}`]) {
        assert.throws(() => checkRepoPath(path), /invalid repository path/, path);
      }
    }
    for (const name of ordinary) checkRepoPath(`docs/${name}/page.md`);
  });

  it('rejects every path Git itself refuses under core.protectNTFS and core.protectHFS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-path-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet']);
      const blob = await git.text(['hash-object', '-w', '--stdin'], { input: 'x\n' });
      const refused: string[] = [];
      for (const name of [...aliases, ...ordinary]) {
        const path = `docs/${name}/page.md`;
        const added = await git.run(['-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { okCodes: [0, 128] });
        if (added.code === 0) continue;
        refused.push(name);
        assert.throws(() => checkRepoPath(path), /invalid repository path/, `Git refuses ${path}`);
      }
      // The check above proves something only while Git really applies both protections.
      for (const name of ['.git', 'GIT~1', '.git:x', '.g‌it']) assert.ok(refused.includes(name), `Git accepted ${JSON.stringify(name)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
