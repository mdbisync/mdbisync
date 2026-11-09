import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { Git, GitError } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { bothVersionsComplete, colorLabel, conflictScope, editParagraph, MARKERS, resolveKeeping, scanMarkers } from './conflicts.ts';
import type { LiveWorld, RunContext } from './context.ts';
import type { RunTree } from './corpus.ts';
import { FIXTURE_PREPARATION } from './runner.ts';
import { DOCUMENT_FIXTURES, fixtureEdit, prepareFixtures, reviewDocument, seededPng, SETUP_FIXTURES, SLICE_FIXTURES, STEP_PREPARATION } from './fixtures.ts';
import { runNames } from './isolation.ts';
import { burst, soak, type SoakDriver } from './load.ts';
import { EnvBlockedError, ProductError } from './results.ts';
import { gitLinks, linearLinks, sameAsFile } from './checks.ts';
import { withoutDocuments } from './fault-proxy.ts';
import { commitStaged, HOOK_ENV_KEYS, HookRejectedError, installFailure, installHooks, PERSON, personCommit, Sandbox } from './sandbox.ts';
import { engineEntry } from './engine.ts';
import { HOOK_REPOSITORY, preCommitConfig } from '../../corpus/tree.ts';
import { CHECK_MARKER, CHECK_WORKFLOW, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { waitForCheck } from './check-fault.ts';
import { SandboxRest, type PullRequest } from './github.ts';
import { loadScenarios } from './spec.ts';
import { editInsideMarkers, HARNESS_GAPS, retireDiscarded, runStep, STEP_ACTIONS } from './steps.ts';
import { commitAsPerson, readRunIds } from './step-helpers.ts';
import { documentLinks, encodeTitlePath, refreshView, relativeLinks, resolveSubject, subjectSource, tokenActive } from './subjects.ts';
import { environmentBlocker, maxOverlap, unzip, waitForRegistration, waitForRun } from './workflows.ts';
import type { WorkflowJob, WorkflowRun } from './github.ts';
import { prerequisiteErrors } from './workflow-files.ts';
import { parse as parseYaml } from 'yaml';

const roots: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scenarios = loadScenarios();

describe('the scenario set', () => {
  it('has no step action or assertion subject the harness cannot run', () => {
    const unrunnable = new Set<string>();
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        const action = `${step.kind}.${step.action}`;
        if (!(action in STEP_ACTIONS) || HARNESS_GAPS.has(action)) unrunnable.add(`${scenario.id} step ${action}`);
      }
      for (const assertion of scenario.checks.assertions) {
        if (subjectSource(assertion.subject) === null) unrunnable.add(`${scenario.id} subject ${assertion.subject}`);
        if (assertion.operator === 'same-as' && subjectSource(String(assertion.expected)) === null) unrunnable.add(`${scenario.id} subject ${String(assertion.expected)}`);
      }
    }
    assert.deepEqual([...unrunnable], []);
  });

  it('knows every setup fixture: prepared, or naming slice content', () => {
    const unknown = scenarios.flatMap((scenario) => scenario.setup.fixtures.filter((fixture) => !(fixture in SETUP_FIXTURES) && !(fixture in FIXTURE_PREPARATION) && !SLICE_FIXTURES.has(fixture)).map((fixture) => `${scenario.id} ${fixture}`));
    assert.deepEqual(unknown, []);
  });

  it('names engine-report subjects only for what the engine alone knows', () => {
    assert.equal(subjectSource('runs.0.summary.code'), 'engine');
    assert.equal(subjectSource('runs.last.writes.total'), 'engine');
    assert.equal(subjectSource('summary.code'), 'engine');
    assert.equal(subjectSource('summary.canaryCount'), 'harness');
    assert.equal(subjectSource('documents.body'), 'harness');
    assert.equal(subjectSource('before.documents.id'), 'harness');
    assert.equal(subjectSource('ui.icon'), 'ui');
    assert.equal(subjectSource('nothing.known'), null);
  });
});

describe('conflict markers', () => {
  const conflict = (git: string, linear: string) => `# Notes\n\n${MARKERS.git}\n\n${git}\n\n${MARKERS.linear}\n\n${linear}\n\n${MARKERS.end}\n\nAfter.\n`;

  it('counts sets, marker lines and nesting, and ignores lookalikes in code fences', () => {
    const scan = scanMarkers(conflict('One.', 'Two.'));
    assert.equal(scan.sets.length, 1);
    assert.equal(scan.markerLines, 3);
    assert.equal(scan.sets[0]?.git, 'One.');
    assert.equal(scan.sets[0]?.linear, 'Two.');
    const partial = conflict('One.', 'Two.').replace(`${MARKERS.end}\n`, '');
    assert.equal(scanMarkers(partial).sets.length, 1);
    assert.equal(scanMarkers(partial).markerLines, 2);
    const nested = conflict(`${MARKERS.git}\n\nInner.\n\n${MARKERS.linear}\n\nOther.\n\n${MARKERS.end}`, 'Two.');
    assert.equal(scanMarkers(nested).nested, 1);
    assert.equal(scanMarkers(reviewDocument({ lookalikes: true })).markerLines, 0);
  });

  it('classifies what a conflict takes in', () => {
    assert.equal(conflictScope('No conflict.\n'), 'none');
    assert.equal(conflictScope(conflict('One.', 'Two.')), 'paragraph');
    assert.equal(conflictScope(conflict('| a |\n| -- |\n| 1 |', '| a |\n| -- |\n| 2 |')), 'whole-table');
    assert.equal(conflictScope(conflict('```text\none\n```', '```text\ntwo\n```')), 'whole-fence');
    assert.equal(conflictScope(conflict('1. One\n   1. Sub', '1. Two\n   1. Sub')), 'whole-list');
    assert.equal(conflictScope(conflict('- Book the room', '- Book the hall')), 'line');
    assert.equal(conflictScope(conflict('![a](media/a.png)', '![b](https://uploads.example.com/b)')), 'image-links');
    assert.ok(bothVersionsComplete(conflict('| a |\n| -- |\n| 1 |', '| a |\n| -- |\n| 2 |')));
    assert.ok(!bothVersionsComplete(conflict('| 1 |', '| 2 |')));
    assert.ok(!bothVersionsComplete(conflict('```text\none', '```text\ntwo\n```')));
  });

  it('resolve keeping one version, and edit inside the markers', () => {
    assert.equal(resolveKeeping(conflict('One.', 'Two.'), 'linear'), '# Notes\n\nTwo.\n\nAfter.\n');
    const edited = editInsideMarkers(conflict('One.', 'Two.'), 'linear', 'abc123-001');
    assert.match(edited, /^Two\. The review moved to the next morning, note abc123-001\.$/m);
    assert.throws(() => editInsideMarkers('No markers.\n', 'git', 't'), ProductError);
    // Lookalike markers in a code fence are text and survive a resolution.
    const lookalikes = reviewDocument({ lookalikes: true });
    const withConflict = lookalikes.replace('The first paragraph explains the plan for the week.', `${MARKERS.git}\n\nOurs.\n\n${MARKERS.linear}\n\nTheirs.\n\n${MARKERS.end}`);
    const resolved = resolveKeeping(withConflict, 'git');
    assert.equal(scanMarkers(resolved).markerLines, 0);
    assert.ok(resolved.includes(`\`\`\`text\n${MARKERS.git}\none\n${MARKERS.linear}\ntwo\n${MARKERS.end}\n\`\`\``));
  });

  it('edit the n-th plain paragraph and nothing else', () => {
    const text = reviewDocument({ lookalikes: false });
    const edited = editParagraph(text, 1, 'abc123-002');
    assert.match(edited, /^The second paragraph lists the open questions\. The review moved to the next morning, note abc123-002\.$/m);
    assert.equal(edited.replace(' The review moved to the next morning, note abc123-002.', ''), text);
  });
});

