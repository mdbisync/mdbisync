// Runs one operation after its preflight: `check` stops there; an initial
// sync from git to Linear without `confirm` plans and reports what it would
// do. The other operations are not built yet and say so after a passed
// preflight.

import { type PlanReport, planFromRepository, renderDryRun, toPlanReport } from '../initial-sync/index.ts';
import { type InitialSyncInputs, type RunInputs } from './inputs.ts';
import { type Operation, type PreflightOptions, type PreflightOutcome, runPreflight } from './preflight.ts';

export interface OperationOutcome extends PreflightOutcome {
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** The initial sync's plan, for a dry run. */
  plan?: PlanReport;
}

export async function runOperation(
  operation: Operation,
  inputs: RunInputs,
  initialSync: InitialSyncInputs | undefined,
  options: PreflightOptions,
): Promise<OperationOutcome> {
  if (operation === 'initial-sync' && initialSync === undefined) throw new Error('initial sync needs its direction and confirm inputs');
  const dryRun = operation === 'initial-sync' && isDryRunBuilt(initialSync as InitialSyncInputs);
  let plan: PlanReport | undefined;
  let planSummary = '';
  const preflight = await runPreflight(
    operation,
    inputs,
    options,
    dryRun
      ? async (context) => {
          const planned = await planFromRepository(context);
          plan = toPlanReport(planned, (initialSync as InitialSyncInputs).direction, false);
          planSummary = renderDryRun(planned);
        }
      : undefined,
  );
  if (!preflight.ok) return { ...preflight, notImplemented: false };
  const outcome: OperationOutcome = { ...preflight, notImplemented: operation !== 'check' && !dryRun };
  if (plan !== undefined) {
    outcome.plan = plan;
    outcome.summary = `${preflight.summary.trimEnd()}\n\n${planSummary}`;
  }
  return outcome;
}

/** The dry run from git to Linear is built; a confirmed run and the other direction are not yet. */
function isDryRunBuilt(inputs: InitialSyncInputs): boolean {
  return inputs.direction === 'git-to-linear' && !inputs.confirm;
}
