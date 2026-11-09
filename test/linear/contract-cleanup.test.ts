// Runs the Linear contract tests against the fake world, served over local
// HTTP, to check their cleanup: the run's documents end archived and never
// in the trash, also when the trash/restore assertion fails before its
// restore step, as it did once when a read right after a trash came back
// without `trashed`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CleanupResult, CreatedReadDiagnosis, TrashReadDiagnosis } from './contract-support.ts';

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

/** The contract run's pause before the one delayed trash read or a verifying cleanup read. */
const PAUSE_MS = 50;

interface Faults {
  /**
   * After the second CreateDocument, this many GetDocuments answers leave out
   * the created documents (`second`: only the later one; `error`: answer 503
   * instead).
   */
  hiddenCreateReads?: { reads: number; hide: 'both' | 'second' | 'error' };
  /** After a TrashDocument, this many GetDocuments answers show the document as before the trash. */
  staleTrashReads?: number;
  /** TrashDocument is applied, but answered with a 503. */
  loseTrashAnswer?: boolean;
  /** Replace reads after trash with an absent document or an HTTP error. */
  trashReadFault?: 'absent-once' | 'absent-always' | 'delayed-error';
  /** After the last DeleteProject, this many GetDocuments answers show no `archivedAt`. */
  staleArchiveReads?: number;
  /** Every post-deletion read remains invalid or fails. */
  archiveReadFault?: 'trashed' | 'absent' | 'error';
}

interface Served {
  url: string;
  /** GraphQL operations in the order they arrived. */
  operations: string[];
  server: Server;
}

type Reply = { status: number; headers: Record<string, string>; text: string };

/**
 * Serves the fake world's Linear API on a local port, with `faults`. The
 * contract's own queries that the world does not know (Teams,
 * RateLimitStatus, TeamFilter) are answered here.
 */
