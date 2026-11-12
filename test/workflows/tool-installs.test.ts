import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const workflows = new URL('../../.github/workflows/', import.meta.url);
const requirementsPath = '.github/requirements/pre-commit.txt';
const requirements = readFileSync(new URL(`../../${requirementsPath}`, import.meta.url), 'utf8').trim();

function checkInstalls(workflow: Workflow) {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      const run = step.run ?? '';
      assert.doesNotMatch(run, /\b(?:pipx|uvx?|easy_install)\b/, 'Python packages must use hash-checked pip');
      for (const install of run.match(/\bpip(?:\d+(?:\.\d+)?)?\b[^\n]*?\b(?:install|download)\b[^\n]*/g) ?? []) {
        const list = name === 'build' ? '"$RUNNER_TEMP/pre-commit-requirements.txt"' : requirementsPath;
        assert.equal(install, `pip install --require-hashes --only-binary :all: -r ${list}`);
      }
      for (const install of run.match(/\bnpm (?:install|i|add)\b.*/g) ?? []) {
        const match = /^npm install --global --ignore-scripts npm@(\d+)\.(\d+)\.(\d+)$/.exec(install);
        assert.ok(match, 'npm installs must pin an exact version and disable scripts');
        const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
        assert.ok(major > 11 || (major === 11 && (minor > 21 || (minor === 21 && patch >= 2))), 'npm must be at least 11.21.2');
      }
    }
    const dependencyInstall = job.steps.findIndex(step => /\bnpm ci\b/.test(step.run ?? ''));
    if (dependencyInstall >= 0) {
      const npmInstall = job.steps.findIndex(step => /\bnpm install --global\b/.test(step.run ?? ''));
      assert.ok(npmInstall >= 0 && npmInstall < dependencyInstall, 'install patched npm before dependencies');
    }
  }
}

test('repository workflows install only hashed Python wheels and patched npm', () => {
  for (const file of readdirSync(workflows).filter(file => file.endsWith('.yml'))) {
    checkInstalls(parse(readFileSync(new URL(file, workflows), 'utf8')));
  }
});

test('repository requirements and every template install the same pins', () => {
  const entries = (text: string) => {
    const lines = text.replace(/ \\\n\s*/g, ' ').split('\n');
    const pins = new Map(lines.map(line => [line.split('==')[0]!, line]));
    assert.equal(pins.size, lines.length, 'each package must appear exactly once');
    for (const line of lines) assert.match(line, /^[a-z0-9-]+==\S+ --hash=sha256:[0-9a-f]{64}(?: --hash=sha256:[0-9a-f]{64})*$/, 'exact pins with hashes, no markers');
    return pins;
  };
  const expected = entries(requirements);
  for (const file of ['mdbisync.yml', 'mdbisync-initial-sync.yml', 'pre-commit.yml']) {
    const template = parse(readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8')) as Workflow;
    const script = Object.values(template.jobs).flatMap(job => job.steps).find(step => step.name === 'Install pre-commit')!.run!;
    const list = /<<'REQUIREMENTS'; then\n([\s\S]*?)\nREQUIREMENTS\n/.exec(script)?.[1];
    assert.ok(list, file);
    assert.deepEqual(entries(list), expected, file);
  }
});

for (const run of [
  'pipx install pre-commit==4.6.2',
  'uvx pre-commit run',
  'pip3.12 install pre-commit',
  'python3 -m pip --isolated install pre-commit',
  'python3 -m pip download pre-commit',
  `python3 -m pip install --only-binary :all: -r ${requirementsPath}`,
  `python3 -m pip install --require-hashes -r ${requirementsPath}`,
  'npm install --global --ignore-scripts npm@11.16.0',
  'npm install --global npm@11.21.2',
  'npm ci',
]) {
  test(`install contract rejects ${run}`, () => {
    assert.throws(() => checkInstalls({ jobs: { test: { steps: [{ run }] } } }));
  });
}

test('release preserves its hash list when the requested source predates the file', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'release-requirements-'));
  try {
    const source = join(temporary, 'source');
    const runner = join(temporary, 'runner');
    mkdirSync(join(source, '.github/requirements'), { recursive: true });
    mkdirSync(runner);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.com');
    writeFileSync(join(source, 'package.json'), '{}');
    git('add', 'package.json');
    git('commit', '-m', 'Older source');
    const old = git('rev-parse', 'HEAD');
    writeFileSync(join(source, requirementsPath), `${requirements}\n`);
    git('add', requirementsPath);
    git('commit', '-m', 'Workflow requirements');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const workflow = parse(readFileSync(new URL('release.yml', workflows), 'utf8')) as Workflow;
    const checkout = workflow.jobs.build!.steps.find(step => step.name === 'Validate and check out source')!.run!;
    execFileSync('bash', ['-e', '-c', checkout], { cwd: source,
      env: { ...process.env, SOURCE_SHA: old, RUNNER_TEMP: runner } });
    assert.equal(git('rev-parse', 'HEAD'), old);
    assert.throws(() => readFileSync(join(source, requirementsPath)));
    assert.equal(readFileSync(join(runner, 'pre-commit-requirements.txt'), 'utf8').trim(), requirements);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
