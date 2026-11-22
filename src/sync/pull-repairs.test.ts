import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { createFixture, IDENTITY, TEST_PUSHED_KEY as KEY } from '../state/test-helpers.ts';
import { type IdEntry, type IdMap, PushedKey, commitTree, commitIds, readIds } from '../state/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedPullView, readPlainFileProvenance, signRepair, signedRepairs, stagePullRepairs, type RepairGate } from './pull-repairs.ts';
import { securityGate } from './security.ts';
import { answeringGate, checkStaged, stagingGate } from './staged.ts';

const PASS: RepairGate = {check: async () => []};

/** `ids` with each repair signed by the sync, as capture records it. */
const signed = (ids: IdMap): IdMap => new Map([...ids].map(([path, entry]) => [path, entry.pullRewrite === undefined ? entry : {...entry, pullRewrite: signRepair(KEY, path, entry.id, entry.pullRewrite)}]));

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
    const ids: IdMap = signed(new Map([['plan.md',{id:'document',pullRewrite:{hash,observedHash:hash,replacement,images:[{image:1,total:1,line:1}]}}]]));
    const first = await checkedPullView(git,base,ids,zones,IDENTITY,PASS,KEY,base);
    assert.equal((await checkedPullView(git,base,ids,zones,IDENTITY,PASS,KEY,base)).commit,first.commit);
    assert.equal(await git.text(['show',`${first.commit}:plan.md`]),replacement.trimEnd());
    const changed = await commitTree(git,{base,parents:[base],changes:new Map([['plan.md',source + 'Later edit.\n']]),message:'Later observation',identity:IDENTITY});
    assert.equal((await checkedPullView(git,changed,ids,zones,IDENTITY,PASS,KEY,changed)).commit,changed);
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
      const ids: IdMap = signed(new Map([[path, {id: 'document', pullRewrite: {hash, observedHash: hash, replacement, images: []}}]]));
      assert.equal((await checkedPullView(git, base, ids, zones, IDENTITY, PASS, KEY, base)).commit, base, path);
    }
    const hash = createHash('sha256').update(source).digest('hex');
    for (const reverse of [false, true]) {
      const entries: Array<[string, {id: string; pullRewrite?: {hash: string; observedHash: string; replacement: string; images: []}}]> = [
        ['docs/plan.md', {id: 'document', pullRewrite: {hash, observedHash: hash, replacement, images: []}}],
        ['outside.md', {id: 'document'}],
      ];
      const ids: IdMap = signed(new Map(reverse ? entries.reverse() : entries));
      assert.equal((await checkedPullView(git, base, ids, zones, IDENTITY, PASS, KEY, base, new Set(['docs/plan.md']))).commit, base);
      await assert.rejects(commitIds(git, null, ids, IDENTITY), /ids\.json maps a document id to more than one path/);
      const tip = await commitTree(git, {base, parents: [base], changes: new Map([['ids.json', JSON.stringify(Object.fromEntries(ids))]]), message: 'Record ambiguous ids', identity: IDENTITY});
      await assert.rejects(readIds(git, tip), /ids\.json maps a document id to more than one path/);
    }
  } finally { await fixture.cleanup(); }
});

