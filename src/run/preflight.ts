// What every run does before it may write: the sync refuses to run without
// its state, and every operation checks the setup. The run's Linear token
// is minted here and revoked when the run's work is done, also on failure.

import { type AuthContext, LinearClient, type LinearReads, LinearStoppedError, RequestStats, withDeferredRunToken, withRunToken, type LogEntry, type StopReason, type TokenLifecycle } from '../linear/index.ts';
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
import { type CommitIdentity, type FetchedState, type Git, NEUTRAL_IDENTITY, fetchState, initialPullRequestPending, isAncestor, readInitialSyncProgress } from '../state/index.ts';
import { type RunInputs } from './inputs.ts';
import { type PREFLIGHT_COMMANDS } from '../commands.ts';
import { renderStoppedBeforeWriting } from './stop.ts';
import { message } from '../messages.ts';

/** The operations that start with the preflight. */
export type Operation = (typeof PREFLIGHT_COMMANDS)[number];

/** What a run that passed its preflight works with. */
export interface RunContext {
  git: Git;
  fetched: FetchedState;
  mapping: RepositoryMapping;
  targets: ResolvedTargets;
  linear: LinearClient;
  /** Who the run's commits are by: the App's bot account, read in the setup check. */
  identity: CommitIdentity;
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
  /**
   * Linear stopped the run's client before the run could write (a rate
   * limit, a budget running low). Nothing was written; a sync run is
   * partial, and the next run starts again.
   */
  stopped?: StopReason;
  /** Writes the run tried after Linear stopped its client; each was refused without a request. */
  writesAfterStop?: number;
  /** Writes Linear accepted from the run's client, by operation; absent when the run made no client. */
  linearWrites?: ReadonlyMap<string, number>;
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
  /** Told when the run's Linear token is minted and when this run revoked it. */
  tokenLifecycle?: TokenLifecycle;
  /**
   * The staged security steps: the stage step keeps Linear's answers to its
   * reads here; the apply step's reads take them, and its token is minted
   * only when a request still has to reach Linear.
   */
  reads?: LinearReads;
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
    const pending = await initialPullRequestPending(git, { linear: fetched.state.linear, tracked: fetched.tracked });
    const refusal = checkSyncState(fetched.state, inputs.state, unfinished, pending);
    if (refusal !== null) return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  } else if (options.refusePendingInitialPullRequest === true) {
    // A new initial sync to Linear may replace an abandoned snapshot once
    // its branch is deleted. A branch still carrying it must be removed first.
    const pending = fetched.sync !== null && fetched.state.linear !== null
      && (await isAncestor(git, fetched.state.linear, fetched.sync))
      && (await initialPullRequestPending(git, { linear: fetched.state.linear, tracked: fetched.tracked }));
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
    options.warn(message('run.revoke-failed', { reason: error instanceof Error ? error.message : String(error) }));
  let minted = false;
  const reads = options.reads;
  const runOptions = { ...tokenOptions, onRevokeError, ...(options.tokenLifecycle ? { lifecycle: options.tokenLifecycle } : {}) };
  const withToken = <T>(work: (token: { accessToken: string | (() => Promise<string>); scope: string[]; context: AuthContext }) => Promise<T>) => {
    const known = reads?.token;
    if (known != null) return withDeferredRunToken(credentials, known, runOptions, (token) => work({ ...token, accessToken: () => token.accessToken() }));
    return withRunToken(credentials, runOptions, (token) => {
      reads?.tokenMinted(token.scope, token.context);
      return work(token);
    });
  };
  try {
    return await withToken(async (token) => {
      minted = true;
      const linear = new LinearClient({ ...tokenOptions, token: token.accessToken, auth: token.context, ...(reads ? { reads } : {}) });
      let setup: SetupReport | undefined;
      try {
        const { report, targets } = await runSetupCheck({ mapping, hooks, github, linear: { client: linear, scope: token.scope } });
        setup = report;
        if (report.ok && targets !== undefined && work !== undefined) await work({ git, fetched, mapping, targets, linear, identity: github.identity ?? NEUTRAL_IDENTITY });
        return { ...outcome(operation, report), writesAfterStop: stats.writesAfterStop, linearWrites: stats.writes };
      } catch (error) {
        // Linear stopped the client (a rate limit, a budget running low) outside the steps that record their progress.
        if (!(error instanceof LinearStoppedError)) throw error;
        return { ...stoppedOutcome(operation, error.reason, setup), writesAfterStop: stats.writesAfterStop, linearWrites: stats.writes };
      }
    });
  } catch (error) {
    // Only Linear's refusal of the credentials is a setup failure; an outage or
    // a lost request is an error of the run.
    if (minted || !isCredentialError(error)) throw error;
    const { report } = await runSetupCheck({ mapping, hooks, github, linear: { error: message('setup.linear-refused-credentials') } });
    return outcome(operation, report);
  }
}

function stoppedOutcome(operation: Operation, stopped: StopReason, setup: SetupReport | undefined): PreflightOutcome {
  const summary = renderStoppedBeforeWriting(stopped, operation === 'sync');
  return {
    operation,
    ok: false,
    stopped,
    summary: setup === undefined ? summary : `${renderSetupSummary(setup).trimEnd()}\n\n${summary}`,
    ...(setup === undefined ? {} : { setup }),
  };
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
