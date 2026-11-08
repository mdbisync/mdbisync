// Linear's side of the setup check: the run's token works and may write,
// and every annotated team and project exists. The resolved ids are what
// the run then uses to list and place documents.

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
 * its team): two requests. A name that matches nothing, or more than one
 * team or project, fails the check and is named. A credential error is
 * returned as a failed `linear-credentials` item.
 */
export async function resolveTargets(
  client: LinearClient,
  zones: Iterable<Zone>,
): Promise<{ result: CheckResult; credentials?: CheckResult; targets?: ResolvedTargets }> {
  const zoneList = [...zones];
  const teamRefs = new Set<string>();
  const projectRefs = new Map<string, { team: string; project: string }>();
  for (const zone of zoneList) {
    teamRefs.add(zone.team);
    if (zone.project !== undefined) projectRefs.set(projectKey(zone.team, zone.project), { team: zone.team, project: zone.project });
  }
  if (teamRefs.size === 0) return { result: notChecked('annotation-targets', 'no annotated folders') };

  let teamNodes: LinearTeam[];
  let projectNodes: Array<LinearProject & { teams: { nodes: Array<{ id: string }> } }>;
  try {
    // A team matches a reference by key or by name, so a batch of references
    // matches at most twice as many teams: within one page when batches are
    // half a page.
    const refs = [...teamRefs];
    teamNodes = [];
    for (let start = 0; start < refs.length; start += TEAM_REFS_PER_REQUEST) {
      const batch = refs.slice(start, start + TEAM_REFS_PER_REQUEST);
      const teams = await client.request<{ teams: { nodes: LinearTeam[] } }>(
        'SetupTeams',
        'query',
        `query SetupTeams($refs: [String!]!, $first: Int!) {
          teams(first: $first, filter: { or: [{ key: { in: $refs } }, { name: { in: $refs } }] }) { nodes { id key name } }
        }`,
        { refs: batch, first: batch.length * 2 },
      );
      teamNodes.push(...teams.teams.nodes.filter((team) => !teamNodes.some((known) => known.id === team.id)));
    }
    const names = [...new Set([...projectRefs.values()].map((ref) => ref.project))];
    projectNodes = [];
    if (names.length > 0) {
      const projects = await client.request<{ projects: { nodes: typeof projectNodes; pageInfo: { hasNextPage: boolean } } }>(
        'SetupProjects',
        'query',
        `query SetupProjects($names: [String!]!) {
          projects(first: 250, filter: { name: { in: $names } }) { nodes { id name teams(first: 50) { nodes { id } } } pageInfo { hasNextPage } }
        }`,
        { names },
      );
      if (projects.projects.pageInfo.hasNextPage) throw new Error('more than 250 Linear projects share the annotated names');
      projectNodes = projects.projects.nodes;
    }
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
