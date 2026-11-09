// The sync's real workflows in the sandbox (actions mode): starting them,
// waiting for a run, and reading what it reported.
//
// The engine's report reaches the harness as the run's artifact
// `mdbisync-report`, holding `report.json` (the same report a local run
// writes to its report file) and `summary.md` (the job summary). The run's
// logs are read for the canary scan (I5).
//
// Scheduled workflows run only on the repository's default branch, and a
// run's branches never are, so a step that needs the schedule is
// env-blocked with that reason.

import { inflateRawSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandName } from '../../../src/commands.ts';
import type { EngineResult } from './engine.ts';
import { GitHubError, type SandboxRest, type WorkflowRun } from './github.ts';
import { EnvBlockedError, ProductError } from './results.ts';

export const REPORT_ARTIFACT = 'mdbisync-report';
export const RUN_WAIT_MS = 30 * 60_000;
export const RUN_APPEAR_MS = 5 * 60_000;
export const POLL_MS = 10_000;

export const SCHEDULE_BLOCKED = 'scheduled workflows run only on the default branch; a run\'s branches are not it';

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
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (run?.status === 'completed') return run;
    seen ||= run !== undefined;
    const waited = Date.now() - started;
    if (!seen && waited > (options.appearMs ?? RUN_APPEAR_MS)) throw new ProductError(`no ${options.event} run started on the run's branch`);
    if (waited > (options.timeoutMs ?? RUN_WAIT_MS)) throw new EnvBlockedError(`the ${options.event} run did not finish within ${Math.round((options.timeoutMs ?? RUN_WAIT_MS) / 60_000)} minutes (runner busy?)`);
    await sleep(poll);
  }
}

/** What a finished workflow run reported, in the shape of a local engine result. */
export async function runResult(rest: SandboxRest, run: WorkflowRun, command: CommandName): Promise<EngineResult> {
  let report: Record<string, unknown> | null = null;
  let summary = '';
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
    summary = files.get('summary.md')?.toString('utf8') ?? '';
  }
  let logs = '';
  try {
    logs = [...unzip(await rest.download(`/actions/runs/${run.id}/logs`)).values()].map((file) => file.toString('utf8')).join('\n');
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
  }
  const started = Date.parse(run.run_started_at ?? run.created_at);
  return {
    command,
    exitCode: run.conclusion === 'success' ? 0 : 1,
    signal: null,
    notImplemented: /not implemented/.test(logs) && run.conclusion !== 'success',
    timedOut: false,
    durationMs: Date.parse(run.updated_at ?? run.created_at) - started,
    stdout: logs,
    stderr: '',
    summary,
    report,
  };
}

export interface JobSpan {
  runId: number;
  started: number;
  completed: number;
}

/** When each run's jobs ran. */
export async function jobSpans(rest: SandboxRest, runs: readonly WorkflowRun[]): Promise<JobSpan[]> {
  const spans: JobSpan[] = [];
  for (const run of runs) {
    const data = await rest.request<{ jobs: Array<{ started_at: string | null; completed_at: string | null }> }>('GET', `/actions/runs/${run.id}/jobs`);
    for (const job of data.jobs) {
      if (job.started_at === null) continue;
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

/** Whether a GitHub login is a GitHub App's bot account. */
export function isAppBot(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.endsWith('[bot]');
}
