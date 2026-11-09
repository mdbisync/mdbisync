// GitHub Action `main` step. The `operation` input selects one of the two
// entry points: the recurring sync or the one-time initial sync. Both run
// the preflight first (the sync's state and the setup check) and write
// nothing when it fails.
//
// The checkout keeps no git credentials (`persist-credentials: false`), so
// the engine's git calls get the GitHub App token through the environment
// of each call, never through the repository's configuration. The run's
// Linear token stays in the step's state until this run revokes it; the
// `post` step revokes it when a killed or failed run left it behind.

import * as core from "@actions/core";
import { notImplementedMessage } from "../commands.ts";
import { PARTIAL, partialCode, pullRequestEnding, stoppedMessage } from "../run/exit.ts";
import { unfinishedMessage, writeRunReport } from "../run/finish.ts";
import { type InputName, readInitialSyncInputs, readInputs } from "../run/inputs.ts";
import { runOperation } from "../run/operation.ts";
import { Git } from "../state/index.ts";
import { LINEAR_TOKEN_STATE } from "./state.ts";

export const OPERATIONS = ["sync", "initial-sync"] as const;
export type Operation = (typeof OPERATIONS)[number];

export function parseOperation(value: string): Operation {
  const operation = value.trim() === "" ? "sync" : value.trim();
  if ((OPERATIONS as readonly string[]).includes(operation)) {
    return operation as Operation;
  }
  throw new Error(`unknown operation: ${operation} (expected one of: ${OPERATIONS.join(", ")})`);
}

/**
 * Environment for git calls that authenticates to the GitHub server with the
 * App's installation token, as an HTTP header that applies to that server
 * only. Nothing is written to the repository's configuration.
 */
export function gitAuthEnv(token: string, serverUrl: string): Record<string, string> {
  const origin = new URL(serverUrl).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface RunOptions {
  /** For tests: the fake services. */
  fetch?: typeof fetch;
}

export async function run(options: RunOptions = {}): Promise<void> {
  try {
    const operation = parseOperation(core.getInput("operation"));
    const get = (name: InputName) => core.getInput(name);
    const inputs = readInputs(get);
    const initialSync = operation === "initial-sync" ? readInitialSyncInputs(get) : undefined;
    const serverUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
    const outcome = await runOperation(operation, inputs, initialSync, {
      git: new Git(process.env["GITHUB_WORKSPACE"] || process.cwd(), gitAuthEnv(inputs.github.token, serverUrl)),
      warn: (message) => core.warning(message),
      log: (entry) => core.info(JSON.stringify(entry)),
      tokenLifecycle: {
        minted: (token) => {
          // Secrets and the App token are masked already; this token is new to the runner.
          core.setSecret(token);
          core.saveState(LINEAR_TOKEN_STATE, token);
        },
        revoked: () => core.saveState(LINEAR_TOKEN_STATE, ""),
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (process.env["GITHUB_STEP_SUMMARY"]) await core.summary.addRaw(outcome.summary).write();
    else core.info(outcome.summary);
    if (inputs.reportFile !== undefined) await writeRunReport(inputs.reportFile, outcome);
    const failure = pullRequestEnding(outcome);
    if (failure !== null) {
      core.setOutput("code", failure.code);
      core.setFailed(`${operation}: ${failure.message}`);
      return;
    }
    const partial = partialCode(outcome);
    core.setOutput("code", partial ?? outcome.code ?? (outcome.stopped === undefined ? "" : "stopped"));
    // A partial sync kept what it could record; the next run goes on, so the job ends with a warning, not a failure.
    if (partial !== undefined) {
      core.warning(`${operation}: ${PARTIAL} (${partial})`);
      return;
    }
    const stopped = stoppedMessage(outcome);
    if (stopped !== undefined) {
      core.setFailed(stopped);
      return;
    }
    if (!outcome.ok) {
      core.setFailed(`${operation}: stopped before any write (${outcome.code})`);
      return;
    }
    if (outcome.confirmed?.code === 'container-cap' || outcome.sync?.write?.code === 'container-cap') {
      core.setOutput("code", "container-cap");
      core.setFailed(`${operation}: stopped before any write (container-cap); reduce additions or check document-cap`);
      return;
    }
    const unfinished = outcome.confirmed ?? outcome.reverse;
    if (unfinished !== undefined && !unfinished.complete) {
      core.setOutput("code", unfinished.code ?? "");
      core.setFailed(unfinishedMessage(operation, unfinished.code));
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