/** git merge-file of a base and two sides: the merged text and whether it conflicted. */
function merge(base: string, ours: string, theirs: string): { conflict: boolean } {
  const dir = fresh('merge-');
  writeFileSync(join(dir, 'base'), base);
  writeFileSync(join(dir, 'ours'), ours);
  writeFileSync(join(dir, 'theirs'), theirs);
  const result = spawnSync('git', ['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
  return { conflict: (result.status ?? 0) > 0 };
}

describe('edit fixtures', () => {
  const ctx = { observations: new Map(), live: null } as unknown as RunContext;
  const base = reviewDocument({ lookalikes: false });
  const sides = async (fixture: string) => ({
    git: (await fixtureEdit(ctx, fixture, 'git', 'eng/guides/weekly-plan.md', base, 'aaaaaa-001'))?.text ?? '',
    linear: (await fixtureEdit(ctx, fixture, 'linear', 'eng/guides/weekly-plan.md', base, 'aaaaaa-002'))?.text ?? '',
  });

  it('make a line-based merge conflict where the scenario wants one', async () => {
    for (const fixture of ['same-paragraph', 'table', 'code-fence', 'mermaid', 'ordered-and-nested-list', 'flat-bullet-list', 'front-matter-change']) {
      const { git, linear } = await sides(fixture);
      assert.notEqual(git, base, fixture);
      assert.ok(merge(base, git, linear).conflict, `${fixture} should conflict`);
    }
  });

  it('merge cleanly where the scenario wants no conflict', async () => {
    for (const fixture of ['different-paragraphs', 'marker-lookalikes']) {
      const { git, linear } = await sides(fixture);
      assert.ok(!merge(base, git, linear).conflict, `${fixture} should merge`);
    }
  });

  it('cover every document fixture with an edit', () => {
    for (const fixture of DOCUMENT_FIXTURES) assert.ok(fixture === 'three-editors' || fixture === 'images-at-same-position' || fixture === 'adjacent-paragraphs' || ['same-paragraph', 'table', 'code-fence', 'mermaid', 'ordered-and-nested-list', 'flat-bullet-list', 'front-matter-change', 'different-paragraphs', 'marker-lookalikes'].includes(fixture), fixture);
  });

  it('make a valid PNG that differs by seed', () => {
    const a = seededPng('one');
    assert.deepEqual([...a.subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join(''), 'PNG');
    assert.notDeepEqual(a, seededPng('two'));
    assert.deepEqual(a, seededPng('one'));
  });
});

describe('workflows', () => {
  /** A zip with stored and deflated entries, built the way zip tools write them. */
  function zip(files: Record<string, { data: Buffer; deflate: boolean }>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, { data, deflate }] of Object.entries(files)) {
      const body = deflate ? deflateRawSync(data) : data;
      const nameBytes = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      locals.push(local, nameBytes, body);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(deflate ? 8 : 0, 10);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBytes);
      offset += 30 + nameBytes.length + body.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
  }

  it('read the report artifact', () => {
    const files = unzip(zip({ 'report.json': { data: Buffer.from('{"changed":false}'), deflate: true }, 'summary.md': { data: Buffer.from('# Sync\n'), deflate: false } }));
    assert.equal(files.get('report.json')?.toString(), '{"changed":false}');
    assert.equal(files.get('summary.md')?.toString(), '# Sync\n');
  });

  it('measure how many jobs ran at once', () => {
    assert.equal(maxOverlap([{ runId: 1, started: 0, completed: 10 }, { runId: 2, started: 10, completed: 20 }]), 1);
    assert.equal(maxOverlap([{ runId: 1, started: 0, completed: 10 }, { runId: 2, started: 5, completed: 20 }]), 2);
  });

  it('wait for the first matching run to complete', async () => {
    let polls = 0;
    const rest = {
      workflowRuns: async () => {
        polls += 1;
        return [
          { id: 1, event: 'push', status: 'completed', conclusion: 'success', created_at: new Date(0).toISOString(), head_sha: 'old' },
          { id: 2, event: 'push', status: polls > 1 ? 'completed' : 'in_progress', conclusion: polls > 1 ? 'success' : null, created_at: new Date().toISOString(), head_sha: 'new' },
        ];
      },
    };
    const run = await waitForRun(rest as never, { branch: 't/aaaaaa/main', event: 'push', after: Date.now() - 1000, headSha: 'new', pollMs: 1 });
    assert.equal(run.id, 2);
    await assert.rejects(waitForRun(rest as never, { branch: 'b', event: 'workflow_dispatch', after: 0, appearMs: 0, pollMs: 1 }), ProductError);
  });

  /** The log of a step that failed because the runner lacks a command, as GitHub writes it. */
  const missingCommand = (command: string) => `##[group]Run ${command} install x\nshell: /usr/bin/bash -e {0}\n##[endgroup]\n/runner/_temp/a.sh: line 1: ${command}: command not found\n##[error]Process completed with exit code 127.\n`;
  const failedRun = (id: number, event = 'push'): WorkflowRun => ({ id, event, status: 'completed', conclusion: 'failure', created_at: new Date().toISOString() });
  const jobWith = (failedStep: string, number: number): WorkflowJob => ({
    id: 1, name: 'sync', conclusion: 'failure', started_at: null, completed_at: null,
    steps: [
      { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' },
      { name: failedStep, number, status: 'completed', conclusion: 'failure' },
      { name: 'Sync', number: number + 1, status: 'completed', conclusion: 'skipped' },
    ],
  });

  it('prove an environment blocker only from a failed prerequisite step whose own log shows a missing command', () => {
    const logs = new Map([['sync/4_Install pre-commit.txt', missingCommand('pipx')]]);
    const blocker = environmentBlocker(failedRun(7), [jobWith('Install pre-commit', 4)], logs);
    assert.deepEqual(blocker && { step: blocker.step, cause: blocker.cause, logFile: blocker.logFile }, { step: 'Install pre-commit', cause: 'pipx: command not found (exit 127)', logFile: 'sync/4_Install pre-commit.txt' });
    assert.match(blocker?.reason ?? '', /pipx: command not found \(exit 127\) \(push run 7\)/);
    // The template's own prerequisite error proves it too, and only a known one does.
    const known = prerequisiteErrors();
    const pythonMissing = new Map([['sync/4_Install pre-commit.txt', `${known.find((error) => error.includes('Python 3'))}\n##[error]Process completed with exit code 1.\n`]]);
    assert.match(environmentBlocker(failedRun(7), [jobWith('Install pre-commit', 4)], pythonMissing, known)?.cause ?? '', /^Install Python 3/);
    assert.equal(environmentBlocker(failedRun(7), [jobWith('Install pre-commit', 4)], pythonMissing), undefined);
    // Not proven: the engine's own step failed, even with the same log.
    assert.equal(environmentBlocker(failedRun(7), [jobWith('Sync', 4)], new Map([['sync/4_Sync.txt', missingCommand('pipx')]])), undefined);
    // Not proven: the prerequisite failed for another reason, or its log is missing.
    assert.equal(environmentBlocker(failedRun(7), [jobWith('Install pre-commit', 4)], new Map([['sync/4_Install pre-commit.txt', 'error: network\n##[error]Process completed with exit code 1.\n']])), undefined);
    assert.equal(environmentBlocker(failedRun(7), [jobWith('Install pre-commit', 4)], new Map()), undefined);
    // Not a failure at all.
    assert.equal(environmentBlocker({ ...failedRun(7), conclusion: 'success' }, [jobWith('Install pre-commit', 4)], logs), undefined);
    // Only the first failed step counts.
    const earlier: WorkflowJob = { ...jobWith('Install pre-commit', 4), steps: [{ name: 'Get the GitHub App token', number: 2, status: 'completed', conclusion: 'failure' }, ...jobWith('Install pre-commit', 4).steps!] };
    assert.equal(environmentBlocker(failedRun(7), [earlier], logs), undefined);
  });

  it('wait for a workflow to be registered, and fail as the harness when it never is', async () => {
    let calls = 0;
    const rest = { workflowId: async () => (++calls > 2 ? 42 : undefined) };
    assert.equal(await waitForRegistration(rest as never, 'mdbisync-initial-sync.yml', { pollMs: 1 }), 42);
    const never = { workflowId: async () => undefined };
    await assert.rejects(waitForRegistration(never as never, 'mdbisync-initial-sync.yml', { timeoutMs: 0, pollMs: 1 }), (error: Error) => !(error instanceof EnvBlockedError) && /not in the repository's Actions registry/.test(error.message));
  });

  /** A sandbox's Actions for one run: the workflow registry, dispatches, runs, their jobs and logs. */
  function fakeActions(ctx: RunContext, remoteGit: Git, options: { conclusion: string; jobs: WorkflowJob[]; logs: Record<string, string>; registeredAfter?: number }) {
    const runs: WorkflowRun[] = [];
    const dispatched: Array<string | number> = [];
    let registryReads = 0;
    const logZip = zip(Object.fromEntries(Object.entries(options.logs).map(([name, text]) => [name, { data: Buffer.from(text), deflate: true }])));
    const rest = {
      workflowExists: async () => true,
      workflowId: async () => (++registryReads > (options.registeredAfter ?? 0) ? 99 : undefined),
      dispatchWorkflow: async (workflow: string | number) => {
        dispatched.push(workflow);
        runs.push({ id: 500 + runs.length, event: 'workflow_dispatch', status: 'completed', conclusion: options.conclusion, created_at: new Date().toISOString(), path: '.github/workflows/mdbisync-initial-sync.yml' });
      },
      workflowRuns: async () => {
        // Each push to the tracked branch starts a skipped registering run of the initial sync first, then the sync's run.
        const tip = (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim();
        if (!runs.some((run) => run.event === 'push' && run.head_sha === tip)) {
          const at = Date.now();
          runs.push({ id: 500 + runs.length, event: 'push', status: 'completed', conclusion: 'success', created_at: new Date(at).toISOString(), head_sha: tip, path: '.github/workflows/mdbisync-initial-sync.yml' });
          runs.push({ id: 500 + runs.length, event: 'push', status: 'completed', conclusion: options.conclusion, created_at: new Date(at + 1).toISOString(), head_sha: tip, path: '.github/workflows/mdbisync.yml' });
        }
        return runs;
      },
      request: async (_method: string, path: string) => {
        if (/^\/actions\/runs\/\d+\/artifacts$/.test(path)) return { artifacts: [] };
        throw new Error(`unexpected ${path}`);
      },
      runJobs: async () => options.jobs,
      download: async () => logZip,
    };
    Object.assign(ctx.live!, { rest, githubTokenSource: 'app' });
    return { runs, dispatched };
  }

  it('stop at a push run\'s proven environment blocker, keeping the run\'s result and evidence', async () => {
    const { ctx, remoteGit } = await fakeRun();
    const logs = { 'sync/4_Install pre-commit.txt': missingCommand('pipx'), 'sync/1_Set up job.txt': 'ok\n' };
    const { runs } = fakeActions(ctx, remoteGit, { conclusion: 'failure', jobs: [jobWith('Install pre-commit', 4)], logs });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await assert.rejects(STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' }), (error: Error) => error instanceof EnvBlockedError && /Install pre-commit.*pipx: command not found/.test(error.message));
    assert.equal(ctx.engine.results.length, 1, 'the failed run is the scenario\'s run');
    assert.equal(ctx.observations.get('runs.0.exitCode'), 1);
    const run = (ctx.observations.get('workflows.runs') as Array<{ id: number }>)[0]!;
    assert.equal(runs.find((candidate) => candidate.id === run.id)?.path, '.github/workflows/mdbisync.yml', 'the sync\'s push run, not another workflow\'s run on the same push');
    const dir = join(ctx.runDir, 'workflows', String(run.id));
    assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).conclusion, 'failure');
    assert.equal(JSON.parse(readFileSync(join(dir, 'blocker.json'), 'utf8')).cause, 'pipx: command not found (exit 127)');
    assert.equal(readFileSync(join(dir, 'failed-step.txt'), 'utf8'), logs['sync/4_Install pre-commit.txt']);
  });

  it('keep an unproven failure as the run\'s result, for the scenario\'s checks', async () => {
    const { ctx, remoteGit } = await fakeRun();
    fakeActions(ctx, remoteGit, { conclusion: 'failure', jobs: [jobWith('Sync', 4)], logs: { 'sync/4_Sync.txt': 'Error: boom\n##[error]Process completed with exit code 1.\n' } });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' });
    assert.equal(ctx.observations.get('runs.0.exitCode'), 1);
    assert.equal(ctx.observations.has('workflows.blocker'), false);
    assert.equal(existsSync(join(ctx.runDir, 'workflows')), false);
  });

  it('dispatch the initial sync by its registry id once its push has registered it', async () => {
    const { ctx, remoteGit } = await fakeRun();
    // Registered already: the waiting itself is covered above, without the step's 10-second poll.
    const { dispatched } = fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {} });
    await STEP_ACTIONS['run.workflow']!(ctx, { event: 'workflow_dispatch', command: 'initial-sync', confirm: false, direction: 'git-to-linear' });
    assert.deepEqual(dispatched, [99]);
    assert.deepEqual(ctx.observations.get('workflows.installed'), ['mdbisync-initial-sync.yml', 'pre-commit.yml']);
    const installed = await remoteGit.text(['show', `${ctx.names.trackedBranch}:.github/workflows/mdbisync-initial-sync.yml`]);
    const on = (parseYaml(installed) as { on: Record<string, { branches?: string[] } | null> }).on;
    assert.deepEqual(on['push'], { branches: [ctx.names.trackedBranch] }, 'registered by a push to the run\'s branch only, never the default branch');
    assert.equal(ctx.observations.get('runs.0.exitCode'), 0);
  });
});

/** A clock the load loops can run against without waiting. */
function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += Math.max(0, ms)) };
}

describe('load', () => {
  it('runs a burst on its schedule', async () => {
    const clock = fakeClock();
    const edits: string[] = [];
    const result = await burst({ ...clock, linearEdit: async (actor) => void edits.push(actor), gitEdit: async () => {}, sync: async () => void clock.sleep(60_000) }, {
      durationMs: 900_000, linearEditsPerMinute: 50, gitPushesPerMinute: 1, documents: ['a.md', 'b.md'],
    });
    assert.equal(result.linearEdits, 750);
    assert.equal(result.gitPushes, 15);
    assert.ok(result.syncRuns > 0);
    assert.equal(edits.filter((actor) => actor === 'editor-b').length, 375);
  });

  it('runs a soak with hourly checks and a repeatable schedule', async () => {
    const run = async () => {
      const clock = fakeClock();
      const edited: string[] = [];
      const driver: SoakDriver = { ...clock, linearEdit: async (actor, path) => void edited.push(`${actor} ${path}`), gitEdit: async (paths) => void edited.push(`git ${paths.join()}`), sync: async () => {}, checkInvariants: async () => ({ lostEdits: 0 }) };
      const result = await soak(driver, { durationMs: 86_400_000, scheduleMs: 300_000, invariantIntervalMs: 3_600_000, actors: ['editor-a', 'editor-b', 'git'], seed: '173', documents: ['a.md', 'b.md', 'c.md'] });
      return { result, edited };
    };
    const first = await run();
    assert.equal(first.result.invariantChecks, 24);
    assert.equal(first.result.syncRuns, 288);
    assert.ok(first.result.edits.git > 100 && first.result.edits['editor-a'] > 100);
    assert.deepEqual((await run()).edited, first.edited);
  });
});

