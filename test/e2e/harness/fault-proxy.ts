// A local proxy in front of Linear's API. The engine reaches Linear through
// it in every local run (MDBISYNC_TEST_LINEAR_URL), so the harness can count
// the engine's requests (I9) and inject faults: an HTTP status at the n-th
// request (429 with or without Retry-After, 500), a reset connection on a
// write, low remaining-budget headers, a rejected document and a failed
// upload. It never logs or keeps request or response bodies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Fault =
  /** Answer the n-th request (counted from when the fault is set) with a status, `times` times. */
  | { kind: 'http'; status: number; requestNumber: number; retryAfterSeconds: number | null; times: number }
  /** Fail the next document write (create or update) with a server error or a reset connection. */
  | { kind: 'write-error'; variant: 'server-error' | 'reset'; times: number }
  /** Pass requests on, but report this little budget left. */
  | { kind: 'budget-headers'; remaining: number; includeEndpointLimits: boolean }
  /** Refuse writes that name this document id or title. */
  | { kind: 'reject-document'; target: string }
  /** Fail the upload request. */
  | { kind: 'upload-error'; times: number };

export interface ProxyRequestRecord {
  n: number;
  operation: string;
  kind: 'query' | 'mutation' | 'other';
  status: number | 'reset';
  injected: boolean;
}

export interface FaultProxy {
  readonly url: string;
  readonly requests: readonly ProxyRequestRecord[];
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

/** Whether the request's text names a target id or title; the body itself is not kept. */
function names(body: string, target: string): boolean {
  return body.includes(JSON.stringify(target).slice(1, -1));
}

export async function startFaultProxy(upstream: string, options: { fetch?: typeof fetch } = {}): Promise<FaultProxy> {
  const forward = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const base = upstream.replace(/\/+$/, '');
  let faults: Array<Fault & { used?: number; armedAt?: number }> = [];
  let counter = 0;
  const requests: ProxyRequestRecord[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');
    counter += 1;
    const n = counter;
    const isGraphql = (request.url ?? '').startsWith('/graphql');
    const { operation, kind } = isGraphql ? operationOf(text) : { operation: `http ${request.url?.split('?')[0] ?? ''}`, kind: 'other' as const };
    const record = (status: number | 'reset', injected: boolean) => requests.push({ n, operation, kind, status, injected });

    for (const fault of faults) {
      const used = fault.used ?? 0;
      if (fault.kind === 'http') {
        const position = n - (fault.armedAt ?? 0);
        if (position >= fault.requestNumber && used < fault.times) {
          fault.used = used + 1;
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (fault.retryAfterSeconds !== null) headers['retry-after'] = String(fault.retryAfterSeconds);
          const code = fault.status === 429 ? 'RATELIMITED' : 'INTERNAL_SERVER_ERROR';
          response.writeHead(fault.status, headers).end(JSON.stringify({ errors: [{ message: 'injected fault', extensions: { code } }] }));
          record(fault.status, true);
          return;
        }
      } else if (fault.kind === 'write-error' && WRITE_OPERATIONS.test(operation) && used < fault.times) {
        fault.used = used + 1;
        if (fault.variant === 'reset') {
          record('reset', true);
          request.socket.destroy();
          return;
        }
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ message: 'injected fault' }] }));
        record(500, true);
        return;
      } else if (fault.kind === 'reject-document' && kind === 'mutation' && WRITE_OPERATIONS.test(operation) && names(text, fault.target)) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ data: null, errors: [{ message: 'injected rejection', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'rejected' } }] }),
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
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
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
    setFaults(next) {
      faults = next.map((fault) => ({ ...fault, used: 0, armedAt: counter }));
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
