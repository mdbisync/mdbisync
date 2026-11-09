// Offline smoke of a release tree through the copied workflow templates: the
// action's `stage` step, the plain "Run the security hooks" step and the
// `apply` step, each as its own process with the inputs, `if:` and `run:` the
// template gives it. Every `uses:` of this action runs the release's own
// `action.yml` entry, and the hooks step runs whatever script the stage step
// names, so a bundle the release left out fails here before it is tagged.
// GitHub and Linear are the fakes, served over local HTTP; nothing leaves the
// machine. Runs from the source checkout (it reads examples/ and the fakes):
//
//   node test/release/staged-flow.ts RELEASE_DIRECTORY

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadMapping } from '../../src/mapping/index.ts';
import { validateAction } from '../../src/release/package.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../../src/setup/test-helpers.ts';
import { Git, commitIds, commitTree, commitUploads, fetchState, pushAtomic, resolveStateConfig, stateRef } from '../../src/state/index.ts';
import { type Fixture, IDENTITY, createFixture } from '../../src/state/test-helpers.ts';

const EXAMPLES = new URL('../../examples/', import.meta.url);
const ACTION = 'mdbisync/mdbisync@';
const HOOKS_STEP = 'Run the security hooks';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/** The template's stage, hooks and apply steps, in the order it runs them. */
async function templateSteps(template: string): Promise<[Step, Step, Step]> {
  const workflow = parse(await readFile(new URL(template, EXAMPLES), 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith(ACTION) || step.name === HOOKS_STEP);
  assert.deepEqual(steps.map((step) => step.with?.['security-step'] ?? step.name), ['stage', HOOKS_STEP, 'apply'], template);
  return steps as [Step, Step, Step];
}

/** Replaces each `${{ name }}` with its value; an expression the smoke does not know fails it. */
function expand(value: unknown, context: Record<string, string>): string {
  return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => {
    assert.ok(name in context, `the smoke has no value for \${{ ${name} }}`);
    return context[name] as string;
  });
}

/** The hooks step's `if:`, which compares one stage output with the empty string. */
function condition(expression: string, context: Record<string, string>): boolean {
  const match = /^(steps\.stage\.outputs\.[\w-]+) != ''$/.exec(expression);
  assert.ok(match, `the smoke cannot evaluate if: ${expression}`);
  return (context[match[1] as string] ?? '') !== '';
}

/** Values a runner file command recorded, by name (`name<<delimiter` blocks). */
async function fileCommands(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const match of (await readFile(path, 'utf8')).matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) values[match[1] as string] = match[3] as string;
  return values;
}

/** GitHub and Linear fakes over local HTTP, so each step can run as a process of its own. */
async function serve(world: FakeWorld): Promise<{ url: string; close: () => Promise<void> }> {
  const answer = fakeFetch(world);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const [, service, ...rest] = (request.url ?? '/').split('/');
      const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const reply = await answer(`${service === 'linear' ? LINEAR_API : GITHUB_API}/${rest.join('/')}`, { method: request.method ?? 'GET', headers, ...(body === '' ? {} : { body }) });
      response.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' });
      response.end(Buffer.from(await reply.arrayBuffer()));
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function runProcess(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ status: number; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', fail);
    child.on('close', (code) => done({ status: code ?? -1, output }));
  });
}

interface Job {
  fixture: Fixture;
  world: FakeWorld;
}

/**
 * A repository whose required Linear-format hook comes from a repository of
 * its own, as in a deployment, with one security hook; with `synced`, the
 * sync's state as an initial sync leaves it, with `docs/plan.md` linked to
 * the Linear document `plan`.
 */
