// Integration check: real pre-commit installation from a bundled release,
// followed by the copyable workflow's scripts in scratch Git repositories.
// Requires pre-commit and Node 24 on PATH; run after npm run build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { preCommitConfig } from '../test/corpus/tree.ts';
import { stageRelease } from '../src/release/package.ts';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'hook-integration-'));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
  PRE_COMMIT_HOME: join(temporary, 'cache'),
  npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true',
  // Refuse any accidental registry or toolchain download during installation.
  HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1',
  ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '',
};
function run(cwd: string, command: string, args: string[], extra: Record<string, string> = {}, expected = 0) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout + result.stderr;
}
function git(cwd: string, ...args: string[]) { return run(cwd, 'git', args).trim(); }
async function init(cwd: string) {
  await mkdir(cwd, { recursive: true });
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Hook Test');
  git(cwd, 'config', 'user.email', 'hook@example.com');
}
try {
  const release = join(temporary, 'release');
  await stageRelease({
    source: root, output: release, sourceSha: 'a'.repeat(40), version: 'v0.1.0-rc.1',
    action: parse(await readFile(join(root, 'action.yml'), 'utf8')),
    hooks: parse(await readFile(join(root, '.pre-commit-hooks.yaml'), 'utf8')),
  });
  await init(release);
  git(release, 'add', '.');
  git(release, 'commit', '-m', 'Bundle hook fixture');
  const revision = git(release, 'rev-parse', 'HEAD');
  const scratch = join(temporary, 'scratch');
  await init(scratch);
  const config = (id: string) => preCommitConfig(revision)
    .replace('https://github.com/mdbisync/mdbisync', release)
    .replace('id: linear-format', `id: ${id}`);
  const page = join(scratch, 'page with spaces.md');
  const fixable = '*one*\n';
  await writeFile(join(scratch, '.pre-commit-config.yaml'), config('linear-format'));
  await writeFile(page, fixable);
  git(scratch, 'add', '.');
  git(scratch, 'commit', '-m', 'Unformatted page');
  const hooks = (expected: number) => run(scratch, 'pre-commit', ['run', '--all-files', '--show-diff-on-failure'], {}, expected);
  hooks(1);
  const fixed = await readFile(page, 'utf8');
  assert.notEqual(fixed, fixable);
  hooks(0);
  await writeFile(join(scratch, '.pre-commit-config.yaml'), config('linear-format-check'));
  await writeFile(page, fixable);
  assert.match(hooks(1), /not in Linear's form/);
  assert.equal(await readFile(page, 'utf8'), fixable);
  await writeFile(page, '*one* and a note[^1].\n\n[^1]: Not supported.\n');
  assert.match(hooks(1), /footnote/);
  await writeFile(join(scratch, '.pre-commit-config.yaml'), config('linear-format'));
  assert.match(hooks(1), /footnote/);
  assert.equal(await readFile(page, 'utf8'), '*one* and a note[^1].\n\n[^1]: Not supported.\n');
  console.log('L0-08: offline install, fix, second pass, check-only and lint refusal passed');

  const workflow = parse(await readFile(join(root, 'examples/pre-commit.yml'), 'utf8'));
  const steps = workflow.jobs['pre-commit'].steps as { name?: string; run?: string }[];
  const script = (name: string) => steps.find((step) => step.name === name)!.run!;
  const collect = script('Run all hooks and collect fixes');
  const commit = script('Commit fixes or show the fork patch');
  const push = script('Push fixes');
  const check = script('Check the fixed tree in the same job');
  const remote = join(temporary, 'remote.git');
  run(temporary, 'git', ['init', '--bare', remote]);
  git(scratch, 'remote', 'add', 'origin', remote);
  await writeFile(page, fixable);
  // A second hook proves that the whole configuration runs, not just ours.
  const marker = join(scratch, 'hook-runs.txt');
  await writeFile(join(scratch, '.pre-commit-config.yaml'), `${config('linear-format')}  - repo: local\n    hooks:\n      - id: extra-check\n        name: extra check\n        language: system\n        entry: sh -c 'echo checked >> hook-runs.txt'\n        pass_filenames: false\n        always_run: true\n`);
  // Untracked hook output must not be swept into the fixing commit.
  git(scratch, 'add', '.');
  git(scratch, 'commit', '-m', 'Add workflow fixture');
  git(scratch, 'push', 'origin', 'HEAD:refs/heads/topic');
  const vars = { GITHUB_OUTPUT: join(temporary, 'output'), SAME_REPOSITORY: 'true', HEAD_BRANCH: 'topic', GH_TOKEN: 'fixture' };
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', collect], vars);
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', commit], vars);
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', push], vars);
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', check], vars);
  assert.equal(git(scratch, 'log', '-1', '--format=%s'), 'Apply pre-commit fixes');
  assert.equal(git(scratch, 'rev-parse', 'HEAD'), git(scratch, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s+/)[0]);
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2);
  assert.equal(await readFile(page, 'utf8'), fixed);
  assert.equal(git(scratch, 'ls-tree', '--name-only', 'HEAD').includes('hook-runs.txt'), false);

  // Exercise the exact check-run payloads without using a GitHub credential.
  const stubBin = join(temporary, 'bin');
  await mkdir(stubBin);
  const capture = join(temporary, 'curl-args');
  await writeFile(join(stubBin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE_FILE"
printf '{"id":123}\\n'
`, { mode: 0o755 });
  const apiVars = { ...vars, PATH: `${stubBin}:${process.env.PATH}`, CAPTURE_FILE: capture,
    REPOSITORY: 'example/repository', CHECKED_SHA: git(scratch, 'rev-parse', 'HEAD'),
    RUN_URL: 'https://example.com/run', CHECK_ID: '123', CHECK_OUTCOME: 'success', JOB_STATUS: 'success' };
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', script('Mark the fixing commit pending')], apiVars);
  let request = (await readFile(capture, 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(request.at(-1)!), { name: 'pre-commit', head_sha: apiVars.CHECKED_SHA, status: 'in_progress', details_url: apiVars.RUN_URL });
  assert.match(await readFile(vars.GITHUB_OUTPUT, 'utf8'), /id=123/);
  for (const outcome of ['success', 'failure', 'cancelled']) {
    run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', script('Publish result on the fixing commit')], { ...apiVars, CHECK_OUTCOME: outcome });
    request = (await readFile(capture, 'utf8')).trim().split('\n');
    const endpoint = new URL(request[request.indexOf('--data') - 1]!);
    assert.equal(endpoint.origin, 'https://api.github.com');
    assert.equal(endpoint.pathname, '/repos/example/repository/check-runs/123');
    assert.deepEqual(JSON.parse(request.at(-1)!), { status: 'completed', conclusion: outcome === 'success' ? 'success' : 'failure' });
  }

  // A contributor can push while hooks run. A normal push must preserve it.
  const contributor = join(temporary, 'contributor');
  run(temporary, 'git', ['clone', '--branch', 'topic', remote, contributor]);
  git(contributor, 'config', 'user.name', 'Contributor');
  git(contributor, 'config', 'user.email', 'contributor@example.com');
  git(contributor, 'commit', '--allow-empty', '-m', 'Concurrent contribution');
  git(contributor, 'push', 'origin', 'topic');
  const concurrentHead = git(contributor, 'rev-parse', 'HEAD');
  await writeFile(page, fixable);
  git(scratch, 'add', '--update');
  git(scratch, 'commit', '-m', 'Unformatted concurrent page');
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', collect], vars);
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', commit], vars);
  assert.match(run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', push], vars, 1), /rejected/);
  assert.equal(git(scratch, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s+/)[0], concurrentHead);

  // A fork cannot write back: emit a ready patch and leave the remote alone.
  const before = git(scratch, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s+/)[0];
  await writeFile(page, fixable);
  git(scratch, 'add', '--update');
  git(scratch, 'commit', '-m', 'Unformatted fork page');
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', collect], vars);
  const patch = run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', commit], { ...vars, SAME_REPOSITORY: 'false' }, 1);
  assert.match(patch, /diff --git/);
  assert.equal(git(scratch, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s+/)[0], before);
  // An unfixable check must still fail on the final pass.
  await writeFile(page, '*one* and a note[^1].\n\n[^1]: Not supported.\n');
  run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', collect], vars);
  assert.match(run(scratch, 'bash', ['-e', '-o', 'pipefail', '-c', check], vars, 1), /footnote/);
  console.log('CI scripts: whole config, fix commit/push, same-job checks, fork patch, concurrent push refusal and lint refusal passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
