// suspended.marksRestored: after a release, each held document shows its own
// icon and color again, or the conflict mark when its text holds a conflict.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RunContext } from './context.ts';
import { BEFORE_VIEW, SUBJECTS } from './subjects.ts';

const CONFLICT = '**Sync conflict: git version**\n\n```sh\nnpm ci\n```\n\n**Sync conflict: Linear version**\n\n```sh\nnpm install\n```\n\n**Sync conflict: end**\n';
// The same lines as a quoted example: not a conflict.
const QUOTED = CONFLICT.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');

interface Doc { content: string; icon: string | null; color: string | null }

async function holds(start: Doc, end: Doc): Promise<unknown> {
  const before = { documents: new Map([['doc', { id: 'doc', ...start }]]) };
  const now = { documents: new Map([['doc', { id: 'doc', ...end }]]) };
  const ctx = { observations: new Map<string, unknown>([[BEFORE_VIEW, before], ['suspended.documents', new Set(['doc'])]]) } as unknown as RunContext;
  const env = { ctx, which: 'now' as const, view: async () => now } as unknown as Parameters<(typeof SUBJECTS)[string]>[0];
  return SUBJECTS['suspended.marksRestored']!(env);
}

it('expects the document\'s own icon and color when its text holds no conflict', async () => {
  assert.equal(await holds({ content: 'Text.\n', icon: 'Book', color: '#4ea7fc' }, { content: 'Text.\n', icon: 'Book', color: '#4ea7fc' }), true);
  assert.equal(await holds({ content: 'Text.\n', icon: null, color: null }, { content: 'Text.\n', icon: 'Cross', color: '#EB5757' }), false);
});

it('expects the conflict mark when the released text holds a conflict', async () => {
  assert.equal(await holds({ content: CONFLICT, icon: null, color: null }, { content: CONFLICT, icon: 'Alert', color: '#F2994A' }), true);
  assert.equal(await holds({ content: CONFLICT, icon: null, color: null }, { content: CONFLICT, icon: null, color: null }), false);
  assert.equal(await holds({ content: CONFLICT, icon: null, color: null }, { content: CONFLICT, icon: 'Cross', color: '#EB5757' }), false);
});

it('treats quoted marker lines as text, not a conflict', async () => {
  assert.equal(await holds({ content: QUOTED, icon: null, color: null }, { content: QUOTED, icon: null, color: null }), true);
  assert.equal(await holds({ content: QUOTED, icon: null, color: null }, { content: QUOTED, icon: 'Alert', color: '#F2994A' }), false);
});