describe('oracles', () => {
  it('map links to uploads link by link, so equal bytes at two paths keep their own links', () => {
    const hashes = new Map([['eng/media/a.png', 'h1'], ['eng/media/copy-of-a.png', 'h1'], ['eng/notes.pdf', 'h2']]);
    const uploads = new Map([['h1', 'https://uploads.linear.app/x/one'], ['h2', 'https://uploads.linear.app/x/two']]);
    const text = '![a](media/a.png) and ![b](<media/copy-of-a.png>) and [pdf](notes.pdf) and [web](https://example.com/a.png) and [anchor](#top)';
    assert.equal(linearLinks(text, 'eng/plan.md', { hashes, uploadsByHash: uploads }), '![a](https://uploads.linear.app/x/one) and ![b](<https://uploads.linear.app/x/one>) and [pdf](https://uploads.linear.app/x/two) and [web](https://example.com/a.png) and [anchor](#top)');
    // An attachment link as the fixer writes it keeps its angle brackets around the URL.
    assert.equal(linearLinks('The [summary](<../assets/summary.pdf>)', 'eng/notes/plan.md', { hashes: new Map([['eng/assets/summary.pdf', 'h2']]), uploadsByHash: uploads }), 'The [summary](<https://uploads.linear.app/x/two>)');
    assert.ok(sameAsFile('---\na: 1\n---\n![a](media/a.png)\n', '![a](https://uploads.linear.app/x/one)\n', 'eng/plan.md', { hashes, uploadsByHash: uploads }));
  });

  it('map links to synchronized documents to their URLs by id, as the engine writes them', () => {
    const targets = {
      hashes: new Map([['eng/media/a.png', 'h1'], ['eng/notes/asset.pdf', 'h2']]),
      uploadsByHash: new Map([['h1', 'https://uploads.linear.app/x/one'], ['h2', 'https://uploads.linear.app/x/two']]),
      ids: new Map([['eng/guide.md', { id: 'g-1' }], ['eng/notes/plan.md', { id: 'p-1' }], ['docs/start.md', { id: 's-1' }]]),
      documentUrlBase: 'https://linear.app/acme/document',
    };
    const text = [
      'See [the guide](../guide.md#setup), [start](</docs/start.md>) and [self](plan.md#top).',
      'Not synced: [data](../data.csv). External: [site](https://example.com). Image: ![a](../media/a.png).',
      'Odd labels: [a\\]b](<asset.pdf>) and [![badge](../media/a.png)](../guide.md).',
      'Code stays: `[x](../guide.md)`',
      '',
      '```text',
      '[y](../guide.md)',
      '```',
      '',
      '[ref]: ../guide.md',
    ].join('\n');
    assert.equal(linearLinks(text, 'eng/notes/plan.md', targets), [
      'See [the guide](<https://linear.app/acme/document/g-1#setup>), [start](<https://linear.app/acme/document/s-1>) and [self](<https://linear.app/acme/document/p-1#top>).',
      'Not synced: [data](../data.csv). External: [site](https://example.com). Image: ![a](https://uploads.linear.app/x/one).',
      'Odd labels: [a\\]b](<https://uploads.linear.app/x/two>) and [![badge](https://uploads.linear.app/x/one)](<https://linear.app/acme/document/g-1>).',
      'Code stays: `[x](../guide.md)`',
      '',
      '```text',
      '[y](../guide.md)',
      '```',
      '',
      '[ref]: <https://linear.app/acme/document/g-1>',
    ].join('\n'));
    assert.deepEqual(documentLinks('[a](https://linear.app/acme/document/g-1#setup) [b](<https://linear.app/acme/document/s-1>) [c](https://linear.app/other/document/x) `[d](https://linear.app/acme/document/z)`', targets.documentUrlBase), ['g-1#setup', 's-1']);
    // The way back gives relative links again.
    assert.equal(gitLinks('[g](<https://linear.app/acme/document/g-1#setup>) ![a](https://uploads.linear.app/x/one)', 'eng/notes/plan.md', { ...targets, uploads: new Map([['https://uploads.linear.app/x/one', 'eng/media/a.png']]) }), '[g](<../guide.md#setup>) ![a](../media/a.png)');
  });

  it('leave a document deleted for good out of every list the proxy passes on', () => {
    const answer = Buffer.from(JSON.stringify({ data: { documents: { nodes: [{ id: 'gone', title: 'x' }, { id: 'kept', title: 'y' }], pageInfo: { hasNextPage: false } } } }));
    assert.deepEqual(JSON.parse(withoutDocuments(answer, new Set(['gone'])).toString()), { data: { documents: { nodes: [{ id: 'kept', title: 'y' }], pageInfo: { hasNextPage: false } } } });
    assert.equal(withoutDocuments(Buffer.from('not json'), new Set(['gone'])).toString(), 'not json');
  });

  it('tell a revoked token from a probe that proves nothing', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    assert.equal(await tokenActive('t', answer(200, { data: { viewer: { id: 'u' } } }), 0), true);
    assert.equal(await tokenActive('t', answer(401, {}), 0), false);
    assert.equal(await tokenActive('t', answer(400, { errors: [{ extensions: { code: 'AUTHENTICATION_ERROR' } }] }), 0), false);
    await assert.rejects(tokenActive('t', answer(503, {}), 0), EnvBlockedError);
  });
});

describe('team-zone cleanup', () => {
  it('names helper projects so cleanup finds them and no annotation ever maps one', async () => {
    const { RUN_PROJECT_PATTERN, runOfProject } = await import('./isolation.ts');
    const { PROJECT_PLACEHOLDERS } = await import('./corpus.ts');
    const names = runNames('aaaaaa');
    const placeholderProjects = PROJECT_PLACEHOLDERS.map((_, index) => names.project(index));
    const helpers = (['archive', 'unmapped', 'archived-copy'] as const).map((purpose) => names.helperProject(purpose));
    // One name per purpose, so a run never holds two live projects with one name.
    assert.equal(new Set(helpers).size, helpers.length);
    for (const helper of helpers) {
      assert.match(helper, RUN_PROJECT_PATTERN);
      assert.equal(runOfProject(helper), 'aaaaaa');
      assert.ok(!placeholderProjects.includes(helper));
    }
  });

  it('archives a run\'s team-zone documents through a run project of their team, restoring trashed ones first', async () => {
    const { LinearWorld } = await import('./linear-world.ts');
    const calls: string[] = [];
    const client = {
      request: async (operation: string, _kind: string, _query: string, variables: { input?: { name: string; teamIds: string[] }; id?: string }) => {
        calls.push(`${operation} ${variables.input?.name ?? variables.id ?? ''} ${variables.input?.teamIds?.join(',') ?? ''}`.trim());
        if (operation === 'CreateProject') return { projectCreate: { success: true, project: { id: `project-${variables.input?.teamIds?.[0]}`, name: variables.input?.name, createdAt: '' } } };
        return { projectDelete: { success: true } };
      },
      restoreDocument: async (id: string) => void calls.push(`restore ${id}`),
      updateDocument: async (id: string, patch: { projectId?: string }) => void calls.push(`move ${id} ${patch.projectId}`),
    };
    const world = new LinearWorld(client as never);
    const archived = await world.archiveRunTeamDocuments([
      { id: 'd1', title: 'aaaaaa/guides/start', projectId: null, teamId: 'team-eng', trashed: false },
      { id: 'd2', title: 'aaaaaa/guides/old', projectId: null, teamId: 'team-eng', trashed: true },
      { id: 'd3', title: 'aaaaaa/notes', projectId: null, teamId: 'team-docs', trashed: false },
      { id: 'd4', title: 'in a project already', projectId: 'p', teamId: 'team-eng', trashed: false },
    ], 'aaaaaa', 'Spare shelf aaaaaa');
    assert.equal(archived, 3);
    assert.deepEqual(calls, [
      'CreateProject Spare shelf aaaaaa team-eng', 'move d1 project-team-eng', 'restore d2', 'move d2 project-team-eng', 'DeleteProject project-team-eng',
      'CreateProject Spare shelf aaaaaa team-docs', 'move d3 project-team-docs', 'DeleteProject project-team-docs',
    ]);
    // A move that fails puts a restored document back in the trash, the other team is still archived, and the
    // failures come back together.
    calls.length = 0;
    const failing = new LinearWorld({
      ...client,
      updateDocument: async (id: string, patch: { projectId?: string }) => {
        if (id === 'd2') throw new Error('quota');
        calls.push(`move ${id} ${patch.projectId}`);
      },
      trashDocument: async (id: string) => void calls.push(`trash ${id}`),
    } as never);
    await assert.rejects(failing.archiveRunTeamDocuments([
      { id: 'd2', title: 'aaaaaa/guides/old', projectId: null, teamId: 'team-eng', trashed: true },
      { id: 'd3', title: 'aaaaaa/notes', projectId: null, teamId: 'team-docs', trashed: false },
      { id: 'd5', title: 'aaaaaa/loose', projectId: null, teamId: null, trashed: false },
    ], 'aaaaaa', 'Spare shelf aaaaaa'), /archived 1; not archived: document d5 has neither a project nor a team; document d2: quota/);
    assert.deepEqual(calls.filter((call) => /^(restore|trash|move)/.test(call)), ['restore d2', 'trash d2', 'move d3 project-team-docs']);
    // Never another run's document.
    await assert.rejects(world.archiveRunTeamDocuments([{ id: 'x', title: 'bbbbbb/notes', projectId: null, teamId: 'team-eng', trashed: false }], 'aaaaaa', 'Spare shelf aaaaaa'), /not a team-zone document of run aaaaaa/);
  });
});

describe('titles that are not paths', () => {
  // Expected paths are written by hand from the documented path rule, not taken from the engine.
  it('percent-encode unsafe characters within each segment', () => {
    assert.equal(encodeTitlePath('Notes: draft?*'), 'Notes%3A draft%3F%2A');
    assert.equal(encodeTitlePath('notes/pipe | table'), 'notes/pipe %7C table');
    assert.equal(encodeTitlePath('notes/back\\slash'), 'notes/back%5Cslash');
    assert.equal(encodeTitlePath('say "hi" <now>'), 'say %22hi%22 %3Cnow%3E');
    assert.equal(encodeTitlePath('notes%3A'), 'notes%253A');
    assert.equal(encodeTitlePath('tab\there\u007f'), 'tab%09here%7F');
  });
  it('keep leading spaces and encode trailing periods and spaces', () => {
    assert.equal(encodeTitlePath('  notes/leading spaces'), '  notes/leading spaces');
    assert.equal(encodeTitlePath(' leading'), ' leading');
    assert.equal(encodeTitlePath('notes /trailing. '), 'notes%20/trailing%2E%20');
    assert.equal(encodeTitlePath('wait...'), 'wait%2E%2E%2E');
    assert.equal(encodeTitlePath('a. b'), 'a. b');
    // A segment of spaces only has no leading part to keep: all of it is trailing.
    assert.equal(encodeTitlePath('notes/   /x'), 'notes/%20%20%20/x');
  });
  it('apply the reserved-segment and trailing rules together', () => {
    assert.equal(encodeTitlePath('..'), '%2E%2E');
    assert.equal(encodeTitlePath('con.'), '%63on%2E');
    assert.equal(encodeTitlePath('.git '), '.git%20');
  });
  it('encode reserved and empty segments so the path stays relative', () => {
    assert.equal(encodeTitlePath('../notes'), '%2E%2E/notes');
    assert.equal(encodeTitlePath('./notes'), '%2E/notes');
    assert.equal(encodeTitlePath('.GIT/config'), '%2EGIT/config');
    assert.equal(encodeTitlePath('.github/notes'), '.github/notes');
    assert.equal(encodeTitlePath('con'), '%63on');
    assert.equal(encodeTitlePath('drafts/LPT1.notes'), 'drafts/%4CPT1.notes');
    assert.equal(encodeTitlePath('console'), 'console');
    assert.equal(encodeTitlePath('/part/notes'), '%00/part/notes');
    assert.equal(encodeTitlePath('part//notes'), 'part/%00/notes');
  });
  it('normalize to NFC', () => {
    assert.equal(encodeTitlePath('Café'), 'Café');
  });
  it('match the independent L1R-05 samples', () => {
    const samples = JSON.parse(readFileSync(new URL('../../scenarios/unsafe-title-samples.json', import.meta.url), 'utf8')) as Array<{ alias: string; title: string; relativePathTemplate: string }>;
    for (const sample of samples.filter((entry) => !entry.relativePathTemplate.includes('{'))) {
      assert.equal(`${encodeTitlePath(sample.title)}.md`, sample.relativePathTemplate, sample.alias);
    }
  });
});

// --- executors and subjects against a local sandbox and an in-memory Linear --------------------

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

/** An in-memory Linear with the client calls the harness makes. */
class FakeLinear {
  documents = new Map<string, LinearDocument>();
  comments = new Map<string, string[]>();
  requests: string[] = [];
  #next = 0;
  stats = { total: 0 };

  add(place: { projectId?: string; teamId?: string }, title: string, content: string): LinearDocument {
    this.#next += 1;
    const id = `doc-${this.#next}`;
    const now = new Date().toISOString();
    const document: LinearDocument = { id, title, slugId: `${String(this.#next).padStart(12, '0')}`, icon: null, color: null, content, documentContentId: `content-${id}`, projectId: place.projectId ?? null, teamId: place.teamId ?? 'team-eng', trashed: false, archivedAt: null, createdAt: now, updatedAt: now };
    this.documents.set(id, document);
    return document;
  }

  /** Ids left out of every `documents(...)` query while `document(id:)` still answers: an opt-in, not Linear's measured behaviour. */
  unlisted = new Set<string>();

  /** Lists a place's documents; trashed and archived ones only with `includeArchived`, as Linear does. */
  async listDocuments(place: { projectId?: string; teamId?: string }, options: { includeArchived?: boolean } = {}) {
    return [...this.documents.values()]
      .filter((document) => (place.projectId !== undefined ? document.projectId === place.projectId : document.teamId === place.teamId))
      .filter((document) => !this.unlisted.has(document.id) && (options.includeArchived === true || (!document.trashed && document.archivedAt === null)))
      .map((document) => ({ ...document }));
  }

  async getDocuments(ids: readonly string[]) {
    return ids.flatMap((id) => (this.documents.has(id) && !this.unlisted.has(id) ? [{ ...(this.documents.get(id) as LinearDocument) }] : []));
  }

  async getDocument(id: string) {
    const document = this.documents.get(id);
    return document === undefined ? null : { ...document };
  }

  async createDocument(place: { projectId?: string; teamId?: string }, input: { title: string; content?: string }) {
    return this.add(place, input.title, input.content ?? '');
  }

  async updateDocument(id: string, patch: Partial<LinearDocument>) {
    const document = this.documents.get(id) as LinearDocument;
    Object.assign(document, patch, { updatedAt: new Date().toISOString() });
    return { ...document };
  }

  /** `documentDelete`: only to the trash, with `archivedAt` set. */
  async trashDocument(id: string) {
    Object.assign(this.documents.get(id) as LinearDocument, { trashed: true, archivedAt: new Date().toISOString() });
  }

  async restoreDocument(id: string) {
    Object.assign(this.documents.get(id) as LinearDocument, { trashed: false, archivedAt: null });
  }

