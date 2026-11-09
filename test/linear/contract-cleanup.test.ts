// Runs the Linear contract tests against the fake world, served over local
// HTTP, to check their cleanup: the run's documents end archived and never
// in the trash, also when the trash/restore assertion fails before its
// restore step, as it did once when a read right after a trash came back
// without `trashed`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { LINEAR_API, fakeFetch, fakeWorld, type FakeWorld } from '../../src/setup/test-helpers.ts';

const BUDGET = {
  'x-ratelimit-requests-limit': '5000',
  'x-ratelimit-requests-remaining': '4900',
  'x-ratelimit-requests-reset': '1794177648843',
  'x-ratelimit-complexity-limit': '2000000',
  'x-ratelimit-complexity-remaining': '1990000',
  'x-ratelimit-complexity-reset': '1794177648843',
  'x-complexity': '3',
};

interface Served {
  url: string;
  /** GraphQL operations in the order they arrived. */
  operations: string[];
  server: Server;
}

/**
 * Serves the fake world's Linear API on a local port. The contract's own
 * queries that the world does not know (Teams, RateLimitStatus, TeamFilter)
 * are answered here. After a TrashDocument, the next `staleReads`
 * GetDocuments answers show the document as before the trash.
 */
async function serve(world: FakeWorld, staleReads: number): Promise<Served> {
  const forward = fakeFetch(world);
  const operations: string[] = [];
  let stale = 0;
  let trashedId: string | undefined;
  let requestNumber = 0;
  const served: Served = { url: '', operations, server: createServer() };
  served.server.on('request', async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const path = req.url ?? '/';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let status: number;
    let text: string;
    if (path === '/graphql') {
      const { operationName, variables } = JSON.parse(raw.toString('utf8')) as { operationName: string; variables: Record<string, unknown> };
      operations.push(operationName);
      Object.assign(headers, BUDGET, { 'x-request-id': `fake-${(requestNumber += 1)}` });
      const local = contractQuery(world, operationName, variables);
      if (local !== undefined) {
        [status, text] = [200, JSON.stringify({ data: local })];
      } else {
        const response = await forward(`${LINEAR_API}${path}`, { method: req.method ?? 'POST', body: raw.toString('utf8') });
        [status, text] = [response.status, await response.text()];
        if (operationName === 'TrashDocument') [trashedId, stale] = [variables.id as string, staleReads];
        if (operationName === 'GetDocuments' && stale > 0) {
          stale -= 1;
          const body = JSON.parse(text) as { data: { documents: { nodes: Array<Record<string, unknown>> } } };
          for (const node of body.data.documents.nodes) {
            if (node.id === trashedId) Object.assign(node, { trashed: null, archivedAt: null });
          }
          text = JSON.stringify(body);
        }
      }
    } else {
      const response = await forward(`${LINEAR_API}${path}`, { method: req.method ?? 'GET', body: req.method === 'PUT' ? new Uint8Array(raw) : raw.toString('utf8') });
      [status, text] = [response.status, await response.text()];
    }
    // Upload targets point at the world's API host; send them back here.
    res.writeHead(status, headers);
    res.end(text.replaceAll(LINEAR_API, served.url));
  });
  await new Promise<void>((resolve) => served.server.listen(0, '127.0.0.1', resolve));
  served.url = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  return served;
}

function contractQuery(world: FakeWorld, operation: string, variables: Record<string, unknown>): unknown {
  if (operation === 'Teams') return { teams: { nodes: world.linear.teams.map(({ id, key }) => ({ id, key })) } };
  if (operation === 'RateLimitStatus') {
    return { rateLimitStatus: { identifier: 'app', kind: 'app', limits: [{ type: 'requests', allowedAmount: 5000, remainingAmount: 4900, requestedAmount: 1, period: 3600000, reset: 1794177648843 }] } };
  }
  if (operation === 'TeamFilter') {
    const ids = variables.ids as string[];
    const nodes = world.linear.documents.filter((d) => ids.includes(d.id) && d.projectId === undefined && d.teamId === variables.teamId);
    return { documents: { nodes: nodes.map(({ id }) => ({ id })) } };
  }
  return undefined;
}

interface Run {
  code: number | null;
  output: string;
  report: {
    cleanupFailed: boolean;
    cleanupErrors: Array<{ operation: string; documentId?: string; error: string }>;
    restoredInCleanup: string[];
    finalDocuments: Array<{ id: string; trashed: boolean; archived: boolean }>;
    trashRead?: {
      trashRequestId: string;
      immediate: { trashed: boolean; archived: boolean; requestId: string };
      delayed: { trashed: boolean; archived: boolean; requestId: string; afterMs: number };
    };
  };
  operations: string[];
}

