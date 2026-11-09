// The sweeper removes what runs left behind: run branches and state refs,
// open pull requests of run branches, run projects and team-zone documents
// of runs. It removes a run's leftovers when the run is known to be dead
// (registered on this host, process gone) or when they are older than two
// hours and the run is not live. It never touches a live run, and it only
// ever matches names of the run patterns, so it is safe to run at any time.
//
// A dead run with an ownership record is recovered from that record alone,
// not by name patterns: exactly what it created, checked before and after
// (see ownership.ts). Its registration and record are forgotten only once its
// refs, open pull requests and projects read back gone and every document it
// created reads back archived and not trashed.

import { RUN_ID_PATTERN, runNames } from './isolation.ts';
import type { LinearWorld } from './linear-world.ts';
import { deadLocalRuns, forgetRun, liveRuns } from './locks.ts';
import { OwnershipLedger, ownedRuns, readOwnership, recoverOwned, type Recovery } from './ownership.ts';
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
  archivedDocuments: number;
  /** Dead runs recovered from their ownership records. */
  recovered: Recovery[];
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
  const report: SweepReport = { removedRefs: [], closedPullRequests: [], deletedProjects: [], archivedDocuments: 0, recovered: [], keptLive: [...live].sort(), errors: [] };
  // Dead runs whose Linear side is recovered from their records, not by name.
  const recorded = new Set(ownedRuns(stateDir).filter((runId) => dead.has(runId)));
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
      if (recorded.has(project.runId) || !shouldSweep(project.runId, Date.parse(project.createdAt), now, live, dead)) continue;
      await targets.world.deleteProject(project, project.runId);
      report.deletedProjects.push(project.name);
    }
  });

  // Leftover team-zone documents are archived through a run project, never trashed: trashed documents count
  // against a team zone's cap and cannot be purged.
  for (const teamId of targets.teamIds) {
    await attempt('team-zone documents', async () => {
      const byRun = new Map<string, Awaited<ReturnType<typeof targets.world.runTeamDocuments>>>();
      for (const document of await targets.world.runTeamDocuments(teamId)) {
        if (recorded.has(document.runId) || !shouldSweep(document.runId, Date.parse(document.createdAt), now, live, dead)) continue;
        byRun.set(document.runId, [...(byRun.get(document.runId) ?? []), document]);
      }
      for (const [runId, documents] of byRun) {
        report.archivedDocuments += await targets.world.archiveRunTeamDocuments(documents, runId, runNames(runId).helperProject('archive'));
      }
    });
  }

  for (const runId of [...recorded].sort()) {
    await attempt(`recovery of run ${runId}`, async () => {
      const owned = readOwnership(stateDir, runId);
      if (owned === null) return;
      const recovery = await recoverOwned(targets.world, owned, new OwnershipLedger(stateDir, runId));
      report.recovered.push(recovery);
      report.deletedProjects.push(...recovery.deletedProjects);
      report.archivedDocuments += recovery.archivedDocuments;
      if (recovery.problems.length > 0) throw new Error(recovery.problems.join('; '));
    });
  }

  // A dead run is forgotten only once its refs and open pull requests read back gone.
  await attempt('refs read back', async () => {
    const left = (await targets.sandbox.runRefs()).filter((ref) => dead.has(ref.runId)).map((ref) => ref.ref);
    if (left.length > 0) throw new Error(`still on the sandbox: ${left.join(', ')}`);
  });
  await attempt('pull requests read back', async () => {
    const open = (await targets.rest.pullRequests('t/', 'open')).filter((pr) => dead.has(/^t\/([0-9a-f]{6})\//.exec(pr.head.ref)?.[1] ?? ''));
    if (open.length > 0) throw new Error(`still open: ${open.map((pr) => pr.number).join(', ')}`);
  });

  if (report.errors.length === 0) for (const runId of dead) forgetRun(stateDir, runId);
  return report;
}
