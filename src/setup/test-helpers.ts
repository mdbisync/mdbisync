// A fake GitHub REST API and Linear API behind one `fetch`, for the setup
// check's tests. It answers the way the real services were seen to answer
// an installation token and a client-credentials token, records every
// request, and counts anything that would have written.

import { PERMISSION_PROBES } from './github.ts';

export const GITHUB_API = 'https://github.test/api';
export const LINEAR_API = 'https://linear.test';

export interface FakeTeam {
  id: string;
  key: string;
  name: string;
}

export interface FakeProject {
  id: string;
  name: string;
  teamIds: string[];
}

export interface FakeWorld {
  github: { tokenValid: boolean; missing: Set<string>; allowMergeCommit: boolean };
  linear: { credentialsValid: boolean; scope: string[]; teams: FakeTeam[]; projects: FakeProject[] };
  /** `METHOD url` of every request. */
  requests: string[];
  /** Requests that would have changed something on either side. */
  writes: string[];
  /** Tokens minted and revoked. */
  minted: number;
  revoked: number;
}

export function fakeWorld(): FakeWorld {
  return {
    github: { tokenValid: true, missing: new Set(), allowMergeCommit: true },
    linear: {
      credentialsValid: true,
      scope: ['read', 'write'],
      teams: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        { id: 'team-docs', key: 'DOCS', name: 'Docs' },
      ],
      projects: [
        { id: 'project-api', name: 'Field notes', teamIds: ['team-eng'] },
        { id: 'project-handbook', name: 'Handbook', teamIds: ['team-docs'] },
      ],
    },
    requests: [],
    writes: [],
    minted: 0,
    revoked: 0,
  };
}

export function fakeFetch(world: FakeWorld): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    world.requests.push(`${method} ${url}`);
    if (url.startsWith(GITHUB_API)) return github(world, method, url.slice(GITHUB_API.length), init);
    if (url.startsWith(LINEAR_API)) return linear(world, url.slice(LINEAR_API.length), init);
    throw new Error(`unexpected request to ${url}`);
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function github(world: FakeWorld, method: string, path: string, init: RequestInit | undefined): Response {
  if (!world.github.tokenValid) return json(401, { message: 'Bad credentials' });
  const repo = /^\/repos\/[^/]+\/[^/]+/.exec(path);
  if (repo === null) return json(404, { message: 'Not Found' });
  const rest = path.slice(repo[0].length);
  if (rest === '' && method === 'GET') {
    // GitHub shows the merge settings only to a token with write access.
    const writable = !world.github.missing.has('contents:write');
    return json(200, { full_name: repo[0].slice(7), ...(writable ? { allow_merge_commit: world.github.allowMergeCommit } : {}) });
  }
  const probe = PERMISSION_PROBES.find((candidate) => candidate.method === method && rest === candidate.path(rest.split('/')[2] ?? ''));
  if (probe === undefined) return json(404, { message: 'Not Found' });
  if (world.github.missing.has(probe.permission)) return json(403, { message: 'Resource not accessible by integration' });
  if (method === 'GET') return json(200, []);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  // Each probe's body lacks a required field, so the real API rejects it.
  const complete = probe.permission === 'workflows:write' ? 'content' in body : Object.keys(body).length > 1;
  if (complete) {
    world.writes.push(`${method} ${path}`);
    return json(201, {});
  }
  return json(422, { message: 'Invalid request.' });
}

async function linear(world: FakeWorld, path: string, init: RequestInit | undefined): Promise<Response> {
  if (path === '/oauth/token') {
    if (!world.linear.credentialsValid) return json(401, { error: 'invalid_client' });
    world.minted += 1;
    return json(200, { access_token: 'fake-token', expires_in: 3600, scope: world.linear.scope.join(' ') });
  }
  if (path === '/oauth/revoke') {
    world.revoked += 1;
    return json(200, { success: true });
  }
  if (path !== '/graphql') return json(404, {});
  const { query, variables, operationName } = JSON.parse(String(init?.body)) as {
    query: string;
    variables: Record<string, unknown>;
    operationName: string;
  };
  if (/^\s*mutation/.test(query)) {
    world.writes.push(operationName);
    return json(200, { data: {} });
  }
  if (operationName === 'SetupTeams') {
    const refs = variables.refs as string[];
    return json(200, { data: { teams: { nodes: world.linear.teams.filter((team) => refs.includes(team.key) || refs.includes(team.name)) } } });
  }
  if (operationName === 'SetupProjects') {
    const names = variables.names as string[];
    const nodes = world.linear.projects
      .filter((project) => names.includes(project.name))
      .map((project) => ({ id: project.id, name: project.name, teams: { nodes: project.teamIds.map((id) => ({ id })) } }));
    return json(200, { data: { projects: { nodes, pageInfo: { hasNextPage: false } } } });
  }
  return json(400, { errors: [{ message: `unknown operation ${operationName}`, extensions: { code: 'INPUT_ERROR' } }] });
}
