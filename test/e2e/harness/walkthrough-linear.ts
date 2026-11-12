// The Linear side of a manual walk-through, and its cleanup, for one run:
//
//   project      creates the run's neutral project ("Field notes <run>") that
//                the folder annotation names;
//   trash        reads the trash counts of the given team zones; the first
//                reading of a run is kept as its baseline;
//   linear-edit  appends one neutral paragraph to a synced document, as an
//                editor does in Linear;
//   linear-read  prints a synced document's content as Linear has it;
//   cleanup      closes the run's pull requests, deletes its refs, and
//                archives its project and documents (never trashes them),
//                with trash counts before and after.
//
// Every command works only on the selected run: projects named for it,
// documents its ids state ref names (inside its projects or team zones) and
// refs under t/<run>/ and refs/mdbisync-t/<run>/. Anything else is refused.
// Like the git and Actions commands, live use needs the same admission and
// cleanup window as a scenario run; these commands reserve no Linear zone
// themselves.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearDocument } from '../../../src/linear/index.ts';
import type { SandboxRest } from './github.ts';
import { runNames, runOfProject, runOfTeamTitle } from './isolation.ts';
import type { LinearWorld, Project, Team } from './linear-world.ts';
import { liveRuns } from './locks.ts';
import { forgetOwnership, OwnershipLedger, readOwnership, recoverOwned } from './ownership.ts';

export const LINEAR_ACTIONS: readonly string[] = ['project', 'trash', 'linear-edit', 'linear-read', 'cleanup'];
/** Actions that also need the sandbox (the ids state ref, refs and pull requests). */
export const SANDBOX_LINEAR_ACTIONS: readonly string[] = ['linear-edit', 'linear-read', 'cleanup'];
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
const MAX_TEXT = 200;

export class WalkthroughRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkthroughRefusal';
  }
}

/** The run's refs and ids state ref on the sandbox, read and deleted with the App token. */
export interface RunGit {
  /** The run's branches and state refs; never another run's or any other ref. */
  refs(runId: string): Promise<string[]>;
  deleteRefs(runId: string, refs: readonly string[]): Promise<void>;
  /** Path → Linear document id, from the run's ids state ref; empty when it has none. */
  ids(runId: string): Promise<Map<string, string>>;
}

export type WalkthroughWorld = Pick<LinearWorld, 'teams' | 'createProject' | 'projects' | 'runProjects' | 'deleteProject' | 'archiveRunTeamDocuments' | 'runTeamDocuments' | 'trashedInZone'> & {
  client: Pick<LinearWorld['client'], 'getDocuments' | 'updateDocument' | 'restoreDocument'> & Partial<Pick<LinearWorld['client'], 'stopped'>>;
};

export interface LinearActionInput {
  action: string;
  runId: string;
  teams: string[];
  path?: string;
  text?: string;
  stateDir: string;
  world: WalkthroughWorld;
  /** Present for SANDBOX_LINEAR_ACTIONS. */
  git?: RunGit;
  rest?: Pick<SandboxRest, 'workflowRuns' | 'pullRequests' | 'closeOpenPullRequests'>;
  print(text: string): void;
  now?: () => Date;
}

/** Checks the Linear options of a walk-through command before anything is read or written. */
export function checkLinearOptions(action: string, teams: readonly string[], path: string | undefined, text: string | undefined): void {
  const onlyFor = (option: string, actions: readonly string[], given: boolean) => {
    if (given && !actions.includes(action)) throw new Error(`${option} is only for ${actions.join(' or ')}`);
  };
  onlyFor('--team', ['project', 'trash', 'cleanup'], teams.length > 0);
  onlyFor('--path', ['linear-edit', 'linear-read'], path !== undefined);
  onlyFor('--text', ['linear-edit'], text !== undefined);
  for (const team of teams) if (!TEAM_KEY_PATTERN.test(team)) throw new Error('--team must be a Linear team key, such as ENG');
  if (new Set(teams).size !== teams.length) throw new Error('--team values must be unique');
  if (action === 'project' && teams.length !== 1) throw new Error('project needs exactly one --team');
  if (action === 'trash' && teams.length === 0) throw new Error('trash needs at least one --team');
  if (['linear-edit', 'linear-read'].includes(action) && (path === undefined || path === '')) throw new Error(`${action} needs --path <synced file>`);
  if (text !== undefined && (text.trim() === '' || text.length > MAX_TEXT || /[\r\n]/.test(text))) throw new Error(`--text must be one non-empty line of at most ${MAX_TEXT} characters`);
}

