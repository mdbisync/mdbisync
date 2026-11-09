import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import { type Fixture, createFixture, IDENTITY } from '../state/test-helpers.ts';
import { fetchState, resolveStateConfig, commitIds, commitUploads, commitTree, pushAtomic, stateRef, readIds } from '../state/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { LinearClient } from '../linear/index.ts';
import { fakeWorld, fakeFetch, LINEAR_API } from '../setup/test-helpers.ts';
import { resolveTargets } from '../setup/linear.ts';
import { capture } from './capture.ts';
import { documentPath } from './paths.ts';

const TREE = {
  'docs/README.md': '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n\n# Notes\n',
  'other/README.md': '---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n',
  'docs/plan.md': '---\ncategory: work\n---\n\nOriginal.\n',
};

describe('capture from Linear', () => {
  let fixture: Fixture;
  const config = resolveStateConfig({});
  let world: ReturnType<typeof fakeWorld>;
  let context: Parameters<typeof capture>[0];
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    const git = await fixture.clone('capture');
    const fetched = await fetchState(git, config);
    const mapping = await loadMapping(git, fetched.tracked);
    world = fakeWorld();
    world.linear.documents.push({ id: 'plan', title: 'plan', content: 'Original.\n', projectId: 'project-api', createdAt: '2026-01-01T00:00:00Z' });
    const linear = new LinearClient({ token: 'test', baseUrl: LINEAR_API, fetch: fakeFetch(world) });
    const { targets } = await resolveTargets(linear, mapping.zones.values());
    assert.ok(targets);
    const initial = {
      linear: await commitTree(git, { parents: [fetched.tracked], base: fetched.tracked, changes: new Map(), message: 'Initial state', identity: IDENTITY }),
      ids: await commitIds(git, null, new Map([['docs/plan.md', { id: 'plan' }]]), IDENTITY),
      uploads: await commitUploads(git, null, new Map(), IDENTITY),
    };
    assert.equal((await pushAtomic(git, config, Object.entries(initial).map(([store, next]) => ({ ref: stateRef(config, store as 'ids' | 'linear' | 'uploads'), expected: null, next })))).ok, true);
    context = { git, fetched: await fetchState(git, config), mapping, targets, linear };
  });
  afterEach(() => fixture.cleanup());
  const run = () => capture(context, { config, identity: IDENTITY });
  const refresh = async () => { context.fetched = await fetchState(context.git, config); };
  const text = async (path: string) => (await fixture.remote.run(['show', `${stateRef(config, 'linear')}:${path}`])).stdout.toString('utf8');

  it('captures edits with previous front matter; repeated capture makes no content commit', async () => {
    world.linear.documents[0]!.content = 'Updated.\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nUpdated.\n');
    const tip = result.fetched.state.linear;
    await refresh();
    assert.equal((await run()).fetched.state.linear, tip);
  });

  it('captures a new path, renames by id and moves across projects', async () => {
    world.linear.documents.push({ id: 'new', title: 'guides/new-page', content: 'New.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' });
    await run();
    assert.equal(await text('docs/guides/new-page.md'), 'New.\n');
    await refresh();
    Object.assign(world.linear.documents[0]!, { title: 'guides/renamed', projectId: 'project-handbook', updatedAt: '2026-01-03T00:00:00Z' });
    const result = await run();
    assert.equal(await text('other/guides/renamed.md'), '---\ncategory: work\n---\n\nOriginal.\n');
    const ids = await readIds(context.git, result.fetched.state.ids);
    assert.equal(ids.get('other/guides/renamed.md')?.id, 'plan');
    assert.equal(ids.has('docs/plan.md'), false);
  });

  it('removes trash and out-of-scope files and captures a restore', async () => {
    world.linear.documents[0]!.trashed = true;
    await run();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${stateRef(config, 'linear')}:docs/plan.md`], { okCodes: [0, 128] })).code, 128);
    await refresh();
    Object.assign(world.linear.documents[0]!, { trashed: false, updatedAt: '2026-01-04T00:00:00Z' });
    await run();
    assert.equal(await text('docs/plan.md'), 'Original.\n');
    await refresh();
    Object.assign(world.linear.documents[0]!, { projectId: 'outside', updatedAt: '2026-01-05T00:00:00Z' });
    await run();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${stateRef(config, 'linear')}:docs/plan.md`], { okCodes: [0, 128] })).code, 128);
  });

  it('blocks a secret before any object write, saves appearance and restores it on correction', async () => {
    await fixture.seed({
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: secret-check
        alias: security
        name: Secret check
        entry: node check.mjs
        language: system
`,
      'check.mjs': `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) { const lines=readFileSync(file,'utf8').split('\\n'); const line=lines.findIndex(x=>x.includes(['blocked','value','731'].join('-'))); if(line>=0) { console.log(file+':'+(line+1)+': '+lines[line]); process.exitCode=1; } }`,
    });
    await refresh();
    Object.assign(world.linear.documents[0]!, { content: 'blocked-value-731\n', icon: 'Fire', color: '#123456', updatedAt: '2026-01-03T00:00:00Z' });
    world.linear.documents.push({id: 'safe', title: 'safe', projectId: 'project-api', content: 'Safe addition.\n', createdAt: '2026-01-04T00:00:00Z'});
    const rejected = await run();
    assert.equal(rejected.blocked.length, 1);
    assert.ok(!rejected.summary.includes('blocked-value-731'));
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
    assert.equal(await text('docs/safe.md'), 'Safe addition.\n');
    const ids = await readIds(context.git, rejected.fetched.state.ids);
    assert.deepEqual(ids.get('docs/plan.md')?.saved, {icon: 'Fire', color: '#123456'});
    assert.equal(world.linear.documents[0]!.icon, 'Cross');
    assert.equal(world.linear.documents[0]!.color, '#EB5757');
    const comments = world.linear.documents[0]!.comments ?? [];
    assert.match(comments.join(''), /hook `secret-check`, line 5/);
    assert.ok(!comments.join('').includes('blocked-value-731'));
    // The canary was assembled only at runtime, so no fixture script contains it verbatim.
    const canary = ['blocked', 'value', '731'].join('-');
    const remoteObjects = await fixture.remote.text(['cat-file', '--batch-all-objects', '--batch']);
    const localObjects = await context.git.text(['cat-file', '--batch-all-objects', '--batch']);
    // The scanner's own source necessarily holds the rule; exclude that pre-existing source blob.
    assert.ok(!remoteObjects.includes(canary+'\n'));
    assert.ok(!localObjects.includes(canary+'\n'));
    await refresh();
    Object.assign(world.linear.documents[0]!, {content: 'Corrected.\n', updatedAt: '2026-01-05T00:00:00Z'});
    const accepted = await run();
    assert.equal(accepted.blocked.length, 0);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nCorrected.\n');
    assert.equal(world.linear.documents[0]!.icon, 'Fire');
    assert.equal(world.linear.documents[0]!.color, '#123456');
    assert.equal((await readIds(context.git, accepted.fetched.state.ids)).get('docs/plan.md')?.saved, undefined);
  });

  it('downloads a pasted image, records an LFS pointer and populates the upload cache', async () => {
    await fixture.seed({'.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n'});
    await refresh();
    const url = 'https://uploads.linear.app/workspace/pasted.png';
    Object.assign(world.linear.documents[0]!, {content: `![Image](${url})\n`, updatedAt: '2026-01-05T00:00:00Z'});
    const result = await capture(context, { config, identity: IDENTITY, fetch: async () => new Response('image-bytes') });
    assert.equal(result.ok, true);
    assert.equal(result.leftOut.length, 0);
    const image = result.changed.find((path) => path.endsWith('.png'));
    assert.ok(image);
    assert.match(await text(image), /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:/);
    assert.ok((await text('docs/plan.md')).includes(image.slice('docs/'.length)));
    const uploads = await fixture.remote.text(['show', `${stateRef(config, 'uploads')}:uploads.json`]);
    assert.ok(uploads.includes(url));
    const read = (await (await import('../state/index.ts')).readFiles(context.git, config, result.fetched.state.linear!, [image])).get(image)!;
    assert.equal(read.ok, true);
    if(read.ok) assert.equal(read.content.toString(), 'image-bytes');
  });

  it('reads only changed content after the cursor', async () => {
    world.linear.documents.push({id: 'later', title: 'later', projectId: 'project-api', content: 'Later.\n', createdAt: '2026-01-04T00:00:00Z'});
    await run();
    await refresh();
    const calls: string[][] = [];
    const original = context.linear.getDocuments.bind(context.linear);
    context.linear.getDocuments = async (ids, options) => { if (options?.withContent) calls.push([...ids]); return original(ids, options); };
    await run();
    assert.ok(calls.every((ids) => !ids.includes('plan')), 'old content was reread');
  });

  it('reports unchecked content every time and makes no content commit for icon-only updates', async () => {
    const first = await run();
    assert.match(first.summary, /pushed unchecked/);
    const tip = first.fetched.state.linear;
    await refresh();
    Object.assign(world.linear.documents[0]!, { icon: 'Fire', color: '#123456', updatedAt: '2026-01-04T00:00:00Z' });
    const second = await run();
    assert.match(second.summary, /pushed unchecked/);
    assert.equal(second.fetched.state.linear, tip);
  });
});

it('makes safe title paths and deterministic collision names', () => {
  assert.equal(documentPath('docs', 'guides/new-page', 'one', new Set()), 'docs/guides/new-page.md');
  for (const title of ['../escape', '/absolute', '.git/config', 'a\\b', 'NUL', 'a: b?', 'a*b', 'a//b']) {
    const path = documentPath('docs', title, 'one', new Set());
    assert.ok(path.startsWith('docs/'));
    assert.ok(!path.split('/').some((segment) => segment === '..' || segment.toLowerCase() === '.git'));
    assert.ok(!/[\\:*?"<>|]/.test(path));
  }
  const occupied = new Set(['docs/plan.md']);
  assert.notEqual(documentPath('docs', 'plan', 'two', occupied), 'docs/plan.md');
  assert.equal(documentPath('docs', 'plan', 'two', occupied), documentPath('docs', 'plan', 'two', occupied));
});
