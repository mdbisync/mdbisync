// A local proxy in front of Linear's API. The engine reaches Linear through
// it in every local run (MDBISYNC_TEST_LINEAR_URL), so the harness can count
// the engine's requests (I9) and inject faults: an HTTP status at the n-th
// request (429 with or without Retry-After, 500), a reset connection on a
// write, low remaining-budget headers, a rejected document and a failed
// upload. It never logs or keeps request or response bodies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Fault =
  /** Answer the n-th matching request after arming; GraphQL is the default target. */
  | { kind: 'http'; target?: 'graphql' | 'oauth'; operation?: string; status: number; requestNumber: number; retryAfterSeconds: number | null; times: number }
  /**
   * Fail the next document write (create or update, or only the one named):
   * `server-error` answers 500 and `reset` drops the connection, both before
   * Linear sees the write; `reset-after-apply` passes the write on, waits for
   * Linear's answer and drops the connection instead of sending it, so Linear
   * has applied a write the engine never hears about.
   */
  | { kind: 'write-error'; variant: 'server-error' | 'reset' | 'reset-after-apply'; operation?: 'create' | 'update'; times: number }
  /** Pass requests on, but report this little budget left. */
  | { kind: 'budget-headers'; remaining: number; includeEndpointLimits: boolean }
  /**
   * Refuse writes of one document: by its id once it exists, and by its
   * name (a title equal to it or ending in `/<name>`) for a create.
   * Only the write's own `id` and `title` fields count, never its content.
   */
  | { kind: 'reject-document'; ids: readonly string[]; titles: readonly string[] }
  /** Fail the upload request. */
  | { kind: 'upload-error'; times: number }
  /** Answer every request that names this document id as Linear answers for a document deleted for good. */
  | { kind: 'document-gone'; id: string };

export interface ProxyRequestRecord {
  n: number;
  operation: string;
  kind: 'query' | 'mutation' | 'other';
  status: number | 'reset';
  injected: boolean;
  /**
   * Linear answered (with `status`) but the proxy dropped the answer: the
   * write happened, the engine never heard of it.
   */
  answerDropped?: boolean;
  /** When the request arrived (ms since the epoch). */
  at: number;
}

/**
 * A write-error variant as specs write it, as the proxy's fault.
 * `reset-after-apply` may name the write it hits: `-on-create` or `-on-update`.
 */
export function writeError(variant: string): Fault {
  const applied = /^reset-after-apply(?:-on-(create|update))?$/.exec(variant);
  if (applied !== null) return { kind: 'write-error', variant: 'reset-after-apply', ...(applied[1] === undefined ? {} : { operation: applied[1] as 'create' | 'update' }), times: 1 };
  if (variant === 'reset' || variant === 'connection-reset') return { kind: 'write-error', variant: 'reset', times: 1 };
  if (variant === 'server-error' || variant === 'http-500') return { kind: 'write-error', variant: 'server-error', times: 1 };
  throw new Error(`unknown write-error variant ${variant}`);
}

/**
 * Whether a GraphQL answer to a write says the write happened: data and no
 * errors, and no mutation payload with `success: false`.
 */
export function writeApplied(payload: Buffer): boolean {
  let answer: { data?: unknown; errors?: unknown[] };
  try {
    answer = JSON.parse(payload.toString('utf8')) as { data?: unknown; errors?: unknown[] };
  } catch {
    return false;
  }
  if ((answer.errors?.length ?? 0) > 0 || answer.data === null || typeof answer.data !== 'object') return false;
  return Object.values(answer.data as Record<string, unknown>).every((result) => result !== null && (typeof result !== 'object' || (result as { success?: unknown }).success !== false));
}

/** Every `id` and `title` value in a GraphQL request's variables. */
export function writeFields(body: string): { ids: string[]; titles: string[] } {
  const ids: string[] = [];
  const titles: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'id' && typeof value === 'string') ids.push(value);
        else if (key === 'title' && typeof value === 'string') titles.push(value);
        else walk(value);
      }
    }
  };
  try {
    walk((JSON.parse(body) as { variables?: unknown }).variables);
  } catch {
    // Not JSON: no fields.
  }
  return { ids, titles };
}

