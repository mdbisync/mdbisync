import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { countAppRequest } from './app-reads.ts';
import type { TestConfig } from './config.ts';
import type { EditRecord, LiveWorld, RunContext } from './context.ts';
import { retireMissingFrom } from './steps.ts';
import { decodeHeldRun, encodeHeldRun, heldRunOf, HELD_RUN_FILE, loadHeldRun, saveHeldRun, type HeldRun } from './held-run.ts';
import { runNames } from './isolation.ts';
import { liveRuns, registerRun } from './locks.ts';
import { readLatest, updateStatusPage, type HarnessReport } from './report.ts';
import type { ScenarioResult } from './results.ts';
import { createRunContext } from './runner.ts';
import { loadScenarios, type Scenario, type Step } from './spec.ts';
import { sweep, type SweepTargets } from './sweeper.ts';
import { parseUiAnswers, renderUiChecklist, uiValueSubjects } from './ui-checklist.ts';
import { recordUiResult, takeUpHeldRun, type UiResultDeps } from './ui-result.ts';

const roots: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const all = loadScenarios();
const byId = (id: string) => all.find((scenario) => scenario.id === id) ?? assert.fail(id);
const RUN = 'a1b2c3';

// L6-03 without the invariants, which read the real world: its steps and its `ui.*` assertions stay.
const base = byId('L6-03');
const scenario: Scenario = {
  ...base,
  checks: {
    invariants: Object.fromEntries(Object.keys(base.checks.invariants).map((id) => [id, { required: false, reason: 'offline test' }])) as Scenario['checks']['invariants'],
    assertions: base.checks.assertions,
  },
};
const scenarios = all.map((candidate) => (candidate.id === scenario.id ? scenario : candidate));

const ANSWERED_VALUES = [
  ['ui.listIcon', '"Alert"'],
  ['ui.headerIcon', '"Alert"'],
  ['ui.markColor', '"orange"'],
  ['ui.botCommentVisible', 'true'],
  ['ui.markerParagraphsBold', 'true'],
] as const;

/** The checklist with the first `items` items answered (`fail` at item `failAt`) and, optionally, the values. */
function answered(checklist: string, items: number, options: { failAt?: number; values?: boolean } = {}): string {
  let item = 0;
  const lines: string[] = [];
  let subject: string | undefined;
  for (const line of checklist.split('\n')) {
    if (/^\d+\. \[ \]/.test(line)) item += 1;
    const value = /^- `(ui\.[\w.]+)`/.exec(line);
    if (value !== null) subject = value[1];
    if (line === '   - result: pass | fail' && item <= items) lines.push(`   - result: ${item === options.failAt ? 'fail' : 'pass'}`);
    else if (line === '   - observed:' && item <= items) lines.push(`   - observed: item ${item} looked as described`);
    else if (line === '  - value:' && options.values === true) lines.push(`  - value: ${ANSWERED_VALUES.find(([name]) => name === subject)?.[1] ?? 'null'}`);
    else lines.push(line);
  }
  return lines.join('\n');
}

/** The sandbox, GitHub and Linear of one run, in memory, with what the sweeper and cleanup call. */
function fakeRemote(runId: string) {
  const names = runNames(runId);
  const state = {
    refs: [`refs/heads/${names.trackedBranch}`, `refs/heads/${names.syncBranch}`, `${names.refPrefix}/linear`].map((ref, index) => ({ ref, oid: `${index}`.repeat(40), runId })),
    projects: [{ id: 'project-1', name: names.project(0), createdAt: new Date().toISOString(), runId }],
    closedPullRequestPrefixes: [] as string[],
  };
  const sandbox = {
    runRefs: async () => [...state.refs],
    deleteRunRefs: async (_run: string, refs: readonly string[]) => {
      state.refs = state.refs.filter((entry) => !refs.includes(entry.ref));
    },
    commitTime: async () => Date.now(),
  };
  const rest = {
    closeOpenPullRequests: async (prefix: string) => {
      state.closedPullRequestPrefixes.push(prefix);
      return [];
    },
    pullRequests: async () => [],
    closePullRequest: async () => {},
  };
  const world = {
    client: { getDocuments: async () => [] },
    runProjects: async () => [...state.projects],
    deleteProject: async (project: { id: string }) => {
      state.projects = state.projects.filter((entry) => entry.id !== project.id);
    },
    runTeamDocuments: async () => [],
    archiveRunTeamDocuments: async () => 0,
    trashedInZone: async () => 0,
  };
  return { state, sandbox, rest, world, names };
}