async function serve(world: FakeWorld, faults: Faults): Promise<Served> {
  const forward = fakeFetch(world);
  const operations: string[] = [];
  let staleTrash = 0;
  let staleArchive = 0;
  let deletes = 0;
  let trashedId: string | undefined;
  let requestNumber = 0;
  let trashReads = 0;
  const created: string[] = [];
  let hiddenReads = 0;
  const served: Served = { url: '', operations, server: createServer() };

  async function answer(req: IncomingMessage, raw: Buffer): Promise<Reply> {
    const path = req.url ?? '/';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (path !== '/graphql') {
      const response = await forward(`${LINEAR_API}${path}`, { method: req.method ?? 'GET', body: req.method === 'PUT' ? new Uint8Array(raw) : raw.toString('utf8') });
      return { status: response.status, headers, text: await response.text() };
    }
    const { operationName, variables } = JSON.parse(raw.toString('utf8')) as { operationName: string; variables: Record<string, unknown> };
    operations.push(operationName);
    Object.assign(headers, BUDGET, { 'x-request-id': `fake-${(requestNumber += 1)}` });
    const local = contractQuery(world, operationName, variables);
    if (local !== undefined) return { status: 200, headers, text: JSON.stringify({ data: local }) };
    const response = await forward(`${LINEAR_API}${path}`, { method: 'POST', body: raw.toString('utf8') });
    let text = await response.text();
    if (operationName === 'CreateDocument' && response.ok && faults.hiddenCreateReads) {
      const id = (JSON.parse(text) as { data?: { documentCreate?: { document?: { id: string } } } }).data?.documentCreate?.document?.id;
      if (id && created.push(id) === 2) hiddenReads = faults.hiddenCreateReads.reads;
    }
    if (operationName === 'GetDocuments' && hiddenReads > 0 && response.ok) {
      hiddenReads -= 1;
      if (faults.hiddenCreateReads!.hide === 'error') return { status: 503, headers, text: '{}' };
      const hidden = faults.hiddenCreateReads!.hide === 'both' ? created : created.slice(1);
      const body = JSON.parse(text) as { data: { documents: { nodes: Array<{ id: string }> } } };
      body.data.documents.nodes = body.data.documents.nodes.filter((node) => !hidden.includes(node.id));
      return { status: response.status, headers, text: JSON.stringify(body) };
    }
    if (operationName === 'TrashDocument') {
      [trashedId, staleTrash] = [variables.id as string, faults.staleTrashReads ?? 0];
      if (faults.loseTrashAnswer) return { status: 503, headers, text: '{}' };
    }
    if (operationName === 'RestoreDocument' && response.ok && JSON.parse(text).data?.documentUnarchive?.success === true) {
      trashedId = undefined;
      staleTrash = 0;
    }
    if (operationName === 'GetDocuments' && trashedId !== undefined && (variables.ids as string[]).includes(trashedId)) {
      trashReads += 1;
      if (faults.trashReadFault === 'absent-always' || (faults.trashReadFault === 'absent-once' && trashReads === 1)) {
        const body = JSON.parse(text) as { data: { documents: { nodes: Array<{ id: string }> } } };
        body.data.documents.nodes = body.data.documents.nodes.filter((node) => node.id !== trashedId);
        return { status: 200, headers, text: JSON.stringify(body) };
      }
      if (faults.trashReadFault === 'delayed-error' && trashReads === 2) return { status: 503, headers, text: '{}' };
    }
    if (operationName === 'DeleteProject' && (deletes += 1) === 2) staleArchive = faults.staleArchiveReads ?? 0;
    if (operationName === 'GetDocuments' && deletes === 2 && faults.archiveReadFault) {
      if (faults.archiveReadFault === 'error') return { status: 503, headers, text: '{}' };
      const body = JSON.parse(text) as { data: { documents: { nodes: Array<Record<string, unknown>> } } };
      if (faults.archiveReadFault === 'absent') body.data.documents.nodes = [];
      else for (const node of body.data.documents.nodes) node.trashed = true;
      text = JSON.stringify(body);
    }
    if (operationName === 'GetDocuments' && (staleTrash > 0 || staleArchive > 0)) {
      const body = JSON.parse(text) as { data: { documents: { nodes: Array<Record<string, unknown>> } } };
      for (const node of body.data.documents.nodes) {
        if (staleTrash > 0 && node.id === trashedId) Object.assign(node, { trashed: null, archivedAt: null });
        if (staleArchive > 0) node.archivedAt = null;
      }
      if (staleTrash > 0) staleTrash -= 1;
      else staleArchive -= 1;
      text = JSON.stringify(body);
    }
    return { status: response.status, headers, text };
  }

  served.server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const reply = await answer(req, Buffer.concat(chunks));
      // Upload targets point at the world's API host; send them back here.
      res.writeHead(reply.status, reply.headers);
      res.end(reply.text.replaceAll(LINEAR_API, served.url));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: `fake server: ${String(error)}` }] }));
    }
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
    archivalVerification: CleanupResult['archivalVerification'];
    requests: Array<{ operation: string; requestId?: string }>;
    cleanupErrors: Array<{ operation: string; documentId?: string; error: string }>;
    restoredInCleanup: string[];
    unconfirmedRestoreFailures: Array<{ operation: string; documentId?: string; error: string }>;
    finalDocuments: Array<{ id: string; trashed: boolean; archived: boolean }>;
    trashRead?: TrashReadDiagnosis;
    createdRead?: CreatedReadDiagnosis;
  };
  operations: string[];
}

