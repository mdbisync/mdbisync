// The sweeper removes what runs left behind: run branches and state refs,
// open pull requests of run branches, run projects and team-zone documents
// of runs. It removes a run's leftovers when the run is known to be dead
// (registered on this host, process gone) or when they are older than two
// hours and the run is not live. It never touches a live run, and it only
// ever matches names of the run patterns, so it is safe to run at any time.

import { RUN_ID_PATTERN } from './isolation.ts';
import type { LinearWorld } from './linear-world.ts';
import { deadLocalRuns, forgetRun, liveRuns } from './locks.ts';
import type { SandboxRest } from './github.ts';
import type { Sandbox } from './sandbox.ts';

export const SWEEP_AGE_MS = 2 * 3_600_000;

export interface SweepTargets {
  sandbox: Sandbox;
  rest: SandboxRest;
  world: LinearWorld;
  /** Team ids whose team-zone documents may hold run documents. */
  teamIds: string[];
}

export interface SweepReport {
  removedRefs: string[];
  closedPullRequests: number[];
  deletedProjects: string[];
  trashedDocuments: number;
  keptLive: string[];
  errors: string[];
}

export function shouldSweep(runId: string, createdAt: number | null, now: number, live: ReadonlySet<string>, dead: ReadonlySet<string>): boolean {
  if (!RUN_ID_PATTERN.test(runId) || live.has(runId)) return false;
  if (dead.has(runId)) return true;
  return createdAt !== null && now - createdAt > SWEEP_AGE_MS;
}

export async function sweep(targets: SweepTargets, stateDir: string, now = Date.now()): Promise<SweepReport> {
  const live = liveRuns(stateDir, now);
  const dead = deadLocalRuns(stateDir, now);
  const report: SweepReport = { removedRefs: [], closedPullRequests: [], deletedProjects: [], trashedDocuments: 0, keptLive: [...live].sort(), errors: [] };
  const attempt = async (what: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      report.errors.push(`${what}: ${(error as Error).message}`);
    }
  };

  // Git: group refs by run; a run's age is its tracked branch's (or any ref's) newest commit time.
  const refs = await targets.sandbox.runRefs();
  const byRun = new Map<string, Array<{ ref: string; oid: string }>>();
  for (const ref of refs) byRun.set(ref.runId, [...(byRun.get(ref.runId) ?? []), ref]);
  for (const [runId, runRefs] of byRun) {
    if (live.has(runId)) continue;
    let newest: number | null = null;
    if (!dead.has(runId)) {
      for (const ref of runRefs) {
        const time = await targets.sandbox.commitTime(ref.oid);
        if (time !== null) newest = Math.max(newest ?? 0, time);
      }
    }
    if (!shouldSweep(runId, newest, now, live, dead)) continue;
    await attempt(`refs of run ${runId}`, async () => {
      await targets.sandbox.deleteRunRefs(runId, runRefs.map((ref) => ref.ref));
      report.removedRefs.push(...runRefs.map((ref) => ref.ref));
    });
  }

  await attempt('pull requests', async () => {
    for (const pr of await targets.rest.pullRequests('t/', 'open')) {
      const runId = /^t\/([0-9a-f]{6})\//.exec(pr.head.ref)?.[1];
      if (runId === undefined || !shouldSweep(runId, Date.parse(pr.created_at), now, live, dead)) continue;
      await targets.rest.closePullRequest(pr.number);
      report.closedPullRequests.push(pr.number);
    }
  });

  await attempt('projects', async () => {
    for (const project of await targets.world.runProjects()) {
      if (!shouldSweep(project.runId, Date.parse(project.createdAt), now, live, dead)) continue;
      await targets.world.deleteProject(project, project.runId);
      report.deletedProjects.push(project.name);
    }
  });

  for (const teamId of targets.teamIds) {
    await attempt('team-zone documents', async () => {
      for (const document of await targets.world.runTeamDocuments(teamId)) {
        if (!shouldSweep(document.runId, Date.parse(document.createdAt), now, live, dead)) continue;
        await targets.world.trashRunDocument(document, document.runId);
        report.trashedDocuments += 1;
      }
    });
  }

  if (report.errors.length === 0) for (const runId of dead) forgetRun(stateDir, runId);
  return report;
}
