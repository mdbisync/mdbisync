import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import initTemplates from '../../src/init/workflows.json' with { type: 'json' };

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

// GitHub's dependency graph, and so dependency review and Dependabot alerts,
// reads only the requirements file: the lists written inline in the templates
// are invisible to it. Every template and init copy must therefore install
// exactly the scanned file's lines.
function entries(text: string) {
  const lines = text.replace(/ \\\n\s*/g, ' ').split('\n');
  const pins = new Map(lines.map(line => [line.split('==')[0]!, line]));
  assert.equal(pins.size, lines.length, 'each package must appear exactly once');
  return pins;
}

/** The names of the copies that install Python packages; throws on any copy that differs from the scanned file. */
function checkTemplateCopies(copies: (readonly [string, string])[], scanned = requirements) {
  const expected = entries(scanned);
  const preCommit = /^pre-commit==(\S+) /m.exec(scanned)?.[1];
  assert.ok(preCommit, `${requirementsPath} must pin pre-commit`);
  const installing: string[] = [];
  for (const [name, text] of copies) {
    for (const step of Object.values((parse(text) as Workflow).jobs).flatMap(job => job.steps)) {
      const run = step.run ?? '';
      if (!/\b(?:pip|pipx|uvx?|easy_install)\b/.test(run)) continue;
      const where = `${name}, step "${step.name}"`;
      const installs = run.match(/\b(?:pipx|uvx?|easy_install|pip(?:\d+(?:\.\d+)?)?)\b[^\n]*?\b(?:install|download|run)\b[^\n]*/g) ?? [];
      assert.deepEqual(installs, ["pip install --require-hashes --only-binary :all: -r /dev/stdin <<'REQUIREMENTS'; then"], where);
      const list = /<<'REQUIREMENTS'; then\n([\s\S]*?)\nREQUIREMENTS\n/.exec(run)?.[1];
      assert.ok(list, `${where}: no requirements list`);
      assert.deepEqual(entries(list), expected, `${where}: copy the lines of ${requirementsPath} into this list`);
      // The version the step checks for and names in its error.
      const named = [...run.matchAll(/\bpre-commit (\d+\.\d+\.\d+)\b/g)].map(match => match[1]);
      assert.ok(named.length > 0 && named.every(version => version === preCommit), `${where}: name the pre-commit ${preCommit} the list installs`);
      installing.push(name);
    }
  }
  return installing;
}

const examples = new URL('../../examples/', import.meta.url);
const templateCopies = [
  ...readdirSync(examples).filter(file => file.endsWith('.yml'))
    .map(file => [`examples/${file}`, readFileSync(new URL(file, examples), 'utf8')] as const),
  ...Object.entries(initTemplates).map(([file, text]) => [`src/init/workflows.json ${file}`, text] as const),
];

test('every template and init copy installs exactly the scanned requirements file', () => {
  const installing = checkTemplateCopies(templateCopies);
  for (const file of ['mdbisync.yml', 'mdbisync-initial-sync.yml', 'pre-commit.yml']) {
    assert.ok(installing.includes(`examples/${file}`), file);
    assert.ok(installing.includes(`src/init/workflows.json ${file}`), file);
  }
});

const [copyName, copyText] = templateCopies.find(([name]) => name === 'examples/pre-commit.yml')!;
const filelock = /^filelock==\S+ --hash=sha256:[0-9a-f]{64}$/m.exec(requirements)![0];
const newPreCommit = (text: string) => text.replace(/\bpre-commit==\S+/, 'pre-commit==4.7.0');
for (const [change, copy, scanned, reason] of [
  ['a changed version in a copy', copyText.replace(filelock, filelock.replace(/==\S+/, '==4.2.9')), requirements, /copy the lines/],
  ['a changed hash in a copy', copyText.replace(filelock, filelock.replace(/[0-9a-f]{64}$/, '0'.repeat(64))), requirements, /copy the lines/],
  ['a package missing from a copy', copyText.replace(new RegExp(`^ *${filelock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`, 'm'), ''), requirements, /copy the lines/],
  ['an update only to the scanned file', copyText, requirements.replace(filelock, filelock.replace(/==\S+/, '==4.3.0')), /copy the lines/],
  ['a pre-commit update the step does not expect', newPreCommit(copyText), newPreCommit(requirements), /name the pre-commit 4\.7\.0/],
  ['a second, unhashed install', copyText.replace(/^( +)mkdir /m, '$1pipx install pre-commit\n$1mkdir '), requirements, /, step "Install pre-commit"$/m],
] as const) {
  test(`template copy check rejects ${change}`, () => {
    assert.notEqual(copy + scanned, copyText + requirements);
    assert.throws(() => checkTemplateCopies([[copyName, copy]], scanned), reason);
  });
}

test('Dependabot keeps the scanned requirements file up to date', () => {
  type Update = { 'package-ecosystem': string; directory: string };
  const config = parse(readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8')) as { updates: Update[] };
  // Dependabot reads requirement files in its directory and in subfolders,
  // and accepts any file whose path names `requirements`.
  assert.ok(config.updates.some(update => update['package-ecosystem'] === 'pip'
    && `${update.directory.replace(/^\/|\/$/g, '')}/requirements/pre-commit.txt` === requirementsPath),
  `Dependabot must update ${requirementsPath}`);
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
