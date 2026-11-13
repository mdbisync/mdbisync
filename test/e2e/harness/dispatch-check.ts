// The own-scheduler dispatch check: runs the dispatch script of
// docs/own-scheduler.md, as published, against the sandbox, once with a token
// that may start workflows and once with one that may not, and records what a
// reader would see: the script's exit code and message, the HTTP status and
// the run that appeared.
//
// The tokens are installation tokens of the harness's own GitHub App, minted
// for this check with only `actions: write`, or with only `actions: read` and
// `contents: read`, and revoked at its end. The script reads its token where
// the page says, `dispatch-token` in $CREDENTIALS_DIRECTORY, through a pipe:
// the token is never written to disk, on a command line, printed or logged.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestConfig } from './config.ts';
import { REPO_ROOT } from './engine.ts';
import { appInstallationToken, GitHubError, revokeInstallationToken, SandboxRest, type TokenPermissions, type WorkflowRun } from './github.ts';
import { githubRequestToken } from './github-request.ts';
import { newRunId } from './isolation.ts';
import { acquireLock, LockTimeoutError, type Lock } from './locks.ts';
import { EnvBlockedError } from './results.ts';
import { WORKFLOW_FILES } from './workflow-files.ts';

/** The page that documents the script, relative to the repository root. */
export const SCRIPT_PAGE = 'docs/own-scheduler.md';
const SCRIPT_HEADING = '## A dispatch script';
const PLACEHOLDER = '<owner>/<repository>';
/** The script's one message, for a status it did not take as success. */
const FAILURE = /^mdbisync dispatch failed: HTTP (\d{3})$/;
/** The page's promise: a dispatched run appears within a minute. */
export const APPEAR_WITHIN_MS = 60_000;
/** How long the check keeps looking, so a late run is still recorded. */
const LOOK_FOR_MS = 120_000;
const POLL_MS = 3_000;
/** The script's own curl stops after 30 seconds; this bounds the rest. */
const SCRIPT_TIMEOUT_MS = 60_000;
const PASSED_ENV = ['PATH', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE'];

/** The first `sh` block under the page's "A dispatch script" heading, as published. */
export function documentedScript(page: string): string {
  const start = page.split('\n').indexOf(SCRIPT_HEADING);
  if (start === -1) throw new Error(`${SCRIPT_PAGE} has no "${SCRIPT_HEADING.slice(3)}" section`);
  const block = /^```sh\n([\s\S]*?)^```$/m.exec(page.split('\n').slice(start).join('\n'));
  const script = block?.[1];
  if (script === undefined || !script.startsWith('#!/bin/sh\n')) throw new Error(`${SCRIPT_PAGE}'s dispatch script is not the first sh block of its section`);
  return script;
}

/** The script with the one edit the page asks of a reader: the repository in place of `<owner>/<repository>`. */
export function scriptFor(script: string, owner: string, repo: string): string {
  if (script.split(PLACEHOLDER).length !== 2) throw new Error(`the dispatch script does not name ${PLACEHOLDER} exactly once`);
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error('the sandbox owner or repository name is not plain');
  return script.replace(PLACEHOLDER, `${owner}/${repo}`);
}

export interface ScriptRun {
  exitCode: number | null;
  /** `2xx` when the script took the answer as success (it prints no status then), else the status it names. */
  httpStatus: string | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the script, `SIGTERM` when it ran past its time limit. */
  signal: string | null;
}

/** The descriptor the script inherits the token on; its `dispatch-token` file is a link to it. */
const TOKEN_FD = 3;

/**
 * Runs `script` as a scheduler would, in a private folder removed afterwards,
 * with $CREDENTIALS_DIRECTORY naming a folder that holds `dispatch-token`, as
 * systemd's LoadCredential= gives it. That file is a link to a pipe the script
 * inherits, so the script reads the token (ending in a newline, as a pasted
 * token does) from the path the page names while the token never touches the
 * disk. HOME is the private folder, so neither the operator's curl settings
 * nor their own token file is read. Output is masked for the token.
 */
export async function runScript(script: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<ScriptRun> {
  githubRequestToken(token);
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-check-'));
  try {
    chmodSync(dir, 0o700);
    const credentials = join(dir, 'credentials');
    mkdirSync(credentials, { mode: 0o700 });
    symlinkSync(`/dev/fd/${TOKEN_FD}`, join(credentials, 'dispatch-token'));
    const path = join(dir, 'mdbisync-dispatch');
    writeFileSync(path, script, { mode: 0o700 });
    // What curl may need to reach GitHub from this host: proxies and the CA bundle.
    const passed = Object.fromEntries(PASSED_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name] as string]])));
    // The script runs through its own interpreter, so a temporary folder mounted noexec does not stop it.
    // Node's pipes to a child are sockets, which /dev/fd cannot open again, so `cat` copies the
    // token from this process into a pipe that the script's shell holds as its token descriptor.
    const child = spawn('/bin/sh', ['-c', `cat | exec /bin/sh "$1" ${TOKEN_FD}<&0 </dev/null`, 'sh', path], {
      cwd: dir, env: { ...passed, HOME: dir, CREDENTIALS_DIRECTORY: credentials }, stdio: ['pipe', 'pipe', 'pipe'], timeout: SCRIPT_TIMEOUT_MS,
    });
    // A script that stops before it reads the token closes the pipe; that is its result to report, not an error here.
    child.stdin.on('error', () => {});
    child.stdin.end(`${token}\n`);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, ended) => resolve([code, ended]));
    });
    const masked = (text: string) => text.split(token).join('[masked]').slice(0, 4096);
    const named = FAILURE.exec(stderr.trimEnd().split('\n').at(-1) ?? '')?.[1];
    return { exitCode, httpStatus: exitCode === 0 ? '2xx' : named ?? null, stdout: masked(stdout), stderr: masked(stderr), signal };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FoundRun {
  id: number;
  url: string | null;
  createdAt: string;
  /** From the end of the allowed case's script to the first listing that showed the run. */
  appearedAfterMs: number;
  /** What the check did with it: `cancelled`, `already finished`, `kept` with --keep-run, or why the cancel failed. */
  after: string;
}