  async commentOnDocument(documentContentId: string, body: string) {
    const id = documentContentId.replace(/^content-/, '');
    this.comments.set(id, [...(this.comments.get(id) ?? []), body]);
    return { id: `comment-${body.length}` };
  }

  async uploadFile(input: { filename: string }) {
    return { assetUrl: `https://uploads.linear.app/test/${input.filename}` };
  }

  async request<T>(operation: string, _kind: string, _query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.requests.push(operation);
    if (operation === 'DocumentComments' || operation === 'BlockedComments') {
      return { document: { comments: { nodes: (this.comments.get(String(variables.id)) ?? []).map((body, index) => ({ body, createdAt: new Date(index).toISOString() })) } } } as T;
    }
    if (operation === 'DeleteDocumentForGood') throw new Error('Unknown argument "permanentlyDelete"');
    throw new Error(`the fake Linear has no ${operation}`);
  }
}

const PROJECT = { id: 'project-1', name: 'Field notes aaaaaa', createdAt: '' };
const OTHER = { id: 'project-2', name: 'Garden plans aaaaaa', createdAt: '' };

/**
 * A local hook repository standing in for the released hook: its
 * `linear-format` runs this checkout's fixer and leaves the environment it
 * saw in `<root>/hook-env`. Returns the corpus's own pre-commit configuration
 * pinned to that repository's commit.
 */
async function localHookConfig(root: string): Promise<string> {
  const repo = join(root, 'hooks');
  const git = new Git(repo, IDENTITY);
  await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', repo]);
  writeFileSync(join(repo, '.pre-commit-hooks.yaml'), '- id: linear-format\n  name: Format Markdown for Linear\n  entry: ./fix.sh\n  language: script\n  types: [markdown]\n  require_serial: true\n');
  writeFileSync(join(repo, 'fix.sh'), `#!/bin/sh\nenv > ${JSON.stringify(join(root, 'hook-env'))}\nexec node ${JSON.stringify(engineEntry())} fix "$@"\n`, { mode: 0o755 });
  await git.run(['add', '--all']);
  await git.run(['commit', '--quiet', '-m', 'Hook']);
  const revision = (await git.text(['rev-parse', 'HEAD'])).trim();
  return preCommitConfig(revision).replace('https://github.com/mdbisync/mdbisync', repo);
}

/**
 * A converged run world: a tracked branch with two project folders and three
 * documents, their ids ref, and Linear holding the same texts. With `hooks`,
 * the person's commits go through the corpus's hooks from a local hook repository.
 */
async function fakeRun(options: { review?: string; hooks?: boolean } = {}) {
  const root = fresh('steps-');
  const remote = join(root, 'sandbox.git');
  const names = runNames('aaaaaa');
  await new Git(root, IDENTITY).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  const seed = new Git(join(root, 'seed'), IDENTITY);
  await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', join(root, 'seed')]);
  const hookConfig = options.hooks === true ? await localHookConfig(root) : 'repos:\n  - repo: https://github.com/example/hooks\n    rev: v1\n    hooks:\n      - id: linear-format\n  - repo: local\n    hooks:\n      - id: test-secret\n        alias: security\n';
  const files: Record<string, string> = {
    'eng/platform/README.md': `---\nlinear-project: ${PROJECT.name}\n---\n`,
    'docs/handbook/README.md': `---\nlinear-project: ${OTHER.name}\n---\n`,
    'eng/platform/plan.md': '# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n',
    'eng/platform/notes.md': '# Notes\n\nKept short.\n',
    'docs/handbook/start.md': '# Start\n\nWelcome.\n',
    '.pre-commit-config.yaml': hookConfig,
    [CHECK_WORKFLOW_PATH]: CHECK_WORKFLOW,
    ...(options.review === undefined ? {} : { 'eng/platform/guides/weekly-plan.md': options.review }),
  };
  for (const [path, text] of Object.entries(files)) {
    spawnSync('mkdir', ['-p', join(seed.dir, path, '..')]);
    writeFileSync(join(seed.dir, path), text);
  }
  await seed.run(['add', '--all']);
  await seed.run(['commit', '--quiet', '-m', 'Starting tree']);
  await seed.run(['push', '--quiet', remote, `HEAD:refs/heads/${names.trackedBranch}`]);
  const linear = new FakeLinear();
  const ids: Record<string, { id: string }> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.md')) continue;
    const projectId = path.startsWith('eng/') ? PROJECT.id : OTHER.id;
    const title = path.replace(/^(eng\/platform|docs\/handbook)\//, '').replace(/\.md$/, '');
    ids[path] = { id: linear.add({ projectId }, title, text.replace(/^---\n[\s\S]*?\n---\n/, '')).id };
  }
  // The ids state ref, as the engine records it.
  const blob = (await seed.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(ids) })).trim();
  const tree = (await seed.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
  const commit = (await seed.text(['commit-tree', tree, '-m', 'ids'])).trim();
  await seed.run(['push', '--quiet', remote, `${commit}:${names.refPrefix}/ids`]);

  const stateDir = join(root, 'state');
  const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir, runId: names.runId });
  const docs = ['eng/platform/plan.md', 'eng/platform/notes.md', 'docs/handbook/start.md', ...(options.review === undefined ? [] : [])];
  const runTree: RunTree = {
    paths: new Map([...Object.keys(files)].filter((path) => path.endsWith('.md')).map((path) => [path, path])),
    rewritten: new Map([['eng/platform/README.md', files['eng/platform/README.md'] as string], ['docs/handbook/README.md', files['docs/handbook/README.md'] as string]]),
    projects: new Map([['PROJECT_ENG_1', PROJECT.name], ['PROJECT_DOCS_1', OTHER.name]]),
    teamZones: new Map(),
    teams: new Set(['ENG', 'DOCS']),
  };
  const created: string[] = [];
  const liveWorld: LiveWorld = {
    sandbox,
    rest: { pullRequests: async () => [] } as never,
    githubToken: 'unused',
    githubTokenSource: 'host',
    repository: 'example/sandbox',
    manifest: { seed: 'test', files: Object.keys(files).filter((path) => path.endsWith('.md')).map((path) => ({ path, group: 'work-documents', kind: 'markdown' as const, synced: true, lfs: false, canary: null, class: null, rule: null })) },
    tree: runTree,
    projects: new Map([['PROJECT_ENG_1', PROJECT], ['PROJECT_DOCS_1', OTHER]]),
    teams: new Map([['ENG', { id: 'team-eng', key: 'ENG', name: 'Engineering' }]]),
    app: linear as never,
    editors: { 'editor-a': linear as never, 'editor-b': linear as never },
    world: { createProject: async (name: string) => { created.push(name); return { id: `project-${name}`, name, createdAt: '' }; } } as never,
    engineApp: { clientId: 'id', clientSecret: 'secret' },
    seededDocuments: [],
    download: async () => Buffer.alloc(0),
    documentUrlBase: 'https://linear.app/test/document',
  };
  let person: Git | undefined;
  const faults: unknown[] = [];
  const ctx: RunContext = {
    scenario: { ...scenarios[0], setup: { state: 'converged', fixtures: [], teamZoneLock: false }, steps: [], checks: { invariants: scenarios[0]?.checks.invariants as never, assertions: [] } } as never,
    names,
    runDir: join(root, 'run'),
    live: liveWorld,
    sandbox,
    proxy: { url: 'http://127.0.0.1:1', requests: [], tokens: () => [], setFaults: (next: readonly unknown[]) => void faults.push(...next), clearFaults: () => {}, counts: () => ({ total: 0, queries: 0, mutations: 0, injected: 0 }), resetCounters: () => {}, close: async () => {} },
    checkpoints: new CheckpointControl(join(root, 'run', 'hooks')),
    engine: { results: [], setupRuns: 0, env: {}, restores: [] },
    edits: [],
    ownCommits: [],
    observations: new Map(),
    uiSteps: 0,
    sequence: 0,
    log: () => {},
    phase: () => {},
    signal: new AbortController().signal,
    async person() {
      person ??= await sandbox.clone(names, join(root, 'run', 'person'));
      return person;
    },
    async personHooks() {
      // Without a hook repository, these runs commit as before: the clone has no hooks installed.
      if (options.hooks === true) await installHooks(await ctx.person());
    },
    async engineClone() {
      return join(root, 'run', 'engine');
    },
    async corpusFile() {
      return null;
    },
  };
  const remoteGit = new Git(remote, IDENTITY);
  const remoteFile = async (path: string, ref = names.trackedBranch) => remoteGit.text(['show', `${ref}:${path}`]);
  // The file's exact bytes, final newline included.
  const rawFile = async (path: string) => (await remoteGit.run(['show', `${names.trackedBranch}:${path}`])).stdout.toString('utf8');
  return { ctx, linear, ids, remoteGit, remoteFile, rawFile, faults, created, docs };
}

describe('marker-driven checks', () => {
  it('writes and releases the marker on the sync branch, retaining later edits without force pushes', async () => {
    const { ctx, remoteGit, remoteFile, linear, ids } = await fakeRun();
    mkdirSync(ctx.sandbox!.cache.dir, { recursive: true });
    const prs: PullRequest[] = [];
    const checked: string[] = [];
    const methods: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/repos/example/sandbox', '');
      methods.push(`${init?.method} ${path}`);
      if (path === '/pulls' && init?.method === 'GET') return Response.json(prs);
      if (path === '/pulls' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        assert.equal(body.head, ctx.names.syncBranch);
        assert.equal(body.base, ctx.names.trackedBranch);
        const sha = (await remoteGit.text(['rev-parse', ctx.names.syncBranch])).trim();
        const pr = { number: 1, state: 'open', head: { ref: body.head, sha }, base: { ref: body.base }, merged_at: null } as PullRequest;
        prs.push(pr);
        return Response.json(pr);
      }
      const sha = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(path)?.[1];
      assert.ok(sha, path);
      assert.equal(sha, (await remoteGit.text(['rev-parse', ctx.names.syncBranch])).trim());
      checked.push(sha);
      const marker = await remoteGit.run(['show', `${sha}:${CHECK_MARKER}`], { okCodes: [0, 128] });
      const state = marker.code === 0 ? marker.stdout.toString().trim() : 'passed';
      return Response.json({ check_runs: [{ id: 1, name: 'format', app: { slug: 'github-actions' }, status: state === 'pending' ? 'in_progress' : 'completed', conclusion: state === 'pending' ? null : state === 'passed' ? 'success' : 'failure' }] });
    }) as typeof fetch;
    ctx.live!.rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', fetchImpl);
    const tracked = (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim();
    await runStep(ctx, { kind: 'fault', action: 'checks', args: { status: 'pending' } });
    const pending = checked.at(-1)!;
    assert.equal((await remoteFile(CHECK_MARKER, ctx.names.syncBranch)).trim(), 'pending');
    assert.equal(prs.length, 1);
    // A fake capture appends the editor's Linear changes while the check is pending.
    const path = 'eng/platform/plan.md';
    await runStep(ctx, { kind: 'linear', action: 'edit', args: { actor: 'editor-a', target: path } });
    await runStep(ctx, { kind: 'linear', action: 'edit', args: { actor: 'editor-b', target: path } });
    const edit = linear.documents.get(ids[path]!.id)!.content!;
    const git = await ctx.person();
    await git.run(['fetch', '--quiet', 'origin', `refs/heads/${ctx.names.syncBranch}`]);
    await git.run(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    const editCommit = await personCommit(git, ctx.names, new Map([[path, edit]]), 'Update the plan', { verify: false, branch: ctx.names.syncBranch });
    await runStep(ctx, { kind: 'fault', action: 'checks', args: { name: 'format', status: 'failed' } });
    assert.equal((await remoteFile(CHECK_MARKER, ctx.names.syncBranch)).trim(), 'failed');
    await runStep(ctx, { kind: 'fault', action: 'checks', args: { status: 'passed' } });
    const passed = checked.at(-1)!;
    assert.equal((await remoteGit.run(['cat-file', '-e', `${passed}:${CHECK_MARKER}`], { okCodes: [0, 128] })).code, 128);
    assert.equal(await remoteFile(path, ctx.names.syncBranch), edit.trimEnd());
    await remoteGit.run(['merge-base', '--is-ancestor', pending, editCommit]);
    await remoteGit.run(['merge-base', '--is-ancestor', editCommit, passed]);
    assert.equal((await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim(), tracked);
    assert.equal(prs.length, 1);
    assert.equal(checked.length, 3);
    assert.ok(checked.every((sha) => ctx.ownCommits.includes(sha)));
    assert.ok(methods.every((method) => method.startsWith('GET ') || method === 'POST /pulls'));
  });

  it('waits past absent, unrelated, skipped and stale checks until the requested state', async () => {
    for (const wanted of ['pending', 'failed', 'passed'] as const) {
      let polls = 0;
      const rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async (_input, init) => {
        assert.equal(init?.method, 'GET');
        polls += 1;
        const check = { id: polls, name: 'format', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' };
        if (polls === 1) return Response.json({ check_runs: [] });
        if (polls === 2) return Response.json({ check_runs: [{ ...check, name: 'other' }] });
        if (polls === 3) return Response.json({ check_runs: [{ ...check, conclusion: 'skipped' }] });
        if (polls === 4) return Response.json({ check_runs: [{ ...check, app: { slug: 'another-app' } }] });
        return Response.json({ check_runs: [
          { ...check, id: 0, conclusion: 'failure' },
          { ...check, status: wanted === 'pending' ? 'queued' : 'completed', conclusion: wanted === 'pending' ? null : wanted === 'failed' ? 'failure' : 'success' },
        ] });
      }) as typeof fetch);
      await waitForCheck(rest, 'abc123', wanted, { pollMs: 0, timeoutMs: 1000 });
      assert.equal(polls, 5);
    }
  });

  it('bounds waits and obeys cancellation', async () => {
    const rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => Response.json({ check_runs: [] })) as typeof fetch);
    await assert.rejects(waitForCheck(rest, 'abc', 'failed', { timeoutMs: 0 }), ProductError);
    const queued = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => Response.json({ check_runs: [{ id: 1, name: 'format', app: { slug: 'github-actions' }, status: 'queued', conclusion: null }] })) as typeof fetch);
    await assert.rejects(waitForCheck(queued, 'abc', 'passed', { timeoutMs: 0 }), EnvBlockedError);
    await assert.rejects(waitForCheck(rest, 'abc', 'passed', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  });

  it('keeps the L5-17 setup error visible to scenario assertions', async () => {
    const { ctx } = await fakeRun();
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: { pullRequest: { pullRequest: { number: 1, opened: true } } } });
    ctx.engine.results.push({ command: 'sync', exitCode: 1, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: {
      summary: null, code: 'check-failed', pullRequest: { code: 'check-failed', checks: { failed: ['format'] }, merged: null }, writtenCount: 0,
    } });
    const scenario = scenarios.find((item) => item.id === 'L5-17')!;
    for (const assertion of scenario.checks.assertions.filter((item) => item.subject.startsWith('runs.1.'))) {
      const subject = await resolveSubject(ctx, assertion.subject);
      assert.equal(subject.known, true);
      assert.deepEqual(subject.value, assertion.expected, assertion.subject);
    }
  });
});

