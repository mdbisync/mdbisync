import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LinearGraphQLError, LinearHttpError, LinearNetworkError, LinearStoppedError, LinearTokenError, type LinearDocument } from '../../../src/linear/index.ts';
import { Git, GitError, lfsReader, parseLfsPointer } from '../../../src/state/index.ts';
import { fakeLfsServer } from '../../../src/state/test-helpers.ts';
import { NEUTRAL_IDENTITY } from '../../../src/state/index.ts';
import { CheckpointControl } from './checkpoints.ts';
import { bothVersionsComplete, colorLabel, conflictScope, editParagraph, MARKERS, resolveKeeping, scanMarkers } from './conflicts.ts';
import type { LiveWorld, RunContext } from './context.ts';
import type { RunTree } from './corpus.ts';
import { FIXTURE_PREPARATION } from './runner.ts';
import { DOCUMENT_FIXTURES, fixtureEdit, LINK_PAIR, paragraphEdit, prepareFixtures, publishesCheckWorkflow, reviewDocument, seededPng, SETUP_FIXTURES, SLICE_FIXTURES, STEP_PREPARATION } from './fixtures.ts';
import { runNames } from './isolation.ts';
import { OwnershipLedger } from './ownership.ts';
import { burst, burstDocuments, burstEditCounts, editCapacity, soak, soakEditCounts, type Actor, type SoakDriver } from './load.ts';
import { CONTENT_LIMIT } from '../../../src/format/rules.ts';
import { fixText } from '../../../src/format/fix.ts';
import { blockedBySetupStop, EnvBlockedError, HarnessGapError, ProductError } from './results.ts';
import { bodyOf, compare, editsFound, holdsToken, lostEdits, differingPaths, evaluateAssertion, fileHash, gitLinks, linearLinks, sameAsFile } from './checks.ts';
import { offlineInput, readInput, runFormatCommand, writeInput } from './offline.ts';
import { BANK_DIR, engineForm, goldenMarkdownPath, loadBank, probedFixtures, readFixture } from '../../probe/bank.ts';
import { GraphQLTransport } from '../../../src/linear/transport.ts';
import { mintAppToken, revokeToken } from '../../../src/linear/token.ts';
import { startFaultProxy, withoutDocuments } from './fault-proxy.ts';
import { commitStaged, HOOK_ENV_KEYS, HookRejectedError, installFailure, installHooks, PERSON, personCommit, Sandbox } from './sandbox.ts';
import { engineEntry, REPO_ROOT, type EngineResult } from './engine.ts';
import { HOOK_REPOSITORY, preCommitConfig } from '../../corpus/tree.ts';
import { readHookConfig } from '../../../src/setup/hooks.ts';
import { CHECK_MARKER, CHECK_WORKFLOW, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { cancelPendingRuns, faultChecks, waitForCheck, waitForCheckCompleted } from './check-fault.ts';
import { SandboxRest, type PullRequest } from './github.ts';
import { loadScenarios } from './spec.ts';
import { ACTION_SHA_ENV, afterUiStep, editInsideMarkers, HARNESS_GAPS, isProbeEnvironmentError, requiredActionSha, retireDiscarded, runStep, settleFollowUpRuns, STEP_ACTIONS, watchRun } from './steps.ts';
import { commitAsPerson, folderTeam, projectFolders, readRunIds, setTarget } from './step-helpers.ts';
import { BEFORE_VIEW, documentLinks, encodeTitlePath, refreshView, relativeLinks, resolveSubject, subjectSource, takeStartView, tokenActive } from './subjects.ts';
import { engineNotImplemented, environmentBlocker, hadReplaceableRun, maxOverlap, REPORT_ARTIFACT, unzip, waitForRegistration, waitForRun } from './workflows.ts';
import type { WorkflowJob, WorkflowRun } from './github.ts';
import { engineSteps, pinnedActionSha, prerequisiteErrors, readTemplate, WORKFLOW_FILES } from './workflow-files.ts';
import { parse as parseYaml } from 'yaml';
import { buildCorpus } from '../../corpus/generate.ts';

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

describe('run.probe', () => {
  // A probe that stops at its first request with this error.
  const probeFailingWith = (error: Error) => {
    const app = { request: async () => { throw error; } };
    const ctx = { observations: new Map(), live: { app }, log: () => {} } as unknown as RunContext;
    return STEP_ACTIONS['run.probe']!(ctx, {});
  };

  it('reports env-blocked when the environment stopped the probe', async () => {
    for (const error of [
      new LinearStoppedError('Teams', { kind: 'rate-limited', operation: 'Teams' }),
      new LinearNetworkError('Teams', new Error('reset')),
      new LinearHttpError('Teams', 502),
      new LinearTokenError('oauth.token', 'refused', { httpStatus: 401 }),
    ]) {
      await assert.rejects(probeFailingWith(error), (thrown: Error) => thrown instanceof EnvBlockedError && /^format probe could not finish: /.test(thrown.message), error.name);
    }
  });

  it('lets any other error fail the scenario instead of hiding it as env-blocked', async () => {
    const bug = new TypeError('a bug in the probe');
    await assert.rejects(probeFailingWith(bug), (thrown: Error) => thrown === bug);
    const refused = new LinearGraphQLError('Teams', 400, { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    await assert.rejects(probeFailingWith(refused), (thrown: Error) => thrown === refused);
    assert.equal(isProbeEnvironmentError(new LinearHttpError('Teams', 400)), false);
    assert.equal(isProbeEnvironmentError(new Error('no team with key ENG')), false);
  });
});

describe('fault.golden-drift', () => {
  // The probe reports drift by construct, so the hand edit must land on a fixture of exactly that construct,
  // not on the first one whose name only contains it (marks-in-table-cell comes before table in the bank).
  it('edits the recorded form of a fixture whose construct is exactly the one asked for', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'golden-drift-'));
    try {
      const ctx = { observations: new Map(), runDir, log: () => {} } as unknown as RunContext;
      await STEP_ACTIONS['fault.golden-drift']!(ctx, { construct: 'table' });
      const copy = ctx.observations.get('probe.bankDir') as string;
      const edited = probedFixtures(loadBank(copy)).filter((fixture) => {
        const golden = join(copy, goldenMarkdownPath(fixture.file));
        return existsSync(golden) && readFileSync(golden, 'utf8') !== readFileSync(join(BANK_DIR, goldenMarkdownPath(fixture.file)), 'utf8');
      });
      assert.deepEqual(edited.map((fixture) => fixture.construct), ['table']);
      // The case only proves something while a recorded fixture whose construct merely contains the name comes first.
      const recorded = probedFixtures(loadBank()).filter((fixture) => existsSync(join(BANK_DIR, goldenMarkdownPath(fixture.file))));
      const exact = recorded.findIndex((fixture) => fixture.construct === 'table');
      const partial = recorded.findIndex((fixture) => fixture.construct !== 'table' && fixture.construct.includes('table'));
      assert.ok(partial !== -1 && partial < exact, 'a fixture whose construct only contains "table" comes before the table fixture');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('fails the scenario, not the environment, for a construct no probed fixture has', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'golden-drift-'));
    try {
      const ctx = { observations: new Map(), runDir, log: () => {} } as unknown as RunContext;
      await assert.rejects(STEP_ACTIONS['fault.golden-drift']!(ctx, { construct: 'tables' }), (thrown: Error) => !(thrown instanceof EnvBlockedError) && /no recorded Linear form for a tables fixture/.test(thrown.message));
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

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
  // Actions mode runs the release under test; these fakes name one.
  const RELEASE_SHA = 'c'.repeat(40);
  let savedActionSha: string | undefined;
  before(() => {
    savedActionSha = process.env[ACTION_SHA_ENV];
    process.env[ACTION_SHA_ENV] = RELEASE_SHA;
  });
  after(() => {
    if (savedActionSha === undefined) delete process.env[ACTION_SHA_ENV];
    else process.env[ACTION_SHA_ENV] = savedActionSha;
  });

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

  it('block actions mode with a clear reason when the release under test is not named, never falling back to the templates\' pin', () => {
    const pin = pinnedActionSha(readTemplate(WORKFLOW_FILES.sync));
    assert.throws(() => requiredActionSha({}), (error: Error) => error instanceof EnvBlockedError && error.message.includes(`${ACTION_SHA_ENV} is unset`) && error.message.includes(pin.slice(0, 7)));
    assert.throws(() => requiredActionSha({ [ACTION_SHA_ENV]: '  ' }), EnvBlockedError);
    assert.throws(() => requiredActionSha({ [ACTION_SHA_ENV]: 'v0.1.0' }), (error: Error) => error instanceof EnvBlockedError && /full commit SHA/.test(error.message));
    assert.equal(requiredActionSha({ [ACTION_SHA_ENV]: RELEASE_SHA }), RELEASE_SHA);
  });

  it('read "not implemented" only from the engine\'s own line in a step that runs the engine', () => {
    assert.deepEqual([...engineSteps()].sort(), ['Initial sync', 'Stage Linear\'s changes', 'Stage Linear\'s documents', 'Sync']);
    const at = '2026-11-11T19:20:00.1234567Z ';
    // The engine's own answer, as the action reports it from the sync or initial sync step.
    assert.equal(engineNotImplemented(new Map([['sync/9_Sync.txt', `${at}##[group]Run mdbisync/mdbisync@x\n${at}##[error]sync: not implemented\n`]]), 'sync'), true);
    assert.equal(engineNotImplemented(new Map([['sync 5a9cba/7_Stage Linear\'s changes.txt', `${at}##[error]sync: not implemented\r\n`]]), 'sync'), true);
    assert.equal(engineNotImplemented(new Map([['initial-sync/9_Initial sync.txt', `${at}##[error]initial-sync: not implemented\n`]]), 'initial-sync'), true);
    // An older release's post step on any failed run, or the same words outside the engine's steps.
    assert.equal(engineNotImplemented(new Map([['sync/15_Post Sync.txt', `${at}post: not implemented, nothing to clean up\n`]]), 'sync'), false);
    assert.equal(engineNotImplemented(new Map([['sync/6_Run the security hooks.txt', `${at}##[error]sync: not implemented\n`]]), 'sync'), false);
    // The job's whole log beside the step logs, another command's answer, and the words inside another line.
    assert.equal(engineNotImplemented(new Map([['0_sync.txt', `${at}##[error]sync: not implemented\n`]]), 'sync'), false);
    assert.equal(engineNotImplemented(new Map([['sync/9_Sync.txt', `${at}##[error]initial-sync: not implemented\n`]]), 'sync'), false);
    assert.equal(engineNotImplemented(new Map([['sync/9_Sync.txt', `${at}##[error]sync: not implemented yet for this path\n`]]), 'sync'), false);
  });

  it('block an actions step before it installs anything when the release under test is not named', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, mode: 'actions' };
    fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml' });
    const tip = (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim();
    delete process.env[ACTION_SHA_ENV];
    try {
      await assert.rejects(STEP_ACTIONS['git.edit']!(ctx, { workflows: true }), (error: Error) => error instanceof EnvBlockedError && error.message.includes(`${ACTION_SHA_ENV} is unset`));
      await assert.rejects(STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' }), (error: Error) => error instanceof EnvBlockedError && error.message.includes(`${ACTION_SHA_ENV} is unset`));
    } finally {
      process.env[ACTION_SHA_ENV] = RELEASE_SHA;
    }
    assert.equal((await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim(), tip, 'nothing was pushed');
    assert.equal(ctx.observations.has('workflows.installed'), false);
  });

  it('wait for a workflow to be registered, and fail as the harness when it never is', async () => {
    let calls = 0;
    const rest = { workflowId: async () => (++calls > 2 ? 42 : undefined) };
    assert.equal(await waitForRegistration(rest as never, 'mdbisync-initial-sync.yml', { pollMs: 1 }), 42);
    const never = { workflowId: async () => undefined };
    await assert.rejects(waitForRegistration(never as never, 'mdbisync-initial-sync.yml', { timeoutMs: 0, pollMs: 1 }), (error: Error) => !(error instanceof EnvBlockedError) && /not in the repository's Actions registry/.test(error.message));
  });

  /** A sandbox's Actions for one run: the workflow registry, dispatches, runs, their jobs and logs. */
  function fakeActions(ctx: RunContext, remoteGit: Git, options: { conclusion: string; jobs: WorkflowJob[]; logs: Record<string, string>; registeredAfter?: number; workflow?: string; report?: (run: WorkflowRun) => Record<string, unknown> }) {
    const runs: WorkflowRun[] = [];
    const dispatched: Array<string | number> = [];
    let registryReads = 0;
    const logZip = zip(Object.fromEntries(Object.entries(options.logs).map(([name, text]) => [name, { data: Buffer.from(text), deflate: true }])));
    const rest = {
      workflowExists: async () => true,
      workflowId: async () => (++registryReads > (options.registeredAfter ?? 0) ? 99 : undefined),
      dispatchWorkflow: async (workflow: string | number) => {
        dispatched.push(workflow);
        runs.push({ id: 500 + runs.length, event: 'workflow_dispatch', status: 'completed', conclusion: options.conclusion, created_at: new Date().toISOString(), path: `.github/workflows/${options.workflow ?? 'mdbisync-initial-sync.yml'}` });
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
        const artifacts = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
        // A run's report artifact shares the run's id.
        if (artifacts !== null) return { artifacts: options.report === undefined ? [] : [{ id: Number(artifacts[1]), name: REPORT_ARTIFACT, expired: false }] };
        throw new Error(`unexpected ${path}`);
      },
      runJobs: async () => options.jobs,
      download: async (path: string) => {
        const artifact = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
        const run = artifact === null ? undefined : runs.find((candidate) => candidate.id === Number(artifact[1]));
        if (run === undefined || options.report === undefined) return logZip;
        return zip({ 'report.json': { data: Buffer.from(JSON.stringify(options.report(run))), deflate: true } });
      },
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

  it('keep a failed run whose old post step says "not implemented" as a failure, not expected-red', async () => {
    const { ctx, remoteGit } = await fakeRun();
    const at = '2026-11-11T19:20:00.1234567Z ';
    const logs = {
      'sync/9_Sync.txt': `${at}fatal: could not read Username for 'https://github.com': No such device or address\n${at}##[error]The process '/usr/bin/git' failed with exit code 128\n`,
      'sync/15_Post Sync.txt': `${at}post: not implemented, nothing to clean up\n`,
    };
    fakeActions(ctx, remoteGit, { conclusion: 'failure', jobs: [jobWith('Sync', 9)], logs });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' });
    assert.equal(ctx.engine.results.length, 1);
    assert.equal(ctx.engine.results[0]?.notImplemented, false);
    assert.equal(ctx.observations.get('runs.0.exitCode'), 1);
    const installed = await remoteGit.text(['show', `${ctx.names.trackedBranch}:.github/workflows/mdbisync.yml`]);
    assert.ok(installed.includes(`mdbisync/mdbisync@${RELEASE_SHA}`), 'the release under test, not the templates\' pin');
    assert.ok(!installed.includes(pinnedActionSha(readTemplate(WORKFLOW_FILES.sync))));
  });

  it('settles an Actions scenario with dispatches instead of local sync processes', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, mode: 'actions', setup: { ...ctx.scenario.setup, fixtures: ['actions-security-canary'] } };
    const { dispatched } = fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml' });
    await STEP_ACTIONS['run.settle']!(ctx, {});
    assert.deepEqual(dispatched, [99, 99, 99, 99], 'without a changed=false report, settle keeps dispatching to its limit');
    assert.equal(ctx.engine.results.length, 4);
  });

  it('count the runs the concurrency group cancelled when a newer run replaced them (L4-10)', async () => {
    const l410 = scenarios.find((item) => item.id === 'L4-10')!;
    const assertion = l410.checks.assertions.find((item) => item.subject === 'workflows.replacedPending')!;
    // Three runs arrive: a push and two dispatches. `replaced`: a newer dispatch replaced the pending push run,
    // which started no job. `stopped`: the push run was cancelled while its job ran, and the first dispatch was
    // waiting when the second arrived. `apart`: nothing was cancelled and no job ran when a run arrived.
    const parallel = async (mode: 'replaced' | 'stopped' | 'apart') => {
      const { ctx, remoteGit } = await fakeRun();
      ctx.scenario = { ...ctx.scenario, mode: 'actions' };
      fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml', report: (run) => ({ operation: 'sync', capturedTrackedTip: run.head_sha ?? null }) });
      mkdirSync(ctx.live!.sandbox.cache.dir, { recursive: true });
      await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
      const rest = ctx.live!.rest as unknown as { dispatchWorkflow: (workflow: string | number) => Promise<void>; workflowRuns: () => Promise<WorkflowRun[]>; runJobs: (id: number) => Promise<WorkflowJob[]> };
      const cancelled = new Set<number>();
      const dispatch = rest.dispatchWorkflow;
      rest.dispatchWorkflow = async (workflow) => {
        await dispatch(workflow);
        for (const run of await rest.workflowRuns()) {
          if (mode === 'apart' || run.event !== 'push' || run.path !== '.github/workflows/mdbisync.yml') continue;
          run.conclusion = 'cancelled';
          cancelled.add(run.id);
        }
      };
      // The cancelled run's job ran from before the runs started until after the last one arrived.
      const job = { ...jobWith('Sync', 4), started_at: new Date(Date.now() - 60_000).toISOString(), completed_at: new Date(Date.now() + 60_000).toISOString() };
      rest.runJobs = async (id) => (mode === 'stopped' && cancelled.has(id) ? [job] : []);
      const step = STEP_ACTIONS['run.workflow-parallel']!(ctx, { events: ['push', 'workflow_dispatch'], replacePending: true });
      if (mode === 'apart') {
        await assert.rejects(step, (error: Error) => !(error instanceof ProductError) && /the runs did not overlap enough/.test(error.message));
        return ctx;
      }
      await step;
      assert.equal(ctx.engine.results.length, 2, 'only the runs that were not cancelled are settled');
      return ctx;
    };
    // A pending run the group replaced started no job: it counts, and L4-10's assertion holds.
    const replaced = await parallel('replaced');
    assert.deepEqual(await resolveSubject(replaced, 'workflows.replacedPending'), { known: true, value: 1 });
    assert.equal((await evaluateAssertion(replaced, assertion)).holds, true);
    // A run cancelled while its job ran (a timeout, a lost runner) was not a pending run replaced by the group.
    const stopped = await parallel('stopped');
    assert.deepEqual(await resolveSubject(stopped, 'workflows.replacedPending'), { known: true, value: 0 });
    assert.equal((await evaluateAssertion(stopped, assertion)).holds, false);
    // Runs that never overlapped leave no run to replace: the harness says so instead of failing the group.
    const apart = await parallel('apart');
    assert.equal(apart.observations.has('workflows.replacedPending'), false);
  });

  it('tell a race that could replace a pending run from runs that only queued one after another', () => {
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const ms = (second: number) => Date.parse(at(second));
    const run = (id: number, created: number) => ({ id, created_at: at(created) });
    // The scheduled job runs 0 to 10; the dispatch arrives at 5 and runs 10 to 20; the push arrives at 15.
    // Each later run waited alone, so a working group cancels nothing: not a race that proves the group.
    const queued = [run(1, 0), run(2, 5), run(3, 15)];
    const queuedSpans = [{ runId: 1, started: ms(0), completed: ms(10) }, { runId: 2, started: ms(10), completed: ms(20) }, { runId: 3, started: ms(20), completed: ms(30) }];
    assert.equal(hadReplaceableRun(queued, queuedSpans), false);
    // The push arrives at 7, while the scheduled job runs and the dispatch waits: the group can replace the dispatch.
    const raced = [run(1, 0), run(2, 5), run(3, 7)];
    assert.equal(hadReplaceableRun(raced, [{ runId: 1, started: ms(0), completed: ms(10) }, { runId: 3, started: ms(10), completed: ms(20) }]), true);
    // Two runs alone never make a replacement possible.
    assert.equal(hadReplaceableRun(raced.slice(0, 2), [{ runId: 1, started: ms(0), completed: ms(10) }]), false);
  });

  it('wait for the push run that the sync pull request\'s merge starts before the checks, as a deployment runs it', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, mode: 'actions' };
    // Each run's report names the tracked commit it took in: the commit its push was for.
    fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml', report: (run) => ({ operation: 'sync', capturedTrackedTip: run.head_sha ?? null }) });
    const history: Array<Record<string, string>> = [];
    ctx.observations.set('refHistory', history);
    mkdirSync(ctx.live!.sandbox.cache.dir, { recursive: true });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' });
    assert.equal(await settleFollowUpRuns(ctx), 0, 'the last run took in the tracked tip: nothing follows it');
    // That run merged the sync pull request: the merge commit lands after the tip the run took in.
    const tracked = `refs/heads/${ctx.names.trackedBranch}`;
    const taken = (await remoteGit.text(['rev-parse', tracked])).trim();
    const merge = (await remoteGit.text(['commit-tree', `${taken}^{tree}`, '-p', taken, '-m', 'Merge the sync pull request'])).trim();
    await remoteGit.run(['update-ref', tracked, merge]);
    assert.equal(await settleFollowUpRuns(ctx), 1, 'the push run of the merge is the deployment\'s, and the harness waits for it');
    assert.equal(ctx.engine.results.length, 2);
    assert.equal(ctx.engine.results.at(-1)?.report?.['capturedTrackedTip'], merge);
    assert.deepEqual((ctx.observations.get('workflows.runs') as Array<{ event: string }>).map((run) => run.event), ['push', 'push']);
    assert.equal(history.length, 1, 'the follow-up run\'s refs join the history the checks read');
    assert.equal(ctx.observations.get('scenario.stepRunsEnd'), 1);
    assert.deepEqual(await resolveSubject(ctx, 'runs.last.capturedTrackedTip'), { known: true, value: taken }, '`runs.last` still names the step\'s run');
    assert.equal(history[0]?.[`${ctx.names.refPrefix}/ids`], (await remoteGit.text(['rev-parse', `${ctx.names.refPrefix}/ids`])).trim());
    assert.equal(await settleFollowUpRuns(ctx), 0, 'once a run took in the tip, the deployment is idle');
    // A check run names no tracked commit: the latest sync's still counts.
    ctx.engine.results.push({ ...ctx.engine.results.at(-1)!, command: 'check', report: { operation: 'check', capturedTrackedTip: null } });
    assert.equal(await settleFollowUpRuns(ctx), 0);
    // Two merges in a row: the first one's push run, which no step recorded, is the deployment's too.
    const commit = async (parent: string, message: string) => (await remoteGit.text(['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message])).trim();
    const first = await commit(merge, 'First merge');
    await remoteGit.run(['update-ref', tracked, first]);
    await ctx.live!.rest.workflowRuns(ctx.names.trackedBranch);
    const second = await commit(first, 'Second merge');
    await remoteGit.run(['update-ref', tracked, second]);
    assert.equal(await settleFollowUpRuns(ctx), 2);
    assert.deepEqual(ctx.engine.results.slice(-2).map((result) => result.report?.['capturedTrackedTip']), [first, second]);
    // A local scenario has run.settle for this: nothing to wait for.
    ctx.scenario = { ...ctx.scenario, mode: 'local' };
    await remoteGit.run(['update-ref', tracked, await commit(second, 'Another')]);
    assert.equal(await settleFollowUpRuns(ctx), 0);
  });

  for (const older of ['success', 'cancelled'] as const) {
    it(`take an older push run (${older}) that no step recorded after the step's newer one, without waiting for the newer again`, async () => {
      const { ctx, remoteGit } = await fakeRun();
      ctx.scenario = { ...ctx.scenario, mode: 'actions' };
      const actions = fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml', report: (run) => ({ operation: 'sync', capturedTrackedTip: run.head_sha ?? null }) });
      mkdirSync(ctx.live!.sandbox.cache.dir, { recursive: true });
      // Commit A (the workflows) starts a push run; commit B (an edit) right after starts another.
      await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
      const tracked = `refs/heads/${ctx.names.trackedBranch}`;
      const a = (await remoteGit.text(['rev-parse', tracked])).trim();
      await ctx.live!.rest.workflowRuns(ctx.names.trackedBranch);
      for (const run of actions.runs) if (run.head_sha === a) run.conclusion = older;
      const b = (await remoteGit.text(['commit-tree', `${a}^{tree}`, '-p', a, '-m', 'Edit'])).trim();
      await remoteGit.run(['update-ref', tracked, b]);
      await STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' });
      assert.equal(ctx.engine.results.at(-1)?.report?.['capturedTrackedTip'], b, 'the step recorded the newer run');
      assert.equal(await settleFollowUpRuns(ctx), older === 'success' ? 1 : 0, 'B was taken in by a recorded run: no wait for another B run');
      assert.equal(ctx.engine.results.length, older === 'success' ? 2 : 1, 'a cancelled run did nothing and is no engine run');
      assert.equal((ctx.observations.get('workflows.runs') as unknown[]).length, 2);
    });
  }

  it('leave the push runs of a scenario without sync state alone: they end with initial-sync-required', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, mode: 'actions' };
    const { runs } = fakeActions(ctx, remoteGit, { conclusion: 'failure', jobs: [], logs: {}, workflow: 'mdbisync.yml', report: () => ({ operation: 'sync', code: 'initial-sync-required', capturedTrackedTip: null }) });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await ctx.live!.rest.workflowRuns(ctx.names.trackedBranch);
    assert.ok(runs.some((run) => run.event === 'push' && run.path === '.github/workflows/mdbisync.yml'), 'the workflows\' push started a sync run');
    assert.equal(await settleFollowUpRuns(ctx), 0);
    assert.equal(ctx.engine.results.length, 0);
  });

  it('fail the scenario when the deployment\'s follow-up push run fails', async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, mode: 'actions' };
    let conclusion = 'success';
    const actions = fakeActions(ctx, remoteGit, { conclusion: 'success', jobs: [], logs: {}, workflow: 'mdbisync.yml', report: (run) => ({ operation: 'sync', capturedTrackedTip: run.head_sha ?? null }) });
    mkdirSync(ctx.live!.sandbox.cache.dir, { recursive: true });
    await STEP_ACTIONS['git.edit']!(ctx, { workflows: true });
    await STEP_ACTIONS['run.workflow']!(ctx, { event: 'push' });
    const tracked = `refs/heads/${ctx.names.trackedBranch}`;
    const taken = (await remoteGit.text(['rev-parse', tracked])).trim();
    await remoteGit.run(['update-ref', tracked, (await remoteGit.text(['commit-tree', `${taken}^{tree}`, '-p', taken, '-m', 'Merge'])).trim()]);
    conclusion = 'failure';
    const rest = ctx.live!.rest as unknown as { workflowRuns: (branch: string) => Promise<WorkflowRun[]> };
    const list = rest.workflowRuns;
    rest.workflowRuns = async (branch) => (await list(branch)).map((run) => (actions.runs.indexOf(run) >= 2 ? Object.assign(run, { conclusion }) : run));
    await assert.rejects(settleFollowUpRuns(ctx), (error: Error) => error instanceof ProductError && /follow-up push run \d+ did not succeed/.test(error.message));
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

  it('keeps the full burst off near-limit documents on either side', async () => {
    const options = { durationMs: 900_000, linearEditsPerMinute: 50, gitPushesPerMinute: 1 };
    const nearLimit = 'a'.repeat(249_999);
    const versions = new Map([
      ['near-linear.md', ['Small file.', nearLimit]],
      ['near-git.md', [nearLimit, 'Small document.']],
      ['notes.md', ['# Notes\n', '# Notes\n']],
    ]);
    const documents = burstDocuments(versions, options, 'abcdef-9999');
    assert.deepEqual(documents, ['notes.md']);
    const texts = new Map([...versions].map(([path, values]) => [path, values[0] as string]));
    const tokens: string[] = [];
    const edit = async (path: string) => {
      const token = `abcdef-${String(tokens.length + 1).padStart(3, '0')}`;
      tokens.push(token);
      const text = paragraphEdit(texts.get(path) as string, undefined, token);
      assert.ok(text.length <= 250_000);
      texts.set(path, text);
    };
    const clock = fakeClock();
    const result = await burst({ ...clock, linearEdit: async (_, path) => edit(path), gitEdit: async ([path]) => edit(path as string), sync: async () => void clock.sleep(60_000) }, { ...options, documents });
    assert.equal(result.linearEdits, 750);
    assert.equal(result.gitPushes, 15);
    assert.ok(tokens.every((token) => texts.get('notes.md')?.includes(token)));
    assert.equal(texts.get('near-git.md'), nearLimit);
    assert.equal(texts.get('near-linear.md'), 'Small file.');
  });

  it('reserves exact append headroom and refuses an exhausted candidate set', () => {
    const options = { durationMs: 60_000, linearEditsPerMinute: 1, gitPushesPerMinute: 1 };
    const token = 'abcdef-1000';
    const growth = 2 * paragraphEdit('', undefined, token).length;
    const markers = 2 * `${MARKERS.git}\n\n${MARKERS.linear}\n\n${MARKERS.end}\n\n`.length;
    const fitting = 'a'.repeat(Math.floor((250_000 - markers) / 2) - growth);
    assert.deepEqual(burstDocuments(new Map([['fits.md', [fitting, fitting]], ['full.md', [fitting + 'a']]]), options, token), ['fits.md']);
    assert.throws(() => burstDocuments(new Map([['full.md', ['a'.repeat(250_000)]]]), options, token), /no document has room/);
    assert.throws(() => burstDocuments(new Map(), options, token), /no document has room/);
  });

  it('uses the budgeted count for non-divisor rates and rejects invalid options', async () => {
    const options = { durationMs: 60_000, linearEditsPerMinute: 49, gitPushesPerMinute: 0 };
    const counts = burstEditCounts(options);
    let edits = 0;
    const clock = fakeClock();
    const result = await burst({ ...clock, linearEdit: async () => { edits += 1; }, gitEdit: async () => {}, sync: async () => void clock.sleep(60_000) }, { ...options, documents: ['notes.md'] });
    assert.equal(result.linearEdits, counts.linear);
    assert.equal(edits, 49);
    assert.throws(() => burstEditCounts({ ...options, linearEditsPerMinute: NaN }), /finite numbers/);
  });

  it('reports a missing mapped document as a product failure before the burst starts', async () => {
    const { ctx, linear } = await fakeRun();
    linear.documents.clear();
    await assert.rejects(runStep(ctx, { kind: 'run', action: 'burst', args: { durationSeconds: 0 } }), ProductError);
    assert.equal(ctx.edits.length, 0);
    assert.equal(ctx.engine.results.length, 0);
  });

  it('leaves a file the run left out on purpose out of the load-test targets, and still fails on a document missing otherwise', async () => {
    // A live run moved a folder under its run id while the linked image stayed at the corpus path: the initial sync
    // left the file out (image-file-missing), so it has no document. Here: that file's document is gone and the
    // initial sync's report names it as left out.
    const leftOut = 'eng/platform/notes.md';
    const initialSync = (paths: string[]) => engineRun('initial-sync', {
      operation: 'initial-sync', initialSync: { created: [] }, summary: { leftOutFiles: paths.map((path) => ({ path, rules: ['image-file-missing'], lines: [3] })) },
    });
    for (const action of ['burst', 'soak']) {
      const { ctx, linear, ids } = await fakeRun();
      const lines: string[] = [];
      ctx.log = (line) => void lines.push(line);
      linear.documents.delete(ids[leftOut]!.id);
      // Without the report, the missing document is a product failure, as before.
      await assert.rejects(runStep(ctx, { kind: 'run', action, args: { durationSeconds: 0 } }), ProductError, action);
      ctx.engine.results.push(initialSync([leftOut]));
      await runStep(ctx, { kind: 'run', action, args: { durationSeconds: 0 } });
      assert.ok(lines.some((line) => line.startsWith(`${action}: 1 file(s)`) && line.includes(`${leftOut} (lint: image-file-missing)`)), `${action} names the skipped file: ${lines.join(' | ')}`);
    }
    // A short real burst edits the other documents and never the left-out file.
    const { ctx, linear, ids } = await fakeRun();
    linear.documents.delete(ids[leftOut]!.id);
    ctx.engine.results.push(initialSync([leftOut]));
    await runStep(ctx, { kind: 'run', action: 'burst', args: { durationSeconds: 2, linearEditsPerMinute: 60, gitPushesPerMinute: 30 } });
    const edited = new Set((ctx.observations.get('burst.edits') as Array<{ path: string }>).map((edit) => edit.path));
    assert.ok(edited.size > 0 && !edited.has(leftOut), [...edited].join(', '));
    // When every document was left out on purpose, the load test names that instead of a capacity problem.
    const empty = await fakeRun();
    for (const path of Object.keys(empty.ids)) empty.linear.documents.delete(empty.ids[path]!.id);
    empty.ctx.engine.results.push(initialSync(['eng/platform/plan.md', 'eng/platform/notes.md', 'docs/handbook/start.md']));
    await assert.rejects(runStep(empty.ctx, { kind: 'run', action: 'burst', args: { durationSeconds: 0 } }), /has no target: every synchronized document was left out on purpose/);
  });

  it('reports the burst\'s edits made and found on each side, which L4-12 requires to be equal', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const path = 'docs/handbook/start.md';
    const document = linear.documents.get(ids[path]!.id)!;
    // An edit before the burst is not the burst's: only the recorded burst edits are counted.
    ctx.edits.push({ side: 'git', path, token: 'aaaaaa-before' });
    const burstEdits = [
      { side: 'linear' as const, path, token: 'aaaaaa-0001' },
      { side: 'linear' as const, path, token: 'aaaaaa-0002' },
      { side: 'git' as const, path, token: 'aaaaaa-0003' },
    ];
    ctx.edits.push(...burstEdits);
    ctx.observations.set('burst.edits', burstEdits);
    const git = await ctx.person();
    const publish = async (text: string) => {
      writeFileSync(join(git.dir, path), text);
      await git.run(['add', '--', path]);
      await git.run(['commit', '--quiet', '-m', 'Update the review date']);
      await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    };
    // Git has the first and the third edit; Linear has the first two.
    await publish('# Start\n\nNote aaaaaa-0001.\n\nNote aaaaaa-0003.\n');
    document.content = 'Note aaaaaa-0001.\n\nNote aaaaaa-0002.\n';
    refreshView(ctx);
    const l412 = scenarios.find((item) => item.id === 'L4-12')!;
    const counted = l412.checks.assertions.filter((item) => item.subject.startsWith('report.burstEdits'));
    assert.deepEqual(counted.map((item) => item.subject), ['report.burstEditsMade', 'report.burstEditsFoundInGit', 'report.burstEditsFoundInLinear']);
    assert.deepEqual(await resolveSubject(ctx, 'report.burstEditsMade'), { known: true, value: 3 });
    assert.deepEqual(await resolveSubject(ctx, 'report.burstEditsFoundInGit'), { known: true, value: 2 });
    assert.deepEqual(await resolveSubject(ctx, 'report.burstEditsFoundInLinear'), { known: true, value: 2 });
    assert.deepEqual((ctx.observations.get('metrics') as Record<string, unknown>).burstEdits, { made: 3, foundInGit: 2, foundInLinear: 2 }, 'the report keeps the counts');
    for (const assertion of counted.slice(1)) assert.equal((await evaluateAssertion(ctx, assertion)).holds, false, assertion.subject);
    // Once both sides hold every burst edit, the counts are equal.
    await publish('# Start\n\nNote aaaaaa-0001.\n\nNote aaaaaa-0002.\n\nNote aaaaaa-0003.\n');
    document.content = 'Note aaaaaa-0001.\n\nNote aaaaaa-0002.\n\nNote aaaaaa-0003.\n';
    refreshView(ctx);
    for (const assertion of counted.slice(1)) assert.equal((await evaluateAssertion(ctx, assertion)).holds, true, assertion.subject);
    // A trashed document's text is not found in Linear.
    document.trashed = true;
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'report.burstEditsFoundInLinear'), { known: true, value: 0 });
  });

  it('records the burst\'s own edits for its report, also when the burst stops early', async () => {
    const { ctx } = await fakeRun();
    ctx.edits.push({ side: 'git', path: 'a.md', token: 'aaaaaa-before' });
    await runStep(ctx, { kind: 'run', action: 'burst', args: { durationSeconds: 0 } });
    assert.deepEqual(ctx.observations.get('burst.edits'), [], 'a burst of no time made no edits, and the earlier edit is not its own');
    // A short real burst: every edit it reports is recorded once, each on the side that made it.
    // (The fake sandbox's sync does not carry edits across; the counting test above covers the found counts.)
    const full = (await fakeRun()).ctx;
    await runStep(full, { kind: 'run', action: 'burst', args: { durationSeconds: 2, linearEditsPerMinute: 60, gitPushesPerMinute: 30 } });
    const made = full.observations.get('burst.edits') as Array<{ side: string; token: string }>;
    assert.deepEqual(made.map((edit) => edit.side).sort(), ['git', 'linear', 'linear']);
    assert.equal(new Set(made.map((edit) => edit.token)).size, 3);
    assert.equal(made.length, Number(full.observations.get('report.generatedLinearEdits')) + Number(full.observations.get('report.generatedGitPushes')));
    assert.deepEqual(await resolveSubject(full, 'report.burstEditsMade'), { known: true, value: 3 });
    // The second Linear edit fails: the burst throws, and the edit that landed before is still recorded as its own.
    const failing = (await fakeRun()).ctx;
    failing.edits.push({ side: 'git', path: 'a.md', token: 'aaaaaa-before' });
    for (const editor of Object.values(failing.live!.editors)) {
      const client = editor as unknown as { updateDocument: (...args: unknown[]) => Promise<unknown> };
      const update = client.updateDocument.bind(client);
      client.updateDocument = async (...args) => {
        if (failing.edits.length > 1) throw new Error('the editor lost its connection');
        return update(...args);
      };
    }
    await assert.rejects(runStep(failing, { kind: 'run', action: 'burst', args: { durationSeconds: 2, linearEditsPerMinute: 60, gitPushesPerMinute: 0 } }), /lost its connection/);
    const recorded = failing.observations.get('burst.edits') as Array<{ side: string; token: string }>;
    assert.deepEqual(recorded.map((edit) => edit.side), ['linear'], 'the burst recorded the edit that landed, although it threw');
    // A failed step skips the checks, so the report's metrics already say where the sides stand.
    const metrics = (failing.observations.get('metrics') as Record<string, unknown>).burstEdits as Record<string, unknown>;
    assert.equal(metrics.made, 1);
    assert.equal(metrics.afterQuiet, false);
    assert.equal(metrics.foundInLinear, 1, 'the edit that landed is in Linear');
    assert.equal(typeof metrics.foundInGit, 'number');
  });

  it('match an edit token only as a whole token, so a lost edit is not found inside a longer token', () => {
    assert.equal(holdsToken('Note aaaaaa-1000.', 'aaaaaa-100'), false);
    assert.equal(holdsToken('Note aaaaaa-1000. Note aaaaaa-100.', 'aaaaaa-100'), true);
    assert.equal(holdsToken('Note aaaaaa-100', 'aaaaaa-100'), true, 'at the end of the text');
    const sides = { files: new Map([['a.md', 'Note aaaaaa-1000.\n']]), documents: new Map([['d', { content: 'Note aaaaaa-1000.\n', trashed: false } as LinearDocument]]) };
    const lost = { side: 'git' as const, path: 'a.md', token: 'aaaaaa-100' };
    assert.deepEqual(editsFound([lost], sides), { git: 0, linear: 0 });
    const ctx = { edits: [lost], observations: new Map() } as unknown as RunContext;
    assert.deepEqual(lostEdits(ctx, sides), [lost]);
  });

  it('runs a soak with hourly checks and a repeatable schedule', async () => {
    const run = async () => {
      const clock = fakeClock();
      const edited: string[] = [];
      const driver: SoakDriver = { ...clock, linearEdit: async (actor, path) => void edited.push(`${actor} ${path}`), gitEdit: async (paths) => void edited.push(`git ${paths.join()}`), sync: async () => {}, checkInvariants: async () => ({ lostEdits: 0 }) };
      const documents = new Map([['a.md', ['# A\n']], ['b.md', ['# B\n']], ['c.md', ['# C\n']]]);
      const result = await soak(driver, { ...SOAK, documents });
      return { result, edited };
    };
    const first = await run();
    assert.equal(first.result.invariantChecks, 24);
    assert.equal(first.result.syncRuns, 288);
    assert.ok(first.result.edits.git > 100 && first.result.edits['editor-a'] > 100);
    assert.deepEqual(first.result.edits, soakEditCounts(SOAK));
    assert.deepEqual((await run()).edited, first.edited);
  });

  it('keeps the seeded soak off near-limit documents and within each document\'s room, without dropping an edit', async () => {
    const counts = soakEditCounts(SOAK);
    const total = counts['editor-a'] + counts['editor-b'] + counts.git;
    const token = soakToken(counts);
    // Each edit appends a note to both versions, and a conflict adds a marker set.
    const perEdit = 2 * paragraphEdit('', undefined, token).length + `${MARKERS.git}\n\n${MARKERS.linear}\n\n${MARKERS.end}\n\n`.length;
    const nearLimit = 'a'.repeat(CONTENT_LIMIT - 1);
    // Room for exactly three edits: the seeded schedule picks it more often, so it fills up and drops out.
    const tight = 'b'.repeat(Math.floor((CONTENT_LIMIT - 3 * perEdit) / 2));
    assert.equal(editCapacity([tight, tight], token), 3);
    const versions = new Map([
      ['near-linear.md', ['Small file.', nearLimit]],
      ['near-git.md', [nearLimit, 'Small document.']],
      ['tight.md', [tight, tight]],
      ['notes.md', ['# Notes\n', '# Notes\n']],
      ['plan.md', ['# Plan\n', '# Plan\n']],
    ]);

    const run = async () => {
      const texts = new Map([...versions].map(([path, values]) => [path, values[0] as string]));
      const tokens: string[] = [];
      const order: string[] = [];
      const edit = async (path: string) => {
        const next = `abcdef-${String(tokens.length + 1).padStart(3, '0')}`;
        tokens.push(next);
        order.push(path);
        const text = paragraphEdit(texts.get(path) as string, undefined, next);
        // A conflict can hold both versions: the budget keeps even that within the limit.
        assert.ok(2 * text.length <= CONTENT_LIMIT, `${path} would leave no room for a conflict`);
        texts.set(path, text);
      };
      const clock = fakeClock();
      const driver: SoakDriver = { ...clock, linearEdit: async (_, path) => edit(path), gitEdit: async ([path]) => edit(path as string), sync: async () => {}, checkInvariants: async () => ({ lostEdits: 0 }) };
      const result = await soak(driver, { ...SOAK, documents: versions });
      return { result, texts, tokens, order };
    };
    const first = await run();
    assert.deepEqual(first.result.edits, counts);
    assert.equal(first.tokens.length, total);
    assert.ok(first.tokens.every((written, index) => first.texts.get(first.order[index] as string)?.includes(written)), 'every scheduled edit is written');
    assert.equal(first.order.filter((path) => path === 'tight.md').length, 3);
    assert.ok(first.order.includes('notes.md') && first.order.includes('plan.md'));
    assert.equal(first.texts.get('near-linear.md'), 'Small file.');
    assert.equal(first.texts.get('near-git.md'), nearLimit);
    assert.deepEqual((await run()).order, first.order);
  });

  it('refuses a soak whose documents cannot take every scheduled edit, or whose options are invalid, before its first edit', async () => {
    const counts = soakEditCounts(SOAK);
    const total = counts['editor-a'] + counts['editor-b'] + counts.git;
    const token = soakToken(counts);
    const perEdit = 2 * paragraphEdit('', undefined, token).length + `${MARKERS.git}\n\n${MARKERS.linear}\n\n${MARKERS.end}\n\n`.length;
    const short = 'a'.repeat(Math.floor((CONTENT_LIMIT - (total - 1) * perEdit) / 2));
    let edits = 0;
    const clock = fakeClock();
    const driver: SoakDriver = { ...clock, linearEdit: async () => { edits += 1; }, gitEdit: async () => { edits += 1; }, sync: async () => {}, checkInvariants: async () => ({ lostEdits: 0 }) };
    await assert.rejects(soak(driver, { ...SOAK, documents: new Map([['short.md', [short]]]) }), new RegExp(`room for ${total - 1} of the ${total} soak edits`));
    await assert.rejects(soak(driver, { ...SOAK, documents: new Map([['full.md', ['a'.repeat(CONTENT_LIMIT / 2)]], ['none.md', []]]) }), new RegExp(`room for 0 of the ${total} soak edits`));
    await assert.rejects(soak(driver, { ...SOAK, scheduleMs: 0, documents: new Map() }), /positive intervals/);
    await assert.rejects(soak(driver, { ...SOAK, invariantIntervalMs: Number.NaN, documents: new Map() }), /finite numbers/);
    await assert.rejects(soak(driver, { ...SOAK, actors: ['editor-a', 'editor-c' as Actor], documents: new Map() }), /unknown soak actors: editor-c/);
    assert.equal(edits, 0);
    // A soak with no scheduled edits needs no room.
    assert.deepEqual((await soak(driver, { ...SOAK, actors: [], documents: new Map() })).edits, { 'editor-a': 0, 'editor-b': 0, git: 0 });
  });

  it('reports a missing mapped document as a product failure before the soak starts', async () => {
    const { ctx, linear } = await fakeRun();
    linear.documents.clear();
    await assert.rejects(runStep(ctx, { kind: 'run', action: 'soak', args: { durationSeconds: 0 } }), /soak target is missing/);
    assert.equal(ctx.edits.length, 0);
    assert.equal(ctx.engine.results.length, 0);
  });
});

/** The widest token of a soak with these edits, as the step bounds it: git pushes can retry three times. */
const soakToken = (edits: Record<Actor, number>) => `abcdef-${String(edits['editor-a'] + edits['editor-b'] + 4 * edits.git).padStart(3, '0')}`;

/** The L4-13 soak's options. */
const SOAK = { durationMs: 86_400_000, scheduleMs: 300_000, invariantIntervalMs: 3_600_000, actors: ['editor-a', 'editor-b', 'git'] as readonly Actor[], seed: '173', lastToken: soakToken };

describe('oracles', () => {
  it('give an unchanged file its body by the engine\'s rule as its form, in the bank and the corpus alike', () => {
    for (const name of ['bank', 'full'] as const) {
      const input = offlineInput(name);
      const bom = [...input.files].find(([path]) => path.endsWith('typography-scripts/bom.md'));
      assert.ok(bom !== undefined, `the ${name} input has the byte order mark fixture`);
      const [path, text] = bom;
      assert.ok(text.startsWith('\uFEFF'), `the ${name} input keeps the mark in the file`);
      assert.ok(!input.golden.get(path)?.startsWith('\uFEFF'), `the ${name} oracle has no mark`);
      // What L0-02 and L0-07 compare: the fixed file's body, as the engine sends it, against the oracle.
      const dir = fresh('mds-bom-');
      writeInput(dir, new Map([[path, text]]));
      assert.ok([0, 1].includes(runFormatCommand('fix', dir).status ?? -1));
      assert.equal(bodyOf(readInput(dir, [path]).get(path) ?? ''), input.golden.get(path), `the ${name} oracle is what fix gives`);
    }
    // The live oracle reads the same form: the recorded one keeps the mark the probe sent.
    const bank = loadBank(join(REPO_ROOT, BANK_DIR));
    const fixture = bank.fixtures.find((candidate) => candidate.file === 'typography-scripts/bom.md');
    assert.ok(fixture !== undefined);
    assert.equal(engineForm(bank, fixture, readFixture(bank, fixture)), bodyOf(readFixture(bank, fixture)));
  });

  it('name the paths a failed comparison of path maps differs at in the check\'s reason', async () => {
    const ctx = { observations: new Map<string, unknown>([['fix.output', new Map([['b.md', 'kept'], ['a.md', 'private text']])], ['golden.linearForm', new Map([['b.md', 'kept'], ['a.md', 'other']])]]) } as unknown as RunContext;
    assert.deepEqual(await evaluateAssertion(ctx, { subject: 'fix.output', operator: 'same-as', expected: 'golden.linearForm' }), { holds: false, reason: 'same-as did not hold: differs at a.md' });
    assert.deepEqual(await evaluateAssertion(ctx, { subject: 'fix.output', operator: 'equal', expected: 3 }), { holds: false, reason: 'equal did not hold' });
  });

  it('name the paths a failed same-as differs at, a few at most and never their content', () => {
    const actual = new Map([['a.md', 'secret one'], ['b.md', 'same'], ['c.md', 'x']]);
    assert.equal(differingPaths(actual, new Map([['b.md', 'same'], ['c.md', 'y'], ['d.md', 'z']])), 'differs at a.md, c.md, d.md');
    assert.equal(differingPaths(actual, new Map(actual)), undefined);
    assert.equal(differingPaths(['a.md'], ['b.md']), undefined, 'only path maps name paths');
    assert.ok(!differingPaths(actual, new Map())?.includes('secret'));
    const many = new Map(Array.from({ length: 8 }, (_, i) => [`f${i}.md`, 'one']));
    assert.equal(differingPaths(many, new Map([...many].map(([path]) => [path, 'two']))), 'differs at f0.md, f1.md, f2.md, f3.md, f4.md and 3 more');
    // Values compare as compare() does: sets in sorted form.
    assert.equal(differingPaths(new Map([['a.md', new Set(['x', 'y'])]]), new Map([['a.md', new Set(['y', 'x'])]])), undefined);
  });

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

  it('give up on a token probe Linear does not answer in time', async () => {
    let calls = 0;
    const stalled = (async (_url: string, init: RequestInit) => {
      calls += 1;
      assert.ok(init.signal instanceof AbortSignal, 'every probe has a deadline');
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    await assert.rejects(tokenActive('t', stalled, 0), (error: Error) => error instanceof EnvBlockedError && /no answer in time/.test(error.message));
    assert.equal(calls, 3);
  });
});

describe('team-zone cleanup', () => {
  it('names helper projects so cleanup finds them and no annotation ever maps one', async () => {
    const { RUN_PROJECT_PATTERN, runOfProject } = await import('./isolation.ts');
    const { PROJECT_PLACEHOLDERS } = await import('./corpus.ts');
    const names = runNames('aaaaaa');
    const placeholderProjects = PROJECT_PLACEHOLDERS.map((_, index) => names.project(index));
    const helpers = (['archive', 'unmapped', 'archived-copy', 'annotation-target'] as const).map((purpose) => names.helperProject(purpose));
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
  it('cut a segment of more than 180 bytes to 40 characters and a hash of the segment', () => {
    // Hashes written by hand: SHA-256 of 'x' x 200 and of 'é' x 100, first 16 hex digits.
    assert.equal(encodeTitlePath(`a/${'x'.repeat(200)}`), `a/${'x'.repeat(40)}~aa20c23e32018340`);
    assert.equal(encodeTitlePath('é'.repeat(100)), `${'é'.repeat(40)}~f42ec48e1e4b487e`, '200 bytes in 100 characters');
    assert.equal(encodeTitlePath('x'.repeat(180)), 'x'.repeat(180), '180 bytes stay');
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
  /** Variables of each `RunComments` query, in order. */
  commentQueries: Array<Record<string, unknown>> = [];
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
    if (operation === 'RunComments') {
      // The filter shapes the canary scan sends: by project, or by team with a title prefix or a list of ids.
      const filter = variables.filter as { project?: { id: { eq: string } }; team?: { id: { eq: string } }; title?: { startsWith: string }; id?: { in: string[] } };
      this.commentQueries.push(variables);
      const nodes = [...this.documents.values()]
        .filter((document) => variables.includeArchived === true || (!document.trashed && document.archivedAt === null))
        .filter((document) => filter.project === undefined || document.projectId === filter.project.id.eq)
        .filter((document) => filter.team === undefined || document.teamId === filter.team.id.eq)
        .filter((document) => filter.title === undefined || document.title.startsWith(filter.title.startsWith))
        .filter((document) => filter.id === undefined || filter.id.in.includes(document.id))
        .map((document) => ({ id: document.id, project: document.projectId === null ? null : { id: document.projectId }, comments: { nodes: (this.comments.get(document.id) ?? []).map((body) => ({ body })) } }));
      return { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } as T;
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

/** A finished engine run with the given report, as the harness records it. */
function engineRun(command: EngineResult['command'], report: Record<string, unknown>): EngineResult {
  return { command, exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report };
}

/**
 * A converged run world: a tracked branch with two project folders and three
 * documents, their ids ref, and Linear holding the same texts. With `hooks`,
 * the person's commits go through the corpus's hooks from a local hook repository.
 */
/** Replaces the run's uploads state ref with one commit holding these hash → URL entries. */
async function writeUploads(ctx: RunContext, entries: Record<string, string>): Promise<void> {
  const git = await ctx.person();
  const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(entries) })).trim();
  const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tuploads.json\n` })).trim();
  const commit = (await git.text(['commit-tree', tree, '-m', 'uploads'])).trim();
  await git.run(['push', '--quiet', 'origin', `+${commit}:${ctx.names.refPrefix}/uploads`]);
  refreshView(ctx);
}

/** The ids state ref as the engine pushes it: a new commit on the current one. */
async function writeIds(ctx: RunContext, entries: Record<string, { id: string }>): Promise<void> {
  const git = await ctx.person();
  const ref = `${ctx.names.refPrefix}/ids`;
  const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(entries) })).trim();
  const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
  await git.run(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${ref}:${ref}`]);
  const commit = (await git.text(['commit-tree', tree, '-p', ref, '-m', 'ids'])).trim();
  await git.run(['push', '--quiet', 'origin', `${commit}:${ref}`]);
}

async function fakeRun(options: { review?: string; hooks?: boolean; teamZone?: boolean; files?: Record<string, string> } = {}) {
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
    // A team-zone folder: its README's document sits in team ENG's zone with the plain title README.
    ...(options.teamZone === true ? { 'zone/README.md': '---\nlinear-team: ENG\n---\n\n# Zone\n\nTeam notes.\n' } : {}),
    ...options.files,
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
    const place = path.startsWith('zone/') ? { teamId: 'team-eng' } : { projectId: path.startsWith('eng/') ? PROJECT.id : OTHER.id };
    const title = path.replace(/^(eng\/platform|docs\/handbook|zone)\//, '').replace(/\.md$/, '');
    ids[path] = { id: linear.add(place, title, text.replace(/^---\n[\s\S]*?\n---\n/, '')).id };
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
    teamZones: new Map(options.teamZone === true ? [['ENG', 'zone']] : []),
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
    proxy: { url: 'http://127.0.0.1:1', requests: [], tokens: () => [], unrevokedTokens: () => [], setFaults: (next: readonly unknown[]) => void faults.push(...next), clearFaults: () => {}, armedFaults: () => faults.length, counts: () => ({ total: 0, queries: 0, mutations: 0, injected: 0 }), resetCounters: () => {}, close: async () => {} },
    owned: new OwnershipLedger(stateDir, names.runId),
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

describe('intentional deletion in I2', () => {
  it('supersedes earlier edits only after deletion on both sides, and rechecks them on restore', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const path = 'eng/platform/plan.md';
    const token = 'aaaaaa-intentional-edit';
    const edit = { side: 'linear' as const, path, token };
    ctx.edits.push(edit);
    await runStep(ctx, { kind: 'linear', action: 'trash', args: { actor: 'editor-a', target: path } });
    const document = linear.documents.get(ids[path]!.id)!;
    const sides = { files: new Map([[path, 'Old text.']]), documents: new Map([[document.id, document]]) };
    assert.deepEqual(lostEdits(ctx, sides), [edit], 'the file must leave Git too');
    sides.files.clear();
    assert.deepEqual(lostEdits(ctx, sides), []);
    const later = { side: 'git' as const, path, token: 'aaaaaa-after-trash' };
    ctx.edits.push(later);
    assert.deepEqual(lostEdits(ctx, sides), [later], 'an edit after the trash must still win');
    const unrelated = { side: 'linear' as const, path: 'other.md', token: 'aaaaaa-other-edit' };
    ctx.edits.push(unrelated);
    assert.deepEqual(lostEdits(ctx, sides), [later, unrelated], 'another document is still checked');
    await runStep(ctx, { kind: 'linear', action: 'restore', args: { actor: 'editor-a', target: path } });
    assert.deepEqual(lostEdits(ctx, sides), [edit, later, unrelated], 'restore reactivates the original edit');
  });
});

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
    // On the same branch the new head cancels the pending job itself: no person's Actions credential is needed.
    const noPerson = () => { throw new Error('a same-branch fault must not cancel through a person'); };
    await faultChecks(ctx, { name: 'format', status: 'failed' }, noPerson);
    assert.equal((await remoteFile(CHECK_MARKER, ctx.names.syncBranch)).trim(), 'failed');
    await faultChecks(ctx, { status: 'passed' }, noPerson);
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

  it('waits for a check to complete with any result, and blocks on the environment when it never does', async () => {
    for (const [conclusion, state] of [['success', 'passed'], ['failure', 'failed'], ['cancelled', 'cancelled']] as const) {
      let polls = 0;
      const rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => {
        polls += 1;
        const check = { id: polls, name: 'format', app: { slug: 'github-actions' }, status: 'completed', conclusion };
        if (polls === 1) return Response.json({ check_runs: [] });
        if (polls === 2) return Response.json({ check_runs: [{ ...check, name: 'other' }] });
        if (polls === 3) return Response.json({ check_runs: [{ ...check, status: 'in_progress', conclusion: null }] });
        return Response.json({ check_runs: [check] });
      }) as typeof fetch);
      assert.equal(await waitForCheckCompleted(rest, 'abc123', { pollMs: 0, timeoutMs: 1000 }), state);
      assert.equal(polls, 4);
    }
    const absent = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => Response.json({ check_runs: [] })) as typeof fetch);
    await assert.rejects(waitForCheckCompleted(absent, 'abc', { timeoutMs: 0 }), EnvBlockedError);
    await assert.rejects(waitForCheckCompleted(absent, 'abc', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  });

  it("waits for the tracked tip's check after a git step, but only once a check fault is in play", async () => {
    const { ctx, remoteGit } = await fakeRun();
    ctx.checkPollMs = 0;
    const reads: string[] = [];
    ctx.live!.rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async (input: string | URL | Request) => {
      const sha = /\/commits\/([0-9a-f]+)\/check-runs/.exec(String(input))?.[1];
      assert.ok(sha, String(input));
      reads.push(sha);
      // The push's check is still queued when it is first read.
      const done = reads.filter((read) => read === sha).length > 1;
      return Response.json({ check_runs: [{ id: 1, name: 'format', app: { slug: 'github-actions' }, status: done ? 'completed' : 'queued', conclusion: done ? 'success' : null }] });
    }) as typeof fetch);
    const tip = async () => (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim();
    // A git step that commits these changes to the tracked branch, as a person does.
    const commitStep = (changes: Map<string, string | null>) => async (step: RunContext) => {
      const git = await step.person();
      await git.run(['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', step.names.trackedBranch]);
      await personCommit(git, step.names, changes, 'Update the tree', { verify: false });
    };
    await runStep(ctx, { kind: 'git', action: 'edit', args: { target: 'eng/platform/plan.md' } });
    assert.deepEqual(reads, [], 'without a check fault the step does not wait');
    ctx.observations.set('fault.checks', { name: 'format', state: 'failed', sha: 'f'.repeat(40) });
    await runStep(ctx, { kind: 'git', action: 'edit', args: { target: 'eng/platform/notes.md' } });
    const edited = await tip();
    assert.deepEqual(reads, [edited, edited]);
    try {
      STEP_ACTIONS['git.test-idle'] = async () => {};
      await runStep(ctx, { kind: 'git', action: 'test-idle', args: {} });
      assert.deepEqual(reads, [edited, edited], 'a step that leaves the tracked tip in place does not wait');
      STEP_ACTIONS['git.test-pending'] = commitStep(new Map([[CHECK_MARKER, 'pending\n']]));
      await assert.rejects(runStep(ctx, { kind: 'git', action: 'test-pending', args: {} }), HarnessGapError);
      STEP_ACTIONS['git.test-no-workflow'] = commitStep(new Map([[CHECK_WORKFLOW_PATH, null]]));
      await runStep(ctx, { kind: 'git', action: 'test-no-workflow', args: {} });
      assert.deepEqual(reads, [edited, edited], 'a tree without the marker workflow starts no check to wait for');
    } finally {
      for (const action of ['git.test-idle', 'git.test-pending', 'git.test-no-workflow']) delete STEP_ACTIONS[action];
    }
  });

  it('cancels the pending marker runs on a head and waits until they complete', async () => {
    const runs = [
      { id: 7, head_sha: 'abc', path: CHECK_WORKFLOW_PATH, status: 'in_progress', conclusion: null as string | null },
      { id: 8, head_sha: 'abc', path: CHECK_WORKFLOW_PATH, status: 'queued', conclusion: null as string | null },
      { id: 9, head_sha: 'abc', path: '.github/workflows/other.yml', status: 'in_progress', conclusion: null as string | null },
    ];
    const calls: string[] = [];
    let reads = 0;
    const person = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'person-token', (async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer person-token');
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (init?.method === 'GET') {
        reads += 1;
        // GitHub finishes a cancel asynchronously: the runs complete one read later.
        if (reads === 3) for (const run of runs) if (run.id !== 9 && run.conclusion === 'cancelled') run.status = 'completed';
        return Response.json({ workflow_runs: runs });
      }
      const run = runs.find((candidate) => path.endsWith(`/actions/runs/${candidate.id}/cancel`))!;
      // Run 8 finished on its own between the read and the cancel.
      if (run.id === 8) { run.status = 'completed'; run.conclusion = 'failure'; return new Response(null, { status: 409 }); }
      run.conclusion = 'cancelled';
      return new Response(null, { status: 202 });
    }) as typeof fetch);
    const ctx = { signal: new AbortController().signal } as unknown as RunContext;
    assert.equal(await cancelPendingRuns(ctx, person, ['abc'], { pollMs: 0, timeoutMs: 1000 }), 1);
    assert.deepEqual(calls.filter((call) => call.startsWith('POST')), ['POST /repos/example/sandbox/actions/runs/7/cancel', 'POST /repos/example/sandbox/actions/runs/8/cancel']);
    assert.equal(calls.filter((call) => call.startsWith('GET')).length, 3);
  });

  it('reports a pending marker run that will not finish as env-blocked', async () => {
    let posts = 0;
    const person = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'person-token', (async (_input, init) => {
      if (init?.method === 'POST') { posts += 1; return new Response(null, { status: 202 }); }
      return Response.json({ workflow_runs: [{ id: 7, head_sha: 'abc', path: CHECK_WORKFLOW_PATH, status: 'in_progress', conclusion: null }] });
    }) as typeof fetch);
    const ctx = { signal: new AbortController().signal } as unknown as RunContext;
    await assert.rejects(cancelPendingRuns(ctx, person, ['abc'], { pollMs: 0, timeoutMs: 20 }), (error) => error instanceof EnvBlockedError && /within 0 s after its cancel/.test(error.message));
    assert.equal(posts, 1, 'one cancel per run, not one per poll');
    const forbidden = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'person-token', (async (_input, init) => init?.method === 'POST' ? new Response(null, { status: 403 })
      : Response.json({ workflow_runs: [{ id: 7, head_sha: 'abc', path: CHECK_WORKFLOW_PATH, status: 'in_progress', conclusion: null }] })) as typeof fetch);
    await assert.rejects(cancelPendingRuns(ctx, forbidden, ['abc'], { pollMs: 0 }), { name: 'GitHubError', status: 403 });
  });

  it("takes a run's writes from its report, so L1R-03's expected-zero total fails on the first sync's writes", async () => {
    const report = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'run-reports', `${name}.json`), 'utf8')) as Record<string, unknown>;
    const run = (name: string) => ({ command: 'sync' as const, exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: report(name) });
    const l1r03 = scenarios.find((item) => item.id === 'L1R-03')!;
    const l2_34 = scenarios.find((item) => item.id === 'L2-34')!;
    const total = l1r03.checks.assertions.find((item) => item.subject === 'runs.last.writes.total')!;
    const linear = l2_34.checks.assertions.find((item) => item.subject === 'runs.last.writes.linear')!;
    const holds = async (ctx: RunContext, assertion: typeof total) => {
      const subject = await resolveSubject(ctx, assertion.subject);
      assert.equal(subject.known, true);
      return compare(assertion.operator, subject.value, assertion.expected);
    };

    // As live: the reverse initial sync, then the first sync after the person's merge created two documents.
    const { ctx } = await fakeRun();
    ctx.engine.results.push(run('reverse-initial-sync'), run('first-sync-two-created'));
    // I6's own run (the quiet one) is not the scenario's last run.
    ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
    ctx.engine.results.push(run('quiet-sync'));
    assert.deepEqual(await resolveSubject(ctx, 'runs.last.writes.total'), { known: true, value: 4 });
    assert.deepEqual(await resolveSubject(ctx, 'runs.last.writes.linear'), { known: true, value: 2 });
    assert.deepEqual(await resolveSubject(ctx, 'runs.0.writes.pullRequests'), { known: true, value: 1 });
    assert.equal(await holds(ctx, total), false);
    assert.equal(await holds(ctx, linear), false);
    await assert.rejects(resolveSubject(ctx, 'runs.last.writes.documents'), /runs\.last\.writes\.documents: a run's writes are writes\.linear, writes\.git, writes\.pullRequests, writes\.total/);
    await assert.rejects(resolveSubject(ctx, 'runs.last.writes'), /runs\.last\.writes: a run's writes are/);

    // The contract the product must meet: a sync after the merge that writes nothing.
    const quiet = (await fakeRun()).ctx;
    quiet.engine.results.push(run('reverse-initial-sync'), run('quiet-sync'));
    quiet.observations.set('scenario.runsEnd', quiet.engine.results.length);
    assert.equal(await holds(quiet, total), true);
    assert.equal(await holds(quiet, linear), true);

    // A run that moved one state ref and wrote nothing else still wrote.
    const moved = (await fakeRun()).ctx;
    moved.engine.results.push(run('state-ref-only-sync'));
    assert.equal(await holds(moved, total), false);
    assert.equal(await holds(moved, linear), true);
  });

  it('keeps the L5-17 suspension and unrelated write visible to scenario assertions', async () => {
    const { ctx } = await fakeRun();
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: { pullRequest: { pullRequest: { number: 1, opened: true } } } });
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 1, stdout: '', stderr: '', summary: '', report: {
      summary: null, code: null, exitStatus: 'success', pullRequest: { suspended: { checks: ['format'] }, merged: null }, writtenCount: 1,
    } });
    const scenario = scenarios.find((item) => item.id === 'L5-17')!;
    for (const assertion of scenario.checks.assertions.filter((item) => item.subject.startsWith('runs.1.') && subjectSource(item.subject) === 'engine')) {
      const subject = await resolveSubject(ctx, assertion.subject);
      assert.equal(subject.known, true);
      assert.equal((await evaluateAssertion(ctx, assertion)).holds, true, assertion.subject);
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

  it('edit a paragraph on the sync branch and resolve markers there, never on the tracked branch', async () => {
    const plan = 'eng/platform/guides/weekly-plan.md';
    const conflicted = `# Plan\n\nFirst.\n\n${MARKERS.git}\n\nOurs.\n\n${MARKERS.linear}\n\nTheirs.\n\n${MARKERS.end}\n`;
    const { ctx, remoteGit, remoteFile } = await fakeRun({ review: conflicted });
    ctx.observations.set('fixture.document', plan);
    await remoteGit.run(['update-ref', `refs/heads/${ctx.names.syncBranch}`, ctx.names.trackedBranch]);
    await runStep(ctx, { kind: 'git', action: 'edit-sync-branch', args: { target: 'first-paragraph' } });
    const pending = ctx.observations.get('syncBranch.personEdit') as { path: string; token: string };
    assert.equal(pending.path, plan);
    // The sentence joins the first paragraph, not a new paragraph at the end.
    const base = await remoteFile(plan);
    assert.equal(await remoteFile(plan, ctx.names.syncBranch), editParagraph(base, 0, pending.token));
    await runStep(ctx, { kind: 'git', action: 'resolve-sync-branch', args: {} });
    const resolved = `# Plan\n\nFirst. The review moved to the next morning, note ${pending.token}.\n\nOurs.\n`;
    // The fake's file reader drops the final newline, as in the tracked-branch resolve test.
    assert.equal(await remoteFile(plan, ctx.names.syncBranch), resolved.replace(/\n$/, ''));
    assert.equal(ctx.observations.get('resolved.body'), resolved);
    assert.ok(ctx.observations.has('syncBranch.resolutionCommit'));
    assert.equal(await remoteFile(plan), base);
    await assert.rejects(runStep(ctx, { kind: 'git', action: 'resolve-sync-branch', args: {} }), /no conflict markers to resolve/);
  });

  it('commit to the sync branch as CI and as a person, recording which interleaving it was', async () => {
    const { ctx, remoteGit, remoteFile } = await fakeRun();
    await assert.rejects(runStep(ctx, { kind: 'git', action: 'ci-fix', args: {} }), ProductError);
    await commitAsPerson(ctx, new Map([['.pre-commit-config.yaml', `${await remoteFile('.pre-commit-config.yaml')}\ndefault_stages: [pre-commit]\n`]]), 'Set hook stages', true);
    await remoteGit.run(['update-ref', `refs/heads/${ctx.names.syncBranch}`, ctx.names.trackedBranch]);
    await runStep(ctx, { kind: 'git', action: 'ci-fix', args: { fixes: ['stable-fix', 'linear-would-undo'] } });
    ctx.engine.pausedAt = 'after-capture-push-before-pr';
    await runStep(ctx, { kind: 'git', action: 'ci-fix', args: { target: 'first-document' } });
    const path = ctx.observations.get('target.path') as string | undefined ?? 'docs/handbook/start.md';
    assert.ok((await remoteFile(path, ctx.names.syncBranch)).endsWith(`Checked by the format job, ref ${ctx.observations.get('ciFix.stable')}.`));
    await runStep(ctx, { kind: 'git', action: 'edit-sync-branch', args: {} });
    assert.equal((ctx.observations.get('ciFix.commits') as string[]).length, 3);
    assert.deepEqual(ctx.observations.get('report.interleavingsCovered'), ['fix-before-capture', 'capture-before-fix']);
    const synced = await remoteFile(path, ctx.names.syncBranch);
    assert.ok(synced.includes(ctx.observations.get('ciFix.unstable') as string));
    assert.ok(ctx.observations.has('syncBranch.personCommit'));
    const configured = readHookConfig(await remoteFile('.pre-commit-config.yaml', ctx.names.syncBranch));
    assert.ok(configured.hooks.some((hook) => hook.id === 'aligned-table'));
    assert.ok(configured.hooks.some((hook) => hook.id === 'stable-fix'));
    assert.deepEqual(parseYaml(await remoteFile('.pre-commit-config.yaml', ctx.names.syncBranch)).default_stages, ['pre-commit']);
    const fixes = await remoteGit.text(['log', '--format=%(trailers:key=Pre-commit-fix,valueonly)', `refs/heads/${ctx.names.syncBranch}`]);
    assert.match(fixes, /aligned-table/);
    assert.match(fixes, /stable-fix/);
    // Never pushed to the tracked branch.
    assert.ok(!(await remoteFile(path)).includes(ctx.observations.get('ciFix.stable') as string));
  });

  it('L2-33 checks the hook name in both the engine report and the rendered summary', async () => {
    const { ctx } = await fakeRun();
    const result = { report: { sync: { leftOut: [{ path: 'notes.md', hooks: ['aligned-table'] }] } }, summary: 'CI fixes not written: aligned-table' } as unknown as EngineResult;
    ctx.engine.results.push(result);
    assert.deepEqual(await resolveSubject(ctx, 'summary.unstableHookNamed'), { known: true, value: true });
    result.summary = 'No hook named';
    assert.deepEqual(await resolveSubject(ctx, 'summary.unstableHookNamed'), { known: true, value: false });
    result.summary = 'aligned-table';
    result.report = { sync: { leftOut: [] } };
    assert.deepEqual(await resolveSubject(ctx, 'summary.unstableHookNamed'), { known: true, value: false });
    const scenario = scenarios.find((item) => item.id === 'L2-33')!;
    const targets = scenario.steps.filter((step) => step.kind === 'git' && step.action === 'ci-fix').map((step) => step.args.target);
    assert.deepEqual(targets, ['document', 'other-document']);
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

  it('point an image at an LFS object the engine cannot download, pushed with its object', async () => {
    const { ctx, remoteFile, remoteGit } = await fakeRun();
    const kept = seededPng('kept');
    // The sandbox's LFS server as the engine reaches it; it holds another object, which must still come through.
    const server = await fakeLfsServer([kept]);
    try {
      const image = 'eng/platform/media/diagram.png';
      await commitAsPerson(ctx, new Map([['.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n']]), 'Store images in LFS', true);
      const engineDir = join(ctx.runDir, 'engine');
      await (await ctx.sandbox!.clone(ctx.names, engineDir)).run(['config', 'lfs.url', server.url]);
      ctx.engineClone = async () => engineDir;
      ctx.live!.githubToken = 'sandbox-token';
      ctx.observations.set('git.imagePath', image);
      await runStep(ctx, { kind: 'fault', action: 'missing-lfs-object', args: {} });
      const oid = ctx.observations.get('fault.missingLfsOid') as string;

      // The push names the object and carries it: the remote holds the object, so GitHub accepts the push.
      const pointer = parseLfsPointer(Buffer.from(`${await remoteFile(image)}\n`));
      assert.equal(pointer?.oid, oid);
      assert.ok(existsSync(join(remoteGit.dir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)));

      // The engine's clone, with the engine's extra environment: that one object is missing, others download.
      const read = await lfsReader(new Git(engineDir, { ...IDENTITY, ...ctx.engine.env }), 'origin');
      const missing = await read(pointer!, image);
      assert.equal(missing.ok, false);
      const keptPointer = parseLfsPointer(Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(kept).digest('hex')}\nsize ${kept.length}\n`));
      assert.deepEqual(await read(keptPointer!, 'eng/platform/media/kept.png'), { ok: true, content: kept });
      assert.deepEqual(ctx.engine.lfsProxy?.requests.map((request) => request.refused), [[oid], []]);
      // Only the object the server holds was asked about, with the sandbox's credential added by the proxy; the
      // download itself goes straight to the address the server answered with.
      assert.deepEqual(server.requests, ['POST /info/lfs/objects/batch', `GET /objects/${keptPointer!.oid}`]);
      assert.match(ctx.engine.lfsProxy!.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/lfs$/);
      assert.equal(server.authorizations[0], `basic ${Buffer.from('x-access-token:sandbox-token').toString('base64')}`);

      // After fault.clear, an engine started with the proxy downloads the object again.
      await runStep(ctx, { kind: 'fault', action: 'clear', args: {} });
      assert.deepEqual(ctx.engine.env, {});
      assert.equal((await read(pointer!, image)).ok, false, 'the fake server never got the object, so it answers 404 itself');
      assert.deepEqual(ctx.engine.lfsProxy?.requests.at(-1), { operation: 'download', refused: [] });
    } finally {
      await ctx.engine.lfsProxy?.close();
      await server.close();
    }
  });

  it('move a folder by its annotation to a new project of the folder\'s own team (L2-08)', async () => {
    const { ctx, remoteFile } = await fakeRun();
    const world = ctx.live as LiveWorld;
    // The team annotations above the project folders, as the corpus has them: each project folder inherits its team.
    await commitAsPerson(ctx, new Map([['eng/README.md', '---\nlinear-team: ENG\n---\n'], ['docs/README.md', '---\nlinear-team: DOCS\n---\n']]), 'Name the teams');
    world.teams.set('DOCS', { id: 'team-docs', key: 'DOCS', name: 'Documentation' });
    const created: Array<{ name: string; teamIds: readonly string[] }> = [];
    Object.assign(world, { world: { createProject: async (name: string, teamIds: readonly string[]) => { created.push({ name, teamIds }); return { id: `project-${name}`, name, createdAt: '' }; } } });
    const before = await remoteFile('eng/platform/README.md');
    await runStep(ctx, { kind: 'git', action: 'annotation', args: { project: 'other-project' } });
    // The longest project folder moves; the project is new, so no other folder maps it, and it is in DOCS, the
    // team docs/handbook inherits, not ENG, where the engine would not find it.
    assert.deepEqual(created, [{ name: 'Spare cabinet aaaaaa', teamIds: ['team-docs'] }]);
    assert.match(await remoteFile('docs/handbook/README.md'), /^linear-project: Spare cabinet aaaaaa$/m);
    assert.equal(await remoteFile('eng/platform/README.md'), before);
    assert.deepEqual(ctx.observations.get('git.annotation'), { folder: 'docs/handbook', project: 'Spare cabinet aaaaaa' });
    // A run project like the others: the destination subject names it and cleanup deletes it.
    assert.equal(world.projects.get('ANNOTATION_TARGET')?.name, 'Spare cabinet aaaaaa');
    assert.deepEqual(await resolveSubject(ctx, 'expected.destination'), { known: true, value: ['project:Spare cabinet aaaaaa'] });
    // One live project per helper name: a second move in the same run is refused before it creates another.
    await assert.rejects(runStep(ctx, { kind: 'git', action: 'annotation', args: {} }), /already has its annotation-target helper project/);
    assert.equal(created.length, 1);
  });

  it('end env-blocked when the workspace has no team for the folder', async () => {
    const { ctx } = await fakeRun();
    // No team annotation above the project folders at all.
    await assert.rejects(runStep(ctx, { kind: 'git', action: 'annotation', args: {} }), (error: Error) => error instanceof EnvBlockedError && error.message === 'no annotation names the team of docs/handbook');
  });

  it('read a folder\'s team from its own annotation, else the nearest one above it', () => {
    const dir = fresh('folder-team-');
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write('README.md', '# Repository\n');
    write('eng/README.md', '---\nlinear-team: ENG\n---\n');
    write('eng/platform/README.md', '---\nlinear-project: Field notes aaaaaa\n---\n');
    write('support/README.md', '---\nlinear-team: DOCS\nlinear-project: Garden plans aaaaaa\n---\n');
    assert.equal(folderTeam(dir, 'eng/platform'), 'ENG');
    assert.equal(folderTeam(dir, 'eng/platform/deep/er'), 'ENG');
    assert.equal(folderTeam(dir, 'support'), 'DOCS');
    assert.equal(folderTeam(dir, 'other'), null);
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

  it('prepare two documents linked by id for the browser check (L6-12)', async () => {
    const { ctx, remoteFile } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, steps: [{ kind: 'ui', action: 'follow-document-links', args: { actor: 'editor-a' } }] };
    await prepareFixtures(ctx, ctx.live as LiveWorld, 'beforeSync', { runStep });
    const { folder, project } = projectFolders(ctx)[0] as { folder: string; project: string };
    const source = `${folder}/${LINK_PAIR.source}.md`;
    const target = `${folder}/${LINK_PAIR.target}.md`;
    assert.deepEqual(ctx.observations.get('fixture.linkPair'), { source, target, anchor: LINK_PAIR.anchor, project });
    // The index links the notes by a relative path, once whole and once to a heading the notes have.
    const index = await remoteFile(source);
    assert.deepEqual([...index.matchAll(/\]\(<([^>]+)>\)/g)].map((match) => match[1]), ['route-notes.md', `route-notes.md#${LINK_PAIR.anchor}`]);
    assert.match(await remoteFile(target), /^## Depot hours$/m);
    // UI steps run in the browser session, never here.
    await assert.rejects(runStep(ctx, { kind: 'ui', action: 'follow-document-links', args: { actor: 'editor-a' } }), EnvBlockedError);
    // Once the session answered, whether the anchored link scrolled goes to the report, which no check reads.
    ctx.observations.set('ui.anchorScrolls', false);
    await afterUiStep(ctx, { kind: 'ui', action: 'follow-document-links', args: { actor: 'editor-a' } });
    assert.deepEqual(ctx.observations.get('metrics'), { anchorScrolls: false });
    ctx.observations.delete('ui.anchorScrolls');
    await afterUiStep(ctx, { kind: 'ui', action: 'follow-document-links', args: { actor: 'editor-a' } });
    assert.deepEqual(ctx.observations.get('metrics'), { anchorScrolls: null });
  });

  it('prepare the L6-12 pair in Linear\'s form, so I1 finds both files equal to their documents', async () => {
    const { ctx, linear, ids, rawFile } = await fakeRun();
    ctx.scenario = { ...ctx.scenario, steps: [{ kind: 'ui', action: 'follow-document-links', args: { actor: 'editor-a' } }] };
    await prepareFixtures(ctx, ctx.live as LiveWorld, 'beforeSync', { runStep });
    const { source, target, project } = ctx.observations.get('fixture.linkPair') as { source: string; target: string; project: string };
    const { folder } = projectFolders(ctx)[0] as { folder: string };
    const projectId = [...(ctx.live as LiveWorld).projects.values()].find((item) => item.name === project)?.id as string;
    const files = { [source]: await rawFile(source), [target]: await rawFile(target) };

    // The documents as a sync leaves them: links by id, and the text as Linear keeps it, without a final newline.
    for (const path of [target, source]) ids[path] = { id: linear.add({ projectId }, path.slice(folder.length + 1).replace(/\.md$/, ''), '').id };
    await writeIds(ctx, ids);
    const base = (ctx.live as LiveWorld).documentUrlBase;
    // The index's links to the notes, `<route-notes.md>` and `<route-notes.md#…>`, become links to the notes' document.
    const kept = (text: string) => text.replaceAll(`](<${basename(target)}`, `](<${base}/${ids[target]?.id}`).replace(/\n+$/, '');
    for (const path of [target, source]) await linear.updateDocument(ids[path]?.id as string, { content: kept(files[path] as string) });
    assert.ok((linear.documents.get(ids[source]?.id as string)?.content ?? '').includes(`(<${base}/${ids[target]?.id}#${LINK_PAIR.anchor}>)`));
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const sides = await readSides(ctx);
    assert.deepEqual([source, target].map((path) => sides.files.has(path)), [true, true]);
    assert.deepEqual(await INVARIANT_CHECKS.I1(ctx, async () => sides), { name: 'I1', ok: true });

    // Both files are already in Linear's form, as the corpus is: the fix command changes nothing, final newline included.
    for (const text of Object.values(files)) assert.equal(fixText(text), text);
    // The notes run past one browser window: about forty lines of text above the anchored heading, and more below it.
    const notes = files[target] as string;
    const heading = notes.indexOf('\n## Depot hours\n');
    assert.ok(heading >= 2500, `${heading} characters above the heading`);
    assert.ok(notes.length - heading >= 600, `${notes.length - heading} characters from the heading on`);
  });

  it('check that Linear holds the index linking the notes by id, whole and with the anchor (L6-12)', async () => {
    const { ctx, linear, ids } = await fakeRun();
    const plan = ids['eng/platform/plan.md']?.id as string;
    const notes = ids['eng/platform/notes.md']?.id as string;
    ctx.observations.set('fixture.linkPair', { source: 'eng/platform/plan.md', target: 'eng/platform/notes.md', anchor: 'dates', project: 'unused' });
    const holds = async (content: string) => {
      (linear.documents.get(plan) as LinearDocument).content = content;
      refreshView(ctx);
      return (await resolveSubject(ctx, 'documents.linkPairById')).value;
    };
    const url = `https://linear.app/test/document/${notes}`;
    assert.equal(await holds(`# Plan\n\nSee [notes](${url}) and [the dates](<${url}#dates>).\n`), true);
    // A relative link Linear kept, a lost anchor, or a third link to the notes is not the pair the browser check needs.
    assert.equal(await holds(`# Plan\n\nSee [notes](notes.md) and [the dates](${url}#dates).\n`), false);
    assert.equal(await holds(`# Plan\n\nSee [notes](${url}) and [the dates](${url}).\n`), false);
    assert.equal(await holds(`# Plan\n\nSee [notes](${url}), [again](${url}) and [the dates](${url}#dates).\n`), false);
    // A document the sync did not write is named, not reported as a link mismatch.
    ctx.observations.set('fixture.linkPair', { source: 'eng/platform/plan.md', target: 'eng/platform/missing.md', anchor: 'dates', project: 'unused' });
    refreshView(ctx);
    await assert.rejects(resolveSubject(ctx, 'documents.linkPairById'), /wrote no document for eng\/platform\/missing\.md/);
    ctx.observations.delete('fixture.linkPair');
    refreshView(ctx);
    await assert.rejects(resolveSubject(ctx, 'documents.linkPairById'), /recorded no fixture\.linkPair/);
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
    // Linear gives the color as a hex code; L2-35 names it by its palette name.
    Object.assign(linear.documents.get(id) as LinearDocument, { icon: 'Cross', color: '#EB5757' });
    linear.comments.set(id, ['Blocked by hook `test-secret`, line 3.']);
    await runStep(ctx, { kind: 'linear', action: 'remove-secret', args: {} });
    assert.equal(ctx.observations.get('blocked.icon'), 'Cross');
    assert.ok(!(linear.documents.get(id)?.content ?? '').includes(secret));
    assert.deepEqual(await resolveSubject(ctx, 'blocked.commentFields'), { known: true, value: ['hook', 'line'] });
    const mark = ['blocked.icon', 'blocked.color', 'blocked.commentFields'];
    assert.deepEqual(await scenarioAssertions(ctx, 'L2-35', mark), new Map(mark.map((subject) => [subject, true])));
    // A wrong color still fails L2-35.
    ctx.observations.set('blocked.color', '#4cb782');
    assert.deepEqual((await scenarioAssertions(ctx, 'L2-35', mark)).get('blocked.color'), false);
  });

  /** Whether each assertion of scenario `id` on `subjects` holds in `ctx`, compared as the runner compares them. */
  async function scenarioAssertions(ctx: RunContext, id: string, subjects?: readonly string[]): Promise<Map<string, boolean>> {
    const scenario = scenarios.find((candidate) => candidate.id === id)!;
    const held = new Map<string, boolean>();
    for (const assertion of scenario.checks.assertions) {
      if (subjects !== undefined && !subjects.includes(assertion.subject)) continue;
      held.set(assertion.subject, (await evaluateAssertion(ctx, assertion)).holds);
    }
    return held;
  }

  it('compare a cross-project move (L2-25) with its recorded destination in the same form', async () => {
    const { ctx, ids, remoteGit } = await fakeRun();
    const plan = ids['eng/platform/plan.md']?.id as string;
    await runStep(ctx, { kind: 'linear', action: 'move-project', args: { target: 'eng/platform/plan.md' } });
    // Where the sync left the document: the ids state ref names its path.
    const landAt = async (path: string) => {
      const moved = Object.fromEntries(Object.entries(ids).map(([key, entry]) => [entry.id === plan ? path : key, entry]));
      const blob = (await remoteGit.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(moved) })).trim();
      const tree = (await remoteGit.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
      const commit = (await remoteGit.text(['commit-tree', tree, '-m', 'ids'])).trim();
      await remoteGit.run(['update-ref', `${ctx.names.refPrefix}/ids`, commit]);
      refreshView(ctx);
    };
    await landAt('docs/handbook/plan.md');
    assert.deepEqual(await resolveSubject(ctx, 'tracked.movedPath'), { known: true, value: 'docs/handbook/plan.md' });
    assert.deepEqual(await scenarioAssertions(ctx, 'L2-25'), new Map([['tracked.movedPath', true]]));
    // Other path subjects keep naming every project folder by its role.
    assert.deepEqual(await resolveSubject(ctx, 'tracked.documentPath'), { known: true, value: 'project/plan.md' });
    // A document that stayed in its project reads `project/plan.md`, not the destination.
    await landAt('eng/platform/plan.md');
    assert.deepEqual(await resolveSubject(ctx, 'tracked.movedPath'), { known: true, value: 'project/plan.md' });
    assert.deepEqual(await scenarioAssertions(ctx, 'L2-25'), new Map([['tracked.movedPath', false]]));
    // So does one under another name in the destination's project.
    await landAt('docs/handbook/other-plan.md');
    assert.deepEqual(await scenarioAssertions(ctx, 'L2-25'), new Map([['tracked.movedPath', false]]));
  });

  it('read a recorded observation through the subject that normalizes it, and a direct one as recorded', async () => {
    const { ctx } = await fakeRun();
    ctx.observations.set('blocked.color', '#EB5757');
    assert.deepEqual(await resolveSubject(ctx, 'blocked.color'), { known: true, value: 'red' });
    ctx.observations.set('blocked.color', null);
    assert.deepEqual(await resolveSubject(ctx, 'blocked.color'), { known: true, value: null });
    // Direct observation subjects, and subjects a step overrides on purpose, return what was recorded.
    ctx.observations.set('blocked.icon', 'Cross');
    assert.deepEqual(await resolveSubject(ctx, 'blocked.icon'), { known: true, value: 'Cross' });
    ctx.observations.set('golden.linearForm', 'recorded');
    assert.deepEqual(await resolveSubject(ctx, 'golden.linearForm'), { known: true, value: 'recorded' });
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

describe('GraphQL HTTP fault scenario', () => {
  it('runs L5-07 OAuth setup and injects ListDocuments with exactly one real transport retry', async () => {
    const { ctx } = await fakeRun();
    const forwarded: string[] = [];
    const proxy = await startFaultProxy('https://api.example.test', { fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      forwarded.push(path);
      return Response.json(path === '/oauth/token'
        ? { access_token: 'test-access-token', expires_in: 3600, scope: 'read,write' }
        : path === '/oauth/revoke' ? { success: true } : { data: { ok: true } });
    } });
    ctx.proxy = proxy;
    const query = 'query ListDocuments { documents { nodes { id } } }';
    try {
      const scenario = scenarios.find((item) => item.id === 'L5-07')!;
      const setup = new GraphQLTransport({ baseUrl: proxy.url, token: 'setup-token' });
      await setup.request('ListDocuments', 'query', query);
      ctx.observations.set('start.proxyIndex', proxy.requests.length);
      await runStep(ctx, scenario.steps[0]!);
      const token = await mintAppToken({ clientId: 'test-id', clientSecret: 'test-secret' }, { baseUrl: proxy.url });
      const attempts: number[] = [];
      const sleeps: number[] = [];
      const transport = new GraphQLTransport({
        baseUrl: proxy.url, token: token.accessToken,
        hooks: { beforeRequest: (info) => { attempts.push(info.attempt); } },
        sleep: async (ms) => { sleeps.push(ms); },
      });
      assert.deepEqual(await transport.request('ListDocuments', 'query', query), { ok: true });
      await revokeToken(token.accessToken, { baseUrl: proxy.url });
      ctx.observations.set('scenario.proxyEnd', proxy.requests.length);
      assert.deepEqual(attempts, [1, 2]);
      assert.deepEqual(sleeps, [1000]);
      assert.deepEqual(proxy.requests.slice(1).map(({ operation, status, injected }) => ({ operation, status, injected })), [
        { operation: 'http /oauth/token', status: 200, injected: false },
        { operation: 'ListDocuments', status: 429, injected: true },
        { operation: 'ListDocuments', status: 200, injected: false },
        { operation: 'http /oauth/revoke', status: 200, injected: false },
      ]);
      assert.deepEqual(forwarded, ['/graphql', '/oauth/token', '/graphql', '/oauth/revoke']);
      for (const assertion of scenario.checks.assertions.filter((item) => item.subject.startsWith('http.') || item.subject === 'proxy.injectedOperations')) {
        assert.deepEqual(await resolveSubject(ctx, assertion.subject), { known: true, value: assertion.expected });
      }
      // An invariant's later normal run cannot turn a missing retry into a pass.
      proxy.setFaults([{ kind: 'http', status: 429, requestNumber: 1, retryAfterSeconds: 1, times: 1 }]);
      await transport.request('ListDocuments', 'query', query);
      assert.deepEqual(await resolveSubject(ctx, 'http.retryCount'), { known: true, value: 1 });
      ctx.observations.set('scenario.proxyEnd', 3);
      assert.deepEqual(await resolveSubject(ctx, 'http.retryCount'), { known: true, value: 0 });
      await assert.rejects(runStep(ctx, { kind: 'fault', action: 'http', args: { status: 429, target: 'unknown' } }), /unknown HTTP fault target/);
      await assert.rejects(runStep(ctx, { kind: 'fault', action: 'http', args: { status: 500, target: 'oauth', operation: 'oauth.token' } }), /OAuth faults cannot select/);
      await runStep(ctx, { kind: 'fault', action: 'http', args: { status: 500, target: 'oauth' } });
      await assert.rejects(mintAppToken({ clientId: 'test-id', clientSecret: 'test-secret' }, { baseUrl: proxy.url }), /HTTP 500/);
    } finally {
      await proxy.close();
    }
  });
});

describe('subjects', () => {
  describe('setup failures (L5-01 to L5-05)', () => {
    const FIX = 'https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#linear-oauth-app';
    // From a live L5-01 run: its job summary and terminal stop line as the engine wrote them, and its report
    // trimmed to the fields these subjects read (four of its eight setup checks, other request log lines dropped).
    const SUMMARY = [
      '## Setup check',
      '',
      `Stopped before any write: \`linear-credential-failed\`. How to fix it: ${FIX}`,
      '',
      '| Item | State | Detail |',
      '| --- | --- | --- |',
      `| linear-credentials | FAILED | Linear refused the OAuth app client credentials ([how to fix](${FIX})) |`,
      '| github-access | passed | GitHub token has contents:write, pull_requests:write, workflows:write, checks:read, statuses:read |',
      '| merge-commits | passed | merge commits are allowed |',
      '| linear-format-hook | passed | .pre-commit-config.yaml has the linear-format hook |',
      '| annotations | passed | 5 annotated folders, 12 files to sync |',
      '| annotation-targets | not checked | needs working Linear credentials |',
      '| left-out-files | passed | no files left out |',
      '| security-hooks | passed | security hooks present: test-secret |',
      '',
    ].join('\n');
    const STDERR = [
      '{"operation":"oauth.token","kind":"oauth","attempt":1,"status":400,"errorCodes":["unknown"]}',
      `sync: stopped before any write (linear-credential-failed): Linear refused the OAuth app client credentials. How to fix it: ${FIX}`,
      '',
    ].join('\n');
    const REPORT = {
      operation: 'sync',
      ok: false,
      code: 'linear-credential-failed',
      exitStatus: 'failure',
      summary: null,
      setupChecks: [
        { name: 'linear-credentials', state: 'failed', detail: 'Linear refused the OAuth app client credentials' },
        { name: 'github-access', state: 'passed', detail: 'GitHub token has contents:write, pull_requests:write, workflows:write, checks:read, statuses:read' },
        { name: 'annotation-targets', state: 'not-checked', detail: 'needs working Linear credentials' },
        { name: 'security-hooks', state: 'passed', detail: 'security hooks present: test-secret' },
      ],
      writes: { linear: {}, git: {}, pullRequests: {} },
    };
    const run = (change: Partial<EngineResult> = {}): EngineResult => ({ command: 'sync', exitCode: 1, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: STDERR, summary: SUMMARY, report: structuredClone(REPORT), ...change });
    const l501 = scenarios.find((scenario) => scenario.id === 'L5-01');

    async function outcomes(result: EngineResult) {
      const { ctx } = await fakeRun();
      ctx.engine.results.push(result);
      const verdicts: [string, boolean | string][] = [];
      for (const assertion of l501?.checks.assertions ?? []) {
        try {
          const verdict = await evaluateAssertion(ctx, assertion);
          verdicts.push([assertion.subject, verdict.holds]);
        } catch (error) {
          verdicts.push([assertion.subject, error instanceof ProductError ? `product: ${error.message}` : `harness: ${String(error)}`]);
        }
      }
      return verdicts;
    }

    it('pass L5-01 on what the live run actually gave: the failed item and its fix link, from the report, summary and terminal', async () => {
      assert.deepEqual(await outcomes(run()), [
        ['runs.0.writes.total', true],
        ['runs.0.summary.code', true],
        ['runs.0.setupFailure.item', true],
        ['runs.0.setupFailure.fixLink', true],
      ]);
      assert.equal(subjectSource('runs.0.setupFailure.item'), 'harness');
      assert.equal(subjectSource('runs.last.setupFailure.fixLink'), 'harness');
    });

    it('expect in L5-01 to L5-05 a known item and the fix link the engine gives for the expected code', async () => {
      const { CHECK_NAMES } = await import('../../../src/setup/report.ts');
      const { fixUrl } = await import('../../../src/setup/fixes.ts');
      for (const id of ['L5-01', 'L5-02', 'L5-03', 'L5-04', 'L5-05']) {
        const expected = new Map(scenarios.find((scenario) => scenario.id === id)?.checks.assertions.map((assertion) => [assertion.subject, assertion.expected]));
        assert.ok((CHECK_NAMES as readonly unknown[]).includes(expected.get('runs.0.setupFailure.item')), id);
        assert.equal(expected.get('runs.0.setupFailure.fixLink'), fixUrl(String(expected.get('runs.0.summary.code'))), id);
      }
    });

    it('stay red when the item or the link is wrong or missing', async () => {
      const verdict = async (result: EngineResult) => Object.fromEntries((await outcomes(result)).filter(([subject]) => subject.startsWith('runs.0.setupFailure.')));
      const wrongLink = FIX.replace('#linear-oauth-app', '#github-app');
      // A wrong item, named everywhere alike.
      const otherItem = run({ summary: SUMMARY.replace('| linear-credentials | FAILED', '| linear-credentials | passed').replace('| github-access | passed | GitHub token has contents:write, pull_requests:write, workflows:write, checks:read, statuses:read |', `| github-access | FAILED | x ([how to fix](${FIX})) |`) });
      (otherItem.report?.['setupChecks'] as { name: string; state: string }[]).forEach((check) => (check.state = check.name === 'github-access' ? 'failed' : 'passed'));
      assert.equal((await verdict(otherItem))['runs.0.setupFailure.item'], false);
      // Several failed items: the first is the one the report's code names; a later one does not stand in for it.
      const several = run({ summary: SUMMARY.replace('| github-access | passed | GitHub token has contents:write, pull_requests:write, workflows:write, checks:read, statuses:read |', `| github-access | FAILED | x ([how to fix](${wrongLink})) |`) });
      (several.report?.['setupChecks'] as { name: string; state: string }[])[1]!.state = 'failed';
      assert.deepEqual(await verdict(several), { 'runs.0.setupFailure.item': true, 'runs.0.setupFailure.fixLink': true });
      const swapped = structuredClone(several);
      (swapped.report?.['setupChecks'] as { name: string; state: string }[])[0]!.state = 'passed';
      assert.equal((await verdict(swapped))['runs.0.setupFailure.item'], false);
      // No failed item, or one the summary does not show as FAILED.
      const none = run();
      (none.report?.['setupChecks'] as { state: string }[]).forEach((check) => (check.state = 'passed'));
      assert.match(String((await verdict(none))['runs.0.setupFailure.item']), /^product: .*no failed item/);
      assert.match(String((await verdict(run({ summary: SUMMARY.replace('| linear-credentials | FAILED', '| linear-credentials | failed') })))['runs.0.setupFailure.item']), /^product: .*no FAILED row for linear-credentials/);
      // A wrong link given alike everywhere is a wrong value.
      assert.equal((await verdict(run({ summary: SUMMARY.replaceAll(FIX, wrongLink), stderr: STDERR.replace(FIX, wrongLink) })))['runs.0.setupFailure.fixLink'], false);
      // A link missing from, or different in, any one place.
      assert.match(String((await verdict(run({ stderr: STDERR.split('\n')[0] as string })))['runs.0.setupFailure.fixLink']), /^product: .*the terminal stop line for linear-credential-failed gives no fix link/);
      assert.match(String((await verdict(run({ stderr: STDERR.replace(FIX, wrongLink) })))['runs.0.setupFailure.fixLink']), /^product: .*different fix links/);
      assert.match(String((await verdict(run({ summary: SUMMARY.replace(` How to fix it: ${FIX}`, '') })))['runs.0.setupFailure.fixLink']), /^product: .*the summary's stop line .* gives no fix link/);
      assert.match(String((await verdict(run({ summary: SUMMARY.replace(` ([how to fix](${FIX}))`, '') })))['runs.0.setupFailure.fixLink']), /^product: .*the FAILED row .* gives no fix link/);
      // A stop line for another code does not count.
      assert.match(String((await verdict(run({ stderr: STDERR.replace('(linear-credential-failed)', '(missing-permission)') })))['runs.0.setupFailure.fixLink']), /^product: .*terminal stop line/);
      // No report at all.
      assert.match(String((await verdict(run({ report: null })))['runs.0.setupFailure.item']), /^product: .*wrote no report/);
    });
  });

  it('read the engine report by path and fail as a product error when it lacks a value', async () => {
    const { ctx } = await fakeRun();
    ctx.engine.results.push({ command: 'sync', exitCode: 0, signal: null, notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: { summary: { code: 'initial-sync-required' } } });
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
    await writeUploads(ctx, { [fileHash(Buffer.from('kept bytes'))]: 'https://uploads.linear.app/x/kept' });
    assert.deepEqual(await resolveSubject(ctx, 'uploads.cacheComplete'), { known: true, value: true });
    void linear;
    void ids;
  });

  it('expect no cache entry for an image link the input already held broken, and still one for every real image', async () => {
    const { ctx } = await fakeRun();
    const git = await ctx.person();
    const notes = join(git.dir, 'eng/platform/notes.md');
    const push = async (message: string) => {
      await git.run(['add', '--all']);
      await git.run(['commit', '--quiet', '-m', message]);
      await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
      refreshView(ctx);
    };
    // The input: a written document with a deliberately broken image link beside two real images.
    mkdirSync(join(git.dir, 'eng/platform/media'), { recursive: true });
    const input = '# Notes\n\n![gone](../assets/does-not-exist.png) ![a](media/first.png) ![b](media/second.png)\n';
    writeFileSync(notes, input);
    writeFileSync(join(git.dir, 'eng/platform/media/first.png'), 'first bytes');
    writeFileSync(join(git.dir, 'eng/platform/media/second.png'), 'second bytes');
    await push('Images and a broken reference');
    ctx.observations.set(BEFORE_VIEW, await takeStartView(ctx));
    const [first, second, other] = ['first bytes', 'second bytes', 'other bytes'].map((text) => fileHash(Buffer.from(text))) as [string, string, string];
    const cacheComplete = async () => (await resolveSubject(ctx, 'uploads.cacheComplete')).value;
    // No uploads: the real images' missing entries fail.
    assert.equal(await cacheComplete(), false);
    // One real image cached, the other not: its missing entry still fails, whatever the broken link does.
    await writeUploads(ctx, { [first]: 'https://uploads.linear.app/x/first' });
    assert.equal(await cacheComplete(), false);
    // An entry under another file's hash does not stand in for the real image's own.
    await writeUploads(ctx, { [first]: 'https://uploads.linear.app/x/first', [other]: 'https://uploads.linear.app/x/other' });
    assert.equal(await cacheComplete(), false);
    // Both real images cached: the input's broken link has no file to upload, so it expects nothing and the check passes.
    await writeUploads(ctx, { [first]: 'https://uploads.linear.app/x/first', [second]: 'https://uploads.linear.app/x/second' });
    assert.equal(await cacheComplete(), true);
    // The same broken target added to another written document is the run's link, not the input's: it fails.
    const plan = join(git.dir, 'eng/platform/plan.md');
    const planText = readFileSync(plan, 'utf8');
    writeFileSync(plan, `${planText}\n![gone too](../assets/does-not-exist.png)\n`);
    await push('The broken target in another document');
    assert.equal(await cacheComplete(), false);
    writeFileSync(plan, planText);
    await push('Restore the plan');
    assert.equal(await cacheComplete(), true);
    // A link the run adds to a file the branch does not hold is not the input's broken reference: it still fails.
    writeFileSync(notes, `${input}\n![new](media/new.png)\n`);
    await push('A link to an image that was never committed');
    assert.equal(await cacheComplete(), false);
    // A document whose only image is the broken one checks nothing, so the check does not pass.
    writeFileSync(notes, '# Notes\n\n![gone](../assets/does-not-exist.png)\n');
    await push('Only the broken reference');
    assert.equal(await cacheComplete(), false);
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

  it('L3-24 counts only its twenty conflicted documents on the mid slice and names missing marks', async () => {
    const scenario = scenarios.find((candidate) => candidate.id === 'L3-24')!;
    assert.equal(scenario.slice, 'mid');
    const corpus = buildCorpus('0'.repeat(40));
    const mid = new Set(corpus.slices.mid);
    const marker = 'docs/reference/conflict-markers/sync-markers-code.md';
    assert.ok(mid.has(marker));
    const files = Object.fromEntries(corpus.files.filter((file) => mid.has(file.path) && file.path.endsWith('.md')).map((file) => [file.path, file.content.toString('utf8')]));
    const { ctx, linear, ids } = await fakeRun({ files });
    ctx.scenario = scenario;
    // Initial sync already decorated the corpus's marker example before the scenario edits.
    const mark = (path: string) => Object.assign(linear.documents.get(ids[path]!.id)!, { icon: 'Alert', color: '#F2994A' });
    mark(marker);
    ctx.observations.set(BEFORE_VIEW, await takeStartView(ctx));
    await runStep(ctx, scenario.steps[0]!);
    await runStep(ctx, scenario.steps[1]!);
    const paths = ctx.observations.get('conflict.paths') as string[];
    assert.equal(paths.length, 20);
    assert.ok(!paths.includes(marker));
    for (const path of paths) mark(path);
    refreshView(ctx);
    const assertion = scenario.checks.assertions.find((item) => item.subject === 'conflicts.markCount')!;
    assert.equal(assertion.expected, 20);
    assert.deepEqual(await resolveSubject(ctx, assertion.subject), { known: true, value: 20 });
    assert.deepEqual(await evaluateAssertion(ctx, assertion), { holds: true });

    // The corpus mark must never replace a missing scenario mark, mapping or document.
    const path = paths[0]!;
    const id = ids[path]!.id;
    const document = linear.documents.get(id)!;
    Object.assign(document, { icon: null, color: null });
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, assertion.subject), { known: true, value: 19 });
    const failed = await evaluateAssertion(ctx, assertion);
    assert.equal(failed.holds, false);
    if (!failed.holds) {
      assert.ok(failed.reason.includes(path));
      assert.match(failed.reason, /expected 20, actual 19/);
      assert.ok(!failed.reason.includes(marker));
    }
    mark(path);
    linear.documents.delete(id);
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, assertion.subject), { known: true, value: 19 });
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

  it('honor a file its run left out at write in I1 and I7, and still fail on an unexplained missing mapping', async () => {
    const { ctx } = await fakeRun();
    // Two files in git with no id and no document: one the run left out for its oversized upload, one it did not explain.
    const git = await ctx.person();
    for (const path of ['eng/platform/large.md', 'eng/platform/lost.md']) writeFileSync(join(git.dir, path), '# Large\n\n![a](a.bin)\n');
    await git.run(['add', '--', 'eng/platform/large.md', 'eng/platform/lost.md']);
    await git.run(['commit', '--quiet', '-m', 'Add two files']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    const initialSync = { created: [], overwritten: [], unchanged: ['eng/platform/plan.md'], leftOutAtWrite: [{ path: 'eng/platform/large.md', rule: 'upload-too-large', files: ['eng/platform/a.bin'] }] as unknown[] };
    ctx.engine.results.push(engineRun('initial-sync', { summary: { leftOutFiles: [] }, initialSync, sync: null }));
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const sides = await readSides(ctx);
    assert.deepEqual([...sides.omitted], [['eng/platform/large.md', 'write: upload-too-large']]);
    assert.equal((await INVARIANT_CHECKS.I1(ctx, async () => sides)).detail, '1 files differ from their documents (each in i1-differences.txt): eng/platform/lost.md (no document)');
    assert.equal((await INVARIANT_CHECKS.I7(ctx, async () => sides)).detail, '1 problems: eng/platform/lost.md has no id');
    // Once the run also leaves the second file out with its rule, both checks hold.
    initialSync.leftOutAtWrite.push({ path: 'eng/platform/lost.md', rule: 'content-too-long' });
    const both = await readSides(ctx);
    assert.deepEqual(await INVARIANT_CHECKS.I1(ctx, async () => both), { name: 'I1', ok: true });
    assert.deepEqual(await INVARIANT_CHECKS.I7(ctx, async () => both), { name: 'I7', ok: true });
  });

  it('honor the annotation READMEs the engine keeps in I1 and I7, and still fail on missing or changed ones', async () => {
    const { ctx, ids } = await fakeRun();
    // An initial sync from Linear: the annotation READMEs stay in git, body included, with no document and no id.
    const git = await ctx.person();
    const ENG = `---\nlinear-project: ${PROJECT.name}\n---\n\nWhat the platform team owns.\n`;
    const DOCS = `---\nlinear-project: ${OTHER.name}\n---\n\nHow the handbook is kept.\n`;
    const commitReadmes = async (texts: Record<string, string>, message: string) => {
      for (const [path, text] of Object.entries(texts)) writeFileSync(join(git.dir, path), text);
      await git.run(['commit', '--quiet', '-am', message]);
      await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    };
    await commitReadmes({ 'eng/platform/README.md': ENG, 'docs/handbook/README.md': DOCS }, 'Describe the folders');
    // The engine's `linear` record holds the tree it recorded, kept READMEs with their bodies included.
    const recordLinear = async () => git.run(['push', '--quiet', 'origin', `HEAD:${ctx.names.refPrefix}/linear`]);
    const recordIds = async (entries: Record<string, { id: string }>, message: string) => {
      const blob = (await git.text(['hash-object', '-w', '--stdin'], { input: JSON.stringify(entries) })).trim();
      const tree = (await git.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
      const parent = (await git.text(['ls-remote', 'origin', `${ctx.names.refPrefix}/ids`])).split('\t')[0] as string;
      await git.run(['fetch', '--quiet', 'origin', parent]);
      const commit = (await git.text(['commit-tree', tree, '-p', parent, '-m', message])).trim();
      await git.run(['push', '--quiet', 'origin', `${commit}:${ctx.names.refPrefix}/ids`]);
    };
    const documents = Object.fromEntries(Object.entries(ids).filter(([path]) => !path.endsWith('README.md')));
    // The same shape as a live final ids commit: subject, capture cursor, one trailer per kept README.
    const final = (kept: string[]) => ['Initial sync: document ids', '', ['Capture-through: 2026-11-09T22:02:38.227Z', ...kept.map((path) => `Kept-annotation: ${JSON.stringify(path)}`)].join('\n')].join('\n');
    const both = ['docs/handbook/README.md', 'eng/platform/README.md'];
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const check = async () => {
      const sides = await readSides(ctx);
      return [(await INVARIANT_CHECKS.I1(ctx, async () => sides)).detail, (await INVARIANT_CHECKS.I7(ctx, async () => sides)).detail];
    };
    const bothMissing = [
      '2 files differ from their documents (each in i1-differences.txt): docs/handbook/README.md (no document), eng/platform/README.md (no document)',
      '2 problems: docs/handbook/README.md has no id; eng/platform/README.md has no id',
    ];

    await recordLinear();

    // A trailer on a commit that is not a final initial sync's names nothing: READMEs with a body fail.
    await recordIds(documents, ['Initial sync: progress', '', ...both.map((path) => `Kept-annotation: ${JSON.stringify(path)}`)].join('\n'));
    assert.deepEqual((await readSides(ctx)).kept, new Set());
    assert.deepEqual(await check(), bothMissing);

    // Both named by the final ids commit and unchanged since the record: kept, bodies and annotations intact.
    await recordIds(documents, final(both));
    const sides = await readSides(ctx);
    assert.deepEqual([...sides.kept].sort(), both);
    assert.equal(sides.files.get('eng/platform/README.md'), ENG);
    assert.deepEqual(await check(), [undefined, undefined]);

    // Named, but no `linear` record holds them: the engine would create their documents.
    await git.run(['push', '--quiet', 'origin', `:${ctx.names.refPrefix}/linear`]);
    assert.deepEqual(await check(), bothMissing);
    await recordLinear();

    // Only one named: the other README is genuinely without a document.
    await recordIds(documents, final(['eng/platform/README.md']));
    assert.deepEqual(await check(), ['1 files differ from their documents (each in i1-differences.txt): docs/handbook/README.md (no document)', '1 problems: docs/handbook/README.md has no id']);

    // A trailer never excuses a synchronized file that is not an annotation README, nor a mapped document Linear lacks.
    const { 'eng/platform/notes.md': _notes, ...withoutNotes } = documents;
    await recordIds({ ...withoutNotes, 'docs/handbook/start.md': { id: 'gone' } }, final([...both, 'eng/platform/notes.md', 'docs/handbook/start.md']));
    assert.deepEqual(await check(), [
      '2 files differ from their documents (each in i1-differences.txt): docs/handbook/start.md (no document), eng/platform/notes.md (no document)',
      '2 problems: docs/handbook/start.md: its document is not in Linear; eng/platform/notes.md has no id',
    ]);

    // A kept README that later gained an id is checked like any mapped file: its document must exist.
    await recordIds({ ...documents, 'eng/platform/README.md': { id: 'gone' } }, final(both));
    assert.deepEqual(await check(), ['1 files differ from their documents (each in i1-differences.txt): eng/platform/README.md (no document)', '1 problems: eng/platform/README.md: its document is not in Linear']);

    // A body edited on the tracked branch after the record is a new document: without one it fails, named or not.
    await recordIds(documents, final(both));
    await commitReadmes({ 'eng/platform/README.md': ENG.replace('owns', 'runs') }, 'Edit the platform README');
    assert.deepEqual(await check(), ['1 files differ from their documents (each in i1-differences.txt): eng/platform/README.md (no document)', '1 problems: eng/platform/README.md has no id']);

    // An annotation-only README the record holds needs no trailer: the engine keeps it, as capture does after its document leaves.
    await commitReadmes({ 'eng/platform/README.md': `---\nlinear-project: ${PROJECT.name}\n---\n` }, 'Only the annotation');
    await recordLinear();
    await recordIds(documents, final(['docs/handbook/README.md']));
    assert.deepEqual(await check(), [undefined, undefined]);
  });

  it('honor a file the run itself left out at lint in I1, keeping the check of its mapped document in I7', async () => {
    const { ctx, linear, ids } = await fakeRun();
    // A synchronized file gains a footnote: its run leaves it out, and its document stays as it was.
    const git = await ctx.person();
    writeFileSync(join(git.dir, 'docs/handbook/start.md'), '# Start\n\nWelcome.[^1]\n\n[^1]: A footnote.\n');
    await git.run(['commit', '--quiet', '-am', 'Add a footnote']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    assert.equal((await INVARIANT_CHECKS.I1(ctx, async () => readSides(ctx))).detail, '1 files differ from their documents (each in i1-differences.txt): docs/handbook/start.md');
    // The run folder keeps where each file differs: the documents are archived at cleanup.
    assert.equal(readFileSync(join(ctx.runDir, 'i1-differences.txt'), 'utf8'), 'docs/handbook/start.md: line 3: file "Welcome.[^1]", document "Welcome."\n');
    // A differences file that cannot be written leaves a failed check, not a crash.
    const unwritable = await INVARIANT_CHECKS.I1({ ...ctx, runDir: join(ctx.runDir, 'missing') } as RunContext, async () => readSides(ctx));
    assert.equal(unwritable.ok, false);
    assert.match(unwritable.detail ?? '', /^1 files differ from their documents \(i1-differences\.txt not written: .*\): docs\/handbook\/start\.md$/);
    const sync = (leftOut: unknown[]) => engineRun('sync', { initialSync: null, sync: { updated: [], created: [], adopted: [], restored: [], leftOut, leftOutAtWrite: [] } });
    ctx.engine.results.push(sync([{ path: 'docs/handbook/start.md', rules: ['footnote'] }]));
    const sides = await readSides(ctx);
    assert.deepEqual([...sides.omitted], [['docs/handbook/start.md', 'lint: footnote']]);
    assert.deepEqual(await INVARIANT_CHECKS.I1(ctx, async () => sides), { name: 'I1', ok: true });
    assert.deepEqual(await INVARIANT_CHECKS.I7(ctx, async () => sides), { name: 'I7', ok: true });
    // Its mapped document is still checked: trashed, I7 says so.
    await linear.trashDocument(ids['docs/handbook/start.md']?.id as string);
    assert.equal((await INVARIANT_CHECKS.I7(ctx, async () => readSides(ctx))).detail, "1 problems: docs/handbook/start.md: its document is in Linear's trash");
    // A later run whose tree no longer leaves it out takes the omission back: I1 compares the file again.
    ctx.engine.results.push(sync([]));
    assert.equal((await readSides(ctx)).omitted.size, 0);
    assert.match((await INVARIANT_CHECKS.I1(ctx, async () => readSides(ctx))).detail ?? '', /docs\/handbook\/start\.md/);
  });

  it('count only explained omissions from the runs\' reports, the latest decision about a path winning', async () => {
    const { deliberateOmissions } = await import('./checks.ts');
    const initial = (initialSync: Record<string, unknown>, leftOutFiles: unknown[] = []) => ({ report: { summary: { leftOutFiles }, initialSync, sync: null } });
    const sync = (fields: Record<string, unknown>) => ({ report: { initialSync: null, sync: { leftOut: [], leftOutAtWrite: [], ...fields } } });
    // A rule found from linked files counts only with those files; an entry without a rule never counts.
    const leftOutAtWrite = [{ path: 'a.md', rule: 'upload-too-large' }, { path: 'b.md', rule: '' }, { path: 'c.md', rule: 'upload-unreadable', files: ['c.bin'] }];
    assert.deepEqual([...deliberateOmissions([initial({ leftOutAtWrite }, [{ path: 'd.md', rules: ['footnote'] }])])], [['d.md', 'lint: footnote'], ['c.md', 'write: upload-unreadable']]);
    // A dry run and a refused run decide nothing.
    assert.equal(deliberateOmissions([{ report: { summary: { leftOutFiles: [{ path: 'd.md', rules: ['footnote'] }] }, initialSync: null, sync: null } }, { report: null }]).size, 0);
    // A write-time omission outlives runs that do not write the path; a run that writes it takes it back in.
    const tooLong = initial({ leftOutAtWrite: [{ path: 'c.md', rule: 'content-too-long' }] });
    assert.deepEqual([...deliberateOmissions([tooLong, sync({})])], [['c.md', 'write: content-too-long']]);
    assert.equal(deliberateOmissions([tooLong, sync({}), sync({ updated: ['c.md'] })]).size, 0);
    // A later write that fails, is skipped, is not reached or moves a document onto the path also ends it.
    for (const fields of [{ failed: [{ path: 'c.md', operation: 'create', error: 'Fault' }] }, { skipped: [{ path: 'c.md', reason: 'conflict' }] }, { notAttempted: ['c.md'] }, { relocated: [{ from: 'b.md', to: 'c.md' }] }]) {
      assert.equal(deliberateOmissions([tooLong, sync(fields)]).size, 0, JSON.stringify(fields));
    }
    // A plan entry for an upload rule needs its files too.
    assert.equal(deliberateOmissions([initial({}, [{ path: 'e.md', rules: ['upload-too-large'] }])]).size, 0);
    assert.deepEqual([...deliberateOmissions([initial({}, [{ path: 'e.md', rules: ['upload-too-large'], files: ['e.bin'] }])])], [['e.md', 'lint: upload-too-large']]);
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

  it('accept encoded and collision file names in I7 and still catch a wrong title, identity or place', async () => {
    const { ctx, ids } = await fakeRun();
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    const base = await readSides(ctx);
    const start = ids['docs/handbook/start.md']?.id as string;
    const plan = ids['eng/platform/plan.md']?.id as string;
    const suffix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
    // The handbook document retitled `Notes: draft?*` (L2-22) and its file at `path`, mapped to `id`.
    const i7 = async (path: string, title = 'Notes: draft?*', id = start, projectId = OTHER.id) => {
      const files = new Map(base.files);
      const text = files.get('docs/handbook/start.md') as string;
      files.delete('docs/handbook/start.md');
      files.set(path, text);
      const mapped = new Map(base.ids);
      mapped.delete('docs/handbook/start.md');
      mapped.set(path, { id });
      const documents = new Map(base.documents);
      documents.set(start, { ...(base.documents.get(start) as LinearDocument), title, projectId });
      return INVARIANT_CHECKS.I7(ctx, async () => ({ ...base, files, ids: mapped, documents }));
    };
    const pass = { name: 'I7', ok: true };
    assert.deepEqual(await i7('docs/handbook/Notes%3A draft%3F%2A.md'), pass);
    assert.deepEqual(await i7('docs/handbook/Notes: draft?*.md'), pass, 'a git spelling of the title is kept');
    assert.deepEqual(await i7(`docs/handbook/Notes%3A draft%3F%2A~${suffix(start)}.md`), pass);
    assert.deepEqual(await i7(`docs/handbook/Notes%3A draft%3F%2A~${suffix(start)}-1.md`), pass);
    assert.deepEqual(await i7(`docs/handbook/a%2Fb %7C c~${suffix(start)}.md`, 'a/b | c'), pass, 'a flattened collision name');
    assert.deepEqual(await i7('docs/handbook/a/b %7C c.md', 'a/b | c'), pass);
    const wrong = (path: string) => new RegExp(`^1 problems: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: title differs from its path$`);
    // A wrong title, another document's suffix and a name outside the title's place all fail.
    assert.match((await i7('docs/handbook/Notes%3A draft%3F.md')).detail ?? '', wrong('docs/handbook/Notes%3A draft%3F.md'));
    assert.match((await i7('docs/handbook/Notes%3A draft%3F%2A.md', 'Notes: draft?')).detail ?? '', wrong('docs/handbook/Notes%3A draft%3F%2A.md'));
    assert.match((await i7(`docs/handbook/Notes%3A draft%3F%2A~${suffix(plan)}.md`)).detail ?? '', wrong(`docs/handbook/Notes%3A draft%3F%2A~${suffix(plan)}.md`));
    assert.match((await i7(`docs/handbook/a/b %7C c~${suffix(start)}.md`, 'a/b | c')).detail ?? '', wrong(`docs/handbook/a/b %7C c~${suffix(start)}.md`));
    assert.match((await i7('docs/handbook/drafts/Notes%3A draft%3F%2A.md')).detail ?? '', wrong('docs/handbook/drafts/Notes%3A draft%3F%2A.md'));
    // A nested title's file directly in its folder, without the title's subfolder.
    assert.match((await i7('docs/handbook/b %7C c.md', 'a/b | c')).detail ?? '', wrong('docs/handbook/b %7C c.md'));
    // The right name for a document of another project: its folder is not the document's place.
    assert.match((await i7('docs/handbook/Notes%3A draft%3F%2A.md', 'Notes: draft?*', start, PROJECT.id)).detail ?? '', /^1 problems: docs\/handbook\/Notes%3A draft%3F%2A\.md: its document is in project:Field notes aaaaaa, not in its folder's project:Garden plans aaaaaa$/);
    assert.match((await i7(`docs/handbook/Notes%3A draft%3F%2A~${suffix(start)}.md`, 'Notes: draft?*', start, PROJECT.id)).detail ?? '', /its document is in project:Field notes aaaaaa/);
    // Another document's identity on the right name: its own title differs.
    assert.match((await i7('docs/handbook/Notes%3A draft%3F%2A.md', 'Notes: draft?*', plan)).detail ?? '', /title differs from its path/);
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

describe('the authenticated writer of the sync\'s pushes (L1-20)', () => {
  // As recorded in the actions run of L1-20: the engine names itself as the author of its state commits, and
  // GitHub names the sandbox's App as the author of the sync pull request it opened.
  const APP = 'mdbisync-sandbox[bot]';
  const ENGINE_AUTHOR = { GIT_AUTHOR_NAME: NEUTRAL_IDENTITY.name, GIT_AUTHOR_EMAIL: NEUTRAL_IDENTITY.email, GIT_COMMITTER_NAME: NEUTRAL_IDENTITY.name, GIT_COMMITTER_EMAIL: NEUTRAL_IDENTITY.email };
  type Actor = { login: string; type: string } | null;

  /**
   * A confirmed initial sync to Linear as the workflow writes it: two pushes
   * of `ids` (a progress commit, then the final one) and one of `linear`. Each
   * push is recorded by GitHub with `actors[ref][n]` as its actor; `null` for a
   * push GitHub has no record of.
   */
  async function writerCase(
    actors: { ids: [Actor | undefined, Actor | undefined]; linear: Actor | undefined },
    author: Record<string, string> = ENGINE_AUTHOR,
    extra: { onLinear?: Array<{ env: Record<string, string>; merged?: boolean; twoParents?: boolean }>; mergedBy?: string } = {},
  ) {
    const { ctx, remoteGit } = await fakeRun();
    const idsRef = `${ctx.names.refPrefix}/ids`;
    const linearRef = `${ctx.names.refPrefix}/linear`;
    const startIds = (await remoteGit.text(['rev-parse', idsRef])).trim();
    ctx.observations.set('start.refs', { [idsRef]: startIds });
    ctx.observations.set('start.trackedTip', (await remoteGit.text(['rev-parse', ctx.names.trackedBranch])).trim());
    const engine = new Git(remoteGit.dir, author);
    const tree = (await engine.text(['rev-parse', `${startIds}^{tree}`])).trim();
    const progress = (await engine.text(['commit-tree', tree, '-p', startIds, '-m', 'Initial sync: progress'])).trim();
    const final = (await engine.text(['commit-tree', tree, '-p', progress, '-m', 'Initial sync: final ids'])).trim();
    let record = (await engine.text(['commit-tree', tree, '-m', "Initial sync: Linear's state"])).trim();
    // Commits on top of the record that are not the engine's: a merge GitHub made, a CI fix.
    const pulls: Array<{ number: number; head: { ref: string }; merged_at: string; merge_commit_sha: string }> = [];
    for (const commit of extra.onLinear ?? []) {
      const second = commit.twoParents === true ? ['-p', final] : [];
      record = (await new Git(remoteGit.dir, commit.env).text(['commit-tree', tree, '-p', record, ...second, '-m', 'Not the engine'])).trim();
      if (commit.merged === true) pulls.push({ number: pulls.length + 1, head: { ref: ctx.names.syncBranch }, merged_at: '2026-11-10T00:00:00Z', merge_commit_sha: record });
    }
    await engine.run(['update-ref', idsRef, final]);
    await engine.run(['update-ref', linearRef, record]);
    const activity: Record<string, Array<{ ref: string; before: string; after: string; activity_type: string; actor: Actor }>> = { [idsRef]: [], [linearRef]: [] };
    const recorded = (ref: string, before: string, after: string, actor: Actor | undefined) => {
      if (actor !== undefined) activity[ref]!.unshift({ ref, before, after, activity_type: 'push', actor });
    };
    recorded(idsRef, startIds, progress, actors.ids[0]);
    recorded(idsRef, progress, final, actors.ids[1]);
    recorded(linearRef, '0'.repeat(40), record, actors.linear);
    const asked: string[] = [];
    ctx.live!.rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/example/sandbox/pulls') return Response.json(pulls);
      if (/^\/repos\/example\/sandbox\/pulls\/\d+$/.test(url.pathname)) return Response.json({ merged_by: { login: extra.mergedBy ?? APP } });
      assert.equal(url.pathname, '/repos/example/sandbox/activity');
      const ref = url.searchParams.get('ref') as string;
      asked.push(ref);
      // Another ref's push in the same answer is not this ref's.
      return Response.json([...(activity[ref] ?? []), { ref: 'refs/heads/main', before: final, after: record, activity_type: 'push', actor: { login: 'someone', type: 'User' } }]);
    }) as typeof fetch);
    ctx.live!.githubAppLogin = APP;
    return { ctx, asked, activity, idsRef, startIds, progress, final, record };
  }
  const app: Actor = { login: APP, type: 'Bot' };

  it('fail another credential\'s push to a sync ref even when it set the ref to a commit that is not the sync\'s', async () => {
    const { ctx, activity, idsRef, startIds, progress } = await writerCase({ ids: [app, app], linear: app });
    // A person force-pushes ids back to its start between the App's two pushes.
    activity[idsRef]!.splice(1, 0, { ref: idsRef, before: progress, after: startIds, activity_type: 'force_push', actor: { login: 'someone', type: 'User' } });
    await assert.rejects(resolveSubject(ctx, 'writes.githubActor'), (error: Error) => error instanceof ProductError && /\/ids: GitHub records a force_push to [0-9a-f]{12} by a user account/.test(error.message));
  });

  it('accept the App as the writer from GitHub\'s push records while the commits name the engine as their author', async () => {
    const { ctx, asked } = await writerCase({ ids: [app, app], linear: app });
    assert.deepEqual(await resolveSubject(ctx, 'writes.githubActor'), { known: true, value: 'app-bot' });
    assert.deepEqual(asked.sort(), [`${ctx.names.refPrefix}/ids`, `${ctx.names.refPrefix}/linear`]);
    assert.deepEqual(await resolveSubject(ctx, 'writes.commitIdentity'), { known: true, value: 'mdbisync <mdbisync@sync.invalid>' });
  });

  it('read the App as the commits\' author and committer only when every commit names the App as GitHub links it', async () => {
    const appAuthor = (email: string) => ({ GIT_AUTHOR_NAME: APP, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: APP, GIT_COMMITTER_EMAIL: email });
    const { ctx: linked } = await writerCase({ ids: [app, app], linear: app }, appAuthor(`4242+${APP}@users.noreply.github.com`));
    assert.deepEqual(await resolveSubject(linked, 'writes.commitIdentity'), { known: true, value: 'app-bot' });
    // A bot name with an address GitHub does not link to the App is reported as it is.
    const { ctx: unlinked } = await writerCase({ ids: [app, app], linear: app }, appAuthor(`${APP}@users.noreply.github.com`));
    assert.deepEqual(await resolveSubject(unlinked, 'writes.commitIdentity'), { known: true, value: `${APP} <${APP}@users.noreply.github.com>` });
    const { ctx: other } = await writerCase({ ids: [app, app], linear: app }, appAuthor('4242+other-app[bot]@users.noreply.github.com'));
    assert.notEqual((await resolveSubject(other, 'writes.commitIdentity')).value, 'app-bot');
  });

  it('leave out of the commit identity a merge commit GitHub made and a fix CI committed under its own name', async () => {
    const appAuthor = (email: string) => ({ GIT_AUTHOR_NAME: APP, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: APP, GIT_COMMITTER_EMAIL: email });
    const app4242 = appAuthor(`4242+${APP}@users.noreply.github.com`);
    const githubMerge = { GIT_AUTHOR_NAME: APP, GIT_AUTHOR_EMAIL: `4242+${APP}@users.noreply.github.com`, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };
    const ciFix = { GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
    const { ctx } = await writerCase({ ids: [app, app], linear: app }, app4242, { onLinear: [{ env: ciFix }, { env: githubMerge, merged: true }, { env: app4242 }] });
    assert.deepEqual(await resolveSubject(ctx, 'writes.commitIdentity'), { known: true, value: 'app-bot' });
    // The same merge commit, but no pull request merged it: GitHub's committer is then not the App's.
    const { ctx: unmerged } = await writerCase({ ids: [app, app], linear: app }, app4242, { onLinear: [{ env: githubMerge }] });
    assert.match(String((await resolveSubject(unmerged, 'writes.commitIdentity')).value), /GitHub <noreply@github\.com>/);
  });

  it('name the App as the merger only by its exact login, and the merge kind by every merged pull request', async () => {
    const githubMerge = { GIT_AUTHOR_NAME: APP, GIT_AUTHOR_EMAIL: `4242+${APP}@users.noreply.github.com`, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };
    const both = { onLinear: [{ env: githubMerge, merged: true, twoParents: true }, { env: githubMerge, merged: true, twoParents: true }] };
    const { ctx } = await writerCase({ ids: [app, app], linear: app }, ENGINE_AUTHOR, both);
    assert.deepEqual(await resolveSubject(ctx, 'pullRequests.merger'), { known: true, value: 'app-bot' });
    assert.deepEqual(await resolveSubject(ctx, 'pullRequests.mergeKind'), { known: true, value: 'merge' });
    // The job's own token merged: a bot, but not the App.
    const { ctx: job } = await writerCase({ ids: [app, app], linear: app }, ENGINE_AUTHOR, { ...both, mergedBy: 'github-actions[bot]' });
    assert.deepEqual(await resolveSubject(job, 'pullRequests.merger'), { known: true, value: 'github-actions[bot]' });
    // The first merged with a merge commit, the second squashed.
    const { ctx: mixed } = await writerCase({ ids: [app, app], linear: app }, ENGINE_AUTHOR, { onLinear: [{ env: githubMerge, merged: true, twoParents: true }, { env: githubMerge, merged: true }] });
    assert.deepEqual(await resolveSubject(mixed, 'pullRequests.mergeKind'), { known: true, value: 'squash-or-rebase' });
  });

  it('fail a push made with a person\'s credential, without naming the person', async () => {
    const { ctx } = await writerCase({ ids: [app, { login: 'someone', type: 'User' }], linear: app });
    await assert.rejects(resolveSubject(ctx, 'writes.githubActor'), (error: Error) => error instanceof ProductError
      && /\/ids: GitHub records a push to [0-9a-f]{12} by a user account, not by the App mdbisync-sandbox\[bot\]$/.test(error.message) && !error.message.includes('someone'));
  });

  it('fail a run that asked for the App\'s token but pushed with the job\'s own token', async () => {
    const { ctx } = await writerCase({ ids: [app, app], linear: { login: 'github-actions[bot]', type: 'Bot' } });
    await assert.rejects(resolveSubject(ctx, 'writes.githubActor'), (error: Error) => error instanceof ProductError && /\/linear: GitHub records a push to [0-9a-f]{12} by github-actions\[bot\], not by the App/.test(error.message));
  });

  it('fail a user account that took the App\'s login as its name', async () => {
    const { ctx } = await writerCase({ ids: [app, app], linear: { login: APP, type: 'User' } });
    await assert.rejects(resolveSubject(ctx, 'writes.githubActor'), (error: Error) => error instanceof ProductError && /\/linear: .* by a user account/.test(error.message));
  });

  it('leave a commit unproven when GitHub has no record of the push that brought it, whatever its author is called', async () => {
    // The final ids push has no record: the progress push alone does not reach the final commit.
    const { ctx: missingFinal } = await writerCase({ ids: [app, undefined], linear: app });
    await assert.rejects(resolveSubject(missingFinal, 'writes.githubActor'), (error: Error) => error instanceof ProductError && /\/ids: GitHub has no push record for 1 of the sync's 2 commits/.test(error.message));
    // A commit author that looks like the App's bot proves nothing on its own.
    const botName = { GIT_AUTHOR_NAME: APP, GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: APP, GIT_COMMITTER_EMAIL: 'bot@example.com' };
    const { ctx: named } = await writerCase({ ids: [undefined, undefined], linear: undefined }, botName);
    await assert.rejects(resolveSubject(named, 'writes.githubActor'), (error: Error) => error instanceof ProductError && /GitHub has no push record/.test(error.message));
    assert.deepEqual(await resolveSubject(named, 'writes.commitIdentity'), { known: true, value: 'mdbisync-sandbox[bot] <bot@example.com>' });
  });

  it('cover the progress push through the final one, and have nothing to prove without the sync\'s commits', async () => {
    // Only the final push is recorded for ids: its commit carries the progress commit too.
    const { ctx } = await writerCase({ ids: [undefined, app], linear: app });
    assert.deepEqual(await resolveSubject(ctx, 'writes.githubActor'), { known: true, value: 'app-bot' });
    const { ctx: quiet, remoteGit } = await fakeRun();
    quiet.observations.set('start.refs', { [`${quiet.names.refPrefix}/ids`]: (await remoteGit.text(['rev-parse', `${quiet.names.refPrefix}/ids`])).trim() });
    quiet.live!.githubAppLogin = APP;
    assert.deepEqual(await resolveSubject(quiet, 'writes.githubActor'), { known: true, value: null });
    assert.deepEqual(await resolveSubject(quiet, 'writes.commitIdentity'), { known: true, value: null });
  });

  it('block the check when the harness holds no App token to compare with', async () => {
    const { ctx } = await writerCase({ ids: [app, app], linear: app });
    delete ctx.live!.githubAppLogin;
    await assert.rejects(resolveSubject(ctx, 'writes.githubActor'), EnvBlockedError);
  });

  it('refuse a full page of push records rather than read it as complete', async () => {
    const rest = new SandboxRest({ owner: 'example', repo: 'sandbox' }, 'unused', (async () => Response.json(Array.from({ length: 100 }, () => ({ ref: 'refs/x', before: '', after: '', activity_type: 'push', actor: null })))) as typeof fetch);
    await assert.rejects(rest.pushActivities('refs/x'), /100 or more pushes to refs\/x/);
  });
});

describe('crash-created document adoption (L1-17)', () => {
  const CREATE = JSON.stringify({ query: 'mutation CreateDocument($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id } } }', variables: { input: { id: '', title: 'README' } } });
  const createOf = (id: string) => CREATE.replace('"id":""', `"id":"${id}"`);
  // The proxy's record of a create: asked for with the engine's own id, then confirmed by Linear's answer.
  const recordCreate = (ctx: RunContext, id: string) => {
    ctx.owned.before(createOf(id));
    ctx.owned.after(createOf(id), Buffer.from(JSON.stringify({ data: { documentCreate: { success: true, document: { id } } } })));
  };

  // A live run's shape: the engine, paused right after its first create, had made the team zone's
  // annotation README (plain title README, no run prefix) and was killed; the resumed run created the
  // other documents and kept that README as its file's document.
  async function crashed() {
    const run = await fakeRun({ teamZone: true });
    const { ctx, linear, ids } = run;
    const readme = ids['zone/README.md']?.id as string;
    // A document the harness owned before the engine started is not the engine's create.
    ctx.owned.record({ kind: 'document', id: 'seeded-before', confirmed: true });
    await runStep(ctx, { kind: 'fault', action: 'pause', args: { checkpoint: 'document-created-before-ids-push' } });
    ctx.observations.set('pause.ownedBefore', new Set(['seeded-before']));
    const killed: EngineResult = { command: 'initial-sync', exitCode: null, signal: 'SIGKILL', notImplemented: false, timedOut: false, durationMs: 10, stdout: '', stderr: '', summary: '', report: null };
    ctx.engine.pending = { kill: () => {}, done: Promise.resolve(killed) } as never;
    recordCreate(ctx, readme);
    (linear.documents.get(readme) as LinearDocument).createdAt = new Date(Date.now() - 60_000).toISOString();
    await runStep(ctx, { kind: 'kill', action: 'engine', args: { checkpoint: 'document-created-before-ids-push' } });
    // The resumed run's creates come after the kill. The subject reads ids, not times: these times are the live
    // run's, under which a selection by creation time before the kill finds no document of the run's own.
    for (const [path, entry] of Object.entries(ids)) {
      if (path === 'zone/README.md') continue;
      recordCreate(ctx, entry.id);
      (linear.documents.get(entry.id) as LinearDocument).createdAt = new Date(Date.now() + 60_000).toISOString();
    }
    refreshView(ctx);
    return { ...run, readme };
  }

  it('records the exact id Linear confirmed before the kill and proves the resumed run kept it', async () => {
    const { ctx, readme } = await crashed();
    assert.deepEqual(ctx.observations.get('kill.created'), [readme]);
    assert.deepEqual(await resolveSubject(ctx, 'documents.adoptedUnmappedTitle'), { known: true, value: true });
    assert.deepEqual(await resolveSubject(ctx, 'documents.duplicateCount'), { known: true, value: 0 });
  });

  it('ignore another run\'s README in the shared team zone: the ownership record decides', async () => {
    const { ctx, linear } = await crashed();
    linear.add({ teamId: 'team-eng' }, 'README', 'Another run\'s notes.\n');
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.adoptedUnmappedTitle'), { known: true, value: true });
    assert.deepEqual(await resolveSubject(ctx, 'documents.duplicateCount'), { known: true, value: 0 });
  });

  it('fail on a real duplicate of the crash-created README, in the subject, the count and I8', async () => {
    const { ctx, linear } = await crashed();
    // The resumed run created the README again instead of keeping the first one.
    const twin = linear.add({ teamId: 'team-eng' }, 'README', 'Team notes.\n');
    recordCreate(ctx, twin.id);
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.adoptedUnmappedTitle'), { known: true, value: false });
    assert.deepEqual(await resolveSubject(ctx, 'documents.duplicateCount'), { known: true, value: 1 });
    const { INVARIANT_CHECKS, readSides } = await import('./checks.ts');
    assert.deepEqual(await INVARIANT_CHECKS.I8(ctx, async () => readSides(ctx)), { name: 'I8', ok: false, detail: 'duplicate titles: README' });
  });

  it('fail when the crash-created document is no longer the file\'s live document', async () => {
    const { ctx, linear, readme } = await crashed();
    await linear.trashDocument(readme);
    refreshView(ctx);
    assert.deepEqual(await resolveSubject(ctx, 'documents.adoptedUnmappedTitle'), { known: true, value: false });
  });

  it('scan comments on the run\'s own README in the team zone for canaries, not on another run\'s README', async () => {
    const { ctx, linear, readme } = await crashed();
    const other = linear.add({ teamId: 'team-eng' }, 'README', 'Another run\'s notes.\n');
    const file = ctx.live?.manifest.files.find((entry) => entry.path === 'zone/README.md');
    if (file === undefined) throw new Error('the zone README is not in the manifest');
    file.canary = 'kx-zone-readme-canary';
    await linear.commentOnDocument(`content-${readme}`, 'Quoted kx-zone-readme-canary here.');
    await linear.commentOnDocument(`content-${other.id}`, 'Also kx-zone-readme-canary, but another run wrote it.');
    const { canaryScan, collectCanaryEvidence } = await import('./checks.ts');
    const evidence = await collectCanaryEvidence(ctx, { summariesOnly: false });
    assert.equal(evidence.texts[`comments on ${readme}`], 'Quoted kx-zone-readme-canary here.');
    assert.equal(evidence.texts[`comments on ${other.id}`], undefined);
    ctx.observations.delete('canary.remoteTexts');
    assert.deepEqual(await canaryScan(ctx, { summariesOnly: false }), [{ source: `comments on ${readme}`, canary: 'kx-zone-readme-canary' }]);
  });

  it('scan comments on the run\'s own README after the engine trashed it', async () => {
    const { ctx, linear, readme } = await crashed();
    const file = ctx.live?.manifest.files.find((entry) => entry.path === 'zone/README.md');
    if (file === undefined) throw new Error('the zone README is not in the manifest');
    file.canary = 'kx-zone-readme-canary';
    await linear.commentOnDocument(`content-${readme}`, 'Quoted kx-zone-readme-canary here.');
    await linear.trashDocument(readme);
    const { canaryScan } = await import('./checks.ts');
    assert.deepEqual(await canaryScan(ctx, { summariesOnly: false }), [{ source: `comments on ${readme}`, canary: 'kx-zone-readme-canary' }]);
  });

  it('ask for the owned ids in bounded queries and still reach the last one', async () => {
    const { ctx, linear, readme } = await crashed();
    // Owned ids Linear does not list (creates asked for but never confirmed), recorded after the README.
    for (let index = 0; index < 60; index += 1) ctx.owned.record({ kind: 'document', id: `never-created-${index}`, confirmed: false });
    const late = linear.add({ teamId: 'team-eng' }, 'README', 'Late notes.\n');
    recordCreate(ctx, late.id);
    await linear.commentOnDocument(`content-${late.id}`, 'Late kx-zone-readme-canary.');
    const { collectCanaryEvidence } = await import('./checks.ts');
    const evidence = await collectCanaryEvidence(ctx, { summariesOnly: false });
    assert.equal(evidence.texts[`comments on ${late.id}`], 'Late kx-zone-readme-canary.');
    assert.ok(`comments on ${readme}` in evidence.texts);
    const byId = linear.commentQueries.map((variables) => (variables.filter as { id?: { in: string[] } }).id?.in).filter((ids) => ids !== undefined);
    assert.ok(byId.length >= 2 && byId.every((ids) => ids.length <= 50), `owned ids per query: ${byId.map((ids) => ids.length).join(', ')}`);
    assert.equal(new Set(byId.flat()).size, byId.flat().length, 'an owned id is asked for once');
  });

  it('refuse a kill without the documents the run owned before the engine started', async () => {
    const { ctx } = await fakeRun({ teamZone: true });
    ctx.engine.pending = { kill: () => {}, done: new Promise(() => {}) } as never;
    await assert.rejects(runStep(ctx, { kind: 'kill', action: 'engine', args: { checkpoint: 'document-created-before-ids-push' } }), /owned before the engine started/);
  });

  it('fail when no create was recorded before the kill', async () => {
    const { ctx } = await crashed();
    ctx.observations.set('kill.created', []);
    assert.deepEqual(await resolveSubject(ctx, 'documents.adoptedUnmappedTitle'), { known: true, value: false });
  });
});

describe('initial sync from Linear: kept annotation READMEs (L1R-01, L1R-02, L1R-06)', () => {
  // Two folders whose README holds the folder's annotation (and a body) but no Linear document maps to it: the sync keeps them.
  const KEPT = {
    'eng/README.md': '---\nlinear-team: ENG\n---\n\nEngineering notes live in the folders below.\n',
    'docs/README.md': '---\nlinear-team: DOCS\nowner: docs\n---\n\n# Docs\n\nThe handbook and its policies.\n',
  };
  // Files with a document (overwrite), a document without a file (create) and a file without a document (remove).
  const OVERWRITTEN = ['docs/handbook/README.md', 'docs/handbook/faq.md', 'docs/handbook/policies/remote.md', 'docs/handbook/start.md', 'eng/platform/README.md', 'eng/platform/notes.md', 'eng/platform/plan.md', 'eng/platform/runbook.md'];
  const CREATED = 'eng/platform/decisions/cache-warm-up.md';
  const REMOVED = 'eng/platform/old.md';
  const ACTIONS = [...OVERWRITTEN, CREATED, REMOVED].sort();

  /** The mini case: ten actions (eight overwrites, one new file, one removal) and two kept READMEs. */
  async function miniCase() {
    const run = await fakeRun();
    const { ctx, linear, ids } = run;
    const git = await ctx.person();
    const tracked: Record<string, string> = {
      ...KEPT,
      'eng/platform/runbook.md': '# Runbook\n\nRestart the worker.\n',
      'docs/handbook/faq.md': '# FAQ\n\nAsk in the channel.\n',
      'docs/handbook/policies/remote.md': '# Remote work\n\nTwo office days.\n',
      [REMOVED]: '# Old\n\nNo longer used.\n',
    };
    for (const [path, text] of Object.entries(tracked)) {
      mkdirSync(join(git.dir, path, '..'), { recursive: true });
      writeFileSync(join(git.dir, path), text);
    }
    await git.run(['add', '--all']);
    await git.run(['commit', '--quiet', '-m', 'Add the mini case files']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    // Linear is the model: its text differs from every tracked file's.
    for (const [path, entry] of Object.entries(ids)) {
      const document = linear.documents.get(entry.id) as LinearDocument;
      document.content = `${[document.content?.trimEnd(), `Edited in Linear: ${path}.`].filter(Boolean).join('\n\n')}\n`;
    }
    linear.add({ projectId: PROJECT.id }, 'runbook', '# Runbook\n\nRestart the worker, then the queue.\n');
    linear.add({ projectId: OTHER.id }, 'faq', '# FAQ\n\nAsk in the team channel.\n');
    linear.add({ projectId: OTHER.id }, 'policies/remote', '# Remote work\n\nThree office days.\n');
    linear.add({ projectId: PROJECT.id }, 'decisions/cache-warm-up', '# Cache warm-up\n\nWarm the route cache before traffic.\n');
    refreshView(ctx);
    return run;
  }

  /** Opens the pull request head the sync would: the tracked tree as Linear holds it, with `change` applied to the files. */
  async function syncHead(ctx: RunContext, linear: FakeLinear, change: (files: Map<string, string>) => void = () => {}): Promise<void> {
    const git = await ctx.person();
    const files = new Map<string, string>(Object.entries(KEPT));
    for (const document of linear.documents.values()) {
      const folder = document.projectId === PROJECT.id ? 'eng/platform' : 'docs/handbook';
      const path = `${folder}/${document.title}.md`;
      // A file keeps its front matter (a project README's annotation) and takes Linear's body.
      const original = existsSync(join(git.dir, path)) ? readFileSync(join(git.dir, path), 'utf8') : '';
      const head = /^---\n[\s\S]*?\n---\n/.exec(original)?.[0] ?? '';
      files.set(path, `${head}${document.content ?? ''}`);
    }
    change(files);
    await git.run(['switch', '--quiet', '-c', 'sync-head']);
    await git.run(['rm', '--quiet', '-r', 'eng', 'docs']);
    for (const [path, text] of files) {
      mkdirSync(join(git.dir, path, '..'), { recursive: true });
      writeFileSync(join(git.dir, path), text);
    }
    await git.run(['add', '--all']);
    await git.run(['commit', '--quiet', '-m', 'Initial sync from Linear']);
    await git.run(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${ctx.names.syncBranch}`]);
    await git.run(['switch', '--quiet', '-']);
    await git.run(['branch', '--quiet', '-D', 'sync-head']);
  }

  // The assertions of each scenario these tests check; pull request counts, ids and writes need the engine's own run.
  const CHECKED: Record<string, string[]> = {
    'L1R-01': ['summary.plan.paths'],
    'L1R-02': ['pullRequests.tree', 'pullRequests.keptAnnotationReadmes', 'pullRequests.gitOnlyPaths'],
    'L1R-06': ['files.duplicateCount', 'pullRequests.tree', 'pullRequests.keptAnnotationReadmes'],
  };

  /** The checked assertions of the scenario that fail, by its own subjects. */
  async function failing(ctx: RunContext, id: string): Promise<string[]> {
    const scenario = scenarios.find((candidate) => candidate.id === id)!;
    const checked = scenario.checks.assertions.filter((assertion) => CHECKED[id]?.includes(assertion.subject));
    // A renamed or dropped assertion must not leave these tests checking nothing.
    assert.deepEqual(checked.map((assertion) => assertion.subject), CHECKED[id], `${id} assertions`);
    const failed: string[] = [];
    for (const assertion of checked) {
      const { value } = await resolveSubject(ctx, assertion.subject);
      const expected = assertion.operator === 'same-as' ? (await resolveSubject(ctx, String(assertion.expected))).value : assertion.expected;
      if (!compare(assertion.operator, value, expected)) failed.push(assertion.subject);
    }
    return failed;
  }

  const dryRun = (paths: string[]) => engineRun('initial-sync', { summary: { direction: 'linear-to-git', confirm: false, plan: { paths } } });

  it('expect the ten actions of the dry run, not the two kept READMEs (L1R-01)', async () => {
    const { ctx } = await miniCase();
    assert.deepEqual((await resolveSubject(ctx, 'expected.reversePlan.paths')).value, ACTIONS);
    ctx.engine.results.push(dryRun(ACTIONS));
    assert.deepEqual(await failing(ctx, 'L1R-01'), []);
    // A plan that lists the kept READMEs as actions, or misses the removal or the new file, still fails.
    for (const paths of [[...ACTIONS, ...Object.keys(KEPT)].sort(), ACTIONS.filter((path) => path !== REMOVED), ACTIONS.filter((path) => path !== CREATED)]) {
      ctx.engine.results.push(dryRun(paths));
      assert.deepEqual(await failing(ctx, 'L1R-01'), ['summary.plan.paths'], paths.join(', '));
    }
  });

  it('expect the pull request to hold Linear\'s documents and the kept READMEs with their annotations and bodies (L1R-02, L1R-06)', async () => {
    const { ctx, linear } = await miniCase();
    await syncHead(ctx, linear);
    const tree = (await resolveSubject(ctx, 'expected.linearTree')).value as Map<string, string>;
    assert.deepEqual([...tree.keys()].sort(), [...OVERWRITTEN, CREATED, ...Object.keys(KEPT)].sort());
    assert.equal(tree.get('docs/README.md'), '# Docs\n\nThe handbook and its policies.\n');
    assert.deepEqual((await resolveSubject(ctx, 'expected.keptAnnotationReadmes')).value, new Map(Object.entries(KEPT)));
    assert.deepEqual(await failing(ctx, 'L1R-02'), []);
    assert.deepEqual(await failing(ctx, 'L1R-06'), []);
  });

  for (const [name, change, failed] of [
    ['a kept README dropped', (files: Map<string, string>) => files.delete('eng/README.md'), ['pullRequests.tree', 'pullRequests.keptAnnotationReadmes']],
    ['a kept README\'s body replaced', (files: Map<string, string>) => files.set('docs/README.md', '---\nlinear-team: DOCS\nowner: docs\n---\n\nSomething else.\n'), ['pullRequests.tree', 'pullRequests.keptAnnotationReadmes']],
    ['a kept README\'s annotation changed', (files: Map<string, string>) => files.set('eng/README.md', KEPT['eng/README.md'].replace('ENG', 'OPS')), ['pullRequests.keptAnnotationReadmes']],
    ['the file without a document kept', (files: Map<string, string>) => files.set(REMOVED, '# Old\n\nNo longer used.\n'), ['pullRequests.tree', 'pullRequests.gitOnlyPaths']],
    ['the new document missing', (files: Map<string, string>) => files.delete(CREATED), ['pullRequests.tree']],
    ['a document written twice', (files: Map<string, string>) => files.set('eng/platform/runbook-2.md', files.get('eng/platform/runbook.md') as string), ['pullRequests.tree', 'pullRequests.gitOnlyPaths', 'files.duplicateCount']],
  ] as const) {
    it(`fail when the pull request has ${name}`, async () => {
      const { ctx, linear } = await miniCase();
      await syncHead(ctx, linear, change);
      const both = new Set([...(await failing(ctx, 'L1R-02')), ...(await failing(ctx, 'L1R-06'))]);
      assert.deepEqual([...both].sort(), [...failed].sort());
    });
  }
});

describe('the setup check step (run.check)', () => {
  // The setup checks of a real `check` run on a fresh mini repository written by `init`.
  const SETUP_CHECKS = [
    { name: 'linear-credentials', state: 'passed', detail: 'Linear token accepted with scopes read, write' },
    { name: 'github-access', state: 'passed', detail: 'GitHub token has contents:write, pull_requests:write, workflows:write, checks:read, statuses:read' },
    { name: 'merge-commits', state: 'passed', detail: 'merge commits are allowed' },
    { name: 'linear-format-hook', state: 'passed', detail: '.pre-commit-config.yaml has the linear-format hook' },
    { name: 'annotations', state: 'passed', detail: '5 annotated folders, 12 files to sync' },
    { name: 'annotation-targets', state: 'passed', detail: 'found in Linear: 2 teams, 3 projects' },
    { name: 'left-out-files', state: 'passed', detail: 'no files left out' },
    { name: 'security-hooks', state: 'warning', detail: 'no pre-commit hook marked "alias: security": content is pushed unchecked' },
  ];
  const CHECK_REPORT = {
    capacity: [], operation: 'check', ok: true, code: null, exitStatus: 'success', stop: null, complete: false, changed: false,
    setupChecks: SETUP_CHECKS, securityHooks: [], notImplemented: false, summary: null, initialSync: null, capture: null, pullRequest: null, sync: null,
    writtenCount: 0, writtenDocuments: 0, writes: { linear: {}, git: {}, pullRequests: {} },
  };
  const FAILED_CHECKS = [{ name: 'linear-credentials', state: 'failed', detail: 'Linear refused the client credentials' }];
  const FAILED_REPORT = { ...CHECK_REPORT, ok: false, code: 'setup-failed', exitStatus: 'setup-failed', setupChecks: FAILED_CHECKS };
  const DRY_RUN_REPORT = { operation: 'initial-sync', ok: true, code: null, complete: true, changed: false, summary: { plan: { paths: ['guides/start.md'] } }, writes: { linear: {}, git: {}, pullRequests: {} } };

  type Answer = { report?: unknown; summary?: string; stderr?: string; exitCode: number };
  /**
   * Runs `steps` with a fake engine that answers each command from `answers` and records how it was called.
   * A list answers a command's runs in turn, its last entry every later run. With `seen`, the calls are
   * also there when a step throws.
   */
  async function withEngine(answers: Record<string, Answer | Answer[]>, steps: Array<{ kind?: 'run' | 'fault'; action: string; args: Record<string, unknown> }>, seen: { calls: Array<{ command: string }> } = { calls: [] }) {
    const { ctx } = await fakeRun();
    mkdirSync(await ctx.engineClone(), { recursive: true });
    const calls = join(ctx.runDir, 'engine-calls.jsonl');
    const driver = join(ctx.runDir, 'fake-engine.mjs');
    writeFileSync(driver, `
      import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
      const command = process.argv[2];
      const before = existsSync(${JSON.stringify(calls)}) ? readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter((line) => line.includes(JSON.stringify(command))).length : 0;
      const answers = [${JSON.stringify(answers)}[command]].flat();
      const answer = answers[Math.min(before, answers.length - 1)];
      const inputs = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('MDBISYNC_') && !/SECRET|TOKEN/.test(name)));
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, cwd: process.cwd(), inputs }) + '\\n');
      if (answer.report !== undefined) writeFileSync(process.env.MDBISYNC_REPORT_FILE, JSON.stringify(answer.report));
      if (answer.summary !== undefined) writeFileSync(process.env.GITHUB_STEP_SUMMARY, answer.summary);
      if (answer.stderr !== undefined) process.stderr.write(answer.stderr);
      process.exitCode = answer.exitCode;
    `);
    const previous = process.env['MDBISYNC_ENGINE'];
    process.env['MDBISYNC_ENGINE'] = driver;
    try {
      for (const step of steps) await runStep(ctx, { kind: 'run', ...step });
    } finally {
      if (previous === undefined) delete process.env['MDBISYNC_ENGINE'];
      else process.env['MDBISYNC_ENGINE'] = previous;
      // A partial line from a killed fake engine must not hide the step's own error.
      seen.calls = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').flatMap((line) => { try { return [JSON.parse(line) as { command: string }]; } catch { return []; } }) : [];
    }
    return { ctx, calls: seen.calls as Array<{ command: string; cwd: string; inputs: Record<string, string> }> };
  }

  it('runs the engine check in the run clone with the run isolation and records it as the first run', async () => {
    const summary = '## Setup check\n\nEvery required item passed.\n';
    const { ctx, calls } = await withEngine(
      { check: { report: CHECK_REPORT, summary, exitCode: 0 }, 'initial-sync': { report: DRY_RUN_REPORT, exitCode: 0 } },
      [{ action: 'check', args: {} }, { action: 'initial-sync', args: { direction: 'git-to-linear', confirm: false } }],
    );
    assert.deepEqual(calls.map((call) => call.command), ['check', 'initial-sync']);
    const [check] = calls;
    assert.equal(check!.cwd, await ctx.engineClone());
    assert.equal(check!.inputs['MDBISYNC_TRACKED_BRANCH'], ctx.names.trackedBranch);
    assert.equal(check!.inputs['MDBISYNC_SYNC_BRANCH'], ctx.names.syncBranch);
    assert.equal(check!.inputs['MDBISYNC_STATE_REF_PREFIX'], ctx.names.refPrefix);
    assert.equal(check!.inputs['MDBISYNC_LINEAR_API_URL'], ctx.proxy!.url);
    assert.equal(check!.inputs['MDBISYNC_REPORT_FILE'], join(ctx.runDir, 'engine-0', 'report.json'));
    assert.equal(check!.inputs['MDBISYNC_DIRECTION'], undefined);
    assert.equal(check!.inputs['MDBISYNC_CONFIRM'], undefined);
    // The check is the scenario's run 0; the dry run after it is run 1 and the last run.
    assert.deepEqual(ctx.engine.results.map((result) => [result.command, result.exitCode]), [['check', 0], ['initial-sync', 0]]);
    assert.equal(ctx.engine.results[0]!.summary, summary);
    assert.equal(ctx.observations.get('runs.0.exitCode'), 0);
    assert.equal(ctx.observations.get('runs.0.operation'), 'check');
    assert.deepEqual(ctx.observations.get('runs.0.setupChecks'), SETUP_CHECKS);
    assert.equal(ctx.observations.get('runs.1.operation'), 'initial-sync');
    assert.deepEqual(await resolveSubject(ctx, 'runs.0.writes.total'), { known: true, value: 0 });
    assert.deepEqual(await resolveSubject(ctx, 'summary.plan.paths'), { known: true, value: ['guides/start.md'] });
  });

  it('records a failed check as the run result and goes on to the next step', async () => {
    const { ctx, calls } = await withEngine(
      { check: { report: FAILED_REPORT, exitCode: 3 }, 'initial-sync': { report: { ...DRY_RUN_REPORT, ok: false, code: 'setup-failed', summary: null }, exitCode: 3 } },
      [{ action: 'check', args: {} }, { action: 'initial-sync', args: { direction: 'git-to-linear', confirm: false } }],
    );
    assert.deepEqual(calls.map((call) => call.command), ['check', 'initial-sync']);
    assert.equal(ctx.observations.get('runs.0.exitCode'), 3);
    assert.equal(ctx.observations.get('runs.0.code'), 'setup-failed');
    assert.deepEqual(ctx.observations.get('runs.0.setupChecks'), FAILED_CHECKS);
    // An assertion on the dry run's plan cannot pass on the failed setup.
    await assert.rejects(resolveSubject(ctx, 'summary.plan.paths'), (error: Error) => error instanceof ProductError);
  });

  const TARGETS_FAILED = [{ name: 'annotation-targets', state: 'failed', detail: 'not found in Linear: project "Library index aaaaaa" of team "ENG"' }];
  const SETUP_STOP = { ...CHECK_REPORT, operation: 'sync', ok: false, code: 'annotation-target-not-found', exitStatus: 'failure', complete: false, setupChecks: TARGETS_FAILED };
  const COMPLETE = { ...CHECK_REPORT, operation: 'sync', ok: true, code: null, exitStatus: 'success', complete: true, changed: true };

  /** Runs resume-until-complete against these sync answers; the error it ends with (or null) and the engine runs. */
  async function resume(answers: Answer[]) {
    const seen = { calls: [] as Array<{ command: string }> };
    const error = await withEngine({ sync: answers }, [{ action: 'resume-until-complete', args: {} }], seen).then(() => null, (failure: Error) => failure);
    return { error, runs: seen.calls.length };
  }

  it('marks the runs a credentials fault made invalid, so their setup stop is the scenario\'s', async () => {
    const stop = { report: { ...SETUP_STOP, code: 'linear-credential-failed', setupChecks: FAILED_CHECKS }, exitCode: 3 };
    const { ctx } = await withEngine({ sync: [stop, { report: COMPLETE, exitCode: 0 }] }, [
      { action: 'sync', args: {} },
      { kind: 'fault', action: 'credentials', args: { service: 'linear', valid: false } },
      { action: 'sync', args: {} },
      { kind: 'fault', action: 'clear', args: {} },
      { action: 'sync', args: {} },
    ]);
    assert.deepEqual(ctx.engine.results.map((result) => result.credentialFault), [undefined, 'linear', undefined]);
    const failed = new ProductError('checks failed: I1');
    assert.equal(blockedBySetupStop(failed, ctx.engine.results.slice(1, 2), 0), failed);
    assert.ok(blockedBySetupStop(failed, ctx.engine.results.slice(0, 1), 0) instanceof EnvBlockedError);
  });

  it('stops resuming when a setup check fails the same way twice in a row, and names it', async () => {
    const { error, runs } = await resume([{ report: SETUP_STOP, exitCode: 3 }]);
    assert.ok(error instanceof ProductError);
    assert.equal(error.message, 'the run failed twice in a row at the setup check annotation-targets (annotation-target-not-found): not found in Linear: project "Library index aaaaaa" of team "ENG"; resuming cannot clear it');
    assert.equal(runs, 2);
  });

  it('stops resuming when the sync is refused the same way twice in a row', async () => {
    const refused = { ...SETUP_STOP, code: 'initial-pull-request-pending', setupChecks: SETUP_CHECKS };
    const { error, runs } = await resume([{ report: refused, exitCode: 3 }]);
    assert.equal(error?.message, 'the run failed twice in a row with initial-pull-request-pending; resuming cannot clear it');
    assert.equal(runs, 2);
  });

  it('resumes past a setup check that failed once', async () => {
    const teamsHidden = { ...SETUP_STOP, code: 'linear-teams-not-visible', setupChecks: [{ name: 'annotation-targets', state: 'failed', detail: 'the token sees no team' }] };
    // A passing failure, then a different one, then the run completes: no failure repeated.
    const { error, runs } = await resume([{ report: teamsHidden, exitCode: 3 }, { report: SETUP_STOP, exitCode: 3 }, { report: COMPLETE, exitCode: 0 }]);
    assert.equal(error, null);
    assert.equal(runs, 3);
  });

  it('keeps resuming a run that stopped part-way, up to 20 runs', async () => {
    const partial = { ...CHECK_REPORT, operation: 'sync', ok: true, code: 'rate-limited', exitStatus: 'warning', complete: false, setupChecks: SETUP_CHECKS };
    const { error, runs } = await resume([{ report: partial, exitCode: 0 }]);
    assert.ok(error instanceof ProductError);
    assert.equal(error.message, 'the run did not complete after 20 resumes');
    assert.equal(runs, 20);
  });

  it('stops resuming at once when a document left out at write is all that keeps the sync incomplete', async () => {
    const sync = { complete: false, failed: [], notAttempted: [], skipped: [], conflicts: [], stopped: null, leftOutAtWrite: [{ path: 'eng/notes/scan.md', rule: 'upload-too-large', files: ['eng/media/scan.png'] }] };
    const leftOut = { ...COMPLETE, complete: false, changed: false, sync };
    const { error, runs } = await resume([{ report: leftOut, exitCode: 0 }]);
    assert.ok(error instanceof ProductError);
    assert.equal(error.message, 'the run changed nothing and only left out at write eng/notes/scan.md (upload-too-large); resuming cannot clear it');
    assert.equal(runs, 1);
    // A run that still wrote something, or still has other work, resumes.
    const progressed = await resume([{ report: { ...leftOut, changed: true }, exitCode: 0 }, { report: COMPLETE, exitCode: 0 }]);
    assert.equal(progressed.error, null);
    const failed = { ...leftOut, sync: { ...sync, failed: [{ path: 'eng/notes/a.md', operation: 'UpdateDocument', error: 'timeout' }] } };
    const retried = await resume([{ report: failed, exitCode: 0 }, { report: COMPLETE, exitCode: 0 }]);
    assert.equal(retried.error, null);
    // A write step that completed leaves another cause (a held removal, the pull request): the run resumes.
    const heldElsewhere = await resume([{ report: { ...leftOut, sync: { ...sync, complete: true } }, exitCode: 0 }, { report: COMPLETE, exitCode: 0 }]);
    assert.equal(heldElsewhere.error, null);
    // An unreadable upload can become readable with no git change: the run resumes.
    const unreadable = { ...leftOut, sync: { ...sync, leftOutAtWrite: [{ path: 'eng/notes/lost.md', rule: 'upload-unreadable', files: ['eng/notes/lost.png'] }] } };
    const recovered = await resume([{ report: unreadable, exitCode: 0 }, { report: COMPLETE, exitCode: 0 }]);
    assert.equal(recovered.error, null);
    assert.equal(recovered.runs, 2);
  });

  it('stops the scenario when the engine does not implement the check', async () => {
    await assert.rejects(
      withEngine({ check: { stderr: 'check: not implemented\n', exitCode: 15 } }, [{ action: 'check', args: {} }]),
      (error: Error) => error.name === 'NotImplementedError',
    );
  });

  it('needs the sandbox and Linear: an offline scenario has no credentials to check', async () => {
    const { ctx } = await fakeRun();
    await assert.rejects(runStep({ ...ctx, live: null }, { kind: 'run', action: 'check', args: {} }), /needs the sandbox and Linear/);
    assert.equal(ctx.engine.results.length, 0);
  });

  it('leaves a mid-run fault armed for the next sync to that sync', async () => {
    const { ctx } = await fakeRun();
    let acted = false;
    ctx.engine.trigger = { checkpoint: 'after-write-before-record', action: async () => { acted = true; } };
    await assert.rejects(runStep(ctx, { kind: 'run', action: 'check', args: {} }), /checkpoint fault waits for the next sync run/);
    assert.notEqual(ctx.engine.trigger, undefined);
    assert.equal(acted, false);
    assert.equal(ctx.engine.results.length, 0);
  });
});

describe('quiet runs through the harness', () => {
  const QUIET_REPORT = {
    operation: 'sync', ok: true, complete: true, changed: true,
    capture: { ok: true, changed: [], removed: [] },
    pullRequest: { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [] },
    sync: { complete: true, updated: [], relocated: [], created: [], adopted: [], restored: [], trashed: [], record: null },
    writtenCount: 0, writtenDocuments: 0,
  };
  const MERGED = { number: 30, state: 'closed', title: 'Changes from Linear', body: 'One document.', head: { ref: 't/aaaaaa/sync', sha: 'a'.repeat(40) }, base: { ref: 't/aaaaaa/main' }, merged_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' };

  /**
   * One watched sync whose fake engine moves the named refs of the bare
   * remote; `pullRequests` is what GitHub lists before and after it, and
   * `writes` the document writes the proxy sees during it.
   */
  it('gives each same-run merge case its own check setup', () => {
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    // Fast checks and slow checks publish the workflow; the no-check case starts without it.
    assert.equal(publishesCheckWorkflow(byId.get('L2-38')!), true);
    assert.equal(publishesCheckWorkflow(byId.get('L2-39')!), false);
    assert.equal(publishesCheckWorkflow(byId.get('L2-40')!), true);
    assert.ok(byId.get('L2-40')!.setup.fixtures.includes('pending-check'));
    // Positive grace on every run, never the harness's deferring default.
    for (const id of ['L2-38', 'L2-39', 'L2-40']) {
      const runs = byId.get(id)!.steps.filter((step) => step.kind === 'run');
      assert.ok(runs.length > 0 && runs.every((step) => typeof step.args.mergeGraceSeconds === 'number' && step.args.mergeGraceSeconds > 0), id);
      assert.ok(byId.get(id)!.checks.assertions.some((assertion) => assertion.subject === 'quiet.last'), id);
      assert.ok(!byId.get(id)!.checks.assertions.some((assertion) => assertion.subject.endsWith('.changed')), id);
    }
  });

  async function watchedRun(options: { moves: Array<'state' | 'tracked-tree' | 'tracked-commit' | 'sync'>; report?: Record<string, unknown>; pullRequests?: [unknown[], unknown[]]; writes?: number; watch?: boolean }) {
    const { ctx, remoteGit } = await fakeRun();
    mkdirSync(await ctx.engineClone(), { recursive: true });
    mkdirSync(ctx.sandbox!.cache.dir, { recursive: true });
    if (options.watch !== false) ctx.scenario = { ...ctx.scenario, checks: { ...ctx.scenario.checks, assertions: [{ subject: 'quiet.last', operator: 'equal', expected: [] }] } };
    const lists = options.pullRequests ?? [[MERGED], [MERGED]];
    let listed = 0;
    Object.assign(ctx.live!, { rest: { pullRequests: async () => lists[Math.min(listed++, 1)] } });
    const records = join(ctx.runDir, 'proxy-records.json');
    Object.defineProperty(ctx.proxy!, 'requests', { get: () => (existsSync(records) ? JSON.parse(readFileSync(records, 'utf8')) : []) });
    const names = ctx.names;
    const driver = join(ctx.runDir, 'quiet-sync.mjs');
    writeFileSync(driver, `
      import { execFileSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
      const git = (...args) => execFileSync('git', ['--git-dir', ${JSON.stringify(remoteGit.dir)}, ...args], { env, encoding: 'utf8' }).trim();
      const empty = git('hash-object', '-t', 'tree', '-w', '--stdin');
      const tip = git('rev-parse', ${JSON.stringify(names.trackedBranch)});
      for (const move of ${JSON.stringify(options.moves)}) {
        if (move === 'state') git('update-ref', ${JSON.stringify(`${names.refPrefix}/linear`)}, git('commit-tree', empty, '-m', 'Record the merge'));
        if (move === 'tracked-tree') git('update-ref', ${JSON.stringify(`refs/heads/${names.trackedBranch}`)}, git('commit-tree', empty, '-p', tip, '-m', 'Change content'));
        if (move === 'tracked-commit') git('update-ref', ${JSON.stringify(`refs/heads/${names.trackedBranch}`)}, git('commit-tree', tip + '^{tree}', '-p', tip, '-m', 'Same content'));
        if (move === 'sync') git('update-ref', ${JSON.stringify(`refs/heads/${names.syncBranch}`)}, git('commit-tree', empty, '-m', 'Sync branch'));
      }
      const writes = Array.from({ length: ${options.writes ?? 0} }, (_, n) => ({ n, at: 0, operation: 'documentUpdate', kind: 'mutation', status: 200, injected: false }));
      writeFileSync(${JSON.stringify(records)}, JSON.stringify(writes));
      writeFileSync(process.env.MDBISYNC_REPORT_FILE, JSON.stringify(${JSON.stringify({ ...QUIET_REPORT, ...options.report })}));
    `);
    const previous = process.env['MDBISYNC_ENGINE'];
    process.env['MDBISYNC_ENGINE'] = driver;
    try {
      await runStep(ctx, { kind: 'run', action: 'sync', args: {} });
    } finally {
      if (previous === undefined) delete process.env['MDBISYNC_ENGINE'];
      else process.env['MDBISYNC_ENGINE'] = previous;
    }
    return ctx;
  }

  it('is a harness subject', () => {
    assert.equal(subjectSource('quiet.last'), 'harness');
    assert.equal(subjectSource('quiet.0'), 'harness');
    assert.equal(subjectSource('before.quiet.last'), null);
  });

  it('accepts a metadata-only merge record although the run reports changed=true', async () => {
    const ctx = await watchedRun({ moves: ['state'] });
    assert.deepEqual(await resolveSubject(ctx, 'runs.last.changed'), { known: true, value: true });
    assert.deepEqual(await resolveSubject(ctx, 'quiet.last'), { known: true, value: [] });
    assert.deepEqual(await resolveSubject(ctx, 'quiet.0'), { known: true, value: [] });
  });

  it('accepts a run that changed nothing', async () => {
    const ctx = await watchedRun({ moves: [], report: { changed: false } });
    assert.deepEqual(await resolveSubject(ctx, 'quiet.last'), { known: true, value: [] });
  });

  it('rejects document writes the proxy saw', async () => {
    const ctx = await watchedRun({ moves: ['state'], writes: 2 });
    assert.deepEqual(await resolveSubject(ctx, 'quiet.last'), { known: true, value: ['2 document writes reached Linear'] });
  });

  it('rejects a different tracked tree, and a moved tracked branch', async () => {
    const tree = await watchedRun({ moves: ['state', 'tracked-tree'] });
    assert.deepEqual(await resolveSubject(tree, 'quiet.last'), { known: true, value: ['the tracked content changed', 'the tracked branch moved'] });
    const commit = await watchedRun({ moves: ['state', 'tracked-commit'] });
    assert.deepEqual(await resolveSubject(commit, 'quiet.last'), { known: true, value: ['the tracked branch moved'] });
  });

  it('rejects repeated pull request activity: a new one, an update, a moved sync branch', async () => {
    const opened = await watchedRun({ moves: ['state'], pullRequests: [[MERGED], [{ ...MERGED, number: 31, state: 'open', merged_at: null }, MERGED]] });
    assert.deepEqual(await resolveSubject(opened, 'quiet.last'), { known: true, value: ['pull request #31 was opened'] });
    const updated = await watchedRun({ moves: ['state'], pullRequests: [[MERGED], [{ ...MERGED, body: 'Two documents.' }]] });
    assert.deepEqual(await resolveSubject(updated, 'quiet.last'), { known: true, value: ['pull request #30 was updated'] });
    const moved = await watchedRun({ moves: ['state', 'sync'] });
    assert.deepEqual(await resolveSubject(moved, 'quiet.last'), { known: true, value: ['the sync branch moved'] });
  });

  it('rejects changed=true that no state ref write explains', async () => {
    const ctx = await watchedRun({ moves: [] });
    assert.deepEqual(await resolveSubject(ctx, 'quiet.last'), { known: true, value: ['the run reports changed=true, but no state ref moved'] });
  });

  it('gives no verdict for a run it did not watch', async () => {
    const ctx = await watchedRun({ moves: ['state'], watch: false });
    await assert.rejects(resolveSubject(ctx, 'quiet.last'), /was not watched/);
    await assert.rejects(resolveSubject(ctx, 'quiet.3'), ProductError);
  });
});

describe('document text right after a run', () => {
  const l1_20 = scenarios.find((item) => item.id === 'L1-20')!;
  const content = l1_20.checks.assertions.find((item) => item.subject === 'runs.1.documents.content')!;
  const report = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'run-reports', `${name}.json`), 'utf8')) as Record<string, unknown>;

  /** A converged world asserting L1-20's checks, its dry and confirmed initial syncs run as the harness watches them. */
  async function confirmedInitialSync(duringConfirm: (linear: FakeLinear, ids: Record<string, { id: string }>) => Promise<void> = async () => {}) {
    const run = await fakeRun();
    run.ctx.scenario = { ...run.ctx.scenario, checks: l1_20.checks };
    await watchRun(run.ctx, { throughProxy: false }, async () => void run.ctx.engine.results.push(engineRun('initial-sync', report('quiet-sync'))));
    await watchRun(run.ctx, { throughProxy: false }, async () => {
      // The confirmed run writes every document as Linear keeps it: without the final newline.
      for (const document of run.linear.documents.values()) await run.linear.updateDocument(document.id, { content: (document.content ?? '').replace(/\n+$/, '') });
      await duringConfirm(run.linear, run.ids);
      run.ctx.engine.results.push(engineRun('initial-sync', report('initial-sync-to-linear')));
    });
    return run;
  }
  const holds = async (ctx: RunContext, subject: string) => compare(content.operator, (await resolveSubject(ctx, subject)).value, (await resolveSubject(ctx, String(content.expected))).value);

  it('compares the documents the confirmed run left with their golden form, though the report has no bodies', async () => {
    assert.equal(subjectSource(content.subject), 'harness');
    assert.equal(subjectSource('runs.last.linear.body'), 'harness');
    // A confirmed initial sync's report, as retained from a live run: no document bodies, by design.
    assert.equal(Object.hasOwn(report('initial-sync-to-linear'), 'documents'), false);
    const { ctx } = await confirmedInitialSync();
    assert.equal(await holds(ctx, content.subject), true);
    assert.equal(await holds(ctx, 'runs.last.documents.body'), true);
  });

  it('fails a confirmed run that wrote a wrong body, even when a later step rewrites it right', async () => {
    const { ctx, linear, ids } = await confirmedInitialSync(async (fake, known) => {
      await fake.updateDocument(known['eng/platform/plan.md']!.id, { content: '# Plan\n\nA paragraph the run garbled.' });
    });
    assert.equal(await holds(ctx, content.subject), false);
    // A later rewrite after the run's boundary: the world at the end alone would pass.
    await linear.updateDocument(ids['eng/platform/plan.md']!.id, { content: '# Plan\n\nThe first paragraph.\n\nThe second paragraph.' });
    refreshView(ctx);
    assert.equal(await holds(ctx, 'documents.content'), true);
    assert.equal(await holds(ctx, content.subject), false);
  });

  it('keeps a correct run correct when a later step breaks a document after it', async () => {
    const { ctx, linear, ids } = await confirmedInitialSync();
    await linear.updateDocument(ids['eng/platform/notes.md']!.id, { content: '# Notes\n\nChanged after the run.\n' });
    // The document is read from the snapshot, never again from Linear.
    linear.documents.delete(ids['eng/platform/plan.md']!.id);
    refreshView(ctx);
    assert.equal(await holds(ctx, 'documents.content'), false);
    assert.equal(await holds(ctx, content.subject), true);
  });

  it('refuses a run without a snapshot after it, and a run the scenario does not have', async () => {
    const { ctx } = await confirmedInitialSync();
    // A run recorded without being watched, such as one a fault paused: nothing stands in for that moment.
    ctx.engine.results.push(engineRun('sync', report('quiet-sync')));
    await assert.rejects(resolveSubject(ctx, 'runs.2.documents.content'), (error: Error) => !(error instanceof ProductError) && /engine run 2 has no snapshot of the world right after it/.test(error.message));
    await assert.rejects(resolveSubject(ctx, 'runs.last.documents.content'), /engine run 2 has no snapshot/);
    await assert.rejects(resolveSubject(ctx, 'runs.5.documents.content'), ProductError);
    // Other run subjects still come from the report.
    assert.equal(subjectSource('runs.0.documents.brokenImageUrls'), 'engine');
  });

  it('compares with the golden form of the files at the same moment, so a later git edit fails no correct run', async () => {
    assert.equal(content.expected, 'runs.1.golden.linearForm');
    const { ctx } = await confirmedInitialSync();
    await commitAsPerson(ctx, new Map([['eng/platform/notes.md', '# Notes\n\nEdited in git after the run.\n']]), 'Edit after the run');
    refreshView(ctx);
    assert.equal(await holds(ctx, content.subject), true);
    // Against the files as they are now, the same correct run would fail.
    assert.equal(compare(content.operator, (await resolveSubject(ctx, content.subject)).value, (await resolveSubject(ctx, 'golden.linearForm')).value), false);
  });

  it('keeps the run\'s own target selection when a later step picks a document', async () => {
    const { ctx, ids } = await confirmedInitialSync();
    // A later edit step records its target, as `setTarget` does.
    setTarget(ctx, 'eng/platform/notes.md', ids['eng/platform/notes.md']!.id);
    const value = (await resolveSubject(ctx, content.subject)).value;
    assert.ok(value instanceof Map && value.size > 1);
    assert.equal(await holds(ctx, content.subject), true);
    // The world now speaks of the picked document alone.
    assert.equal(typeof (await resolveSubject(ctx, 'documents.content')).value, 'string');
    assert.equal(ctx.observations.get('target.path'), 'eng/platform/notes.md');
  });

  it('snapshots only the run the scenario names, and never I6\'s extra run', async () => {
    const { ctx } = await confirmedInitialSync();
    assert.equal(ctx.observations.has('harness.runView.0'), false);
    assert.equal(ctx.observations.has('harness.runView.1'), true);
    ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
    await watchRun(ctx, { throughProxy: false }, async () => void ctx.engine.results.push(engineRun('sync', report('quiet-sync'))));
    assert.equal(ctx.observations.has('harness.runView.2'), false);
    // For `last`, each run's view replaces the one before it.
    const last = (await fakeRun()).ctx;
    last.scenario = { ...last.scenario, checks: { ...l1_20.checks, assertions: [{ subject: 'runs.last.documents.content', operator: 'same-as', expected: 'runs.last.golden.linearForm' }] } };
    for (let run = 0; run < 2; run += 1) await watchRun(last, { throughProxy: false }, async () => void last.engine.results.push(engineRun('sync', report('quiet-sync'))));
    assert.deepEqual([...last.observations.keys()].filter((key) => key.startsWith('harness.runView.')), ['harness.runView.1']);
  });

  it('snapshots nothing for a scenario that asserts on no run\'s documents', async () => {
    const { ctx } = await fakeRun();
    await watchRun(ctx, { throughProxy: false }, async () => void ctx.engine.results.push(engineRun('sync', report('quiet-sync'))));
    assert.equal(ctx.observations.has('harness.runView.0'), false);
  });
});
