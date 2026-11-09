import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LinearClient } from '../../../src/linear/index.ts';
import { fakeFetch, fakeWorld, LINEAR_API } from '../../../src/setup/test-helpers.ts';
import { Git } from '../../../src/state/index.ts';
import { countAppRequest, withAppRequests } from './app-reads.ts';
import { budgetHolds, compare, gitLinks, scanCanaries, stripFrontMatter, titleOf } from './checks.ts';
import type { TestConfig } from './config.ts';
import { parseEnvFile, parseRepoUrl } from './config.ts';
import { appJwt } from './github.ts';
import { registerRun } from './locks.ts';
import { evidenceSummary, mergeLatest, readLatest, renderRunMarkdown, renderStatusPage, updateStatusPage, type HarnessReport } from './report.ts';
import { EnvBlockedError, HarnessGapError, NotImplementedError, ProductError, classify, loadExpectedRed, type ScenarioResult } from './results.ts';
import { runScenario, runScenarios } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios } from './spec.ts';
import { HARNESS_GAPS } from './steps.ts';
import { shouldSweep, sweep, SWEEP_AGE_MS } from './sweeper.ts';
import { generateKeyPairSync, createVerify } from 'node:crypto';

const roots: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scenarios = loadScenarios();
const byId = (id: string) => scenarios.find((scenario) => scenario.id === id) ?? assert.fail(id);

describe('results', () => {
  it('classifies by the expected-red list and the kind of failure', () => {
    assert.deepEqual(classify(new NotImplementedError('sync'), true).result, 'expected-red');
    assert.deepEqual(classify(new ProductError('I1 failed'), true).result, 'expected-red');
    assert.deepEqual(classify(new NotImplementedError('sync'), false).result, 'fail');
    assert.deepEqual(classify(new ProductError('I1 failed'), false).result, 'fail');
    assert.deepEqual(classify(new EnvBlockedError('budget'), true), { result: 'env-blocked', reason: 'budget' });
    assert.equal(classify(new HarnessGapError('git.ci-fix'), true).result, 'fail');
    assert.equal(classify(new Error('boom'), true).result, 'fail');
    assert.deepEqual(classify(undefined, false), { result: 'pass' });
    assert.equal(classify(undefined, true).unexpectedPass, true);
  });

  it('lists only known scenarios as expected-red, and none of the offline format scenarios that pass', () => {
    const list = loadExpectedRed();
    const known = new Set(scenarios.map((scenario) => scenario.id));
    for (const id of list) assert.ok(known.has(id), id);
    for (const id of ['L0-01', 'L0-02', 'L0-03', 'L0-04', 'L0-07', 'L0-08']) assert.ok(!list.has(id), id);
  });

  it('has an executor for every step action', () => {
    assert.equal(HARNESS_GAPS.size, 0);
  });
});

