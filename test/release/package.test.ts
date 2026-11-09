import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tagRelease } from '../../src/release/tag.ts';
import { RELEASE_BUNDLES } from '../../src/release/bundles.ts';
import { createReleaseCommit, releasePackage, stageRelease, validateAction, validateHooks, validateVersion, verifyReleaseDirectory } from '../../src/release/package.ts';

const action = { runs: { using: 'node24', main: 'dist/action-main.js', post: 'dist/action-post.js', 'post-if': 'always()' } };

test('release version must be an explicit semantic pre-release', () => {
  assert.equal(validateVersion('v0.1.0-rc.1'), '0.1.0-rc.1');
  for (const value of ['v1.0.0', '1.0.0-rc.1', 'v01.0.0-rc.1', 'v1.0.0-01', 'v1.0.0-rc/1', '--help', 'v1.0.0-rc.1\n', 'v1.0.0-rc.1\r']) {
    assert.throws(() => validateVersion(value), /pre-release/);
  }
});

test('release package retains only the bundled executable contract', () => {
  assert.deepEqual(releasePackage({ name: 'mdbisync', type: 'module', engines: { node: '>=24.5' }, bin: { mdbisync: 'dist/cli.cjs' }, dependencies: { example: '1.0.0' }, scripts: { prepare: 'npm install' } }, 'v0.1.0-rc.1'), {
    name: 'mdbisync', version: '0.1.0-rc.1', private: true, type: 'module',
    engines: { node: '>=24.5' }, bin: { mdbisync: 'dist/cli.cjs' },
  });
  assert.throws(() => releasePackage({ name: 'mdbisync', type: 'module', engines: { node: '>=24.2' }, bin: { mdbisync: '../cli.js' } }, 'v0.1.0-rc.1'), /bundle/);
});

test('action must run local bundled JavaScript with a post entry and no steps', () => {
  assert.deepEqual(validateAction(action), ['dist/action-main.js', 'dist/action-post.js']);
  for (const runs of [
    { using: 'composite', steps: [{ run: 'npm ci' }] },
    { ...action.runs, steps: [{ run: 'pip install example' }] },
    { ...action.runs, main: '../action.cjs' },
    { ...action.runs, main: 'dist/install.sh' },
    { using: 'node24', main: 'dist/action-main.js' },
    { ...action.runs, 'post-if': 'success()' },
  ]) assert.throws(() => validateAction({ runs }));
});

