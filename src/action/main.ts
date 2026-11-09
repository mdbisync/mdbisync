// GitHub Action `main` step. The `operation` input selects one of the two
// entry points: the recurring sync or the one-time initial sync. Both run
// the preflight first (the sync's state and the setup check) and write
// nothing when it fails.

import * as core from "@actions/core";
import { notImplementedMessage } from "../commands.ts";
import { writeRunReport } from "../run/finish.ts";
import { type InputName, readInitialSyncInputs, readInputs } from "../run/inputs.ts";
import { runOperation } from "../run/operation.ts";
import { Git } from "../state/index.ts";

export const OPERATIONS = ["sync", "initial-sync"] as const;
export type Operation = (typeof OPERATIONS)[number];

export function parseOperation(value: string): Operation {
  const operation = value.trim() === "" ? "sync" : value.trim();
  if ((OPERATIONS as readonly string[]).includes(operation)) {
    return operation as Operation;
  }
  throw new Error(`unknown operation: ${operation} (expected one of: ${OPERATIONS.join(", ")})`);
}

export async function run(): Promise<void> {
  try {
    const operation = parseOperation(core.getInput("operation"));
    const get = (name: InputName) => core.getInput(name);
    const inputs = readInputs(get);
    const initialSync = operation === "initial-sync" ? readInitialSyncInputs(get) : undefined;
    const outcome = await runOperation(operation, inputs, initialSync, {
      git: new Git(process.env["GITHUB_WORKSPACE"] || process.cwd()),
      warn: (message) => core.warning(message),
      log: (entry) => core.info(JSON.stringify(entry)),
    });
    if (process.env["GITHUB_STEP_SUMMARY"]) await core.summary.addRaw(outcome.summary).write();
    else core.info(outcome.summary);
    if (inputs.reportFile !== undefined) await writeRunReport(inputs.reportFile, outcome);
    core.setOutput("code", outcome.code ?? "");
    if (!outcome.ok) {
      core.setFailed(`${operation}: stopped before any write (${outcome.code})`);
      return;
    }
    if (outcome.confirmed !== undefined && !outcome.confirmed.complete) {
      core.setOutput("code", outcome.confirmed.code ?? "");
      core.setFailed(`${operation}: not finished (${outcome.confirmed.code}); run it again with the same inputs`);
      return;
    }
    if (outcome.captured !== undefined && !outcome.captured.ok) {
      core.setFailed(`${operation}: capture did not finish (${outcome.captured.code})`);
      return;
    }
    if (outcome.notImplemented) core.setFailed(notImplementedMessage(operation));
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await run();
}
