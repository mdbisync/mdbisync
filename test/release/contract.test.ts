import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { stageRelease, validateAction, validateHooks } from '../../src/release/package.ts';
import { smokeRelease } from '../../src/release/smoke.ts';

const root = resolve(import.meta.dirname, '../..');

test('action and hook metadata prohibit runtime installs', async () => {
  validateAction(parse(await readFile(join(root, 'action.yml'), 'utf8')));
  validateHooks(parse(await readFile(join(root, '.pre-commit-hooks.yaml'), 'utf8')));
});

test('real bundles run from the isolated release tree and install as an offline Node hook', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'release-contract-'));
  try {
    const source = join(temporary, 'source');
    const output = join(temporary, 'release');
    await mkdir(source);
    for (const file of ['src', 'tools', 'package.json', 'package-lock.json', '.npmrc', 'action.yml', '.pre-commit-hooks.yaml', 'LICENSE', 'README.md', 'third-party-licenses.json']) {
      await cp(join(root, file), join(source, file), { recursive: true });
    }
    // Build tools exist only in the source tree, never in the consumer tree.
    await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
    const version = 'v0.1.0-rc.1';
    execFileSync(process.execPath, ['tools/build.ts'], { cwd: source, encoding: 'utf8', env: { ...process.env, MDBISYNC_RELEASE_VERSION: version.slice(1) } });
    const action: unknown = parse(await readFile(join(source, 'action.yml'), 'utf8'));
    const hooks: unknown = parse(await readFile(join(source, '.pre-commit-hooks.yaml'), 'utf8'));
    await stageRelease({ source, output, sourceSha: 'a'.repeat(40), version, action, hooks });
    await smokeRelease(output);
    assert.match(await readFile(join(output, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'), /@actions\/core [0-9.]+\nLicense: MIT/);
    assert.equal(await readFile(join(source, 'package.json'), 'utf8'), await readFile(join(root, 'package.json'), 'utf8'));
    await assert.rejects(readFile(join(output, 'package-lock.json')), /ENOENT/);
    await assert.rejects(readFile(join(output, 'node_modules/package.json')), /ENOENT/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
