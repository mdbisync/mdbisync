// A fake GitHub REST API and Linear API behind one `fetch`, for the setup
// check's tests. It answers the way the real services were seen to answer
// an installation token and a client-credentials token, records every
// request, and counts anything that would have written.

import { PERMISSION_PROBES } from './github.ts';

export const GITHUB_API = 'https://github.test/api';
/** The fake App: the run's `app-slug`, and the commit identity GitHub links to it. */
export const FAKE_APP_SLUG = 'sync-app';
export const FAKE_APP_ID = 1001;
export const FAKE_APP_IDENTITY = { name: 'sync-app[bot]', email: '1001+sync-app[bot]@users.noreply.github.com' } as const;
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
export const UPLOADS_HOST = 'https://uploads.linear.app';

/** How the fake answers document writes. */
export interface FakeWrites {
  /** Mutations received so far. */
  count: number;
  /** Answer 429 from this mutation on (1-based), as Linear does when rate limited. */
  rateLimitAt?: number;
  /** Rejects a mutation with a GraphQL error when it returns true. */
  reject?: (operation: string, variables: Record<string, unknown>) => boolean;
}

/** A pull request in the fake repository; tests merge or close it by changing `state`. */
export interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  /**
   * Its head branch was deleted. GitHub then closes the pull request itself,
   * a little later, and answers 422 to any change of its state.
   */
  headDeleted?: boolean;
  /** With `headDeleted`: reads that still show it open before GitHub's own close lands; none when undefined. */
  openReadsLeft?: number;
}

/** A check run or commit status on a commit in the fake repository. */
export interface FakeCheck {
  name: string;
  /** Check runs: `queued`, `in_progress` or `completed`; commit statuses use `pending` or `completed`. */
  status: 'queued' | 'in_progress' | 'pending' | 'completed';
  /** For a completed check: `success`, `failure`, `neutral`, `skipped`, `cancelled`, `timed_out`, or a status's `error`. */
  conclusion?: string;
  /** A commit status (the statuses API) instead of a check run. */
  commitStatus?: boolean;
  /** A commit status's link (`target_url`). */
  url?: string;
  /** A check run's annotations, as `GET /check-runs/<id>/annotations` answers them. */
  annotations?: Array<{ path: string; start_line: number; title?: string; message: string }>;
  /** An HTTP status the annotations endpoint answers for this check run instead of its annotations. */
  annotationsStatus?: number;
}

