import assert from 'node:assert/strict';
import { it } from 'node:test';
import { commentsOf } from './checks.ts';

it('includes comments beyond the first page in the canary evidence', async () => {
  const calls: string[] = [];
  const client = {
    request: async (operation: string) => {
      calls.push(operation);
      if (operation === 'RunComments') return { documents: {
        nodes: [{ id: 'doc', project: null, comments: { nodes: [{ body: 'clean' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } };
      return { document: { comments: { nodes: [{ body: 'kx-last-comment' }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    },
  };
  const result = await commentsOf(client as Parameters<typeof commentsOf>[0], {});
  assert.deepEqual(result[0]?.bodies, ['clean', 'kx-last-comment']);
  assert.deepEqual(calls, ['RunComments', 'RunCommentPage']);
});
