// Linear's side of the setup check: the run's token works and may write,
// and every annotated team and project exists. The resolved ids are what
// the run then uses to list and place documents.

import { setTimeout } from 'node:timers/promises';
import { type LinearClient, LinearError, LinearGraphQLError, LinearHttpError, LinearStoppedError, LinearTokenError } from '../linear/index.ts';
import { type Place, type Zone } from '../mapping/index.ts';
import { type CheckResult, failed, notChecked, passed } from './report.ts';
import { message } from '../messages.ts';
import { stableId } from '../sync/stable-id.ts';

export const REQUIRED_SCOPES = ['read', 'write'] as const;

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
}

/** Annotated names resolved to Linear ids. */
export interface ResolvedTargets {
  /** By the team name or key as annotated. */
  teams: Map<string, LinearTeam>;
  /** By `team\0project` as annotated. */
  projects: Map<string, LinearProject>;
  /** Projects that resolved to an existing team but still need to be created, by project key. */
  pendingProjects?: Map<string, { id: string; name: string; teamId: string; team: string }>;
}

/** Half of Linear's largest page; see `resolveTargets`. */
const TEAM_REFS_PER_REQUEST = 125;
// Keep the nested teams connection within Linear's complexity limit. Check an incomplete page by team below.
export const PROJECT_TEAMS_PAGE_SIZE = 20;

/** The wait before asking again a token that saw no team at all. */
export const TEAMS_RETRY_DELAY_MS = 3000;

export function projectKey(team: string, project: string): string {
  return `${team}\0${project}`;
}

export function pendingProject(targets: ResolvedTargets, place: Place): boolean {
  return place.kind === 'project' && targets.pendingProjects?.has(projectKey(place.team, place.project)) === true;
}

/** Whether an error means Linear refused the credentials, as opposed to any other failure. */
export function isCredentialError(error: unknown): boolean {
  if (error instanceof LinearTokenError) return error.credentialsRefused;
  if (error instanceof LinearGraphQLError) {
    return error.httpStatus === 401 || error.code === 'AUTHENTICATION_ERROR';
  }
  return error instanceof LinearHttpError && error.httpStatus === 401;
}

/** The token's scopes as Linear granted them; `undefined` when unknown (a key, not a minted token). */
export function checkLinearScopes(scope: readonly string[] | undefined): CheckResult {
  if (scope === undefined) return passed('linear-credentials', 'Linear token accepted');
  const missing = REQUIRED_SCOPES.filter((wanted) => !scope.includes(wanted));
  return missing.length === 0
    ? passed('linear-credentials', `Linear token accepted with scopes ${scope.join(', ')}`)
    : failed('linear-credentials', 'linear-credential-failed', message('setup.linear-scope', { scopes: missing.join(', ') }));
}

export function linearCredentialFailure(detail: string): CheckResult {
  return failed('linear-credentials', 'linear-credential-failed', detail);
}

/**
 * Looks up every annotated team (by key or name) and project (by name, in
 * its team): one request, plus one per further 125 team references. A
 * name that matches nothing, or more than one team or project, fails the
 * check and is named, except that an opted-in missing project is planned.
 * When the token sees no team at all, the lookup is
 * asked once more after `retryDelayMs`; when it still sees none, the check
 * fails with `linear-teams-not-visible` rather than naming every team as
 * missing. A credential error is returned as a failed `linear-credentials`
 * item.
 */
