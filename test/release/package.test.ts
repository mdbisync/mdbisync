import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReleaseCommit, releasePackage, stageRelease, validateAction, validateHooks, validateVersion } from '../../src/release/package.ts';

const action = { runs: { using: 'node24', main: 'dist/action.cjs', post: 'dist/post.cjs', 'post-if': 'always()' } };

test('release version must be an explicit semantic pre-release', () => {
  assert.equal(validateVersion('v0.1.0-rc.1'), '0.1.0-rc.1');
  for (const value of ['v1.0.0', '1.0.0-rc.1', 'v01.0.0-rc.1', 'v1.0.0-01', 'v1.0.0-rc/1', '--help', 'v1.0.0-rc.1\n']) {
    assert.throws(() => validateVersion(value), /pre-release/);
  }
});

test('release package retains only the bundled executable contract', () => {
  assert.deepEqual(releasePackage({ name: 'mdbisync', bin: { mdbisync: 'dist/cli.cjs' }, dependencies: { example: '1.0.0' }, scripts: { prepare: 'npm install' } }, 'v0.1.0-rc.1'), {
    name: 'mdbisync', version: '0.1.0-rc.1', private: true, type: 'module',
    engines: { node: '>=24' }, bin: { mdbisync: 'dist/cli.cjs' },
  });
  assert.throws(() => releasePackage({ name: 'mdbisync', bin: { mdbisync: '../cli.js' } }, 'v0.1.0-rc.1'), /bundle/);
});

test('action must run local bundled JavaScript with a post entry and no steps', () => {
  assert.deepEqual(validateAction(action), ['dist/action.cjs', 'dist/post.cjs']);
  for (const runs of [
    { using: 'composite', steps: [{ run: 'npm ci' }] },
    { ...action.runs, steps: [{ run: 'pip install example' }] },
    { ...action.runs, main: '../action.cjs' },
    { ...action.runs, main: 'dist/install.sh' },
    { using: 'node24', main: 'dist/action.cjs' },
    { ...action.runs, 'post-if': 'success()' },
  ]) assert.throws(() => validateAction({ runs }));
});

test('hooks cannot add registry dependencies or shell installation steps', () => {
  validateHooks([{ id: 'linear-format', language: 'node', entry: 'mdbisync lint' }]);
  for (const hook of [
    { language: 'system', entry: 'npm install' },
    { language: 'node', entry: 'npx mdbisync lint' },
    { language: 'node', entry: 'mdbisync lint', additional_dependencies: ['example'] },
  ]) assert.throws(() => validateHooks([hook]));
});

test('release tree is self-contained and its tagged commit does not change main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const source = join(root, 'source');
    const output = join(root, 'release');
    await mkdir(join(source, 'dist'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    await writeFile(join(source, 'README.md'), '# Example\n');
    await writeFile(join(source, 'LICENSE'), 'Example license\n');
    await writeFile(join(source, 'action.yml'), 'runs:\n  using: node24\n');
    await writeFile(join(source, '.pre-commit-hooks.yaml'), '- id: linear-format\n');
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'mdbisync', bin: { mdbisync: 'dist/cli.cjs' } }));
    await writeFile(join(source, 'dist/action.cjs'), 'console.log("action")');
    await writeFile(join(source, 'dist/post.cjs'), 'console.log("post")');
    await writeFile(join(source, 'dist/cli.cjs'), '#!/usr/bin/env node\nconsole.log("cli")');
    await writeFile(join(source, 'dist/action.cjs.LEGAL.txt'), 'Bundled licenses\n');
    await writeFile(join(source, 'dist/unexpected.cjs'), 'throw new Error("not a release file")');
    git('add', '.');
    git('commit', '-m', 'Create source fixture');
    const parent = git('rev-parse', 'HEAD');
    const options = { source, output, version: 'v0.1.0-rc.1', sourceSha: parent, action };
    await stageRelease(options);
    const manifest = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
    assert.equal(manifest.source, parent);
    assert.match(manifest.bundles['dist/cli.cjs'], /^[a-f0-9]{64}$/);
    const release = await createReleaseCommit({ repository: source, directory: output, sourceSha: parent, version: options.version });
    assert.equal(git('rev-parse', 'main'), parent);
    assert.equal(git('rev-parse', `${release}^`), parent);
    assert.equal(git('show', `${release}:release.json`), (await readFile(join(output, 'release.json'), 'utf8')).trim());
    assert.equal(git('ls-tree', '-r', '--name-only', release).includes('unexpected.cjs'), false);
    git('tag', '-a', options.version, release, '-m', options.version);
    assert.equal(git('rev-parse', `${options.version}^{commit}`), release);
    assert.equal(execFileSync(process.execPath, [join(output, 'dist/cli.cjs')], { encoding: 'utf8' }).trim(), 'cli');
    await assert.rejects(stageRelease({ ...options, sourceSha: 'bad' }), /SHA/);
    await rm(join(source, 'dist/post.cjs'));
    await assert.rejects(stageRelease({ ...options, output: join(root, 'missing') }), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