type FakeRemote = ReturnType<typeof fakeRemote>;

function fakeLive(remote: FakeRemote, held: HeldRun): LiveWorld {
  return {
    sandbox: remote.sandbox,
    rest: remote.rest,
    world: remote.world,
    githubToken: 'not-a-token',
    githubTokenSource: held.live.githubTokenSource,
    repository: held.live.repository,
    manifest: held.live.manifest,
    tree: held.live.tree,
    projects: held.live.projects,
    teams: held.live.teams,
    app: {},
    editors: { 'editor-a': { stats: { total: 2 } }, 'editor-b': { stats: { total: 1 } } },
    engineApp: { clientId: 'client', clientSecret: 'secret' },
    seededDocuments: held.live.seededDocuments,
    documentUrlBase: held.live.documentUrlBase,
    download: async () => Buffer.alloc(0),
  } as unknown as LiveWorld;
}

const config = { missing: [], linearApps: [], editors: { 'editor-a': '', 'editor-b': '' } } as unknown as TestConfig;

/** A run of the scenario held at its first UI step, as the runner leaves it, with a report that says env-blocked. */
function heldRun(options: { holdUntil?: number } = {}) {
  const outDir = fresh('ui-result-');
  const stateDir = join(outDir, 'state');
  const runDir = join(outDir, 'runs', `${scenario.id}-${RUN}`);
  mkdirSync(runDir, { recursive: true });
  const remote = fakeRemote(RUN);
  const holdUntil = options.holdUntil ?? Date.now() + 3_600_000;
  const held: HeldRun = {
    version: 1,
    scenarioId: scenario.id,
    runId: RUN,
    stepIndex: 0,
    appName: 'app1',
    holdUntil,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    budgetWaitMs: 500,
    takeUpRequests: { harness: 0, harnessApp: 0 },
    engine: { results: [], setupRuns: 0 },
    edits: [],
    ownCommits: ['0'.repeat(40)],
    sequence: 3,
    uiSteps: 0,
    observations: new Map<string, unknown>([['refHistory', [{}]], ['start.time', Date.now() - 60_000]]),
    proxyRequests: [{ n: 1, operation: 'Documents', kind: 'query', status: 200, injected: false, at: Date.now() - 50_000 }],
    live: {
      githubTokenSource: 'host',
      repository: 'owner/sandbox',
      manifest: { seed: 'seed', files: [] },
      tree: { paths: new Map(), rewritten: new Map(), projects: new Map([['PROJECT_ENG_1', remote.names.project(0)]]), teamZones: new Map([['ENG', 'eng']]), teams: new Set(['ENG']) },
      projects: new Map([['PROJECT_ENG_1', { id: 'project-1', name: remote.names.project(0), createdAt: new Date().toISOString() }]]),
      teams: new Map([['ENG', { id: 'team-eng', key: 'ENG', name: 'Engineering' }]]),
      seededDocuments: [],
      documentUrlBase: 'https://linear.app/example/document',
    },
  };
  saveHeldRun(runDir, held);
  registerRun(stateDir, RUN).hold(holdUntil);
  const checklist = renderUiChecklist(scenario, remote.names, { live: fakeLive(remote, held), runDir });
  writeFileSync(join(runDir, 'ui-checklist.md'), checklist);
  const result: ScenarioResult = {
    id: scenario.id, level: 'L6', slice: scenario.slice, mode: scenario.mode, runId: RUN, result: 'env-blocked', reason: 'ui steps wait for the UI session',
    startedAt: held.startedAt, durationMs: 60_000, engineRequests: 1, harnessRequests: 4, harnessAppRequests: 7, budgetWaitMs: 500, checks: [],
    cleanup: { ok: true, detail: 'kept for the UI session; the sweeper removes it after the hold' },
  };
  const report: HarnessReport = { harnessRunId: '2026-11-09-c0ffee', startedAt: held.startedAt, finishedAt: held.startedAt, host: 'test', selection: {}, results: [result] };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report));
  const steps: string[] = [];
  const attached: number[] = [];
  const deps: UiResultDeps = {
    config,
    governor: null,
    appClients: new Map(),
    stateDir,
    expectedRed: new Set(),
    log: () => {},
    attach: async (saved) => {
      attached.push(saved.stepIndex);
      return fakeLive(remote, saved);
    },
    runStep: async (_ctx: RunContext, step: Step) => {
      steps.push(`${step.kind}.${step.action}`);
      countAppRequest(); // one harness read through the app
    },
  };
  return { outDir, stateDir, runDir, remote, checklist, deps, steps, attached };
}

