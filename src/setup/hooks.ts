// The repository's pre-commit configuration, read from the tracked branch:
// which hooks are marked `alias: security`, and whether the Linear-format
// hook is configured.

import { parseQuietly } from '../mapping/front-matter.ts';
import { type CheckResult, failed, passed } from './report.ts';

export const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml';
export const SECURITY_ALIAS = 'security';
export const LINEAR_FORMAT_HOOK = 'linear-format';
/** pre-commit's names for hooks defined in the repository itself or by pre-commit. */
const LOCAL_REPOS: ReadonlySet<string> = new Set(['local', 'meta']);

export interface HookConfig {
  /** Every hook with the `repo` it comes from. */
  hooks: Array<{ id: string; repo: string; alias?: string }>;
  /** Set when the file exists but is not a pre-commit configuration. */
  invalid?: string;
}

/** Reads `.pre-commit-config.yaml`; null text means the file does not exist. */
export function readHookConfig(text: string | null): HookConfig {
  if (text === null) return { hooks: [] };
  let data: unknown;
  try {
    data = parseQuietly(text);
  } catch {
    return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} is not valid YAML` };
  }
  const repos = isRecord(data) ? data.repos : undefined;
  if (!Array.isArray(repos)) return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} has no "repos" list` };
  const hooks: HookConfig['hooks'] = [];
  for (const repo of repos) {
    if (!isRecord(repo) || !Array.isArray(repo.hooks)) continue;
    const source = typeof repo.repo === 'string' ? repo.repo : '';
    for (const hook of repo.hooks) {
      if (!isRecord(hook) || typeof hook.id !== 'string') continue;
      hooks.push(typeof hook.alias === 'string' ? { id: hook.id, repo: source, alias: hook.alias } : { id: hook.id, repo: source });
    }
  }
  return { hooks };
}

export function securityHooks(config: HookConfig): string[] {
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}

/** Security hooks are recommended: without them the run goes on and says so. */
export function checkSecurityHooks(config: HookConfig): CheckResult {
  const ids = securityHooks(config);
  if (ids.length > 0) return passed('security-hooks', `security hooks present: ${ids.join(', ')}`);
  return { name: 'security-hooks', state: 'warning', detail: `no pre-commit hook marked "alias: ${SECURITY_ALIAS}": content is pushed unchecked` };
}

/**
 * The Linear-format hook is required: without it, files reach Linear in a
 * form Linear rewrites. It counts when a repository entry (not `local` or
 * `meta`) lists the hook id, so the hook runs this project's released code.
 */
export function checkLinearFormatHook(config: HookConfig): CheckResult {
  if (config.invalid !== undefined) return failed('linear-format-hook', 'linear-format-hook-required', config.invalid);
  const configured = config.hooks.some((hook) => hook.id === LINEAR_FORMAT_HOOK && !LOCAL_REPOS.has(hook.repo));
  return configured
    ? passed('linear-format-hook', `${PRE_COMMIT_CONFIG} has the ${LINEAR_FORMAT_HOOK} hook`)
    : failed('linear-format-hook', 'linear-format-hook-required', `${PRE_COMMIT_CONFIG} has no ${LINEAR_FORMAT_HOOK} hook`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
