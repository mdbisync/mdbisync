// The sync's real workflows in the sandbox (actions mode): starting them,
// waiting for a run, and reading what it reported.
//
// The engine's report reaches the harness as the run's artifact
// `mdbisync-report`, holding `report.json` (the same report a local run
// writes to its report file) and `summary.md` (the job summary). The run's
// logs are read for the canary scan (I5).
//
// Scheduled workflows run only on the repository's default branch, and a
// run's branches never are. A run asks the sandbox's scheduled workflow
// (workflow-files.ts, renderScheduler) for a scheduled sync with its request
// branch; the scheduled run that takes the request runs the sync for the
// run's branches as a job named for the run.
//
// A failed run is an environment blocker only when it is proven: its first
// failed step installs a tool the runner must provide, and that step's own
// log shows the shell could not find a command (exit 127) or one of the
// errors the template's step reports for a missing prerequisite. The
// scenario then stops at that run. Any other failure stays the run's result
// for the scenario's checks.

import { engineSteps, REQUEST_JOB, SCHEDULER_FILE, WORKFLOW_FILES } from './workflow-files.ts';
import { diagnosticRequests } from './request-accounting.ts';
import { CANARY_EVIDENCE } from './security-canary.ts';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { notImplementedMessage, type CommandName } from '../../../src/commands.ts';
import type { EngineResult } from './engine.ts';
import { GitHubError, type SandboxRest, type WorkflowJob, type WorkflowRun } from './github.ts';
import { EnvBlockedError, ProductError } from './results.ts';

export const REPORT_ARTIFACT = 'mdbisync-report';
export const RUN_WAIT_MS = 30 * 60_000;
export const RUN_APPEAR_MS = 5 * 60_000;
export const POLL_MS = 10_000;

/** How long a run's request may wait for a scheduled run to take it: GitHub starts schedules late, and may skip a tick. */
export const SCHEDULE_TAKE_MS = 60 * 60_000;
/** How often a tick by hand is started again while the request waits: a newer pending tick cancels an older one, and a tick serves one request. */
export const RETICK_MS = 5 * 60_000;

/** Files of a zip archive (stored or deflated entries), by name. */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 65_557); at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = archive.readUInt16LE(end + 10);
  let entry = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = archive.readUInt16LE(entry + 10);
    const compressed = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const local = archive.readUInt32LE(entry + 42);
    const name = archive.subarray(entry + 46, entry + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + compressed);
    if (!name.endsWith('/')) files.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : Buffer.alloc(0));
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export interface WaitOptions {
  branch: string;
  event: string;
  /** Only runs created at or after this time. */
  after: number;
  /** Runs already accounted for. */
  exclude?: ReadonlySet<number>;
  /** Only the run for this commit (a push run). */
  headSha?: string;
  /** Only runs of this `.github/workflows/` file: another workflow can run on the same push. */
  workflow?: string;
  timeoutMs?: number;
  appearMs?: number;
  pollMs?: number;
}

/** The newest run of `event` on `branch` created after `after`, once it has completed. */
export async function waitForRun(rest: SandboxRest, options: WaitOptions): Promise<WorkflowRun> {
  const started = Date.now();
  const poll = options.pollMs ?? POLL_MS;
  let seen = false;
  for (;;) {
    // The first run of that event since `after` (a little clock skew allowed).
    const run = (await rest.workflowRuns(options.branch))
      .filter((candidate) => candidate.event === options.event && Date.parse(candidate.created_at) >= options.after - 5_000 && !(options.exclude?.has(candidate.id) ?? false))
      .filter((candidate) => options.headSha === undefined || candidate.head_sha === options.headSha)
      .filter((candidate) => options.workflow === undefined || candidate.path?.split('@')[0] === `.github/workflows/${options.workflow}`)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (run?.status === 'completed') return run;
    seen ||= run !== undefined;
    const waited = Date.now() - started;
    if (!seen && waited > (options.appearMs ?? RUN_APPEAR_MS)) throw new ProductError(`no ${options.event} run started on the run's branch`);
    if (waited > (options.timeoutMs ?? RUN_WAIT_MS)) throw new EnvBlockedError(`the ${options.event} run did not finish within ${Math.round((options.timeoutMs ?? RUN_WAIT_MS) / 60_000)} minutes (runner busy?)`);
    await sleep(poll);
  }
}