describe('person commits through the repository hooks', () => {
  // Hook environments of these tests stay in a folder of their own; later tests see the variable as it was.
  const saved = process.env.PRE_COMMIT_HOME;
  before(() => {
    process.env.PRE_COMMIT_HOME = fresh('pre-commit-');
  });
  after(() => {
    if (saved === undefined) delete process.env.PRE_COMMIT_HOME;
    else process.env.PRE_COMMIT_HOME = saved;
  });

  it('commits the text the Linear-format hook fixed', async () => {
    const { ctx, rawFile } = await fakeRun({ hooks: true });
    // Linear's form has no final newline: the hook fixes it away.
    const commit = await commitAsPerson(ctx, new Map([['eng/platform/fixable.md', '# Plan\n\n*one*\n']]), 'Add a page');
    assert.equal(await rawFile('eng/platform/fixable.md'), '# Plan\n\n*one*');
    assert.deepEqual(ctx.ownCommits, [commit]);
    assert.equal((await (await ctx.person()).text(['status', '--porcelain'])).trim(), '');
    // A git step commits through the same hooks.
    await runStep(ctx, { kind: 'git', action: 'add', args: {} });
    const added = await rawFile(ctx.observations.get('git.added') as string);
    assert.ok(added.startsWith('# Notes\n\n') && !added.endsWith('\n'), added);
  });

  it('moves through the hooks and records the text as committed', async () => {
    const { ctx, rawFile } = await fakeRun({ hooks: true });
    let installs = 0;
    const install = ctx.personHooks.bind(ctx);
    ctx.personHooks = async () => {
      installs += 1;
      await install();
    };
    await runStep(ctx, { kind: 'git', action: 'move', args: { target: 'eng/platform/notes.md' } });
    const moved = (ctx.observations.get('git.moved') as { to: string }).to;
    // The moved file is fixed into Linear's form on the way in.
    assert.equal(await rawFile(moved), '# Notes\n\nKept short.');
    assert.equal(installs, 1);
    await runStep(ctx, { kind: 'git', action: 'edit', args: { target: 'eng/platform/plan.md' } });
    assert.equal(ctx.observations.get('edited.gitBody'), await rawFile('eng/platform/plan.md'));
    assert.equal((await (await ctx.person()).text(['status', '--porcelain'])).trim(), '');
  });

  it('fails a commit the hook refuses and commits it when the step bypasses the hook', async () => {
    const { ctx, remoteGit, rawFile } = await fakeRun({ hooks: true });
    const head = async () => (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim();
    const before = await head();
    const refused = await runStep(ctx, { kind: 'git', action: 'add-footnote', args: {} }).then(() => null, (error: unknown) => error);
    assert.ok(refused instanceof HookRejectedError, String(refused));
    assert.deepEqual(refused.hooks, ['linear-format']);
    assert.equal(await head(), before);
    assert.equal((await (await ctx.person()).text(['status', '--porcelain'])).trim(), '');
    // L2-13: the footnote goes in past the hook.
    await runStep(ctx, { kind: 'git', action: 'add-footnote', args: { bypassHook: true } });
    assert.notEqual(await head(), before);
    assert.match(await rawFile(ctx.observations.get('target.path') as string), /\[\^1\]: Added later\.\n$/);
  });

  it('never lets the test secret reach the repository', async () => {
    const { ctx, remoteGit } = await fakeRun({ hooks: true });
    const secret = `TESTKEY-${'0123456789abcdef01234567'}`;
    await assert.rejects(
      commitAsPerson(ctx, new Map([['eng/platform/notes.md', `# Notes\n\nAccess key ${secret}.`]]), 'Update notes'),
      (error: unknown) => error instanceof HookRejectedError && error.hooks.join() === 'test-secret' && !error.message.includes(secret),
    );
    assert.doesNotMatch(await remoteGit.text(['log', '-p', '--all']), new RegExp(secret));
  });

  it('reports a failure no hook caused as git\'s own error', async () => {
    const { ctx } = await fakeRun({ hooks: true });
    await installHooks(await ctx.person());
    // Nothing staged: git refuses the commit before any hook fails.
    await assert.rejects(commitStaged(await ctx.person(), [], 'Nothing', true), (error: unknown) => error instanceof GitError && !(error instanceof HookRejectedError));
  });

  // Values the harness can hold in its environment (test/e2e/harness/config.ts) and the sandbox's credential header.
  const SECRETS = {
    LINEAR_TEST_APP_CLIENT_SECRET: 'app-secret-value',
    LINEAR_TEST_ALICE_API_KEY: 'editor-key-value',
    SYNC_APP_PRIVATE_KEY: 'private-key-value',
    GIT_CONFIG_VALUE_1: 'AUTHORIZATION: basic other-header-value',
    GITHUB_TOKEN: 'github-token-value',
  };
  // What may reach hook code besides the allowlist: the identity, git's base settings, what git sets for its hooks and what the shell sets itself.
  const ALLOWED = new Set([...HOOK_ENV_KEYS, 'GIT_TERMINAL_PROMPT', 'GIT_LFS_SKIP_SMUDGE', 'GIT_EDITOR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_EXEC_PATH', 'PWD', 'SHLVL', '_', 'OLDPWD']);
  /** The inherited variables (the process's, the secrets, the sandbox's git settings) that reached a recorded environment. */
  const leaked = (recorded: string, inherited: Record<string, string | undefined>) => {
    const names = new Set(recorded.split('\n').map((line) => line.split('=')[0] as string));
    return Object.keys(inherited).filter((name) => names.has(name) && !ALLOWED.has(name));
  };

  it('installs the hooks with no secret in the installer\'s environment', async () => {
    const { ctx } = await fakeRun({ hooks: true });
    // A stand-in pre-commit first on PATH records the environment it was given.
    const bin = fresh('fake-pre-commit-');
    const seen = join(bin, 'env');
    writeFileSync(join(bin, 'pre-commit'), `#!/bin/sh\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    const from = { ...process.env, ...SECRETS, GIT_CONFIG_COUNT: '2', PATH: `${bin}:${process.env.PATH ?? ''}` };
    await installHooks(await ctx.person(), { from });
    const env = readFileSync(seen, 'utf8');
    assert.deepEqual(leaked(env, from), []);
    for (const value of Object.values(SECRETS)) assert.ok(!env.includes(value));
    assert.match(env, /^PATH=/m);
    assert.match(env, /^GIT_TERMINAL_PROMPT=0$/m);
  });

  it('runs the hooks of a commit with no secret in their environment', async () => {
    const saved = Object.fromEntries(Object.keys(SECRETS).map((name) => [name, process.env[name]]));
    Object.assign(process.env, SECRETS);
    try {
      const { ctx, rawFile } = await fakeRun({ hooks: true });
      await commitAsPerson(ctx, new Map([['eng/platform/fixable.md', '# Plan\n\n*one*\n']]), 'Add a page');
      const env = readFileSync(join(ctx.runDir, '..', 'hook-env'), 'utf8');
      // The sandbox's own git settings (its credential header) count as inherited too.
      const inherited = { ...process.env, ...ctx.live!.sandbox.env(PERSON) };
      assert.deepEqual(leaked(env, inherited).filter((name) => !/^GIT_(AUTHOR|COMMITTER)_/.test(name)), []);
      for (const value of Object.values(SECRETS)) assert.ok(!env.includes(value));
      assert.ok(!env.includes('AUTHORIZATION'), 'the sandbox credential header reached the hook');
      assert.match(env, /^GIT_AUTHOR_NAME=Test Editor$/m);
      assert.equal(await rawFile('eng/platform/fixable.md'), '# Plan\n\n*one*');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('tells a network failure while installing from a defect of the released hook', () => {
    for (const code of ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'E503', 'E429', 'ENOSPC', 'SELF_SIGNED_CERT_IN_CHAIN', 'EALLOWGIT']) {
      assert.ok(installFailure(`npm error code ${code}\n`) instanceof EnvBlockedError, code);
    }
    assert.ok(installFailure('An unexpected error has occurred\n') instanceof EnvBlockedError);
    const defect = installFailure('npm error code EJSONPARSE\n');
    assert.ok(defect instanceof ProductError && !(defect instanceof EnvBlockedError));
    assert.match(defect.message, /npm EJSONPARSE/);
  });

  it('refuses to install hooks pinned to anything but a released commit', async () => {
    const { ctx } = await fakeRun();
    await assert.rejects(installHooks(await ctx.person()), (error: unknown) => error instanceof EnvBlockedError && /"v1", not a released commit SHA/.test(error.message));
  });

  it('commits without the hooks only when asked to', async () => {
    const { ctx, rawFile } = await fakeRun({ hooks: true });
    await installHooks(await ctx.person());
    await personCommit(await ctx.person(), ctx.names, new Map([['eng/platform/raw.md', '# Raw\n\n*one*\n']]), 'Add raw notes', { verify: false });
    assert.equal(await rawFile('eng/platform/raw.md'), '# Raw\n\n*one*\n');
  });
});

describe('the scratch-hook scenario (L0-08)', () => {
  const L0_08 = scenarios.find((scenario) => scenario.id === 'L0-08')!;
  // Values the harness can hold in its environment; none may reach the hook or its installer.
  const SECRETS = { LINEAR_TEST_APP_CLIENT_SECRET: 'app-secret-value', SYNC_APP_PRIVATE_KEY: 'private-key-value', GITHUB_TOKEN: 'github-token-value' };

  /** An offline run of L0-08 whose corpus holds `config` as its pre-commit configuration. */
  async function offlineRun(config: string | null) {
    const { ctx } = await fakeRun();
    const run: RunContext = { ...ctx, scenario: L0_08, live: null, runDir: fresh('scratch-run-'), observations: new Map(), corpusFile: async (path) => (path === '.pre-commit-config.yaml' ? config : null) };
    return run;
  }

  async function assertionsHold(ctx: RunContext): Promise<void> {
    for (const assertion of L0_08.checks.assertions) {
      const { value } = await resolveSubject(ctx, assertion.subject);
      const expected = assertion.operator === 'same-as' ? (await resolveSubject(ctx, String(assertion.expected))).value : assertion.expected;
      assert.deepEqual(value, expected, `${assertion.subject} ${assertion.operator} ${JSON.stringify(assertion.expected)}`);
    }
  }

  /** Sets `vars` in this process's environment for `body`, then restores what was there. */
  async function withEnv<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
    Object.assign(process.env, vars);
    try {
      return await body();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('installs the corpus\'s pinned hook through pre-commit and fixes, settles and refuses through it', async () => {
    const root = fresh('released-hook-');
    // The released hook's repository, served from a local stand-in: git fetches the corpus's URL from it.
    const rev = /rev: ([0-9a-f]{40})/.exec(await localHookConfig(root))?.[1] as string;
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), `[url "${join(root, 'hooks')}"]\n\tinsteadOf = ${HOOK_REPOSITORY}\n`);
    // The corpus generator's own configuration, as the sandbox's corpus holds it.
    const config = preCommitConfig(rev);
    const ctx = await offlineRun(config);
    await withEnv({ ...SECRETS, HOME: home, PRE_COMMIT_HOME: join(root, 'pre-commit') }, async () => {
      for (const step of L0_08.steps) await runStep(ctx, step);
    });
    const scratch = join(ctx.runDir, 'scratch');
    // The corpus's configuration as it is, installed by pre-commit, and nothing of this checkout's command line.
    assert.equal(readFileSync(join(scratch, '.pre-commit-config.yaml'), 'utf8'), config);
    assert.ok(!config.includes(engineEntry()));
    assert.ok(existsSync(join(scratch, '.git', 'hooks', 'pre-commit')));
    assert.equal(ctx.observations.get('hook.source'), 'published');
    // The pinned hook is what ran: it left its environment behind, without a secret.
    const env = readFileSync(join(root, 'hook-env'), 'utf8');
    for (const value of Object.values(SECRETS)) assert.ok(!env.includes(value), 'a harness secret reached the hook');
    await assertionsHold(ctx);
  });

  it('refuses a published request whose corpus has no released hook, instead of running a local one', async () => {
    // This checkout's command line as a local system hook: what source mode writes.
    const sourceRun = await offlineRun(null);
    await runStep(sourceRun, { kind: 'git', action: 'scratch-hook', args: { source: 'source' } });
    const local = readFileSync(join(sourceRun.runDir, 'scratch', '.pre-commit-config.yaml'), 'utf8');
    const released = preCommitConfig('a'.repeat(40));
    const cases: Array<[string | null, RegExp]> = [
      [local, /local hook, not the released one/],
      [released.replace(`rev: ${'a'.repeat(40)}`, 'rev: v0.1.0'), /not a released commit SHA/],
      [preCommitConfig('0'.repeat(40)), /not a released commit SHA/],
      [released.replace(HOOK_REPOSITORY, 'https://github.com/example/fork'), /not from https:\/\/github.com\/mdbisync\/mdbisync/],
      [`${released}  - repo: local\n    hooks:\n      - id: linear-format\n        name: Linear format\n        entry: "true"\n        language: system\n`, /2 times/],
      [null, /corpus has no/],
    ];
    for (const [config, reason] of cases) {
      const ctx = await offlineRun(config);
      await assert.rejects(runStep(ctx, L0_08.steps[0]!), (error: Error) => error instanceof EnvBlockedError && reason.test(error.message));
      assert.ok(!existsSync(join(ctx.runDir, 'scratch', '.pre-commit-config.yaml')), 'a hook configuration was written anyway');
      assert.ok(!ctx.observations.has('hook.source'));
    }
  });

  it('runs this checkout\'s command line only when the scenario asks for source, and needs a source', async () => {
    const ctx = await offlineRun(null);
    await runStep(ctx, { kind: 'git', action: 'scratch-hook', args: { source: 'source' } });
    assert.match(readFileSync(join(ctx.runDir, 'scratch', '.pre-commit-config.yaml'), 'utf8'), /repo: local[\s\S]*language: system/);
    // L0-08's assertion on hook.source fails for such a run.
    assert.equal(ctx.observations.get('hook.source'), 'source');
    const unnamed = await offlineRun(null);
    await assert.rejects(runStep(unnamed, { kind: 'git', action: 'scratch-hook', args: {} }), /needs source "published" or "source"/);
  });

  it('asks for the published hook in L0-08', () => {
    assert.equal(L0_08.steps[0]?.args.source, 'published');
  });
});

describe('git executors', () => {
  it('edit the target paragraph and record the edit for I2', async () => {
    const { ctx, remoteFile } = await fakeRun();
    await runStep(ctx, { kind: 'git', action: 'edit', args: { target: 'second-paragraph' } });
    const text = await remoteFile('eng/platform/notes.md').catch(() => '');
    const plan = await remoteFile('docs/handbook/start.md');
    assert.equal(ctx.edits.length, 1);
    const edited = ctx.edits[0]?.path as string;
    assert.ok((await remoteFile(edited)).includes(ctx.edits[0]?.token as string));
    assert.equal(ctx.observations.get('target.path'), edited);
    void text;
    void plan;
  });

  it('resolve a conflict on the tracked branch', async () => {
    const conflicted = `# Plan\n\n${MARKERS.git}\n\nOurs.\n\n${MARKERS.linear}\n\nTheirs.\n\n${MARKERS.end}\n`;
    const { ctx, remoteFile } = await fakeRun({ review: conflicted });
    ctx.observations.set('fixture.document', 'eng/platform/guides/weekly-plan.md');
    await runStep(ctx, { kind: 'git', action: 'resolve', args: {} });
    assert.equal(await remoteFile('eng/platform/guides/weekly-plan.md'), '# Plan\n\nOurs.');
    assert.equal(ctx.observations.get('resolved.body'), '# Plan\n\nOurs.\n');
  });

  it('commit to the sync branch as CI and as a person, recording which interleaving it was', async () => {
    const { ctx, remoteGit, remoteFile } = await fakeRun();
    await assert.rejects(runStep(ctx, { kind: 'git', action: 'ci-fix', args: {} }), ProductError);
    await remoteGit.run(['update-ref', `refs/heads/${ctx.names.syncBranch}`, ctx.names.trackedBranch]);
    await runStep(ctx, { kind: 'git', action: 'ci-fix', args: { fixes: ['stable-fix', 'linear-would-undo'] } });
    ctx.engine.pausedAt = 'after-capture-push-before-pr';
    await runStep(ctx, { kind: 'git', action: 'ci-fix', args: { target: 'first-document' } });
    await runStep(ctx, { kind: 'git', action: 'edit-sync-branch', args: {} });
    assert.equal((ctx.observations.get('ciFix.commits') as string[]).length, 3);
    assert.deepEqual(ctx.observations.get('report.interleavingsCovered'), ['fix-before-capture', 'capture-before-fix']);
    const path = ctx.observations.get('target.path') as string | undefined ?? 'docs/handbook/start.md';
    const synced = await remoteFile(path, ctx.names.syncBranch);
    assert.ok(synced.includes(ctx.observations.get('ciFix.unstable') as string));
    assert.ok(ctx.observations.has('syncBranch.personCommit'));
    // Never pushed to the tracked branch.
    assert.ok(!(await remoteFile(path)).includes(ctx.observations.get('ciFix.stable') as string));
  });

  it('drop the format hook until fault.clear puts it back', async () => {
    const { ctx, remoteFile } = await fakeRun();
    const original = await remoteFile('.pre-commit-config.yaml');
    await runStep(ctx, { kind: 'fault', action: 'hooks', args: { linearFormat: false } });
    const without = await remoteFile('.pre-commit-config.yaml');
    assert.doesNotMatch(without, /linear-format/);
    assert.match(without, /test-secret/);
    await runStep(ctx, { kind: 'fault', action: 'clear', args: {} });
    assert.equal(await remoteFile('.pre-commit-config.yaml'), original);
  });

  it('move a state ref forward while a run waits, as a stale lease', async () => {
    const { ctx, remoteGit } = await fakeRun();
    const before = (await remoteGit.text(['rev-parse', `${ctx.names.refPrefix}/ids`])).trim();
    await runStep(ctx, { kind: 'fault', action: 'stale-lease', args: { ref: 'ids' } });
    assert.equal(ctx.engine.trigger?.checkpoint, 'after-write-before-record');
    await ctx.engine.trigger?.action();
    const after = (await remoteGit.text(['rev-parse', `${ctx.names.refPrefix}/ids`])).trim();
    assert.notEqual(after, before);
    assert.equal((await remoteGit.run(['merge-base', '--is-ancestor', before, after], { okCodes: [0, 1] })).code, 0);
  });

  it('gather a folder of documents before the sync and rename it as one step', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, steps: [{ kind: 'git', action: 'move-folder', args: { documents: 2 } }] };
    await STEP_PREPARATION['git.move-folder']?.beforeSync?.(ctx, ctx.live as LiveWorld, { runStep });
    await runStep(ctx, { kind: 'git', action: 'move-folder', args: { documents: 2 } });
    const moves = ctx.observations.get('git.movedFolder') as Array<{ from: string; to: string }>;
    assert.equal(moves.length, 2);
    const listing = await remoteGit.text(['ls-tree', '-r', '--name-only', ctx.names.trackedBranch]);
    for (const move of moves) assert.ok(listing.includes(move.to), move.to);
  });

  it('point an image at an LFS object the server never got', async () => {
    const { ctx, remoteFile } = await fakeRun();
    ctx.observations.set('git.imagePath', 'eng/platform/media/diagram.png');
    await runStep(ctx, { kind: 'fault', action: 'missing-lfs-object', args: {} });
    assert.match(await remoteFile('eng/platform/media/diagram.png'), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 4096$/);
  });

  it('prepare a left-out document and make it join', async () => {
    const { ctx, remoteFile } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, steps: [{ kind: 'git', action: 'remove-footnote', args: {} }] };
    await prepareFixtures(ctx, ctx.live as LiveWorld, 'beforeSync', { runStep });
    const path = ctx.observations.get('fixture.leftOut') as string;
    assert.match(await remoteFile(path), /\[\^1\]/);
    await runStep(ctx, { kind: 'git', action: 'remove-footnote', args: {} });
    assert.doesNotMatch(await remoteFile(path), /\[\^/);
  });
});

