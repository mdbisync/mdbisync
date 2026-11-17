import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { createFixture, IDENTITY } from '../state/test-helpers.ts';
import { type IdMap, commitTree, commitIds, readIds } from '../state/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { checkedPullView, readPlainFileProvenance } from './pull-repairs.ts';

it('derives a stable checked view, binds it to source bytes, and preserves metadata verbatim', async () => {
  const fixture = await createFixture();
  try {
    const source = '---\nowner: "![Metadata](https://example.com/meta.png)"\n---\n\n![Chart](https://example.com/chart.png)\n';
    const replacement = source.replace('![Chart]', '[Chart]');
    await fixture.seed({'README.md': '---\nlinear-team: ENG\n---\n', 'plan.md':source});
    const git = await fixture.clone('checked-view');
    const base = await git.text(['rev-parse','origin/main']);
    const {zones} = await loadMapping(git, base);
    const hash = createHash('sha256').update(source).digest('hex');
    const ids: IdMap = new Map([['plan.md',{id:'document',pullRewrite:{hash,observedHash:hash,replacement,images:[{image:1,total:1,line:1}]}}]]);
    const first = await checkedPullView(git,base,ids,zones,IDENTITY);
    assert.equal((await checkedPullView(git,base,ids,zones,IDENTITY)).commit,first.commit);
    assert.equal(await git.text(['show',`${first.commit}:plan.md`]),replacement.trimEnd());
    const changed = await commitTree(git,{base,parents:[base],changes:new Map([['plan.md',source + 'Later edit.\n']]),message:'Later observation',identity:IDENTITY});
    assert.equal((await checkedPullView(git,changed,ids,zones,IDENTITY)).commit,changed);
    const provenance = await commitTree(git,{base,parents:[base],changes:new Map([['plan.md',replacement]]),message:'Observation\n\nPlain-link: document assets%2Fchart.csv',identity:IDENTITY});
    assert.deepEqual((await readPlainFileProvenance(git,provenance)).get('document'),new Set(['assets/chart.csv']));
  } finally { await fixture.cleanup(); }
});

it('selects only mapped regular Markdown documents with an unambiguous id', async () => {
  const fixture = await createFixture();
  try {
    const source = '![Chart](https://example.com/chart.png)\n';
    const replacement = '[Chart](https://example.com/chart.png)\n';
    await fixture.seed({
      'docs/README.md': '---\nlinear-team: ENG\n---\n',
      'docs/plan.md': source, 'outside.md': source, 'docs/script.sh': source,
      'docs/.github/workflows/notes.md': source,
      'docs/binary.md': Buffer.from([0, 1, 2]),
      'docs/duplicate.md': source, 'docs/Duplicate.md': source,
    });
    const git = await fixture.clone('repair-selection');
    const base = await git.text(['rev-parse', 'origin/main']);
    const {zones} = await loadMapping(git, base);
    for (const path of ['outside.md', 'docs/script.sh', 'docs/.github/workflows/notes.md', 'docs/binary.md', 'docs/duplicate.md', 'docs/Duplicate.md']) {
      const bytes = (await git.run(['show', `${base}:${path}`])).stdout;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ids: IdMap = new Map([[path, {id: 'document', pullRewrite: {hash, observedHash: hash, replacement, images: []}}]]);
      assert.equal((await checkedPullView(git, base, ids, zones, IDENTITY)).commit, base, path);
    }
    const hash = createHash('sha256').update(source).digest('hex');
    for (const reverse of [false, true]) {
      const entries: Array<[string, {id: string; pullRewrite?: {hash: string; observedHash: string; replacement: string; images: []}}]> = [
        ['docs/plan.md', {id: 'document', pullRewrite: {hash, observedHash: hash, replacement, images: []}}],
        ['outside.md', {id: 'document'}],
      ];
      const ids: IdMap = new Map(reverse ? entries.reverse() : entries);
      assert.equal((await checkedPullView(git, base, ids, zones, IDENTITY, new Set(['docs/plan.md']))).commit, base);
      await assert.rejects(commitIds(git, null, ids, IDENTITY), /ids\.json maps a document id to more than one path/);
      const tip = await commitTree(git, {base, parents: [base], changes: new Map([['ids.json', JSON.stringify(Object.fromEntries(ids))]]), message: 'Record ambiguous ids', identity: IDENTITY});
      await assert.rejects(readIds(git, tip), /ids\.json maps a document id to more than one path/);
    }
  } finally { await fixture.cleanup(); }
});
