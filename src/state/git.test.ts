import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Git } from './git.ts';

const dir = mkdtempSync(join(tmpdir(), 'git-env-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('onlyEnv gives git just that environment and the base settings', async () => {
  const saved = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL };
  process.env.GIT_AUTHOR_NAME = 'From Process';
  process.env.GIT_AUTHOR_EMAIL = 'process@example.com';
  try {
    // The author identity git resolves shows which environment the call got.
    const author = async (git: Git, options = {}) => (await git.text(['var', 'GIT_AUTHOR_IDENT'], options)).replace(/ \d+ [+-]\d{4}$/, '');
    assert.equal(await author(new Git(dir)), 'From Process <process@example.com>');
    const runner = new Git(dir, { GIT_AUTHOR_NAME: 'From Runner', GIT_AUTHOR_EMAIL: 'runner@example.com' });
    assert.equal(await author(runner), 'From Runner <runner@example.com>');
    // A home without configuration: what git reports comes only from the given environment.
    const only = { onlyEnv: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Given', GIT_AUTHOR_EMAIL: 'given@example.com' } };
    assert.equal(await author(runner, only), 'Given <given@example.com>');
    const nameless = { onlyEnv: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_EMAIL: 'given@example.com' } };
    // Without a name git falls back to the system's, or reports none; it never inherits one.
    assert.doesNotMatch(await author(runner, nameless).catch(() => ''), /From (Process|Runner)/);
  } finally {
    for (const [key, value] of [['GIT_AUTHOR_NAME', saved.name], ['GIT_AUTHOR_EMAIL', saved.email]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
