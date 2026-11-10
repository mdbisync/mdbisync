// Where the sync keeps its state: the tracked branch, the sync branch and
// the prefix of the three state refs. The defaults are the names the sync
// uses in a real repository; tests give each run its own names.

import { message } from '../messages.ts';

export const STORES = ['linear', 'ids', 'uploads'] as const;
export type Store = (typeof STORES)[number];

export interface StateConfig {
  /** The remote the state is fetched from and pushed to. */
  remote: string;
  /** The branch people work on, which the sync keeps equal to Linear. */
  trackedBranch: string;
  /** The branch of the sync pull request. */
  syncBranch: string;
  /** The prefix of the state refs `<prefix>/linear`, `<prefix>/ids` and `<prefix>/uploads`. */
  refPrefix: string;
}

export const DEFAULT_STATE_CONFIG: Readonly<StateConfig> = Object.freeze({
  remote: 'origin',
  trackedBranch: 'main',
  syncBranch: 'mdbisync/linear',
  refPrefix: 'refs/mdbisync',
});

export class StateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateConfigError';
  }
}

/** Fills in defaults for empty or missing values and checks every name. */
export function resolveStateConfig(input: Partial<StateConfig> = {}): StateConfig {
  const pick = (key: keyof StateConfig): string => {
    const value = input[key];
    return value === undefined || value.trim() === '' ? DEFAULT_STATE_CONFIG[key] : value.trim();
  };
  const config: StateConfig = {
    remote: pick('remote'),
    trackedBranch: pick('trackedBranch'),
    syncBranch: pick('syncBranch'),
    refPrefix: pick('refPrefix').replace(/\/+$/, ''),
  };

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.remote)) {
    throw new StateConfigError(message('config.invalid-remote', { remote: config.remote }));
  }
  for (const key of ['trackedBranch', 'syncBranch'] as const) {
    const problem = refNameProblem(`refs/heads/${config[key]}`) ?? (config[key].startsWith('-') ? message('config.starts-with-dash') : null);
    if (problem !== null) throw new StateConfigError(message('config.invalid-branch', { key, branch: config[key], problem }));
  }
  const suspended = suspendedBranch(config);
  if (config.trackedBranch === config.syncBranch || config.trackedBranch === suspended) {
    throw new StateConfigError(message('config.same-branches'));
  }
  // git cannot hold both "a" and "a/b" as refs.
  if (config.syncBranch.startsWith(`${config.trackedBranch}/`) || config.trackedBranch.startsWith(`${config.syncBranch}/`)) {
    throw new StateConfigError(message('config.nested-branches'));
  }
  if (suspended.startsWith(`${config.trackedBranch}/`) || config.trackedBranch.startsWith(`${suspended}/`)) throw new StateConfigError(message('config.nested-branches'));
  const prefixProblem = refNameProblem(`${config.refPrefix}/linear`);
  if (prefixProblem !== null) {
    throw new StateConfigError(message('config.invalid-prefix', { prefix: config.refPrefix, problem: prefixProblem }));
  }
  if (!/^refs\/[^/]/.test(config.refPrefix)) {
    throw new StateConfigError(message('config.prefix-outside-refs', { prefix: config.refPrefix }));
  }
  if (/^refs\/(heads|tags|remotes)(\/|$)/.test(config.refPrefix)) {
    throw new StateConfigError(message('config.prefix-reserved', { prefix: config.refPrefix }));
  }
  return config;
}

export function stateRef(config: StateConfig, store: Store): string {
  return `${config.refPrefix}/${store}`;
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/**
 * The local ref that holds the last value seen on the remote: branches go to
 * `refs/remotes/<remote>/`, the state refs keep their own names.
 */
export function localRef(config: StateConfig, remoteRef: string): string {
  return remoteRef.startsWith('refs/heads/')
    ? `refs/remotes/${config.remote}/${remoteRef.slice('refs/heads/'.length)}`
    : remoteRef;
}

/** Returns why `name` is not a valid full ref name (the rules of `git check-ref-format`), or null. */
export function refNameProblem(name: string): string | null {
  if (!name.startsWith('refs/')) return 'does not start with "refs/"';
  if (name.endsWith('/')) return 'ends with "/"';
  if (name.endsWith('.')) return 'ends with "."';
  if (name.includes('//')) return 'contains "//"';
  if (name.includes('..')) return 'contains ".."';
  if (name.includes('@{')) return 'contains "@{"';
  // Control characters, space and the characters git forbids.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'contains a character git does not allow';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'has a part starting with "."';
    if (part.endsWith('.lock')) return 'has a part ending with ".lock"';
  }
  return null;
}

/** The second lane shares the configured namespace of the normal branch. */
export function suspendedBranch(config: StateConfig): string {
  return !config.syncBranch.includes('/') || config.syncBranch.endsWith('/suspended')
    ? `${config.syncBranch}-suspended` : config.syncBranch.replace(/[^/]+$/, 'suspended');
}
