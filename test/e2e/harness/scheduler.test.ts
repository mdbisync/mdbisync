// The sync template rendered as the sandbox's scheduled workflow
// (workflow-files.ts, renderScheduler), its request script run against a
// fake git, and the harness's waits for a scheduled run (workflows.ts).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { runNames } from './isolation.ts';
import { EnvBlockedError } from './results.ts';
import { SCHEDULE_TICK_ENV, scheduleTick } from './steps.ts';
import {
  ACTION_REPOSITORY, pinnedActionSha, readTemplate, renderScheduler, requestScript, runGroup, SANDBOX_RUNNER, scheduledJobName, SCHEDULER_FILE, SCHEDULER_GROUP, WORKFLOW_FILES,
} from './workflow-files.ts';
import { jobSpans, maxOverlap, REPORT_ARTIFACT, stopScheduledRun, waitForRequestTaken, waitForScheduledRun } from './workflows.ts';

const SHA = 'a'.repeat(40);
const OUT = (name: string) => `\${{ needs.request.outputs.${name} }}`;

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { name?: string; needs?: string; if?: string; concurrency?: Record<string, unknown>; permissions?: unknown; 'runs-on': unknown; steps: Step[] };
const scheduler = (actionSha?: string) =>
  parse(renderScheduler(readTemplate(WORKFLOW_FILES.sync), actionSha)) as { name: string; on: Record<string, unknown>; concurrency: Record<string, unknown>; jobs: Record<string, Job> };

describe('the scheduled sync on the sandbox\'s default branch', () => {
  it('runs on the template\'s schedule and by hand, one tick at a time', () => {
    const parsed = scheduler();
    const template = parse(readTemplate(WORKFLOW_FILES.sync)) as { on: Record<string, unknown> };
    assert.deepEqual(parsed.on, { schedule: template.on['schedule'], workflow_dispatch: null });
    assert.deepEqual(parsed.concurrency, { group: SCHEDULER_GROUP, 'cancel-in-progress': false });
    assert.equal(parsed.name, 'mdbisync (scheduled)');
    assert.equal(SCHEDULER_FILE, 'mdbisync-scheduled.yml');
  });

  it('takes a request first, then runs the template\'s job for that run only', () => {
    const parsed = scheduler(SHA);
    assert.deepEqual(Object.keys(parsed.jobs), ['request', 'sync']);
    const request = parsed.jobs['request']!;
    assert.deepEqual(request['runs-on'], SANDBOX_RUNNER);
    assert.deepEqual(request.permissions, { contents: 'write' });
    assert.equal(request.steps[0]?.run, requestScript());
    const sync = parsed.jobs['sync']!;
    assert.equal(sync.name, scheduledJobName('sync', OUT('run')));
    assert.equal(sync.needs, 'request');
    assert.equal(sync.if, "needs.request.outputs.run != ''");
    assert.deepEqual(sync.concurrency, { group: `\${{ needs.request.outputs.group || format('${SCHEDULER_GROUP}-idle-{0}', github.run_id) }}`, 'cancel-in-progress': false });
    assert.deepEqual(sync['runs-on'], SANDBOX_RUNNER);
    // The checkout is the run's tracked branch, not the default branch a schedule checks out.
    assert.equal(sync.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.['ref'], OUT('tracked-branch'));
    const actions = sync.steps.filter((step) => step.uses?.startsWith(`${ACTION_REPOSITORY}@`));
    assert.deepEqual(actions.map((step) => step.with?.['security-step']), ['stage', 'apply']);
    for (const step of actions) {
      assert.equal(step.uses, `${ACTION_REPOSITORY}@${SHA}`);
      assert.equal(step.with?.['tracked-branch'], OUT('tracked-branch'));
      assert.equal(step.with?.['sync-branch'], OUT('sync-branch'));
      assert.equal(step.with?.['state-ref-prefix'], OUT('state-ref-prefix'));
    }
    assert.ok(sync.steps.some((step) => step.with?.['name'] === REPORT_ARTIFACT));
  });

  it('is the same text for the same template and release, and another for another release', () => {
    const template = readTemplate(WORKFLOW_FILES.sync);
    assert.equal(renderScheduler(template, SHA), renderScheduler(template, SHA));
    assert.notEqual(renderScheduler(template, SHA), renderScheduler(template, 'b'.repeat(40)));
    assert.ok(renderScheduler(template).includes(`${ACTION_REPOSITORY}@${pinnedActionSha(template)}`));
  });

  it('refuses a template without a schedule', () => {
    assert.throws(() => renderScheduler('on:\n  workflow_dispatch:\nconcurrency:\n  group: mdbisync\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps: []\n'), /no schedule/);
  });
});