/** Whether a write names the rejected document: by its id, or by a title whose last segment is the document's name. */
function namesDocument(body: string, fault: { ids: readonly string[]; titles: readonly string[] }): boolean {
  const fields = writeFields(body);
  return fields.ids.some((id) => fault.ids.includes(id)) || fields.titles.some((title) => fault.titles.some((name) => title === name || title.endsWith(`/${name}`)));
}

export interface FaultProxy {
  readonly url: string;
  readonly requests: readonly ProxyRequestRecord[];
  /** Bearer tokens the engine used, kept in memory only so token hygiene can be checked (L5-20); never logged. */
  tokens(): readonly string[];
  setFaults(faults: readonly Fault[]): void;
  clearFaults(): void;
  /** Requests by kind since the start or the last reset of the counters. */
  counts(): { total: number; queries: number; mutations: number; injected: number };
  resetCounters(): void;
  close(): Promise<void>;
}

const WRITE_OPERATIONS = /^(?:documentCreate|documentUpdate|CreateDocument|UpdateDocument)$/i;
const UPLOAD_OPERATIONS = /^(?:fileUpload|FileUpload|Upload.*)$/;

export function operationOf(body: string): { operation: string; kind: ProxyRequestRecord['kind'] } {
  try {
    const parsed = JSON.parse(body) as { operationName?: unknown; query?: unknown };
    const query = typeof parsed.query === 'string' ? parsed.query : '';
    const match = /^\s*(query|mutation)\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(query);
    const kind = match?.[1] === 'mutation' ? 'mutation' : match?.[1] === 'query' || query.trimStart().startsWith('{') ? 'query' : 'other';
    const name = typeof parsed.operationName === 'string' ? parsed.operationName : (match?.[2] ?? 'anonymous');
    return { operation: name, kind };
  } catch {
    return { operation: 'unparsed', kind: 'other' };
  }
}

/** A GraphQL answer with the given documents left out of every list, as Linear lists no document deleted for good. */
export function withoutDocuments(payload: Buffer, ids: ReadonlySet<string>): Buffer {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return payload;
  }
  const prune = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.filter((item) => !(item !== null && typeof item === 'object' && ids.has(String((item as { id?: unknown }).id)))).map(prune);
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, prune(item)]));
    return node;
  };
  return Buffer.from(JSON.stringify(prune(value)));
}

/** Whether the request's text names a target id or title; the body itself is not kept. */
function names(body: string, target: string): boolean {
  return body.includes(JSON.stringify(target).slice(1, -1));
}

