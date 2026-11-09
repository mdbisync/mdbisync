// Contract tests against a real Linear workspace. They run only when
// LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET are set; the
// app needs client credentials tokens with read and write scopes.
// Optional: LINEAR_TEST_TEAM_KEY (default: the first team),
// LINEAR_BASE_URL (a proxy in front of Linear), LINEAR_CONTRACT_REPORT (a
// path for the JSON report of requests per operation),
// LINEAR_CONTRACT_PAUSE_MS (the pause before a delayed read, default 2000).
// Just-created documents must be read within three reads and two pauses,
// trash confirmed by at most two reads with one pause; a stale or absent
// final read fails.
//
// Everything written is neutral work text in two short-lived projects, which
// are removed at the end; their documents end archived, never in the
// trash. About 30 API requests per run.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import {
  DocumentTooLongError,
  LinearClient,
  LinearGraphQLError,
  LinearTokenError,
  RequestStats,
  mintAppToken,
  revokeToken,
  type LinearDocument,
  type LogEntry,
  type RunToken,
} from '../../src/linear/index.ts';
import {
  cleanUpOwned,
  diagnoseTrashRead,
  readCreated,
  type CleanupError,
  type CleanupResult,
  type CreatedReadDiagnosis,
  type TrashReadDiagnosis,
} from './contract-support.ts';

const clientId = process.env.LINEAR_TEST_APP_CLIENT_ID;
const clientSecret = process.env.LINEAR_TEST_APP_CLIENT_SECRET;
const baseUrl = process.env.LINEAR_BASE_URL;
const live = Boolean(clientId && clientSecret);
const pauseMs = Number(process.env.LINEAR_CONTRACT_PAUSE_MS ?? 2_000);

// A 1x1 PNG.
const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

