import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git } from '../../../src/state/index.ts';
import { compatibleHookNpm, HOOK_NPM_VERSION, provisionHookNpm } from './hook-npm.ts';
import { EnvBlockedError } from './results.ts';
import { commitStaged, hookEnv, installHooks, repositoryHookEnv } from './sandbox.ts';

const roots: string[] = [];
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-npm-'));
  roots.push(dir);
  return dir;
}
function executable(file: string, source: string): void {
  writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}
function fixture(version = '11.12.1', failure = false) {
  const root = fresh();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls.jsonl');
  executable(join(bin, 'npm'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, env:process.env, cwd:process.cwd()})+'\\n');
    if (${failure}) { console.error('bootstrap failed with confidential output'); process.exit(1); }
    const dir = args[args.indexOf('--prefix')+1];
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, {recursive:true});
    fs.writeFileSync(path.join(bin, 'npm'), ${JSON.stringify(`#!${process.execPath}\nconsole.log('${HOOK_NPM_VERSION}');\n`)}, {mode:0o755});
  `);
  const from = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_TOKEN: 'github-token-value', npm_config_registry: 'https://invalid.test/', LINEAR_TEST_APP_CLIENT_SECRET: 'app-secret-value' };
  return { root, bin, calls, from, env: hookEnv(from), dir: join(root, 'run', 'hook-npm') };
}

describe('per-run npm for repository hooks', () => {
  it('accepts stable versions at the minimum and newer, and rejects older or unparseable versions', () => {
    for (const version of ['11.16.0', '11.16.1', '11.17.0', '12.0.0', ' 11.16.0\n']) assert.equal(compatibleHookNpm(version), true, version);
    for (const version of ['11.12.1', '11.15.99', '10.99.0', '', 'unknown', '11.16', '11.16.0-beta.1', 'v11.16.0']) assert.equal(compatibleHookNpm(version), false, version);
  });

  it('uses a compatible host npm without creating or changing any tool folder', async () => {
    const f = fixture('12.0.0');
    assert.deepEqual(await provisionHookNpm(f.dir, f.env), f.env);
    assert.equal(existsSync(f.dir), false);
    assert.equal(existsSync(f.calls), false);
  });

  it('provisions the pinned npm once per run with scripts disabled and no inherited credentials', async () => {
    const f = fixture();
    const first = await provisionHookNpm(f.dir, f.env);
    assert.equal(execFileSync('npm', ['--version'], { env: first, encoding: 'utf8' }).trim(), HOOK_NPM_VERSION);
    assert.deepEqual(await provisionHookNpm(f.dir, f.env), first);
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.args[0], 'ci');
    for (const arg of ['--ignore-scripts', '--no-audit', '--no-fund']) assert.ok(call.args.includes(arg));
    for (const [flag, value] of [['--prefix', f.dir], ['--cache', join(f.dir, 'cache')], ['--registry', 'https://registry.npmjs.org/']]) {
      assert.equal(call.args[call.args.indexOf(flag) + 1], value);
    }
    for (const flag of ['--userconfig', '--globalconfig']) assert.equal(readFileSync(call.args[call.args.indexOf(flag) + 1], 'utf8'), '');
    assert.notEqual(call.args[call.args.indexOf('--userconfig') + 1], call.args[call.args.indexOf('--globalconfig') + 1]);
    assert.equal(call.cwd, f.dir);
    for (const key of ['GITHUB_TOKEN', 'LINEAR_TEST_APP_CLIENT_SECRET', 'npm_config_registry']) assert.equal(call.env[key], undefined);
    const lock = JSON.parse(readFileSync(join(f.dir, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[''].dependencies.npm, HOOK_NPM_VERSION);
    assert.equal(lock.packages['node_modules/npm'].version, HOOK_NPM_VERSION);
    assert.match(lock.packages['node_modules/npm'].integrity, /^sha512-/);
    const other = await provisionHookNpm(join(f.root, 'other-run', 'hook-npm'), f.env);
    assert.notEqual(other.PATH, first.PATH);
    assert.equal(f.from.PATH, f.env.PATH);
  });

  it('replaces an unparseable npm version and reports failed provisioning as env-blocked without bootstrap output', async () => {
    const f = fixture('unparseable');
    assert.notEqual((await provisionHookNpm(f.dir, f.env)).PATH, f.env.PATH);
    const failed = fixture('11.12.1', true);
    await assert.rejects(provisionHookNpm(failed.dir, failed.env), (error: unknown) => {
      assert.ok(error instanceof EnvBlockedError);
      assert.match(error.message, /need npm 11\.16\.0 or newer; per-run npm provisioning failed/);
      assert.doesNotMatch(error.message, /confidential|hook-npm-/);
      return true;
    });
  });

  it('keeps missing npm env-blocked and propagates cancellation', async () => {
    const dir = fresh();
    await assert.rejects(provisionHookNpm(join(dir, 'tools'), { PATH: dir }), EnvBlockedError);
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provisionHookNpm(f.dir, f.env, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(existsSync(f.calls), false);
  });

  it('uses the provisioned npm for hook installation and a later verified commit', async () => {
    const f = fixture();
    const repo = join(f.root, 'run', 'person');
    mkdirSync(repo, { recursive: true });
    const git = new Git(repo, { GIT_AUTHOR_NAME: 'Test Editor', GIT_AUTHOR_EMAIL: 'editor@example.com', GIT_COMMITTER_NAME: 'Test Editor', GIT_COMMITTER_EMAIL: 'editor@example.com' });
    await git.run(['init', '--quiet']);
    await git.run(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Starting tree']);
    writeFileSync(join(repo, '.pre-commit-config.yaml'), `repos:\n  - repo: https://example.com/hooks\n    rev: ${'a'.repeat(40)}\n    hooks:\n      - id: format\n`);
    executable(join(f.bin, 'pre-commit'), `
      const fs = require('node:fs');
      const {execFileSync} = require('node:child_process');
      fs.writeFileSync('installer-version', execFileSync('npm',['--version']));
      fs.writeFileSync('.git/hooks/pre-commit', ${JSON.stringify(`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('commit-version',require('node:child_process').execFileSync('npm',['--version']));fs.writeFileSync('commit-env',JSON.stringify(process.env));\n`)}, {mode:0o755});
    `);
    await installHooks(git, { from: f.from, npmDir: f.dir });
    assert.equal(readFileSync(join(repo, 'installer-version'), 'utf8').trim(), HOOK_NPM_VERSION);
    writeFileSync(join(repo, 'page.md'), '# Plan');
    await git.run(['add', 'page.md']);
    const saved = process.env.PATH;
    process.env.PATH = f.from.PATH;
    try {
      assert.ok(repositoryHookEnv(repo).PATH?.startsWith(join(f.dir, 'node_modules', '.bin')));
      await commitStaged(git, ['page.md'], 'Add page', true);
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
    assert.equal(readFileSync(join(repo, 'commit-version'), 'utf8').trim(), HOOK_NPM_VERSION);
    const env = JSON.parse(readFileSync(join(repo, 'commit-env'), 'utf8'));
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.LINEAR_TEST_APP_CLIENT_SECRET, undefined);
  });
});
