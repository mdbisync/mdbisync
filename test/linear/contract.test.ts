// Contract tests against a real Linear workspace. They run only when
// LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET are set; the
// app needs client credentials tokens with read and write scopes.
// Optional: LINEAR_TEST_TEAM_KEY (default: the first team),
// LINEAR_BASE_URL (a proxy in front of Linear), LINEAR_CONTRACT_REPORT (a
// path for the JSON report of requests per operation).
//
// Everything written is neutral work text in two short-lived projects, which
// are removed at the end. About 25 API requests per run.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import {
  LinearClient,
  LinearGraphQLError,
  RequestStats,
  mintAppToken,
  revokeToken,
  type LinearDocument,
  type LogEntry,
  type RunToken,
} from '../../src/linear/index.ts';

const clientId = process.env.LINEAR_TEST_APP_CLIENT_ID;
const clientSecret = process.env.LINEAR_TEST_APP_CLIENT_SECRET;
const baseUrl = process.env.LINEAR_BASE_URL;
const live = Boolean(clientId && clientSecret);

// A 1x1 PNG.
const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

describe('Linear client contract', { skip: live ? false : 'LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET are not set' }, () => {
  const suffix = randomBytes(3).toString('hex');
  const stats = new RequestStats();
  const perOperation: Record<string, number> = {};
  // Every request, without content: operation, status, request id, error codes.
  const requests: Array<Omit<LogEntry, 'rateLimitHeaders'>> = [];
  let token: RunToken;
  let linear: LinearClient;
  let teamId: string;
  const projectIds: string[] = [];
  let first: LinearDocument;
  let second: LinearDocument;

  /** Runs one step and records how many API requests it took. */
  async function measured<T>(name: string, step: () => Promise<T>): Promise<T> {
    const before = stats.total;
    const result = await step();
    perOperation[name] = stats.total - before;
    return result;
  }

  before(async () => {
    token = await measured('mint token', () => mintAppToken({ clientId: clientId!, clientSecret: clientSecret! }, { baseUrl, stats }));
    linear = new LinearClient({
      token: token.accessToken,
      baseUrl,
      stats,
      hooks: { log: ({ rateLimitHeaders, ...entry }) => requests.push(entry) },
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
    if (!linear) return;
    try {
      for (const id of projectIds) {
        await linear.request('DeleteProject', 'mutation', 'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }', { id });
      }
    } finally {
      await measured('revoke token', () => revokeToken(token.accessToken, { baseUrl, stats }));
      const report = { perOperation, stats: stats.toJSON(), lastRateLimit: linear.transport.lastRateLimit?.headers, requests };
      console.log(JSON.stringify(report, null, 2));
      if (process.env.LINEAR_CONTRACT_REPORT) await writeFile(process.env.LINEAR_CONTRACT_REPORT, JSON.stringify(report, null, 2));
    }
  });

  it('reads the rate-limit status', async () => {
    const status = await measured('rateLimitStatus', () => linear.rateLimitStatus());
    const requests = status.limits.find((l) => l.type === 'requests');
    assert.ok(requests && requests.allowedAmount > 0);
    assert.ok(linear.transport.lastRateLimit?.requestsRemaining !== undefined, 'the response carries the remaining-requests header');
  });

  it('creates documents in a project', async () => {
    first = await measured('createDocument', () =>
      linear.createDocument({ projectId: projectIds[0]! }, { title: 'Weekly planning', content: '# Goals\n\n- Review the backlog\n- Plan the demo\n' }),
    );
    second = await linear.createDocument({ projectId: projectIds[0]! }, { title: 'Reading list', content: 'A short list of articles.\n' });
    assert.equal(first.title, 'Weekly planning');
    assert.equal(first.projectId, projectIds[0]);
    assert.equal(typeof first.content, 'string');
    assert.ok(first.documentContentId);
  });

  it('reads documents by ids in one request', async () => {
    const docs = await measured('getDocuments (2 ids)', () => linear.getDocuments([first.id, second.id], { withContent: true }));
    assert.deepEqual(docs.map((d) => d.id).sort(), [first.id, second.id].sort());
    assert.ok(docs.every((d) => typeof d.content === 'string' && d.content.length > 0));
  });

  it('lists the documents of a project with content', async () => {
    const docs = await measured('listDocuments (1 page)', () => linear.listDocuments({ projectId: projectIds[0]! }, { withContent: true }));
    assert.deepEqual(docs.map((d) => d.id).sort(), [first.id, second.id].sort());
  });

  it('updates content, renames, sets icon and color, and moves', async () => {
    const updated = await measured('updateDocument (content)', () => linear.updateDocument(first.id, { content: '# Goals\n\n- Ship the demo\n' }));
    assert.equal(typeof updated.content, 'string');
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
    await measured('trashDocument', () => linear.trashDocument(second.id));
    const [trashed] = await linear.getDocuments([second.id]);
    assert.ok(trashed, 'a trashed document is still read by id');
    assert.equal(trashed.trashed, true);
    await measured('restoreDocument', () => linear.restoreDocument(second.id));
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
