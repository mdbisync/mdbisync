// The commands of the command-line entry and their exit codes.
// A command that is not built yet reports "not implemented" and exits with
// its own code, so callers and tests can tell the stubs apart.

export interface CommandInfo {
  readonly summary: string;
  readonly notImplementedExitCode: number;
}

export const COMMANDS = {
  sync: { summary: "Sync Markdown files and Linear documents both ways", notImplementedExitCode: 10 },
  "initial-sync": { summary: "Make one side match the other before the first sync", notImplementedExitCode: 11 },
  lint: { summary: "Report Markdown that Linear would change", notImplementedExitCode: 12 },
  fix: { summary: "Rewrite Markdown into the form Linear keeps", notImplementedExitCode: 13 },
  init: { summary: "Write the workflows and configuration into a repository", notImplementedExitCode: 14 },
  check: { summary: "Check the setup without writing anything", notImplementedExitCode: 15 },
} as const satisfies Record<string, CommandInfo>;

export type CommandName = keyof typeof COMMANDS;

export const USAGE_EXIT_CODE = 2;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}

/** Commands that run; the others are stubs. */
export const IMPLEMENTED: ReadonlySet<CommandName> = new Set(["lint", "fix"]);

export function notImplementedMessage(command: string): string {
  return `${command}: not implemented`;
}
