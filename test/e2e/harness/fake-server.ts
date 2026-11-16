// Serves the fake GitHub and Linear over HTTP on the loopback, so an engine
// process (not only the test's own process) reaches them: `/github/...` and
// `/linear/...` go to the fakes' API addresses.

import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { GITHUB_API, LINEAR_API } from '../../../src/setup/test-helpers.ts';

export interface Served {
  url: string;
  /** Answers a request before the fakes do, for a fault; undefined lets the fakes answer. */
  fault?: (body: string) => Response | undefined;
  /** Holds an answer before it is sent, to order two runs' requests; undefined sends it at once. */
  hold?: (method: string, path: string, text: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Serves `answer` (a fake transport such as `fakeFetch(world)`) at a free loopback port. */
export async function serveFakes(answer: typeof fetch): Promise<Served> {
  const served: Served = { url: '', close: async () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const path = request.url ?? '/';
      const target = path.startsWith('/github/') ? `${GITHUB_API}${path.slice('/github'.length)}` : `${LINEAR_API}${path.slice('/linear'.length)}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string' && name !== 'host' && name !== 'content-length') headers.set(name, value);
      const method = request.method ?? 'GET';
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const reply = served.fault?.(body) ?? (await answer(target, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) }));
        let bytes = Buffer.from(await reply.arrayBuffer());
        // API identity links must use the same origin as the client's API
        // target, including when the fakes are reached through this proxy.
        if (bytes.length > 0 && path.startsWith('/github/') && reply.headers.get('content-type')?.includes('application/json')) {
          bytes = Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')), (_key, value: unknown) =>
            typeof value === 'string' && value.startsWith(`${GITHUB_API}/`)
              ? `${served.url}/github${value.slice(GITHUB_API.length)}` : value));
        }
        await served.hold?.(method, path, bytes.toString('utf8'));
        response.writeHead(reply.status, { ...Object.fromEntries(reply.headers), 'content-type': reply.headers.get('content-type') ?? 'application/json', 'content-length': String(bytes.length) });
        response.end(bytes);
      } catch (error) {
        console.error(JSON.stringify(error instanceof Error ? error.stack ?? error.message : String(error)));
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('Request failed');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  served.url = `http://127.0.0.1:${port}`;
  served.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return served;
}
