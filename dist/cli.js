#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/commands.ts
var COMMANDS = {
  sync: { summary: "Sync Markdown files and Linear documents both ways", notImplementedExitCode: 10 },
  "initial-sync": { summary: "Make one side match the other before the first sync", notImplementedExitCode: 11 },
  lint: { summary: "Report Markdown that Linear would change", notImplementedExitCode: 12 },
  fix: { summary: "Rewrite Markdown into the form Linear keeps", notImplementedExitCode: 13 },
  init: { summary: "Write the workflows and configuration into a repository", notImplementedExitCode: 14 },
  check: { summary: "Check the setup without writing anything", notImplementedExitCode: 15 }
};
var USAGE_EXIT_CODE = 2;
function isCommandName(value) {
  return Object.hasOwn(COMMANDS, value);
}
function notImplementedMessage(command) {
  return `${command}: not implemented`;
}

// src/version.ts
var VERSION = true ? "0.1.0-rc.1" : packageJson.version;

// src/cli.ts
function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(([name, info]) => `  ${name.padEnd(width)}  ${info.summary}`);
  return ["Usage: mdbisync <command>", "", "Commands:", ...lines, "", "Options:", "  --version  Print the version", "  --help     Print this help", ""].join("\n");
}
function runCli(args) {
  const [first] = args;
  if (first === "--version") {
    return { exitCode: 0, stdout: `${VERSION}
`, stderr: "" };
  }
  if (first === "--help" || first === "-h") {
    return { exitCode: 0, stdout: usage(), stderr: "" };
  }
  if (first !== void 0 && isCommandName(first)) {
    return { exitCode: COMMANDS[first].notImplementedExitCode, stdout: "", stderr: `${notImplementedMessage(first)}
` };
  }
  const problem = first === void 0 ? "missing command" : `unknown command: ${first}`;
  return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${problem}

${usage()}` };
}
function main() {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
if (import.meta.main) {
  main();
}
export {
  runCli,
  usage
};
