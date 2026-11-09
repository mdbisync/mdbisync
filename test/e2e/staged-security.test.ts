// End to end against the fake GitHub and Linear worlds: the security hooks
// in a step of their own. Each step of the sync job runs as its own process,
// with the environment the runner would give it: the action's `stage` and
// `apply` steps get the Linear secret and the App token as inputs, the hooks
// step gets only a hook key. A canary hook looks for those secrets, and for
// the run's Linear tokens, in every process it can read under /proc.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMapping } from '../../src/mapping/index.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../../src/setup/test-helpers.ts';
import { Git, commitIds, commitTree, commitUploads, fetchState, pushAtomic, resolveStateConfig, stateRef } from '../../src/state/index.ts';
import { type Fixture, IDENTITY, createFixture } from '../../src/state/test-helpers.ts';
import { STAGE_FOLDER } from '../../src/sync/staged.ts';

const MAIN = fileURLToPath(new URL('../../src/action/main.ts', import.meta.url));
const linux = process.platform === 'linux' && existsSync('/proc/self/environ');

interface Canary {
  keys: string[];
  hookKey: string | null;
  found: string[];
  read: number;
}

interface Step {
  status: number;
  stdout: string;
  outputs: Record<string, string>;
}

describe('security hooks in a step of their own', { skip: linux ? false : 'needs /proc' }, () => {
  const config = resolveStateConfig({});
  // Every secret of the run starts with the marker, so the canary can find them without being told them.
  const marker = `mdbx${randomBytes(6).toString('hex')}x`;
  const clientSecret = `${marker}linear-client-secret`;
  const appToken = `${marker}app-token`;
  const hookKey = 'hook-key-value';
  let fixture: Fixture;
  let world: FakeWorld;
  let server: Server;
  let bridge: string;
  let home: string;
  let workspace: string;
  let runnerTemp: string;
  let minted: string[];

  beforeEach(async () => {
    fixture = await createFixture();
    home = join(fixture.root, 'home');
    runnerTemp = join(fixture.root, 'runner-temp');
    await mkdir(home);
    await mkdir(runnerTemp);
    // The required Linear-format hook comes from a repository of its own, as in a deployment.
    const hooksRepo = join(fixture.root, 'format-hook');
    await mkdir(hooksRepo);
    const hooks = new Git(hooksRepo, { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email });
    await hooks.run(['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(hooksRepo, '.pre-commit-hooks.yaml'), '- id: linear-format\n  name: Linear format\n  entry: "true"\n  language: system\n');
    await hooks.run(['add', '--all']);
    await hooks.run(['commit', '--quiet', '-m', 'Hook']);
    const rev = await hooks.text(['rev-parse', 'HEAD']);
    await fixture.seed({
      'docs/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n\n# Notes\n',
      'docs/plan.md': '---\ncategory: work\n---\n\nOriginal.\n',
      '.pre-commit-config.yaml': `repos:
  - repo: ${hooksRepo}
    rev: ${rev}
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: canary
        alias: security
        name: Canary
        entry: node canary.mjs
        language: system
        stages: [pre-commit]
`,
      'canary.mjs': `import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const secret = new RegExp(${JSON.stringify(marker)} + '[0-9a-z-]*', 'g');
const found = new Set();
let read = 0;
for (const pid of readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(pid)) continue;
  for (const name of ['environ', 'cmdline']) {
    let text;
    try { text = readFileSync('/proc/' + pid + '/' + name, 'latin1'); } catch { continue; }
    read += 1;
    for (const match of text.matchAll(secret)) found.add(match[0]);
  }
}
appendFileSync(join(process.env.HOME, 'canary.jsonl'), JSON.stringify({ keys: Object.keys(process.env).sort(), hookKey: process.env.CANARY_HOOK_KEY ?? null, found: [...found], read }) + '\\n');
for (const file of process.argv.slice(2)) {
  if (readFileSync(file, 'utf8').includes('private-' + 'canary')) { console.log(file + ':1: found'); process.exitCode = 1; }
}
`,
    });

    // The sync's state, as an initial sync leaves it.
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
    workspace = (await fixture.clone('workspace')).dir;

    world = fakeWorld();
    world.linear.documents.push({ id: 'plan', title: 'plan', content: 'Original.\n', projectId: 'project-api', createdAt: '2026-01-01T00:00:00Z' });
    // The fake worlds over HTTP, so the steps can run as processes of their own. Each Linear token is a secret of the run.
    minted = [];
    const answer = fakeFetch(world);
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const [, service, ...rest] = (request.url ?? '/').split('/');
        const target = `${service === 'linear' ? LINEAR_API : GITHUB_API}/${rest.join('/')}`;
        const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const reply = await answer(target, { method: request.method ?? 'GET', headers, ...(body.length > 0 ? { body: body.toString('utf8') } : {}) });
        let text = Buffer.from(await reply.arrayBuffer());
        if (target === `${LINEAR_API}/oauth/token` && reply.ok) {
          const token = `${marker}linear-token-${minted.length}`;
          minted.push(token);
          text = Buffer.from(text.toString('utf8').replace('"fake-token"', JSON.stringify(token)));
        }
        response.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' });
        response.end(text);
      })().catch((error: unknown) => {
        response.writeHead(500);
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bridge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.cleanup();
  });

  /** The environment every step of the job gets from the runner. */
  const runnerEnv = async (name: string) => {
    const files = { GITHUB_OUTPUT: join(fixture.root, `${name}.output`), GITHUB_STATE: join(fixture.root, `${name}.state`) };
    for (const file of Object.values(files)) await writeFile(file, '');
    return { PATH: process.env['PATH'] ?? '', HOME: home, LANG: 'C.UTF-8', GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, GITHUB_STEP_SUMMARY: '', ...files };
  };

  const runProcess = (command: string, args: string[], env: Record<string, string>) =>
    new Promise<{ status: number; stdout: string }>((resolve, reject) => {
      const child = spawn(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: code ?? -1, stdout }));
    });

  const outputsOf = async (file: string) => {
    const outputs: Record<string, string> = {};
    for (const match of (await readFile(file, 'utf8')).matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[match[1] as string] = match[3] as string;
    return outputs;
  };

  /** One `uses:` step of the action, its inputs as the runner gives them. */
  const action = async (name: string, inputs: Record<string, string>): Promise<Step> => {
    const env: Record<string, string> = await runnerEnv(name);
    const given = {
      'linear-client-id': 'client',
      'linear-client-secret': clientSecret,
      'linear-api-url': `${bridge}/linear`,
      'github-token': appToken,
      'github-api-url': `${bridge}/github`,
      repository: 'example/repository',
      'report-file': join(fixture.root, `${name}-report`, 'report.json'),
      ...inputs,
    };
    for (const [input, value] of Object.entries(given)) env[`INPUT_${input.toUpperCase()}`] = value;
    const { status, stdout } = await runProcess(process.execPath, [MAIN], env);
    return { status, stdout, outputs: await outputsOf(env['GITHUB_OUTPUT'] as string) };
  };

  /** The hooks step: a plain `run:` step with the stage step's command and a hook key. */
  const hooksStep = async (stage: Step): Promise<Step> => {
    const env = { ...(await runnerEnv('hooks')), CANARY_HOOK_KEY: hookKey };
    const { status, stdout } = await runProcess(stage.outputs['node'] as string, [stage.outputs['hooks'] as string], env);
    return { status, stdout, outputs: {} };
  };

  const report = async (name: string) => JSON.parse(await readFile(join(fixture.root, `${name}-report`, 'report.json'), 'utf8')) as { capture: { leftOut: Array<{ id: string; rule: string }>; blocked: Array<{ id: string; path: string }> } };
  const canaries = async (): Promise<Canary[]> => {
    const text = await readFile(join(home, 'canary.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Canary);
  };
  const remoteRefs = async () => (await fixture.remote.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8');
  const remoteText = async (path: string) => (await fixture.remote.run(['show', `${stateRef(config, 'linear')}:${path}`])).stdout.toString('utf8');
  /** Whether any object of the remote holds the text, reachable or not. */
  const remoteHolds = async (text: string) => (await fixture.remote.run(['cat-file', '--batch-all-objects', '--batch'])).stdout.toString('utf8').includes(text);
  const edit = (content: string) => {
    const document = world.linear.documents[0]!;
    document.content = content;
    touch(document);
  };

  it('the canary sees its hook key and none of the run\'s secrets, and the change goes through', async () => {
    edit('Edited in Linear.\n');
    const refs = await remoteRefs();
    const stage = await action('stage', { operation: 'sync', 'security-step': 'stage', 'report-file': '' });
    assert.equal(stage.status, 0, stage.stdout);
    assert.equal(stage.outputs['node'], process.execPath);
    assert.ok(existsSync(stage.outputs['hooks'] as string));
    // Staging writes nothing: no ref moves, nothing is written to Linear or GitHub, and its token is revoked.
    assert.equal(await remoteRefs(), refs);
    assert.deepEqual(world.writes, []);
    assert.equal(world.linear.writes.count, 0);
    assert.deepEqual([world.minted, world.revoked], [1, 1]);
    assert.ok(!stage.stdout.includes('Edited in Linear'));

    const hooks = await hooksStep(stage);
    assert.equal(hooks.status, 0, hooks.stdout);
    assert.match(hooks.stdout, /Security hooks: staged sets checked 1, with findings 0, without an answer 0\./);
    const [canary, ...more] = await canaries();
    assert.ok(canary !== undefined, 'the canary hook did not run');
    for (const seen of [canary, ...more]) {
      assert.equal(seen.hookKey, hookKey);
      assert.ok(seen.read > 2, 'the canary could not read /proc');
      assert.deepEqual(seen.found, [], 'the hook saw a secret of the run');
      assert.deepEqual(seen.keys.filter((key) => key.startsWith('INPUT_') || key.startsWith('ACTIONS_')), []);
    }

    const apply = await action('apply', { operation: 'sync', 'security-step': 'apply' });
    assert.equal(apply.status, 0, apply.stdout);
    assert.equal(await remoteText('docs/plan.md'), '---\ncategory: work\n---\n\nEdited in Linear.\n');
    assert.deepEqual((await report('apply')).capture.leftOut, []);
    // The staged content is gone from the runner's disk.
    assert.equal(existsSync(join(runnerTemp, STAGE_FOLDER)), false);
    assert.equal((await canaries()).length, 1 + more.length, 'a hook ran in the apply step');
    assert.ok(minted.length === 2 && world.revoked === 2);
  });

  it('control: hooks run inside the action\'s own step can read its secrets through /proc', async () => {
    edit('Edited in Linear.\n');
    const sync = await action('sync', { operation: 'sync' });
    assert.equal(sync.status, 0, sync.stdout);
    const found = new Set((await canaries()).flatMap((seen) => seen.found));
    assert.ok(found.has(clientSecret), 'the canary did not find the Linear client secret');
    assert.ok(found.has(appToken), 'the canary did not find the App token');
  });

  it('a change the hooks have not seen is not pushed, and the next run takes it', async () => {
    edit('Seen by the hooks.\n');
    const stage = await action('stage', { operation: 'sync', 'security-step': 'stage', 'report-file': '' });
    assert.equal((await hooksStep(stage)).status, 0);
    // Linear changes the document after the hooks ran.
    edit('Unseen secret-like edit.\n');
    const apply = await action('apply', { operation: 'sync', 'security-step': 'apply' });
    assert.equal(apply.status, 0, apply.stdout);
    assert.deepEqual((await report('apply')).capture.leftOut, [{ id: 'plan', rule: 'security-unchecked' }]);
    assert.equal(await remoteHolds('Unseen secret-like edit'), false);
    assert.equal(await remoteText('docs/plan.md'), '---\ncategory: work\n---\n\nOriginal.\n');

    // The next run's hooks see it, and it goes through.
    const again = await action('stage-2', { operation: 'sync', 'security-step': 'stage', 'report-file': '' });
    assert.equal((await hooksStep(again)).status, 0);
    assert.equal((await action('apply-2', { operation: 'sync', 'security-step': 'apply' })).status, 0);
    assert.equal(await remoteText('docs/plan.md'), '---\ncategory: work\n---\n\nUnseen secret-like edit.\n');
  });

  it('without the hooks step, nothing from Linear is pushed', async () => {
    edit('Never checked.\n');
    const stage = await action('stage', { operation: 'sync', 'security-step': 'stage', 'report-file': '' });
    assert.equal(stage.status, 0, stage.stdout);
    const apply = await action('apply', { operation: 'sync', 'security-step': 'apply' });
    assert.equal(apply.status, 0, apply.stdout);
    assert.deepEqual((await report('apply')).capture.leftOut, [{ id: 'plan', rule: 'security-unchecked' }]);
    assert.equal(await remoteHolds('Never checked'), false);
  });

  it('the initial sync from Linear stages, checks and records the same way; a dry run stages nothing', async () => {
    edit('Taken from Linear.\n');
    const initial = { operation: 'initial-sync', direction: 'linear-to-git', confirm: 'true' };
    const dry = await action('dry', { ...initial, confirm: '', 'security-step': 'stage', 'report-file': '' });
    assert.equal(dry.status, 0, dry.stdout);
    assert.equal(world.minted, 0, 'a dry run has nothing to stage and needs no token');

    const stage = await action('stage', { ...initial, 'security-step': 'stage', 'report-file': '' });
    assert.equal(stage.status, 0, stage.stdout);
    assert.deepEqual(world.writes, []);
    const hooks = await hooksStep(stage);
    assert.equal(hooks.status, 0, hooks.stdout);
    assert.match(hooks.stdout, /staged sets checked 1,/);
    const seen = await canaries();
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.flatMap((canary) => canary.found), []);
    const apply = await action('apply', { ...initial, 'security-step': 'apply' });
    assert.equal(apply.status, 0, apply.stdout);
    assert.equal(await remoteText('docs/plan.md'), '---\ncategory: work\n---\n\nTaken from Linear.\n');
  });

  it('a finding of the hooks step blocks the document', async () => {
    edit('A private-canary value.\n');
    const stage = await action('stage', { operation: 'sync', 'security-step': 'stage', 'report-file': '' });
    const hooks = await hooksStep(stage);
    assert.equal(hooks.status, 0, hooks.stdout);
    assert.match(hooks.stdout, /with findings 1,/);
    assert.ok(!hooks.stdout.includes('private-canary'));
    const apply = await action('apply', { operation: 'sync', 'security-step': 'apply' });
    assert.equal(apply.status, 0, apply.stdout);
    assert.deepEqual((await report('apply')).capture.blocked.map(({ id, path }) => ({ id, path })), [{ id: 'plan', path: 'docs/plan.md' }]);
    assert.equal(await remoteHolds('A private-canary value'), false);
  });
});
