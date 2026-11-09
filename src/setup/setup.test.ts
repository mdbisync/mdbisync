import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LinearClient } from '../linear/index.ts';
import { type RepositoryMapping, resolveZones } from '../mapping/index.ts';
import {
  CHECK_NAMES,
  checkGitHub,
  checkLinearFormatHook,
  checkSyncState,
  readHookConfig,
  renderSetupSummary,
  runSetupCheck,
  securityHooks,
} from './index.ts';
import { GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from './test-helpers.ts';
import { resolveTargets } from './linear.ts';
import { DEFAULT_STATE_CONFIG } from '../state/index.ts';
import type { Nodes } from 'mdast';
import { parse, visit } from '../format/markdown.ts';

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
  return { annotations, zones: resolveZones(annotations).zones, problems: [], documents: [], unsynced: [], leftOut: [] };
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

  it('requires the linear-format hook from a hook repository', () => {
    assert.deepEqual(checkLinearFormatHook(readHookConfig(PRE_COMMIT)), {
      name: 'linear-format-hook',
      state: 'passed',
      detail: '.pre-commit-config.yaml has the linear-format hook',
    });
    const local = 'repos:\n  - repo: local\n    hooks:\n      - id: linear-format\n        name: x\n        entry: x\n        language: system\n';
    for (const text of [null, 'repos: []\n', local]) {
      const result = checkLinearFormatHook(readHookConfig(text));
      assert.equal(result.code, 'linear-format-hook-required', String(text));
      assert.equal(result.detail, '.pre-commit-config.yaml has no linear-format hook');
    }
    assert.equal(checkLinearFormatHook(readHookConfig('repos: [')).detail, '.pre-commit-config.yaml is not valid YAML');
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

  it('treats a rate-limit 403 as an error of the run, not a missing permission', async () => {
    const world = fakeWorld();
    world.github.rateLimited = true;
    await assert.rejects(checkGitHub(target(world)), /GitHub rate-limited the setup check while checking contents:write/);
    const first = fakeWorld();
    first.github.rateLimitedRepository = true;
    await assert.rejects(checkGitHub(target(first)), /GitHub rate-limited the setup check while reading the repository/);
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
    assert.equal(world.requests.filter((request) => request.startsWith(`POST ${LINEAR_API}`)).length, 1);
    assert.deepEqual(world.writes, []);
  });

  it('names the files a title collision leaves out, without stopping the run', async () => {
    const place = { kind: 'project' as const, team: 'ENG', project: 'Field notes' };
    const leftOut = (path: string, other: string) => ({ path, oid: '0'.repeat(40), rule: 'duplicate-title' as const, title: 'guide', place, collidesWith: [other] });
    const map = { ...MINI, leftOut: [leftOut('eng/notes/guide.md', 'eng/notes/Guide.md'), leftOut('eng/notes/Guide.md', 'eng/notes/guide.md')] };
    const { report } = await run(fakeWorld(), map);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.find((check) => check.name === 'left-out-files'), {
      name: 'left-out-files',
      state: 'warning',
      detail: '2 files left out, not synced: eng/notes/Guide.md (duplicate-title), eng/notes/guide.md (duplicate-title)',
    });
    const many = { ...MINI, leftOut: Array.from({ length: 23 }, (_, index) => leftOut(`f/${String(index).padStart(2, '0')}.md`, 'x')) };
    const detail = (await run(fakeWorld(), many)).report.checks.find((check) => check.name === 'left-out-files')?.detail ?? '';
    assert.match(detail, /^23 files left out, not synced: f\/00\.md \(duplicate-title\), .*f\/19\.md \(duplicate-title\), and 3 more$/);
    assert.equal((await run(fakeWorld())).report.checks.find((check) => check.name === 'left-out-files')?.state, 'passed');
  });

  it('goes on without security hooks and says content is pushed unchecked', async () => {
    const { report } = await run(fakeWorld(), MINI, PRE_COMMIT.slice(0, PRE_COMMIT.indexOf('  - repo: local')));
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

  it('fails when two folders map to one Linear project or one team zone, also when named by key and by name', async () => {
    const cases: Array<[RepositoryMapping, RegExp]> = [
      [
        mapping([
          { folder: 'eng', readme: 'eng/README.md', team: 'ENG' },
          { folder: 'platform', readme: 'platform/README.md', team: 'Engineering' },
        ]),
        /the documents of team "Engineering" \(eng\/, platform\/\)/,
      ],
      [
        mapping([
          { folder: 'a', readme: 'a/README.md', team: 'ENG', project: 'Field notes' },
          { folder: 'b', readme: 'b/README.md', team: 'Engineering', project: 'Field notes' },
        ]),
        /project "Field notes" \(a\/, b\/\)/,
      ],
    ];
    for (const [map, named] of cases) {
      const { report, targets } = await run(fakeWorld(), map);
      assert.equal(report.code, 'annotation-target-shared');
      assert.match(report.checks.find((check) => check.name === 'annotation-targets')?.detail ?? '', named);
      assert.equal(targets, undefined);
    }
  });

  it('looks up many annotated teams in pages and finds every one', async () => {
    const world = fakeWorld();
    const many = Array.from({ length: 130 }, (_, index) => ({ id: `team-${index}`, key: `T${index}`, name: `Team ${index}` }));
    world.linear.teams = many;
    world.linear.projects = [];
    const map = mapping(many.map((team, index) => ({ folder: `t${index}`, readme: `t${index}/README.md`, team: index % 2 === 0 ? team.key : team.name })));
    const { report, targets } = await run(world, map);
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(targets?.teams.size, 130);
    assert.equal(world.requests.filter((request) => request.startsWith(`POST ${LINEAR_API}/graphql`)).length, 2);
  });

  it('asks again a token that saw no team, and tells no team access from a missing team', async () => {
    const lookups = (world: ReturnType<typeof fakeWorld>) => world.requests.filter((request) => request.startsWith(`POST ${LINEAR_API}/graphql`)).length;
    const resolve = (world: ReturnType<typeof fakeWorld>) =>
      resolveTargets(new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fakeFetch(world) }), MINI.zones.values(), 0);

    const once = fakeWorld();
    once.linear.teamsHidden = 1;
    const recovered = await resolve(once);
    assert.equal(recovered.result.state, 'passed', recovered.result.detail);
    assert.equal(lookups(once), 2);

    const never = fakeWorld();
    never.linear.teamsHidden = Infinity;
    const hidden = await resolve(never);
    assert.equal(hidden.result.code, 'linear-teams-not-visible');
    assert.match(hidden.result.detail, /saw no team in two lookups/);
    assert.equal(hidden.targets, undefined);
    assert.equal(lookups(never), 2);

    const elsewhere = fakeWorld();
    elsewhere.linear.teams = [{ id: 'team-other', key: 'OPS', name: 'Operations' }];
    const missing = await resolve(elsewhere);
    assert.equal(missing.result.code, 'annotation-target-not-found');
    assert.equal(lookups(elsewhere), 1, 'a token that sees teams is asked once');
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
    assert.match(summary, /\| github-access \| FAILED \| the GitHub token lacks workflows:write \(\[how to fix\]\(https:\/\/github\.com\/mdbisync\/mdbisync\/blob\/main\/docs\/quickstart\.md#github-app\)\) \|/);
    assert.match(summary, /\| linear-format-hook \| passed \|/);
  });

  it('keeps a detail with backslashes and pipes inside its table cell', () => {
    const summary = renderSetupSummary({
      ok: true,
      securityHooks: [],
      checks: [{ name: 'github-access', state: 'passed', detail: 'C:\\dir\\|a|b\nnext\rlast' }],
    });
    const table = parse(summary).children.find((node) => node.type === 'table');
    assert.ok(table?.type === 'table');
    const text = (cell: Nodes) => {
      let out = '';
      visit(cell, (node) => { if (node.type === 'text') out += node.value; });
      return out;
    };
    const cells = table.children[1]!.children.map(text);
    assert.deepEqual(cells, ['github-access', 'passed', 'C:\\dir\\|a|b next last']);
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
