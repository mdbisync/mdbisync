import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LinearClient } from '../linear/index.ts';
import { resolveZones } from '../mapping/index.ts';
import { type OperationOutcome } from '../run/operation.ts';
import { stoppedBeforeWritingMessage } from '../run/exit.ts';
import { APP_PERMISSIONS, appCreationUrl, appManifest } from './app.ts';
import { FIX_ANCHORS, QUICKSTART_PATH, QUICKSTART_URL, fixUrl } from './fixes.ts';
import { PERMISSION_PROBES, checkGitHub } from './github.ts';
import { readHookConfig } from './hooks.ts';
import { checkSyncState, renderSetupSummary, renderStateRefusal, runSetupCheck } from './index.ts';
import { DEFAULT_STATE_CONFIG } from '../state/index.ts';
import { GITHUB_API, LINEAR_API, fakeFetch, fakeWorld } from './test-helpers.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

/** The permissions the sync's GitHub App needs, as the setup decision lists them. */
const REQUIRED = {
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  checks: 'read',
  statuses: 'read',
};

/** GitHub's anchor for a Markdown heading. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function anchors(markdown: string): Set<string> {
  const found = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) found.add(slug(heading[1]));
  }
  return found;
}

describe('the GitHub App', () => {
  it('requests exactly the needed permissions, the same the setup check probes', () => {
    assert.deepEqual({ ...APP_PERMISSIONS }, REQUIRED);
    assert.deepEqual(
      PERMISSION_PROBES.map((probe) => probe.permission),
      Object.entries(REQUIRED).map(([name, access]) => `${name}:${access}`),
    );
  });

  it('has a manifest file equal to the manifest, with those permissions, no webhook and no events', () => {
    const manifest = JSON.parse(read('docs/github-app-manifest.json')) as {
      default_permissions: unknown;
      hook_attributes: { active: unknown };
      public: unknown;
      default_events: unknown;
    };
    assert.deepEqual(manifest, appManifest());
    assert.deepEqual(manifest.default_permissions, REQUIRED);
    assert.equal(manifest.hook_attributes.active, false);
    assert.equal(manifest.public, false);
    assert.deepEqual(manifest.default_events, []);
  });

  it('has a creation link with those permissions, shown in the quickstart', () => {
    for (const [organization, base] of [
      [undefined, 'https://github.com/settings/apps/new'],
      ['acme', 'https://github.com/organizations/acme/settings/apps/new'],
    ] as const) {
      const url = new URL(appCreationUrl(organization));
      assert.equal(`${url.origin}${url.pathname}`, base);
      const permissions = Object.fromEntries([...url.searchParams].filter(([name]) => name in REQUIRED));
      assert.deepEqual(permissions, REQUIRED);
      assert.equal(url.searchParams.get('webhook_active'), 'false');
      assert.equal(url.searchParams.get('public'), 'false');
      // Every other parameter is a setting GitHub's form knows, not a permission.
      assert.deepEqual([...url.searchParams.keys()].filter((name) => !(name in REQUIRED)).sort(), ['description', 'public', 'url', 'webhook_active']);
    }
    assert.ok(read(QUICKSTART_PATH).includes(`](${appCreationUrl()})`), 'the quickstart links the creation URL');
  });
});

describe('fix links', () => {
  const quickstart = anchors(read(QUICKSTART_PATH));

  it('point every failure at a quickstart section that exists', () => {
    for (const [code, anchor] of Object.entries(FIX_ANCHORS)) {
      assert.ok(quickstart.has(anchor), `${code}: ${QUICKSTART_PATH} has no section #${anchor}`);
      assert.equal(fixUrl(code), `${QUICKSTART_URL}#${anchor}`);
    }
    assert.equal(fixUrl('stopped'), undefined);
    assert.equal(fixUrl(undefined), undefined);
  });

  it('resolve every quickstart link in the docs', () => {
    for (const path of ['README.md', 'docs/usage.md', QUICKSTART_PATH]) {
      for (const match of read(path).matchAll(/\]\((?:docs\/)?quickstart\.md#([^)]+)\)/g)) {
        assert.ok(quickstart.has(match[1] as string), `${path} links #${match[1]}, which ${QUICKSTART_PATH} does not have`);
      }
    }
  });
});

describe('setup check failures L5-01 to L5-05', () => {
  const PRE_COMMIT = 'repos:\n  - repo: https://github.com/example/linear-format\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n';
  const annotations = [
    { folder: 'eng', readme: 'eng/README.md', team: 'ENG' },
    { folder: 'combined', readme: 'combined/README.md', team: 'Docs', project: 'Handbook' },
  ];
  const MAPPING = { annotations, zones: resolveZones(annotations).zones, problems: [], documents: [], unsynced: [], leftOut: [] };
  type World = ReturnType<typeof fakeWorld>;
  const scenarios: Array<{ id: string; change: (world: World) => void; hooks?: string; linearError?: string; anchor: string; names: RegExp }> = [
    { id: 'L5-01 refused credentials', change: () => {}, linearError: 'Linear refused the OAuth app client credentials', anchor: 'linear-oauth-app', names: /client credentials/ },
    { id: 'L5-01 token without write', change: (world) => (world.linear.scope = ['read']), anchor: 'linear-oauth-app', names: /scope write/ },
    ...PERMISSION_PROBES.map((probe) => ({
      id: `L5-02 without ${probe.permission}`,
      change: (world: World) => world.github.missing.add(probe.permission),
      anchor: 'github-app',
      names: new RegExp(probe.permission),
    })),
    { id: 'L5-02 App not installed', change: (world) => (world.github.tokenValid = false), anchor: 'github-app', names: /GitHub token/ },
    { id: 'L5-03 merge commits not allowed', change: (world) => (world.github.allowMergeCommit = false), anchor: 'merge-commits', names: /merge commits/ },
    { id: 'L5-04 no Linear-format hook', change: () => {}, hooks: 'repos: []\n', anchor: 'linear-format-hook', names: /linear-format hook/ },
    { id: 'L5-05 team missing', change: (world) => (world.linear.teams = world.linear.teams.filter((team) => team.key !== 'ENG')), anchor: 'folder-annotations', names: /team "ENG"/ },
    { id: 'L5-05 project renamed', change: (world) => ((world.linear.projects[1] as { name: string }).name = 'Guide'), anchor: 'folder-annotations', names: /project "Handbook" of team "Docs"/ },
  ];
  const quickstart = anchors(read(QUICKSTART_PATH));

  for (const scenario of scenarios) {
    it(`${scenario.id}: names the missing piece and links the section that fixes it`, async () => {
      const world = fakeWorld();
      scenario.change(world);
      const target = { repository: 'owner/repo', token: 'gh-token', commit: 'a'.repeat(40), apiUrl: GITHUB_API, fetch: fakeFetch(world) };
      const client = new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
      const { report } = await runSetupCheck({
        mapping: MAPPING,
        hooks: readHookConfig(scenario.hooks ?? PRE_COMMIT),
        github: await checkGitHub(target),
        linear: scenario.linearError === undefined ? { client, scope: world.linear.scope } : { error: scenario.linearError },
      });
      assert.equal(report.ok, false);
      assert.ok(quickstart.has(scenario.anchor), `${QUICKSTART_PATH} has #${scenario.anchor}`);
      const link = `${QUICKSTART_URL}#${scenario.anchor}`;

      const summary = renderSetupSummary(report);
      assert.ok(summary.includes(`How to fix it: ${link}`), summary);
      const row = summary.split('\n').find((line) => line.includes('| FAILED |')) ?? '';
      assert.match(row, scenario.names);
      assert.ok(row.includes(`([how to fix](${link}))`), row);

      const outcome = { operation: 'sync', ok: false, code: report.code, setup: report } as OperationOutcome;
      const message = stoppedBeforeWritingMessage('sync', outcome);
      assert.match(message, scenario.names);
      assert.ok(message.endsWith(`. How to fix it: ${link}`), message);
    });
  }

  it('links initial sync when the sync has no state', () => {
    const refusal = checkSyncState({ linear: null, ids: null, uploads: null }, DEFAULT_STATE_CONFIG);
    assert.ok(refusal !== null);
    assert.ok(renderStateRefusal(refusal).includes(`How to fix it: ${QUICKSTART_URL}#initial-sync`));
    assert.ok(quickstart.has('initial-sync'));
  });
});
