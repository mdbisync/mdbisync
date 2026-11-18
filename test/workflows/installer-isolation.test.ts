// The checkout is the repository's content: anything a merged pull request
// adds, or anything on a branch a writer dispatches on. The sync workflows
// later hold the App token and the Linear secrets in the same job, so no
// step before them may run code from the checkout. The pre-commit install
// step runs Python, which puts the current directory first on its module
// path unless it runs in isolated mode: a root `venv/` or `pip/` package
// would then stand in for the standard module. Each workflow `init` writes
// therefore runs Python isolated (-I) from the runner's temporary directory,
// and the sync workflows run on main only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import templates from '../../src/init/workflows.json' with { type: 'json' };

interface Step { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

const generated = Object.entries(templates as Record<string, string>).map(([file, text]) => [file, parse(text) as Workflow] as const);
const INSTALL_STEP = 'Install pre-commit';
const GUARD_STEP = 'Refuse a branch other than main';
/** The workflows whose jobs hold the App token and the Linear secrets. */
const PRIVILEGED = ['mdbisync.yml', 'mdbisync-initial-sync.yml'];

const installScript = (workflow: Workflow) => {
  const found = Object.values(workflow.jobs).flatMap((job) => job.steps).filter((step) => step.name === INSTALL_STEP);
  assert.equal(found.length, 1);
  return found[0]!.run!;
};

function bash(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  // The runner's own command line for a `run` step.
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  return result;
}

describe('workflows written by init', () => {
  it('cover every template the installer appears in', () => {
    assert.deepEqual(generated.map(([file]) => file).sort(), ['mdbisync-initial-sync.yml', 'mdbisync.yml', 'pre-commit.yml']);
  });

  for (const [file, workflow] of generated) {
    it(`${file}: every Python call is isolated and runs from the runner's temporary directory`, () => {
      const lines = installScript(workflow).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
      // The first command leaves the checkout ($GITHUB_WORKSPACE, the step's default directory).
      assert.equal(lines[0], 'cd "$RUNNER_TEMP"');
      assert.doesNotMatch(lines.slice(1).join('\n'), /\bcd\b|pushd|GITHUB_WORKSPACE/);
      // Every call of Python, except the lookup of the command itself.
      const calls = lines.flatMap((line) => [...line.matchAll(/(?<!command -v )(?:\bpython3|"\$environment\/bin\/python")(?=\s)(\s+\S+)?/g)]);
      assert.ok(calls.length >= 4, `${file}: the version check, version report, venv and pip calls`);
      for (const call of calls) assert.equal(call[1]?.trim(), '-I', `${file}: ${call[0]}`);
    });

    it(`${file}: every Python call in any step is isolated`, () => {
      const scripts = Object.values(workflow.jobs).flatMap((job) => job.steps).flatMap((step) => (step.run === undefined ? [] : [step.run]));
      const lines = scripts.flatMap((script) => script.split('\n')).map((line) => line.trim()).filter((line) => !line.startsWith('#'));
      // Python by name, the installed environment's, or the interpreter pre-commit runs on; never the command lookup.
      const calls = lines.flatMap((line) => [...line.matchAll(/(?<!command -v )(?:\bpython3|"\$environment\/bin\/python"|"\$\{python_command\[@\]\}")(?=\s)(\s+\S+)?/g)]);
      assert.ok(calls.length >= 4, file);
      for (const call of calls) assert.equal(call[1]?.trim(), '-I', `${file}: ${call[0]}`);
    });
  }

  for (const file of PRIVILEGED) {
    it(`${file}: refuses a run on any branch but main before any step gets a token or a secret`, () => {
      const workflow = generated.find(([name]) => name === file)![1];
      for (const job of Object.values(workflow.jobs)) {
        const [guard, ...rest] = job.steps;
        assert.equal(guard?.name, GUARD_STEP);
        assert.equal(guard?.if, "github.ref != 'refs/heads/main'");
        assert.equal(guard?.uses, undefined);
        assert.doesNotMatch(JSON.stringify(guard), /secrets\.|token/);
        assert.ok(rest.some((step) => /secrets\./.test(JSON.stringify(step))));
        const root = mkdtempSync(join(tmpdir(), 'ref-guard-'));
        try {
          const result = bash(guard!.run!, root, { PATH: '/usr/bin:/bin', GITHUB_REF: 'refs/heads/feature' });
          assert.equal(result.status, 1);
          assert.equal(result.stdout, '::error::Run this workflow on main, not on refs/heads/feature.\n');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }

  // Real Python, with `venv/` and `pip/` packages at the checkout's root
  // that would leave a mark when imported. Python's venv module is real; the
  // environment is made without pip (no network, no ensurepip needed), so
  // `-m pip` there finds the checkout's `pip/` only when the checkout is on
  // the module path, and otherwise fails as an install failure.
  // The interpreter itself, not a version manager's shim, which would need a PATH the step does not have.
  const found = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable); print(int((3, 11) <= sys.version_info[:2] <= (3, 14)))'], { encoding: 'utf8' });
  const [realPython = '', supported] = found.status === 0 ? found.stdout.trim().split('\n') : [];
  const skip = realPython === '' ? 'no python3' : supported !== '1' && 'python3 is outside the 3.11 to 3.14 the step accepts';
  for (const [file, workflow] of generated) {
    it(`${file}: checkout packages named venv and pip never run`, { skip }, () => {
      const root = mkdtempSync(join(tmpdir(), 'installer-canary-'));
      try {
        const checkout = join(root, 'checkout');
        const temp = join(root, 'temp');
        const bin = join(root, 'bin');
        const marks = join(root, 'marks');
        for (const directory of [checkout, temp, bin, marks]) mkdirSync(directory);
        for (const module of ['venv', 'pip']) {
          mkdirSync(join(checkout, module));
          writeFileSync(join(checkout, module, '__init__.py'), `open(${JSON.stringify(join(marks, module))}, 'w').close()\nraise SystemExit(0)\n`);
        }
        writeFileSync(join(bin, 'python3'), [
          '#!/bin/bash',
          `if [ "$1 $2 $3" = '-I -m venv' ] || [ "$1 $2" = '-m venv' ]; then exec ${realPython} "$@" --without-pip; fi`,
          `exec ${realPython} "$@"`,
          '',
        ].join('\n'));
        chmodSync(join(bin, 'python3'), 0o755);
        // Only what the step needs, so a pre-commit installed on this machine does not skip the install.
        for (const tool of ['mktemp', 'mkdir', 'ln']) symlinkSync(spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), join(bin, tool));
        const output = join(root, 'github-path');
        writeFileSync(output, '');
        const result = bash(installScript(workflow), checkout, { PATH: bin, RUNNER_TEMP: temp, GITHUB_PATH: output });
        assert.equal(existsSync(join(marks, 'venv')), false, 'the checkout\'s venv/ ran');
        assert.equal(existsSync(join(marks, 'pip')), false, 'the checkout\'s pip/ ran');
        // The real venv module made the environment; its pip is absent, so the install fails as one.
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /::error::Could not install pre-commit/, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), '');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
