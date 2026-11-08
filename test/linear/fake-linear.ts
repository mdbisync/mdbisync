// A local stand-in for Linear's API: GraphQL by operation name, OAuth token
// endpoints and an upload target, with injectable faults. Used by the unit
// tests; the contract tests run against the real service.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** A JSON body; `data` for success, `errors` for GraphQL errors. */
  body?: unknown;
  /** Drop the connection without an answer. */
  reset?: boolean;
}

export interface ReceivedRequest {
  path: string;
  method: string;
  operation?: string | undefined;
  variables?: Record<string, unknown> | undefined;
  form?: Record<string, string>;
  headers: IncomingMessage['headers'];
  bodyBytes: number;
}

type Handler = (request: ReceivedRequest, index: number) => FakeReply | undefined;

export class FakeLinear {
  readonly received: ReceivedRequest[] = [];
  /** Replies by GraphQL operation name. */
  readonly operations = new Map<string, (request: ReceivedRequest) => FakeReply>();
  /** Checked first for every request; return a reply to inject a fault. */
  fault: Handler | undefined;
  /** Remaining-budget headers sent on every GraphQL answer. */
  budgetHeaders: Record<string, string> = {
    'x-ratelimit-requests-limit': '5000',
    'x-ratelimit-requests-remaining': '4900',
    'x-ratelimit-requests-reset': '1794177648843',
    'x-ratelimit-complexity-limit': '2000000',
    'x-ratelimit-complexity-remaining': '1990000',
    'x-ratelimit-complexity-reset': '1794177648843',
    'x-complexity': '12',
  };
  #server: Server | undefined;
  url = '';

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  graphqlCount(): number {
    return this.received.filter((r) => r.path === '/graphql').length;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const request: ReceivedRequest = { path, method: req.method ?? 'GET', headers: req.headers, bodyBytes: raw.length };
    if (path === '/graphql') {
      const json = JSON.parse(raw.toString('utf8')) as { operationName?: string; variables?: Record<string, unknown> };
      request.operation = json.operationName;
      request.variables = json.variables;
    } else if (path.startsWith('/oauth/')) {
      request.form = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    }
    this.received.push(request);

    const reply = this.fault?.(request, this.received.length) ?? this.#reply(request);
    if (reply.reset) {
      req.socket.destroy();
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', ...reply.headers };
    if (path === '/graphql') Object.assign(headers, { ...this.budgetHeaders, ...reply.headers });
    res.writeHead(reply.status ?? 200, headers);
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }

  #reply(request: ReceivedRequest): FakeReply {
    if (request.path === '/oauth/token') {
      return { body: { access_token: 'fake-token', token_type: 'Bearer', expires_in: 2591999, scope: ['read', 'write'] } };
    }
    if (request.path === '/oauth/revoke') return { body: { success: true } };
    if (request.path === '/upload') return { status: 200 };
    const handler = request.operation ? this.operations.get(request.operation) : undefined;
    if (!handler) return { status: 400, body: { errors: [{ message: `no fake for ${request.operation}` }] } };
    return handler(request);
  }
}

export function fakeDocument(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Title ${id}`,
    slugId: `slug${id}`,
    icon: null,
    color: null,
    trashed: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    documentContentId: `content-${id}`,
    project: { id: 'project-1' },
    team: null,
    ...overrides,
  };
}

export const rateLimited = (retryAfter?: string): FakeReply => ({
  status: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
});
