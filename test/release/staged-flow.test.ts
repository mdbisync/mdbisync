import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHooksStep } from './staged-flow.ts';

test('the hooks step runs the expected release bundle with this Node executable', async () => {
  const release = await mkdtemp(join(tmpdir(), 'staged-command-'));
  try {
    await mkdir(join(release, 'dist'));
    const script = join(await realpath(release), 'dist/action-hooks.js');
    await writeFile(script, "console.log('expected hooks');\n");
    assert.deepEqual(await runHooksStep(release, release, {
      MDBISYNC_NODE: process.execPath, MDBISYNC_HOOKS: script,
    }), { status: 0, output: 'expected hooks\n' });
  } finally { await rm(release, { recursive: true, force: true }); }
});

test('stage outputs cannot substitute an executable or hooks script', async () => {
  const release = await mkdtemp(join(tmpdir(), 'staged-command-'));
  try {
    await mkdir(join(release, 'dist'));
    const script = join(await realpath(release), 'dist/action-hooks.js');
    const marker = join(release, 'executed');
    const substitute = join(release, 'substitute.mjs');
    await writeFile(script, "console.log('expected hooks');\n");
    await writeFile(substitute, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`, { mode: 0o755 });
    for (const change of [
      { MDBISYNC_NODE: substitute },
      { MDBISYNC_HOOKS: substitute },
      { MDBISYNC_NODE: '' },
      { MDBISYNC_HOOKS: '' },
      { MDBISYNC_NODE: `${process.execPath} --eval` },
      { MDBISYNC_HOOKS: `${script}; echo unexpected` },
    ]) {
      await assert.rejects(runHooksStep(release, release, {
        MDBISYNC_NODE: process.execPath, MDBISYNC_HOOKS: script, ...change,
      }), /unexpected (?:Node executable|hooks script)/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally { await rm(release, { recursive: true, force: true }); }
});

// Node emits its canonical module path even when checkout is reached through an alias.
test('the hooks step accepts a release directory symlink without trusting stage paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'staged-command-'));
  try {
    const release = join(directory, 'release');
    const alias = join(directory, 'alias');
    await mkdir(join(release, 'dist'), { recursive: true });
    const script = join(await realpath(release), 'dist/action-hooks.js');
    await writeFile(script, "console.log('canonical hooks');\n");
    await symlink(release, alias, 'dir');
    assert.deepEqual(await runHooksStep(alias, alias, {
      MDBISYNC_NODE: process.execPath, MDBISYNC_HOOKS: script,
    }), { status: 0, output: 'canonical hooks\n' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
