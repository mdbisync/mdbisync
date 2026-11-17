import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { createFixture, IDENTITY } from '../state/test-helpers.ts';
import { type IdMap, commitTree } from '../state/index.ts';
import { checkedPullView, readPlainFileProvenance } from './pull-repairs.ts';

it('derives a stable checked view, binds it to source bytes, and preserves metadata verbatim', async () => {
  const fixture = await createFixture();
  try {
    const source = '---\nowner: "![Metadata](https://example.com/meta.png)"\n---\n\n![Chart](https://example.com/chart.png)\n';
    const replacement = source.replace('![Chart]', '[Chart]');
    await fixture.seed({'plan.md':source});
    const git = await fixture.clone('checked-view');
    const base = await git.text(['rev-parse','origin/main']);
    const hash = createHash('sha256').update(source).digest('hex');
    const ids: IdMap = new Map([['plan.md',{id:'document',pullRewrite:{hash,observedHash:hash,replacement,images:[{image:1,total:1,line:1}]}}]]);
    const first = await checkedPullView(git,base,ids,IDENTITY);
    assert.equal((await checkedPullView(git,base,ids,IDENTITY)).commit,first.commit);
    assert.equal(await git.text(['show',`${first.commit}:plan.md`]),replacement.trimEnd());
    const changed = await commitTree(git,{base,parents:[base],changes:new Map([['plan.md',source + 'Later edit.\n']]),message:'Later observation',identity:IDENTITY});
    assert.equal((await checkedPullView(git,changed,ids,IDENTITY)).commit,changed);
    const provenance = await commitTree(git,{base,parents:[base],changes:new Map([['plan.md',replacement]]),message:'Observation\n\nPlain-link: document assets%2Fchart.csv',identity:IDENTITY});
    assert.deepEqual((await readPlainFileProvenance(git,provenance)).get('document'),new Set(['assets/chart.csv']));
  } finally { await fixture.cleanup(); }
});
