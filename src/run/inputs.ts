// The run's inputs. The action reads them as action inputs; the command line
// reads the same names from `MDBISYNC_*` environment variables (secrets do
// not belong in arguments). Empty means "not given".

import { DIRECTIONS, type Direction } from '../initial-sync/summary.ts';
import { type StateConfig, StateConfigError, resolveStateConfig } from '../state/index.ts';

export const INPUT_NAMES = [
  'linear-client-id',
  'linear-client-secret',
  'linear-api-url',
  'github-token',
  'github-api-url',
  'repository',
  'tracked-branch',
  'sync-branch',
  'state-ref-prefix',
  'report-file',
  'direction',
  'confirm',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

export interface RunInputs {
  linear: { clientId: string; clientSecret: string; apiUrl?: string };
  github: { token: string; apiUrl?: string; repository: string };
  state: StateConfig;
  /** Where to write the run's report as JSON; for tests and tooling. */
  reportFile?: string;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** The environment variable the command line reads an input from. */
export function environmentName(name: InputName): string {
  return `MDBISYNC_${name.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Reads and checks the inputs. `repository` falls back to the runner's
 * `GITHUB_REPOSITORY`, the API URLs to the public services.
 */
export function readInputs(get: (name: InputName) => string, env: NodeJS.ProcessEnv = process.env): RunInputs {
  const value = (name: InputName): string => get(name).trim();
  const required = (name: InputName): string => {
    const given = value(name);
    if (given === '') throw new InputError(`the input ${name} is required`);
    return given;
  };
  const linear = { clientId: required('linear-client-id'), clientSecret: required('linear-client-secret') };
  const token = required('github-token');
  const repository = value('repository') || (env.GITHUB_REPOSITORY ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new InputError('the input repository must be "owner/name" (it defaults to the workflow\'s repository)');
  }
  const inputs: RunInputs = {
    linear,
    github: { token, repository },
    state: stateConfig(value('tracked-branch'), value('sync-branch'), value('state-ref-prefix')),
  };
  const linearApiUrl = value('linear-api-url');
  if (linearApiUrl !== '') inputs.linear.apiUrl = linearApiUrl;
  const githubApiUrl = value('github-api-url') || (env.GITHUB_API_URL ?? '').trim();
  if (githubApiUrl !== '') inputs.github.apiUrl = githubApiUrl;
  const reportFile = value('report-file');
  if (reportFile !== '') inputs.reportFile = reportFile;
  return inputs;
}

/** The initial sync's own inputs. */
export interface InitialSyncInputs {
  direction: Direction;
  /** Only the exact value `true` confirms; anything else is a dry run. */
  confirm: boolean;
}

/** Reads `direction` (required, no default) and `confirm` for an initial sync. */
export function readInitialSyncInputs(get: (name: InputName) => string): InitialSyncInputs {
  const direction = get('direction').trim();
  if (!(DIRECTIONS as readonly string[]).includes(direction)) {
    const given = direction === '' ? 'is required' : `must be one of ${DIRECTIONS.join(', ')}, not "${direction}"`;
    throw new InputError(`the input direction ${given} (initial sync never picks a direction itself)`);
  }
  return { direction: direction as Direction, confirm: get('confirm').trim() === 'true' };
}

function stateConfig(trackedBranch: string, syncBranch: string, refPrefix: string): StateConfig {
  try {
    return resolveStateConfig({ trackedBranch, syncBranch, refPrefix });
  } catch (error) {
    if (error instanceof StateConfigError) throw new InputError(error.message);
    throw error;
  }
}