export interface FakeWorld {
  github: {
    tokenValid: boolean;
    /** The App the token is of: its slug and its bot account's id, which `GET /users/<slug>[bot]` answers. */
    app: { slug: string; id: number };
    missing: Set<string>;
    allowMergeCommit: boolean;
    rateLimited: boolean;
    rateLimitedRepository: boolean;
    pullRequests: FakePullRequest[];
    /** The head SHA GitHub currently shows on a pull request detail read. */
    pullRequestHead?: (pr: FakePullRequest) => Promise<string>;
    /** Answer 422 to every pull request a run tries to open. */
    refusePullRequests?: boolean;
    /** Checks by commit; a commit without an entry has none. */
    checks?: Map<string, FakeCheck[]>;
    /** Check runs in the order the world first listed them: a run's id is its place here, from 1. */
    checkRuns?: FakeCheck[];
    /** How many annotation pages the runs read. */
    annotationReads?: number;
    /**
     * Merges a pull request as GitHub would, while its head is `sha`: the
     * test moves the base branch and answers the merge commit, or answers
     * GitHub's refusal status, with its message when given. Without it,
     * GitHub answers 405.
     */
    merge?: (pr: FakePullRequest, sha: string) => Promise<{ sha: string } | { status: number; message?: string }>;
    /**
     * Breaks the connection of a request (`METHOD path`, the path after the
     * repository): `before` GitHub handles it, or `after`, so its answer is
     * lost. Undefined lets the request through. `body` is the request's JSON
     * body, empty for none; the setup check's probes send bodies that lack
     * required fields.
     */
    reset?: (request: string, body: Record<string, unknown>) => 'before' | 'after' | undefined;
    /**
     * Answers a request (as for `reset`) with HTTP 500, as in a GitHub
     * outage: `before` GitHub handles it, or `after` it applied the request,
     * so the answer hides a change that happened.
     */
    serverError?: (request: string, body: Record<string, unknown>) => 'before' | 'after' | undefined;
  };
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
    /** Optional deterministic query-boundary edits by a test user. */
    beforeQuery?: (operation: string, variables: Record<string, unknown>) => void;
    writes: FakeWrites;
    store: (content: string) => string;
    /** The workspace's URL key, in its document URLs. */
    urlKey: string;
    uploads: FakeUpload[];
    /** Comments on documents, by comment id. */
    comments: Map<string, { documentContentId: string; body: string; resolved?: boolean }>;
    /** Projects removed with `projectDelete`; their documents stay, archived. */
    deletedProjects?: string[];
    /**
     * How many of the next team lookups the token sees no team in, as one
     * run against the live service did while every team existed; `Infinity`
     * when the app has no team access at all.
     */
    teamsHidden?: number;
    /**
     * Documents every read leaves out (the listing, reads by id, and
     * `document(id:)`, which answers not found), as a blank answer from
     * Linear would while they exist.
     */
    blankAnswer?: (document: FakeDocument) => boolean;
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
    github: { tokenValid: true, app: { slug: FAKE_APP_SLUG, id: FAKE_APP_ID }, missing: new Set(), allowMergeCommit: true, rateLimited: false, rateLimitedRepository: false, pullRequests: [] },
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
  const githubUrl = new URL(GITHUB_API);
  const linearUrl = new URL(LINEAR_API);
  const uploadsUrl = new URL(UPLOADS_HOST);
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    world.requests.push(`${method} ${url}`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`unexpected request to ${url}`); }
    if (method === 'GET' && parsed.origin === uploadsUrl.origin) {
      const upload = world.linear.uploads.find((entry) => entry.assetUrl === url);
      return upload?.bytes === undefined ? new Response(null, {status:404}) : new Response(upload.bytes, {headers:{'content-type':upload.contentType}});
    }
    if (parsed.origin === githubUrl.origin && (parsed.pathname === githubUrl.pathname || parsed.pathname.startsWith(`${githubUrl.pathname}/`))) {
      const path = parsed.pathname.slice(githubUrl.pathname.length) + parsed.search;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const request = `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, '')}`;
      const reset = world.github.reset?.(request, body);
      const serverError = world.github.serverError?.(request, body);
      if (reset === 'before') throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
      if (serverError === 'before') return json(500, { message: 'Server Error' });
      const answer = await github(world, method, path, init);
      if (reset === 'after') throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
      if (serverError === 'after') return json(500, { message: 'Server Error' });
      return answer;
    }
    if (parsed.origin === linearUrl.origin) return linear(world, parsed.pathname + parsed.search, init);
    throw new Error(`unexpected request to ${url}`);
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function github(world: FakeWorld, method: string, path: string, init: RequestInit | undefined): Promise<Response> {
  if (!world.github.tokenValid) return json(401, { message: 'Bad credentials' });
  if (world.github.rateLimitedRepository) return json(403, { message: 'API rate limit exceeded for installation.' });
  const user = /^\/users\/([^/?]+)$/.exec(path);
  if (user !== null && method === 'GET') {
    // GitHub's bot account of an App; logins are matched without case.
    const login = `${world.github.app.slug}[bot]`;
    return decodeURIComponent(user[1] as string).toLowerCase() === login.toLowerCase()
      ? json(200, { login, id: world.github.app.id, type: 'Bot' })
      : json(404, { message: 'Not Found' });
  }
  const repo = /^\/repos\/[^/]+\/[^/]+/.exec(path);
  if (repo === null) return json(404, { message: 'Not Found' });
  const rest = path.slice(repo[0].length);
  if (rest === '' && method === 'GET') {
    // GitHub shows the merge settings only to a token with write access.
    const writable = !world.github.missing.has('contents:write');
    return json(200, { full_name: repo[0].slice(7), ...(writable ? { allow_merge_commit: world.github.allowMergeCommit } : {}) });
  }
  const pulls = await pullRequests(world, method, rest, init);
  if (pulls !== undefined) return pulls;
  const merged = await mergeRequest(world, method, rest, init);
  if (merged !== undefined) return merged;
  const checks = commitChecks(world, method, rest);
  if (checks !== undefined) return checks;
  const annotations = checkAnnotations(world, method, rest);
  if (annotations !== undefined) return annotations;
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

/**
 * Lists and opens pull requests; undefined for other requests, and for the
 * setup check's empty-bodied probe, which the probes answer.
 */
async function pullRequests(world: FakeWorld, method: string, rest: string, init: RequestInit | undefined): Promise<Response | undefined> {
  const [path = '', search = ''] = rest.split('?');
  const store = world.github.pullRequests;
  const one = /^\/pulls\/(\d+)$/.exec(path);
  if (one !== null && method === 'GET') {
    const pr = store.find((candidate) => candidate.number === Number(one[1]));
    if (pr === undefined) return json(404, { message: 'Not Found' });
    const node = pullRequestNode(read(pr));
    const sha = await world.github.pullRequestHead?.(pr);
    return json(200, { ...node, head: { ...node.head, sha } });
  }
  if (one !== null && method === 'PATCH') {
    const pr = store.find((candidate) => candidate.number === Number(one[1]));
    if (pr === undefined) return json(404, { message: 'Not Found' });
    const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string; body?: string; state?: 'open' | 'closed' };
    if (body.state !== undefined && pr.headDeleted === true) return json(422, { message: 'Validation Failed', errors: [{ message: 'state cannot be changed. The head branch was deleted.' }] });
    if (body.title !== undefined) pr.title = body.title;
    if (body.body !== undefined) pr.body = body.body;
    if (body.state !== undefined) pr.state = body.state;
    world.writes.push(`${method} ${path}`);
    return json(200, pullRequestNode(pr));
  }
  if (path !== '/pulls') return undefined;
  if (method === 'GET') {
    const query = new URLSearchParams(search);
    const state = query.get('state') ?? 'open';
    const head = query.get('head');
    const base = query.get('base');
    const found = store
      .filter((pr) => (head === null || `owner:${pr.head}` === head) && (base === null || pr.base === base))
      .map(read)
      .filter((pr) => state === 'all' || pr.state === state);
    return json(200, found.map(pullRequestNode));
  }
  if (method !== 'POST') return undefined;
  const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string; head?: string; base?: string; body?: string };
  if (body.head === undefined) return undefined;
  if (world.github.missing.has('pull_requests:write')) return json(403, { message: 'Resource not accessible by integration' });
  if (world.github.refusePullRequests) return json(422, { message: 'Validation Failed' });
  if (store.some((pr) => pr.state === 'open' && pr.head === body.head && pr.base === body.base)) {
    return json(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] });
  }
  world.writes.push(`${method} ${path}`);
  const pr: FakePullRequest = { number: store.length + 1, title: body.title ?? '', body: body.body ?? '', head: body.head, base: body.base ?? '', state: 'open', merged: false };
  store.push(pr);
  return json(201, pullRequestNode(pr));
}