describe('Linear client contract', { skip: live ? false : 'LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET are not set' }, () => {
  const suffix = randomBytes(3).toString('hex');
  const stats = new RequestStats();
  const perOperation: Record<string, number> = {};
  // Every OAuth and GraphQL attempt, without credentials, variables or content.
  const requests: LogEntry[] = [];
  const hooks = { log: (entry: LogEntry) => requests.push(entry) };
  let token: RunToken | undefined;
  let linear: LinearClient;
  let teamId: string;
  const projectIds: string[] = [];
  let first: LinearDocument;
  let second: LinearDocument;
  // Documents a trash was sent for (applied or not) and no restore confirmed since.
  const trashed = new Set<string>();
  let trashRead: TrashReadDiagnosis | undefined;
  let createdRead: CreatedReadDiagnosis | undefined;

  /** Runs one step and records how many API requests it took. */
  async function measured<T>(name: string, step: () => Promise<T>): Promise<T> {
    const before = stats.total;
    try {
      return await step();
    } finally {
      perOperation[name] = stats.total - before;
    }
  }

  /** The operations a step sent, ignoring a retry of the same operation after a short Retry-After. */
  async function operationsOf(step: () => Promise<unknown>): Promise<string[]> {
    const before = new Map(stats.byOperation);
    await step();
    return [...stats.byOperation].filter(([name, count]) => count > (before.get(name) ?? 0)).map(([name]) => name).sort();
  }

  before(async () => {
    token = await measured('mint token', () => mintAppToken({ clientId: clientId!, clientSecret: clientSecret! }, { baseUrl, stats, hooks }));
    linear = new LinearClient({
      token: token.accessToken,
      auth: token.context,
      baseUrl,
      stats,
      hooks,
    });
    const teams = await linear.request<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      'Teams',
      'query',
      'query Teams { teams { nodes { id key } } }',
    );
    const wanted = process.env.LINEAR_TEST_TEAM_KEY;
    const team = wanted ? teams.teams.nodes.find((t) => t.key === wanted) : teams.teams.nodes[0];
    assert.ok(team, 'the workspace has the team');
    teamId = team.id;
    for (const name of [`Field notes ${suffix}`, `Archive shelf ${suffix}`]) {
      const created = await linear.request<{ projectCreate: { project: { id: string } } }>(
        'CreateProject',
        'mutation',
        'mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }',
        { input: { name, teamIds: [teamId] } },
      );
      projectIds.push(created.projectCreate.project.id);
    }
  });

  after(async () => {
    const cleanupErrors: CleanupError[] = [];
    let cleanup: CleanupResult | undefined;
    if (linear) {
      const documentIds = [first, second].filter((document) => document !== undefined).map((document) => document.id);
      cleanup = await cleanUpOwned(linear, { projectIds, documentIds, trashed }, { pauseMs });
      cleanupErrors.push(...cleanup.errors);
    }
    if (token) {
      try {
        await measured('revoke token', () => revokeToken(token!.accessToken, { baseUrl, stats, hooks, auth: token!.context }));
      } catch (error) {
        cleanupErrors.push({ operation: 'oauth.revoke', error });
      }
    }
    // Token errors contain only operation/status. GraphQL details are already
    // in requests; avoid copying arbitrary server messages into the report.
    const describeCleanup = ({ operation, projectId, documentId, error }: CleanupError) => ({
      operation,
      ...(projectId ? { projectId } : {}),
      ...(documentId ? { documentId } : {}),
      error: error instanceof LinearTokenError ? error.message : error instanceof Error ? error.name : 'Unknown error',
    });
    const report = {
      perOperation,
      stats: stats.toJSON(),
      lastRateLimit: linear?.transport.lastRateLimit?.headers,
      requests,
      cleanupFailed: cleanupErrors.length > 0,
      cleanupErrors: cleanupErrors.map(describeCleanup),
      restoredInCleanup: cleanup?.restored ?? [],
      unconfirmedRestoreFailures: (cleanup?.unconfirmedRestoreFailures ?? []).map(describeCleanup),
      finalDocuments: cleanup?.final ?? [],
      ...(createdRead ? { createdRead } : {}),
      ...(trashRead ? { trashRead } : {}),
    };
    console.log(JSON.stringify(report, null, 2));
    if (process.env.LINEAR_CONTRACT_REPORT) {
      try {
        await writeFile(process.env.LINEAR_CONTRACT_REPORT, JSON.stringify(report, null, 2));
      } catch (error) {
        cleanupErrors.push({ operation: 'write report', error });
      }
    }
    if (cleanupErrors.length) {
      const summary = cleanupErrors.map((entry) => JSON.stringify(describeCleanup(entry))).join('; ');
      throw new AggregateError(cleanupErrors.map((entry) => entry.error), `Contract cleanup failed: ${summary}`);
    }
  });

  it('reads the rate-limit status', async () => {
    const status = await measured('rateLimitStatus', () => linear.rateLimitStatus());
    const requests = status.limits.find((l) => l.type === 'requests');
    assert.ok(requests && requests.allowedAmount > 0);
    assert.ok(linear.transport.lastRateLimit?.requestsRemaining !== undefined, 'the response carries the remaining-requests header');
  });

  it('creates documents in a project', async () => {
    const sent = await operationsOf(async () => {
      first = await measured('createDocument', () =>
        linear.createDocument({ projectId: projectIds[0]! }, { title: 'Weekly planning', content: '# Goals\n\n- Review the backlog\n- Plan the demo\n' }),
      );
    });
    assert.deepEqual(sent, ['CreateDocument'], 'a create with its stored record needs no read-back');
    second = await linear.createDocument({ projectId: projectIds[0]! }, { title: 'Reading list', content: 'A short list of articles.\n' });
    assert.equal(first.title, 'Weekly planning');
    assert.equal(first.projectId, projectIds[0]);
    assert.equal(typeof first.content, 'string');
    assert.ok(first.documentContentId);
  });

  it('reads documents by ids in one request, with the content the create returned', async () => {
    const ids = [first.id, second.id];
    const { documents: docs, diagnosis } = await readCreated(linear, requests, ids, { pauseMs, record: (d) => (createdRead = d) });
    // The cost of one read; the reads that waited out lag are in createdRead.
    perOperation['getDocuments (2 ids)'] = diagnosis.reads[0]!.requestIds.length;
    assert.deepEqual(
      docs.map((d) => d.id).sort(),
      [...ids].sort(),
      `created documents must be read within ${diagnosis.maxReads} reads and ${pauseMs}ms pauses: ${JSON.stringify(diagnosis)}`,
    );
    assert.ok(docs.every((d) => typeof d.content === 'string' && d.content.length > 0));
    const stored = new Map(docs.map((d) => [d.id, d.content]));
    assert.equal(stored.get(first.id), first.content, 'the create payload is the stored content');
    assert.equal(stored.get(second.id), second.content);
  });

  it('does not return project documents for a team filter', async () => {
    // Narrowed to this run's documents, so the cost does not grow with the team zone.
    const data = await measured('documents (team filter)', () =>
      linear.request<{ documents: { nodes: Array<{ id: string }> } }>(
        'TeamFilter',
        'query',
        `query TeamFilter($teamId: ID!, $ids: [ID!]!) {
          documents(first: 5, filter: { and: [{ team: { id: { eq: $teamId } } }, { id: { in: $ids } }] }) { nodes { id } }
        }`,
        { teamId, ids: [first.id, second.id] },
      ),
    );
    assert.deepEqual(data.documents.nodes, []);
  });

  it('accepts a title of 512 emoji: titles count code points, as content does', async () => {
    const titled = await linear.updateDocument(second.id, { title: '\u{1F4DD}'.repeat(512) });
    assert.equal([...titled.title].length, 512);
    await linear.updateDocument(second.id, { title: 'Reading list' });
  });

  it('leaves out a too-long title without a request', async () => {
    const before = stats.total;
    const error = await linear.createDocument({ projectId: projectIds[0]! }, { title: 'T'.repeat(513) }).catch((e: unknown) => e);
    assert.ok(error instanceof DocumentTooLongError);
    assert.equal(stats.total, before);
  });

  it('lists the documents of a project with content', async () => {
    const docs = await measured('listDocuments (1 page)', () => linear.listDocuments({ projectId: projectIds[0]! }, { withContent: true }));
    assert.deepEqual(docs.map((d) => d.id).sort(), [first.id, second.id].sort());
  });

  it('updates content, renames, sets icon and color, and moves', async () => {
    let updated!: LinearDocument;
    const sent = await operationsOf(async () => {
      updated = await measured('updateDocument (content)', () => linear.updateDocument(first.id, { content: '# Goals\n\n- Ship the demo\n' }));
    });
    assert.deepEqual(sent, ['UpdateDocument'], 'an update with its stored record needs no read-back');
    assert.equal(typeof updated.content, 'string');
    const [read] = await linear.getDocuments([first.id], { withContent: true });
    assert.equal(read?.content, updated.content, 'the update payload is the stored content');
    const renamed = await measured('updateDocument (rename)', () => linear.updateDocument(first.id, { title: 'Weekly planning, revised' }));
    assert.equal(renamed.title, 'Weekly planning, revised');
    const styled = await measured('updateDocument (icon, color)', () => linear.updateDocument(first.id, { icon: 'Book', color: '#5e6ad2' }));
    assert.equal(styled.icon, 'Book');
    assert.equal(styled.color, '#5e6ad2');
    const moved = await measured('updateDocument (move)', () => linear.updateDocument(first.id, { projectId: projectIds[1]! }));
    assert.equal(moved.projectId, projectIds[1]);
  });

  it('comments on a document', async () => {
    const comment = await measured('commentOnDocument', () => linear.commentOnDocument(first.documentContentId!, 'Looks good to me.'));
    assert.ok(comment.id);
  });

  it('uploads a file and returns its asset URL', async () => {
    const uploaded = await measured('uploadFile', () => linear.uploadFile({ filename: 'dot.png', contentType: 'image/png', bytes: PNG }));
    assert.match(uploaded.assetUrl, /^https:\/\//);
  });

  it('trashes and restores a document', async () => {
    // Before the call: a trash may apply even when its answer is lost.
    trashed.add(second.id);
    await measured('trashDocument', () => linear.trashDocument(second.id));
    const [read] = await linear.getDocuments([second.id]);
    let finalRead: { trashed: boolean } | undefined = read;
    if (read?.trashed !== true) {
      trashRead = await diagnoseTrashRead(linear, requests, second.id, read, pauseMs);
      finalRead = 'trashed' in trashRead.delayed ? trashRead.delayed : undefined;
    }
    assert.equal(finalRead?.trashed, true, `trash must be confirmed within two reads and one ${pauseMs}ms pause: ${JSON.stringify(trashRead)}`);
    await measured('restoreDocument', () => linear.restoreDocument(second.id));
    trashed.delete(second.id);
    const [restored] = await linear.getDocuments([second.id]);
    assert.equal(restored?.trashed, false);
  });

  it('reports a missing document as not found', async () => {
    const error = await linear.updateDocument('00000000-0000-4000-8000-000000000000', { title: 'Nothing' }).catch((e: unknown) => e);
    assert.ok(error instanceof LinearGraphQLError);
    assert.equal(error.notFound, true);
    assert.equal(linear.stopped, undefined);
  });
});
