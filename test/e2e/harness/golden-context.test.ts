import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RunContext } from './context.ts';
import { BEFORE_VIEW, linearForms, resolveSubject } from './subjects.ts';

const path = 'docs/policies/work.md';
const asset = 'docs/media/guide.pdf';
const source = '# Work policy\n\n* \n  [Guide (PDF)](../media/guide.pdf)';
const missing = '# Work policy\n\n* [Guide (PDF)](<../media/guide.pdf>)';

it('normalizes an attachment list with the observed linked-file existence', () => {
  const texts = new Map([[path, source]]);
  assert.deepEqual(linearForms(texts, [path, asset]), texts);
  assert.deepEqual(linearForms(texts, [path]), new Map([[path, missing]]));
  // An asset at a different path cannot supply the missing relative target.
  assert.deepEqual(linearForms(texts, [path, 'media/guide.pdf']), new Map([[path, missing]]));
});

it('uses the snapshot asset paths for golden forms without adding assets to the comparison', async () => {
  const files = new Map([[path, source]]);
  const hashes = new Map([[path, 'document-hash'], [asset, 'asset-hash']]);
  const ctx = { observations: new Map([[BEFORE_VIEW, { files, hashes }]]) } as unknown as RunContext;
  assert.deepEqual((await resolveSubject(ctx, 'before.golden.linearForm')).value, files);
  hashes.delete(asset);
  assert.deepEqual((await resolveSubject(ctx, 'before.golden.linearForm')).value, new Map([[path, missing]]));
});

it('keeps present and missing attachments distinct in the same document', () => {
  const text = '* [Guide](../media/guide%20one.pdf)\n* [Absent](../media/absent.pdf)';
  const expected = '* \n  [Guide](../media/guide%20one.pdf)\n* [Absent](<../media/absent.pdf>)';
  assert.deepEqual(linearForms(new Map([[path, text]]), ['docs/media/guide one.pdf']), new Map([[path, expected]]));
});

it('supplies the same snapshot context to typography goldens and single-document fix checks', async () => {
  const files = new Map([[path, source]]);
  const hashes = new Map([[path, 'document-hash'], [asset, 'asset-hash']]);
  const ctx = {
    observations: new Map<string, unknown>([[BEFORE_VIEW, { files, hashes, ids: new Map() }], ['target.path', path]]),
    live: {
      manifest: { files: [{ path, group: 'typography-scripts', kind: 'markdown' }] },
      tree: { paths: new Map([[path, path]]) },
    },
  } as unknown as RunContext;
  assert.deepEqual((await resolveSubject(ctx, 'before.golden.typographyBytes')).value, files);
  assert.equal((await resolveSubject(ctx, 'before.hook.fixes')).value, 0);
  hashes.delete(asset);
  assert.deepEqual((await resolveSubject(ctx, 'before.golden.typographyBytes')).value, new Map([[path, missing]]));
  assert.equal((await resolveSubject(ctx, 'before.hook.fixes')).value, 1);
});
