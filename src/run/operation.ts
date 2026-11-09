// Runs one operation after its preflight: `check` stops there; an initial
// sync from git to Linear without `confirm` plans and reports what it would
// do, and with `confirm` makes Linear equal to the tracked branch and
// records the state. A sync captures Linear changes after its preflight.

import { capture, type CaptureResult } from '../capture/index.ts';
import { checkpoint } from '../test-hooks.ts';
import {
  type ConfirmedResult,
  type PlanReport,
  confirmInitialSync,
  documentLinks,
  planFromRepository,
  renderConfirmed,
  renderDryRun,
  toPlanReport,
  uploadsTransform,
} from '../initial-sync/index.ts';
import { type InitialSyncInputs, type RunInputs } from './inputs.ts';
import { type Operation, type PreflightOptions, type PreflightOutcome, runPreflight } from './preflight.ts';

export interface OperationOutcome extends PreflightOutcome {
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** The initial sync's plan. */
  plan?: PlanReport;
  /** What a confirmed initial sync wrote and recorded. */
  confirmed?: ConfirmedResult;
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
  const gitToLinear = initialSync?.direction === 'git-to-linear' ? initialSync : undefined;
  let plan: PlanReport | undefined;
  let confirmed: ConfirmedResult | undefined;
  let captured: CaptureResult | undefined;
  let workSummary = '';
  const preflight = await runPreflight(
    operation,
    inputs,
    options,
    operation === 'sync'
      ? async (context) => {
          captured = await capture(context, { config: inputs.state, ...(options.fetch ? {fetch: options.fetch} : {}) });
          workSummary = captured.summary;
          if (captured.ok) await checkpoint('after-capture-push-before-pr');
        }
      : gitToLinear === undefined
      ? undefined
      : async (context) => {
          if (gitToLinear.confirm) {
            const run = await confirmInitialSync(context, { config: inputs.state, transforms: [uploadsTransform({ config: inputs.state }), documentLinks()] });
            plan = toPlanReport(run.plan, gitToLinear.direction, true);
            confirmed = run.result;
            workSummary = renderConfirmed(run.plan, run.result);
          } else {
            const planned = await planFromRepository(context);
            plan = toPlanReport(planned, gitToLinear.direction, false);
            workSummary = renderDryRun(planned);
          }
        },
  );
  if (!preflight.ok) return { ...preflight, notImplemented: false };
  const outcome: OperationOutcome = { ...preflight, notImplemented: operation !== 'check' && operation !== 'sync' && gitToLinear === undefined };
  if (plan !== undefined) outcome.plan = plan;
  if (workSummary !== '') {
    outcome.summary = `${preflight.summary.trimEnd()}\n\n${workSummary}`;
  }
  if (confirmed !== undefined) outcome.confirmed = confirmed;
  if (captured !== undefined) outcome.captured = captured;
  return outcome;
}
