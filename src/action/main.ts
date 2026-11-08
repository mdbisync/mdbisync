// GitHub Action `main` step. The `operation` input selects one of the two
// entry points: the recurring sync or the one-time initial sync.

import * as core from "@actions/core";
import { notImplementedMessage } from "../commands.ts";

export const OPERATIONS = ["sync", "initial-sync"] as const;
export type Operation = (typeof OPERATIONS)[number];

export function parseOperation(value: string): Operation {
  const operation = value.trim() === "" ? "sync" : value.trim();
  if ((OPERATIONS as readonly string[]).includes(operation)) {
    return operation as Operation;
  }
  throw new Error(`unknown operation: ${operation} (expected one of: ${OPERATIONS.join(", ")})`);
}

export function run(): void {
  try {
    const operation = parseOperation(core.getInput("operation"));
    core.setFailed(notImplementedMessage(operation));
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  run();
}
