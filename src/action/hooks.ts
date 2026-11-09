// The hooks step of the staged security steps: runs the repository's
// security hooks on the sets of files the action's `stage` step left in the
// runner's temporary directory, and writes their findings beside them for
// the `apply` step.
//
// It runs as a plain step of its own, not as the action: its environment
// holds only what the workflow gives that step (the keys the deployer gives
// to hooks), so neither the hooks nor anything they can read of this
// process holds the Linear secret, the run's Linear token or the App token.
// It prints counts only, never content or hook output.

import { Git } from "../state/index.ts";
import { checkStaged, stageFolder } from "../sync/staged.ts";

const RUNNER_COMMAND_FILES = ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'];

export async function runHooksStep(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const git = new Git(env["GITHUB_WORKSPACE"] || process.cwd());
    // The runner's command files would let a hook set the environment, PATH or outputs of later steps.
    const hookEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !RUNNER_COMMAND_FILES.includes(entry[0])));
    const result = await checkStaged(git, stageFolder(env), hookEnv);
    console.log(`Security hooks: staged sets checked ${result.sets}, with findings ${result.rejected}, without an answer ${result.unanswered}.`);
    return 0;
  } catch (error) {
    console.log(`::error::security hooks: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runHooksStep();
}
