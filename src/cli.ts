#!/usr/bin/env node
// Command-line entry: `mdbisync <command>` and `mdbisync --version`.

import { appendFile } from "node:fs/promises";
import {
  COMMANDS,
  type CommandName,
  NO_STATE_EXIT_CODE,
  PREFLIGHT_COMMANDS,
  SETUP_FAILED_EXIT_CODE,
  USAGE_EXIT_CODE,
  isCommandName,
  notImplementedMessage,
} from "./commands.ts";
import { runFix, runLint } from "./format/command.ts";
import { writeRunReport } from "./run/finish.ts";
import { InputError, type InputName, environmentName, readInitialSyncInputs, readInputs } from "./run/inputs.ts";
import { runOperation } from "./run/operation.ts";
import { Git } from "./state/index.ts";
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
    warn: (message) => warnings.push(`warning: ${message}\n`),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (inputs.reportFile !== undefined) await writeRunReport(inputs.reportFile, outcome);
  // Inside a workflow step the summary also goes to the job summary.
  const summaryFile = env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) await appendFile(summaryFile, outcome.summary);
  const stderr = warnings.join("");
  if (!outcome.ok) {
    const exitCode = outcome.code === "initial-sync-required" ? NO_STATE_EXIT_CODE : SETUP_FAILED_EXIT_CODE;
    return { exitCode, stdout: outcome.summary, stderr: `${stderr}${command}: stopped before any write (${outcome.code})\n` };
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
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