export async function resolveTargets(
  client: LinearClient,
  zones: Iterable<Zone>,
  { retryDelayMs = TEAMS_RETRY_DELAY_MS, createProjects = false, live = false }: {
    retryDelayMs?: number;
    createProjects?: boolean | undefined;
    live?: boolean;
  } = {},
): Promise<{ result: CheckResult; credentials?: CheckResult; targets?: ResolvedTargets }> {
  const zoneList = [...zones];
  const teamRefs = new Set<string>();
  const projectRefs = new Map<string, { team: string; project: string }>();
  for (const zone of zoneList) {
    teamRefs.add(zone.team);
    if (zone.project !== undefined) projectRefs.set(projectKey(zone.team, zone.project), { team: zone.team, project: zone.project });
  }
  if (teamRefs.size === 0) return { result: notChecked('annotation-targets', 'no annotated folders') };

  type ProjectNode = LinearProject & { teams: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean } } };
  const refs = [...teamRefs];
  const names = [...new Set([...projectRefs.values()].map((ref) => ref.project))];
  const query = live ? client.transport.queryLive.bind(client.transport) : client.transport.query.bind(client.transport);
  // A team matches a reference by key or by name, so a batch of references
  // matches at most twice as many teams: within one page when batches are
  // half a page. The first request also looks up the projects, so a usual
  // run resolves its targets in one request, and asks whether the token
  // sees any team at all.
  const lookUp = async () => {
    const teamNodes: LinearTeam[] = [];
    let projectNodes: ProjectNode[] = [];
    let seesTeams: boolean | undefined;
    for (let start = 0; start < refs.length; start += TEAM_REFS_PER_REQUEST) {
      const batch = refs.slice(start, start + TEAM_REFS_PER_REQUEST);
      const first = start === 0;
      const withProjects = first && names.length > 0;
      const data = await query<{
        teams: { nodes: LinearTeam[] };
        projects?: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean } };
        visible?: { nodes: Array<{ id: string }> };
      }>(
        'SetupTargets',
        `query SetupTargets($refs: [String!]!, $first: Int!${withProjects ? ', $names: [String!]!' : ''}) {
          teams(first: $first, filter: { or: [{ key: { in: $refs } }, { name: { in: $refs } }] }) { nodes { id key name } }
          ${withProjects ? `projects(first: 250, filter: { name: { in: $names } }) { nodes { id name teams(first: ${PROJECT_TEAMS_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }` : ''}
          ${first ? 'visible: teams(first: 1) { nodes { id } }' : ''}
        }`,
        withProjects ? { refs: batch, first: batch.length * 2, names } : { refs: batch, first: batch.length * 2 },
      );
      teamNodes.push(...data.teams.nodes.filter((team) => !teamNodes.some((known) => known.id === team.id)));
      if (data.projects !== undefined) {
        if (data.projects.pageInfo.hasNextPage) throw new Error(message('setup.too-many-projects'));
        projectNodes = data.projects.nodes;
      }
      if (data.visible !== undefined) seesTeams = data.visible.nodes.length > 0;
    }
    return { teamNodes, projectNodes, seesTeams };
  };

  let teamNodes: LinearTeam[];
  let projectNodes: ProjectNode[];
  try {
    let found = await lookUp();
    // A token that sees no team at all: Linear has answered a run's token so
    // once while the runs before and after it saw every team. Wait a moment
    // and ask once more before stopping the run. A token that sees teams but
    // not the annotated ones is a naming problem, asked only once.
    if (found.seesTeams === false) {
      await setTimeout(retryDelayMs);
      found = await lookUp();
      if (found.seesTeams === false) {
        return {
          result: failed(
            'annotation-targets',
            'linear-teams-not-visible',
            message('setup.no-team-visible', { teams: [...refs].sort().map((ref) => `"${ref}"`).join(', ') }),
          ),
        };
      }
    }
    ({ teamNodes, projectNodes } = found);
  } catch (error) {
    if (!isCredentialError(error)) throw error;
    return {
      result: notChecked('annotation-targets', 'needs working Linear credentials'),
      credentials: linearCredentialFailure(message('setup.linear-refused-teams')),
    };
  }

  const targets: ResolvedTargets = { teams: new Map(), projects: new Map() };
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const ref of [...teamRefs].sort()) {
    const matches = teamNodes.filter((team) => team.key === ref || team.name === ref);
    if (matches.length === 1) targets.teams.set(ref, matches[0] as LinearTeam);
    else (matches.length === 0 ? missing : ambiguous).push(`team "${ref}"`);
  }
  for (const [key, ref] of [...projectRefs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const team = targets.teams.get(ref.team);
    if (team === undefined) continue;
    const matches: LinearProject[] = [];
    for (const project of projectNodes) {
      if (project.name !== ref.project) continue;
      if (project.teams.nodes.some((node) => node.id === team.id)) {
        matches.push(project);
      } else if (project.teams.pageInfo.hasNextPage) {
        const membership = await query<{ project: { teams: { nodes: Array<{ id: string }> } } }>(
          'SetupProjectTeam',
          'query SetupProjectTeam($project: String!, $team: ID!) { project(id: $project) { teams(first: 1, filter: { id: { eq: $team } }) { nodes { id } } } }',
          { project: project.id, team: team.id },
        );
        if (membership.project.teams.nodes.some((node) => node.id === team.id)) matches.push(project);
      }
    }
    if (matches.length === 1) {
      const { id, name } = matches[0] as LinearProject;
      targets.projects.set(key, { id, name });
    } else if (matches.length === 0 && createProjects) {
      const id = stableId('project', team.id, ref.project);
      targets.pendingProjects ??= new Map();
      targets.pendingProjects.set(key, { id, name: ref.project, teamId: team.id, team: ref.team });
    } else {
      (matches.length === 0 ? missing : ambiguous).push(`project "${ref.project}" of team "${ref.team}"`);
    }
  }

  if (missing.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-not-found', message('setup.target-not-found', { targets: missing.join(', ') })) };
  }
  if (ambiguous.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-ambiguous', message('setup.target-ambiguous', { targets: ambiguous.join(', ') })) };
  }
  const shared = sharedDestinations(zoneList, targets);
  if (shared.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-shared', message('setup.target-shared', { targets: shared.join('; ') })) };
  }
  return {
    result: passed('annotation-targets', `found in Linear: ${targets.teams.size} teams, ${targets.projects.size} projects`
      + (targets.pendingProjects === undefined ? '' : `; ${targets.pendingProjects.size} missing projects eligible for creation`)),
    targets,
  };
}

