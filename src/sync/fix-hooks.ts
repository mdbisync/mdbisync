import { PRE_COMMIT_CONFIG, readHookConfig } from '../setup/hooks.ts';
import { type Git } from '../state/index.ts';

/** Hook ids recorded by CI on the latest commit that changed each left-out file. */
export async function nameFixingHooks(git: Git, tracked: string, files: Array<{ path: string; hooks?: string[] }>): Promise<void> {
  if (files.length === 0) return;
  const config = readHookConfig(await git.text(['show', `${tracked}:${PRE_COMMIT_CONFIG}`]));
  const configured = new Set(config.hooks.map((hook) => hook.id));
  for (const file of files) {
    // Path history follows a merged PR to the commit that supplied its tree.
    // Only the latest change counts: a later human edit must not inherit old attribution.
    const trailers = await git.text(['--literal-pathspecs', 'log', '-1', '--format=%(trailers:key=Pre-commit-fix,valueonly)', tracked, '--', file.path]);
    const hooks = [...new Set(trailers.split('\n').map((id) => id.trim()).filter((id) => configured.has(id)))].sort();
    if (hooks.length > 0) file.hooks = hooks;
  }
}