describe('the request script', () => {
  // A fake git: ls-remote prints REFS; a push deletes a ref, unless TAKEN names it (another tick took it) or
  // REFUSED does (a rule or the token refuses the deletion).
  const fakeGit = [
    '#!/bin/sh',
    'case "$1" in init) mkdir -p "$3"; exit 0 ;; esac',
    'case "$3" in',
    '  ls-remote) printf "%s" "$REFS" | while read -r ref; do printf "0000\\t%s\\n" "$ref"; done ;;',
    '  push) ref=${6#:}; echo "$ref" >> "$PUSHED"',
    '    case " $TAKEN " in *" $ref "*) echo "error: unable to delete \'$ref\': remote ref does not exist" >&2; exit 1 ;; esac',
    '    case " $REFUSED " in *" $ref "*) echo "remote: error: GH013: Repository rule violations found" >&2; exit 1 ;; esac ;;',
    'esac',
    '',
  ].join('\n');
  const take = (refs: string[], taken: string[] = [], refused: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'git'), fakeGit, { mode: 0o755 });
    const env = {
      PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), PUSHED: join(dir, 'pushed'),
      TOKEN: 'token', REMOTE: 'https://example.invalid/o/r', REFS: refs.map((ref) => `${ref}\n`).join(''), TAKEN: taken.join(' '), REFUSED: refused.join(' '),
    };
    const stdout = execFileSync('bash', ['-c', requestScript()], { env, encoding: 'utf8' });
    const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '');
    const outputs = Object.fromEntries(read('output').split('\n').filter(Boolean).map((line) => line.split('=') as [string, string]));
    return { stdout, outputs, pushed: read('pushed').split('\n').filter(Boolean) };
  };
  const names = runNames('a1b2c3');

  it('takes a request and writes that run\'s names, as the harness names them', () => {
    const { outputs, pushed } = take([`refs/heads/${names.trackedBranch}`, `refs/heads/${names.scheduleRequest}`, `refs/heads/${names.syncBranch}`]);
    assert.deepEqual(outputs, { run: 'a1b2c3', 'tracked-branch': names.trackedBranch, 'sync-branch': names.syncBranch, 'state-ref-prefix': names.refPrefix, group: runGroup('a1b2c3') });
    assert.deepEqual(pushed, [`refs/heads/${names.scheduleRequest}`]);
  });

  it('leaves a request another tick took, and drops one whose run is gone', () => {
    const gone = runNames('0a0a0a');
    const other = runNames('d4e5f6');
    const refs = [gone.scheduleRequest, names.trackedBranch, names.scheduleRequest, other.trackedBranch, other.scheduleRequest].map((branch) => `refs/heads/${branch}`);
    const { outputs, pushed } = take(refs, [`refs/heads/${names.scheduleRequest}`]);
    assert.equal(outputs['run'], 'd4e5f6');
    assert.deepEqual(pushed, [gone, names, other].map((run) => `refs/heads/${run.scheduleRequest}`));
  });

  it('fails the job when a deletion is refused for another reason than a taken request', () => {
    const request = `refs/heads/${names.scheduleRequest}`;
    assert.throws(() => take([`refs/heads/${names.trackedBranch}`, request], [], [request]), (error: Error & { stderr?: string }) => /GH013/.test(error.stderr ?? ''));
  });

  it('does nothing without a request', () => {
    const { stdout, outputs, pushed } = take([`refs/heads/${names.trackedBranch}`, `refs/heads/${names.scheduleRequest}-old`, 'refs/heads/t/a1b2c/schedule']);
    assert.deepEqual(outputs, {});
    assert.deepEqual(pushed, []);
    assert.match(stdout, /No request/);
  });
});