describe('linear executors', () => {
  const conflicted = `# Plan\n\n${MARKERS.git}\n\nOurs.\n\n${MARKERS.linear}\n\nTheirs.\n\n${MARKERS.end}\n`;

  it('resolve, cut one marker, and edit inside the markers', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const id = ids['eng/platform/notes.md']?.id as string;
    const reset = () => void ((linear.documents.get(id) as LinearDocument).content = conflicted);
    reset();
    await runStep(ctx, { kind: 'linear', action: 'resolve', args: { target: 'eng/platform/notes.md' } });
    assert.equal(linear.documents.get(id)?.content, '# Plan\n\nTheirs.\n');
    reset();
    await runStep(ctx, { kind: 'linear', action: 'remove-one-marker', args: { target: 'eng/platform/notes.md' } });
    assert.equal(scanMarkers(linear.documents.get(id)?.content ?? '').markerLines, 2);
    reset();
    await runStep(ctx, { kind: 'linear', action: 'edit-inside-markers', args: { target: 'eng/platform/notes.md' } });
    assert.match(linear.documents.get(id)?.content ?? '', /^Theirs\. The review moved/m);
    reset();
    await runStep(ctx, { kind: 'linear', action: 'conflict-again', args: { target: 'eng/platform/notes.md' } });
    assert.match(linear.documents.get(id)?.content ?? '', /^Ours\. The review moved/m);
  });

  it('change icon, color and comments, move projects, and leave the scope', async () => {
    const { ctx, linear, ids, created } = await fakeRun();
    const plan = ids['eng/platform/plan.md']?.id as string;
    await runStep(ctx, { kind: 'linear', action: 'metadata', args: { target: 'eng/platform/plan.md', variants: ['icon', 'color', 'comment'] } });
    assert.equal(linear.documents.get(plan)?.icon, 'Fire');
    assert.equal(linear.comments.get(plan)?.length, 1);
    await runStep(ctx, { kind: 'linear', action: 'move-project', args: { target: 'eng/platform/plan.md' } });
    assert.equal(linear.documents.get(plan)?.projectId, OTHER.id);
    assert.equal(ctx.observations.get('expected.destinationPath'), 'docs/handbook/plan.md');
    ctx.observations.delete('target.paths');
    await runStep(ctx, { kind: 'linear', action: 'out-of-scope', args: { variants: ['unmapped-project', 'trash'] } });
    assert.deepEqual(created, ['Spare drawer aaaaaa']);
    assert.equal((ctx.observations.get('target.paths') as string[]).length, 2);
    assert.ok([...linear.documents.values()].some((document) => document.trashed));
  });

  it('record how a blocked document looked before the secret goes', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const id = ids['eng/platform/plan.md']?.id as string;
    await runStep(ctx, { kind: 'linear', action: 'edit', args: { target: 'eng/platform/plan.md', fixture: 'fake-secret' } });
    const secret = ctx.observations.get('secret.value') as string;
    assert.match(secret, /^TESTKEY-[0-9a-f]{24}$/);
    Object.assign(linear.documents.get(id) as LinearDocument, { icon: 'Cross', color: 'red' });
    linear.comments.set(id, ['Blocked by hook `test-secret`, line 3.']);
    await runStep(ctx, { kind: 'linear', action: 'remove-secret', args: {} });
    assert.equal(ctx.observations.get('blocked.icon'), 'Cross');
    assert.ok(!(linear.documents.get(id)?.content ?? '').includes(secret));
    assert.deepEqual(await resolveSubject(ctx, 'blocked.commentFields'), { known: true, value: ['hook', 'line'] });
  });

  it('reject a document by its recorded id and its name, without taking over the scenario\'s target', async () => {
    const { ctx, ids, faults, remoteGit } = await fakeRun();
    await runStep(ctx, { kind: 'fault', action: 'reject-document', args: { target: 'eng/platform/notes.md' } });
    assert.deepEqual(faults, [{ kind: 'reject-document', ids: [ids['eng/platform/notes.md']?.id], titles: ['notes'] }]);
    assert.equal(ctx.observations.has('target.path'), false);
    // A converged run whose ids ref is gone is the engine's gap, not a quiet fall back to the name.
    await remoteGit.run(['update-ref', '-d', `${ctx.names.refPrefix}/ids`]);
    const git = await ctx.person();
    await git.run(['update-ref', '-d', `${ctx.names.refPrefix}/ids`], { okCodes: [0, 1] });
    await assert.rejects(runStep(ctx, { kind: 'fault', action: 'reject-document', args: { target: 'eng/platform/notes.md' } }), ProductError);
  });

  it('tells the engine a document is gone for good when Linear cannot delete one', async () => {
    const { ctx, ids, faults } = await fakeRun();
    ctx.observations.set('fixture.trashedDocument', { path: 'eng/platform/notes.md', id: ids['eng/platform/notes.md']?.id });
    await runStep(ctx, { kind: 'linear', action: 'delete-permanently', args: {} });
    assert.equal(ctx.observations.get('fault.documentGone'), 'proxy');
    assert.deepEqual(faults, [{ kind: 'document-gone', id: ids['eng/platform/notes.md']?.id }]);
  });
});