/**
 * Waits until a scheduled run takes the run's request (its branch is gone).
 * `tick`, when given, starts a tick by hand now and again every `retickMs`
 * while the request waits. A request no tick took within `timeoutMs` blocks
 * the run.
 */
export async function waitForRequestTaken(rest: SandboxRest, branch: string, options: { tick?: () => Promise<void>; retickMs?: number; timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? SCHEDULE_TAKE_MS;
  let ticked = -Infinity;
  for (;;) {
    if (options.tick !== undefined && Date.now() - ticked >= (options.retickMs ?? RETICK_MS)) {
      ticked = Date.now();
      await options.tick();
    }
    if (!(await rest.branchExists(branch))) return;
    if (Date.now() - started > timeoutMs) {
      const cause = options.tick === undefined ? 'GitHub started no tick of the schedule, or the runner was busy' : 'no tick started by hand took it: the runner was busy, or other requests went first';
      throw new EnvBlockedError(`no scheduled run took the run's request within ${Math.round(timeoutMs / 60_000)} minutes (${cause})`);
    }
    await sleep(options.pollMs ?? POLL_MS);
  }
}

/**
 * The run of the scheduled workflow `workflow`, a scheduled tick or one by
 * hand, that ran a job for run `runId` (a job
 * named `<job> <runId>`), once it has completed. Call it once the request
 * is taken: that run exists by then. The tick that took it may have been
 * created before the request (it waited for the runner or for the tick
 * before it), so only runs that finished before `after` are left out.
 */
export async function waitForScheduledRun(rest: SandboxRest, options: { workflow: string; runId: string; after: number; exclude?: ReadonlySet<number>; timeoutMs?: number; pollMs?: number }): Promise<WorkflowRun> {
  const started = Date.now();
  // Runs that served another run, or none: they never become this run's.
  const others = new Set<number>(options.exclude ?? []);
  for (;;) {
    // GitHub's tick or one by hand, whichever took the request; the run keeps its true event.
    const runs = [...(await rest.workflowFileRuns(options.workflow, 'schedule')), ...(await rest.workflowFileRuns(options.workflow, 'workflow_dispatch'))];
    const candidates = runs
      .filter((run) => !others.has(run.id) && (run.status !== 'completed' || Date.parse(run.updated_at ?? run.created_at) >= options.after - 5_000))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const run of candidates) {
      const jobs = await rest.runJobs(run.id);
      const ours = jobs.some((job) => job.name.endsWith(` ${options.runId}`));
      if (ours && run.status === 'completed') return run;
      // A tick serves another run once a job named for that run shows. A finished request job proves nothing:
      // the job that depends on it may not be listed yet.
      const another = jobs.some((job) => job.name !== REQUEST_JOB && /\s[0-9a-f]{6}$/.test(job.name));
      if (!ours && (run.status === 'completed' || another)) others.add(run.id);
    }
    const waited = Date.now() - started;
    if (waited > (options.timeoutMs ?? RUN_WAIT_MS)) throw new EnvBlockedError(`the scheduled run that took the run's request did not finish within ${Math.round((options.timeoutMs ?? RUN_WAIT_MS) / 60_000)} minutes (runner busy?)`);
    await sleep(options.pollMs ?? POLL_MS);
  }
}