/** Creates only projects whose destinations passed the setup check. A retry resolves any project already created. */
export async function createPendingProjects(client: LinearClient, targets: ResolvedTargets): Promise<boolean> {
  const pending = targets.pendingProjects;
  if (!pending?.size) return false;
  for (const [key, { id, name, teamId, team }] of pending) {
    try {
      targets.projects.set(key, await createProject(client, id, name, teamId));
    } catch (error) {
      if (error instanceof LinearStoppedError || !(error instanceof LinearError)) throw error;
      throw new ProjectCreationError(name, team, error);
    }
    pending.delete(key);
  }
  return true;
}

async function createProject(client: LinearClient, firstId: string, name: string, teamId: string): Promise<LinearProject> {
  for (let id = firstId; ; id = stableId('project', id)) {
    let failure: LinearError;
    try {
      const { projectCreate } = await client.mutate<{ projectCreate: { success: boolean; project: LinearProject | null } }>(
        'CreateProject',
        'mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }',
        { input: { id, name, teamIds: [teamId] } },
      );
      if (projectCreate.success && projectCreate.project?.id === id) {
        client.stats.wrote('CreateProject');
        if (projectCreate.project.name === name) return projectCreate.project;
        throw new LinearError('CreateProject', message('setup.project-name-changed'));
      }
      failure = new LinearError('CreateProject', message('setup.project-create-failed'));
    } catch (error) {
      if (!(error instanceof LinearGraphQLError) || isCredentialError(error)) throw error;
      failure = error;
    }
    // A renamed project can still own the deterministic id. Only a lookup confirming a different name
    // justifies retrying with the next id. If our original write landed, the next run re-plans against it.
    const { projects } = await client.transport.queryLive<{ projects: { nodes: LinearProject[] } }>(
      'ProjectByCreationId',
      'query ProjectByCreationId($id: ID!) { projects(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id name } } }',
      { id },
    );
    const existing = projects.nodes.find((project) => project.id === id);
    if (existing === undefined || existing.name === name) throw failure;
  }
}

export class ProjectCreationError extends Error {
  readonly project: string;
  readonly team: string;
  override readonly cause: LinearError;

  constructor(project: string, team: string, cause: LinearError) {
    super(message('setup.project-create-failed'), { cause });
    this.project = project;
    this.team = team;
    this.cause = cause;
  }
}

/**
 * Each Linear project, and each team's own documents (its team zone), must
 * come from one folder: otherwise a document has two folders to live in,
 * and titles that collide in Linear would not collide in the mapping (a
 * team named by key in one folder and by name in another).
 */
function sharedDestinations(zones: readonly Zone[], targets: ResolvedTargets): string[] {
  const folders = new Map<string, { label: string; folders: Set<string> }>();
  for (const zone of zones) {
    const team = targets.teams.get(zone.team) as LinearTeam;
    const key = zone.project === undefined ? undefined : projectKey(zone.team, zone.project);
    const [id, label, folder] = zone.project === undefined
      ? [`team\0${team.id}`, `the documents of team "${team.name}"`, zone.teamFolder]
      : [`project\0${(targets.projects.get(key!) ?? targets.pendingProjects?.get(key!))!.id}`, `project "${zone.project}"`, zone.projectFolder as string];
    const entry = folders.get(id) ?? { label, folders: new Set<string>() };
    entry.folders.add(folder === '' ? 'the repository root' : `${folder}/`);
    folders.set(id, entry);
  }
  return [...folders.values()]
    .filter((entry) => entry.folders.size > 1)
    .map((entry) => `${entry.label} (${[...entry.folders].sort().join(', ')})`);
}