describe('I6 requires a completed no-change sync', () => {
  const complete = { operation: 'sync', ok: true, complete: true, capture: { ok: true }, code: null, changed: false };
  const cases = [
    { name: 'a complete quiet run', report: complete, exitCode: 0, pass: true },
    { name: 'a partial capture with a successful exit', report: { ...complete, complete: false, capture: { ok: false }, code: 'capture-failed' }, exitCode: 0, pass: false, reason: /capture.ok false.*capture-failed/ },
    { name: 'a stopped run with a successful exit', report: { ...complete, complete: false, code: 'stopped' }, exitCode: 0, pass: false, reason: /complete false.*stopped/ },
    { name: 'an unsuccessful run despite a complete report', report: complete, exitCode: 1, pass: false, reason: /exit 1/ },
    { name: 'a failed report despite a successful exit', report: { ...complete, ok: false }, exitCode: 0, pass: false, reason: /ok false/ },
    { name: 'a missing report', report: null, exitCode: 0, pass: false, reason: /lacks a successful completed report/ },
    { name: 'a report without completion evidence', report: { operation: 'sync', ok: true }, exitCode: 0, pass: false, reason: /complete undefined/ },
    { name: 'a report from another command', report: { ...complete, operation: 'initial-sync' }, exitCode: 0, pass: false, reason: /operation initial-sync/ },
    { name: 'a signalled run', report: complete, signal: true, exitCode: 0, pass: false, reason: /signal SIGKILL/ },
    { name: 'a complete run that writes', report: { ...complete, changed: true }, exitCode: 0, writes: 1, pass: false, reason: /wrote 1 mutations/ },
  ];
  for (const fixture of cases) it(fixture.name, async () => {
    const { ctx } = await fakeRun();
    const { INVARIANT_CHECKS, snapshotRefs } = await import('./checks.ts');
    mkdirSync(ctx.sandbox!.cache.dir, { recursive: true });
    ctx.observations.set('refHistory', [await snapshotRefs(ctx)]);
    mkdirSync(await ctx.engineClone(), { recursive: true });
    const driver = join(ctx.runDir, 'fixed-sync.mjs');
    const mutation = join(ctx.runDir, 'mutation');
    writeFileSync(driver, `
      import { writeFileSync } from 'node:fs';
      const report = ${JSON.stringify(fixture.report)};
      if (report !== null) writeFileSync(process.env.MDBISYNC_REPORT_FILE, JSON.stringify(report));
      ${fixture.writes === 1 ? `writeFileSync(${JSON.stringify(mutation)}, 'written');` : ''}
      ${fixture.signal === true ? "process.kill(process.pid, 'SIGKILL');" : `process.exitCode = ${fixture.exitCode};`}
    `);
    ctx.proxy!.counts = () => ({ total: 0, queries: 0, mutations: existsSync(mutation) ? 1 : 0, injected: 0 });
    // A prior successful run cannot stand in for the probe's own result.
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: complete });
    const previous = process.env['MDBISYNC_ENGINE'];
    process.env['MDBISYNC_ENGINE'] = driver;
    try {
      const outcome = await INVARIANT_CHECKS.I6(ctx, () => assert.fail('I6 does not need document bodies'));
      assert.equal(outcome.ok, fixture.pass, outcome.detail);
      if (fixture.reason !== undefined) assert.match(outcome.detail ?? '', fixture.reason);
      assert.equal(ctx.engine.results.length, 2);
    } finally {
      if (previous === undefined) delete process.env['MDBISYNC_ENGINE'];
      else process.env['MDBISYNC_ENGINE'] = previous;
    }
  });

  for (const resultCount of [0, 2]) it(`rejects a probe that records ${resultCount} results`, async () => {
    const { ctx } = await fakeRun();
    const { INVARIANT_CHECKS } = await import('./checks.ts');
    mkdirSync(ctx.sandbox!.cache.dir, { recursive: true });
    const prior = { command: 'sync' as const, exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: complete };
    ctx.engine.results.push(prior);
    const original = STEP_ACTIONS['run.sync'];
    STEP_ACTIONS['run.sync'] = async () => { for (let index = 0; index < resultCount; index += 1) ctx.engine.results.push(prior); };
    try {
      const outcome = await INVARIANT_CHECKS.I6(ctx, () => assert.fail('I6 does not need document bodies'));
      assert.equal(outcome.ok, false);
      assert.match(outcome.detail ?? '', new RegExp(`expected one result.*recorded ${resultCount}`));
    } finally {
      STEP_ACTIONS['run.sync'] = original!;
    }
  });
});