function teamsByKey(all: readonly Team[], keys: readonly string[]): Team[] {
  return keys.map((key) => {
    const team = all.find((candidate) => candidate.key === key);
    if (team === undefined) throw new WalkthroughRefusal(`the test workspace has no team with key ${key}`);
    return team;
  });
}

function baselineFile(stateDir: string, runId: string): string {
  return join(stateDir, 'walkthrough', `${runNames(runId).runId}-trash.json`);
}

function readBaseline(stateDir: string, runId: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readFileSync(baselineFile(stateDir, runId), 'utf8'));
    if (value === null || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])));
  } catch {
    return {};
  }
}

async function trashCounts(world: WalkthroughWorld, teams: readonly Team[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const team of teams) counts[team.key] = await world.trashedInZone(team.id);
  return counts;
}

/**
 * A synced document of the run, by its path in the run's ids state ref. It
 * must be live, in a project of the run or in a team zone with the run's
 * title prefix; any other document is refused before it is read in full.
 */
async function runDocument(input: LinearActionInput): Promise<LinearDocument> {
  const ids = await input.git!.ids(input.runId);
  const id = ids.get(input.path!);
  if (id === undefined) throw new WalkthroughRefusal('the run\'s ids state ref has no document for --path; run the initial sync first');
  const [document] = await input.world.client.getDocuments([id], { withContent: true });
  if (document === undefined) throw new WalkthroughRefusal('the document the ids state ref names does not exist in Linear');
  if (document.trashed || document.archivedAt !== null) throw new WalkthroughRefusal('the document is trashed or archived');
  if (document.projectId !== null) {
    const own = (await input.world.runProjects()).some((project) => project.id === document.projectId && project.runId === input.runId);
    if (!own) throw new WalkthroughRefusal('the document is in a project that is not the selected run\'s');
  } else if (runOfTeamTitle(document.title) !== input.runId) {
    throw new WalkthroughRefusal('the document is in a team zone but is not titled for the selected run');
  }
  return document;
}

export async function linearAction(input: LinearActionInput): Promise<number> {
  const { action, runId, world, print, stateDir } = input;
  const names = runNames(runId);

  if (action === 'project') {
    const [team] = teamsByKey(await world.teams(), input.teams);
    const name = names.project(0);
    const ledger = new OwnershipLedger(stateDir, runId);
    const existing = (await world.projects()).find((project) => project.name === name);
    if (existing !== undefined) {
      // Its team is not known here, so no zone is recorded: cleanup takes --team for the zones the run touched.
      ledger.project(existing);
      print(`Project "${name}" already exists; recorded for cleanup. Give cleanup --team for each zone the run touched.`);
      return 0;
    }
    ledger.scope([team!.id]);
    await world.createProject(name, [team!.id], ledger);
    print(`Created project "${name}" in team ${team!.key}. Name it in the folder annotation: linear-project: ${name}`);
    return 0;
  }

  if (action === 'trash') {
    const counts = await trashCounts(world, teamsByKey(await world.teams(), input.teams));
    // The first reading of a run is its baseline; cleanup compares with it.
    const baseline = { ...counts, ...readBaseline(stateDir, runId) };
    mkdirSync(join(stateDir, 'walkthrough'), { recursive: true });
    writeFileSync(baselineFile(stateDir, runId), `${JSON.stringify(baseline)}\n`, { mode: 0o600 });
    print(JSON.stringify({ trash: counts, baseline }));
    return 0;
  }

  if (action === 'linear-read') {
    const document = await runDocument(input);
    print(document.content ?? '');
    return 0;
  }

  if (action === 'linear-edit') {
    const document = await runDocument(input);
    const line = input.text ?? `Checked again on ${(input.now?.() ?? new Date()).toISOString().slice(0, 10)}.`;
    const content = `${(document.content ?? '').trimEnd()}\n\n${line}\n`;
    await world.client.updateDocument(document.id, { content });
    print(`Appended to ${input.path} in Linear: ${line}`);
    return 0;
  }

  if (action === 'cleanup') return cleanup(input);
  throw new Error(`unknown walkthrough action ${action}`);
}

/**
 * Cleans up the run right away, as the sweeper would after two hours:
 * Linear first (its refusals change nothing), then pull requests and refs,
 * then reads everything back. A failure leaves the ownership record, so the
 * same command can finish it later.
 */
