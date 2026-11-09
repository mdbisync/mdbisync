// Runs one operation after its preflight: `check` stops there; an initial
// sync without `confirm` plans and reports what it would do. With `confirm`,
// from git to Linear it makes Linear equal to the tracked branch and records
// the state; from Linear it records the state and opens the pull request a
// person merges. `sync` runs one sync cycle.

import { type CaptureResult } from '../sync/capture.ts';
import {
  type ConfirmedResult,
  type PlanReport,
  type ReverseResult,
  confirmInitialSync,
  confirmLinearToGit,
  documentLinks,
  planFromRepository,
  planLinearToGitFromRepository,
  renderConfirmed,
  renderDryRun,
  renderReverseConfirmed,
  renderReverseDryRun,
  toPlanReport,
  toReversePlanReport,
  uploadsTransform,
} from '../initial-sync/index.ts';
import { type CycleResult, renderSync, runSyncCycle } from '../sync/index.ts';
import { type InitialSyncInputs, type RunInputs } from './inputs.ts';
import { type Operation, type PreflightOptions, type PreflightOutcome, type RunContext, runPreflight } from './preflight.ts';

export interface OperationOutcome extends PreflightOutcome {
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** The initial sync's plan. */
  plan?: PlanReport;
  /** What a confirmed initial sync from git to Linear wrote and recorded. */
  confirmed?: ConfirmedResult;
  /** What a confirmed initial sync from Linear recorded, and its pull request. */
  reverse?: ReverseResult;
  /** What a sync run wrote and recorded. */
  sync?: CycleResult;
  /** What a sync run's capture of Linear changes recorded. */
  captured?: CaptureResult;
}

export async function runOperation(
  operation: Operation,
  inputs: RunInputs,
  initialSync: InitialSyncInputs | undefined,
  options: PreflightOptions,
): Promise<OperationOutcome> {
  if ((operation === 'initial-sync') !== (initialSync !== undefined)) {
    throw new Error('the direction and confirm inputs belong to an initial sync, and only to it');
  }
  let plan: PlanReport | undefined;
  let confirmed: ConfirmedResult | undefined;
  let reverse: ReverseResult | undefined;
  let sync: CycleResult | undefined;
  let workSummary = '';

  // Uploads rewrite links to files that are not Markdown; document links, links to synchronized documents.
  const transforms = () => [uploadsTransform({ config: inputs.state }), documentLinks()];

  const gitToLinear = async (context: RunContext, confirm: boolean) => {
    if (confirm) {
      const run = await confirmInitialSync(context, { config: inputs.state, transforms: transforms() });
      plan = toPlanReport(run.plan, 'git-to-linear', true);
      confirmed = run.result;
      workSummary = renderConfirmed(run.plan, run.result);
    } else {
      const planned = await planFromRepository(context);
      plan = toPlanReport(planned, 'git-to-linear', false);
      workSummary = renderDryRun(planned);
    }
  };
  const linearToGit = async (context: RunContext, confirm: boolean) => {
    if (confirm) {
      const github = { ...inputs.github, ...(options.fetch ? { fetch: options.fetch } : {}) };
      const run = await confirmLinearToGit(context, { config: inputs.state, github });
      plan = toReversePlanReport(run.plan, true);
      reverse = run.result;
      workSummary = renderReverseConfirmed(run.plan, run.result);
    } else {
      const planned = await planLinearToGitFromRepository(context);
      plan = toReversePlanReport(planned, false);
      workSummary = renderReverseDryRun(planned);
    }
  };
  const syncCycle = async (context: RunContext) => {
    sync = await runSyncCycle(context, { config: inputs.state, transforms, ...(options.fetch ? { fetch: options.fetch } : {}) });
    workSummary = renderSync(sync);
  };

  const refusePending = initialSync?.direction === 'git-to-linear' && initialSync.confirm;
  const preflight = await runPreflight(
    operation,
    inputs,
    refusePending ? { ...options, refusePendingInitialPullRequest: true } : options,
    operation === 'sync'
      ? syncCycle
      : initialSync === undefined
        ? undefined
        : (context) => (initialSync.direction === 'git-to-linear' ? gitToLinear : linearToGit)(context, initialSync.confirm),
  );
  if (!preflight.ok) return { ...preflight, notImplemented: false };
  const outcome: OperationOutcome = { ...preflight, notImplemented: false };
  if (plan !== undefined) outcome.plan = plan;
  if (workSummary !== '') outcome.summary = `${preflight.summary.trimEnd()}\n\n${workSummary}`;
  if (confirmed !== undefined) outcome.confirmed = confirmed;
  if (reverse !== undefined) outcome.reverse = reverse;
  if (sync !== undefined) {
    outcome.sync = sync;
    outcome.captured = sync.capture;
  }
  return outcome;
}
