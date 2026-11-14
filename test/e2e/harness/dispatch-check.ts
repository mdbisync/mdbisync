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
//
// The script dispatches `mdbisync.yml` on `main`. With `withWorkflow`, the
// check puts a stand-in of that file on the sandbox's main for its own
// duration (standInWorkflow): it starts only by hand and its one job is always
// skipped, so nothing runs on its own and a dispatched run does nothing. It
// adds and removes the file with a third App token, limited to Contents and
// Workflows write, under an exclusive shared reservation that keeps every
// scenario run off the sandbox meanwhile.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestConfig } from './config.ts';
import { REPO_ROOT } from './engine.ts';
import { appInstallationToken, GitHubError, revokeInstallationToken, SandboxRest, type TokenPermissions, type WorkflowRun } from './github.ts';
import { githubRequestToken } from './github-request.ts';
import { newRunId } from './isolation.ts';
import { acquireLock, LockTimeoutError, registerRun, type Lock } from './locks.ts';
import { OwnershipLedger } from './ownership.ts';
import { EnvBlockedError } from './results.ts';
import type { SharedAdmission } from './shared-state.ts';
import { SANDBOX_RUNNER, WORKFLOW_FILES } from './workflow-files.ts';

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
/** How long the check waits for GitHub to register the stand-in it added. */
const REGISTER_MS = 60_000;
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

/** Where the stand-in goes: the file the script dispatches, on the default branch. */
export const STAND_IN_PATH = `.github/workflows/${WORKFLOW_FILES.sync}`;

/** The stand-in's first line: a check knows its own file on main by it, whichever harness version wrote the rest. */
const STAND_IN_MARK = '# A stand-in for the sync workflow, for the harness\'s dispatch check';

/** Whether a workflow file on main is a dispatch check's stand-in. */
export function isStandIn(text: string): boolean {
  return text.split('\n', 1)[0] === STAND_IN_MARK;
}

/**
 * What a dispatch check may have left on the sandbox: its stand-in on main,
 * its exclusive shared reservation, or both. The check failed (exit 1), and
 * the message says what to recover; never env-blocked, which says nothing was left.
 */
export class LeftOnSandboxError extends Error {}

/**
 * The stand-in for the sync workflow that `withWorkflow` puts on main: the
 * name the script dispatches, started only by hand, with no permissions and
 * one job that is always skipped. A dispatch gives a run that appears and
 * ends at once; no runner takes a job and nothing is read or written.
 */
export function standInWorkflow(): string {
  return [
    STAND_IN_MARK,
    '# (test/e2e/harness/dispatch-check.ts). Generated: the check adds it to the',
    '# default branch and removes it when it ends. It starts only by hand, and',
    '# its one job is always skipped.',
    'name: mdbisync',
    '',
    'on:',
    '  workflow_dispatch:',
    '',
    'permissions: {}',
    '',
    'jobs:',
    '  sync:',
    "    if: ${{ false }}",
    `    runs-on: [${SANDBOX_RUNNER.join(', ')}]`,
    '    steps:',
    '      - run: "true"',
    '',
  ].join('\n');
}

export interface StandInRecord {
  /** The run id of the exclusive shared reservation: `cli.ts recover` takes it up after a crash. */
  reservation: string;
  /** The commit that added the stand-in to main, or `already there` for one a stopped check left. */
  added: string;
  /** The commit that removed it, or null while it is still on main. */
  removed: string | null;
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
  /** With `withWorkflow`: the stand-in's way on and off main. */
  standIn?: StandInRecord;
  /** Whether every minted token was revoked; an unrevoked one expires within an hour. */
  tokensRevoked: boolean;
  ok: boolean;
}

export interface DispatchCheckDeps {
  /** `missing` matters only with `withWorkflow`: recovering its reservation takes the whole live configuration. */
  config: Pick<TestConfig, 'owner' | 'repo' | 'githubApp' | 'githubAppMissing' | 'sandboxUrl'> & Partial<Pick<TestConfig, 'missing'>>;
  /** The harness state folder that holds the check's lock: one check at a time on this host. */
  stateDir: string;
  fetch?: typeof fetch;
  /** The environment the script runs with: its PATH finds curl. */
  env?: NodeJS.ProcessEnv;
  keepRun?: boolean;
  /**
   * Put the stand-in workflow on main for the check, under an exclusive
   * reservation of the shared admission `admission` builds. Its git access
   * takes tokens from `gitToken`, which the check mints with Contents write
   * alone and revokes with its others.
   */
  withWorkflow?: { admission(gitToken: () => Promise<string>): SharedAdmission };
  log?: (line: string) => void;
  /** For tests: shorter waits. */
  timing?: { lookForMs?: number; pollMs?: number; registerMs?: number };
}

