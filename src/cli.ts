#!/usr/bin/env node
// Command-line entry: `mdbisync <command>` and `mdbisync --version`.

import { COMMANDS, USAGE_EXIT_CODE, isCommandName, notImplementedMessage } from "./commands.ts";
import { runFix, runLint } from "./format/command.ts";
import { VERSION } from "./version.ts";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(([name, info]) => `  ${name.padEnd(width)}  ${info.summary}`);
  return ["Usage: mdbisync <command> [paths...]", "", "Commands:", ...lines, "", "Options:", "  --version  Print the version", "  --help     Print this help", ""].join("\n");
}

export function runCli(args: readonly string[]): CliResult {
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
    return { exitCode: COMMANDS[first].notImplementedExitCode, stdout: "", stderr: `${notImplementedMessage(first)}\n` };
  }
  const problem = first === undefined ? "missing command" : `unknown command: ${first}`;
  return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${problem}\n\n${usage()}` };
}

function main(): void {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (import.meta.main) {
  main();
}
