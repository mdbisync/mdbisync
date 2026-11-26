// The repository's pre-commit configuration, read from the tracked branch:
// which hooks are marked `alias: security`, whether they can check files
// independently, and whether the Linear-format hook is configured.

import { isScalar, parseDocument, visit } from 'yaml';
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
const PRE_COMMIT_HOOKS = 'https://github.com/pre-commit/pre-commit-hooks';
const PRE_COMMIT_HOOKS_REV = '3e8a8703264a2f4a69428a0aa4dcb512790b2c8c';

export interface HookConfig {
  /** Every hook with the `repo` it comes from. */
  hooks: Array<{ id: string; repo: string; alias?: string; command?: string }>;
  /** Whether every hook selected by `pre-commit run security` checks each filename independently. */
  securityBatchable?: boolean;
  /** Set when the file exists but is not a pre-commit configuration. */
  invalid?: string;
}

/** Reads `.pre-commit-config.yaml`; null text means the file does not exist. */
export function readHookConfig(text: string | null): HookConfig {
  if (text === null) return { hooks: [] };
  let data: unknown;
  let merges: boolean;
  try {
    ({ data, merges } = parsePreCommitYaml(text));
  } catch {
    return { hooks: [], invalid: message('setup.hooks-invalid-yaml', { file: PRE_COMMIT_CONFIG }) };
  }
  const repos = isRecord(data) ? data.repos : undefined;
  if (!Array.isArray(repos)) return { hooks: [], invalid: message('setup.hooks-no-repos', { file: PRE_COMMIT_CONFIG }) };
  const hooks: HookConfig['hooks'] = [];
  // Remote hook defaults are not resolved here, and merged options are not
  // trusted to keep a hook file-local. Unknown effective aliases may select
  // hooks that inspect more than their file arguments.
  let securityBatchable = !merges && !/!!merge|!<|%TAG/.test(text);
  for (const repo of repos) {
    if (!isRecord(repo)) continue;
    if (!Array.isArray(repo.hooks)) continue;
    const pinned = repo.repo === PRE_COMMIT_HOOKS && repo.rev === PRE_COMMIT_HOOKS_REV;
    const source = typeof repo.repo === 'string' ? repo.repo : '';
    for (const hook of repo.hooks) {
      if (!isRecord(hook)) continue;
      if (typeof hook.id !== 'string') continue;
      if (selectedBySecurity(hook)) {
        securityBatchable &&= fileLocalHook(source, pinned, hook);
      } else if (typeof hook.alias !== 'string') {
        // The pinned manifest defines no aliases. Other remote hooks might.
        securityBatchable &&= LOCAL_REPOS.has(source) || pinned;
      }
      const command = [hook.entry, ...(Array.isArray(hook.args) ? hook.args : [])].filter((part) => typeof part === 'string').join(' ');
      hooks.push({ id: hook.id, repo: source, ...(typeof hook.alias === 'string' ? { alias: hook.alias } : {}), ...(command ? { command } : {}) });
    }
  }
  return { hooks, securityBatchable };
}

function fileLocalHook(repo: string, pinned: boolean, hook: Record<string, unknown>): boolean {
  // These options can select files and stages, but cannot change how a hook checks a file.
  const selection = ['id', 'name', 'alias', 'description', 'files', 'exclude', 'types', 'types_or', 'exclude_types', 'stages', 'require_serial', 'verbose', 'pass_filenames', 'always_run'];
  if (hook.pass_filenames !== undefined && hook.pass_filenames !== true) return false;
  if (hook.always_run !== undefined && hook.always_run !== false) return false;
  if (repo === 'local' && hook.language === 'pygrep') {
    // A leading dash is normally an option. The generated private-key pattern is a positional argument.
    const entry = hook.entry;
    return typeof entry === 'string' && (!entry.startsWith('-') || entry === '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----')
      && (hook.args === undefined || Array.isArray(hook.args) && hook.args.every((arg) => ['-i', '--ignore-case', '--multiline', '--negate'].includes(arg)))
      && Object.keys(hook).every((key) => [...selection, 'language', 'entry', 'args'].includes(key));
  }
  // Only this pinned implementation is known to read the filenames independently.
  return pinned && hook.id === 'detect-private-key' && Object.keys(hook).every((key) => selection.includes(key));
}

/** `pre-commit run security` selects the hooks whose alias or id is `security`. */
function selectedBySecurity(hook: { id?: unknown; alias?: unknown }): boolean {
  return hook.alias === SECURITY_ALIAS || hook.id === SECURITY_ALIAS;
}

export function securityHooks(config: HookConfig): string[] {
  return config.hooks.filter(selectedBySecurity).map((hook) => hook.id);
}

/**
 * Security hooks are recommended: without them the run goes on and says so.
 * Document text comes from Linear, so a Gitleaks security hook that honours
 * an inline `gitleaks:allow` comment is reported too.
 */
export function checkSecurityHooks(config: HookConfig): CheckResult {
  const ids = securityHooks(config);
  if (ids.length === 0) return warning('security-hooks', message('setup.security-hooks-missing', { alias: SECURITY_ALIAS }));
  const allowing = config.hooks.filter((hook) => selectedBySecurity(hook) && /gitleaks/i.test(`${hook.id} ${hook.command ?? ''}`) && !IGNORES_INLINE_ALLOW.test(hook.command ?? ''));
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

/**
 * Parses the configuration as pre-commit does: PyYAML resolves merge keys
 * (`<<: *defaults`), so a hook can get its alias from a merged map. `merges`
 * tells whether any map has a `<<` key. Throws on invalid YAML, without the
 * source in the message, and on a map with two merge keys: PyYAML takes the
 * last one's values and this parser the first one's.
 */
function parsePreCommitYaml(text: string): { data: unknown; merges: boolean } {
  const doc = parseDocument(text, { merge: true, logLevel: 'error', prettyErrors: false });
  if (doc.errors.length > 0) throw new Error();
  let merges = false;
  visit(doc, {
    Map(_, map) {
      // A resolved merge key is a symbol; a quoted `"<<"` stays a string.
      const keys = map.items.filter(({ key }) => isScalar(key) && (typeof key.value === 'symbol' || key.value === '<<'));
      if (keys.filter(({ key }) => isScalar(key) && typeof key.value === 'symbol').length > 1) throw new Error();
      merges ||= keys.length > 0;
    },
  });
  return { data: doc.toJS(), merges };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