async function runContract(world: FakeWorld, faults: Faults = {}, pauseSetting = String(PAUSE_MS)): Promise<Run> {
  const served = await serve(world, faults);
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
        LINEAR_CONTRACT_PAUSE_MS: pauseSetting,
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
    const text = await readFile(reportPath, 'utf8').catch((error: unknown) => {
      throw new Error(`the contract run (exit ${code}) wrote no report: ${String(error)}\n${output}`);
    });
    return { code, output, report: JSON.parse(text) as Run['report'], operations: served.operations };
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

/** The created documents were read this many times, each in one request, and no create was repeated. */
function assertCreateReads(run: Run, reads: number): void {
  const afterCreates = run.operations.lastIndexOf('CreateDocument') + 1;
  const teamFilter = run.operations.indexOf('TeamFilter');
  assert.ok(teamFilter > afterCreates, 'the next test ran after the reads');
  assert.deepEqual(run.operations.slice(afterCreates, teamFilter), Array(reads).fill('GetDocuments'));
  assert.equal(run.operations.filter((op) => op === 'CreateDocument').length, 2);
  assert.equal(run.report.createdRead!.reads.length, reads);
}

const readingList = (world: FakeWorld) => world.linear.documents.find((d) => d.title === 'Reading list')!;
const TRASH_TEST_FAILED = /^\s*not ok \d+ - trashes and restores a document$/m;
const LATER_TEST_PASSED = /^\s*ok \d+ - reports a missing document as not found$/m;

describe('Linear contract cleanup against the fake world', { timeout: 120_000 }, () => {
  it('passes, and leaves its documents archived', async () => {
    const world = fakeWorld();
    const run = await runContract(world);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.report.cleanupFailed, false);
    assert.deepEqual(run.report.restoredInCleanup, []);
    assert.equal(run.report.trashRead, undefined);
    assert.deepEqual(run.report.createdRead!.reads.map((r) => r.missing), [[]], 'the immediate read shows both created documents');
    assert.deepEqual(run.report.finalDocuments.map((d) => [d.trashed, d.archived]), [[false, true], [false, true]]);
    assertArchivedNotTrashed(world);
  });

  it('reads created documents on a delayed read after an immediate empty read', async () => {
    const world = fakeWorld();
    const run = await runContract(world, { hiddenCreateReads: { reads: 1, hide: 'both' } });
    assert.equal(run.code, 0, run.output);
    assert.equal(run.report.cleanupFailed, false);
    const ids = world.linear.documents.map((d) => d.id);
    const diagnosis = run.report.createdRead!;
    assert.deepEqual([diagnosis.pauseMs, diagnosis.maxReads], [PAUSE_MS, 3]);
    assert.equal(diagnosis.createRequestIds.length, 2);
    assert.ok(diagnosis.createRequestIds.every((id) => /^fake-\d+$/.test(id ?? '')));
    assert.deepEqual(diagnosis.reads.map((r) => [r.returned.length, [...r.missing].sort()]), [[0, [...ids].sort()], [2, []]]);
    assert.deepEqual(diagnosis.reads.map((r) => r.requestIds.length), [1, 1], 'each read is one request');
    assert.notEqual(diagnosis.reads[0]!.requestIds[0], diagnosis.reads[1]!.requestIds[0]);
    assert.ok(diagnosis.reads.every((r) => Number.isFinite(r.sinceCreateMs) && r.sinceCreateMs! >= 0));
    assert.ok(diagnosis.reads[1]!.sinceCreateMs! > diagnosis.reads[0]!.sinceCreateMs!);
    assertCreateReads(run, 2);
    assert.ok(!JSON.stringify(diagnosis).includes('A short list of articles'), 'no document content in the diagnosis');
    assertArchivedNotTrashed(world);
  });

  it('reads the missing created document on a later read after partial reads', async () => {
    const world = fakeWorld();
    const run = await runContract(world, { hiddenCreateReads: { reads: 2, hide: 'second' } });
    assert.equal(run.code, 0, run.output);
    const diagnosis = run.report.createdRead!;
    const second = readingList(world).id;
    assert.deepEqual(diagnosis.reads.map((r) => r.missing), [[second], [second], []]);
    assertCreateReads(run, 3);
    assertArchivedNotTrashed(world);
  });

  it('fails with every read retained when created documents stay absent after the bound', async () => {
    const world = fakeWorld();
    const run = await runContract(world, { hiddenCreateReads: { reads: 3, hide: 'both' } });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /^\s*not ok \d+ - reads documents by ids in one request, with the content the create returned$/m);
    assert.match(run.output, /created documents must be read within 3 reads and 50ms pauses/);
    assert.match(run.output, LATER_TEST_PASSED, 'the later tests still ran');
    const diagnosis = run.report.createdRead!;
    assert.equal(diagnosis.reads.length, 3);
    assert.ok(diagnosis.reads.every((r) => r.returned.length === 0 && r.missing.length === 2 && r.error === undefined));
    assert.equal(new Set(diagnosis.reads.flatMap((r) => r.requestIds)).size, 3);
    assertCreateReads(run, 3);
    assert.equal(run.report.cleanupFailed, false, run.output);
    assertArchivedNotTrashed(world);
  });

  it('fails on a failed read of created documents with its own error, without more reads', async () => {
    const world = fakeWorld();
    const run = await runContract(world, { hiddenCreateReads: { reads: 1, hide: 'error' } });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /^\s*not ok \d+ - reads documents by ids in one request, with the content the create returned$/m);
    assert.match(run.output, /LinearHttpError/);
    assert.doesNotMatch(run.output, /created documents must be read within/);
    const diagnosis = run.report.createdRead!;
    assert.deepEqual(diagnosis.reads.map((r) => [r.error, r.returned, r.requestIds.length]), [['LinearHttpError', [], 1]]);
    assertCreateReads(run, 1);
    assert.equal(run.report.cleanupFailed, false, run.output);
    assertArchivedNotTrashed(world);
  });

  it('completes cleanup, revocation and reporting with a malformed pause setting', async () => {
    const world = fakeWorld();
    const run = await runContract(world, {}, 'invalid');
    assert.equal(run.code, 0, run.output);
    assert.equal(run.report.cleanupFailed, false);
    assert.equal(run.report.archivalVerification.pauseMs, 2_000);
    assert.equal(run.report.createdRead!.pauseMs, 2_000);
    assert.equal(run.report.requests.at(-1)?.operation, 'oauth.revoke');
    assertArchivedNotTrashed(world);
  });

  for (const fault of ['stale', 'absent-once'] as const) {
    it(`confirms trash on the delayed read after an immediate ${fault} response`, async () => {
      const world = fakeWorld();
      const run = await runContract(world, fault === 'stale' ? { staleTrashReads: 1 } : { trashReadFault: fault });
      assert.equal(run.code, 0, run.output);
      assert.equal(run.report.cleanupFailed, false);
      const diagnosis = run.report.trashRead!;
      assert.ok('trashed' in diagnosis.delayed);
      assert.equal(diagnosis.delayed.trashed, true);
      assert.equal(diagnosis.delayed.afterMs, PAUSE_MS);
      assert.ok(Number.isFinite(diagnosis.delayed.elapsedMs) && diagnosis.delayed.elapsedMs >= 0);
      const trash = run.operations.indexOf('TrashDocument');
      assert.deepEqual(run.operations.slice(trash, trash + 4), ['TrashDocument', 'GetDocuments', 'GetDocuments', 'RestoreDocument']);
      assert.equal(run.operations.filter((op) => op === 'TrashDocument').length, 1);
      assertArchivedNotTrashed(world);
    });
  }

  for (const fault of ['absent-always', 'delayed-error'] as const) {
    it(`fails with diagnostics and restores before deleting after ${fault}`, async () => {
      const world = fakeWorld();
      const run = await runContract(world, { trashReadFault: fault, ...(fault === 'delayed-error' ? { staleTrashReads: 1 } : {}) });
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, TRASH_TEST_FAILED);
      assert.match(run.output, /trash must be confirmed within two reads/);
      const diagnosis = run.report.trashRead!;
      if (fault === 'absent-always') {
        assert.ok('absent' in diagnosis.immediate && diagnosis.immediate.absent);
        assert.ok('absent' in diagnosis.delayed && diagnosis.delayed.absent);
      } else {
        assert.ok('error' in diagnosis.delayed);
        assert.equal(diagnosis.delayed.error, 'LinearHttpError');
      }
      assert.equal(run.report.cleanupFailed, false, run.output);
      const trash = run.operations.indexOf('TrashDocument');
      const restore = run.operations.indexOf('RestoreDocument');
      // Two contract reads, then cleanup's own read before its restore.
      assert.deepEqual(run.operations.slice(trash, restore).filter((op) => op !== 'UpdateDocument'), ['TrashDocument', 'GetDocuments', 'GetDocuments', 'GetDocuments']);
      assert.ok(restore < run.operations.indexOf('DeleteProject'));
      assert.equal(run.operations.filter((op) => op === 'TrashDocument').length, 1);
      assertArchivedNotTrashed(world);
    });
  }

  it('restores before project deletion after a failed trash assertion even with delayed archival', async () => {
    const world = fakeWorld();
    // The trash read, diagnostic read and cleanup read are stale. Archival
    // also stays stale until the final allowed sample after the restore.
    const run = await runContract(world, { staleTrashReads: 3, staleArchiveReads: 15 });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, TRASH_TEST_FAILED);
    assert.match(run.output, /trash must be confirmed within two reads and one 50ms pause/);
    assert.match(run.output, LATER_TEST_PASSED, 'the later tests still ran');
    assert.equal(run.report.cleanupFailed, false, run.output);
    assert.deepEqual(run.report.restoredInCleanup, [readingList(world).id]);
    assert.equal(run.report.archivalVerification.samples.length, 16);
    const restore = run.operations.lastIndexOf('RestoreDocument');
    assert.ok(restore > 0 && restore < run.operations.indexOf('DeleteProject'), run.operations.join(' '));
    assert.equal(run.operations.at(-1), 'GetDocuments', 'the final read follows the project deletions');
    assert.deepEqual(run.report.finalDocuments.map((d) => [d.trashed, d.archived]), [[false, true], [false, true]]);
    assertArchivedNotTrashed(world);
    // The safe diagnosis: request ids and states only.
    const diagnosis = run.report.trashRead!;
    assert.match(diagnosis.trashRequestId!, /^fake-\d+$/);
    assert.ok('trashed' in diagnosis.immediate);
    assert.ok('trashed' in diagnosis.delayed);
    assert.deepEqual([diagnosis.immediate.trashed, diagnosis.immediate.archived], [false, false]);
    assert.deepEqual([diagnosis.delayed.trashed, diagnosis.delayed.archived, diagnosis.delayed.afterMs], [false, false, PAUSE_MS]);
    assert.notEqual(diagnosis.delayed.requestId, diagnosis.immediate.requestId);
    assert.ok(!JSON.stringify(run.report).includes('A short list of articles'), 'no document content in the report');
  });

  it('restores a document whose trash applied though its answer was lost, against a stale read', async () => {
    const world = fakeWorld();
    const run = await runContract(world, { loseTrashAnswer: true, staleTrashReads: 1 });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, TRASH_TEST_FAILED);
    assert.equal(run.report.cleanupFailed, false, run.output);
    assert.deepEqual(run.report.restoredInCleanup, [readingList(world).id]);
    assert.equal(run.report.trashRead, undefined, 'a lost mutation response cannot become success through a read');
    assert.equal(run.operations.filter((op) => op === 'TrashDocument').length, 1);
    assert.ok(run.operations.indexOf('RestoreDocument') < run.operations.indexOf('DeleteProject'));
    assertArchivedNotTrashed(world);
  });

  for (const staleArchiveReads of [1, 15]) {
    it(`confirms archival after ${staleArchiveReads} stale reads without repeating deletion`, async () => {
      const world = fakeWorld();
      const run = await runContract(world, { staleArchiveReads });
      assert.equal(run.code, 0, run.output);
      assert.equal(run.report.cleanupFailed, false);
      const verification = run.report.archivalVerification;
      assert.equal(verification.maxReads, 16);
      assert.equal(verification.pauseMs, PAUSE_MS);
      assert.equal(verification.samples.length, staleArchiveReads + 1);
      for (const sample of verification.samples.slice(0, -1)) {
        assert.deepEqual(sample.documents.map((d) => [d.trashed, d.archived]), [[false, false], [false, false]]);
      }
      assert.deepEqual(verification.samples.at(-1)!.documents.map((d) => [d.trashed, d.archived]), [[false, true], [false, true]]);
      assert.equal(run.operations.filter((op) => op === 'DeleteProject').length, 2);
      assertArchivedNotTrashed(world);
    });
  }

  for (const fault of ['active', 'trashed', 'absent', 'error'] as const) {
    it(`fails at the archival bound and retains every ${fault} sample and request id`, async () => {
      const world = fakeWorld();
      const run = await runContract(world, fault === 'active' ? { staleArchiveReads: 16 } : { archiveReadFault: fault });
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /Contract cleanup failed/);
      assert.equal(run.report.cleanupFailed, true);
      assert.ok(run.report.cleanupErrors.every((entry) => entry.operation === 'verify archived'));
      const verification = run.report.archivalVerification;
      assert.equal(verification.samples.length, 16);
      const deletion = run.operations.lastIndexOf('DeleteProject');
      assert.equal(run.operations.filter((op) => op === 'DeleteProject').length, 2);
      assert.ok(run.operations.slice(deletion + 1).every((op) => op === 'GetDocuments'));
      const requestIds = run.report.requests.slice(run.report.requests.findLastIndex((entry) => entry.operation === 'DeleteProject') + 1)
        .filter((entry) => entry.operation === 'GetDocuments').map((entry) => entry.requestId);
      assert.deepEqual(verification.samples.flatMap((sample) => sample.requestIds), requestIds);
      assert.equal(new Set(requestIds).size, 16);
      for (const [index, sample] of verification.samples.entries()) {
        assert.ok(sample.elapsedMs >= (verification.samples[index - 1]?.elapsedMs ?? 0));
        assert.match(sample.requestIds[0]!, /^fake-\d+$/);
        if (fault === 'error') {
          assert.equal(sample.error, 'LinearHttpError');
          assert.deepEqual(sample.documents, []);
        } else if (fault === 'absent') {
          assert.equal(sample.missingIds.length, 2);
          assert.deepEqual(sample.documents, []);
        } else {
          assert.deepEqual(sample.documents.map((d) => [d.trashed, d.archived]),
            fault === 'active' ? [[false, false], [false, false]] : [[true, true], [true, true]]);
          assert.deepEqual(sample.missingIds, []);
        }
      }
      assert.deepEqual(run.report.finalDocuments, verification.samples.at(-1)!.documents);
      assert.ok(!JSON.stringify(run.report).includes('A short list of articles'));
      assertArchivedNotTrashed(world);
    });
  }

  it('does not fail cleanup on a refused restore of a document its trash never reached', async () => {
    const world = fakeWorld();
    world.linear.writes.reject = (operation) => operation === 'TrashDocument' || operation === 'RestoreDocument';
    const run = await runContract(world);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, TRASH_TEST_FAILED);
    assert.equal(run.report.cleanupFailed, false, run.output);
    assert.deepEqual(run.report.unconfirmedRestoreFailures, [{ operation: 'RestoreDocument', documentId: readingList(world).id, error: 'LinearGraphQLError' }]);
    assertArchivedNotTrashed(world);
  });

  it('reports the document that stays trashed when its restore is refused', async () => {
    const world = fakeWorld();
    world.linear.writes.reject = (operation) => operation === 'RestoreDocument';
    const run = await runContract(world, { staleTrashReads: 1 });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, TRASH_TEST_FAILED);
    assert.match(run.output, /Contract cleanup failed/);
    const second = readingList(world);
    assert.deepEqual(run.report.cleanupErrors, [
      { operation: 'RestoreDocument', documentId: second.id, error: 'LinearGraphQLError' },
      { operation: 'verify archived', documentId: second.id, error: 'Error' },
    ]);
    assert.equal(run.report.finalDocuments.find((d) => d.id === second.id)?.trashed, true);
  });
});
