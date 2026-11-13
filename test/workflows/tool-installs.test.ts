import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import { preCommitVersion, SYNC_COMMAND, syncedFiles, syncTemplate } from '../../tools/sync-pre-commit-pins.ts';

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const workflows = new URL('../../.github/workflows/', import.meta.url);
const requirementsPath = '.github/requirements/pre-commit.txt';
const requirements = readFileSync(new URL(`../../${requirementsPath}`, import.meta.url), 'utf8').trim();

// release.yml installs from the copy its checkout step takes from main before
// it checks out the source, which may predate the requirements file.
function checkInstalls(workflow: Workflow, copiedList = false) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      const run = step.run ?? '';
      assert.doesNotMatch(run, /\b(?:pipx|uvx?|easy_install)\b/, 'Python packages must use hash-checked pip');
      for (const install of run.match(/\bpip(?:\d+(?:\.\d+)?)?\b[^\n]*?\b(?:install|download)\b[^\n]*/g) ?? []) {
        const list = copiedList ? '"$RUNNER_TEMP/pre-commit-requirements.txt"' : requirementsPath;
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
    checkInstalls(parse(readFileSync(new URL(file, workflows), 'utf8')), file === 'release.yml');
  }
});

// GitHub's dependency graph, and so dependency review and Dependabot alerts,
// reads only the requirements file: the lists written inline in the templates
// are invisible to it. Every template list must therefore be exactly the
// scanned file's lines. templates.test.ts holds the templates to that one
// hashed install form, and init.test.ts holds the init copies equal to the
// templates. Dependabot updates only the scanned file; the update path is
// the sync command, which every failure here names.
function entries(text: string) {
  const lines = text.replace(/ \\\n\s*/g, ' ').split('\n');
  const pins = new Map(lines.map(line => [line.split('==')[0]!, line]));
  assert.equal(pins.size, lines.length, 'each package must appear exactly once');
  return pins;
}

/** The templates that carry a requirements list; throws on a list that differs from the scanned file. */
function checkTemplateLists(templates: [string, string][], scanned = requirements) {
  const expected = entries(scanned);
  const preCommit = preCommitVersion(scanned);
  const listing: string[] = [];
  for (const [name, text] of templates) {
    for (const step of Object.values((parse(text) as Workflow).jobs).flatMap(job => job.steps)) {
      const list = /<<'REQUIREMENTS'; then\n([\s\S]*?)\nREQUIREMENTS\n/.exec(step.run ?? '')?.[1];
      if (list === undefined) continue;
      const where = `${name}, step "${step.name}"`;
      assert.deepEqual(entries(list), expected, `${where}: the list differs from ${requirementsPath}; run \`${SYNC_COMMAND}\` to copy it`);
      // The step's messages (and pre-commit.yml's version check) name the installed pre-commit.
      const named = [...step.run!.matchAll(/\bpre-commit (\d+(?:\.\d+)+)\b/g)].map(match => match[1]);
      assert.ok(named.length > 0 && named.every(version => version === preCommit), `${where}: name pre-commit ${preCommit}, the version the list installs; run \`${SYNC_COMMAND}\``);
      listing.push(name);
    }
  }
  return listing;
}

const examples = new URL('../../examples/', import.meta.url);
const templates = readdirSync(examples).filter(file => file.endsWith('.yml'))
  .map((file): [string, string] => [file, readFileSync(new URL(file, examples), 'utf8')]);

test('every template list is exactly the scanned requirements file', () => {
  assert.deepEqual(checkTemplateLists(templates).sort(), ['mdbisync-initial-sync.yml', 'mdbisync.yml', 'pre-commit.yml']);
});

// Mutations of whole entries (a package line with its continued hash lines),
// to versions that differ from whatever the current pins are.
const [first, ...rest] = requirements.split(/\n(?=\S)/) as [string, ...string[]];
const bump = (entry: string) => entry.replace(/==([^\s\\]+)/, '==$1.1');
const template = templates.find(([file]) => file === 'pre-commit.yml')!;
const preCommitEntry = /\bpre-commit==[^\s\\]+/;
for (const [change, copy, scanned, reason] of [
  ['a list with another version', template[1], [bump(first), ...rest].join('\n'), /differs from .*; run `npm run sync:pre-commit-pins`/],
  ['a list with another hash', template[1], [first.replace(/[0-9a-f]{64}/, '0'.repeat(64)), ...rest].join('\n'), /differs from .*; run `npm run sync:pre-commit-pins`/],
  ['a list without a scanned package', template[1], `${requirements}\nextra==1.0 --hash=sha256:${'1'.repeat(64)}`, /differs from .*; run `npm run sync:pre-commit-pins`/],
  ['a list with a package the scanned file lacks', template[1], rest.join('\n'), /differs from .*; run `npm run sync:pre-commit-pins`/],
  ['a pre-commit update the step does not name', template[1].replace(preCommitEntry, entry => bump(entry)), requirements.replace(preCommitEntry, entry => bump(entry)), /name pre-commit .*; run `npm run sync:pre-commit-pins`/],
] as const) {
  test(`template list check rejects ${change}`, () => {
    assert.notEqual(copy + scanned, template[1] + requirements);
    assert.throws(() => checkTemplateLists([[template[0], copy]], scanned), reason);
  });
}

