// The workflow templates in `examples/` pin `mdbisync/mdbisync` to a
// release commit, and a deployer copies them as they are. Every input a
// template passes must be one that release's `action.yml` declares; an
// input it lacks makes the copied workflow fail. The release commit is
// not on `main` (release commits live on `releases`), so a shallow checkout
// cannot read it: CI fetches the release tags for the tests that read it
// and fails without them; elsewhere a clone without the tag skips them.
//
// Each final release moves the pins itself: release.yml's `pins` job runs
// `src/release/pins.ts`, which rewrites every `mdbisync/mdbisync` step in
// `examples/`, `src/init/workflows.json` (which must equal them),
// `src/init/older-releases.json` and the configuration page, and pushes
// them on a branch for a pull request to `main`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { MINIMUM_RELEASE, OLDER_RELEASES } from '../../src/init/releases.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLES = new URL('../../examples/', import.meta.url);
const ACTION = 'mdbisync/mdbisync@';
/** A `uses:` line of the action, with what follows the `@`. */
const ACTION_USES = /^\s*(?:-\s+)?uses:\s*mdbisync\/mdbisync@(.*)$/;

/** The release the templates pin: the oldest one `init` writes. */
const PINNED_RELEASE = MINIMUM_RELEASE;

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

/** Skips the test when this clone lacks `what`, except in CI, which fetches the release tags and must check the pinned release. */
function missing(t: TestContext, what: string): void {
  const message = `${what} is not in this clone, so the templates are not checked against the pinned release; fetch the tag ${PINNED_RELEASE.version} to check them`;
  if (process.env['GITHUB_ACTIONS'] === 'true') assert.fail(message);
  t.skip(message);
}

describe('the release the workflow templates pin', () => {
  it('every mdbisync step in examples/ pins one release, with its version beside it', () => {
    assert.match(PINNED_RELEASE.sha, /^[a-f0-9]{40}$/);
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

  it('finds an input the pinned release lacks, and a required input left out', () => {
    const { text } = templates().find(({ file }) => file === 'mdbisync.yml') ?? assert.fail('mdbisync.yml is missing');
    const workflow = parse(text) as Workflow;
    const step = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []).find((each) => each.uses?.startsWith(ACTION)) ?? assert.fail('no mdbisync step');
    const inputs = Object.fromEntries(Object.keys(step.with ?? {}).map((name) => [name, { required: name === 'app-slug' }]));
    step.with = { ...step.with, 'added-later': 'true' };
    delete step.with['app-slug'];
    const problems = inputProblems(JSON.stringify(workflow), inputs);
    assert.deepEqual(problems, [
      `${step.name}: input added-later is not declared by the pinned release`,
      `${step.name}: required input app-slug is missing`,
    ]);
  });

  it('every input a template passes is declared by the pinned release\'s action.yml, and every required one is passed', (t) => {
    const actionYml = git('show', `${PINNED_RELEASE.sha}:action.yml`);
    if (actionYml === undefined) return missing(t, `release commit ${PINNED_RELEASE.sha}`);
    const declared = (parse(actionYml) as { inputs: Record<string, { required?: boolean }> }).inputs;
    const inputs = Object.fromEntries(Object.entries(declared).map(([name, input]) => [name, { required: input.required === true }]));
    for (const { file, text } of templates()) assert.deepEqual(inputProblems(text, inputs), [], file);
  });

  it('init knows every release before the pinned one by its tagged commit', (t) => {
    const tags = git('-c', 'versionsort.suffix=-', 'tag', '--list', 'v*', '--sort=version:refname')?.split('\n').filter(Boolean) ?? [];
    const pinned = tags.indexOf(PINNED_RELEASE.version);
    if (pinned < 0) return missing(t, `the tag ${PINNED_RELEASE.version}`);
    const older = Object.fromEntries(tags.slice(0, pinned).map((tag) => [git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`)?.trim() ?? assert.fail(`the tag ${tag} does not resolve`), tag]));
    assert.deepEqual({ ...OLDER_RELEASES }, older);
  });

  it('the pinned version\'s tag names the pinned commit', (t) => {
    const tagged = git('rev-parse', '--verify', '--quiet', `refs/tags/${PINNED_RELEASE.version}^{commit}`);
    if (tagged === undefined) return missing(t, `the tag ${PINNED_RELEASE.version}`);
    assert.equal(tagged.trim(), PINNED_RELEASE.sha, `the tag ${PINNED_RELEASE.version}`);
  });
});
