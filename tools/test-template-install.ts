// Integration check: each workflow template's "Install pre-commit" step, run
// as written on a runner without pre-commit. It must install exactly the
// hash-checked list from PyPI into its own virtual environment and put
// pre-commit 4.6.2 on GITHUB_PATH; a list with a wrong hash must install
// nothing. Requires Python 3.10 to 3.14 with venv support and access to PyPI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const TEMPLATES = ['mdbisync.yml', 'mdbisync-initial-sync.yml', 'pre-commit.yml'];

/** The step's script and the `name==version` pins of its requirements list. */
async function installStep(file: string) {
  const workflow = parse(await readFile(join(root, 'examples', file), 'utf8'));
  const steps = Object.values(workflow.jobs as Record<string, { steps: { name?: string; run?: string }[] }>).flatMap((job) => job.steps);
  const script = steps.find((step) => step.name === 'Install pre-commit')?.run;
  assert.ok(script, `${file}: no Install pre-commit step`);
  const list = /<<'REQUIREMENTS'; then\n([\s\S]*?)\nREQUIREMENTS\n/.exec(script)?.[1];
  assert.ok(list, `${file}: no requirements list`);
  const pins = list.replace(/ \\\n\s*/g, ' ').split('\n').map((line) => {
    const [, pin, below] = /^(\S+==\S+)(?: ; python_version < "(\d+\.\d+)")?/.exec(line) ?? [];
    assert.ok(pin, `${file}: ${line}`);
    return { pin: pin.toLowerCase(), below };
  });
  return { script, pins };
}

const temporary = await mkdtemp(join(tmpdir(), 'template-install-'));
try {
  // Only the commands the step uses: a runner's own pre-commit or pipx stays out of reach.
  const bin = join(temporary, 'bin');
  await mkdir(bin);
  for (const command of ['python3', 'mktemp', 'mkdir', 'ln']) {
    const found = spawnSync('bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(found, `${command} is not on PATH`);
    await symlink(found, join(bin, command));
  }
  const version = spawnSync(join(bin, 'python3'), ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).stdout.trim();
  const older = (a: string, b: string) => a.split('.').map(Number).reduce((order, part, index) => order || part - Number(b.split('.')[index]), 0) < 0;
  const run = async (name: string, script: string) => {
    const home = join(temporary, name);
    await mkdir(home);
    const githubPath = join(home, 'github-path');
    await writeFile(githubPath, '');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      env: { PATH: bin, HOME: home, RUNNER_TEMP: home, GITHUB_PATH: githubPath, PIP_NO_CACHE_DIR: '1' }, encoding: 'utf8',
    });
    return { result, added: (await readFile(githubPath, 'utf8')).trim() };
  };

  for (const file of TEMPLATES) {
    const { script, pins } = await installStep(file);
    const { result, added } = await run(file, script);
    assert.equal(result.status, 0, `${file}\n${result.stdout}${result.stderr}`);
    const preCommit = join(added, 'pre-commit');
    const shown = spawnSync(preCommit, ['--version'], { encoding: 'utf8' });
    assert.equal(shown.stdout, 'pre-commit 4.6.2\n', `${file}: ${shown.stderr}`);
    const python = join(dirname(await readlink(preCommit)), 'python');
    const listed = spawnSync(python, ['-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check', '--exclude', 'pip', '--exclude', 'setuptools'], { encoding: 'utf8' });
    const installed = listed.stdout.trim().split('\n').map((line) => line.toLowerCase().replace(/_/g, '-')).sort();
    const expected = pins.filter(({ below }) => below === undefined || older(version, below)).map(({ pin }) => pin).sort();
    assert.deepEqual(installed, expected, `${file}: the environment holds other packages than the list`);
    console.log(`${file}: installed ${installed.length} hash-checked packages on Python ${version}`);
  }

  // One wrong hash: pip refuses the file, and the step adds nothing to PATH.
  const { script } = await installStep('pre-commit.yml');
  const tampered = script.replace(/^(pre-commit==\S+ --hash=sha256:)[0-9a-f]{64}$/m, `$1${'0'.repeat(64)}`);
  assert.notEqual(tampered, script);
  const { result, added } = await run('tampered', tampered);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /THESE PACKAGES DO NOT MATCH THE HASHES/);
  assert.match(result.stdout, /::error::Could not install pre-commit 4\.6\.2 from its pinned hashes/);
  assert.equal(added, '');
  console.log('pre-commit.yml: a wrong hash installs nothing');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
