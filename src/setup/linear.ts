// Linear's side of the setup check: the run's token works and may write,
// and every annotated team and project exists. The resolved ids are what
// the run then uses to list and place documents.

import { setTimeout } from 'node:timers/promises';
import { type LinearClient, LinearGraphQLError, LinearHttpError, LinearTokenError } from '../linear/index.ts';
import { type Zone } from '../mapping/index.ts';
import { type CheckResult, failed, notChecked, passed } from './report.ts';

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
}

/** Half of Linear's largest page; see `resolveTargets`. */
const TEAM_REFS_PER_REQUEST = 125;

/** The wait before asking again a token that saw no team at all. */
export const TEAMS_RETRY_DELAY_MS = 3000;

export function projectKey(team: string, project: string): string {
  return `${team}\0${project}`;
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
    : failed('linear-credentials', 'linear-credential-failed', `the Linear token lacks the scope ${missing.join(', ')}`);
}

export function linearCredentialFailure(detail: string): CheckResult {
  return failed('linear-credentials', 'linear-credential-failed', detail);
}

/**
 * Looks up every annotated team (by key or name) and project (by name, in
 * its team): one request, plus one per further 125 team references. A
 * name that matches nothing, or more than one team or project, fails the
 * check and is named. When the token sees no team at all, the lookup is
 * asked once more after `retryDelayMs`; when it still sees none, the check
 * fails with `linear-teams-not-visible` rather than naming every team as
 * missing. A credential error is returned as a failed `linear-credentials`
 * item.
 */
export async function resolveTargets(
  client: LinearClient,
  zones: Iterable<Zone>,
  retryDelayMs = TEAMS_RETRY_DELAY_MS,
): Promise<{ result: CheckResult; credentials?: CheckResult; targets?: ResolvedTargets }> {
  const zoneList = [...zones];
  const teamRefs = new Set<string>();
  const projectRefs = new Map<string, { team: string; project: string }>();
  for (const zone of zoneList) {
    teamRefs.add(zone.team);
    if (zone.project !== undefined) projectRefs.set(projectKey(zone.team, zone.project), { team: zone.team, project: zone.project });
  }
  if (teamRefs.size === 0) return { result: notChecked('annotation-targets', 'no annotated folders') };

  type ProjectNode = LinearProject & { teams: { nodes: Array<{ id: string }> } };
  const refs = [...teamRefs];
  const names = [...new Set([...projectRefs.values()].map((ref) => ref.project))];
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
      const data = await client.request<{
        teams: { nodes: LinearTeam[] };
        projects?: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean } };
        visible?: { nodes: Array<{ id: string }> };
      }>(
        'SetupTargets',
        'query',
        `query SetupTargets($refs: [String!]!, $first: Int!${withProjects ? ', $names: [String!]!' : ''}) {
          teams(first: $first, filter: { or: [{ key: { in: $refs } }, { name: { in: $refs } }] }) { nodes { id key name } }
          ${withProjects ? 'projects(first: 250, filter: { name: { in: $names } }) { nodes { id name teams(first: 50) { nodes { id } } } pageInfo { hasNextPage } }' : ''}
          ${first ? 'visible: teams(first: 1) { nodes { id } }' : ''}
        }`,
        withProjects ? { refs: batch, first: batch.length * 2, names } : { refs: batch, first: batch.length * 2 },
      );
      teamNodes.push(...data.teams.nodes.filter((team) => !teamNodes.some((known) => known.id === team.id)));
      if (data.projects !== undefined) {
        if (data.projects.pageInfo.hasNextPage) throw new Error('more than 250 Linear projects share the annotated names');
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
            `the Linear app saw no team in two lookups, so none of the annotated teams (${[...refs].sort().map((ref) => `"${ref}"`).join(', ')}) can be found: check the app's team access in Linear`,
          ),
        };
      }
    }
    ({ teamNodes, projectNodes } = found);
  } catch (error) {
    if (!isCredentialError(error)) throw error;
    return {
      result: notChecked('annotation-targets', 'needs working Linear credentials'),
      credentials: linearCredentialFailure('Linear refused the token while reading teams'),
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
    const matches = projectNodes.filter((project) => project.name === ref.project && project.teams.nodes.some((node) => node.id === team.id));
    if (matches.length === 1) {
      const { id, name } = matches[0] as LinearProject;
      targets.projects.set(key, { id, name });
    } else {
      (matches.length === 0 ? missing : ambiguous).push(`project "${ref.project}" of team "${ref.team}"`);
    }
  }

  if (missing.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-not-found', `not found in Linear: ${missing.join(', ')}`) };
  }
  if (ambiguous.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-ambiguous', `more than one match in Linear: ${ambiguous.join(', ')}`) };
  }
  const shared = sharedDestinations(zoneList, targets);
  if (shared.length > 0) {
    return { result: failed('annotation-targets', 'annotation-target-shared', `more than one folder maps to ${shared.join('; ')}`) };
  }
  return {
    result: passed('annotation-targets', `found in Linear: ${targets.teams.size} teams, ${targets.projects.size} projects`),
    targets,
  };
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
    const [id, label, folder] = zone.project === undefined
      ? [`team\0${team.id}`, `the documents of team "${team.name}"`, zone.teamFolder]
      : [`project\0${(targets.projects.get(projectKey(zone.team, zone.project)) as LinearProject).id}`, `project "${zone.project}"`, zone.projectFolder as string];
    const entry = folders.get(id) ?? { label, folders: new Set<string>() };
    entry.folders.add(folder === '' ? 'the repository root' : `${folder}/`);
    folders.set(id, entry);
  }
  return [...folders.values()]
    .filter((entry) => entry.folders.size > 1)
    .map((entry) => `${entry.label} (${[...entry.folders].sort().join(', ')})`);
}
