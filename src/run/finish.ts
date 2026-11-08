// The run's machine-readable report: what the job summary says, as JSON,
// for tests and tooling. Names and states only, no content.

import { writeFile } from 'node:fs/promises';
import { type PreflightOutcome } from './preflight.ts';

export interface RunReport {
  operation: PreflightOutcome['operation'];
  ok: boolean;
  code: string | null;
  setupChecks: Array<{ name: string; state: string; detail: string }>;
  securityHooks: string[] | null;
}

export function toRunReport(outcome: PreflightOutcome): RunReport {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    code: outcome.code ?? null,
    setupChecks: (outcome.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome.setup?.securityHooks ?? null,
  };
}

export async function writeRunReport(path: string, outcome: PreflightOutcome): Promise<void> {
  await writeFile(path, `${JSON.stringify(toRunReport(outcome), null, 2)}\n`);
}
