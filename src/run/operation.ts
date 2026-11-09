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
import { rm } from 'node:fs/promises';
import { type CycleResult, capture, renderSync, runSyncCycle } from '../sync/index.ts';
import { type SecurityStep, answeringGate, stageNothing, stagingGate } from '../sync/staged.ts';
import { type RefusedPush, refusedPushes } from '../state/index.ts';
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
  /** Pushes refused because a ref had moved under this run: another run got there first. */
  refusedPushes: readonly RefusedPush[];
  /** The staged security steps' first step: how many sets of files it staged for the hooks. */
  staged?: { sets: number };
}

/** The staged security steps: which one this run is, and the folder they share. */
export interface StagedSecurity {
  step: SecurityStep;
  folder: string;
}

export async function runOperation(
  operation: Operation,
  inputs: RunInputs,
  initialSync: InitialSyncInputs | undefined,
  options: PreflightOptions,
  security?: StagedSecurity,
): Promise<OperationOutcome> {
  if ((operation === 'initial-sync') !== (initialSync !== undefined)) {
    throw new Error('the direction and confirm inputs belong to an initial sync, and only to it');
  }
  // Only a sync and a confirmed initial sync from Linear take Linear's text; nothing else has a set for the hooks.
  if (security?.step === 'stage' && operation === 'initial-sync' && !(initialSync?.direction === 'linear-to-git' && initialSync.confirm)) {
    await stageNothing(security.folder, null);
    return { operation, ok: true, notImplemented: false, refusedPushes: [], summary: renderStaged(0), staged: { sets: 0 } };
  }
  try {
    const outcome = await runWithSecurity(operation, inputs, initialSync, options, security);
    // The preflight passed without work to do (no annotated folder has a target): the hooks step still gets its command.
    if (security?.step === 'stage' && outcome.ok && outcome.staged === undefined) {
      await stageNothing(security.folder, null);
      return { ...outcome, staged: { sets: 0 }, summary: `${outcome.summary.trimEnd()}\n\n${renderStaged(0)}` };
    }
    return outcome;
  } finally {
    // The folder holds document content; the apply step is its last reader.
    if (security?.step === 'apply') await rm(security.folder, { recursive: true, force: true });
  }
}

async function runWithSecurity(
  operation: Operation,
  inputs: RunInputs,
  initialSync: InitialSyncInputs | undefined,
  options: PreflightOptions,
  security: StagedSecurity | undefined,
): Promise<OperationOutcome> {
  let staged: { sets: number } | undefined;
  let plan: PlanReport | undefined;
  let confirmed: ConfirmedResult | undefined;
  let reverse: ReverseResult | undefined;
  let sync: CycleResult | undefined;
  let workSummary = '';

  // Uploads rewrite links to files that are not Markdown; document links, links to synchronized documents.
  const transforms = () => [uploadsTransform({ config: inputs.state }), documentLinks()];

  const gitToLinear = async (context: RunContext, confirm: boolean) => {
    if (confirm) {
      const run = await confirmInitialSync(context, { config: inputs.state, documentCap: inputs.documentCap, transforms: transforms() });
      plan = toPlanReport(run.plan, 'git-to-linear', true);
      confirmed = run.result;
      workSummary = renderConfirmed(run.plan, run.result);
    } else {
      const planned = await planFromRepository(context, inputs.documentCap);
      plan = toPlanReport(planned, 'git-to-linear', false);
      workSummary = renderDryRun(planned);
    }
  };
  const linearToGit = async (context: RunContext, confirm: boolean) => {
    if (confirm) {
      const github = { ...inputs.github, ...(options.fetch ? { fetch: options.fetch } : {}) };
      if (security?.step === 'stage') {
        const gate = await stagingGate(context.git, context.fetched.tracked, security.folder);
        const ended = gate.configured ? (await confirmLinearToGit(context, { config: inputs.state, github, security: gate, stageOnly: true })).result.code : undefined;
        staged = { sets: await gate.finish() };
        // Stopped before the documents reached the hooks: the apply step meets the same reason and reports it.
        workSummary = renderStaged(staged.sets) + (ended === undefined ? '' : `\n\nStaging stopped early (${ended}).`);
        return;
      }
      const gate = security?.step === 'apply' ? { security: await answeringGate(context.git, context.fetched.tracked, security.folder) } : {};
      const run = await confirmLinearToGit(context, { config: inputs.state, github, ...gate });
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
    if (security?.step === 'stage') {
      const gate = await stagingGate(context.git, context.fetched.tracked, security.folder);
      let stopped = '';
      if (gate.configured) {
        const result = await capture(context, { config: inputs.state, state: { ...context.fetched.state }, security: gate, stageOnly: true, ...(options.fetch ? { fetch: options.fetch } : {}) });
        // Linear stopped the capture: it staged part of its sets, and the apply step leaves the rest out.
        if (!result.ok) stopped = `\n\n${result.summary}`;
      }
      staged = { sets: await gate.finish() };
      workSummary = renderStaged(staged.sets) + stopped;
      return;
    }
    sync = await runSyncCycle(context, {
      ...(security?.step === 'apply' ? { security: await answeringGate(context.git, context.fetched.tracked, security.folder) } : {}),
      config: inputs.state,
      documentCap: inputs.documentCap,
      mergeGraceSeconds: inputs.mergeGraceSeconds,
      github: { ...inputs.github, ...(options.fetch ? { fetch: options.fetch } : {}) },
      transforms,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
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
  const refused = refusedPushes(options.git);
  if (!preflight.ok) return { ...preflight, notImplemented: false, refusedPushes: refused };
  const outcome: OperationOutcome = { ...preflight, notImplemented: false, refusedPushes: refused };
  if (plan !== undefined) outcome.plan = plan;
  if (workSummary !== '') outcome.summary = `${preflight.summary.trimEnd()}\n\n${workSummary}`;
  if (confirmed !== undefined) outcome.confirmed = confirmed;
  if (reverse !== undefined) outcome.reverse = reverse;
  if (sync !== undefined) {
    outcome.sync = sync;
    outcome.captured = sync.capture;
  }
  if (staged !== undefined) outcome.staged = staged;
  return outcome;
}

function renderStaged(sets: number): string {
  return sets === 0
    ? 'Nothing staged for the security hooks: none are configured, or Linear has no changes for them.'
    : `Staged ${sets} sets of files for the security hooks; nothing was written to the repository or Linear.`;
}
