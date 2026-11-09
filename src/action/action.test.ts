// The action's entry points in process, the way the runner starts them
// (inputs and step files from the environment), against a local git remote
// and a fake GitHub and Linear: the initial sync's dry run and confirmed
// run, the Linear token handed to `post` and taken back once revoked, and
// `post` revoking a token a killed run left behind.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { type RunReport } from '../run/finish.ts';
import { type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { Git } from '../state/index.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { gitAuthEnv, run as runMain } from './main.ts';
import { run as runPost } from './post.ts';
import { LINEAR_TOKEN_STATE } from './state.ts';

const CANARY = 'kx-5e0d82a1';
const SUMMARY = join(mkdtempSync(join(tmpdir(), 'action-summary-')), 'summary.md');
after(() => rmSync(dirname(SUMMARY), { recursive: true, force: true }));
const TREE: Record<string, string> = {
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}`,
  'eng/backend/notes.md': `# Notes\n\n${CANARY}`,
  '.pre-commit-config.yaml': `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`,
};

/** Values a runner file command recorded, by name, in order (`name<<delimiter` blocks). */
async function fileCommands(path: string): Promise<Array<[string, string]>> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const entries: Array<[string, string]> = [];
  const pattern = /^([^\n<]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const match of text.matchAll(pattern)) entries.push([match[1] as string, match[3] as string]);
  return entries;
}

