// The commands of the command-line entry and their exit codes.
// `sync`, `initial-sync` and `check` run the preflight (the sync's state and
// the setup check). A command that is not built yet reports "not implemented"
// and exits with its own code, so callers and tests can tell the stubs apart.

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

/** Commands that run the preflight. */
export const PREFLIGHT_COMMANDS = ["sync", "initial-sync", "check"] as const satisfies readonly CommandName[];

export const USAGE_EXIT_CODE = 2;
/** The setup check failed; nothing was written. */
export const SETUP_FAILED_EXIT_CODE = 3;
/**
 * The sync has no state, or its state waits for a person to merge the
 * initial sync's pull request; nothing was written.
 */
export const NO_STATE_EXIT_CODE = 4;
/**
 * A confirmed initial sync wrote part of its work and stopped; a sync run is
 * partial (Linear stopped it with a rate limit or a low budget, before or
 * while writing, a write failed or was rejected, or a state ref moved) and
 * the next run goes on; or Linear stopped another operation before any
 * write. Run it again with the same inputs.
 */
export const INCOMPLETE_EXIT_CODE = 5;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}

/** Commands that run; the others are stubs. */
export const IMPLEMENTED: ReadonlySet<CommandName> = new Set(["lint", "fix"]);

export function notImplementedMessage(command: string): string {
  return `${command}: not implemented`;
}