it('applies a stored replacement only when the hooks pass its exact text, in process and in the staged steps, and holds the document otherwise', async () => {
  const fixture = await createFixture();
  try {
    const canary = 'repair-canary-9b41';
    await fixture.seed({
      'README.md': '---\nlinear-team: ENG\n---\n',
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: canary-check
        alias: security
        name: Canary check
        entry: node canary-check.mjs
        language: system
`,
      'canary-check.mjs': `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) if (readFileSync(file, 'utf8').includes('${canary}')) { console.log(file + ':1: found'); process.exitCode = 1; }`,
      'plan.md': '![Chart](https://example.com/chart.png)\n',
      'notes.md': '![Plot](https://example.com/plot.png)\n',
    });
    const git = await fixture.clone('gated-repairs');
    const base = await git.text(['rev-parse', 'origin/main']);
    const {zones} = await loadMapping(git, base);
    const repair = async (path: string, replacement: string) => {
      const hash = createHash('sha256').update((await git.run(['show', `${base}:${path}`])).stdout).digest('hex');
      return {hash, observedHash: hash, replacement, images: [{image: 1, total: 1, line: 1}]};
    };
    const safe = '[Chart](https://example.com/chart.png)\n';
    const flagged = `[Plot](https://example.com/plot.png) ${canary}\n`;
    const ids: IdMap = signed(new Map([['plan.md', {id: 'plan', pullRewrite: await repair('plan.md', safe)}], ['notes.md', {id: 'notes', pullRewrite: await repair('notes.md', flagged)}]]));
    const asked: string[][] = [];
    const recording = (answer: Awaited<ReturnType<RepairGate['check']>>): RepairGate => ({check: async (files) => {
      asked.push([...files].map(([path, content]) => `${path}=${String(content)}`));
      return answer;
    }});
    const read = async (commit: string, path: string) => (await git.run(['show', `${commit}:${path}`])).stdout.toString('utf8');
    // The branch the view is merged into: a refused or unanswered repair's document keeps its version there.
    const tracked = await commitTree(git, {base, parents: [base], changes: new Map([['notes.md', 'Tracked text.\n']]), message: 'Tracked edit', identity: IDENTITY});
    // The gate sees each replacement's exact bytes on its own; with a finding or no answer, neither text is proposed.
    for (const answer of [null, [{hook: 'canary-check', line: 1}]]) {
      const view = await checkedPullView(git, base, ids, zones, IDENTITY, recording(answer), KEY, tracked);
      assert.equal(await read(view.commit, 'notes.md'), 'Tracked text.\n');
      assert.equal(await read(view.commit, 'plan.md'), await read(base, 'plan.md'));
      assert.deepEqual(view.notes, []);
    }
    assert.deepEqual(asked.slice(0, 2).sort(), [[`notes.md=${flagged}`], [`plan.md=${safe}`]]);
    const views = [];
    const inProcess = await securityGate(git, base);
    try { views.push(await checkedPullView(git, base, ids, zones, IDENTITY, inProcess, KEY, tracked)); } finally { await inProcess.close?.(); }
    // The staged steps: the stage step stages the stored replacements, the hooks step answers them, the last step applies.
    const folder = join(await mkdtemp(join(fixture.root, 'runner-')), 'candidates');
    const state = {linear: base, ids: await commitIds(git, null, ids, IDENTITY), uploads: null};
    const staging = await stagingGate(git, base, folder);
    await stagePullRepairs(git, state, zones, staging, KEY);
    assert.equal(await staging.finish(), 2);
    assert.deepEqual(await checkStaged(git, folder, {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? ''}), {sets: 2, rejected: 1, unanswered: 0});
    views.push(await checkedPullView(git, base, ids, zones, IDENTITY, await answeringGate(git, base, folder), KEY, tracked));
    for (const view of views) {
      assert.notEqual(view.commit, base);
      assert.equal(await read(view.commit, 'plan.md'), safe);
      assert.equal(await read(view.commit, 'notes.md'), 'Tracked text.\n');
      assert.deepEqual(view.notes, ['- plan.md: image 1 of 1 (line 1).']);
    }
    assert.equal(views[0]!.commit, views[1]!.commit);
  } finally { await fixture.cleanup(); }
});

it('applies only a repair the sync signed for its path and document', async () => {
  const fixture = await createFixture();
  try {
    const source = '![Chart](https://example.com/chart.png)\n';
    await fixture.seed({'README.md': '---\nlinear-team: ENG\n---\n', 'plan.md': source, 'other.md': source});
    const git = await fixture.clone('signed-repairs');
    const base = await git.text(['rev-parse', 'origin/main']);
    const {zones} = await loadMapping(git, base);
    const hash = createHash('sha256').update(source).digest('hex');
    const repair = {hash, observedHash: hash, replacement: '[Chart](https://example.com/chart.png)\n', images: []};
    // The branch the view is merged into: a document whose repair is not applied keeps its version there.
    const hold = await commitTree(git, {base, parents: [base], changes: new Map([['plan.md', 'Tracked text.\n']]), message: 'Tracked edit', identity: IDENTITY});
    const view = async (ids: IdMap) => (await checkedPullView(git, base, ids, zones, IDENTITY, PASS, KEY, hold)).commit;
    const read = async (commit: string) => (await git.run(['show', `${commit}:plan.md`])).stdout.toString('utf8');
    const own = signRepair(KEY, 'plan.md', 'plan', repair);
    assert.equal(await read(await view(new Map([['plan.md', {id: 'plan', pullRewrite: own}]]))), repair.replacement);
    const sourced = signRepair(KEY, 'plan.md', 'plan', {...repair, source: base});
    assert.equal(await read(await view(new Map([['plan.md', {id: 'plan', pullRewrite: sourced}]]))), repair.replacement);
    // With no hooks every text passes the gate: only the signature tells the sync's repair from one written into the ref.
    const forged: IdEntry[] = [
      {id: 'plan', pullRewrite: repair},
      {id: 'plan', pullRewrite: {...repair, mac: '0'.repeat(64)}},
      {id: 'plan', pullRewrite: {...own, replacement: 'Forged text.\n'}},
      {id: 'plan', pullRewrite: {...own, images: [{image: 1, total: 1, line: 1}]}},
      {id: 'plan', pullRewrite: {...own, source: base}},
      {id: 'plan', pullRewrite: (({source: _, ...rest}) => rest)(sourced)},
      {id: 'plan', pullRewrite: {...repair, mac: 42 as unknown as string}},
      {id: 'other', pullRewrite: own},
      {id: 'plan', pullRewrite: signRepair(new PushedKey('another-secret', 'owner/repo'), 'plan.md', 'plan', repair)},
      {id: 'plan', pullRewrite: signRepair(new PushedKey('client-secret', 'owner/other'), 'plan.md', 'plan', repair)},
    ];
    // Neither the forged text nor the observation it would replace is proposed: the document keeps its held version.
    for (const entry of forged) assert.equal(await read(await view(new Map([['plan.md', entry]]))), 'Tracked text.\n', JSON.stringify(entry));
    // Signed for another path, it is not this path's repair.
    assert.equal(await git.text(['show', `${await view(new Map([['other.md', {id: 'plan', pullRewrite: own}]]))}:other.md`]), source.trimEnd());
    assert.deepEqual(signedRepairs(new Map([['plan.md', {id: 'plan', pullRewrite: repair}]]), KEY).get('plan.md'), {id: 'plan'});
  } finally { await fixture.cleanup(); }
});
