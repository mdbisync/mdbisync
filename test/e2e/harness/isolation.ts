// A scenario run's own names in git and Linear, and the patterns the sweeper
// uses to find what a run left behind.
//
// Every name carries the run id (six hex characters). Linear names are
// neutral work text: they say nothing about the tool under test.

import { randomBytes } from 'node:crypto';

export const RUN_ID_PATTERN = /^[0-9a-f]{6}$/;
/** Branches of runs: t/<run>/main, t/<run>/sync and the scheduled-run request t/<run>/schedule. */
export const RUN_BRANCH_PATTERN = /^refs\/heads\/t\/([0-9a-f]{6})\/(?:main|sync|schedule)$/;
/** State refs of runs: refs/mdbisync-t/<run>/<store>. */
export const RUN_STATE_REF_PATTERN = /^refs\/mdbisync-t\/([0-9a-f]{6})\/[a-z]+$/;
/** Run projects: "<two words> <run>". */
export const RUN_PROJECT_PATTERN = /^[A-Z][a-z]+ [a-z]+ ([0-9a-f]{6})$/;
/** Team-zone document titles start with "<run>/". */
export const RUN_TEAM_TITLE_PATTERN = /^([0-9a-f]{6})\//;

/** Neutral project names; the run id follows. */
const PROJECT_WORDS = [
  'Field notes',
  'Garden plans',
  'Harbor log',
  'Kitchen guide',
  'Library index',
  'Market study',
  'River survey',
  'Studio handbook',
  'Workshop agenda',
  'Orchard calendar',
  'Lighthouse journal',
] as const;

/**
 * Names of the run's helper projects, one per purpose so a run never holds two live projects with one name.
 * None is one of PROJECT_WORDS, so no annotation names a helper; each matches the run-project pattern, so
 * cleanup and the sweeper find it.
 */
const HELPER_PROJECT_WORDS = { archive: 'Spare shelf', unmapped: 'Spare drawer', 'archived-copy': 'Spare binder' } as const;
export type HelperPurpose = keyof typeof HELPER_PROJECT_WORDS;

export function newRunId(): string {
  return randomBytes(3).toString('hex');
}

export interface RunNames {
  runId: string;
  trackedBranch: string;
  syncBranch: string;
  refPrefix: string;
  /**
   * The branch that asks the sandbox's scheduled workflow for one scheduled
   * sync of this run (workflow-files.ts, renderScheduler). The scheduled run
   * deletes it when it takes the request.
   */
  scheduleRequest: string;
  /** Title prefix of the run's team-zone documents. */
  teamZonePrefix: string;
  /** The i-th project of the run (0-based), for the corpus's project placeholders. */
  project(index: number): string;
  /**
   * A project no annotation names: for the harness's own helpers (an unmapped
   * project, the project that archives team-zone documents). Its name is never
   * a placeholder's, so the engine never maps it, however many placeholders
   * the corpus has.
   */
  helperProject(purpose: HelperPurpose): string;
}

export function runNames(runId: string): RunNames {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`run id must be six hex characters: ${runId}`);
  return {
    runId,
    trackedBranch: `t/${runId}/main`,
    syncBranch: `t/${runId}/sync`,
    refPrefix: `refs/mdbisync-t/${runId}`,
    scheduleRequest: `t/${runId}/schedule`,
    teamZonePrefix: `${runId}/`,
    project(index: number): string {
      const words = PROJECT_WORDS[index];
      if (words === undefined) throw new Error(`a run has at most ${PROJECT_WORDS.length} projects`);
      return `${words} ${runId}`;
    },
    helperProject(purpose: HelperPurpose): string {
      return `${HELPER_PROJECT_WORDS[purpose]} ${runId}`;
    },
  };
}

/** The run id a git ref belongs to, or null when it is no run's. */
export function runOfRef(ref: string): string | null {
  return RUN_BRANCH_PATTERN.exec(ref)?.[1] ?? RUN_STATE_REF_PATTERN.exec(ref)?.[1] ?? null;
}

/** The run id a Linear project belongs to, or null when it is no run's. */
export function runOfProject(name: string): string | null {
  const match = RUN_PROJECT_PATTERN.exec(name);
  if (match === null) return null;
  return [...PROJECT_WORDS, ...Object.values(HELPER_PROJECT_WORDS)].some((words) => name === `${words} ${match[1]}`) ? (match[1] as string) : null;
}

/** The run id of a team-zone document title, or null. */
export function runOfTeamTitle(title: string): string | null {
  return RUN_TEAM_TITLE_PATTERN.exec(title)?.[1] ?? null;
}