describe('check helpers', () => {
  it('compare files and documents the way I1 needs', () => {
    assert.equal(stripFrontMatter('---\na: 1\n---\n# Title\n'), '# Title\n');
    assert.equal(stripFrontMatter('# No front matter\n'), '# No front matter\n');
    assert.equal(titleOf('eng/4f1a9c/guides/start.md', 'eng'), '4f1a9c/guides/start');
    assert.equal(titleOf('eng/alpha/plan.md', 'eng/alpha'), 'plan');
    assert.equal(gitLinks('![x](https://uploads.example.com/a)', 'eng/guides/start.md', { ids: new Map(), documentUrlBase: 'https://linear.app/acme/document', uploads: new Map([['https://uploads.example.com/a', 'eng/img/a.png']]) }), '![x](../img/a.png)');
  });

  it('find canaries without quoting the text around them', () => {
    const hits = scanCanaries(new Map([['run 0 stdout', 'wrote kx-4f1a9c2e'], ['summary', 'clean']]), ['kx-4f1a9c2e', 'kx-00000000']);
    assert.deepEqual(hits, [{ source: 'run 0 stdout', canary: 'kx-4f1a9c2e' }]);
  });

  it('keep new files of a root document at the root', async () => {
    const { sibling } = await import('./steps.ts');
    assert.equal(sibling('plan.md', 'notes.md'), 'notes.md');
    assert.equal(sibling('eng/plan.md', 'notes.md'), 'eng/notes.md');
  });

  it('read comments in small pages, under Linear\'s complexity limit', async () => {
    const { commentsOf, COMMENT_DOCUMENTS_PER_PAGE, COMMENTS_PER_DOCUMENT } = await import('./checks.ts');
    assert.ok(COMMENT_DOCUMENTS_PER_PAGE * COMMENTS_PER_DOCUMENT <= 2_500, 'a page must stay far below the 250 x 50 that Linear refused');
    const pages = [
      { nodes: [{ id: 'd1', project: { id: 'p' }, comments: { nodes: [{ body: 'one' }] } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: [{ id: 'd2', project: null, comments: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const afters: unknown[] = [];
    const client = {
      request: async (_operation: string, _kind: string, query: string, variables?: Record<string, unknown>) => {
        assert.match(query, new RegExp(`documents\\(first: ${COMMENT_DOCUMENTS_PER_PAGE}, after: \\$after`));
        afters.push(variables?.after);
        return { documents: pages[afters.length - 1] } as never;
      },
    };
    const documents = await commentsOf(client as never, { project: { id: { eq: 'p' } } });
    assert.deepEqual(afters, [null, 'c1']);
    assert.deepEqual(documents, [{ id: 'd1', inProject: true, bodies: ['one'] }, { id: 'd2', inProject: false, bodies: [] }]);
  });

  it('look only for canaries in content, since paths may be listed', async () => {
    const { contentCanaries } = await import('./checks.ts');
    const files = [
      { path: 'a.md', canary: 'kx-00000001', canary_in: 'content' as const },
      { path: 'empty-kx-00000002.md', canary: 'kx-00000002', canary_in: 'name' as const },
      { path: 'b.png', canary: null, canary_in: null },
      { path: 'c.md', canary: 'kx-00000003' },
    ];
    assert.deepEqual(contentCanaries(files).map((file) => file.canary), ['kx-00000001', 'kx-00000003']);
  });

  it('hold I9 at 1.5 requests per written document plus 5 per run', () => {
    assert.ok(budgetHolds(155, 100, 1));
    assert.ok(!budgetHolds(156, 100, 1));
  });

  it('evaluate every assertion operator', () => {
    assert.ok(compare('equal', 0, 0));
    assert.ok(compare('same-as', new Set(['b', 'a']), ['a', 'b']));
    assert.ok(compare('contains-all', ['a', 'b', 'c'], ['a', 'c']));
    assert.ok(!compare('contains-all', ['a'], ['a', 'c']));
    assert.ok(compare('at-most', 3, 3) && !compare('at-most', 4, 3));
    assert.ok(compare('at-least', 3, 3) && !compare('at-least', 2, 3));
  });
});

describe('configuration and GitHub App', () => {
  it('reads secrets files and sandbox URLs', () => {
    assert.deepEqual(parseEnvFile('A_B=1\nexport C="two"\n# note\nlower=x\n'), { A_B: '1', C: 'two' });
    assert.deepEqual(parseRepoUrl('https://github.com/acme/sandbox.git'), { owner: 'acme', repo: 'sandbox' });
    assert.equal(parseRepoUrl('git@github.com:acme/sandbox.git'), null);
  });

  it('signs an App JWT that the public key verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt('Iv1.test', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 1_000_000);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), { iat: 999_940, exp: 1_000_540, iss: 'Iv1.test' });
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  });
});

describe('reports', () => {
  const result = (id: string, outcome: ScenarioResult['result'], extra: Partial<ScenarioResult> = {}): ScenarioResult => ({
    id, level: id.split('-')[0] as string, slice: 'mini', mode: 'local', runId: '4f1a9c', result: outcome, startedAt: '2026-11-08T23:00:00.000Z',
    durationMs: 1000, engineRequests: 3, harnessRequests: 2, harnessAppRequests: 4, budgetWaitMs: 0, checks: [], cleanup: { ok: true }, ...extra,
  });
  const report: HarnessReport = {
    harnessRunId: '2026-11-08-abc123', startedAt: '2026-11-08T23:00:00.000Z', finishedAt: '2026-11-08T23:10:00.000Z', host: 'test', selection: {},
    results: [result('L1-04', 'expected-red', { reason: 'not implemented: initial-sync' }), result('L2-01', 'pass', { unexpectedPass: true }), result('L6-01', 'env-blocked', { reason: 'ui | browser' })],
  };

  it('write a run report with counts and the passing expected-red scenarios', () => {
    const markdown = renderRunMarkdown(report);
    assert.match(markdown, /\| 1 \| 0 \| 1 \| 1 \| 0 \|/);
    assert.match(markdown, /ui \\\| browser/);
    assert.match(markdown, /remove them from the list\): L2-01/);
  });

  it('rewrite the status page from the latest result of each scenario, keeping other sections', () => {
    const dir = fresh('status-');
    const file = join(dir, 'test-status.md');
    writeFileSync(file, '---\ntitle: test-status\nstatus: generated\n---\n\n# Test status\n\nold text\n\n## UI environment (L6)\n\nReady.\n');
    const catalog = scenarios.map((scenario) => scenario.id);
    updateStatusPage(file, catalog, report);
    const page = readFileSync(file, 'utf8');
    assert.ok(page.startsWith('---\ntitle: test-status\n'));
    assert.match(page, /## UI environment \(L6\)\n\nReady\./);
    assert.match(page, /\| L1 Initial sync git → Linear \| 20 \| 0 \| 1 \| 0 \| 0 \| 0 \| 19 \|/);
    assert.match(page, /\| L1-04 \| expected-red \| not implemented: initial-sync \|/);
    assert.doesNotMatch(page, /old text/);
    // A later run keeps earlier results it did not repeat; a skipped result does not replace a real one.
    updateStatusPage(file, catalog, { ...report, harnessRunId: 'later', results: [result('L1-04', 'skipped'), result('L1-05', 'expected-red')] });
    const latest = readLatest(readFileSync(file, 'utf8'));
    assert.equal(latest.find((entry) => entry.id === 'L1-04')?.result, 'expected-red');
    assert.equal(latest.find((entry) => entry.id === 'L1-05')?.harnessRunId, 'later');
    assert.equal(latest.find((entry) => entry.id === 'L6-01')?.result, 'env-blocked');
    assert.equal(mergeLatest([], report).length, 3);
    assert.match(renderStatusPage(catalog, [], { frontMatter: '---\n---\n', preserved: '' }), /\| L0-01 \| not run \|/);
  });

  it('summarize evidence with counts and no content', () => {
    const summary = evidenceSummary(report);
    assert.match(summary, /Scenarios: 3; pass: 1, fail: 0, expected-red: 1, env-blocked: 1, skipped: 0/);
    assert.match(summary, /engine 9, harness editors 6, harness app reads 12;/);
    assert.match(summary, /\| L1-04 \| expected-red \| 4 \| not implemented: initial-sync \|/);
    assert.match(renderRunMarkdown(report), /\| L2-01 \| 4f1a9c \| pass \(expected red\) \|  \| 3 \| 4 \| 1 \| ok \|/);
  });

  it('count the harness\'s requests through the app per scenario, even when scenarios run in parallel', async () => {
    const world = fakeWorld();
    world.linear.documents.push({ id: 'doc-1', title: 'Plan', teamId: 'team-eng', createdAt: '2026-02-01T00:00:00.000Z' });
    // One app client shared by every scenario, as the harness has it.
    const app = new LinearClient({ token: 'fake-token', baseUrl: LINEAR_API, fetch: fakeFetch(world), hooks: { beforeRequest: countAppRequest } });
    const reads = (count: number) => async () => {
      for (let index = 0; index < count; index += 1) {
        await app.getDocument('doc-1');
        await new Promise((resolve) => setImmediate(resolve));
      }
      return count;
    };
    const [one, two] = await Promise.all([withAppRequests(reads(2)), withAppRequests(reads(5))]);
    assert.deepEqual([one, two], [{ result: 2, requests: 2 }, { result: 5, requests: 5 }]);
    // A request outside any scenario counts for none.
    await app.getDocument('doc-1');
    assert.equal(app.stats.total, 8);
  });
});

function deps(config: Partial<TestConfig> = {}) {
  return {
    config: { sandboxUrl: '', gitUrl: '', owner: '', repo: '', linearApps: [], editors: { 'editor-a': '', 'editor-b': '' }, githubApp: null, githubAppMissing: ['SYNC_APP_CLIENT_ID'], missing: ['LINEAR_TEST_APP_CLIENT_ID'], ...config },
    governor: null,
    appClients: new Map(),
    stateDir: fresh('runner-state-'),
    outDir: fresh('runner-out-'),
    // Every scenario on the list, so runner tests do not depend on which features have landed.
    expectedRed: new Set(scenarios.map((scenario) => scenario.id)),
    log: () => {},
  };
}

/** Runs `body` with MDBISYNC_ENGINE pointing at a stub engine script. */
async function withStubEngine<T>(script: string, body: () => Promise<T>): Promise<T> {
  const file = join(fresh('stub-engine-'), 'engine.mjs');
  writeFileSync(file, script);
  const before = process.env.MDBISYNC_ENGINE;
  process.env.MDBISYNC_ENGINE = file;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.MDBISYNC_ENGINE;
    else process.env.MDBISYNC_ENGINE = before;
  }
}
const NOT_IMPLEMENTED = `const codes = { sync: 10, 'initial-sync': 11, lint: 12, fix: 13, init: 14, check: 15 };
const command = process.argv[2];
process.stderr.write(command + ': not implemented\\n');
process.exitCode = codes[command];
`;

describe('runner', () => {
  it('runs an offline scenario to expected-red when the engine answers "not implemented"', async () => {
    const result = await withStubEngine(NOT_IMPLEMENTED, () => runScenario(byId('L0-01'), deps()));
    assert.equal(result.result, 'expected-red');
    assert.match(result.reason ?? '', /not implemented: fix/);
    assert.equal(result.cleanup.ok, true);
  });

  it('fails a scenario, as the harness\'s gap, when it cannot observe an assertion\'s subject', async () => {
    const base = byId('L0-04');
    const scenario = { ...base, checks: { ...base.checks, assertions: [{ subject: 'nothing.known', operator: 'equal' as const, expected: 0 }] } };
    const result = await withStubEngine('process.exitCode = 0;\n', () => runScenario(scenario, deps()));
    assert.equal(result.result, 'fail');
    assert.match(result.reason ?? '', /harness: .*assertion subject nothing\.known/);
  });

  it('computes the offline format subjects and fails a fix that is not idempotent', async () => {
    // A stub `fix` that changes every file again on each pass.
    const growing = [
      "const { readdirSync, readFileSync, writeFileSync, statSync } = await import('node:fs');",
      "const walk = (dir) => readdirSync(dir).flatMap((name) => statSync(`${dir}/${name}`).isDirectory() ? walk(`${dir}/${name}`) : [`${dir}/${name}`]);",
      "for (const file of walk('.').filter((path) => path.endsWith('.md'))) writeFileSync(file, readFileSync(file, 'utf8') + 'x');",
      '',
    ].join('\n');
    const result = await withStubEngine(growing, () => runScenario(byId('L0-01'), deps()));
    assert.equal(result.result, 'expected-red');
    assert.match(result.reason ?? '', /checks failed: fix\.second\.bytes/);
    const idempotent = await withStubEngine('process.exitCode = 0;\n', () => runScenario(byId('L0-04'), deps()));
    assert.equal(idempotent.result, 'pass');
  });

  it('reports a live scenario env-blocked, with the reason, when the configuration is missing', async () => {
    const [result] = await runScenarios([byId('L1-04')], deps(), 4);
    assert.equal(result?.result, 'env-blocked');
    assert.match(result?.reason ?? '', /no Linear app is configured/);
  });

  it('reports a UI scenario env-blocked when the configuration is missing', async () => {
    const result = await runScenario(byId('L6-01'), deps());
    assert.equal(result.result, 'env-blocked');
  });

  it('runs many scenarios on parallel workers and keeps their order', async () => {
    const ids = ['L0-01', 'L0-02', 'L0-03', 'L0-04'];
    const results = await withStubEngine(NOT_IMPLEMENTED, () => runScenarios(ids.map(byId), deps(), 3));
    assert.deepEqual(results.map((result) => result.id), ids);
    assert.ok(results.every((result) => result.result === 'expected-red'));
  });
});

describe('sweeper', () => {
  it('sweeps dead runs at once, old runs after two hours, and never live ones', () => {
    const now = 10 * SWEEP_AGE_MS;
    const live = new Set(['aaaaaa']);
    const dead = new Set(['bbbbbb']);
    assert.equal(shouldSweep('aaaaaa', 0, now, live, dead), false);
    assert.equal(shouldSweep('bbbbbb', now, now, live, dead), true);
    assert.equal(shouldSweep('cccccc', now - SWEEP_AGE_MS - 1, now, live, dead), true);
    assert.equal(shouldSweep('cccccc', now - 1000, now, live, dead), false);
    assert.equal(shouldSweep('cccccc', null, now, live, dead), false);
    assert.equal(shouldSweep('not-a-run', 0, now, live, dead), false);
  });

  it('removes a killed run\'s leftovers and leaves a live run and other refs alone', async () => {
    const root = fresh('sweep-');
    const remote = join(root, 'sandbox.git');
    const git = new Git(root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
    await git.run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    const bare = new Git(remote, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
    const tree = (await bare.text(['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' })).trim();
    const commit = (await bare.text(['commit-tree', tree, '-m', 'x'])).trim();
    for (const ref of ['refs/heads/main', 'refs/heads/t/111111/main', 'refs/mdbisync-t/111111/ids', 'refs/heads/t/222222/main', 'refs/heads/t/333333/main']) {
      await bare.run(['update-ref', ref, commit]);
    }
    const stateDir = join(root, 'state');
    // 111111: a run of this host whose process died (a killed scenario). 222222: live. 333333: unknown and young.
    const killed = registerRun(stateDir, '111111');
    writeFileSync(join(stateDir, 'runs', '111111.json'), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname(), runId: '111111', since: '', heartbeatAt: new Date().toISOString() }));
    void killed;
    const live = registerRun(stateDir, '222222');
    const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir, runId: 'sweep0' });
    await sandbox.refreshCache();
    const archived: string[] = [];
    const deleted: string[] = [];
    const report = await sweep({
      sandbox,
      rest: { pullRequests: async () => [], closePullRequest: async () => {} } as never,
      world: {
        runProjects: async () => [
          { id: 'p1', name: 'Field notes 111111', createdAt: new Date().toISOString(), runId: '111111' },
          { id: 'p2', name: 'Field notes 222222', createdAt: new Date(0).toISOString(), runId: '222222' },
        ],
        deleteProject: async (project: { name: string }) => void deleted.push(project.name),
        runTeamDocuments: async () => [{ id: 'd1', title: '111111/guides/start', projectId: null, createdAt: new Date().toISOString(), runId: '111111' }],
        // Leftover team-zone documents are archived through a run project, never trashed.
        archiveRunTeamDocuments: async (documents: Array<{ id: string }>, runId: string, projectName: string) => {
          archived.push(...documents.map((document) => `${runId}:${projectName}:${document.id}`));
          return documents.length;
        },
      } as never,
      teamIds: ['team-1'],
    }, stateDir);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.removedRefs.sort(), ['refs/heads/t/111111/main', 'refs/mdbisync-t/111111/ids']);
    assert.deepEqual(deleted, ['Field notes 111111']);
    assert.deepEqual(archived, ['111111:Spare shelf 111111:d1']);
    assert.equal(report.archivedDocuments, 1);
    const left = (await bare.text(['for-each-ref', '--format=%(refname)'])).split('\n').sort();
    assert.deepEqual(left, ['refs/heads/main', 'refs/heads/t/222222/main', 'refs/heads/t/333333/main']);
    live.done();
  });

});

describe('setup deadline', () => {
  it('gives up on work that does not settle in time, and keeps the result of work that does', async () => {
    const { withDeadline } = await import('./runner.ts');
    assert.equal(await withDeadline(Promise.resolve(7), 1_000, () => new Error('late')), 7);
    await assert.rejects(withDeadline(new Promise(() => {}), 20, () => new EnvBlockedError('setup did not finish')), EnvBlockedError);
  });

  it('stops a setup past its deadline: a lock wait ends, and cleanup knows whether setup stopped', async () => {
    const { settlesWithin } = await import('./runner.ts');
    const { acquireLock } = await import('./locks.ts');
    const stateDir = fresh('setup-abort-');
    const held = await acquireLock('team-eng', { stateDir, runId: '555555', timeoutMs: 0 });
    const abort = new AbortController();
    const waiting = acquireLock('team-eng', { stateDir, runId: '666666', timeoutMs: 60_000, pollMs: 20, signal: abort.signal });
    abort.abort();
    assert.equal(await settlesWithin(waiting, 1_000), true);
    await assert.rejects(waiting);
    held.release();
    assert.equal(await settlesWithin(new Promise(() => {}), 20), false);
  });
});
