#!/usr/bin/env node
// Command-line entry: `mdbisync <command>` and `mdbisync --version`.

import { appendFile } from "node:fs/promises";
import {
  COMMANDS,
  INCOMPLETE_EXIT_CODE,
  type CommandName,
  NO_STATE_EXIT_CODE,
  PREFLIGHT_COMMANDS,
  SETUP_FAILED_EXIT_CODE,
  USAGE_EXIT_CODE,
  isCommandName,
  notImplementedMessage,
} from "./commands.ts";
import { type LogEntry } from "./linear/index.ts";
import { runFix, runLint } from "./format/command.ts";
import { PARTIAL, partialCode, pullRequestEnding, stoppedBeforeWritingMessage, stoppedMessage } from "./run/exit.ts";
import { unfinishedMessage, writeRunReport } from "./run/finish.ts";
import { InputError, type InputName, environmentName, readInitialSyncInputs, readInputs } from "./run/inputs.ts";
import { runOperation } from "./run/operation.ts";
import { Git } from "./state/index.ts";
import { runInit, runTerminalInit } from "./init/command.ts";
import { VERSION } from "./version.ts";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  /** The repository the command works in. */
  cwd?: string;
  fetch?: typeof fetch;
  /** Optional immediate sinks for callers that need diagnostics even on rejection. */
  log?: (entry: LogEntry) => void;
  warn?: (message: string) => void;
}

export function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(([name, info]) => `  ${name.padEnd(width)}  ${info.summary}`);
  return [
    "Usage: mdbisync <command> [paths...]",
    "",
    "Commands:",
    ...lines,
    "",
    "init --help lists the repository setup flags.",
    "",
    "Options:",
    "  --version  Print the version",
    "  --help     Print this help",
    "",
    "sync, initial-sync and check read their inputs from MDBISYNC_* environment",
    "variables, for example MDBISYNC_LINEAR_CLIENT_ID for the input linear-client-id.",
    "initial-sync also needs MDBISYNC_DIRECTION (git-to-linear or linear-to-git);",
    "it writes only with MDBISYNC_CONFIRM=true, otherwise it is a dry run.",
    "",
  ].join("\n");
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  const [first] = args;
  if (first === "--version") {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  if (first === "--help" || first === "-h") {
    return { exitCode: 0, stdout: usage(), stderr: "" };
  }
  if (first === "init") return runInit(args.slice(1), options);
  if (first === "lint") return runLint(args.slice(1));
  if (first === "fix") return runFix(args.slice(1));
  if (first !== undefined && isCommandName(first)) {
    if ((PREFLIGHT_COMMANDS as readonly string[]).includes(first)) {
      return runPreflightCommand(first as (typeof PREFLIGHT_COMMANDS)[number], options);
    }
    return notImplemented(first);
  }
  const problem = first === undefined ? "missing command" : `unknown command: ${first}`;
  return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${problem}\n\n${usage()}` };
}

async function runPreflightCommand(command: (typeof PREFLIGHT_COMMANDS)[number], options: CliOptions): Promise<CliResult> {
  const env = options.env ?? process.env;
  const input = (name: InputName) => env[environmentName(name)] ?? "";
  let inputs;
  let initialSync;
  try {
    inputs = readInputs(input, env);
    if (command === "initial-sync") initialSync = readInitialSyncInputs(input);
  } catch (error) {
    if (error instanceof InputError) return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${command}: ${error.message}\n` };
    throw error;
  }
  const warnings: string[] = [];
  const outcome = await runOperation(command, inputs, initialSync, {
    git: new Git(options.cwd ?? process.cwd()),
    warn: (message) => {
      if (options.warn) options.warn(message);
      else warnings.push(`warning: ${message}\n`);
    },
    log: options.log ?? (() => {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (inputs.reportFile !== undefined) await writeRunReport(inputs.reportFile, outcome);
  // Inside a workflow step the summary also goes to the job summary.
  const summaryFile = env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) await appendFile(summaryFile, outcome.summary);
  const stderr = warnings.join("");
  // A failed check on the sync pull request is a setup error: a person fixes it, so it comes before a partial ending.
  const failure = pullRequestEnding(outcome);
  if (failure !== null) {
    const exitCode = failure.kind === "setup" ? SETUP_FAILED_EXIT_CODE : failure.kind === "no-state" ? NO_STATE_EXIT_CODE : INCOMPLETE_EXIT_CODE;
    return { exitCode, stdout: outcome.summary, stderr: `${stderr}${command}: ${failure.message}\n` };
  }
  // A partial run recorded what it finished; the next run goes on from there.
  const partial = partialCode(outcome);
  if (partial !== undefined) {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome.summary, stderr: `${stderr}warning: ${command}: ${PARTIAL} (${partial})\n` };
  }
  const stopped = stoppedMessage(outcome);
  if (stopped !== undefined) return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome.summary, stderr: `${stderr}${stopped}\n` };
  if (!outcome.ok) {
    const exitCode = outcome.code === "initial-sync-required" || outcome.code === "initial-pull-request-pending" ? NO_STATE_EXIT_CODE : SETUP_FAILED_EXIT_CODE;
    return { exitCode, stdout: outcome.summary, stderr: `${stderr}${stoppedBeforeWritingMessage(command, outcome)}\n` };
  }
  if (outcome.confirmed?.code === 'container-cap' || outcome.sync?.write?.code === 'container-cap') {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome.summary, stderr: `${stderr}${command}: stopped before any write (container-cap); reduce additions or check document-cap\n` };
  }
  const unfinished = outcome.confirmed ?? outcome.reverse;
  if (unfinished !== undefined && !unfinished.complete) {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome.summary, stderr: `${stderr}${unfinishedMessage(command, unfinished.code)}\n` };
  }
  if (!outcome.notImplemented) return { exitCode: 0, stdout: outcome.summary, stderr };
  const stub = notImplemented(command);
  return { ...stub, stdout: outcome.summary, stderr: `${stderr}${stub.stderr}` };
}

function notImplemented(command: CommandName): CliResult {
  return { exitCode: COMMANDS[command].notImplementedExitCode, stdout: "", stderr: `${notImplementedMessage(command)}\n` };
}

async function main(): Promise<void> {
  try {
    const result = process.argv[2] === "init" ? await runTerminalInit(process.argv.slice(3)) : await runCli(process.argv.slice(2), {
      log: (entry) => { process.stderr.write(`${JSON.stringify(entry)}\n`); },
      warn: (message) => { process.stderr.write(`warning: ${message}\n`); },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("mdbisync requires Node 24 or newer; install it before running the hook.\n");
  process.exitCode = USAGE_EXIT_CODE;
} else if (import.meta.main) {
  await main();
}