async function prepareJob(synced: boolean): Promise<Job> {
  const fixture = await createFixture();
  try {
    const hooksRepo = join(fixture.root, 'format-hook');
    await mkdir(hooksRepo);
    const hooks = new Git(hooksRepo, { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email });
    await hooks.run(['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(hooksRepo, '.pre-commit-hooks.yaml'), '- id: linear-format\n  name: Linear format\n  entry: "true"\n  language: system\n');
    await hooks.run(['add', '--all']);
    await hooks.run(['commit', '--quiet', '-m', 'Hook']);
    await fixture.seed({
      'docs/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n\n# Notes\n',
      'docs/plan.md': '---\ncategory: work\n---\n\nOriginal.\n',
      '.pre-commit-config.yaml': `repos:
  - repo: ${hooksRepo}
    rev: ${await hooks.text(['rev-parse', 'HEAD'])}
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: scan
        alias: security
        name: Scan
        entry: "true"
        language: system
        stages: [pre-commit]
`,
    });
    const world = fakeWorld();
    if (synced) {
      const config = resolveStateConfig({});
      const setup = await fixture.clone('setup');
      const fetched = await fetchState(setup, config);
      await loadMapping(setup, fetched.tracked);
      const initial = {
        linear: await commitTree(setup, { parents: [fetched.tracked], base: fetched.tracked, changes: new Map(), message: 'Initial state', identity: IDENTITY }),
        ids: await commitIds(setup, null, new Map([['docs/plan.md', { id: 'plan' }]]), IDENTITY),
        uploads: await commitUploads(setup, null, new Map(), IDENTITY),
      };
      const pushed = await pushAtomic(setup, config, Object.entries(initial).map(([store, next]) => ({ ref: stateRef(config, store as 'ids' | 'linear' | 'uploads'), expected: null, next })));
      assert.equal(pushed.ok, true);
      world.linear.documents.push({ id: 'plan', title: 'plan', content: 'Original.\n', projectId: 'project-api', createdAt: '2026-01-01T00:00:00Z' });
    }
    return { fixture, world };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

/**
 * Runs the template's job on the release, as the runner would: a fresh
 * checkout, the stage, hooks and apply steps, then the action's `post` entry
 * for each of its steps, last first. Returns what the hooks step printed
 * (empty when its `if:` skipped it).
 */
async function runTemplate(release: string, template: string, inputs: Record<string, string>, job: Job): Promise<string> {
  const [stage, hooks, apply] = await templateSteps(template);
  const action: unknown = parse(await readFile(join(release, 'action.yml'), 'utf8'));
  const [main, post] = validateAction(action);
  const defaults = (action as { inputs: Record<string, { default?: string }> }).inputs;
  // One folder per run of the template: its checkout, the runner's files, its home and its temporary directory.
  const run = await mkdtemp(join(job.fixture.root, 'run-'));
  const workspace = (await job.fixture.clone(join(basename(run), 'workspace'))).dir;
  const home = join(run, 'home');
  const runnerTemp = join(run, 'temp');
  await mkdir(home);
  await mkdir(runnerTemp);
  const context: Record<string, string> = {
    'secrets.MDBISYNC_LINEAR_CLIENT_ID': 'client',
    'secrets.MDBISYNC_LINEAR_CLIENT_SECRET': 'client-secret',
    'steps.app-token.outputs.token': 'app-token',
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`inputs.${name}`, value])),
  };
  /** The runner's environment for one step, with command files of its own. */
  const runnerEnv = async (name: string): Promise<Record<string, string>> => {
    const files: Record<string, string> = {};
    for (const file of ['OUTPUT', 'STATE', 'ENV', 'PATH', 'STEP_SUMMARY']) {
      files[`GITHUB_${file}`] = join(run, `${name}.${file.toLowerCase()}`);
      await writeFile(files[`GITHUB_${file}`] as string, '');
    }
    return { PATH: process.env['PATH'] ?? '', HOME: home, LANG: 'C.UTF-8', GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, ...files };
  };
  const server = await serve(job.world);
  try {
    /** A `uses:` step's inputs: the template's over action.yml's defaults, pointed at the fakes. */
    const actionInputs = (step: Step) => {
      const given: Record<string, string> = {
        ...Object.fromEntries(Object.entries(defaults).map(([input, spec]) => [input, spec.default ?? ''])),
        ...Object.fromEntries(Object.entries(step.with ?? {}).map(([input, value]) => [input, expand(value, context)])),
        // Offline only: the fakes, the fixture's repository and no wait for checks the fake has none of.
        'linear-api-url': `${server.url}/linear`,
        'github-api-url': `${server.url}/github`,
        repository: 'example/repository',
        'merge-grace-seconds': '0',
      };
      return Object.fromEntries(Object.entries(given).map(([input, value]) => [`INPUT_${input.toUpperCase()}`, value]));
    };
    const ran: Array<{ name: string; step: Step; state: string }> = [];
    const runAction = async (name: string, step: Step) => {
      const runner = await runnerEnv(name);
      const result = await runProcess(process.execPath, [join(release, main!)], workspace, { ...runner, ...actionInputs(step) });
      assert.equal(result.status, 0, `${template} ${name}:\n${result.output}`);
      ran.push({ name, step, state: runner.GITHUB_STATE as string });
      return fileCommands(runner.GITHUB_OUTPUT as string);
    };
    for (const [output, value] of Object.entries(await runAction('stage', stage))) context[`steps.stage.outputs.${output}`] = value;
    let printed = '';
    if (hooks.if === undefined || condition(hooks.if, context)) {
      const env: Record<string, string> = { ...(await runnerEnv('hooks')), ...Object.fromEntries(Object.entries(hooks.env ?? {}).map(([key, value]) => [key, expand(value, context)])) };
      // The runner's default shell for a `run:` step on Linux.
      const result = await runProcess('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', hooks.run ?? ''], workspace, env);
      assert.equal(result.status, 0, `${template} ${HOOKS_STEP}:\n${result.output}`);
      printed = result.output;
    }
    await runAction('apply', apply);
    // At the end of the job the runner runs each step's post entry, last first, with that step's inputs and saved state.
    for (const { name, step, state } of ran.reverse()) {
      const saved = Object.fromEntries(Object.entries(await fileCommands(state)).map(([key, value]) => [`STATE_${key}`, value]));
      const result = await runProcess(process.execPath, [join(release, post!)], workspace, { ...(await runnerEnv(`${name}-post`)), ...actionInputs(step), ...saved });
      assert.equal(result.status, 0, `${template} ${name} post:\n${result.output}`);
    }
    return printed;
  } finally {
    await server.close();
  }
}

