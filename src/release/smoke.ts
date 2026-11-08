import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { validateAction, validateHooks } from './package.ts';

export async function smokeRelease(directory: string): Promise<void> {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')) as { version: string };
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
    assert.equal(key in pkg, false, `Release package must omit ${key}`);
  }
  const bins = pkg.bin as Record<string, string>;
  assert.equal(typeof bins.mdbisync, 'string');
  const temporary = await mkdtemp(join(tmpdir(), 'release-smoke-'));
  const env = { PATH: process.env.PATH, HOME: temporary, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' };
  const run = (command: string, args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
    if (result.error) throw result.error;
    return result;
  };
  try {
    const action: unknown = parse(await readFile(join(root, 'action.yml'), 'utf8'));
    const hooks: unknown = parse(await readFile(join(root, '.pre-commit-hooks.yaml'), 'utf8'));
    const [main, post] = validateAction(action);
    validateHooks(hooks);
    const actionRun = run(process.execPath, [join(root, main!)], { INPUT_OPERATION: '__release_smoke__' });
    assert.equal(actionRun.status, 1);
    assert.match(actionRun.stdout + actionRun.stderr, /unknown operation:/);
    const cleanup = run(process.execPath, [join(root, post!)]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    const help = run(process.execPath, [join(root, bins.mdbisync!), '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    const version = run(process.execPath, [join(root, bins.mdbisync!), '--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.version.slice(1));
    const pack = run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--cache', join(temporary, 'cache'), '--pack-destination', temporary]);
    assert.equal(pack.status, 0, pack.stderr);
    const packed = JSON.parse(pack.stdout) as { filename: string }[];
    assert.equal(packed.length, 1);
    // This mirrors pre-commit's one-time local package installation, offline.
    const install = run('npm', ['install', '--global', '--offline', '--ignore-scripts', '--cache', join(temporary, 'cache'), '--prefix', join(temporary, 'prefix'), join(temporary, packed[0]!.filename)]);
    assert.equal(install.status, 0, install.stderr);
    const hookCli = run(join(temporary, 'prefix/bin/mdbisync'), ['--help']);
    assert.equal(hookCli.status, 0, hookCli.stderr);
    assert.match(hookCli.stdout, /Usage:/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: smoke.ts RELEASE_DIRECTORY');
  await smokeRelease(directory);
}
