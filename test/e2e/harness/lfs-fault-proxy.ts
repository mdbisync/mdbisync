// A local proxy in front of the sandbox's Git LFS server, for the engine's
// clone only. It passes every batch request on and answers 404 for the
// download of chosen objects, so the engine sees an LFS object the server
// does not have, while the object itself is uploaded and the push that names
// it is accepted (GitHub refuses a push whose pointer names an object it never
// received). Only the batch API passes through it: the transfers go straight
// to the addresses the server answers with. It never logs or keeps request or
// response bodies, and it adds the sandbox's authorization itself, so the
// engine's credential is never sent to it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Git } from '../../../src/state/index.ts';

const LFS_JSON = 'application/vnd.git-lfs+json';
const BATCH_PATH = '/lfs/objects/batch';
const MAX_BODY = 1024 * 1024;

export interface LfsFaultProxy {
  /** The LFS endpoint, for the engine's `lfs.url`. */
  readonly url: string;
  /** Batch requests received, by operation, and the object ids answered with 404. */
  readonly requests: Array<{ operation: string; refused: string[] }>;
  close(): Promise<void>;
}

interface BatchObject {
  oid: string;
  size: number;
}

/**
 * Starts the proxy on 127.0.0.1.
 *
 * @param upstream the LFS endpoint the requests go on to (`…/info/lfs`)
 * @param authorization the `Authorization` header value for `upstream`
 * @param missing LFS object ids whose download the proxy answers with 404
 */
export async function startLfsFaultProxy(upstream: string, authorization: string, missing: ReadonlySet<string>, fetchImpl: typeof fetch = fetch): Promise<LfsFaultProxy> {
  const requests: LfsFaultProxy['requests'] = [];

  async function batch(body: Buffer): Promise<{ status: number; body: string }> {
    const request = JSON.parse(body.toString('utf8')) as { operation?: unknown; objects?: unknown };
    if (typeof request.operation !== 'string' || !Array.isArray(request.objects)) return { status: 422, body: JSON.stringify({ message: 'Not a batch request' }) };
    const objects = request.objects as BatchObject[];
    const refused = request.operation === 'download' ? objects.filter((object) => missing.has(object.oid)) : [];
    requests.push({ operation: request.operation, refused: refused.map((object) => object.oid) });
    const errors = refused.map(({ oid, size }) => ({ oid, size, error: { code: 404, message: 'Object does not exist' } }));
    const asked = objects.filter((object) => !refused.includes(object));
    if (asked.length === 0) return { status: 200, body: JSON.stringify({ transfer: 'basic', objects: errors }) };
    const answer = await fetchImpl(`${upstream.replace(/\/$/, '')}/objects/batch`, {
      method: 'POST',
      headers: { accept: LFS_JSON, 'content-type': LFS_JSON, authorization },
      body: JSON.stringify({ ...request, objects: asked }),
      redirect: 'error',
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
    if (request.method !== 'POST' || request.url !== BATCH_PATH) {
      response.writeHead(404, { 'content-type': LFS_JSON }).end(JSON.stringify({ message: 'Not found' }));
      return;
    }
    let answer: { status: number; body: string };
    try {
      answer = await batch(Buffer.concat(chunks));
    } catch {
      answer = { status: 502, body: JSON.stringify({ message: 'The LFS server could not be reached' }) };
    }
    response.writeHead(answer.status, { 'content-type': LFS_JSON }).end(answer.body);
  }

  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Never keeps the harness running on its own.
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/lfs`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' ? resolve() : reject(error)))),
  };
}

/**
 * The LFS endpoint a clone uses for `origin`: its `lfs.url`, else the one
 * git-lfs derives from an HTTPS remote URL. Null for a remote that is not
 * HTTP(S), which has no batch API to pass on to.
 */
export async function lfsEndpoint(git: Git): Promise<string | null> {
  const configured = (await git.run(['config', '--get', 'lfs.url'], { okCodes: [0, 1] })).stdout.toString('utf8').trim();
  if (configured !== '') return /^https?:\/\//.test(configured) ? configured : null;
  const remote = (await git.text(['remote', 'get-url', 'origin'])).trim();
  if (!/^https?:\/\//.test(remote)) return null;
  return `${remote.replace(/\/$/, '').replace(/(\.git)?$/, '.git')}/info/lfs`;
}

/** Environment that adds `lfs.url` to git's configuration, after any configuration `env` already gives the same way. */
export function lfsUrlEnv(url: string, env: Readonly<Record<string, string>>): Record<string, string> {
  const given = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  const index = Number.isSafeInteger(given) && given > 0 ? given : 0;
  return { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: 'lfs.url', [`GIT_CONFIG_VALUE_${index}`]: url };
}