/** Reads the workflow's state, its runs and its file on main; cannot start it. */
const DENIED: TokenPermissions = { actions: 'read', contents: 'read' };
const ALLOWED: TokenPermissions = { actions: 'write' };
/** Adds and removes the stand-in: a workflow file needs Workflows write besides Contents write. */
const WRITER: TokenPermissions = { contents: 'write', workflows: 'write' };
/** Takes and releases the shared reservation: a push to the admission ref. */
const ADMISSION: TokenPermissions = { contents: 'write' };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The shared reservation's budget: the check spends nothing of Linear's, so it reads none. */
const NO_BUDGET = { requestsRemaining: 0, complexityRemaining: 0, resetAt: 0 };

interface StandIn {
  record: StandInRecord;
  /** Removes the stand-in, then releases the reservation; throws, with both left, when main's file is not the stand-in or the removal fails. */
  remove(): Promise<void>;
}

/**
 * The stand-in on main for the check's duration. Registers a run on this
 * host with an empty ownership record, then takes an exclusive shared
 * reservation (refused, writing nothing, while any other run holds one), so
 * that `cli.ts recover` finds what it needs after a crash at any point. Adds
 * the stand-in, or keeps one that a stopped check left, and waits until
 * GitHub has it registered and active. Leaves a `mdbisync.yml` on main that
 * is not the stand-in as it is. Each write names the state it was checked
 * against (create-only, or the blob read), so a file changed meanwhile makes
 * GitHub refuse the write instead of losing that change.
 */
async function addStandIn(shared: SharedAdmission, stateDir: string, rest: SandboxRest, reader: SandboxRest,
  wait: { registerMs: number; pollMs: number }, log: (line: string) => void): Promise<StandIn> {
  const runId = newRunId();
  const owner = randomUUID();
  const registration = registerRun(stateDir, runId);
  new OwnershipLedger(stateDir, runId).scope([]);
  const free = async () => {
    await shared.release(runId, owner);
    registration.done();
  };
  let admitted: boolean;
  try {
    admitted = (await shared.reserve({ runId, owner, app: 'dispatch-check', full: true, need: { requests: 0, complexity: 0 },
      reserve: { requests: 0, complexity: 0 }, maxWorkers: 1, readBudget: async () => NO_BUDGET })).admitted;
  } catch (error) {
    // The reservation may have landed: the local records stay for `recover`.
    throw new LeftOnSandboxError(`taking the shared reservation ${runId} failed, and it may be held: ${message(error)}`);
  }
  if (!admitted) {
    registration.done();
    throw new EnvBlockedError('the stand-in needs exclusive shared admission and other runs hold reservations; nothing was written or dispatched');
  }
  let present: { text: string; sha: string } | undefined;
  try { present = await rest.fileBlob(STAND_IN_PATH); }
  catch (error) {
    await free().catch((freeing: unknown) => { throw new LeftOnSandboxError(`${message(error)}; then releasing reservation ${runId} failed: ${message(freeing)}`); });
    throw error;
  }
  if (present !== undefined && !isStandIn(present.text)) {
    await free().catch((freeing: unknown) => { throw new LeftOnSandboxError(`releasing reservation ${runId} failed: ${message(freeing)}`); });
    throw new EnvBlockedError(`the sandbox's main holds a ${STAND_IN_PATH} that is not the stand-in; it was left as it is and nothing was dispatched`);
  }

  const record: StandInRecord = { reservation: runId, added: present === undefined ? '' : 'already there', removed: null };
  const remove = async () => {
    const file = await rest.fileBlob(STAND_IN_PATH);
    if (file !== undefined && !isStandIn(file.text)) throw new Error(`main's ${STAND_IN_PATH} is no longer the stand-in; it was left as it is`);
    const removed = file === undefined ? undefined : await rest.deleteFile(STAND_IN_PATH, 'Remove the dispatch check\'s stand-in workflow', file.sha);
    record.removed = removed?.commit ?? 'already gone';
    log(`removed the stand-in ${STAND_IN_PATH} from main${removed === undefined ? ' (it was gone)' : ` in ${removed.commit}`}`);
    await free();
  };
  try {
    if (present === undefined) {
      record.added = (await rest.createFile(STAND_IN_PATH, standInWorkflow(), 'Add a stand-in sync workflow for the dispatch check')).commit;
      log(`added the stand-in ${STAND_IN_PATH} to main in ${record.added}`);
    } else {
      log(`main already holds the stand-in ${STAND_IN_PATH}, left by a stopped check`);
    }
    const started = Date.now();
    while (!(await reader.workflowState(WORKFLOW_FILES.sync) === 'active' && isStandIn(await reader.fileText(STAND_IN_PATH, 'main') ?? ''))) {
      if (Date.now() - started >= wait.registerMs) throw new EnvBlockedError(`GitHub did not register the stand-in ${STAND_IN_PATH} as active within ${wait.registerMs / 1000} seconds; nothing was dispatched`);
      await sleep(wait.pollMs);
    }
  } catch (error) {
    // A write that failed may still have landed: the stand-in goes as on every other way out.
    await removeOrThrow({ record, remove }, error);
    throw error;
  }
  return { record, remove };
}

