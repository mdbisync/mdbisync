// A local proxy in front of the sandbox's Git LFS server, for the engine's
// clone only. It passes every batch request on and answers 404 for the
// download of chosen objects, so the engine sees an LFS object the server
// does not have, while the object itself is uploaded and the push that names
// it is accepted (GitHub refuses a push whose pointer names an object it never
// received). Only the batch API passes through it: the transfers go straight
// to the addresses the server answers with. It never logs or keeps request or
// response bodies, and it adds the sandbox's authorization itself, so the
// engine's credential is never sent to it. Its address carries a random path,
// so another local process cannot borrow that authorization.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Git } from '../../../src/state/index.ts';

const LFS_JSON = 'application/vnd.git-lfs+json';
const MAX_BODY = 1024 * 1024;
/** How long one batch request may wait for the server, well under the engine's own limit. */
const UPSTREAM_TIMEOUT_MS = 60_000;

export interface LfsFaultProxy {
  /** The LFS endpoint, for the engine's `lfs.url`. */
  readonly url: string;
  /** Batch requests received, by operation, and the object ids answered with 404. */
  readonly requests: Array<{ operation: string; refused: string[] }>;
  /** Stops refusing objects: an engine already started with the proxy goes on reaching the server through it. */
  clear(): void;
  close(): Promise<void>;
}

interface BatchObject {
  oid: string;
  size: number;
}

class BadRequest extends Error {}

function parseBatch(body: Buffer): { operation: string; objects: BatchObject[]; rest: Record<string, unknown> } {
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    throw new BadRequest('Not JSON');
  }
  const { operation, objects, ...rest } = (request ?? {}) as Record<string, unknown>;
  if (typeof operation !== 'string' || !Array.isArray(objects)) throw new BadRequest('Not a batch request');
  if (!objects.every((object) => typeof (object as BatchObject | null)?.oid === 'string')) throw new BadRequest('An object has no id');
  return { operation, objects: objects as BatchObject[], rest };
}

/**
 * Starts the proxy on 127.0.0.1.
 *
 * @param upstream the LFS endpoint the requests go on to (`…/info/lfs`)
 * @param authorization the `Authorization` header value for `upstream`, read for each request
 * @param missing LFS object ids whose download the proxy answers with 404
 */
export async function startLfsFaultProxy(upstream: string, authorization: () => string, missing: ReadonlySet<string>, fetchImpl: typeof fetch = fetch): Promise<LfsFaultProxy> {
  const requests: LfsFaultProxy['requests'] = [];
  const refusing = new Set(missing);
  const prefix = `/${randomUUID()}/lfs`;

  async function batch(body: Buffer): Promise<{ status: number; body: string }> {
    const { operation, objects, rest } = parseBatch(body);
    const refused = operation === 'download' ? objects.filter((object) => refusing.has(object.oid)) : [];
    requests.push({ operation, refused: refused.map((object) => object.oid) });
    const errors = refused.map(({ oid, size }) => ({ oid, size, error: { code: 404, message: 'Object does not exist' } }));
    const asked = objects.filter((object) => !refused.includes(object));
    if (asked.length === 0) return { status: 200, body: JSON.stringify({ transfer: 'basic', objects: errors }) };
    const answer = await fetchImpl(`${upstream.replace(/\/$/, '')}/objects/batch`, {
      method: 'POST',
      headers: { accept: LFS_JSON, 'content-type': LFS_JSON, authorization: authorization() },
      body: JSON.stringify({ ...rest, operation, objects: asked }),
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await answer.text();
    if (!answer.ok || errors.length === 0) return { status: answer.status, body: text };
    const passed = JSON.parse(text) as { objects?: unknown[] };
    return { status: answer.status, body: JSON.stringify({ ...passed, objects: [...(passed.objects ?? []), ...errors] }) };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      length += chunk.length;
      if (length > MAX_BODY) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    if (request.method !== 'POST' || request.url !== `${prefix}/objects/batch`) {
      response.writeHead(404, { 'content-type': LFS_JSON }).end(JSON.stringify({ message: 'Not found' }));
      return;
    }
    let answer: { status: number; body: string };
    try {
      answer = await batch(Buffer.concat(chunks));
    } catch (error) {
      answer = error instanceof BadRequest
        ? { status: 422, body: JSON.stringify({ message: error.message }) }
        : { status: 502, body: JSON.stringify({ message: 'The LFS server could not be reached' }) };
    }
    response.writeHead(answer.status, { 'content-type': LFS_JSON }).end(answer.body);
  }

  const server = createServer((request, response) => {
    // A request cut off by a stopped engine must not stop the harness.
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Never keeps the harness running on its own.
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}${prefix}`,
    requests,
    clear: () => refusing.clear(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' ? resolve() : reject(error)));
      server.closeAllConnections();
    }),
  };
}

/**
 * The LFS endpoint git-lfs uses for a clone's `origin`, from all the places
 * it reads (`lfs.url`, `remote.origin.lfsurl`, `.lfsconfig`, the remote URL).
 * Null for an endpoint that is not HTTP(S), which has no batch API to pass on to.
 */
export async function lfsEndpoint(git: Git): Promise<string | null> {
  const env = await git.text(['lfs', 'env']);
  const endpoint = /^Endpoint=(\S+)/m.exec(env)?.[1] ?? '';
  return /^https?:\/\//.test(endpoint) ? endpoint : null;
}

/** Environment that adds `lfs.url` to git's configuration, after any configuration `env` already gives the same way. */
export function lfsUrlEnv(url: string, env: Readonly<Record<string, string>>): Record<string, string> {
  const given = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  const index = Number.isSafeInteger(given) && given > 0 ? given : 0;
  return { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: 'lfs.url', [`GIT_CONFIG_VALUE_${index}`]: url };
}
