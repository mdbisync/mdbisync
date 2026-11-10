// Runs the engine's command line for a scenario (local mode): in the run's
// working clone, with the run's own branches and state-ref prefix, Linear
// behind the fault proxy and the test hooks on.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteRequests } from './request-accounting.ts';
import { COMMANDS, type CommandName } from '../../../src/commands.ts';
import { HOOKS_DIR_ENV, HOOKS_ENV } from '../../../src/test-hooks.ts';
import type { RunNames } from './isolation.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The command line under test; MDBISYNC_ENGINE overrides it (for example a built bundle). */
export function engineEntry(env: NodeJS.ProcessEnv = process.env): string {
  return env['MDBISYNC_ENGINE'] || join(REPO_ROOT, 'src/cli.ts');
}

/**
 * The engine reads each input from the environment as MDBISYNC_ followed by
 * the input's name in upper case with "-" replaced by "_"; an unset or empty
 * variable is "not given".
 */
export function inputEnv(name: string): string {
  return `MDBISYNC_${name.toUpperCase().replaceAll('-', '_')}`;
}

export interface EngineCall {
  command: CommandName;
  names: RunNames;
  /** initial-sync only. */
  direction?: string;
  confirm?: boolean;
  /** The merge grace for this call; 0 (deferred merging) when absent. */
  mergeGraceSeconds?: number;
  cwd: string;
  /** owner/name of the sandbox repository. */
  repository: string;
  hooksDir: string;
  reportFile: string;
  summaryFile: string;
  linearUrl: string;
  /** `appSlug`: the slug of the App the GitHub token is of; absent for a token of the host's own. */
  credentials: { linearClientId: string; linearClientSecret: string; githubToken: string; appSlug?: string };
  /** Test-hook settings for this call. */
  extraEnv: Record<string, string>;
  timeoutMs: number;
}

export interface EngineResult {
  /** Present for Actions runs, including failed runs with no diagnostics. */
  remote?: RemoteRequests;
  command: CommandName;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The command answered "not implemented": the feature has not landed. */
  notImplemented: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Logs, kept only for the canary scan and failure reasons. */
  stdout: string;
  stderr: string;
  summary: string;
  securityCanary?: string;
  report: Record<string, unknown> | null;
}

/** The engine's inputs for a call, as its environment. */
export function engineInputs(call: EngineCall): Record<string, string> {
  const inputs: Record<string, string> = {
    'linear-client-id': call.credentials.linearClientId,
    'linear-client-secret': call.credentials.linearClientSecret,
    'linear-api-url': call.linearUrl,
    'github-token': call.credentials.githubToken,
    repository: call.repository,
    'tracked-branch': call.names.trackedBranch,
    'sync-branch': call.names.syncBranch,
    'state-ref-prefix': call.names.refPrefix,
    'report-file': call.reportFile,
    // Most scenarios exercise deferred merging; a run's `mergeGraceSeconds` sets a positive grace.
    'merge-grace-seconds': String(call.mergeGraceSeconds ?? 0),
  };
  // The sync's commits name the App when the engine knows it, as in the workflows.
  if (call.credentials.appSlug !== undefined) inputs['app-slug'] = call.credentials.appSlug;
  if (call.command === 'initial-sync') {
    inputs.direction = call.direction ?? 'git-to-linear';
    if (call.confirm === true) inputs.confirm = 'true';
  }
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => [inputEnv(name), value]));
}

export interface RunningEngine {
  readonly child: ChildProcess;
  readonly done: Promise<EngineResult>;
  kill(): void;
}

/** A clean environment for the engine: only what it needs, never the harness's own secrets. */
export function engineEnv(call: EngineCall, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env['PATH'],
    HOME: env['HOME'],
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    [HOOKS_ENV]: '1',
    [HOOKS_DIR_ENV]: call.hooksDir,
    GITHUB_STEP_SUMMARY: call.summaryFile,
    ...call.extraEnv,
    ...engineInputs(call),
  };
}

/** The action's `post` step (it revokes a run's Linear token, also after a killed run); MDBISYNC_ENGINE_POST overrides it. */
export function postEntry(env: NodeJS.ProcessEnv = process.env): string {
  return env['MDBISYNC_ENGINE_POST'] || join(REPO_ROOT, 'src/action/post.ts');
}

export function startEngine(call: EngineCall, env: NodeJS.ProcessEnv = process.env): RunningEngine {
  const started = Date.now();
  const child = spawn(process.execPath, [engineEntry(env), call.command], {
    cwd: call.cwd,
    env: engineEnv(call, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, call.timeoutMs);
  child.on('error', (error) => {
    stderr += `could not start the engine: ${error.message}\n`;
  });
  const done = new Promise<EngineResult>((resolve) => {
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
      let report: Record<string, unknown> | null = null;
      try {
        const text = read(call.reportFile);
        report = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        report = null;
      }
      resolve({
        command: call.command,
        exitCode,
        signal,
        notImplemented: exitCode === COMMANDS[call.command].notImplementedExitCode && stderr.includes('not implemented'),
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        summary: read(call.summaryFile),
        report,
      });
    });
  });
  return { child, done, kill: () => child.kill('SIGKILL') };
}

export async function runEngine(call: EngineCall, env?: NodeJS.ProcessEnv): Promise<EngineResult> {
  return startEngine(call, env).done;
}