/** `PUT /pulls/<n>/merge` with a merge commit; undefined for other requests. */
async function mergeRequest(world: FakeWorld, method: string, rest: string, init: RequestInit | undefined): Promise<Response | undefined> {
  const one = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (one === null || method !== 'PUT') return undefined;
  const pr = world.github.pullRequests.find((candidate) => candidate.number === Number(one[1]));
  if (pr === undefined) return json(404, { message: 'Not Found' });
  if (pr.state !== 'open') return json(422, { message: 'Pull Request is not open' });
  const body = JSON.parse(String(init?.body ?? '{}')) as { merge_method?: string; sha?: string };
  if (body.merge_method !== 'merge' || body.sha === undefined) return json(422, { message: 'Validation Failed' });
  const answer = world.github.merge === undefined ? { status: 405 } : await world.github.merge(pr, body.sha);
  if ('status' in answer) return json(answer.status, { message: answer.message ?? 'Pull Request is not mergeable' });
  world.writes.push(`${method} ${rest}`);
  Object.assign(pr, { state: 'closed', merged: true });
  return json(200, { sha: answer.sha, merged: true, message: 'Pull Request successfully merged' });
}

/**
 * A commit's check runs and combined status. The setup check's probe of
 * check runs (`per_page=1`) reads the same list.
 */
