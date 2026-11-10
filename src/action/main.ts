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

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import { notImplementedMessage } from "../commands.ts";
import { PARTIAL, partialCode, pullRequestEnding, stoppedBeforeWritingMessage, stoppedMessage } from "../run/exit.ts";
import { unfinishedMessage, writeRunReport } from "../run/finish.ts";
import { type InputName, readInitialSyncInputs, readInputs } from "../run/inputs.ts";
import { runOperation } from "../run/operation.ts";
import { Git } from "../state/index.ts";
import { SECURITY_STEPS, type SecurityStep, stageFolder } from "../sync/staged.ts";
import { cleanupAppTokens } from "../linear/cleanup.ts";
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
export function gitAuthEnv(token: string, serverUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const origin = new URL(serverUrl).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  // Keep configuration an earlier step gave git the same way: add after it.
  const given = Number(env["GIT_CONFIG_COUNT"] ?? "0");
  const index = Number.isSafeInteger(given) && given > 0 ? given : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * The `security-step` input: empty runs the security hooks inside this
 * step; `stage` and `apply` are the action's two steps around a hooks step
 * of their own (see `src/sync/staged.ts`).
 */
export function parseSecurityStep(value: string): SecurityStep | undefined {
  const step = value.trim();
  if (step === "") return undefined;
  if ((SECURITY_STEPS as readonly string[]).includes(step)) return step as SecurityStep;
  throw new Error(`unknown security-step: ${step} (expected one of: ${SECURITY_STEPS.join(", ")}, or empty)`);
}

/** The hooks step's script, beside this one: the bundle in a release, the source in tests. */
export function hooksScript(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./hooks.ts" : "./action-hooks.js", import.meta.url));
}

/** Where the action writes the job summary beside its report, for tooling that reads both. */
export const SUMMARY_FILE = "summary.md";

export interface RunOptions {
  /** For tests: the fake services. */
  fetch?: typeof fetch;
}

export async function run(options: RunOptions = {}): Promise<void> {
  try {
    const operation = parseOperation(core.getInput("operation"));
    const get = (name: InputName) => core.getInput(name);
    const inputs = readInputs(get, process.env, { appSlugRequired: true });
    const initialSync = operation === "initial-sync" ? readInitialSyncInputs(get) : undefined;
    const cleanupValue = core.getInput("cleanup-tokens");
    const cleanupTokens = cleanupValue === "" ? false : core.getBooleanInput("cleanup-tokens");
    const step = parseSecurityStep(core.getInput("security-step"));
    if (cleanupTokens && step === "apply") throw new Error("cleanup-tokens belongs before the stage step, not apply");
    const security = step === undefined ? undefined : { step, folder: stageFolder() };
    const serverUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
    const auth = gitAuthEnv(inputs.github.token, serverUrl);
    // The header's encoded form is not the token itself; mask it too.
    for (const [key, value] of Object.entries(auth)) if (key.startsWith("GIT_CONFIG_VALUE_")) core.setSecret(value.split(" ").pop() as string);
    const tokenLifecycle = {
      minted: (token: string) => {
        core.setSecret(token);
        core.saveState(LINEAR_TOKEN_STATE, token);
      },
      revoked: () => core.saveState(LINEAR_TOKEN_STATE, ""),
    };
    if (cleanupTokens) {
      await cleanupAppTokens(inputs.linear, {
        exclusive: true,
        baseUrl: inputs.linear.apiUrl,
        lifecycle: tokenLifecycle,
        onRevokeError: () => { throw new Error("token cleanup revocation failed"); },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      core.info("token cleanup: replaced stale app tokens and restored read/write scopes");
    }
    const outcome = await runOperation(operation, inputs, initialSync, {
      git: new Git(process.env["GITHUB_WORKSPACE"] || process.cwd(), auth),
      warn: (message) => core.warning(message),
      log: (entry) => core.info(JSON.stringify(entry)),
      tokenLifecycle,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }, security);
    if (process.env["GITHUB_STEP_SUMMARY"]) await core.summary.addRaw(outcome.summary).write();
    else core.info(outcome.summary);
    if (inputs.reportFile !== undefined) {
      await writeRunReport(inputs.reportFile, outcome);
      await writeFile(join(dirname(inputs.reportFile), SUMMARY_FILE), outcome.summary);
    }
    if (outcome.ok && outcome.staged !== undefined) {
      // The hooks step runs this script with the runner's Node.js.
      core.setOutput("node", process.execPath);
      core.setOutput("hooks", hooksScript());
      core.setOutput("code", "");
      return;
    }
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
      core.setFailed(stoppedBeforeWritingMessage(operation, outcome));
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
