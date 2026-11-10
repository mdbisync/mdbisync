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
  'app-slug',
  'github-api-url',
  'repository',
  'tracked-branch',
  'sync-branch',
  'state-ref-prefix',
  'report-file',
  'document-cap',
  'merge-grace-seconds',
  'direction',
  'confirm',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

export interface RunInputs {
  linear: { clientId: string; clientSecret: string; apiUrl?: string };
  /**
   * `appSlug`: the slug of the GitHub App whose installation token `token`
   * is; the sync's commits name the App's bot account as their author.
   */
  github: { token: string; apiUrl?: string; repository: string; appSlug?: string };
  state: StateConfig;
  /** Where to write the run's report as JSON; for tests and tooling. */
  reportFile?: string;
  documentCap?: number;
  mergeGraceSeconds?: number;
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

export interface ReadInputsOptions {
  /**
   * The action runs with the App's token only, so it needs the App's slug.
   * The command line may run without it; its commits then name
   * `mdbisync <mdbisync@sync.invalid>`.
   */
  appSlugRequired?: boolean;
}

/** A GitHub App slug: letters, digits and single hyphens between them. */
const APP_SLUG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * Reads and checks the inputs. `repository` falls back to the runner's
 * `GITHUB_REPOSITORY`, the API URLs to the public services.
 */
export function readInputs(get: (name: InputName) => string, env: NodeJS.ProcessEnv = process.env, options: ReadInputsOptions = {}): RunInputs {
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
  const appSlug = value('app-slug');
  if (appSlug === '' && options.appSlugRequired === true) {
    throw new InputError("the input app-slug is required: give it the App token step's output app-slug");
  }
  if (appSlug !== '') {
    if (!APP_SLUG.test(appSlug)) throw new InputError('the input app-slug must be a GitHub App slug (letters, digits and hyphens)');
    inputs.github.appSlug = appSlug;
  }
  const linearApiUrl = value('linear-api-url');
  if (linearApiUrl !== '') inputs.linear.apiUrl = linearApiUrl;
  const githubApiUrl = value('github-api-url') || (env.GITHUB_API_URL ?? '').trim();
  if (githubApiUrl !== '') inputs.github.apiUrl = githubApiUrl;
  const reportFile = value('report-file');
  if (reportFile !== '') inputs.reportFile = reportFile;
  const cap = value('document-cap');
  if (cap !== '') {
    if (!/^[1-9][0-9]*$/.test(cap) || !Number.isSafeInteger(Number(cap))) throw new InputError('the input document-cap must be a positive safe integer');
    inputs.documentCap = Number(cap);
  }
  const grace = value('merge-grace-seconds');
  if (grace !== '') {
    if (!/^(0|[1-9][0-9]*)$/.test(grace) || Number(grace) > 120) throw new InputError('the input merge-grace-seconds must be an integer from 0 to 120');
    inputs.mergeGraceSeconds = Number(grace);
  }
  return inputs;
}

function stateConfig(trackedBranch: string, syncBranch: string, refPrefix: string): StateConfig {
  try {
    return resolveStateConfig({ trackedBranch, syncBranch, refPrefix });
  } catch (error) {
    if (error instanceof StateConfigError) throw new InputError(error.message);
    throw error;
  }
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
