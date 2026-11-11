import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { stageRelease, validateAction, validateHooks } from '../../src/release/package.ts';
import { writeSbom } from '../../src/release/sbom.ts';
import { smokeRelease } from '../../src/release/smoke.ts';
import { smokeStagedFlow } from './staged-flow.ts';

const root = resolve(import.meta.dirname, '../..');

test('CI and release install the same pinned pre-commit before tests', async () => {
  const versions: string[] = [];
  for (const [file, job] of [['ci.yml', 'test'], ['ci.yml', 'validate'], ['release.yml', 'build']] as const) {
    const workflow = parse(await readFile(join(root, '.github/workflows', file), 'utf8'));
    assert.ok(workflow.jobs?.[job], `${file} must contain the ${job} job`);
    const steps = workflow.jobs[job].steps as { run?: string }[];
    const installs = steps.flatMap((step, index) => {
      const match = step.run?.trim().match(/^pipx install pre-commit==(\d+\.\d+\.\d+)$/);
      return match ? [{ version: match[1]!, index }] : [];
    });
    assert.equal(installs.length, 1, `${file} must install exactly one pinned pre-commit`);
    const tests = steps.flatMap((step, index) => /\b(?:npm (?:test|run test:hooks)|node --test)\b/.test(step.run ?? '') ? [index] : []);
    assert.ok(tests.length > 0, `${file} must run tests`);
    assert.ok(tests.every(index => installs[0]!.index < index), `${file} must install pre-commit before tests`);
    versions.push(installs[0]!.version);
  }
  assert.equal(new Set(versions).size, 1, 'CI and release pre-commit versions must match');
});

test('action and hook metadata prohibit runtime installs', async () => {
  validateAction(parse(await readFile(join(root, 'action.yml'), 'utf8')));
  validateHooks(parse(await readFile(join(root, '.pre-commit-hooks.yaml'), 'utf8')));
});

test('real bundles run from the isolated release tree, install as an offline Node hook and run the templates\' staged steps', { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'release-contract-'));
  try {
    const source = join(temporary, 'source');
    // Exercise action main, hooks and post with a literal shell-looking path.
    const output = join(temporary, "release ' \" ; $(touch executed) #");
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
    // The SBOM a final release writes from the same tree lists exactly the bundled packages of the inventory.
    const sbomFile = join(temporary, 'sbom.spdx.json');
    await writeSbom({ repository: 'owner/name', sourceSha: 'a'.repeat(40), version, source, directory: output, output: sbomFile });
    await assert.rejects(writeSbom({ repository: 'owner/name', sourceSha: 'b'.repeat(40), version, source, directory: output, output: `${sbomFile}.other` }),
      /provenance does not match/, 'the SBOM describes only the tree staged for the requested source');
    const sbom = JSON.parse(await readFile(sbomFile, 'utf8')) as { packages: { name: string; versionInfo: string }[] };
    const inventory = JSON.parse(await readFile(join(source, 'third-party-licenses.json'), 'utf8')) as { name: string; version: string }[];
    assert.deepEqual(sbom.packages.slice(1).map((pkg) => `${pkg.name}@${pkg.versionInfo}`), inventory.map((pkg) => `${pkg.name}@${pkg.version}`));
    assert.ok(sbom.packages.some((pkg) => pkg.name === '@actions/core'));
    await smokeRelease(output);
    await smokeStagedFlow(output);
    await assert.rejects(readFile(join(temporary, 'executed')), { code: 'ENOENT' });
    assert.match(await readFile(join(output, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'), /@actions\/core [0-9.]+\nLicense: MIT/);
    assert.equal(await readFile(join(source, 'package.json'), 'utf8'), await readFile(join(root, 'package.json'), 'utf8'));
    await assert.rejects(readFile(join(output, 'package-lock.json')), /ENOENT/);
    await assert.rejects(readFile(join(output, 'node_modules/package.json')), /ENOENT/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// A command-line bundle with working `fix` and `lint` commands for the smoke
// test's pages, except for one defect that the smoke test must refuse.
type Defect = 'stub' | 'rewrites-unfixable' | 'refuses-linear-form';
function fakeCli(defect: Defect): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const defect = ${JSON.stringify(defect)};
const [command, file] = process.argv.slice(2);
const fixedForm = '# Notes\\n\\n* first item';
if (command === '--help') console.log('Usage: mdbisync <command> [paths...]');
else if (command === '--version') console.log('0.1.0-rc.1');
else if (defect === 'stub') { console.error(command + ': not implemented'); process.exitCode = command === 'fix' ? 13 : 12; }
else {
  const text = readFileSync(file, 'utf8');
  if (text.includes('[^1]')) {
    if (defect === 'rewrites-unfixable' && command === 'fix') writeFileSync(file, text.trimEnd());
    console.log(file + ':1: footnote: Footnotes are dropped.');
    process.exitCode = 1;
  } else if (text !== fixedForm || defect === 'refuses-linear-form') {
    if (command === 'fix') { writeFileSync(file, fixedForm); console.log(file + ': fixed'); }
    else console.log(file + ": not in Linear's form; run fix");
    process.exitCode = 1;
  }
}
`;
}

for (const [defect, description, refusal] of [
  ['stub', 'commands are stubs', /mdbisync (?:fix|lint) is a stub/],
  ['rewrites-unfixable', 'rewrites a page it cannot fix', /changed a page it cannot fix/],
  ['refuses-linear-form', "refuses a page in Linear's form", /on a page in Linear's form/],
] as const) {
  test(`the release smoke refuses a release whose hook ${description}`, { timeout: 30_000 }, async () => {
    const release = await mkdtemp(join(tmpdir(), 'release-defect-'));
    try {
      await mkdir(join(release, 'dist'));
      await copyFile(join(root, '.pre-commit-hooks.yaml'), join(release, '.pre-commit-hooks.yaml'));
      await writeFile(join(release, 'action.yml'), 'runs:\n  using: node24\n  main: dist/action-main.js\n  post: dist/action-post.js\n  post-if: always()\n');
      await writeFile(join(release, 'dist/action-main.js'), 'console.error("unknown operation: smoke"); process.exitCode = 1;\n');
      await writeFile(join(release, 'dist/action-post.js'), '');
      await writeFile(join(release, 'dist/cli.js'), fakeCli(defect), { mode: 0o755 });
      await writeFile(join(release, 'package.json'), JSON.stringify({
        name: 'mdbisync', version: '0.1.0-rc.1', private: true, type: 'module', engines: { node: '>=24.2' }, bin: { mdbisync: 'dist/cli.js' },
      }));
      await writeFile(join(release, 'release.json'), JSON.stringify({ version: 'v0.1.0-rc.1' }));
      await assert.rejects(smokeRelease(release), refusal);
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  });
}