export interface DispatchCheckReport {
  page: string;
  /** SHA-256 of the script block as the page publishes it, before the repository is filled in. */
  scriptSha256: string;
  workflow: string;
  ref: 'main';
  denied: ScriptRun & { permissions: TokenPermissions; ok: boolean };
  allowed: ScriptRun & { permissions: TokenPermissions; ok: boolean };
  /** The App's new runs of the workflow on main after the check began, oldest first: the allowed case's one alone when all went as the page says. */
  runs: FoundRun[];
  /** What went wrong after the first dispatch; the record is still printed. */
  errors: string[];
  /** Whether both minted tokens were revoked; an unrevoked one expires within an hour. */
  tokensRevoked: boolean;
  ok: boolean;
}

export interface DispatchCheckDeps {
  config: Pick<TestConfig, 'owner' | 'repo' | 'githubApp' | 'githubAppMissing' | 'sandboxUrl'>;
  /** The harness state folder that holds the check's lock: one check at a time on this host. */
  stateDir: string;
  fetch?: typeof fetch;
  /** The environment the script runs with: its PATH finds curl. */
  env?: NodeJS.ProcessEnv;
  keepRun?: boolean;
  log?: (line: string) => void;
  /** For tests: shorter waits. */
  timing?: { lookForMs?: number; pollMs?: number };
}

/** Reads the workflow's state, its runs and its file on main; cannot start it. */
const DENIED: TokenPermissions = { actions: 'read', contents: 'read' };
const ALLOWED: TokenPermissions = { actions: 'write' };

/** The App's new runs of `mdbisync.yml` on `main` since `before`, oldest first. */
async function newRuns(rest: SandboxRest, before: ReadonlySet<number>, appLogin: string): Promise<WorkflowRun[]> {
  return (await rest.workflowFileRuns(WORKFLOW_FILES.sync, 'workflow_dispatch'))
    .filter((run) => !before.has(run.id) && run.head_branch === 'main' && run.actor?.login === appLogin)
    .sort((a, b) => a.id - b.id);
}

/** Whether GitHub may have taken the dispatch: the script took it as success, or it did not hear a 4xx answer. */
const mayHaveStarted = (run: ScriptRun) => run.exitCode === 0 || !/^4\d\d$/.test(run.httpStatus ?? '');

/**
 * Runs the check. Before the first dispatch, a missing setting or a sandbox
 * that cannot take it throws EnvBlockedError and nothing is dispatched.
 * After it, every error goes into the record, and every new run of the
 * workflow on main by the App is cancelled (unless keepRun): the lock keeps
 * other checks on this host out, and nothing else in the harness dispatches
 * that workflow on main.
 */
