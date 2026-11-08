// The repository's pre-commit configuration, read from the tracked branch:
// which hooks are marked `alias: security`, and whether the Linear-format
// hook is configured.

import { parse } from 'yaml';
import { type CheckResult, failed, notChecked, passed } from './report.ts';

export const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml';
export const SECURITY_ALIAS = 'security';

export interface HookConfig {
  hooks: Array<{ id: string; alias?: string }>;
  /** Set when the file exists but is not a pre-commit configuration. */
  invalid?: string;
}

/** Reads `.pre-commit-config.yaml`; null text means the file does not exist. */
export function readHookConfig(text: string | null): HookConfig {
  if (text === null) return { hooks: [] };
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} is not valid YAML` };
  }
  const repos = isRecord(data) ? data.repos : undefined;
  if (!Array.isArray(repos)) return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} has no "repos" list` };
  const hooks: HookConfig['hooks'] = [];
  for (const repo of repos) {
    if (!isRecord(repo) || !Array.isArray(repo.hooks)) continue;
    for (const hook of repo.hooks) {
      if (!isRecord(hook) || typeof hook.id !== 'string') continue;
      hooks.push(typeof hook.alias === 'string' ? { id: hook.id, alias: hook.alias } : { id: hook.id });
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
 * PENDING: the Linear-format hook check. The hook and its id come with the
 * Linear-format normalizer; until then this item reports `not-checked` and
 * does not stop the run. An invalid configuration file already fails it.
 */
export function checkLinearFormatHookPending(config: HookConfig): CheckResult {
  if (config.invalid !== undefined) return failed('linear-format-hook', 'linear-format-hook-required', config.invalid);
  return notChecked('linear-format-hook', 'the Linear-format hook check is not implemented yet');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