function commitChecks(world: FakeWorld, method: string, rest: string): Response | undefined {
  const match = /^\/commits\/([0-9a-f]+)\/(check-runs|status)(\?.*)?$/.exec(rest);
  if (match === null || method !== 'GET') return undefined;
  if (world.github.rateLimited) return json(403, { message: 'You have exceeded a secondary rate limit.' });
  if (match[2] === 'check-runs' && world.github.missing.has('checks:read')) return json(403, { message: 'Resource not accessible by integration' });
  if (match[2] === 'status' && world.github.missing.has('statuses:read')) return json(403, { message: 'Resource not accessible by integration' });
  const all = world.github.checks?.get(match[1] as string) ?? [];
  if (match[2] === 'status') {
    const statuses = all.filter((check) => check.commitStatus === true).map((check) => ({ context: check.name, state: check.status === 'completed' ? check.conclusion : 'pending', target_url: check.url ?? null }));
    return json(200, { state: statuses.length === 0 ? 'pending' : 'success', total_count: statuses.length, statuses });
  }
  const runs = all.filter((check) => check.commitStatus !== true);
  const page = Number(new URLSearchParams(match[3] ?? '').get('page') ?? '1');
  const size = Number(new URLSearchParams(match[3] ?? '').get('per_page') ?? '30');
  const slice = runs.slice((page - 1) * size, page * size);
  return json(200, { total_count: runs.length, check_runs: slice.map((check) => ({ id: checkRunId(world, check), name: check.name, status: check.status, conclusion: check.conclusion ?? null, html_url: `https://github.test/owner/repo/runs/${checkRunId(world, check)}` })) });
}

/** A check run's id: the order in which the world first listed it, from 1. */
function checkRunId(world: FakeWorld, check: FakeCheck): number {
  const listed = (world.github.checkRuns ??= []);
  if (!listed.includes(check)) listed.push(check);
  return listed.indexOf(check) + 1;
}

/** `GET /check-runs/<id>/annotations`: the annotations of the check run with that id. */
function checkAnnotations(world: FakeWorld, method: string, rest: string): Response | undefined {
  const match = /^\/check-runs\/(\d+)\/annotations(\?.*)?$/.exec(rest);
  if (match === null || method !== 'GET') return undefined;
  if (world.github.missing.has('checks:read')) return json(403, { message: 'Resource not accessible by integration' });
  world.github.annotationReads = (world.github.annotationReads ?? 0) + 1;
  const check = world.github.checkRuns?.[Number(match[1]) - 1];
  if (check === undefined || check.commitStatus === true) return json(404, { message: 'Not Found' });
  if (check.annotationsStatus !== undefined) return json(check.annotationsStatus, { message: 'Not Found' });
  const query = new URLSearchParams(match[2] ?? '');
  const page = Number(query.get('page') ?? '1');
  const size = Number(query.get('per_page') ?? '30');
  const all = (check.annotations ?? []).map((annotation) => ({ ...annotation, end_line: annotation.start_line, annotation_level: 'failure' }));
  return json(200, all.slice((page - 1) * size, page * size));
}

/** A read of a pull request: GitHub's own close of one whose head branch was deleted lands after its open reads run out. */
function read(pr: FakePullRequest): FakePullRequest {
  if (pr.headDeleted !== true || pr.state === 'closed') return pr;
  if ((pr.openReadsLeft ?? 0) > 0) pr.openReadsLeft = (pr.openReadsLeft ?? 0) - 1;
  else pr.state = 'closed';
  return pr;
}

