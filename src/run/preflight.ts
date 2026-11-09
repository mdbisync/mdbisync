// What every run does before it may write: the sync refuses to run without
// its state, and every operation checks the setup. The run's Linear token
// is minted here and revoked when the run's work is done, also on failure.

import { LinearClient, RequestStats, withRunToken, type LogEntry } from '../linear/index.ts';
import { type RepositoryMapping, loadMapping } from '../mapping/index.ts';
import {
  type FailureCode,
  PRE_COMMIT_CONFIG,
  type ResolvedTargets,
  type SetupReport,
  type StateRefusal,
  checkGitHub,
  checkSyncState,
  isCredentialError,
  readHookConfig,
  renderSetupSummary,
  renderStateRefusal,
  runSetupCheck,
} from '../setup/index.ts';
import { type FetchedState, type Git, fetchState, initialPullRequestPending, readInitialSyncProgress } from '../state/index.ts';
import { type RunInputs } from './inputs.ts';
import { type PREFLIGHT_COMMANDS } from '../commands.ts';

/** The operations that start with the preflight. */
export type Operation = (typeof PREFLIGHT_COMMANDS)[number];

/** What a run that passed its preflight works with. */
export interface RunContext {
  git: Git;
  fetched: FetchedState;
  mapping: RepositoryMapping;
  targets: ResolvedTargets;
  linear: LinearClient;
}

export interface PreflightOutcome {
  operation: Operation;
  ok: boolean;
  /** Why the run stopped before writing; absent when it may go on. */
  code?: FailureCode;
  /** Markdown for the job summary: names and states, no content. */
  summary: string;
  setup?: SetupReport;
  refusal?: StateRefusal;
}

export interface PreflightOptions {
  git: Git;
  /** For warnings that do not change the outcome, such as a token that could not be revoked. */
  warn: (message: string) => void;
  fetch?: typeof fetch;
  /** Safe per-request diagnostics; emitted immediately, including on failure. */
  log: (entry: LogEntry) => void;
  /** Refuse, writing nothing, while the pull request of an initial sync from Linear waits for a person. */
  refusePendingInitialPullRequest?: boolean;
}

/**
 * Runs the preflight and, when it passes, `work` with the run's context
 * while the Linear token is alive. Nothing is written before `work`.
 */
export async function runPreflight(
  operation: Operation,
  inputs: RunInputs,
  options: PreflightOptions,
  work?: (context: RunContext) => Promise<void>,
): Promise<PreflightOutcome> {
  const { git } = options;
  const fetched = await fetchState(git, inputs.state);
  if (operation === 'sync') {
    const unfinished = (await readInitialSyncProgress(git, fetched.state.ids)) !== null;
    const pending = await initialPullRequestPending(git, { linear: fetched.state.linear, sync: fetched.sync, tracked: fetched.tracked });
    const refusal = checkSyncState(fetched.state, inputs.state, unfinished, pending);
    if (refusal !== null) return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  } else if (options.refusePendingInitialPullRequest === true) {
    // Writing Linear from the tracked branch while that pull request is open would leave it to be merged over the new state.
    const pending = await initialPullRequestPending(git, { linear: fetched.state.linear, sync: fetched.sync, tracked: fetched.tracked });
    const refusal = checkSyncState(fetched.state, inputs.state, false, pending);
    if (refusal?.code === 'initial-pull-request-pending') return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  }

  const mapping = await loadMapping(git, fetched.tracked);
  const hooks = readHookConfig(await readTrackedFile(git, fetched.tracked, PRE_COMMIT_CONFIG));
  const github = await checkGitHub({ ...inputs.github, commit: fetched.tracked, ...(options.fetch ? { fetch: options.fetch } : {}) });

  const stats = new RequestStats();
  const requestHooks = { log: options.log };
  const tokenOptions = { hooks: requestHooks, baseUrl: inputs.linear.apiUrl, stats, ...(options.fetch ? { fetch: options.fetch } : {}) };
  const credentials = { clientId: inputs.linear.clientId, clientSecret: inputs.linear.clientSecret };
  const onRevokeError = (error: unknown) =>
    options.warn(`the run's Linear token could not be revoked: ${error instanceof Error ? error.message : String(error)}`);
  let minted = false;
  try {
    return await withRunToken(credentials, { ...tokenOptions, onRevokeError }, async (token) => {
      minted = true;
      const linear = new LinearClient({ ...tokenOptions, token: token.accessToken, auth: token.context });
      const { report, targets } = await runSetupCheck({ mapping, hooks, github, linear: { client: linear, scope: token.scope } });
      if (report.ok && targets !== undefined && work !== undefined) await work({ git, fetched, mapping, targets, linear });
      return outcome(operation, report);
    });
  } catch (error) {
    // Only Linear's refusal of the credentials is a setup failure; an outage or
    // a lost request is an error of the run.
    if (minted || !isCredentialError(error)) throw error;
    const { report } = await runSetupCheck({ mapping, hooks, github, linear: { error: 'Linear refused the OAuth app client credentials' } });
    return outcome(operation, report);
  }
}

function outcome(operation: Operation, report: SetupReport): PreflightOutcome {
  const result: PreflightOutcome = { operation, ok: report.ok, summary: renderSetupSummary(report), setup: report };
  if (report.code !== undefined) result.code = report.code;
  return result;
}

async function readTrackedFile(git: Git, commit: string, path: string): Promise<string | null> {
  const result = await git.run(['cat-file', 'blob', `${commit}:${path}`], { okCodes: [0, 128] });
  return result.code === 0 ? result.stdout.toString('utf8') : null;
}