describe('waiting for a scheduled run', () => {
  it('bounds polling sleeps by the absolute soak deadline', { timeout: 2000 }, async () => {
    await assert.rejects(waitForRequestTaken({ branchExists: async () => true } as never, 't/a1b2c3/schedule', { deadlineAt: Date.now() + 20, pollMs: 60000 }), /deadline/);
    await assert.rejects(waitForScheduledRun({ workflowFileRuns: async () => [] } as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', after: Date.now(), deadlineAt: Date.now() + 20, pollMs: 60000 }), /deadline/);
  });

  it('fences a request that no scheduler took without cancelling any workflow', async () => {
    await stopScheduledRun({ deleteBranch: async () => true, workflowFileRuns: async () => assert.fail('no workflow can own an untaken request') } as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', requestBranch: 't/a1b2c3/schedule', after: Date.now() });
  });

  it('cancels only the current owned scheduled job and waits for its completion', async () => {
    const cancelled: number[] = [];
    let polls = 0;
    const rest = {
      deleteBranch: async () => false,
      workflowFileRuns: async (_file: string, event: string) => {
        if (event !== 'schedule') return [];
        polls++;
        return [
          { id: 1, status: 'completed', created_at: new Date().toISOString() },
          { id: 2, status: 'in_progress', created_at: new Date().toISOString() },
          { id: 3, status: polls > 1 ? 'completed' : 'in_progress', created_at: new Date().toISOString() },
        ];
      },
      runJobs: async (id: number) => [{ name: id === 2 ? 'sync ffffff' : 'sync a1b2c3' }],
      request: async (method: string, path: string) => { assert.equal(method, 'POST'); assert.equal(path, '/actions/runs/3/cancel'); cancelled.push(3); },
    };
    await stopScheduledRun(rest as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', requestBranch: 't/a1b2c3/schedule', after: Date.now() - 1000, exclude: new Set([1]), pollMs: 1 });
    assert.deepEqual(cancelled, [3]);
    assert.equal(polls, 2);
  });

  it('keeps an unconfirmed scheduled writer blocked for verified recovery', async () => {
    await assert.rejects(stopScheduledRun({ deleteBranch: async () => false, workflowFileRuns: async () => [] } as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', requestBranch: 't/a1b2c3/schedule', after: Date.now(), timeoutMs: 0 }), /reservation must remain held/);
  });
  it('waits until the request is taken, and blocks when no tick takes it', async () => {
    let polls = 0;
    await waitForRequestTaken({ branchExists: async () => (polls += 1) < 3 } as never, 't/a1b2c3/schedule', { pollMs: 1 });
    assert.equal(polls, 3);
    await assert.rejects(waitForRequestTaken({ branchExists: async () => true } as never, 't/a1b2c3/schedule', { timeoutMs: 0, pollMs: 1 }), EnvBlockedError);
  });

  it('returns the completed scheduled run that ran a job for the run', async () => {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    let polls = 0;
    const jobsRead: number[] = [];
    const rest = {
      workflowFileRuns: async (file: string, event: string) => {
        assert.equal(file, SCHEDULER_FILE);
        if (event === 'workflow_dispatch') return [];
        polls += 1;
        return [
          // A tick created before the request, which waited for the runner and then took it.
          { id: 4, status: polls > 1 ? 'completed' : 'in_progress', conclusion: null, event: 'schedule', created_at: at(-120_000), updated_at: at(polls > 1 ? 3000 : 0) },
          { id: 3, status: 'in_progress', conclusion: null, event: 'schedule', created_at: at(1000), updated_at: at(1000) },
          { id: 1, status: 'completed', conclusion: 'success', event: 'schedule', created_at: at(-60_000), updated_at: at(-50_000) },
        ];
      },
      runJobs: async (id: number) => {
        jobsRead.push(id);
        // Tick 4's job for the run is listed only from the second poll on, after its request job finished.
        if (id === 4) return [{ name: 'request', completed_at: at(0) }, ...(polls > 1 ? [{ name: 'sync a1b2c3', completed_at: null }] : [])];
        return [{ name: 'request', completed_at: at(1500) }, { name: 'sync d4e5f6', completed_at: null }];
      },
    };
    const run = await waitForScheduledRun(rest as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', after: now, pollMs: 1 });
    assert.equal(run.id, 4);
    // A run that finished before the request is never read; a tick that took another run's request is read once.
    assert.deepEqual(jobsRead, [4, 3, 4]);
    await assert.rejects(waitForScheduledRun(rest as never, { workflow: SCHEDULER_FILE, runId: 'ffffff', after: now, timeoutMs: 0, pollMs: 1 }), EnvBlockedError);
  });

  it('finds the run that took the request, a tick by hand or GitHub\'s, under its own event', async () => {
    for (const taker of ['workflow_dispatch', 'schedule']) {
      const rest = {
        workflowFileRuns: async (_file: string, event: string) => [
          { id: event === 'schedule' ? 1 : 2, status: 'completed', conclusion: 'success', event, created_at: new Date().toISOString() },
        ],
        runJobs: async (id: number) => (id === (taker === 'schedule' ? 1 : 2) ? [{ name: 'request' }, { name: 'sync a1b2c3' }] : [{ name: 'request' }]),
      };
      const run = await waitForScheduledRun(rest as never, { workflow: SCHEDULER_FILE, runId: 'a1b2c3', after: 0, pollMs: 1 });
      assert.equal(run.event, taker);
    }
  });

  it('starts a tick by hand again while the request waits', async () => {
    let ticks = 0;
    let polls = 0;
    await waitForRequestTaken({ branchExists: async () => (polls += 1) < 4 } as never, 't/a1b2c3/schedule', { tick: async () => { ticks += 1; }, retickMs: 0, pollMs: 1 });
    assert.equal(ticks, 4);
    await assert.rejects(waitForRequestTaken({ branchExists: async () => true } as never, 't/a1b2c3/schedule', { tick: async () => {}, timeoutMs: 0, pollMs: 1 }), /no tick started by hand took it/);
  });

  it('starts a tick by hand only when asked', () => {
    assert.equal(scheduleTick({}), 'schedule');
    assert.equal(scheduleTick({ [SCHEDULE_TICK_ENV]: '' }), 'schedule');
    assert.equal(scheduleTick({ [SCHEDULE_TICK_ENV]: 'dispatch' }), 'workflow_dispatch');
    assert.throws(() => scheduleTick({ [SCHEDULE_TICK_ENV]: 'schedule' }), /must be empty or "dispatch"/);
  });
});

describe('the jobs that hold a run\'s group', () => {
  it('leave out the scheduled workflow\'s request job, however the tick started', async () => {
    const time = (seconds: number) => new Date(seconds * 1000).toISOString();
    const rest = {
      runJobs: async (id: number) => (id === 1
        ? [{ name: 'request', started_at: time(0), completed_at: time(10) }, { name: 'sync a1b2c3', started_at: time(21), completed_at: time(30) }]
        : [{ name: 'sync', started_at: time(6), completed_at: time(20) }]),
    };
    for (const event of ['schedule', 'workflow_dispatch']) {
      const spans = await jobSpans(rest as never, [{ id: 1, event, path: `.github/workflows/${SCHEDULER_FILE}@refs/heads/main` }, { id: 2, event: 'workflow_dispatch', path: '.github/workflows/mdbisync.yml@refs/heads/t/a1b2c3/main' }] as never);
      assert.equal(maxOverlap(spans), 1, event);
    }
  });
});
