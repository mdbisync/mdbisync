// What every run does before it may write: the sync refuses to run without
// its state, and every operation checks the setup. The run's Linear token
// is minted here and revoked when the run's work is done, also on failure.

import { LinearClient, RequestStats, mintAppToken, revokeToken } from '../linear/index.ts';
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
import { type FetchedState, type Git, fetchState } from '../state/index.ts';
import { type RunInputs } from './inputs.ts';

export const OPERATIONS = ['sync', 'initial-sync', 'check'] as const;
export type Operation = (typeof OPERATIONS)[number];

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
    const refusal = checkSyncState(fetched.state, inputs.state);
    if (refusal !== null) return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  }

  const mapping = await loadMapping(git, fetched.tracked);
  const hooks = readHookConfig(await readTrackedFile(git, fetched.tracked, PRE_COMMIT_CONFIG));
  const github = await checkGitHub({ ...inputs.github, commit: fetched.tracked, ...(options.fetch ? { fetch: options.fetch } : {}) });

  const stats = new RequestStats();
  const tokenOptions = { baseUrl: inputs.linear.apiUrl, stats, ...(options.fetch ? { fetch: options.fetch } : {}) };
  let token;
  try {
    token = await mintAppToken({ clientId: inputs.linear.clientId, clientSecret: inputs.linear.clientSecret }, tokenOptions);
  } catch (error) {
    if (!isCredentialError(error)) throw error;
    const { report } = await runSetupCheck({ mapping, hooks, github, linear: { error: 'Linear refused the OAuth app client credentials' } });
    return outcome(operation, report);
  }

  try {
    const linear = new LinearClient({ token: token.accessToken, baseUrl: inputs.linear.apiUrl, stats, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const { report, targets } = await runSetupCheck({ mapping, hooks, github, linear: { client: linear, scope: token.scope } });
    if (report.ok && targets !== undefined && work !== undefined) await work({ git, fetched, mapping, targets, linear });
    return outcome(operation, report);
  } finally {
    try {
      await revokeToken(token.accessToken, tokenOptions);
    } catch (error) {
      options.warn(`the run's Linear token could not be revoked: ${error instanceof Error ? error.message : String(error)}`);
    }
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
