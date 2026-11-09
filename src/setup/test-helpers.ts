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

/** A document in a project, or in a team outside projects (the team zone). */
export interface FakeDocument {
  id: string;
  title: string;
  projectId?: string;
  teamId?: string;
  createdAt: string;
  /** Moves forward on every change; `createdAt` when absent. */
  updatedAt?: string;
  icon?: string | null;
  color?: string | null;
  /** In the trash; Linear then sets `archivedAt` too. */
  trashed?: boolean;
  archivedAt?: string;
  /**
   * Left out of every `documents(...)` query, even with `includeArchived`,
   * while `document(id:)` still answers for it. Not Linear's measured
   * behaviour (lists return trashed and archived documents): an opt-in to
   * reproduce a list that misses a document.
   */
  unlisted?: boolean;
  /** The stored content. */
  content?: string;
}

/** A file uploaded with `fileUpload`; `bytes` is set once the storage PUT arrived. */
export interface FakeUpload {
  filename: string;
  contentType: string;
  size: number;
  assetUrl: string;
  bytes?: Buffer;
}

/** Where the fake's asset URLs point. */
export const UPLOADS_HOST = 'https://uploads.linear.test';

/** How the fake answers document writes. */
export interface FakeWrites {
  /** Mutations received so far. */
  count: number;
  /** Answer 429 from this mutation on (1-based), as Linear does when rate limited. */
  rateLimitAt?: number;
  /** Rejects a mutation with a GraphQL error when it returns true. */
  reject?: (operation: string, variables: Record<string, unknown>) => boolean;
}

export interface FakeWorld {
  github: { tokenValid: boolean; missing: Set<string>; allowMergeCommit: boolean; rateLimited: boolean; rateLimitedRepository: boolean };
  /**
   * `unavailable`: the token endpoint answers 503, as in an outage.
   * `store`: what Linear stores for written content (the identity unless a test reformats).
   */
  linear: {
    credentialsValid: boolean;
    unavailable: boolean;
    scope: string[];
    teams: FakeTeam[];
    projects: FakeProject[];
    documents: FakeDocument[];
    writes: FakeWrites;
    store: (content: string) => string;
    /** The workspace's URL key, in its document URLs. */
    urlKey: string;
    uploads: FakeUpload[];
    /** Comments on documents, by comment id. */
    comments: Map<string, { documentContentId: string; body: string }>;
  };
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
    github: { tokenValid: true, missing: new Set(), allowMergeCommit: true, rateLimited: false, rateLimitedRepository: false },
    linear: {
      credentialsValid: true,
      unavailable: false,
      scope: ['read', 'write'],
      teams: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        { id: 'team-docs', key: 'DOCS', name: 'Docs' },
      ],
      projects: [
        { id: 'project-api', name: 'Field notes', teamIds: ['team-eng'] },
        { id: 'project-handbook', name: 'Handbook', teamIds: ['team-docs'] },
      ],
      documents: [],
      writes: { count: 0 },
      store: (content) => content,
      urlKey: 'example-team',
      uploads: [],
      comments: new Map(),
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
  if (world.github.rateLimitedRepository) return json(403, { message: 'API rate limit exceeded for installation.' });
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
  if (world.github.rateLimited) return json(403, { message: 'You have exceeded a secondary rate limit.' });
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
  if (path === '/oauth/token' && world.linear.unavailable) return json(503, { error: 'temporarily_unavailable' });
  if (path === '/oauth/token') {
    if (!world.linear.credentialsValid) return json(401, { error: 'invalid_client' });
    world.minted += 1;
    return json(200, { access_token: 'fake-token', expires_in: 3600, scope: world.linear.scope.join(' ') });
  }
  if (path === '/oauth/revoke') {
    world.revoked += 1;
    return json(200, { success: true });
  }
  if (path.startsWith('/storage/') && init?.method === 'PUT') {
    const upload = world.linear.uploads[Number(path.slice('/storage/'.length))];
    if (upload === undefined) return json(404, {});
    upload.bytes = Buffer.from(init.body as Uint8Array);
    return new Response(null, { status: 200 });
  }
  if (path !== '/graphql') return json(404, {});
  const { query, variables, operationName } = JSON.parse(String(init?.body)) as {
    query: string;
    variables: Record<string, unknown>;
    operationName: string;
  };
  if (/^\s*mutation/.test(query)) {
    world.writes.push(operationName);
    const write = world.linear.writes;
    write.count += 1;
    if (write.rateLimitAt !== undefined && write.count >= write.rateLimitAt) {
      return json(429, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] });
    }
    if (write.reject?.(operationName, variables) === true) {
      return json(200, { errors: [{ message: 'Rejected by the fake', extensions: { code: 'INVALID_INPUT' } }], data: null });
    }
    return json(200, { data: documentMutation(world, operationName, variables) ?? {} });
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
  if (operationName === 'WorkspaceUrlKey') return json(200, { data: { organization: { urlKey: world.linear.urlKey } } });
  if (operationName === 'ListDocuments') return json(200, { data: { documents: listDocuments(world, variables) } });
  if (operationName === 'FindDocumentComment') {
    const id = variables.id as string;
    const comment = world.linear.comments.get(id);
    return json(200, { data: { comments: { nodes: comment === undefined ? [] : [{ id, documentContentId: comment.documentContentId }] } } });
  }
  if (operationName === 'GetDocuments') {
    // Read by id: trashed documents are included, unknown ids are absent.
    const ids = variables.ids as string[];
    const nodes = world.linear.documents.filter((d) => ids.includes(d.id) && d.unlisted !== true).map((d) => documentNode(d, variables.withContent === true));
    return json(200, { data: { documents: { nodes } } });
  }
  if (operationName === 'GetDocument') {
    // `document(id:)`: trashed and archived documents too; an unknown id is a GraphQL error, as in Linear.
    const document = world.linear.documents.find((d) => d.id === variables.id);
    if (document === undefined) return json(200, { errors: [{ message: 'Entity not found: Document', extensions: { code: 'INPUT_ERROR' } }], data: null });
    return json(200, { data: { document: documentNode(document, variables.withContent === true) } });
  }
  return json(400, { errors: [{ message: `unknown operation ${operationName}`, extensions: { code: 'INPUT_ERROR' } }] });
}