describe('subjects', () => {
  it('read the engine report by path and fail as a product error when it lacks a value', async () => {
    const { ctx } = await fakeRun();
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { summary: { code: 'initial-sync-required' }, writes: { total: 0 } } });
    assert.deepEqual(await resolveSubject(ctx, 'runs.0.summary.code'), { known: true, value: 'initial-sync-required' });
    assert.deepEqual(await resolveSubject(ctx, 'summary.code'), { known: true, value: 'initial-sync-required' });
    await assert.rejects(resolveSubject(ctx, 'runs.0.summary.plan.paths'), ProductError);
    await assert.rejects(resolveSubject(ctx, 'runs.1.summary.code'), ProductError);
    assert.deepEqual(await resolveSubject(ctx, 'unknown.subject'), { known: false });
    // A flat report (the job summary's fields at the top) reads the same.
    ctx.engine.results.push({ command: 'sync', exitCode: 1, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { operation: 'sync', ok: false, code: 'merge-commits-required', setupChecks: [{ name: 'linear-credentials', state: 'passed' }, { name: 'security-hooks', state: 'warning' }], securityHooks: [] } });
    assert.deepEqual(await resolveSubject(ctx, 'runs.1.summary.code'), { known: true, value: 'merge-commits-required' });
    assert.deepEqual(await resolveSubject(ctx, 'summary.setupChecks'), { known: true, value: ['linear-credentials', 'security-hooks'] });
    assert.deepEqual(await resolveSubject(ctx, 'summary.securityHooksReported'), { known: true, value: true });
    // A sync's report holds `summary: null`; its left-out rules and path rule are read at the top (L2-13, L2-22).
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { operation: 'sync', ok: true, summary: null, leftOutRules: ['footnote'], paths: { rule: 'percent-encode-unsafe-segments' } } });
    assert.deepEqual(await resolveSubject(ctx, 'summary.leftOutRules'), { known: true, value: ['footnote'] });
    assert.deepEqual(await resolveSubject(ctx, 'paths.rule'), { known: true, value: 'percent-encode-unsafe-segments' });
    ctx.engine.results.pop();
    // The checks' own run (I6) is not the scenario's last run.
    ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { code: 'nothing-to-do' } });
    assert.deepEqual(await resolveSubject(ctx, 'runs.last.summary.code'), { known: true, value: 'merge-commits-required' });
    assert.deepEqual(await resolveSubject(ctx, 'run.completed'), { known: true, value: false });
    ctx.observations.delete('scenario.runsEnd');
    // A sync's report has `summary: null` (an initial sync's plan goes there); its own fields are at the top.
    ctx.engine.results.push({ command: 'sync', exitCode: 1, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { operation: 'sync', summary: null, endpointLimitHeadersPresent: true, rejectedDocumentNamed: true } });
    assert.deepEqual(await resolveSubject(ctx, 'runs.3.summary.endpointLimitHeadersPresent'), { known: true, value: true });
    assert.deepEqual(await resolveSubject(ctx, 'runs.3.summary.rejectedDocumentNamed'), { known: true, value: true });
    // A plan under `summary` is still read there.
    ctx.engine.results.push({ command: 'initial-sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { summary: { plan: { paths: ['a.md'] } }, plan: 'top-level' } });
    assert.deepEqual(await resolveSubject(ctx, 'runs.4.summary.plan.paths'), { known: true, value: ['a.md'] });
  });

  it('compute both sides of the target document from the world', async () => {
    const { ctx, linear, ids } = await fakeRun();
    await runStep(ctx, { kind: 'git', action: 'edit', args: { target: 'eng/platform/plan.md' } });
    const id = ids['eng/platform/plan.md']?.id as string;
    const tracked = (await resolveSubject(ctx, 'tracked.body')).value as string;
    assert.ok(tracked.includes(ctx.edits[0]?.token as string));
    assert.deepEqual(await resolveSubject(ctx, 'documents.id'), { known: true, value: id });
    assert.equal((await resolveSubject(ctx, 'documents.body')).value, linear.documents.get(id)?.content);
    assert.deepEqual(await resolveSubject(ctx, 'documents.allEditsPreserved'), { known: true, value: false });
    (linear.documents.get(id) as LinearDocument).content = tracked;
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.allEditsPreserved'), { known: true, value: true });
    assert.deepEqual(await resolveSubject(ctx, 'ids.paths'), { known: true, value: ['docs/handbook/README.md', 'docs/handbook/start.md', 'eng/platform/README.md', 'eng/platform/notes.md', 'eng/platform/plan.md'] });
    assert.deepEqual(await resolveSubject(ctx, 'conflicts.markerSetCount'), { known: true, value: 0 });
    assert.deepEqual(await resolveSubject(ctx, 'documents.duplicateCount'), { known: true, value: 0 });
  });

  it('check links between documents (L1-12) against the documents Linear holds', async () => {
    const { ctx, linear, ids } = await fakeRun();
    // plan.md links notes.md with a fragment and an unsynchronized file; Linear holds it with the document URL.
    const plan = ids['eng/platform/plan.md']?.id as string;
    const notes = ids['eng/platform/notes.md']?.id as string;
    const git = await ctx.person();
    writeFileSync(join(git.dir, 'eng/platform/plan.md'), '# Plan\n\nSee [notes](notes.md#dates) and [data](data.csv).\n');
    await git.run(['commit', '--quiet', '--all', '-m', 'Link the notes']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    for (const file of ctx.live?.manifest.files ?? []) if (file.path === 'eng/platform/plan.md') file.group = 'links';
    (linear.documents.get(plan) as LinearDocument).content = `# Plan\n\nSee [notes](<https://linear.app/test/document/${notes}#dates>) and [data](data.csv).\n`;
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.syncedLinks'), await resolveSubject(ctx, 'expected.linearUrls'));
    assert.deepEqual((await resolveSubject(ctx, 'documents.syncedLinks')).value, new Map([['eng/platform/plan.md', [`${notes}#dates`]]]));
    assert.deepEqual(await resolveSubject(ctx, 'documents.supportedAnchorsPreserved'), { known: true, value: true });
    assert.deepEqual((await resolveSubject(ctx, 'documents.unsyncedLinks')).value, new Map([['eng/platform/plan.md', ['data.csv']]]));
    assert.deepEqual(await resolveSubject(ctx, 'documents.unsyncedLinks'), await resolveSubject(ctx, 'input.unsyncedLinks'));
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const sides = await readSides(ctx);
    assert.ok(sameAsFile(sides.files.get('eng/platform/plan.md') as string, linear.documents.get(plan)?.content ?? '', 'eng/platform/plan.md', sides));
    void INVARIANT_CHECKS;
    // A fragment lost on the way fails the anchor assertion.
    (linear.documents.get(plan) as LinearDocument).content = `# Plan\n\nSee [notes](https://linear.app/test/document/${notes}) and [data](data.csv).\n`;
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.supportedAnchorsPreserved'), { known: true, value: false });
  });

  it('name the files left out for size by their manifest role, not by path', async () => {
    const { ctx } = await fakeRun();
    const files = ctx.live?.manifest.files ?? [];
    files.push({ path: 'eng/platform/media/scan-11mb.pdf', group: 'attachments', kind: 'attachment', synced: false, lfs: true, canary: null, class: null, rule: null, role: 'pdf-11mb' });
    ctx.live?.tree.paths.set('eng/platform/media/scan-11mb.pdf', 'eng/platform/media/scan-11mb.pdf');
    ctx.engine.results.push({ command: 'initial-sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: { summary: { oversizeFiles: ['eng/platform/media/scan-11mb.pdf', 'eng/platform/unknown.png'] } } });
    assert.deepEqual(await resolveSubject(ctx, 'summary.oversizeFiles'), { known: true, value: ['eng/platform/unknown.png', 'pdf-11mb'] });
  });

  it('evaluate every check when one fails because the engine lacks a command', async () => {
    const { ctx } = await fakeRun();
    const { INVARIANT_CHECKS, runChecks } = await import('./checks.ts');
    const { NotImplementedError } = await import('./results.ts');
    const invariants = Object.fromEntries(Object.keys(ctx.scenario.checks.invariants).map((id) => [id, { required: id === 'I6' || id === 'I8' }]));
    ctx.scenario = { ...ctx.scenario, checks: { invariants: invariants as never, assertions: [{ subject: 'documents.duplicateCount', operator: 'equal', expected: 0 }, { subject: 'runs.0.summary.code', operator: 'equal', expected: 'x' }] } };
    const original = INVARIANT_CHECKS.I6;
    INVARIANT_CHECKS.I6 = async () => {
      throw new NotImplementedError('sync');
    };
    try {
      const outcomes = await runChecks(ctx);
      assert.deepEqual(outcomes.map((outcome) => [outcome.name, outcome.ok]), [['I6', false], ['I8', true], ['documents.duplicateCount', true], ['runs.0.summary.code', false]]);
      assert.match(outcomes[0]?.detail ?? '', /not implemented: sync/);
    } finally {
      INVARIANT_CHECKS.I6 = original;
    }
  });

  it('keep parent-relative links: resolved from their own document, not from the repository root', async () => {
    const { ctx } = await fakeRun();
    assert.deepEqual(relativeLinks('[a](../assets/brief.pdf) [b](notes.md) [c](https://example.com) [d](#top) [e](//cdn.example.com/x)'), ['../assets/brief.pdf', 'notes.md']);
    // An attachment linked as ../ from a nested document is an expected upload.
    const git = await ctx.person();
    spawnSync('mkdir', ['-p', join(git.dir, 'eng/platform/guides'), join(git.dir, 'eng/platform/assets')]);
    writeFileSync(join(git.dir, 'eng/platform/guides/howto.md'), '# How to\n\nSee [the brief](../assets/brief.pdf).\n');
    writeFileSync(join(git.dir, 'eng/platform/assets/brief.pdf'), 'pdf bytes');
    await git.run(['add', '--all']);
    await git.run(['commit', '--quiet', '-m', 'A nested guide']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    const files = ctx.live?.manifest.files ?? [];
    files.push({ path: 'eng/platform/guides/howto.md', group: 'links', kind: 'markdown', synced: true, lfs: false, canary: null, class: null, rule: null });
    files.push({ path: 'eng/platform/assets/brief.pdf', group: 'attachments', kind: 'attachment', synced: false, lfs: false, canary: null, class: null, rule: null });
    ctx.live?.tree.paths.set('eng/platform/guides/howto.md', 'eng/platform/guides/howto.md');
    ctx.live?.tree.paths.set('eng/platform/assets/brief.pdf', 'eng/platform/assets/brief.pdf');
    // The guide has a document (an id), so its attachment is one Linear should hold.
    const ids = await readRunIds(ctx);
    const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ ...Object.fromEntries([...(ids ?? new Map())]), 'eng/platform/guides/howto.md': { id: 'doc-howto' } }) })).trim();
    const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
    const parent = (await git.text(['rev-parse', `${ctx.names.refPrefix}/ids`])).trim();
    const commit = (await git.text(['commit-tree', tree, '-p', parent, '-m', 'ids'])).trim();
    await git.run(['push', '--quiet', 'origin', `${commit}:${ctx.names.refPrefix}/ids`]);
    refreshView(ctx);
    const allowed = (await resolveSubject(ctx, 'assets.allowedBytes')).value as Map<string, string>;
    assert.equal(allowed.get('eng/platform/assets/brief.pdf'), createHash('sha256').update('pdf bytes').digest('hex'));
  });

  it('check the upload cache only for documents the engine wrote, and read upload URLs in any link form', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const git = await ctx.person();
    // An image in a document the engine left out (no id) and one in a written document.
    writeFileSync(join(git.dir, 'eng/platform/left-out.md'), '![x](media/left.png)\n');
    writeFileSync(join(git.dir, 'eng/platform/notes.md'), '# Notes\n\n![y](media/kept.png) and [the brief](<media/brief.pdf#page=2>)\n');
    spawnSync('mkdir', ['-p', join(git.dir, 'eng/platform/media')]);
    writeFileSync(join(git.dir, 'eng/platform/media/left.png'), 'left bytes');
    writeFileSync(join(git.dir, 'eng/platform/media/kept.png'), 'kept bytes');
    await git.run(['add', '--all']);
    await git.run(['commit', '--quiet', '-m', 'Images']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    ctx.live?.tree.paths.set('eng/platform/left-out.md', 'eng/platform/left-out.md');
    ctx.live?.manifest.files.push({ path: 'eng/platform/left-out.md', group: 'images', kind: 'markdown', synced: true, lfs: false, canary: null, class: null, rule: null });
    refreshView(ctx);
    // No uploads yet: the written document's image is missing from the cache.
    assert.deepEqual(await resolveSubject(ctx, 'uploads.cacheComplete'), { known: true, value: false });
    // Once the written document's image is cached, the left-out document's image does not count.
    const kept = createHash('sha256').update('kept bytes').digest('hex');
    const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ [kept]: 'https://uploads.linear.app/x/kept' }) })).trim();
    const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tuploads.json\n` })).trim();
    const commit = (await git.text(['commit-tree', tree, '-m', 'uploads'])).trim();
    await git.run(['push', '--quiet', 'origin', `${commit}:${ctx.names.refPrefix}/uploads`]);
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'uploads.cacheComplete'), { known: true, value: true });
    void linear;
    void ids;
  });

  it('read conflict marks by the palette names specs use, from Linear\'s hex colors', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const id = ids['docs/handbook/start.md']?.id as string;
    Object.assign(linear.documents.get(id) as LinearDocument, { icon: 'Alert', color: '#F2994A' });
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'conflicts.markCount'), { known: true, value: 1 });
    assert.deepEqual(await resolveSubject(ctx, 'conflicts.color'), { known: true, value: 'orange' });
    assert.equal(colorLabel('#eb5757'), 'red');
    assert.equal(colorLabel('#123456'), '#123456');
  });

  it('retire the edits a resolution discards on purpose, so I2 does not count them as lost', async () => {
    const { ctx } = await fakeRun();
    ctx.edits.push({ side: 'git', path: 'a.md', token: 'aaaaaa-001' }, { side: 'linear', path: 'a.md', token: 'aaaaaa-002' });
    const conflicted = `${MARKERS.git}\n\nOurs aaaaaa-001.\n\n${MARKERS.linear}\n\nTheirs aaaaaa-002.\n\n${MARKERS.end}\n`;
    retireDiscarded(ctx, conflicted, resolveKeeping(conflicted, 'linear'));
    assert.deepEqual(ctx.edits.map((edit) => edit.retired === true), [true, false]);
    const { lostEdits } = await import('./checks.ts');
    assert.deepEqual(lostEdits(ctx, { files: new Map([['a.md', 'Theirs aaaaaa-002.\n']]), documents: new Map([['d', { content: 'Theirs aaaaaa-002.\n', trashed: false } as LinearDocument]]) }), []);
  });

  it('count uploads per content from the requests that succeeded, not from the final cache', async () => {
    const { ctx } = await fakeRun();
    const upload = { n: 1, operation: 'FileUpload', kind: 'mutation' as const, status: 200, injected: false, at: 0 };
    (ctx.proxy as unknown as { requests: unknown[] }).requests.push(upload, { ...upload, n: 2 }, { ...upload, n: 3 });
    // Three uploads for one hash in the cache: the cache entry was overwritten twice.
    const git = await ctx.person();
    const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ ['a'.repeat(64)]: 'https://uploads.linear.app/x/one' }) })).trim();
    const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tuploads.json\n` })).trim();
    const commit = (await git.text(['commit-tree', tree, '-m', 'uploads'])).trim();
    await git.run(['push', '--quiet', 'origin', `${commit}:${ctx.names.refPrefix}/uploads`]);
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'uploads.perHash'), { known: true, value: 3 });
  });

  it('compare only the valid files: a lint-error file stays in git with no document and no difference', async () => {
    const { ctx } = await fakeRun();
    // A file the corpus marks as a lint error, in git as it is, with no document in Linear.
    const git = await ctx.person();
    writeFileSync(join(git.dir, 'eng/platform/footnotes.md'), '# Notes\n\nSee this.[^1]\n\n[^1]: A footnote Linear would drop.\n');
    await git.run(['add', '--', 'eng/platform/footnotes.md']);
    await git.run(['commit', '--quiet', '-m', 'Add footnotes']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    ctx.live?.tree.paths.set('eng/platform/footnotes.md', 'eng/platform/footnotes.md');
    ctx.live?.manifest.files.push({ path: 'eng/platform/footnotes.md', group: 'lint-errors', kind: 'markdown', synced: true, lfs: false, canary: null, class: 'lint-error', rule: 'footnote' });
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const sides = await readSides(ctx);
    assert.equal(sides.files.has('eng/platform/footnotes.md'), false);
    assert.deepEqual(await INVARIANT_CHECKS.I1(ctx, async () => sides), { name: 'I1', ok: true });
    refreshView(ctx);
    assert.equal(((await resolveSubject(ctx, 'corpus.validPaths')).value as string[]).includes('eng/platform/footnotes.md'), false);
  });

  it('tell a trashed document from an archived or missing one in I7, reading unlisted ids one by one', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const i7 = async () => INVARIANT_CHECKS.I7(ctx, async () => readSides(ctx));
    assert.deepEqual(await i7(), { name: 'I7', ok: true });
    const plan = ids['eng/platform/plan.md']?.id as string;
    const notes = ids['eng/platform/notes.md']?.id as string;
    const start = ids['docs/handbook/start.md']?.id as string;
    // Trashed and read back by the batch read by id, as Linear answers.
    await linear.trashDocument(plan);
    assert.match((await i7()).detail ?? '', /^1 problems: eng\/platform\/plan\.md: its document is in Linear's trash$/);
    // Trashed, archived and deleted, none returned by any list: each read on its own.
    for (const id of [plan, notes, start]) linear.unlisted.add(id);
    (linear.documents.get(notes) as LinearDocument).archivedAt = new Date().toISOString();
    linear.documents.delete(start);
    const reads: string[] = [];
    const getDocument = linear.getDocument.bind(linear);
    linear.getDocument = async (id: string) => {
      reads.push(id);
      return getDocument(id);
    };
    const detail = (await i7()).detail ?? '';
    assert.match(detail, /eng\/platform\/plan\.md: its document is in Linear's trash/);
    assert.match(detail, /eng\/platform\/notes\.md: its document is archived/);
    assert.match(detail, /docs\/handbook\/start\.md: its document is not in Linear/);
    assert.deepEqual(reads.sort(), [plan, notes, start].sort());
  });

  it('count the engine\'s commits as git writes and not the scenario\'s own', async () => {
    const { ctx, remoteGit } = await fakeRun();
    const { snapshotRefs } = await import('./checks.ts');
    void snapshotRefs;
    ctx.observations.set('start.refs', { [`${ctx.names.refPrefix}/ids`]: (await remoteGit.text(['rev-parse', `${ctx.names.refPrefix}/ids`])).trim() });
    ctx.observations.set('start.trackedTip', (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim());
    await runStep(ctx, { kind: 'git', action: 'edit', args: {} });
    assert.deepEqual(await resolveSubject(ctx, 'writes.git'), { known: true, value: 0 });
    await runStep(ctx, { kind: 'fault', action: 'stale-lease', args: { ref: 'ids' } });
    await ctx.engine.trigger?.action();
    assert.deepEqual(await resolveSubject(ctx, 'writes.git'), { known: true, value: 1 });
    void readFileSync;
  });
});