/** Waits until a `.github/workflows/` file is in the repository's Actions registry and returns its id. */
export async function waitForRegistration(rest: SandboxRest, file: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<number> {
  const started = Date.now();
  for (;;) {
    const id = await rest.workflowId(file);
    if (id !== undefined) return id;
    if (Date.now() - started > (options.timeoutMs ?? RUN_APPEAR_MS)) {
      // Not an environment block: the registering push run should have registered it.
      throw new Error(`${file} is not in the repository's Actions registry after its push to the run's branch; a dispatch would answer 404`);
    }
    await sleep(options.pollMs ?? POLL_MS);
  }
}

/** A run's log files by name (`<job>/<number>_<step>.txt`), or none when GitHub has no logs for it. */
export async function runLogs(rest: SandboxRest, run: WorkflowRun): Promise<Map<string, string>> {
  try {
    return new Map([...unzip(await rest.download(`/actions/runs/${run.id}/logs`))].map(([name, file]) => [name, file.toString('utf8')]));
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return new Map();
  }
}

/** Template steps that install a tool the runner must provide before the engine starts. */
export const PREREQUISITE_STEPS: ReadonlySet<string> = new Set(['Install pre-commit', 'Install compatible npm']);

export interface RunBlocker {
  runId: number;
  job: string;
  step: string;
  /** What the runner lacked: the missing command, or the step's own prerequisite error. */
  cause: string;
  /** The step's log file in the run's logs. */
  logFile: string;
  reason: string;
}

/**
 * A failed run's proven environment blocker, or undefined. Proven means: the
 * run's first failed step is a prerequisite step, and its own log shows a
 * command that was not found with exit code 127, or one of `knownErrors`
 * (the template's prerequisite errors, as log lines). A failure anywhere
 * else, or without that log, is not proven.
 */
export function environmentBlocker(run: WorkflowRun, jobs: readonly WorkflowJob[], logs: ReadonlyMap<string, string>, knownErrors: readonly string[] = []): RunBlocker | undefined {
  if (run.conclusion !== 'failure') return undefined;
  for (const job of jobs) {
    const failed = [...(job.steps ?? [])].sort((a, b) => a.number - b.number).find((step) => step.conclusion === 'failure');
    if (failed === undefined) continue;
    if (!PREREQUISITE_STEPS.has(failed.name)) return undefined;
    const logFile = `${job.name}/${failed.number}_${failed.name}.txt`;
    const log = logs.get(logFile);
    if (log === undefined) return undefined;
    const missing = /##\[error\]Process completed with exit code 127\./.test(log) ? /: ([\w.+-]+): command not found\s*$/m.exec(log)?.[1] : undefined;
    const cause = missing === undefined ? knownErrors.find((error) => log.includes(error))?.replace('##[error]', '') : `${missing}: command not found (exit 127)`;
    if (cause === undefined) return undefined;
    return {
      runId: run.id,
      job: job.name,
      step: failed.name,
      cause,
      logFile,
      reason: `the sandbox runner cannot run "${failed.name}": ${cause} (${run.event} run ${run.id})`,
    };
  }
  return undefined;
}

/** A step's log file in a run's logs, `<job>/<number>_<step>.txt`, without the characters GitHub may drop from a file name. */
function stepOfLogFile(file: string): string | undefined {
  const step = /\/\d+_([^/]+)\.txt$/.exec(file)?.[1];
  return step === undefined ? undefined : comparable(step);
}

function comparable(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '');
}

/**
 * Whether a run's engine answered "not implemented" for `command`: a step
 * that runs the engine (engineSteps) logged the engine's own line,
 * `<command>: not implemented`, which the action reports as the step's
 * failure. Any other text is not that answer: an older release's post step
 * prints "post: not implemented, nothing to clean up" on every failed run,
 * and a run on a release that rejects the template's inputs fails before the
 * engine starts.
 */
