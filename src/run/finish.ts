// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names, paths and states only, no content.

import { writeFile } from 'node:fs/promises';
import { type PlanReport } from '../initial-sync/index.ts';
import { type OperationOutcome } from './operation.ts';
import { type PreflightOutcome } from './preflight.ts';

export interface RunReport {
  operation: PreflightOutcome['operation'];
  ok: boolean;
  code: string | null;
  setupChecks: Array<{ name: string; state: string; detail: string }>;
  securityHooks: string[] | null;
  /** The preflight passed, but the operation is not built yet; nothing was written. */
  notImplemented: boolean;
  /** An initial sync's dry run: what its job summary lists, as data. */
  summary: PlanReport | null;
}

export function toRunReport(outcome: OperationOutcome): RunReport {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? null,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
    notImplemented: outcome.notImplemented,
    summary: outcome.plan ?? null,
  };
}

export async function writeRunReport(path: string, outcome: OperationOutcome): Promise<void> {
  await writeFile(path, `${JSON.stringify(toRunReport(outcome), null, 2)}\n`);
}
