import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const workflows = new URL('../../.github/workflows/', import.meta.url);
const requirementsPath = '.github/requirements/pre-commit.txt';
const requirements = readFileSync(new URL(`../../${requirementsPath}`, import.meta.url), 'utf8').trim();

function checkInstalls(workflow: Workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      const run = step.run ?? '';
      assert.doesNotMatch(run, /\b(?:pipx|uv|easy_install)\b/, 'Python packages must use hash-checked pip');
      for (const install of run.match(/\bpip3? install\b.*/g) ?? []) {
        assert.equal(install, `pip install --require-hashes --only-binary :all: -r ${requirementsPath}`);
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

test('repository requirements stay identical to the templates hash list', () => {
  const template = parse(readFileSync(new URL('../../examples/pre-commit.yml', import.meta.url), 'utf8')) as Workflow;
  const script = Object.values(template.jobs).flatMap(job => job.steps).find(step => step.name === 'Install pre-commit')!.run!;
  const list = /<<'REQUIREMENTS'; then\n([\s\S]*?)\nREQUIREMENTS\n/.exec(script)?.[1];
  assert.equal(requirements, list);
});

for (const run of [
  'pipx install pre-commit==4.6.2',
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
