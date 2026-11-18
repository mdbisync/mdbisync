// The repository's pre-commit configuration, read from the tracked branch:
// which hooks are marked `alias: security`, and whether the Linear-format
// hook is configured.

import { parseQuietly } from '../mapping/front-matter.ts';
import { type CheckResult, failed, passed, warning } from './report.ts';
import { message } from '../messages.ts';

export const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml';
export const SECURITY_ALIAS = 'security';
export const LINEAR_FORMAT_HOOK = 'linear-format';
/** The Gitleaks option that makes it ignore inline `gitleaks:allow` comments. */
export const IGNORE_INLINE_ALLOW = '--ignore-gitleaks-allow';
/** The option set to true, not merely named (`--ignore-gitleaks-allow=false` keeps the comments working). */
const IGNORES_INLINE_ALLOW = /(?:^|\s)--ignore-gitleaks-allow(?:=true)?(?=\s|$)/;
/** pre-commit's names for hooks defined in the repository itself or by pre-commit. */
export const LOCAL_REPOS: ReadonlySet<string> = new Set(['local', 'meta']);

export interface HookConfig {
  /** Every hook with the `repo` it comes from. */
  hooks: Array<{ id: string; repo: string; alias?: string; command?: string }>;
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
    return { hooks: [], invalid: message('setup.hooks-invalid-yaml', { file: PRE_COMMIT_CONFIG }) };
  }
  const repos = isRecord(data) ? data.repos : undefined;
  if (!Array.isArray(repos)) return { hooks: [], invalid: message('setup.hooks-no-repos', { file: PRE_COMMIT_CONFIG }) };
  const hooks: HookConfig['hooks'] = [];
  for (const repo of repos) {
    if (!isRecord(repo) || !Array.isArray(repo.hooks)) continue;
    const source = typeof repo.repo === 'string' ? repo.repo : '';
    for (const hook of repo.hooks) {
      if (!isRecord(hook) || typeof hook.id !== 'string') continue;
      const command = [hook.entry, ...(Array.isArray(hook.args) ? hook.args : [])].filter((part) => typeof part === 'string').join(' ');
      hooks.push({ id: hook.id, repo: source, ...(typeof hook.alias === 'string' ? { alias: hook.alias } : {}), ...(command ? { command } : {}) });
    }
  }
  return { hooks };
}

export function securityHooks(config: HookConfig): string[] {
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}

/**
 * Security hooks are recommended: without them the run goes on and says so.
 * Document text comes from Linear, so a Gitleaks security hook that honours
 * an inline `gitleaks:allow` comment is reported too.
 */
export function checkSecurityHooks(config: HookConfig): CheckResult {
  const ids = securityHooks(config);
  if (ids.length === 0) return warning('security-hooks', message('setup.security-hooks-missing', { alias: SECURITY_ALIAS }));
  const allowing = config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS && /gitleaks/i.test(`${hook.id} ${hook.command ?? ''}`) && !IGNORES_INLINE_ALLOW.test(hook.command ?? ''));
  if (allowing.length > 0) return warning('security-hooks', message('setup.security-hooks-inline-allow', { hooks: allowing.map((hook) => hook.id).join(', '), flag: IGNORE_INLINE_ALLOW }));
  return passed('security-hooks', `security hooks present: ${ids.join(', ')}`);
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
    : failed('linear-format-hook', 'linear-format-hook-required', message('setup.format-hook-missing', { file: PRE_COMMIT_CONFIG, hook: LINEAR_FORMAT_HOOK }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