/** The text of a file on the sync's tracked state in the remote. */
async function trackedText(job: Job, path: string): Promise<string> {
  return (await job.fixture.remote.run(['show', `${stateRef(resolveStateConfig({}), 'linear')}:${path}`])).stdout.toString('utf8');
}

export async function smokeStagedFlow(directory: string): Promise<void> {
  const release = resolve(directory);
  const checked = (count: number) => new RegExp(`Security hooks: staged sets checked ${count}, with findings 0, without an answer 0\\.`);
  const scenarios: Array<[string, (job: Job) => Promise<void>, boolean]> = [
    ['the sync takes a change from Linear through the hooks', async (job) => {
      const plan = job.world.linear.documents[0]!;
      plan.content = 'Edited in Linear.\n';
      touch(plan);
      assert.match(await runTemplate(release, 'mdbisync.yml', {}, job), checked(1));
      assert.equal(await trackedText(job, 'docs/plan.md'), '---\ncategory: work\n---\n\nEdited in Linear.\n');
    }, true],
    ['the initial sync from Linear stages, checks and records', async (job) => {
      const plan = job.world.linear.documents[0]!;
      plan.content = 'Taken from Linear.\n';
      touch(plan);
      assert.match(await runTemplate(release, 'mdbisync-initial-sync.yml', { direction: 'linear-to-git', confirm: 'true' }, job), checked(1));
      assert.equal(await trackedText(job, 'docs/plan.md'), '---\ncategory: work\n---\n\nTaken from Linear.\n');
    }, true],
    // Nothing comes from Linear, yet the stage step still names the hooks script and the hooks step runs it.
    ['the initial sync to Linear stages nothing, in a dry run and a confirmed run', async (job) => {
      const initial = 'mdbisync-initial-sync.yml';
      assert.match(await runTemplate(release, initial, { direction: 'git-to-linear', confirm: 'false' }, job), checked(0));
      assert.deepEqual(job.world.writes, [], 'the dry run wrote');
      assert.match(await runTemplate(release, initial, { direction: 'git-to-linear', confirm: 'true' }, job), checked(0));
      assert.deepEqual(job.world.linear.documents.filter((document) => document.trashed !== true).map((document) => document.title).sort(), ['README', 'plan']);
    }, false],
  ];
  for (const [label, scenario, synced] of scenarios) {
    const job = await prepareJob(synced);
    try {
      await scenario(job);
    } catch (error) {
      throw new Error(`staged flow: ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await job.fixture.cleanup();
    }
  }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: staged-flow.ts RELEASE_DIRECTORY');
  await smokeStagedFlow(directory);
  console.log('Staged flow passed: sync, initial sync from Linear, initial sync to Linear.');
}
