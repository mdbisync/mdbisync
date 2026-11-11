#!/usr/bin/env node
// Command-line entry: `mdbisync <command>` and `mdbisync --version`.

import { createInterface } from "node:readline/promises";
import { appendFile } from "node:fs/promises";
import {
  COMMANDS,
  type CommandName,
  PREFLIGHT_COMMANDS,
  USAGE_EXIT_CODE,
  isCommandName,
  notImplementedMessage,
} from "./commands.ts";
import { type LogEntry } from "./linear/index.ts";
import { type CheckClock } from "./pull-request/index.ts";
import { runFix, runLint } from "./format/command.ts";
import { runEnding } from "./run/exit.ts";
import { writeRunReport } from "./run/finish.ts";
import { outputText } from "./run/output.ts";
import { InputError, type InputName, environmentName, readInitialSyncInputs, readInputs } from "./run/inputs.ts";
import { type OperationOutcome, runOperation } from "./run/operation.ts";
import { Git } from "./state/index.ts";
import { runInit } from "./init/command.ts";
import { VERSION } from "./version.ts";
import { message } from "./messages.ts";

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
  /** Paces a sync run's waits for checks; real time when absent. */
  checkClock?: CheckClock;
  /** Explicit terminal prompt for repository setup; never opened by library calls. */
  prompt?: (question: string) => Promise<string>;
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
  const problem = first === undefined ? message('cli.missing-command') : message('cli.unknown-command', { command: first });
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
    ...(options.checkClock ? { checkClock: options.checkClock } : {}),
  });
  if (inputs.reportFile !== undefined) await writeRunReport(inputs.reportFile, outcome);
  // Inside a workflow step the summary also goes to the job summary.
  const summaryFile = env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) await appendFile(summaryFile, outputText(outcome.summary));
  return endedRun(outcome, warnings.join(""));
}

/** The command line's result for a run that ended: its summary, the warnings it gave, and its ending's line and exit code. */
export function endedRun(outcome: OperationOutcome, warnings: string): CliResult {
  const ending = runEnding(outcome);
  const line = ending.message === undefined ? "" : `${ending.status === "warning" ? "warning: " : ""}${ending.message}\n`;
  return { exitCode: ending.exitCode, stdout: outcome.summary, stderr: `${warnings}${line}` };
}

function notImplemented(command: CommandName): CliResult {
  return { exitCode: COMMANDS[command].notImplementedExitCode, stdout: "", stderr: `${notImplementedMessage(command)}\n` };
}

async function main(): Promise<void> {
  const terminal = process.argv[2] === "init" && process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const result = await runCli(process.argv.slice(2), {
      ...(terminal ? { prompt: (question: string) => terminal.question(question) } : {}),
      log: (entry) => { process.stderr.write(`${JSON.stringify(entry)}\n`); },
      warn: (message) => { process.stderr.write(`warning: ${message}\n`); },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    terminal?.close();
  }
}

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write(`${message('cli.node-too-old')}\n`);
  process.exitCode = USAGE_EXIT_CODE;
} else if (import.meta.main) {
  await main();
}