export function engineNotImplemented(files: ReadonlyMap<string, string>, command: CommandName): boolean {
  const steps = new Set([...engineSteps()].map(comparable));
  const line = notImplementedMessage(command);
  for (const [file, log] of files) {
    const step = stepOfLogFile(file);
    if (step === undefined || !steps.has(step)) continue;
    // Each log line starts with its timestamp; the action's failure carries GitHub's error marker.
    for (const entry of log.split(/\r?\n/)) {
      if (entry.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '').replace(/^##\[error\]/, '').trimEnd() === line) return true;
    }
  }
  return false;
}

/** What a finished workflow run reported, in the shape of a local engine result. */
export async function runResult(rest: SandboxRest, run: WorkflowRun, command: CommandName, logFiles?: ReadonlyMap<string, string>): Promise<EngineResult> {
  let report: Record<string, unknown> | null = null;
  let summary = '';
  let securityCanary = '';
  const artifacts = await rest.request<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>('GET', `/actions/runs/${run.id}/artifacts`);
  const artifact = artifacts.artifacts.find((candidate) => candidate.name === REPORT_ARTIFACT && !candidate.expired);
  if (artifact !== undefined) {
    const files = unzip(await rest.download(`/actions/artifacts/${artifact.id}/zip`));
    const json = files.get('report.json');
    if (json !== undefined) {
      try {
        report = JSON.parse(json.toString('utf8')) as Record<string, unknown>;
      } catch {
        report = null;
      }
    }
    securityCanary = files.get(CANARY_EVIDENCE)?.toString('utf8') ?? '';
    summary = files.get('summary.md')?.toString('utf8') ?? '';
  }
  const files = logFiles ?? await runLogs(rest, run);
  const logs = [...files.values()].join('\n');
  const started = Date.parse(run.run_started_at ?? run.created_at);
  return {
    command,
    remote: {
      runId: run.id, runAttempt: run.run_attempt ?? 1,
      linearEngine: run.path?.split('@')[0] !== `.github/workflows/${WORKFLOW_FILES['pre-commit']}`,
      requests: diagnosticRequests(files),
    },
    exitCode: run.conclusion === 'success' ? 0 : 1,
    signal: null,
    notImplemented: run.conclusion !== 'success' && engineNotImplemented(files, command),
    timedOut: false,
    durationMs: Date.parse(run.updated_at ?? run.created_at) - started,
    stdout: logs,
    stderr: '',
    summary,
    securityCanary,
    report,
  };
}

export interface JobSpan {
  runId: number;
  started: number;
  completed: number;
}

/** When each run's jobs ran; the scheduled workflow's request job holds no run's group, so it is left out. */
export async function jobSpans(rest: SandboxRest, runs: readonly WorkflowRun[]): Promise<JobSpan[]> {
  const spans: JobSpan[] = [];
  for (const run of runs) {
    for (const job of await rest.runJobs(run.id)) {
      if (job.started_at === null || (run.path?.split('@')[0] === `.github/workflows/${SCHEDULER_FILE}` && job.name === REQUEST_JOB)) continue;
      spans.push({ runId: run.id, started: Date.parse(job.started_at), completed: job.completed_at === null ? Date.now() : Date.parse(job.completed_at) });
    }
  }
  return spans;
}

/** The most jobs running at the same moment. */
export function maxOverlap(spans: readonly JobSpan[]): number {
  const events = spans.flatMap((span) => [{ at: span.started, delta: 1 }, { at: span.completed, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.delta;
    max = Math.max(max, active);
  }
  return max;
}

/**
 * Whether the runs set up a replacement: when some run arrived, another run's
 * job was running and a third run was already waiting (created, its job not
 * started). Only then can a concurrency group replace a pending run. Runs
 * that arrive one after another, each waiting alone, never give it the chance.
 */
export function hadReplaceableRun(runs: readonly Pick<WorkflowRun, 'id' | 'created_at'>[], spans: readonly JobSpan[]): boolean {
  const firstStart = (id: number) => Math.min(...spans.filter((span) => span.runId === id).map((span) => span.started));
  return runs.some((arriving) => {
    const at = Date.parse(arriving.created_at);
    const active = spans.some((span) => span.runId !== arriving.id && span.started <= at && span.completed > at);
    const waiting = runs.some((other) => other.id !== arriving.id && Date.parse(other.created_at) <= at && firstStart(other.id) > at);
    return active && waiting;
  });
}

/** Whether a GitHub login is a GitHub App's bot account. */
export function isAppBot(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.endsWith('[bot]');
}