export async function startFaultProxy(upstream: string, options: { fetch?: typeof fetch } = {}): Promise<FaultProxy> {
  const forward = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const base = upstream.replace(/\/+$/, '');
  let faults: Array<Fault & { used?: number; matched?: number }> = [];
  let counter = 0;
  const requests: ProxyRequestRecord[] = [];
  const tokens = new Set<string>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');
    counter += 1;
    const n = counter;
    const path = (request.url ?? '').split('?')[0];
    const isGraphql = path === '/graphql';
    const { operation, kind } = isGraphql ? operationOf(text) : { operation: `http ${request.url?.split('?')[0] ?? ''}`, kind: 'other' as const };
    const at = Date.now();
    const record = (status: number | 'reset', injected: boolean) => requests.push({ n, operation, kind, status, injected, at });
    const bearer = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ''))?.[1];
    if (bearer !== undefined) tokens.add(bearer);

    // A lost-answer fault for this write, used up only once the write has reached Linear.
    let dropAnswer: (Fault & { used?: number }) | undefined;
    for (const fault of faults) {
      const used = fault.used ?? 0;
      if (fault.kind === 'http') {
        const matchesTarget = fault.target === 'oauth' ? path === '/oauth/token' : isGraphql;
        if (!matchesTarget || (fault.operation !== undefined && fault.operation !== operation)) continue;
        const position = fault.matched = (fault.matched ?? 0) + 1;
        if (position >= fault.requestNumber && used < fault.times) {
          fault.used = used + 1;
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (fault.retryAfterSeconds !== null) headers['retry-after'] = String(fault.retryAfterSeconds);
          const code = fault.status === 429 ? 'RATELIMITED' : 'INTERNAL_SERVER_ERROR';
          response.writeHead(fault.status, headers).end(JSON.stringify({ errors: [{ message: 'injected fault', extensions: { code } }] }));
          record(fault.status, true);
          return;
        }
      } else if (fault.kind === 'write-error' && WRITE_OPERATIONS.test(operation) && used < fault.times && (fault.operation === undefined || (fault.operation === 'create') === /create/i.test(operation))) {
        if (fault.variant === 'reset-after-apply') {
          // Decided after every other fault had its say: a rejection or a "not found" still answers first.
          dropAnswer ??= fault;
          continue;
        }
        fault.used = used + 1;
        if (fault.variant === 'reset') {
          record('reset', true);
          request.socket.destroy();
          return;
        }
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ message: 'injected fault' }] }));
        record(500, true);
        return;
      } else if (fault.kind === 'reject-document' && kind === 'mutation' && WRITE_OPERATIONS.test(operation) && namesDocument(text, fault)) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ data: null, errors: [{ message: 'injected rejection', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'rejected' } }] }),
        );
        record(200, true);
        return;
      } else if (fault.kind === 'document-gone' && names(text, fault.id) && (kind === 'mutation' || /\bdocument\s*\(\s*id\s*:/.test(text))) {
        // A lookup or a write of that one document: Linear's "not found". Collections leave it out (below).
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ data: null, errors: [{ message: 'Entity not found: Document', extensions: { code: 'INVALID_INPUT', type: 'invalid input', userPresentableMessage: 'Could not find referenced Document.' } }] }),
        );
        record(200, true);
        return;
      } else if (fault.kind === 'upload-error' && UPLOAD_OPERATIONS.test(operation) && used < fault.times) {
        fault.used = used + 1;
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ message: 'injected fault' }] }));
        record(500, true);
        return;
      }
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ['host', 'connection', 'content-length', 'accept-encoding'].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    let upstreamResponse: Response;
    try {
      upstreamResponse = await forward(`${base}${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
    } catch {
      record(502, false);
      response.writeHead(502).end();
      return;
    }
    const out: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = value;
    });
    const budget = faults.find((fault) => fault.kind === 'budget-headers');
    if (budget?.kind === 'budget-headers') {
      out['x-ratelimit-requests-remaining'] = String(budget.remaining);
      out['x-ratelimit-complexity-remaining'] = String(budget.remaining * 100);
      if (budget.includeEndpointLimits) {
        out['x-ratelimit-endpoint-name'] = operation;
        out['x-ratelimit-endpoint-requests-limit'] = '100';
        out['x-ratelimit-endpoint-requests-remaining'] = String(Math.min(budget.remaining, 100));
        out['x-ratelimit-endpoint-requests-reset'] = String(Date.now() + 3_600_000);
      }
    }
    let payload: Buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    // A lost answer only for a write Linear applied: a refused one (GraphQL errors come with HTTP 200) is passed
    // on as it is, and the fault stays armed for the next write.
    if (dropAnswer !== undefined && upstreamResponse.ok && writeApplied(payload)) {
      // Linear has the write and answered; the engine never hears it. The record keeps Linear's status, so the
      // write counts as written for I9 and the writes subjects, and marks the lost answer.
      dropAnswer.used = (dropAnswer.used ?? 0) + 1;
      requests.push({ n, operation, kind, status: upstreamResponse.status, injected: false, answerDropped: true, at });
      request.socket.destroy();
      return;
    }
    const gone = faults.flatMap((fault) => (fault.kind === 'document-gone' ? [fault.id] : []));
    if (gone.length > 0 && isGraphql) payload = withoutDocuments(payload, new Set(gone));
    response.writeHead(upstreamResponse.status, out).end(payload);
    record(upstreamResponse.status, false);
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    tokens: () => [...tokens],
    setFaults(next) {
      faults = next.map((fault) => ({ ...fault, used: 0, matched: 0 }));
    },
    clearFaults() {
      faults = [];
    },
    counts() {
      return {
        total: requests.length,
        queries: requests.filter((r) => r.kind === 'query').length,
        mutations: requests.filter((r) => r.kind === 'mutation').length,
        injected: requests.filter((r) => r.injected).length,
      };
    },
    resetCounters() {
      requests.length = 0;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
