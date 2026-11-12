// The workflow templates in `examples/` pin `mdbisync/mdbisync` to a
// release commit, and a deployer copies them as they are. Every input a
// template passes must be one that release's `action.yml` declares; an
// input it lacks makes the copied workflow fail. The release commit is
// not on `main` (release commits are isolated), so a shallow checkout
// cannot read it: PINNED_RELEASE records its inputs, and the last two
// tests check that record against the release commit and its tag. CI
// fetches the release tags for them and fails without them; elsewhere a
// clone without the tag skips them.
//
// To move the pin: change the SHA and version comment of every
// `mdbisync/mdbisync` step in `examples/` (and `src/init/workflows.json`,
// which must equal them), then update PINNED_RELEASE from that release's
// `action.yml` and run this test in a clone that has the release's tag.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLES = new URL('../../examples/', import.meta.url);
const ACTION = 'mdbisync/mdbisync@';
/** A `uses:` line of the action, with what follows the `@`. */
const ACTION_USES = /^\s*(?:-\s+)?uses:\s*mdbisync\/mdbisync@(.*)$/;

/** The release the templates pin, and the inputs its `action.yml` declares. */
const PINNED_RELEASE = {
  version: 'v0.1.0-rc.9',
  sha: 'f1164ace541d364889a7699f5f90929ffa478b68',
  inputs: {
    operation: { required: false },
    'linear-client-id': { required: true },
    'linear-client-secret': { required: true },
    'linear-api-url': { required: false },
    'cleanup-tokens': { required: false },
    'github-token': { required: true },
    'app-slug': { required: true },
    'github-api-url': { required: false },
    repository: { required: false },
    'tracked-branch': { required: false },
    'sync-branch': { required: false },
    'state-ref-prefix': { required: false },
    'document-cap': { required: false },
    'merge-grace-seconds': { required: false },
    'check-deadline-minutes': { required: false },
    'report-file': { required: false },
    direction: { required: false },
    confirm: { required: false },
    'security-step': { required: false },
  },
} as const;

type Inputs = Record<string, { required: boolean }>;
interface Step { name?: string; uses?: string; with?: Record<string, unknown> }
interface Workflow { jobs?: Record<string, { steps?: Step[] }> }

const templates = () => readdirSync(EXAMPLES).filter((file) => file.endsWith('.yml')).map((file) => ({ file, text: readFileSync(new URL(file, EXAMPLES), 'utf8') }));

/** The `mdbisync/mdbisync` steps of a workflow. */
function actionSteps(text: string): Step[] {
  const workflow = parse(text) as Workflow;
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith(ACTION));
}

/** What a workflow passes that `inputs` does not declare, and what it leaves out that `inputs` requires. */
function inputProblems(text: string, inputs: Inputs): string[] {
  const problems: string[] = [];
  for (const step of actionSteps(text)) {
    const label = step.name ?? step.uses;
    const passed = Object.keys(step.with ?? {});
    for (const name of passed) if (!(name in inputs)) problems.push(`${label}: input ${name} is not declared by the pinned release`);
    for (const [name, { required }] of Object.entries(inputs)) if (required && !passed.includes(name)) problems.push(`${label}: required input ${name} is missing`);
  }
  return problems;
}

/** `git` in this repository; undefined when it fails (no repository, or an object it does not have). */
function git(...args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

/** Skips the test when this clone lacks `what`, except in CI, which fetches the release tags and must check the record. */
function missing(t: TestContext, what: string): void {
  const message = `${what} is not in this clone; fetch the tag ${PINNED_RELEASE.version} to check the record`;
  if (process.env['GITHUB_ACTIONS'] === 'true') assert.fail(message);
  t.skip(message);
}

describe('the release the workflow templates pin', () => {
  it('every mdbisync step in examples/ pins the recorded release, with its version beside it', () => {
    let steps = 0;
    for (const { file, text } of templates()) {
      for (const line of text.split('\n')) {
        const uses = ACTION_USES.exec(line);
        if (uses === null) continue;
        steps += 1;
        assert.equal(uses[1], `${PINNED_RELEASE.sha} # ${PINNED_RELEASE.version}`, `${file}: ${line.trim()}`);
      }
    }
    assert.ok(steps > 0, 'no template runs mdbisync/mdbisync');
  });

  it('every input a template passes is declared by the pinned release, and every required one is passed', () => {
    for (const { file, text } of templates()) assert.deepEqual(inputProblems(text, PINNED_RELEASE.inputs), [], file);
  });

  it('finds an input the pinned release lacks, and a required input left out', () => {
    const { text } = templates().find(({ file }) => file === 'mdbisync.yml') ?? assert.fail('mdbisync.yml is missing');
    const workflow = parse(text) as Workflow;
    const step = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []).find((each) => each.uses?.startsWith(ACTION)) ?? assert.fail('no mdbisync step');
    step.with = { ...step.with, 'added-later': 'true' };
    delete step.with['app-slug'];
    const problems = inputProblems(JSON.stringify(workflow), PINNED_RELEASE.inputs);
    assert.deepEqual(problems, [
      `${step.name}: input added-later is not declared by the pinned release`,
      `${step.name}: required input app-slug is missing`,
    ]);
  });

  it('the recorded inputs are the ones the release commit\'s action.yml declares', (t) => {
    const actionYml = git('show', `${PINNED_RELEASE.sha}:action.yml`);
    if (actionYml === undefined) return missing(t, `release commit ${PINNED_RELEASE.sha}`);
    const declared = (parse(actionYml) as { inputs: Record<string, { required?: boolean }> }).inputs;
    assert.deepEqual(
      Object.fromEntries(Object.entries(declared).map(([name, input]) => [name, { required: input.required === true }])),
      PINNED_RELEASE.inputs,
    );
  });

  it('the recorded version\'s tag names the pinned commit', (t) => {
    const tagged = git('rev-parse', '--verify', '--quiet', `refs/tags/${PINNED_RELEASE.version}^{commit}`);
    if (tagged === undefined) return missing(t, `the tag ${PINNED_RELEASE.version}`);
    assert.equal(tagged.trim(), PINNED_RELEASE.sha, `the tag ${PINNED_RELEASE.version}`);
  });
});