async function cleanup(input: LinearActionInput): Promise<number> {
  const { runId, world, stateDir, print } = input;
  const git = input.git!;
  const rest = input.rest!;
  const names = runNames(runId);
  if (liveRuns(stateDir).has(runId)) throw new WalkthroughRefusal('the run is a registered scenario run; use recover or sweep');
  const running = [];
  for (const branch of [names.trackedBranch, names.syncBranch, names.scheduleRequest, `t/${runId}/suspended`]) {
    running.push(...(await rest.workflowRuns(branch)).filter((run) => run.head_branch === branch && run.status !== 'completed'));
  }
  if (running.length > 0) throw new WalkthroughRefusal(`workflow runs ${running.map((run) => run.id).join(', ')} of the run are not completed; cancel or wait for them first`);

  const ledger = new OwnershipLedger(stateDir, runId);
  const recorded = readOwnership(stateDir, runId);
  const all = await world.teams();
  const teams = [...teamsByKey(all, input.teams), ...all.filter((team) => recorded?.teamIds.has(team.id) && !input.teams.includes(team.key))];
  if (teams.length === 0) throw new WalkthroughRefusal('cleanup needs --team for each zone the run touched (none is recorded)');
  // Check the synced documents before recording them: a foreign one in the record would block every later cleanup.
  const projects = (await world.runProjects()).filter((project) => project.runId === runId);
  const ids = [...(await git.ids(runId)).values()];
  const teamIds = new Set(teams.map((team) => team.id));
  for (const document of await world.client.getDocuments(ids)) {
    const archived = document.archivedAt !== null && !document.trashed;
    const own = document.projectId === null
      ? document.teamId !== null && teamIds.has(document.teamId) && runOfTeamTitle(document.title) === runId
      : projects.some((project) => project.id === document.projectId);
    if (!archived && !own) throw new WalkthroughRefusal(`document ${document.id} of the ids state ref is outside the run's projects and the given team zones`);
  }
  // Record what the run made before changing anything: its synced documents and every project named for it.
  ledger.scope(teamIds);
  for (const id of ids) ledger.record({ kind: 'document', id, confirmed: true });
  for (const project of projects) ledger.project(project);

  const before = await trashCounts(world, teams);
  const named: LinearDocument[] = [];
  // Trashed ones too: a document the engine trashed counts against the zone's cap until it is archived.
  for (const team of teams) named.push(...(await world.runTeamDocuments(team.id, { trashed: true })).filter((document) => document.runId === runId));
  const problems: string[] = [];
  // Refuses, changing nothing, when a recorded document or project is not the run's.
  const recovery = await recoverOwned(world, readOwnership(stateDir, runId)!, ledger, named);
  problems.push(...recovery.problems);

  let closedPullRequests: number[] = [];
  try { closedPullRequests = await rest.closeOpenPullRequests(`t/${runId}/`); }
  catch (error) { problems.push(`pull requests: ${(error as Error).message}`); }
  let removedRefs: string[] = [];
  try {
    removedRefs = await git.refs(runId);
    await git.deleteRefs(runId, removedRefs);
  } catch (error) { problems.push(`refs: ${(error as Error).message}`); }

  const leftRefs = await git.refs(runId);
  if (leftRefs.length > 0) problems.push(`refs still on the sandbox: ${leftRefs.join(', ')}`);
  const open = await rest.pullRequests(`t/${runId}/`, 'open');
  if (open.length > 0) problems.push(`pull requests still open: ${open.map((pr) => pr.number).join(', ')}`);
  const left = (await world.projects()).filter((project: Project) => runOfProject(project.name) === runId);
  if (left.length > 0) problems.push(`projects of the run still there: ${left.map((project) => project.name).join(', ')}`);
  const after = await trashCounts(world, teams);
  const baseline = readBaseline(stateDir, runId);
  const trash = Object.fromEntries(teams.map((team) => [team.key, { ...(baseline[team.key] === undefined ? {} : { baseline: baseline[team.key] }), before: before[team.key], after: after[team.key] }]));
  for (const team of teams) if (after[team.key]! > before[team.key]!) problems.push(`cleanup increased the trash count of ${team.key}`);

  if (problems.length === 0) {
    forgetOwnership(stateDir, runId);
    rmSync(baselineFile(stateDir, runId), { force: true });
  }
  print(JSON.stringify({ runId, removedRefs, closedPullRequests, deletedProjects: recovery.deletedProjects, archivedDocuments: recovery.archivedDocuments,
    verifiedArchived: recovery.verifiedArchived, alreadyArchived: recovery.alreadyArchived, gone: recovery.gone, trash, problems }, null, 2));
  return problems.length === 0 ? 0 : 1;
}