const sweepTargets = (remote: FakeRemote) => ({ sandbox: remote.sandbox, rest: remote.rest, world: remote.world, teamIds: ['team-eng'] }) as unknown as SweepTargets;

describe('UI checklist answers', () => {
  it('lists the values the checks read and reads the answers back', () => {
    const { checklist } = heldRun();
    assert.deepEqual(uiValueSubjects(scenario), ANSWERED_VALUES.map(([name]) => name));
    assert.match(checklist, /ui-result .*runs\/L6-03-a1b2c3 <this file>/);
    assert.match(checklist, /^- `ui\.markColor` expected equal `"orange"`$/m);
    const untouched = parseUiAnswers(checklist);
    assert.deepEqual(untouched.items.map((item) => item.result), [null, null, null]);
    assert.equal(untouched.values.size, 0);
    const done = parseUiAnswers(answered(checklist, 3, { failAt: 2, values: true }));
    assert.deepEqual(done.items.map((item) => item.result), ['pass', 'fail', 'pass']);
    assert.equal(done.items[1]?.observed, 'item 2 looked as described');
    assert.equal(done.values.get('ui.markColor'), 'orange');
    assert.equal(done.values.get('ui.botCommentVisible'), true);
  });

  it('asks the session for the texts the editors typed, and for the UI side of a same-as comparison', () => {
    assert.deepEqual(uiValueSubjects(byId('L6-08')), ['ui.typedTexts']);
    assert.deepEqual(uiValueSubjects(byId('L6-05')), ['ui.markPresent', 'ui.resolvedText']);
    assert.match(renderUiChecklist(byId('L6-05'), runNames(RUN), { live: null, runDir: 'run' }), /^- `ui\.resolvedText` \(compared with `tracked\.body`\)\n  - value:$/m);
  });

  it('asks the link check (L6-12) to click both links to the notes and record what they did', () => {
    const links = byId('L6-12');
    assert.deepEqual(links.setup.fixtures, ['document-links']);
    assert.deepEqual(uiValueSubjects(links), ['ui.plainLinkOpensTarget', 'ui.anchorLinkOpensTarget', 'ui.anchorScrolls']);
    // Without the run's record (`cli.ts checklist`), the project line is left out.
    assert.doesNotMatch(renderUiChecklist(links, runNames(RUN), { live: null, runDir: 'run' }), /are in project/);
    const pair = { source: 'p/guides/route-index.md', target: 'p/guides/route-notes.md', anchor: 'depot-hours', project: 'Field notes a1b2c3' };
    const checklist = renderUiChecklist(links, runNames(RUN), { live: null, runDir: 'run', observations: new Map([['fixture.linkPair', pair]]) });
    assert.match(checklist, /^- "guides\/route-index" and "guides\/route-notes" are in project Field notes a1b2c3$/m);
    assert.match(checklist, /^2\. \[ \] As editor-a: Open the document "guides\/route-index" in the project named above\. .* links the document "guides\/route-notes" twice: .*`#depot-hours`/m);
    assert.match(checklist, /scrolled to the heading/);
    assert.match(checklist, /^- `ui\.anchorLinkOpensTarget` expected equal `true`$/m);
    assert.match(checklist, /^- `ui\.anchorScrolls` \(recorded for the harness's checks\)$/m);
    // Both links opened the notes; the anchor did not scroll: recorded, and not a failed check.
    const filled = checklist
      .replaceAll('   - result: pass | fail', '   - result: pass')
      .replace(/(`ui\.plainLinkOpensTarget`[^\n]*\n  - value:)/, '$1 true')
      .replace(/(`ui\.anchorLinkOpensTarget`[^\n]*\n  - value:)/, '$1 true')
      .replace(/(`ui\.anchorScrolls`[^\n]*\n  - value:)/, '$1 false');
    const answers = parseUiAnswers(filled);
    assert.equal(answers.scenarioId, 'L6-12');
    assert.deepEqual(answers.items.map((item) => item.result), ['pass', 'pass']);
    assert.deepEqual([...answers.values], [['ui.plainLinkOpensTarget', true], ['ui.anchorLinkOpensTarget', true], ['ui.anchorScrolls', false]]);
  });

  it('reads which scenario and run the checklist is for', () => {
    const { checklist } = heldRun();
    const answers = parseUiAnswers(checklist);
    assert.equal(answers.scenarioId, 'L6-03');
    assert.equal(answers.runId, RUN);
  });

  it('refuses an answer that is neither pass nor fail, and a value that is not JSON', () => {
    const { checklist } = heldRun();
    assert.throws(() => parseUiAnswers(checklist.replace('   - result: pass | fail', '   - result: maybe')), /item 1: the result is "maybe"/);
    assert.throws(() => parseUiAnswers(checklist.replace('  - value:', '  - value: Alert')), /not JSON/);
  });
});

const extra = { stepIndex: 0, appName: 'app1', holdUntil: 1, startedAt: '2026-11-09T10:00:00.000Z', budgetWaitMs: 0, takeUpRequests: { harness: 0, harnessApp: 0 } };

describe('held run file', () => {
  it('keeps maps, sets and bytes through a save', () => {
    const { runDir } = heldRun();
    const held = loadHeldRun(runDir);
    held.observations.set('bytes', Buffer.from([1, 2, 3]));
    held.observations.set('nested', { inner: new Map([['a', new Set(['b'])]]) });
    const back = decodeHeldRun(encodeHeldRun(held));
    assert.deepEqual(back.observations.get('bytes'), Buffer.from([1, 2, 3]));
    assert.deepEqual(back.observations.get('nested'), { inner: new Map([['a', new Set(['b'])]]) });
    assert.equal(back.live.tree.teamZones.get('ENG'), 'eng');
    assert.equal(back.live.projects.get('PROJECT_ENG_1')?.id, 'project-1');
  });

  it('records a run where it stopped, without credentials', () => {
    const { runDir, remote, deps } = heldRun();
    const held = loadHeldRun(runDir);
    const { ctx } = createRunContext(scenario, RUN, runDir, { ...deps, outDir: join(runDir, '..', '..') });
    ctx.live = fakeLive(remote, held);
    ctx.observations.set('target.path', 'eng/guide.md');
    const saved = heldRunOf(ctx, extra);
    const text = encodeHeldRun(saved);
    assert.equal(decodeHeldRun(text).observations.get('target.path'), 'eng/guide.md');
    assert.doesNotMatch(text, /not-a-token|secret/);
    ctx.observations.set('canary.remoteTexts', { 'pull request #1': 'text' });
    assert.equal(heldRunOf(ctx, extra).observations.has('canary.remoteTexts'), false, 'remote texts are read again after the take-up');
    ctx.observations.set('tokens.seen', ['bearer']);
    assert.throws(() => heldRunOf(ctx, extra), /credentials \(tokens\.seen\)/);
  });

  it('does not keep a run whose faults live only in this process', () => {
    const { runDir, remote, deps } = heldRun();
    const held = loadHeldRun(runDir);
    const { ctx } = createRunContext(scenario, RUN, runDir, { ...deps, outDir: join(runDir, '..', '..') });
    ctx.live = fakeLive(remote, held);
    ctx.engine.env.MDBISYNC_TEST_STOP_AFTER = 'push';
    ctx.engine.restores.push(async () => {});
    assert.throws(() => heldRunOf(ctx, extra), /cannot be saved: engine environment of a fault, undo steps of a fault/);
  });
});

describe('ui-result', () => {
  it('runs the harness step between answered items and keeps the run held for the next ones', async () => {
    const { runDir, stateDir, remote, checklist, deps, steps } = heldRun();
    const outcome = await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, deps);
    assert.deepEqual(outcome, { state: 'waiting', ran: ['run.settle'], nextItem: 3 });
    assert.deepEqual(steps, ['run.settle']);
    const held = loadHeldRun(runDir);
    assert.equal(held.stepIndex, 3, 'the run goes on from the last UI step next time');
    assert.equal(held.proxyRequests.length, 1, 'the proxy records of the first part are kept');
    assert.deepEqual(held.takeUpRequests, { harness: 3, harnessApp: 1 }, 'the take-up\'s requests are kept for the result');
    assert.ok(liveRuns(stateDir).has(RUN), 'the hold stays');
    assert.equal(remote.state.refs.length, 3);
    assert.equal(remote.state.projects.length, 1);
    const report = await sweep(sweepTargets(remote), stateDir);
    assert.deepEqual(report.keptLive, [RUN], 'the sweeper leaves a held run alone');
    assert.equal(remote.state.projects.length, 1);
  });

  it('runs the checks once every item is answered, records the result in place of env-blocked, cleans up and releases the hold', async () => {
    const { runDir, stateDir, outDir, remote, checklist, deps, steps } = heldRun();
    await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, deps);
    // A resumed engine can provision npm again before the run finishes.
    mkdirSync(join(runDir, 'hook-npm', 'cache'), { recursive: true });
    writeFileSync(join(runDir, 'hook-npm', 'cache', 'artifact'), 'cached npm');
    const outcome = await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 3, { values: true })), scenarios, deps);
    assert.equal(outcome.state, 'done');
    assert.ok(outcome.state === 'done');
    const { result } = outcome;
    assert.equal(result.result, 'pass', result.reason);
    assert.deepEqual(result.checks.map((check) => check.name), ANSWERED_VALUES.map(([name]) => name));
    assert.ok(result.checks.every((check) => check.ok));
    assert.deepEqual(result.cleanup, { ok: true });
    assert.equal(result.engineRequests, 1, 'I9 counts the requests made before the hold');
    assert.equal(result.startedAt, loadReport(outDir).results[0]?.startedAt);
    assert.deepEqual(steps, ['run.settle'], 'a step that ran is not run again');
    // Cleaned up, the hold released, nothing left for the sweeper.
    assert.deepEqual(remote.state.refs, []);
    assert.deepEqual(remote.state.projects, []);
    assert.deepEqual(remote.state.closedPullRequestPrefixes, [`t/${RUN}/`]);
    assert.equal(liveRuns(stateDir).has(RUN), false);
    assert.equal(existsSync(join(runDir, HELD_RUN_FILE)), false);
    assert.equal(existsSync(join(runDir, 'canary-pending')), false);
    assert.equal(existsSync(join(runDir, 'hook-npm')), false, 'terminal take-up removes its npm installation and cache');
    const swept = await sweep(sweepTargets(remote), stateDir);
    assert.deepEqual(swept, { removedRefs: [], closedPullRequests: [], deletedProjects: [], archivedDocuments: 0, recovered: [], keptLive: [], errors: [] });
    assert.match(readFileSync(join(runDir, 'harness.log'), 'utf8'), /ui item 3 \(assert-dom\): pass/);
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 3, { values: true })), scenarios, deps), /no run waiting for its UI steps/);

    // The report, the status page and the evidence.
    const statusPage = join(outDir, 'test-status.md');
    const evidenceDir = join(outDir, 'evidence');
    assert.equal(recordUiResult(runDir, result, { statusPage, evidenceDir, catalog: all.map((candidate) => candidate.id) }).statusPage, 'updated');
    assert.equal(JSON.parse(readFileSync(join(runDir, 'ui-result.json'), 'utf8')).result, 'pass', 'the result is kept in the run folder too');
    const [recorded] = loadReport(outDir).results;
    assert.equal(recorded?.result, 'pass');
    assert.equal(recorded?.harnessAppRequests, 7 + 1, 'app reads of every take-up add to the first part\'s');
    assert.equal(recorded?.harnessRequests, 4 + 3 + 3, 'editor requests of both take-ups add to the first part\'s');
    assert.match(readFileSync(join(outDir, 'report.md'), 'utf8'), /\| L6-03 \| a1b2c3 \| pass \|/);
    const latest = readLatest(readFileSync(statusPage, 'utf8'));
    assert.deepEqual(latest.map((entry) => [entry.id, entry.result]), [['L6-03', 'pass']]);
    assert.match(readFileSync(join(evidenceDir, '2026-11-09-c0ffee', 'summary.md'), 'utf8'), /pass: 1/);
  });

  it('keeps the outcomes of every check when one does not hold', async () => {
    const { runDir, checklist, deps } = heldRun();
    await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, deps);
    const wrong = answered(checklist, 3, { values: true }).replace('  - value: "orange"', '  - value: "red"');
    const outcome = await takeUpHeldRun(runDir, parseUiAnswers(wrong), scenarios, deps);
    assert.ok(outcome.state === 'done');
    assert.equal(outcome.result.result, 'fail');
    assert.match(outcome.result.reason ?? '', /checks failed: ui\.markColor/);
    assert.equal(outcome.result.checks.length, 5);
    assert.deepEqual(outcome.result.checks.filter((check) => !check.ok).map((check) => check.name), ['ui.markColor']);
  });

  it('takes nothing up while the item where the run stopped is still open', async () => {
    const { runDir, checklist, deps, attached } = heldRun();
    assert.deepEqual(await takeUpHeldRun(runDir, parseUiAnswers(checklist), scenarios, deps), { state: 'waiting', ran: [], nextItem: 1 });
    assert.deepEqual(attached, [], 'no clients, budget or locks for a checklist with nothing new');
  });

  it('keeps a newer result of the scenario from another run on the status page', async () => {
    const { runDir, outDir, checklist, deps } = heldRun();
    await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, deps);
    const outcome = await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 3, { values: true })), scenarios, deps);
    assert.ok(outcome.state === 'done');
    const statusPage = join(outDir, 'test-status.md');
    const newer: HarnessReport = { ...loadReport(outDir), harnessRunId: '2026-11-09-beef00', results: [{ ...outcome.result, runId: 'ffffff', result: 'expected-red', startedAt: new Date().toISOString() }] };
    updateStatusPage(statusPage, all.map((candidate) => candidate.id), newer);
    assert.equal(recordUiResult(runDir, outcome.result, { statusPage, catalog: all.map((candidate) => candidate.id) }).statusPage, 'kept-newer');
    assert.deepEqual(readLatest(readFileSync(statusPage, 'utf8')).map((entry) => [entry.runId, entry.result]), [['ffffff', 'expected-red']]);
    assert.equal(loadReport(outDir).results[0]?.result, 'pass', 'the run\'s own report still gets its result');
  });

  it('refuses an admission on another app than the run\'s, and keeps the run held', async () => {
    const { runDir, stateDir, checklist, deps, attached } = heldRun();
    const released: string[] = [];
    const governor = { admit: async () => ({ app: { name: 'app2' }, waitedMs: 0, release: () => released.push('app2') }) } as unknown as UiResultDeps['governor'];
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, { ...deps, governor }), /admitted the run on app app2, but it runs on app app1/);
    assert.deepEqual(released, ['app2']);
    assert.deepEqual(attached, []);
    assert.ok(liveRuns(stateDir).has(RUN));
    assert.equal(loadHeldRun(runDir).stepIndex, 0);
  });

  it('ends the run on a failed UI step: expected-red on the expected-red list, fail otherwise, and cleans up either way', async () => {
    for (const [expectedRed, want] of [[true, 'expected-red'], [false, 'fail']] as const) {
      const { runDir, stateDir, remote, checklist, deps, steps } = heldRun();
      const outcome = await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2, { failAt: 2 })), scenarios, { ...deps, expectedRed: new Set(expectedRed ? [scenario.id] : []) });
      assert.ok(outcome.state === 'done');
      assert.equal(outcome.result.result, want);
      assert.match(outcome.result.reason ?? '', /UI step 2 \(inspect-conflict\) failed: item 2 looked as described/);
      assert.deepEqual(steps, [], 'nothing runs after a failed UI step');
      assert.deepEqual(remote.state.projects, []);
      assert.equal(liveRuns(stateDir).has(RUN), false);
    }
  });

  it('changes nothing when the hold has ended, the values are missing or the checklist is another scenario\'s', async () => {
    const ended = heldRun({ holdUntil: Date.now() - 1 });
    await assert.rejects(takeUpHeldRun(ended.runDir, parseUiAnswers(answered(ended.checklist, 3, { values: true })), scenarios, ended.deps), /hold of run a1b2c3 ended .* Run L6-03 again/);
    assert.equal(existsSync(join(ended.runDir, HELD_RUN_FILE)), true);

    const { runDir, stateDir, remote, checklist, deps, steps } = heldRun();
    // Every item answered at once: the last one was seen before the harness settled the run.
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 3, { values: true })), scenarios, deps), /item 3 comes after the harness step run\.settle, which has not run yet/);
    // Another scenario with as many items, and another run of the same scenario.
    const other = renderUiChecklist(byId('L6-04'), remote.names, { live: null, runDir });
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(other, 2)), scenarios, deps), /checklist is of L6-04 run a1b2c3, and the held run is L6-03 run a1b2c3/);
    const otherRun = checklist.replace(`(run ${RUN})`, '(run 0f0f0f)');
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(otherRun, 2)), scenarios, deps), /checklist is of L6-03 run 0f0f0f/);
    const skipped = answered(checklist, 3, { values: true }).replace(/(2\. \[ \][^\n]*\n   - result:) pass/, '$1 pass | fail');
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(skipped), scenarios, deps), /item 3 is answered but item 2 before it is not/);
    assert.deepEqual(steps, []);
    assert.equal(remote.state.projects.length, 1);
    assert.ok(liveRuns(stateDir).has(RUN));
    assert.equal(loadHeldRun(runDir).stepIndex, 0);

    // Values missing once every item is answered.
    await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, deps);
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 3)), scenarios, deps), /these values are not: ui\.listIcon/);
    assert.equal(loadHeldRun(runDir).stepIndex, 3);
  });

  it('leaves a held run as it was when the test configuration lacks the sandbox repository', async () => {
    const { runDir, stateDir, checklist, deps, steps, attached } = heldRun();
    const incomplete = { ...deps, config: { ...config, missing: ['MDBISYNC_TEST_SANDBOX_URL'] } };
    await assert.rejects(takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, incomplete), /test configuration is missing: MDBISYNC_TEST_SANDBOX_URL/);
    assert.deepEqual([steps, attached], [[], []]);
    assert.ok(liveRuns(stateDir).has(RUN));
    assert.equal(loadHeldRun(runDir).stepIndex, 0);
  });

  it('lets the harness act on a UI step answered pass, before the steps after it', async () => {
    const { runDir, checklist, deps } = heldRun();
    const order: string[] = [];
    const tracked: UiResultDeps = {
      ...deps,
      afterUiStep: async (_ctx, step) => void order.push(`after ui.${step.action}`),
      runStep: async (_ctx, step) => void order.push(`${step.kind}.${step.action}`),
    };
    await takeUpHeldRun(runDir, parseUiAnswers(answered(checklist, 2)), scenarios, tracked);
    assert.deepEqual(order, ['after ui.verify-editor', 'after ui.inspect-conflict', 'run.settle']);
  });
});

describe('UI conflict resolution', () => {
  it('retires the edits of the version the person discarded, and only those', () => {
    const edits: EditRecord[] = [
      { side: 'git', path: 'eng/plan.md', token: 'a1b2c3-001' },
      { side: 'linear', path: 'eng/plan.md', token: 'a1b2c3-002' },
      { side: 'linear', path: 'eng/plan.md', token: 'a1b2c3-003', removal: true },
      { side: 'git', path: 'eng/other.md', token: 'a1b2c3-004' },
    ];
    retireMissingFrom({ edits }, 'eng/plan.md', '# Plan\n\nKept text a1b2c3-002.\n');
    assert.deepEqual(edits.map((edit) => edit.retired === true), [true, false, false, false]);
  });
});

function loadReport(outDir: string): HarnessReport {
  return JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as HarnessReport;
}