/** Applies a document create, update or trash to the fake's documents and answers like Linear; undefined for other mutations. */
function documentMutation(world: FakeWorld, operation: string, variables: Record<string, unknown>): Record<string, unknown> | undefined {
  const documents = world.linear.documents;
  if (operation === 'CreateDocument') {
    const input = variables.input as { id?: string; title: string; content?: string; projectId?: string; teamId?: string };
    const document: FakeDocument = {
      id: input.id ?? `doc-${documents.length + 1}`,
      title: input.title,
      content: world.linear.store(input.content ?? ''),
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, documents.length)).toISOString(),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : { teamId: input.teamId as string }),
    };
    documents.push(document);
    return { documentCreate: { success: true, document: documentNode(document, true) } };
  }
  if (operation === 'UpdateDocument') {
    const document = documents.find((d) => d.id === variables.id);
    if (document === undefined) return { documentUpdate: { success: false, document: null } };
    const input = variables.input as {
      content?: string;
      title?: string;
      icon?: string | null;
      color?: string | null;
      projectId?: string | null;
      teamId?: string | null;
    };
    if (input.content !== undefined) document.content = world.linear.store(input.content);
    if (input.title !== undefined) document.title = input.title;
    if (input.icon !== undefined) document.icon = input.icon;
    if (input.color !== undefined) document.color = input.color;
    // A document belongs to a project or, without one, to a team (the team zone).
    if (input.projectId != null) {
      document.projectId = input.projectId;
      delete document.teamId;
    } else if (input.teamId != null) {
      document.teamId = input.teamId;
      delete document.projectId;
    }
    touch(document);
    return { documentUpdate: { success: true, document: documentNode(document, variables.withContent === true) } };
  }
  if (operation === 'FileUpload') {
    return { fileUpload: fileUpload(world, String(variables.filename), String(variables.contentType), Number(variables.size)) };
  }
  if (operation === 'FileUploads') {
    // One aliased `fileUpload` per file: f0, f1, … with variables filename0, filename1, …
    const payload: Record<string, unknown> = {};
    for (let index = 0; variables[`filename${index}`] !== undefined; index += 1) {
      payload[`f${index}`] = fileUpload(world, String(variables[`filename${index}`]), String(variables[`contentType${index}`]), Number(variables[`size${index}`]));
    }
    return payload;
  }
  if (operation === 'TrashDocument') {
    const document = documents.find((d) => d.id === variables.id);
    if (document !== undefined) {
      // `documentDelete` only moves the document to the trash, and sets `archivedAt` with it.
      document.trashed = true;
      document.archivedAt = new Date().toISOString();
      touch(document);
    }
    return { documentDelete: { success: document !== undefined } };
  }
  if (operation === 'CommentOnDocument') {
    const input = variables.input as { id?: string; documentContentId: string; body: string };
    const id = input.id ?? `comment-${world.linear.comments.size + 1}`;
    world.linear.comments.set(id, { documentContentId: input.documentContentId, body: input.body });
    return { commentCreate: { success: true, comment: { id } } };
  }
  if (operation === 'UpdateDocumentComment') {
    const comment = world.linear.comments.get(variables.id as string);
    if (comment !== undefined) comment.body = (variables.input as { body: string }).body;
    return { commentUpdate: { success: comment !== undefined, comment: comment === undefined ? null : { id: variables.id } } };
  }
  if (operation === 'RestoreDocument') {
    const document = documents.find((d) => d.id === variables.id);
    if (document !== undefined) {
      delete document.trashed;
      delete document.archivedAt;
      touch(document);
    }
    return { documentUnarchive: { success: document !== undefined } };
  }
  return undefined;
}