test('hooks cannot add registry dependencies or shell installation steps', () => {
  validateHooks([{ id: 'linear-format', language: 'node', language_version: 'system', entry: 'mdbisync lint' }]);
  for (const hook of [
    { language: 'system', entry: 'npm install' },
    { language: 'node', language_version: '24.15.0', entry: 'mdbisync lint' },
    { language: 'node', entry: 'npx mdbisync lint' },
    { language: 'node', language_version: 'system', entry: 'mdbisync lint', additional_dependencies: ['example'] },
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
    git('config', 'user.email', 'release@example.com');
    await writeFile(join(source, 'README.md'), '# Example\n');
    await writeFile(join(source, 'LICENSE'), 'Example license\n');
    await writeFile(join(source, 'action.yml'), 'runs:\n  using: node24\n');
    await writeFile(join(source, '.pre-commit-hooks.yaml'), '- id: linear-format\n');
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'mdbisync', type: 'module', engines: { node: '>=24.2' }, bin: { mdbisync: 'dist/cli.js' } }));
    await writeFile(join(source, 'dist/action-main.js'), 'console.log("action")');
    await writeFile(join(source, 'dist/action-post.js'), 'console.log("post")');
    await writeFile(join(source, 'dist/action-hooks.js'), 'console.log("hooks")');
    await writeFile(join(source, 'dist/cli.js'), '#!/usr/bin/env node\nconsole.log("cli")');
    await writeFile(join(source, 'dist/action-main.js.LEGAL.txt'), 'Bundled licenses\n');
    await writeFile(join(source, 'dist/THIRD_PARTY_NOTICES.txt'), 'Third-party notices\n');
    await writeFile(join(source, 'dist/unexpected.cjs'), 'throw new Error("not a release file")');
    git('add', '.');
    git('commit', '-m', 'Create source fixture');
    const parent = git('rev-parse', 'HEAD');
    const options = { source, output, version: 'v0.1.0-rc.1', sourceSha: parent, action, hooks: [{ language: 'node', language_version: 'system', entry: 'mdbisync lint' }] };
    await stageRelease(options);
    const manifest = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
    assert.equal(manifest.source, parent);
    assert.match(manifest.files['dist/cli.js'], /^[a-f0-9]{64}$/);
    // The hooks bundle ships although only another bundle names it.
    assert.match(manifest.files['dist/action-hooks.js'], /^[a-f0-9]{64}$/);
    assert.match(manifest.files['dist/action-main.js.LEGAL.txt'], /^[a-f0-9]{64}$/);
    assert.match(manifest.files['dist/THIRD_PARTY_NOTICES.txt'], /^[a-f0-9]{64}$/);
    await verifyReleaseDirectory(output, parent, options.version);
    await writeFile(join(output, 'dist/cli.js'), 'changed');
    await assert.rejects(verifyReleaseDirectory(output, parent, options.version), /checksum/);
    await writeFile(join(output, 'dist/cli.js'), await readFile(join(source, 'dist/cli.js')));
    await writeFile(join(output, 'extra.txt'), 'unexpected');
    await assert.rejects(verifyReleaseDirectory(output, parent, options.version), /Unexpected/);
    await rm(join(output, 'extra.txt'));
    const release = await createReleaseCommit({ repository: source, directory: output, sourceSha: parent, version: options.version });
    assert.equal(git('rev-parse', 'main'), parent);
    assert.equal(git('rev-parse', `${release}^`), parent);
    assert.equal(git('show', `${release}:release.json`), (await readFile(join(output, 'release.json'), 'utf8')).trim());
    assert.equal(git('ls-tree', '-r', '--name-only', release).includes('unexpected.cjs'), false);
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    git('remote', 'add', 'origin', remote);
    git('push', '--set-upstream', 'origin', 'main');
    const tagged = await tagRelease(parent, options.version, output, source);
    assert.equal(git('rev-parse', `${options.version}^{commit}`), tagged);
    // The documented update resolves the peeled annotated tag, never main.
    const resolved = git('ls-remote', remote, `refs/tags/${options.version}^{}`).split(/\s+/)[0]!;
    assert.equal(resolved, tagged);
    assert.notEqual(resolved, parent);
    const consumer = join(root, 'consumer');
    execFileSync('git', ['clone', '--no-checkout', remote, consumer], { stdio: 'pipe' });
    execFileSync('git', ['-C', consumer, 'checkout', '--detach', resolved], { stdio: 'pipe' });
    assert.equal(execFileSync(process.execPath, [join(consumer, 'dist/cli.js')], { encoding: 'utf8' }).trim(), 'cli');
    assert.equal(git('rev-parse', 'main'), parent);
    await assert.rejects(tagRelease(parent, options.version, output, source), /already exists/);
    assert.equal(execFileSync(process.execPath, [join(output, 'dist/cli.js')], { encoding: 'utf8' }).trim(), 'cli');
    await assert.rejects(stageRelease({ ...options, sourceSha: 'bad' }), /SHA/);
    await rm(join(source, 'dist/THIRD_PARTY_NOTICES.txt'));
    await assert.rejects(stageRelease({ ...options, output: join(root, 'no-notices') }), /Missing release file: dist\/THIRD_PARTY_NOTICES\.txt/);
    await writeFile(join(source, 'dist/THIRD_PARTY_NOTICES.txt'), 'Third-party notices\n');
    // An entry that action.yml or package.json names must be a bundle the build declares.
    await assert.rejects(stageRelease({ ...options, output: join(root, 'undeclared'), action: { runs: { ...action.runs, main: 'dist/other.js' } } }), /not a declared bundle: dist\/other\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the build declares the bundles the action runs, and a release without any one of them is refused', async () => {
  assert.deepEqual(RELEASE_BUNDLES, ['dist/action-hooks.js', 'dist/action-main.js', 'dist/action-post.js', 'dist/cli.js']);
  const root = await mkdtemp(join(tmpdir(), 'release-bundles-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'dist'), { recursive: true });
    for (const file of ['README.md', 'LICENSE', 'action.yml', '.pre-commit-hooks.yaml', 'dist/THIRD_PARTY_NOTICES.txt']) await writeFile(join(source, file), `${file}\n`);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'mdbisync', type: 'module', engines: { node: '>=24.2' }, bin: { mdbisync: 'dist/cli.js' } }));
    for (const bundle of RELEASE_BUNDLES) await writeFile(join(source, bundle), `console.log(${JSON.stringify(bundle)})`);
    const sourceSha = 'a'.repeat(40);
    const version = 'v0.1.0-rc.1';
    const options = { source, sourceSha, version, action, hooks: [{ language: 'node', language_version: 'system', entry: 'mdbisync lint' }] };
    const complete = join(root, 'complete');
    await stageRelease({ ...options, output: complete });
    await verifyReleaseDirectory(complete, sourceSha, version);
    for (const bundle of RELEASE_BUNDLES) {
      const name = bundle.slice('dist/'.length);
      // The build left it out: staging refuses before writing any output.
      await rename(join(source, bundle), join(root, name));
      await assert.rejects(stageRelease({ ...options, output: join(root, `without-${name}`) }), new RegExp(`Missing release file: ${bundle}`));
      await assert.rejects(readdir(join(root, `without-${name}`)), /ENOENT/);
      await rename(join(root, name), join(source, bundle));
      // A tree and manifest that both lack it (staged by an older release step) are refused before tagging.
      const partial = join(root, `partial-${name}`);
      await cp(complete, partial, { recursive: true });
      await rm(join(partial, bundle));
      const manifest = JSON.parse(await readFile(join(partial, 'release.json'), 'utf8')) as { files: Record<string, string> };
      delete manifest.files[bundle];
      await writeFile(join(partial, 'release.json'), JSON.stringify(manifest));
      await assert.rejects(verifyReleaseDirectory(partial, sourceSha, version), new RegExp(`Missing release file: ${bundle}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
