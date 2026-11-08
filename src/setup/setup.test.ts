import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LinearClient } from '../linear/index.ts';
import { type RepositoryMapping } from '../mapping/index.ts';
import {
  CHECK_NAMES,
  checkGitHub,
  checkLinearFormatHookPending,
  checkSyncState,
  readHookConfig,
  renderSetupSummary,
  runSetupCheck,
  securityHooks,
} from './index.ts';
import { GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from './test-helpers.ts';
import { DEFAULT_STATE_CONFIG } from '../state/index.ts';

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/linear-format
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: no-test-secrets
        alias: security
        name: no test secrets
        language: pygrep
        entry: 'TESTKEY-[0-9a-f]{24}'
`;

const target = (world: ReturnType<typeof fakeWorld>) => ({ repository: 'owner/repo', token: 'gh-token', commit: 'a'.repeat(40), apiUrl: GITHUB_API, fetch: fakeFetch(world) });

function mapping(annotations: RepositoryMapping['annotations']): RepositoryMapping {
  return { annotations, problems: [], documents: [], unsynced: [], leftOut: [] };
}

const MINI = mapping([
  { folder: 'eng', readme: 'eng/README.md', team: 'ENG' },
  { folder: 'eng/notes', readme: 'eng/notes/README.md', project: 'Field notes' },
  { folder: 'combined', readme: 'combined/README.md', team: 'Docs', project: 'Handbook' },
]);

describe('pre-commit hooks', () => {
  it('finds the hooks marked alias: security', () => {
    assert.deepEqual(securityHooks(readHookConfig(PRE_COMMIT)), ['no-test-secrets']);
    assert.deepEqual(securityHooks(readHookConfig(null)), []);
    assert.equal(readHookConfig('repos: [').invalid, '.pre-commit-config.yaml is not valid YAML');
  });

  it('PENDING: the Linear-format hook item reports not-checked until the hook exists', () => {
    assert.deepEqual(checkLinearFormatHookPending(readHookConfig(PRE_COMMIT)), {
      name: 'linear-format-hook',
      state: 'not-checked',
      detail: 'the Linear-format hook check is not implemented yet',
    });
    assert.equal(checkLinearFormatHookPending(readHookConfig('repos: [')).code, 'linear-format-hook-required');
  });
});

describe('GitHub access', () => {
  it('passes a token with every permission, without writing', async () => {
    const world = fakeWorld();
    const result = await checkGitHub(target(world));
    assert.equal(result.access.state, 'passed');
    assert.equal(result.mergeCommits.state, 'passed');
    assert.equal(world.requests.length, 6);
    assert.deepEqual(world.writes, []);
  });

  it('names each missing permission', async () => {
    for (const permission of ['contents:write', 'pull_requests:write', 'workflows:write', 'checks:read', 'statuses:read']) {
      const world = fakeWorld();
      world.github.missing.add(permission);
      const result = await checkGitHub(target(world));
      assert.equal(result.access.code, 'missing-permission', permission);
      const unchecked = permission === 'contents:write' ? ' (workflows:write not checked without it)' : '';
      assert.equal(result.access.detail, `the GitHub token lacks ${permission}${unchecked}`);
      assert.equal(result.mergeCommits.state, permission === 'contents:write' ? 'not-checked' : 'passed');
    }
  });

  it('stops on disallowed merge commits and on a refused token', async () => {
    const world = fakeWorld();
    world.github.allowMergeCommit = false;
    assert.equal((await checkGitHub(target(world))).mergeCommits.code, 'merge-commits-required');
    world.github.tokenValid = false;
    const refused = await checkGitHub(target(world));
    assert.equal(refused.access.code, 'github-credential-failed');
    assert.equal(refused.mergeCommits.state, 'not-checked');
  });
});

describe('setup check', () => {
  const run = async (world: ReturnType<typeof fakeWorld>, map = MINI, hooks = PRE_COMMIT) => {
    const client = new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
    return runSetupCheck({ mapping: map, hooks: readHookConfig(hooks), github: await checkGitHub(target(world)), linear: { client, scope: world.linear.scope } });
  };

  it('passes a correct setup, lists every item and resolves the targets', async () => {
    const world = fakeWorld();
    const { report, targets } = await run(world);
    assert.equal(report.ok, true);
    assert.equal(report.code, undefined);
    assert.deepEqual(report.checks.map((check) => check.name), [...CHECK_NAMES]);
    assert.deepEqual(report.securityHooks, ['no-test-secrets']);
    assert.equal(targets?.teams.get('ENG')?.id, 'team-eng');
    assert.equal(targets?.teams.get('Docs')?.id, 'team-docs');
    assert.equal(targets?.projects.get('ENG\0Field notes')?.id, 'project-api');
    assert.equal(world.requests.filter((request) => request.startsWith(`POST ${LINEAR_API}`)).length, 2);
    assert.deepEqual(world.writes, []);
  });

  it('goes on without security hooks and says content is pushed unchecked', async () => {
    const { report } = await run(fakeWorld(), MINI, 'repos: []\n');
    assert.equal(report.ok, true);
    assert.deepEqual(report.securityHooks, []);
    const item = report.checks.find((check) => check.name === 'security-hooks');
    assert.equal(item?.state, 'warning');
    assert.match(item?.detail ?? '', /pushed unchecked/);
  });

  it('names a missing, renamed or ambiguous team or project', async () => {
    const cases: Array<[string, (world: ReturnType<typeof fakeWorld>) => void, string, RegExp]> = [
      ['missing team', (world) => (world.linear.teams = world.linear.teams.filter((team) => team.key !== 'ENG')), 'annotation-target-not-found', /team "ENG"/],
      ['renamed team', (world) => ((world.linear.teams[1] as { name: string }).name = 'Documentation'), 'annotation-target-not-found', /team "Docs"/],
      ['missing project', (world) => (world.linear.projects = world.linear.projects.slice(1)), 'annotation-target-not-found', /project "Field notes" of team "ENG"/],
      ['renamed project', (world) => ((world.linear.projects[1] as { name: string }).name = 'Guide'), 'annotation-target-not-found', /project "Handbook" of team "Docs"/],
      ['project in another team', (world) => ((world.linear.projects[0] as { teamIds: string[] }).teamIds = ['team-docs']), 'annotation-target-not-found', /project "Field notes"/],
      ['two projects', (world) => world.linear.projects.push({ id: 'p2', name: 'Handbook', teamIds: ['team-docs'] }), 'annotation-target-ambiguous', /project "Handbook"/],
      ['key of one team, name of another', (world) => world.linear.teams.push({ id: 't3', key: 'DOC', name: 'ENG' }), 'annotation-target-ambiguous', /team "ENG"/],
    ];
    for (const [label, change, code, named] of cases) {
      const world = fakeWorld();
      change(world);
      const { report, targets } = await run(world);
      assert.equal(report.ok, false, label);
      assert.equal(report.code, code, label);
      assert.match(report.checks.find((check) => check.name === 'annotation-targets')?.detail ?? '', named, label);
      assert.equal(targets, undefined, label);
    }
  });

  it('fails on refused Linear credentials or a token without write', async () => {
    const world = fakeWorld();
    const github = await checkGitHub(target(world));
    const refused = await runSetupCheck({ mapping: MINI, hooks: readHookConfig(PRE_COMMIT), github, linear: { error: 'Linear refused the OAuth app client credentials' } });
    assert.equal(refused.report.code, 'linear-credential-failed');
    assert.match(refused.report.checks[0]?.detail ?? '', /credentials/);
    assert.equal(refused.report.checks.find((check) => check.name === 'annotation-targets')?.state, 'not-checked');

    world.linear.scope = ['read'];
    const readOnly = await run(world);
    assert.equal(readOnly.report.code, 'linear-credential-failed');
    assert.match(readOnly.report.checks[0]?.detail ?? '', /lacks the scope write/);
  });

  it('fails on annotation problems and on a repository without annotations', async () => {
    const broken = { ...MINI, problems: [{ readme: 'eng/README.md', kind: 'invalid-annotation' as const, message: 'eng/README.md: linear-team must be a non-empty name' }] };
    const invalid = await run(fakeWorld(), broken);
    assert.equal(invalid.report.code, 'invalid-annotation');
    assert.equal(invalid.report.checks.find((check) => check.name === 'annotation-targets')?.state, 'not-checked');
    assert.equal((await run(fakeWorld(), mapping([]))).report.code, 'no-annotations');
  });

  it('renders a summary of names and states', async () => {
    const world = fakeWorld();
    world.github.missing.add('workflows:write');
    const { report } = await run(world);
    const summary = renderSetupSummary(report);
    assert.match(summary, /^## Setup check\n\nStopped before any write: `missing-permission`\./);
    assert.match(summary, /\| github-access \| FAILED \| the GitHub token lacks workflows:write \|/);
    assert.match(summary, /\| linear-format-hook \| not checked \|/);
  });
});

describe('the sync without state', () => {
  it('refuses to run without the linear state ref', () => {
    const refusal = checkSyncState({ linear: null, ids: null, uploads: null }, DEFAULT_STATE_CONFIG);
    assert.deepEqual(refusal, {
      code: 'initial-sync-required',
      message: 'refs/mdbisync/linear does not exist: run initial sync first. The sync wrote nothing.',
    });
    assert.equal(checkSyncState({ linear: 'a'.repeat(40), ids: null, uploads: null }, DEFAULT_STATE_CONFIG), null);
  });
});