let clock = 0;

/** Moves a document's `updatedAt` past every earlier change, as Linear does on a write. */
export function touch(document: FakeDocument): void {
  clock += 1;
  document.updatedAt = new Date(Date.UTC(2026, 1, 1) + clock * 1000).toISOString();
}

/** Issues an upload target; the storage PUT to it fills in the bytes. */
function fileUpload(world: FakeWorld, filename: string, contentType: string, size: number) {
  const index = world.linear.uploads.length;
  const upload: FakeUpload = { filename, contentType, size, assetUrl: `${UPLOADS_HOST}/${index}/${encodeURIComponent(filename)}` };
  world.linear.uploads.push(upload);
  return { success: true, uploadFile: { uploadUrl: `${LINEAR_API}/storage/${index}`, assetUrl: upload.assetUrl, headers: [] } };
}

function documentNode(d: FakeDocument, withContent: boolean) {
  return {
    id: d.id,
    title: d.title,
    slugId: d.id,
    icon: d.icon ?? null,
    color: d.color ?? null,
    documentContentId: `content-${d.id}`,
    trashed: d.trashed ?? null,
    archivedAt: d.archivedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt ?? d.createdAt,
    project: d.projectId !== undefined ? { id: d.projectId } : null,
    team: d.projectId === undefined && d.teamId !== undefined ? { id: d.teamId } : null,
    ...(withContent ? { content: d.content ?? '' } : {}),
  };
}

/** One project's or team zone's documents, oldest first, in pages of `first` after the cursor (an index). */
function listDocuments(world: FakeWorld, variables: Record<string, unknown>) {
  const filter = variables.filter as { project?: { id: { eq: string } }; team?: { id: { eq: string } } };
  const projectId = filter.project?.id.eq;
  const teamId = filter.team?.id.eq;
  const matching = world.linear.documents
    .filter((d) => (projectId !== undefined ? d.projectId === projectId : d.teamId === teamId && d.projectId === undefined))
    .filter((d) => d.unlisted !== true)
    .filter((d) => variables.includeArchived === true || (d.trashed !== true && d.archivedAt === undefined))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const start = variables.after === null ? 0 : Number(variables.after);
  const end = start + Number(variables.first);
  const nodes = matching.slice(start, end).map((d) => documentNode(d, variables.withContent === true));
  return { nodes, pageInfo: { hasNextPage: end < matching.length, endCursor: end < matching.length ? String(end) : null } };
}