test('every copy of the scanned requirements file is what the sync command writes', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const [path, text] of syncedFiles(root)) {
    assert.equal(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), text, `${path} differs from ${requirementsPath}; run \`${SYNC_COMMAND}\``);
  }
});

// A Dependabot update of the group: new versions, and a wheel and an sdist
// hash on one line. The synced templates must pass the list check as they are.
test('the sync command makes the templates pass the list check after a Dependabot update', () => {
  const updated = requirements.split(/\n(?=\S)/).map(entry => /^pre-commit==/.test(entry) || entry === first
    ? `${bump(entry).split(' ')[0]} --hash=sha256:${'a'.repeat(64)} --hash=sha256:${'b'.repeat(64)}` : entry).join('\n');
  assert.notEqual(updated, requirements);
  assert.throws(() => checkTemplateLists(templates, updated), /run `npm run sync:pre-commit-pins`/);
  const synced = templates.map(([file, text]): [string, string] => [file, syncTemplate(text, `${updated}\n`)]);
  assert.deepEqual(checkTemplateLists(synced, updated).sort(), ['mdbisync-initial-sync.yml', 'mdbisync.yml', 'pre-commit.yml']);
  // Read as workflows, every step but the install step is unchanged, and the
  // install step differs only in its list and the version it names.
  const install = (step: Step) => (step.run ?? '').replace(/<<'REQUIREMENTS'; then\n[\s\S]*?\nREQUIREMENTS\n/, '')
    .replaceAll(`pre-commit ${preCommitVersion(updated)}`, 'pre-commit VERSION')
    .replaceAll(`pre-commit ${preCommitVersion(requirements)}`, 'pre-commit VERSION');
  for (const [file, text] of synced) {
    assert.equal(syncTemplate(text, `${updated}\n`), text, `${file}: syncing twice changes nothing`);
    const before = parse(templates.find(([name]) => name === file)![1]) as Workflow;
    const after = parse(text) as Workflow;
    for (const [name, job] of Object.entries(before.jobs)) {
      assert.equal(after.jobs[name]!.steps.length, job.steps.length, `${file}: ${name}`);
      job.steps.forEach((step, index) => {
        const changed = after.jobs[name]!.steps[index]!;
        if (step.name === 'Install pre-commit') assert.equal(install(changed), install(step), `${file}: ${name}: the install step changes only its list and version`);
        else assert.deepEqual(changed, step, `${file}: ${name}: step ${step.name ?? index} is unchanged`);
      });
    }
    assert.deepEqual({ ...after, jobs: {} }, { ...before, jobs: {} }, `${file}: only steps change`);
  }
});

test('the sync command keeps every install step of a template, and refuses a list it cannot keep', () => {
  const [, text] = template;
  const step = /^( *)- name: Install pre-commit\n(?:\1 {2}.*\n|\n)*/m.exec(text)![0];
  const updated = requirements.replace(/^pre-commit==\S+/m, 'pre-commit==99.0.0');
  const twice = syncTemplate(text.replace(step, step + step), updated);
  assert.equal(twice.split('pre-commit==99.0.0').length - 1, 2, 'both install steps carry the new list');
  assert.doesNotMatch(twice, new RegExp(`pre-commit ${preCommitVersion(requirements).replaceAll('.', '\\.')}\\b`));
  // `shell:` before `name:` hides the step from the command: it must fail, not report nothing to do.
  const reordered = text.replace(/^( *)- name: Install pre-commit\n\1 {2}shell: bash\n/m, '$1- shell: bash\n$1  name: Install pre-commit\n');
  assert.notEqual(reordered, text);
  assert.throws(() => syncTemplate(reordered, updated), /outside a step named "Install pre-commit"/);
  assert.throws(() => syncTemplate(text, requirements.replace(/^pre-commit==\S+/m, 'pre-commit==4.8.0rc1')), /must pin a release of pre-commit, not 4\.8\.0rc1/);
});

test('Dependabot keeps the scanned requirements file up to date', () => {
  type Update = { 'package-ecosystem': string; directory?: string; directories?: string[] };
  const config = parse(readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8')) as { updates: Update[] };
  // Dependabot reads requirement files in its directory and one level of
  // subfolders, and accepts without further parsing a file whose path names
  // `requirements`; from `/.github` the path is `requirements/pre-commit.txt`.
  const directories = config.updates.filter(update => update['package-ecosystem'] === 'pip')
    .flatMap(update => [update.directory, ...update.directories ?? []]);
  assert.ok(directories.includes('/.github'), `Dependabot must update ${requirementsPath} from /.github`);
});

for (const run of [
  'pipx install pre-commit',
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
    const checkout = workflow.jobs.test!.steps.find(step => step.name === 'Validate and check out source')!.run!;
    execFileSync('bash', ['-e', '-c', checkout], { cwd: source,
      env: { ...process.env, SOURCE_SHA: old, RUNNER_TEMP: runner } });
    assert.equal(git('rev-parse', 'HEAD'), old);
    assert.throws(() => readFileSync(join(source, requirementsPath)));
    assert.equal(readFileSync(join(runner, 'pre-commit-requirements.txt'), 'utf8').trim(), requirements);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