describe('the action entry points', () => {
  let fixture: Fixture;
  let workspace: string;
  let saved: NodeJS.ProcessEnv;
  const file = (name: string) => join(fixture.root, name);

  beforeEach(async () => {
    saved = { ...process.env };
    fixture = await createFixture();
    await fixture.seed(TREE);
    workspace = (await fixture.clone('work')).dir;
    for (const name of ['state', 'output']) await writeFile(file(name), '');
    await writeFile(SUMMARY, '');
  });
  afterEach(async () => {
    process.env = saved;
    process.exitCode = 0;
    await fixture.cleanup();
  });

  /** Sets the step's environment as the runner does. */
  const step = (inputs: Record<string, string>, extra: Record<string, string> = {}) => {
    for (const key of Object.keys(process.env)) if (key.startsWith('INPUT_') || key.startsWith('STATE_')) delete process.env[key];
    const all: Record<string, string> = {
      'linear-client-id': 'client-id',
      'linear-client-secret': 'client-secret',
      'linear-api-url': LINEAR_API,
      'github-token': 'gh-token',
      'github-api-url': GITHUB_API,
      repository: 'owner/repo',
      'report-file': file('report.json'),
      ...inputs,
    };
    for (const [name, value] of Object.entries(all)) process.env[`INPUT_${name.toUpperCase()}`] = value;
    Object.assign(process.env, {
      GITHUB_WORKSPACE: workspace,
      GITHUB_STATE: file('state'),
      GITHUB_OUTPUT: file('output'),
      // @actions/core keeps the first summary path it saw for the whole process.
      GITHUB_STEP_SUMMARY: SUMMARY,
      ...extra,
    });
  };

  const tokenStates = async () => (await fileCommands(file('state'))).filter(([name]) => name === LINEAR_TOKEN_STATE).map(([, value]) => value);

  /** Captures what the step prints, so the test can check it holds no content. */
  const quietly = async (work: () => Promise<void>): Promise<string> => {
    const write = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await work();
    } finally {
      process.stdout.write = write;
    }
    return printed;
  };

  const runInitialSync = async (world: FakeWorld, confirm: string) => {
    step({ operation: 'initial-sync', direction: 'git-to-linear', confirm });
    const printed = await quietly(() => runMain({ fetch: fakeFetch(world) }));
    assert.ok(!printed.includes(CANARY), 'the step printed content');
    // The runner consumes mask commands; it never logs them.
    const logged = printed.replace(/^::add-mask::.*$/gm, '');
    for (const secret of ['client-secret', 'gh-token', 'fake-token']) assert.ok(!logged.includes(secret), secret);
    const report = JSON.parse(await readFile(file('report.json'), 'utf8')) as RunReport;
    return { printed, report };
  };

  it('L1-20 (offline): a dry run writes nothing, the confirmed run converges, and each revokes its token', async () => {
    const world = fakeWorld();
    const dry = await runInitialSync(world, 'false');
    assert.equal(process.exitCode ?? 0, 0, dry.printed);
    assert.deepEqual(world.writes, [], 'the dry run wrote');
    assert.deepEqual(dry.report.summary?.plan?.create, ['eng/README.md', 'eng/backend/notes.md']);
    // The job summary goes beside the report, for tooling that collects both.
    const summary = await readFile(file('summary.md'), 'utf8');
    assert.match(summary, /eng\/backend\/notes\.md/);
    assert.ok(!summary.includes(CANARY));
    assert.equal(world.minted, 1);
    assert.equal(world.revoked, 1);
    // The token went to the step's state for `post`, and was taken back once revoked.
    assert.deepEqual(await tokenStates(), ['fake-token', '']);
    assert.match(dry.printed, /::add-mask::fake-token/);

    await writeFile(file('state'), '');
    const confirmed = await runInitialSync(world, 'true');
    assert.equal(process.exitCode ?? 0, 0, confirmed.printed);
    const titles = world.linear.documents.filter((d) => d.trashed !== true).map((d) => d.title).sort();
    assert.deepEqual(titles, ['README', 'backend/notes']);
    assert.notEqual(await fixture.remote.text(['rev-parse', '--verify', '--quiet', 'refs/mdbisync/linear']).catch(() => ''), '');
    assert.equal(world.minted, 2);
    assert.equal(world.revoked, 2);
    assert.deepEqual(await tokenStates(), ['fake-token', '']);

    // L2-37 (offline): the sync entry point on the converged repository writes nothing and revokes its token.
    await writeFile(file('state'), '');
    const writes = world.writes.length;
    step({ operation: 'sync' });
    const synced = await quietly(() => runMain({ fetch: fakeFetch(world) }));
    assert.equal(process.exitCode ?? 0, 0, synced);
    assert.ok(!synced.includes(CANARY), 'the sync printed content');
    assert.equal(world.writes.length, writes, 'a converged sync wrote');
    assert.equal(world.minted, 3);
    assert.equal(world.revoked, 3);
    assert.deepEqual(await tokenStates(), ['fake-token', '']);
  });

  it('a run whose revocation failed leaves the token in the state for post, which revokes it', async () => {
    const world = fakeWorld();
    const fetchWithoutRevoke: typeof fetch = async (input, init) =>
      String(input).endsWith('/oauth/revoke') ? new Response('{}', { status: 503 }) : fakeFetch(world)(input, init);
    step({ operation: 'initial-sync', direction: 'git-to-linear', confirm: 'false' });
    const printed = await quietly(() => runMain({ fetch: fetchWithoutRevoke }));
    assert.match(printed, /::warning::the run's Linear token could not be revoked/);
    assert.equal(process.exitCode ?? 0, 0, printed);
    assert.deepEqual(await tokenStates(), ['fake-token']);

    // The runner hands the state to the post step as STATE_<name>.
    step({}, { [`STATE_${LINEAR_TOKEN_STATE}`]: 'fake-token' });
    const post = await quietly(() => runPost({ fetch: fakeFetch(world) }));
    assert.match(post, /post: revoked the run's Linear token/);
    assert.match(post, /::add-mask::fake-token/);
    assert.equal(world.revoked, 1);
    assert.equal(process.exitCode ?? 0, 0);
  });

  it('post has nothing to do after a run that revoked its token, and only warns when Linear refuses', async () => {
    const world = fakeWorld();
    step({});
    assert.match(await quietly(() => runPost({ fetch: fakeFetch(world) })), /post: no Linear token left to revoke/);
    assert.equal(world.requests.length, 0);

    step({}, { [`STATE_${LINEAR_TOKEN_STATE}`]: 'stale-token' });
    const refused = await quietly(() => runPost({ fetch: async () => new Response('{}', { status: 400 }) }));
    assert.match(refused, /::warning::post: the run's Linear token could not be revoked/);
    assert.equal(process.exitCode ?? 0, 0);
  });

  it('git authenticates with the App token through each call, never through the repository configuration', async () => {
    // Configuration an earlier step gave git through the environment stays.
    assert.deepEqual(Object.keys(gitAuthEnv('t', 'https://github.com', { GIT_CONFIG_COUNT: '2' })).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2']);
    assert.equal(gitAuthEnv('t', 'https://github.com', { GIT_CONFIG_COUNT: '2' })['GIT_CONFIG_COUNT'], '3');
    const env = gitAuthEnv('app-token', 'https://github.com', {});
    const git = new Git(workspace, env);
    const header = await git.text(['config', '--get', 'http.https://github.com/.extraheader']);
    assert.equal(header.trim(), `AUTHORIZATION: basic ${Buffer.from('x-access-token:app-token').toString('base64')}`);
    const stored = await readFile(join(workspace, '.git', 'config'), 'utf8');
    assert.ok(!stored.includes('extraheader') && !stored.includes('app-token'));
    // Only the server the workflow runs on gets the header.
    assert.equal(gitAuthEnv('t', 'https://ghe.example.com/', {})['GIT_CONFIG_KEY_0'], 'http.https://ghe.example.com/.extraheader');
  });
});