async function runContract(world: FakeWorld, staleReads: number): Promise<Run> {
  const served = await serve(world, staleReads);
  const directory = await mkdtemp(join(tmpdir(), 'contract-cleanup-'));
  const reportPath = join(directory, 'report.json');
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./contract.test.ts', import.meta.url))], {
      env: {
        ...env,
        LINEAR_TEST_APP_CLIENT_ID: 'test-client',
        LINEAR_TEST_APP_CLIENT_SECRET: 'test-secret',
        LINEAR_TEST_TEAM_KEY: 'ENG',
        LINEAR_BASE_URL: served.url,
        LINEAR_CONTRACT_REPORT: reportPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Run['report'];
    return { code, output, report, operations: served.operations };
  } finally {
    served.server.closeAllConnections();
    await new Promise<void>((resolve) => served.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

/** The run's documents in the world: every one archived, none trashed, their projects deleted. */
function assertArchivedNotTrashed(world: FakeWorld): void {
  assert.equal(world.linear.documents.length, 2);
  for (const document of world.linear.documents) {
    assert.ok(document.archivedAt !== undefined, `${document.id} is archived`);
    assert.notEqual(document.trashed, true, `${document.id} is not trashed`);
  }
  assert.equal(world.linear.deletedProjects?.length, 2);
  assert.deepEqual(world.linear.projects.map((p) => p.id), ['project-api', 'project-handbook']);
}

describe('Linear contract cleanup against the fake world', { timeout: 60_000 }, () => {
  it('passes, and leaves its documents archived', async () => {
    const world = fakeWorld();
    const run = await runContract(world, 0);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.report.cleanupFailed, false);
    assert.deepEqual(run.report.restoredInCleanup, []);
    assert.equal(run.report.trashRead, undefined);
    assert.deepEqual(run.report.finalDocuments.map((d) => [d.trashed, d.archived]), [[false, true], [false, true]]);
    assertArchivedNotTrashed(world);
  });

  it('restores the trashed document before deleting its project when the trash assertion fails', async () => {
    const world = fakeWorld();
    // The read right after the trash, the diagnostic read and cleanup's own read are all stale.
    const run = await runContract(world, 3);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /not ok \d+ - trashes and restores a document/);
    assert.match(run.output, /Expected values to be strictly equal:[\s\S]*false !== true/);
    assert.match(run.output, /ok \d+ - reports a missing document as not found/, 'the later tests still ran');
    assert.equal(run.report.cleanupFailed, false, run.output);
    const second = world.linear.documents.find((d) => d.title === 'Reading list')!;
    assert.deepEqual(run.report.restoredInCleanup, [second.id]);
    const restore = run.operations.lastIndexOf('RestoreDocument');
    assert.ok(restore > 0 && restore < run.operations.indexOf('DeleteProject'), run.operations.join(' '));
    assert.equal(run.operations.at(-1), 'GetDocuments', 'the final read follows the project deletions');
    assert.deepEqual(run.report.finalDocuments.map((d) => [d.trashed, d.archived]), [[false, true], [false, true]]);
    assertArchivedNotTrashed(world);
    // The safe diagnosis: request ids and states only.
    const diagnosis = run.report.trashRead!;
    assert.match(diagnosis.trashRequestId, /^fake-\d+$/);
    assert.deepEqual([diagnosis.immediate.trashed, diagnosis.immediate.archived], [false, false]);
    assert.deepEqual([diagnosis.delayed.trashed, diagnosis.delayed.archived, diagnosis.delayed.afterMs], [false, false, 2000]);
    assert.notEqual(diagnosis.delayed.requestId, diagnosis.immediate.requestId);
    assert.ok(!JSON.stringify(run.report).includes('A short list of articles'), 'no document content in the report');
  });

  it('reports the document that stays trashed when its restore is refused', async () => {
    const world = fakeWorld();
    world.linear.writes.reject = (operation) => operation === 'RestoreDocument';
    const run = await runContract(world, 1);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /not ok \d+ - trashes and restores a document/);
    assert.match(run.output, /Contract cleanup failed/);
    const second = world.linear.documents.find((d) => d.title === 'Reading list')!;
    assert.deepEqual(run.report.cleanupErrors, [
      { operation: 'RestoreDocument', documentId: second.id, error: 'LinearGraphQLError' },
      { operation: 'verify archived', documentId: second.id, error: 'Error' },
    ]);
    assert.equal(run.report.finalDocuments.find((d) => d.id === second.id)?.trashed, true);
  });
});