/** Removes the stand-in on a way out with `cause`; when that fails, throws LeftOnSandboxError naming both. */
async function removeOrThrow(standIn: StandIn, cause: unknown): Promise<void> {
  try { await standIn.remove(); }
  catch (error) {
    throw new LeftOnSandboxError(`${message(cause)}; then the stand-in could not be removed and reservation ${standIn.record.reservation} stays held: ${message(error)}`);
  }
}

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
  const registerMs = deps.timing?.registerMs ?? REGISTER_MS;
  if (config.sandboxUrl === '' || config.owner === '') throw new EnvBlockedError('test configuration is missing: MDBISYNC_TEST_SANDBOX_URL');
  if (config.githubApp === null) throw new EnvBlockedError(`the dispatch check needs the GitHub App: ${config.githubAppMissing.join(' and ')} not in the test secrets`);

  // A reservation this host could not recover would block every run: `recover` reads Linear, so the
  // stand-in needs the whole live configuration, though the check itself uses none of Linear.
  if (deps.withWorkflow !== undefined && (config.missing?.length ?? 0) > 0) {
    throw new EnvBlockedError(`--with-workflow takes a reservation that only \`recover\` with the whole test configuration can release, and it is missing: ${config.missing?.join(', ')}; nothing was written or dispatched`);
  }
  const published = documentedScript(readFileSync(join(REPO_ROOT, SCRIPT_PAGE), 'utf8'));
  const script = scriptFor(published, config.owner, config.repo);
  let lock: Lock;
  try { lock = await acquireLock('dispatch-check', { stateDir: deps.stateDir, runId: newRunId(), timeoutMs: 0 }); }
  catch (error) {
    if (error instanceof LockTimeoutError) throw new EnvBlockedError(`another dispatch check is running on this host (${error.message})`);
    throw error;
  }
  const minted: string[] = [];
  let standIn: StandIn | undefined;
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
      if (deps.withWorkflow !== undefined) {
        const writer = new SandboxRest(config, (await mint(WRITER)).token, fetchImpl);
        const shared = deps.withWorkflow.admission(async () => (await mint(ADMISSION)).token);
        standIn = await addStandIn(shared, deps.stateDir, writer, reader, { registerMs, pollMs }, log);
      }
      const state = await reader.workflowState(WORKFLOW_FILES.sync);
      if (state !== 'active') throw new EnvBlockedError(`the sandbox's ${WORKFLOW_FILES.sync} is ${state === undefined ? 'not registered' : state}; nothing was dispatched`);
      // The registry also lists a workflow that only a run branch carries; the script dispatches main's.
      const onMain = await reader.fileText(STAND_IN_PATH, 'main');
      if (onMain === undefined) throw new EnvBlockedError(`the sandbox's main has no .github/workflows/${WORKFLOW_FILES.sync}; nothing was dispatched`);
      // Another check's stand-in, which that check may remove or dispatch at any moment.
      if (standIn === undefined && isStandIn(onMain)) throw new EnvBlockedError(`the sandbox's main holds a dispatch check's stand-in ${STAND_IN_PATH}: a check with --with-workflow is running or stopped; nothing was dispatched`);
      const before = new Set((await reader.workflowFileRuns(WORKFLOW_FILES.sync, 'workflow_dispatch')).map((run) => run.id));
      return { denied, allowed, reader, before };
    };
    const { denied, allowed, reader, before } = await setup().catch((error: unknown) => {
      if (error instanceof EnvBlockedError || error instanceof LeftOnSandboxError) throw error;
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
    const standInRecord = standIn?.record;
    if (standIn !== undefined) {
      const current = standIn;
      standIn = undefined;
      try { await current.remove(); }
      catch (error) {
        record(`removing the stand-in (reservation ${current.record.reservation} stays held)`, error);
        log(`warning: the stand-in may still be on main and reservation ${current.record.reservation} stays held: ${message(error)}`);
      }
    }

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
      ...(standInRecord === undefined ? {} : { standIn: standInRecord }),
      tokensRevoked: await revoke(minted, fetchImpl, log),
      ok: deniedOk && allowedOk && errors.length === 0,
    };
  } catch (error) {
    // Any way out before the record (an error, an env-blocked setup) takes the stand-in off main too.
    if (standIn !== undefined) await removeOrThrow(standIn, error);
    throw error;
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