function pullRequestNode(pr: FakePullRequest) {
  return { number: pr.number, html_url: `https://github.test/owner/repo/pull/${pr.number}`, state: pr.state, head: { ref: pr.head }, base: { ref: pr.base }, title: pr.title, body: pr.body };
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
    // Linear refuses to resolve a comment on a document in its trash (seen live 2026-11-12: INPUT_ERROR with HTTP 200).
    // The refusal changes nothing, so it is not one of the writes the fake took; it still counts toward the rate limit.
    const refusedResolve = operationName === 'ResolveComment' && commentOnTrashedDocument(world, variables.id as string);
    if (!refusedResolve) world.writes.push(operationName);
    const write = world.linear.writes;
    write.count += 1;
    if (write.rateLimitAt !== undefined && write.count >= write.rateLimitAt) {
      return json(429, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] });
    }
    if (write.reject?.(operationName, variables) === true) {
      return json(200, { errors: [{ message: 'Rejected by the fake', extensions: { code: 'INVALID_INPUT' } }], data: null });
    }
    if (refusedResolve) return json(200, { errors: [{ message: 'Comment cannot be resolved', extensions: { code: 'INPUT_ERROR' } }], data: null });
    if (operationName === 'UpdateDocument' && !world.linear.documents.some((d) => d.id === variables.id)) {
      return json(200, { errors: [{ message: 'Entity not found: Document', extensions: { code: 'INPUT_ERROR' } }], data: null });
    }
    if (operationName === 'RestoreDocument' && inDeletedProject(world, variables.id as string)) {
      // As measured: Linear refuses to restore a trashed document whose project was deleted.
      return json(200, { errors: [{ message: 'Project not found', extensions: { code: 'INPUT_ERROR' } }], data: null });
    }
    // Linear refuses a client-chosen comment id it already holds (measured 2026-11-10: INPUT_ERROR "conflict on insert of Comment").
    const commentId = operationName === 'CommentOnDocument' ? (variables.input as { id?: string }).id : undefined;
    if (commentId !== undefined && world.linear.comments.has(commentId)) return json(200, { errors: [{ message: 'conflict on insert of Comment', extensions: { code: 'INPUT_ERROR' } }], data: null });
    return json(200, { data: documentMutation(world, operationName, variables) ?? {} });
  }
  world.linear.beforeQuery?.(operationName, variables);
  if (operationName === 'SetupTargets') {
    const refs = variables.refs as string[];
    const hidden = (world.linear.teamsHidden ?? 0) > 0;
    if (hidden) world.linear.teamsHidden = (world.linear.teamsHidden as number) - 1;
    const seen = hidden ? [] : world.linear.teams;
    const teams = { nodes: seen.filter((team) => refs.includes(team.key) || refs.includes(team.name)) };
    // `visible: teams(first: 1)` asks whether the token sees any team.
    const visible = /\bvisible:\s*teams\(/.test(query) ? { visible: { nodes: seen.slice(0, 1).map((team) => ({ id: team.id })) } } : {};
    // The projects are asked for only when the query names them.
    if (!Array.isArray(variables.names)) return json(200, { data: { teams, ...visible } });
    const names = variables.names as string[];
    const nodes = (hidden ? [] : world.linear.projects)
      .filter((project) => names.includes(project.name))
      .map((project) => ({ id: project.id, name: project.name, teams: { nodes: project.teamIds.map((id) => ({ id })) } }));
    return json(200, { data: { teams, projects: { nodes, pageInfo: { hasNextPage: false } }, ...visible } });
  }
  if (operationName === 'WorkspaceUrlKey') return json(200, { data: { organization: { urlKey: world.linear.urlKey } } });
  if (operationName === 'ListDocuments') return json(200, { data: { documents: listDocuments(world, variables) } });
  if (operationName === 'FindComment') {
    const id = variables.id as string;
    return json(200, { data: { comments: { nodes: world.linear.comments.has(id) ? [{ id }] : [] } } });
  }
  if (operationName === 'FindDocumentComment') {
    const id = variables.id as string;
    const comment = world.linear.comments.get(id);
    return json(200, { data: { comments: { nodes: comment === undefined ? [] : [{ id, documentContentId: comment.documentContentId }] } } });
  }
  if (operationName === 'GetDocuments') {
    // Read by id: trashed documents are included, unknown ids are absent.
    const ids = variables.ids as string[];
    const nodes = world.linear.documents.filter((d) => ids.includes(d.id) && d.unlisted !== true && world.linear.blankAnswer?.(d) !== true).map((d) => documentNode(d, variables.withContent === true));
    return json(200, { data: { documents: { nodes } } });
  }
  if (operationName === 'GetDocument') {
    // `document(id:)`: trashed and archived documents too; an unknown id is a GraphQL error, as in Linear.
    const document = world.linear.documents.find((d) => d.id === variables.id && world.linear.blankAnswer?.(d) !== true);
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
    // An unknown id was already answered with Linear's not-found error.
    const document = documents.find((d) => d.id === variables.id)!;
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
  if (operation === 'ResolveComment') {
    const comment = world.linear.comments.get(variables.id as string);
    if (comment !== undefined) comment.resolved = true;
    return { commentResolve: { success: comment !== undefined } };
  }
  if (operation === 'UpdateDocumentComment') {
    const comment = world.linear.comments.get(variables.id as string);
    if (comment !== undefined) comment.body = (variables.input as { body: string }).body;
    return { commentUpdate: { success: comment !== undefined, comment: comment === undefined ? null : { id: variables.id } } };
  }
  if (operation === 'CreateProject') {
    const input = variables.input as { name: string; teamIds: string[] };
    const project: FakeProject = { id: `project-${world.linear.projects.length + (world.linear.deletedProjects?.length ?? 0) + 1}`, name: input.name, teamIds: input.teamIds };
    world.linear.projects.push(project);
    return { projectCreate: { project: { id: project.id } } };
  }
  if (operation === 'DeleteProject') {
    const index = world.linear.projects.findIndex((p) => p.id === variables.id);
    if (index === -1) return { projectDelete: { success: false } };
    const [project] = world.linear.projects.splice(index, 1);
    (world.linear.deletedProjects ??= []).push(project!.id);
    // Deleting a project archives its live documents; trashed ones stay trashed.
    for (const document of documents) {
      if (document.projectId === project!.id && document.archivedAt === undefined) document.archivedAt = new Date().toISOString();
    }
    return { projectDelete: { success: true } };
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

function inDeletedProject(world: FakeWorld, id: string): boolean {
  const projectId = world.linear.documents.find((d) => d.id === id)?.projectId;
  return projectId !== undefined && world.linear.deletedProjects?.includes(projectId) === true;
}

/** Whether the comment `id` is on a document that is in the trash. */
function commentOnTrashedDocument(world: FakeWorld, id: string): boolean {
  const contentId = world.linear.comments.get(id)?.documentContentId;
  return contentId !== undefined && world.linear.documents.some((d) => contentIdOf(d) === contentId && d.trashed === true);
}

/** The id of a document's content, which its comments name. */
function contentIdOf(d: FakeDocument): string {
  return `content-${d.id}`;
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
    documentContentId: contentIdOf(d),
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
  type Filter = {project?:{id:{eq:string}}; team?:{id:{eq:string}}; or?:Filter[]};
  const filter = variables.filter as Filter;
  const matches = (doc: FakeDocument, rule: Filter): boolean => rule.or !== undefined ? rule.or.some((nested) => matches(doc, nested)) : rule.project !== undefined ? doc.projectId === rule.project.id.eq : rule.team !== undefined && doc.teamId === rule.team.id.eq && doc.projectId === undefined;
  const matching = world.linear.documents
    .filter((d) => matches(d, filter))
    .filter((d) => d.unlisted !== true && world.linear.blankAnswer?.(d) !== true)
    .filter((d) => variables.includeArchived === true || (d.trashed !== true && d.archivedAt === undefined))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const start = variables.after === null ? 0 : Number(variables.after);
  const end = start + Number(variables.first);
  const nodes = matching.slice(start, end).map((d) => documentNode(d, variables.withContent === true));
  return { nodes, pageInfo: { hasNextPage: end < matching.length, endCursor: end < matching.length ? String(end) : null } };
}