export async function dispatchCheck(deps: DispatchCheckDeps): Promise<DispatchCheckReport> {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const lookForMs = deps.timing?.lookForMs ?? LOOK_FOR_MS;
  const pollMs = deps.timing?.pollMs ?? POLL_MS;
  if (config.sandboxUrl === '' || config.owner === '') throw new EnvBlockedError('test configuration is missing: MDBISYNC_TEST_SANDBOX_URL');
  if (config.githubApp === null) throw new EnvBlockedError(`the dispatch check needs the GitHub App: ${config.githubAppMissing.join(' and ')} not in the test secrets`);

  const published = documentedScript(readFileSync(join(REPO_ROOT, SCRIPT_PAGE), 'utf8'));
  const script = scriptFor(published, config.owner, config.repo);
  let lock: Lock;
  try { lock = await acquireLock('dispatch-check', { stateDir: deps.stateDir, runId: newRunId(), timeoutMs: 0 }); }
  catch (error) {
    if (error instanceof LockTimeoutError) throw new EnvBlockedError(`another dispatch check is running on this host (${error.message})`);
    throw error;
  }
  const minted: string[] = [];
  const mint = async (permissions: TokenPermissions) => {
    const token = await appInstallationToken(config, fetchImpl, permissions);
    minted.push(token.token);
    return token;
  };
  try {
    // Before the first dispatch, any failure (the App not installed, a bad key, an API error) means the check could not run.
    const setup = async () => {
      const denied = await mint(DENIED);
      const allowed = await mint(ALLOWED);
      const reader = new SandboxRest(config, denied.token, fetchImpl);
      const state = await reader.workflowState(WORKFLOW_FILES.sync);
      if (state !== 'active') throw new EnvBlockedError(`the sandbox's ${WORKFLOW_FILES.sync} is ${state === undefined ? 'not registered' : state}; nothing was dispatched`);
      // The registry also lists a workflow that only a run branch carries; the script dispatches main's.
      if (!await reader.workflowExists(WORKFLOW_FILES.sync, 'main')) throw new EnvBlockedError(`the sandbox's main has no .github/workflows/${WORKFLOW_FILES.sync}; nothing was dispatched`);
      const before = new Set((await reader.workflowFileRuns(WORKFLOW_FILES.sync, 'workflow_dispatch')).map((run) => run.id));
      return { denied, allowed, reader, before };
    };
    const { denied, allowed, reader, before } = await setup().catch((error: unknown) => {
      if (error instanceof EnvBlockedError) throw error;
      throw new EnvBlockedError(`before any dispatch: ${error instanceof Error ? error.message : String(error)}; nothing was dispatched`);
    });

    const errors: string[] = [];
    const record = (what: string, error: unknown) => {
      errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    };
    log('dispatch with a token without Actions write');
    const deniedRun = await runScript(script, denied.token, deps.env);
    log('dispatch with a token with Actions write');
    const allowedRun = await runScript(script, allowed.token, deps.env);
    const dispatchedAt = Date.now();

    // Look for the runs either case may have started: until as many have
    // appeared as dispatches GitHub took, and for the whole window when one
    // may have been taken without the script hearing it.
    const certain = [deniedRun, allowedRun].filter((run) => run.exitCode === 0).length;
    const uncertain = [deniedRun, allowedRun].some((run) => run.exitCode !== 0 && mayHaveStarted(run));
    const writer = new SandboxRest(config, allowed.token, fetchImpl);
    // Each run is cancelled as soon as it is seen, while the check goes on looking for others.
    const settle = async (run: WorkflowRun): Promise<string> => {
      if (deps.keepRun === true) return 'kept';
      try {
        await writer.request('POST', `/actions/runs/${run.id}/cancel`);
        return 'cancelled';
      } catch (error) {
        // GitHub answers 409 for a run that already finished.
        if (error instanceof GitHubError && error.status === 409) return 'already finished';
        record(`cancelling run ${run.id}`, error);
        return `not cancelled: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    const runs: FoundRun[] = [];
    if (certain > 0 || uncertain) {
      for (;;) {
        try {
          for (const run of await newRuns(reader, before, allowed.appLogin)) {
            if (runs.some((found) => found.id === run.id)) continue;
            const appearedAfterMs = Date.now() - dispatchedAt;
            runs.push({ id: run.id, url: run.html_url ?? null, createdAt: run.created_at, appearedAfterMs, after: await settle(run) });
          }
        } catch (error) { record('listing runs', error); }
        if ((!uncertain && runs.length >= certain) || Date.now() - dispatchedAt >= lookForMs) break;
        await sleep(pollMs);
      }
    }
    runs.sort((a, b) => a.id - b.id);

    const deniedOk = deniedRun.exitCode === 1 && deniedRun.httpStatus === '403' && deniedRun.stdout === ''
      && deniedRun.stderr === 'mdbisync dispatch failed: HTTP 403\n';
    // The allowed case's run is the only new one, and it appeared within the page's minute.
    const allowedOk = allowedRun.exitCode === 0 && allowedRun.stdout === '' && allowedRun.stderr === ''
      && runs.length === 1 && (runs[0] as FoundRun).appearedAfterMs <= APPEAR_WITHIN_MS;
    return {
      page: SCRIPT_PAGE,
      scriptSha256: createHash('sha256').update(published).digest('hex'),
      workflow: WORKFLOW_FILES.sync,
      ref: 'main',
      denied: { ...deniedRun, permissions: DENIED, ok: deniedOk },
      allowed: { ...allowedRun, permissions: ALLOWED, ok: allowedOk },
      runs,
      errors,
      tokensRevoked: await revoke(minted, fetchImpl, log),
      ok: deniedOk && allowedOk && errors.length === 0,
    };
  } finally {
    // A token revoked already (on the way out of the try) is not in the list any more.
    await revoke(minted, fetchImpl, log);
    lock.release();
  }
}

/** Revokes and forgets every token in `minted`; true when all were revoked. */
async function revoke(minted: string[], fetchImpl: typeof fetch, log: (line: string) => void): Promise<boolean> {
  let all = true;
  for (const token of minted.splice(0)) {
    try { await revokeInstallationToken(token, fetchImpl); }
    catch { all = false; log('warning: a dispatch check token was not revoked; it expires within an hour'); }
  }
  return all;
}
