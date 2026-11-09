import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { cleanupKilledTokens } from './token-cleanup.ts';

it('revokes multiple killed-run tokens through a proxy in the parent process', async () => {
  const revoked: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    revoked.push(new URLSearchParams(body).get('token')!);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"success":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const output = await cleanupKilledTokens(['orphan-one', 'orphan-two'], {
      cwd: process.cwd(), env: process.env, linearUrl: `http://127.0.0.1:${address.port}`,
    });
    assert.deepEqual(revoked, ['orphan-one', 'orphan-two']);
    assert.match(output, /post: revoked/);
    assert.ok(!output.includes('orphan-one') && !output.includes('orphan-two'));
    assert.ok(!output.includes('::add-mask::'));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
