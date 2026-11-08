// The commands of the command-line entry and their exit codes.
// `sync`, `initial-sync` and `check` run the preflight (the sync's state and
// the setup check); `lint` and `fix` check and rewrite Markdown files. A
// command that is not built yet reports "not implemented" and exits with its
// own code, so callers and tests can tell the stubs apart.

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
  check: { summary: "Check the setup without changing Linear or the remote repository", notImplementedExitCode: 15 },
} as const satisfies Record<string, CommandInfo>;

export type CommandName = keyof typeof COMMANDS;

/** Commands that check or rewrite Markdown files given as paths. */
export const FORMAT_COMMANDS = ["lint", "fix"] as const satisfies readonly CommandName[];

/** Commands that run the preflight. */
export const PREFLIGHT_COMMANDS = ["sync", "initial-sync", "check"] as const satisfies readonly CommandName[];

export const USAGE_EXIT_CODE = 2;
/** The setup check failed; nothing was written. */
export const SETUP_FAILED_EXIT_CODE = 3;
/** The sync has no state; nothing was written; run initial sync first. */
export const NO_STATE_EXIT_CODE = 4;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}

export function notImplementedMessage(command: string): string {
  return `${command}: not implemented`;
}
