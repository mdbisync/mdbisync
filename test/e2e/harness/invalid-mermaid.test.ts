import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildCorpus } from '../../corpus/generate.ts';
import { compare, differingPaths } from './checks.ts';
import type { RunContext } from './context.ts';
import { SUBJECTS } from './subjects.ts';
import { loadScenarios } from './spec.ts';

// L1-09 on the mid slice of the default corpus: which Mermaid documents hold
// an invalid diagram comes from the manifest, since neither their paths nor
// their texts say "invalid".
const corpus = buildCorpus('a'.repeat(40));
const mid = new Set(corpus.slices.mid);
const manifest = { ...corpus.manifest, files: corpus.manifest.files.filter((file) => mid.has(file.path)) };
const ctx = { live: { manifest, tree: { paths: new Map([...mid].map((path) => [path, path])) } } } as unknown as RunContext;
const texts = new Map(corpus.files.filter((file) => mid.has(file.path)).map((file) => [file.path, file.content.toString('utf8')]));
const mermaid = manifest.files.filter((file) => file.group === 'mermaid' && file.kind === 'markdown').map((file) => file.path);

/** Every mid Mermaid document synchronized as a live document, except those `missing` leaves out and `trashed` trashes. */
function viewOf(missing: readonly string[] = [], trashed: readonly string[] = []) {
  const ids = new Map(mermaid.filter((path) => !missing.includes(path)).map((path) => [path, { id: `id:${path}` }]));
  const documents = new Map([...ids].map(([path, { id }]) => [id, { id, content: texts.get(path), trashed: trashed.includes(path), archivedAt: null }]));
  return { files: texts, ids, documents };
}

const assertion = loadScenarios().find((candidate) => candidate.id === 'L1-09')?.checks.assertions.find((candidate) => candidate.subject === 'documents.invalidMermaidIncluded');

// evaluateAssertion reads its view from git and Linear; this runs the same compare and differingPaths on a given view.
async function check(view: ReturnType<typeof viewOf>): Promise<{ holds: boolean; paths: string | undefined }> {
  assert.ok(assertion);
  assert.equal(assertion.operator, 'same-as');
  const env = { ctx, which: 'now' as const, view: async () => view } as unknown as Parameters<(typeof SUBJECTS)[string]>[0];
  const actual = await SUBJECTS[assertion.subject]!(env);
  const expected = await SUBJECTS[String(assertion.expected)]!(env);
  return { holds: compare(assertion.operator, actual, expected), paths: differingPaths(actual, expected) };
}

const invalid = [
  'eng/edge-cases/diagrams/the-life-of-an-order-2.md',
  'eng/edge-cases/diagrams/the-life-of-an-order.md',
];

it('finds the mid slice invalid diagrams by the manifest, not by the word in the path or text', async () => {
  const env = { ctx, which: 'now' as const, view: async () => viewOf() } as unknown as Parameters<(typeof SUBJECTS)[string]>[0];
  assert.deepEqual([...((await SUBJECTS['expected.invalidMermaidIncluded']!(env)) as Map<string, boolean>).keys()], invalid);
  for (const path of invalid) {
    assert.ok(mermaid.includes(path), path);
    assert.doesNotMatch(path, /invalid/i);
    assert.doesNotMatch(texts.get(path) ?? '', /invalid/i);
  }
});

it('holds when every invalid diagram document is synchronized', async () => {
  assert.deepEqual(await check(viewOf()), { holds: true, paths: undefined });
});

it('names the invalid diagram document that is left out or trashed', async () => {
  assert.deepEqual(await check(viewOf([invalid[0]!])), { holds: false, paths: `differs at ${invalid[0]}` });
  assert.deepEqual(await check(viewOf([], [invalid[1]!])), { holds: false, paths: `differs at ${invalid[1]}` });
});

it('fails loudly on a slice without an invalid diagram', async () => {
  const noInvalid = { live: { manifest: { ...manifest, files: manifest.files.filter((file) => !invalid.includes(file.path)) }, tree: { paths: new Map([...mid].map((path) => [path, path])) } } } as unknown as RunContext;
  const env = { ctx: noInvalid, which: 'now' as const, view: async () => viewOf() } as unknown as Parameters<(typeof SUBJECTS)[string]>[0];
  await assert.rejects(() => SUBJECTS['documents.invalidMermaidIncluded']!(env), /no Mermaid document with an invalid diagram/);
});
