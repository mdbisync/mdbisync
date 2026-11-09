import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import { type Fixture, createFixture, IDENTITY } from '../state/test-helpers.ts';
import { fetchState, resolveStateConfig, commitIds, commitUploads, commitTree, pushAtomic, stateRef, readIds, readReservedIds } from '../state/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { LinearClient, LinearStoppedError } from '../linear/index.ts';
import { fakeWorld, fakeFetch, LINEAR_API } from '../setup/test-helpers.ts';
import { resolveTargets } from '../setup/linear.ts';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GITHUB_API } from '../setup/test-helpers.ts';
import { capture } from './capture.ts';
import { writeTrackedToLinear } from './write.ts';
import { MARKERS } from '../merge/index.ts';
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
  const run = () => capture(context, { config, state: context.fetched.state, identity: IDENTITY });
  const commentsOf = (id: string) => [...world.linear.comments.values()].filter((comment) => comment.documentContentId === `content-${id}`).map((comment) => comment.body);
  const refresh = async () => { context.fetched = await fetchState(context.git, config); };
  const text = async (path: string) => (await fixture.remote.run(['show', `${stateRef(config, 'linear')}:${path}`])).stdout.toString('utf8');

  it('captures through the CLI and omits document bodies from its report and summary', async () => {
    await fixture.seed({'.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n'});
    world.linear.documents[0]!.content = 'Private body canary.\n';
    const reportFile = join(fixture.root, 'capture-report.json');
    const result = await runCli(['sync'], {cwd: context.git.dir, fetch: fakeFetch(world), env: {
      MDBISYNC_LINEAR_CLIENT_ID: 'client', MDBISYNC_LINEAR_CLIENT_SECRET: 'secret', MDBISYNC_LINEAR_API_URL: LINEAR_API,
      MDBISYNC_GITHUB_TOKEN: 'token', MDBISYNC_GITHUB_API_URL: GITHUB_API, MDBISYNC_REPOSITORY: 'example/repository', MDBISYNC_REPORT_FILE: reportFile,
    }});
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!result.stdout.includes('Private body canary'));
    const reportText = await readFile(reportFile, 'utf8');
    assert.ok(!reportText.includes('Private body canary'));
    assert.equal(JSON.parse(reportText).capture.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nPrivate body canary.\n');
  });

  it('captures edits with previous front matter; repeated capture makes no content commit', async () => {
    world.linear.documents[0]!.content = 'Updated.\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nUpdated.\n');
    const tip = result.state.linear;
    await refresh();
    assert.equal((await run()).state.linear, tip);
  });

  it('uses the supplied snapshot between steps without changing the run context', async () => {
    const initial = { ...context.fetched.state };
    world.linear.documents[0]!.content = 'First edit.\n';
    const first = await capture(context, {config, state: initial});
    assert.equal(first.ok, true);
    assert.deepEqual(context.fetched.state, initial);
    world.linear.documents[0]!.content = 'Next edit.\n';
    world.linear.documents[0]!.updatedAt = '2026-02-01T00:00:00Z';
    const second = await capture(context, {config, state: first.state});
    assert.equal(second.ok, true);
    assert.notEqual(second.state.linear, first.state.linear);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nNext edit.\n');
    assert.deepEqual(context.fetched.state, initial);
  });

  it('reports a rate-limited CLI capture as a partial warning with its stop reason', async () => {
    await fixture.seed({'.pre-commit-config.yaml':'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n'});
    const reportFile = join(fixture.root, 'partial-report.json');
    const request = fakeFetch(world);
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === `${LINEAR_API}/graphql` && JSON.parse(String(init?.body)).operationName === 'ListDocuments') {
        return new Response(JSON.stringify({errors:[{message:'Limited', extensions:{code:'RATELIMITED'}}]}), {status:429, headers:{'retry-after':'12'}});
      }
      return request(input, init);
    };
    const result = await runCli(['sync'], {cwd:context.git.dir, fetch:fetcher, env:{
      MDBISYNC_LINEAR_CLIENT_ID:'client', MDBISYNC_LINEAR_CLIENT_SECRET:'secret', MDBISYNC_LINEAR_API_URL:LINEAR_API,
      MDBISYNC_GITHUB_TOKEN:'token', MDBISYNC_GITHUB_API_URL:GITHUB_API, MDBISYNC_REPOSITORY:'example/repository', MDBISYNC_REPORT_FILE:reportFile,
    }});
    // Every partial sync exits with the incomplete code, so a script can tell it from a complete one.
    assert.equal(result.exitCode, INCOMPLETE_EXIT_CODE, result.stderr);
    assert.match(result.stderr, /warning: sync: partial, will continue/);
    assert.equal(JSON.parse(await readFile(reportFile, 'utf8')).exitStatus, 'warning');
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.code, 'stopped');
    assert.equal(report.stoppedEarly, true);
    assert.equal(report.capture.stopped.kind, 'rate-limited');
    assert.equal(report.capture.stopped.operation, 'ListDocuments');
    assert.equal(report.capture.stopped.retryAfterSeconds, 12);
    assert.deepEqual(world.writes, []);
  });

  it('returns a partial capture when document listing exhausts the budget', async () => {
    const before = {...context.fetched.state};
    const reason = {kind:'budget-low' as const, operation:'ListDocuments', header:'x-ratelimit-requests-remaining', remaining:10, threshold:100};
    context.linear.listDocumentsInPlaces = async () => { throw new LinearStoppedError('ListDocuments', reason); };
    const partial = await run();
    assert.equal(partial.ok, false);
    assert.equal(partial.code, 'stopped');
    assert.deepEqual(partial.stopped, reason);
    assert.deepEqual(partial.state, before);
    assert.deepEqual(partial.changed, []);
    assert.deepEqual(partial.removed, []);
    assert.match(partial.summary, /partial.*will continue/i);
    assert.deepEqual(world.writes, []);
  });

  it('returns durable progress when rate-limited after capture pushes a pending notice', async () => {
    const before = {...context.fetched.state};
    world.linear.documents[0]!.content = 'Rejected.\n';
    world.linear.documents.push({id:'safe', title:'safe', projectId:'project-api', content:'Safe.\n', createdAt:'2026-01-02T00:00:00Z'});
    world.linear.writes.rateLimitAt = 1;
    const gate = {configured:true, check:async(files:ReadonlyMap<string, Buffer|string>)=>files.has('docs/plan.md')?[{hook:'secret-check', line:1}]:[]};
    const partial = await capture(context, {config, state:context.fetched.state, security:gate});
    assert.equal(partial.code, 'stopped');
    assert.equal(partial.stopped?.kind, 'rate-limited');
    assert.notEqual(partial.state.ids, before.ids);
    assert.notEqual(partial.state.linear, before.linear);
    assert.equal(await text('docs/safe.md'), 'Safe.\n');
    const pending = (await readIds(context.git, partial.state.ids)).get('docs/plan.md')!.saved!.notice!;
    assert.equal(pending.posted, false);
    delete world.linear.writes.rateLimitAt;
    context.linear = new LinearClient({token:'test', baseUrl:LINEAR_API, fetch:fakeFetch(world)});
    await refresh();
    const resumed = await capture(context, {config, state:context.fetched.state, security:gate});
    assert.equal(resumed.ok, true);
    const posted = (await readIds(context.git, resumed.state.ids)).get('docs/plan.md')!.saved!.notice!;
    assert.equal(posted.id, pending.id);
    assert.equal(posted.posted, true);
    assert.equal(commentsOf('plan')?.length, 1);
  });

  it('preserves reserved document ids through capture and subsequent runs', async () => {
    const reserved = new Map([['docs/future.md', 'future-document']]);
    const state = context.fetched.state;
    const next = await commitIds(context.git, state.ids, await readIds(context.git, state.ids), IDENTITY, {reserved});
    assert.equal((await pushAtomic(context.git, config, [{ref:stateRef(config,'ids'), expected:state.ids, next}])).ok, true);
    await refresh();
    world.linear.documents[0]!.content = 'An accepted edit.\n';
    const first = await run();
    assert.deepEqual(await readReservedIds(context.git, first.state.ids), reserved);
    assert.equal((await readIds(context.git, first.state.ids)).has('docs/future.md'), false);
    await refresh();
    const second = await run();
    assert.deepEqual(await readReservedIds(context.git, second.state.ids), reserved);
    assert.equal(second.state.ids, first.state.ids);
  });

  it('writes to an encoded captured filename without changing the Linear title', async () => {
    world.linear.documents[0]!.title = 'question?';
    const captured = await run();
    const path = 'docs/question%3F.md';
    const tracked = await commitTree(context.git, {parents:[captured.state.linear!], base:captured.state.linear, changes:new Map([[path, '---\ncategory: work\n---\n\nEdited in git.\n']]), message:'Edit document', identity:IDENTITY});
    await context.git.run(['push', 'origin', `${tracked}:refs/heads/main`]);
    await refresh();
    const written = await writeTrackedToLinear(context, {config, state:captured.state});
    assert.deepEqual(written.updated, [path]);
    assert.equal(world.linear.documents[0]!.content, 'Edited in git.\n');
    assert.equal(world.linear.documents[0]!.title, 'question?');
  });

  it('captures a new path, renames by id and moves across projects', async () => {
    world.linear.documents.push({ id: 'new', title: 'guides/new-page', content: 'New.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' });
    await run();
    assert.equal(await text('docs/guides/new-page.md'), 'New.\n');
    await refresh();
    Object.assign(world.linear.documents[0]!, { title: 'guides/renamed', projectId: 'project-handbook', updatedAt: '2026-01-03T00:00:00Z' });
    const result = await run();
    assert.equal(await text('other/guides/renamed.md'), '---\ncategory: work\n---\n\nOriginal.\n');
    const ids = await readIds(context.git, result.state.ids);
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

  for (const change of ['trash', 'outside', 'rename', 'move'] as const) {
    it(`preserves folder annotations when its README document undergoes ${change}`, async () => {
      const readme = {id:'readme', title:'README', projectId:'project-api', content:'# Notes\n', createdAt:'2026-01-02T00:00:00Z'};
      world.linear.documents.push(readme);
      const ids = await readIds(context.git, context.fetched.state.ids);
      ids.set('docs/README.md', {id:readme.id});
      const tip = await commitIds(context.git, context.fetched.state.ids, ids, IDENTITY);
      const carrier = change === 'rename'
        ? TREE['docs/README.md'].replace('linear-team: ENG', 'linear-team: &team ENG\ncategory: *team')
        : TREE['docs/README.md'].replace('---\n', '---\ncategory: work\n');
      const linearTip = await commitTree(context.git, {parents:[context.fetched.state.linear!], base:context.fetched.state.linear!, changes:new Map([['docs/README.md', carrier]]), identity:IDENTITY, message:'Keep document metadata'});
      assert.equal((await pushAtomic(context.git, config, [
        {ref:stateRef(config,'ids'), expected:context.fetched.state.ids, next:tip},
        {ref:stateRef(config,'linear'), expected:context.fetched.state.linear, next:linearTip},
      ])).ok, true);
      await refresh();
      if (change === 'trash') Object.assign(readme, {trashed:true});
      if (change === 'outside') readme.projectId = 'outside';
      if (change === 'rename') readme.title = 'sub/README';
      if (change === 'move') readme.projectId = 'project-handbook';
      const captured = await run();
      assert.equal(captured.ok, true);
      assert.equal(await text('docs/README.md'), carrier.replace('# Notes\n', ''));
      const mapping = await loadMapping(context.git, captured.state.linear!);
      assert.ok(mapping.documents.some((file) => file.path === 'docs/plan.md'));
      assert.equal(mapping.problems.length, 0);
      const capturedIds = await readIds(context.git, captured.state.ids);
      assert.equal(capturedIds.has('docs/README.md'), false);
      const moved = [...capturedIds].find(([,entry]) => entry.id === readme.id);
      if (change === 'rename' || change === 'move') {
        assert.ok(moved);
        assert.ok((await text(moved[0])).includes(change === 'rename' ? 'category: ENG' : 'category: work'));
        assert.ok(!(await text(moved[0])).includes('linear-team:'));
        assert.ok(!(await text(moved[0])).includes('linear-project:'));
      } else assert.equal(moved, undefined);
      await fixture.seed({'docs/next.md':'A later tracked edit.\n'});
      await refresh();
      context.mapping = await loadMapping(context.git, context.fetched.tracked);
      const written = await writeTrackedToLinear(context, {config, state:captured.state});
      assert.equal(written.trashed.includes('docs/plan.md'), false);
      assert.equal(world.linear.documents.find((doc) => doc.id === 'plan')?.trashed, undefined);
      assert.equal(world.linear.documents.filter((doc) => doc.projectId === 'project-api' && doc.title === 'README' && !('trashed' in doc && doc.trashed)).length, 0, 'the annotation carrier must not recreate its removed document');
    });
  }

  it('reserves an identity-only blocked path before allocating an earlier same-title document', async () => {
    const blocked = {id:'z-blocked',title:'duplicate',projectId:'project-api',content:'Rejected body.\n',createdAt:'2026-01-03T00:00:00Z'};
    world.linear.documents.push(blocked);
    const security = {configured:true, check:async (files:ReadonlyMap<string, Buffer|string>) => [...files.values()].some((body) => String(body).includes('Rejected body.')) ? [{hook:'secret-check',line:1}] : []};
    const first = await capture(context, {config, state:context.fetched.state, security});
    assert.equal(first.blocked[0]?.path, 'docs/duplicate.md');
    assert.equal((await fixture.remote.run(['cat-file','-e',`${first.state.linear}:docs/duplicate.md`], {okCodes:[0,128]})).code, 128);
    await refresh();
    world.linear.documents.push({id:'a-earlier',title:'duplicate',projectId:'project-api',content:'Accepted body.\n',createdAt:'2026-01-04T00:00:00Z'});
    const second = await capture(context, {config, state:context.fetched.state, security});
    assert.equal(second.ok, true);
    const ids = await readIds(context.git, second.state.ids);
    assert.equal(ids.get('docs/duplicate.md')?.id, blocked.id);
    assert.ok(ids.get('docs/duplicate.md')?.saved);
    const accepted = [...ids].find(([,entry]) => entry.id === 'a-earlier');
    assert.ok(accepted);
    assert.notEqual(accepted[0], 'docs/duplicate.md');
    assert.equal(await text(accepted[0]), 'Accepted body.\n');
    assert.equal(world.linear.documents.find((doc) => doc.id === blocked.id)?.icon, 'Cross');
    await refresh();
    Object.assign(blocked, {content:'Corrected body.\n',updatedAt:'2026-03-01T00:00:00Z'});
    const third = await capture(context, {config, state:context.fetched.state, security});
    const finalIds = await readIds(context.git, third.state.ids);
    assert.equal(finalIds.get('docs/duplicate.md')?.id, blocked.id);
    assert.equal(finalIds.get(accepted[0])?.id, 'a-earlier');
    assert.equal(finalIds.get('docs/duplicate.md')?.saved, undefined);
    assert.equal(await text('docs/duplicate.md'), 'Corrected body.\n');
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
    const ids = await readIds(context.git, rejected.state.ids);
    const decoration = ids.get('docs/plan.md')!.saved!;
    assert.equal(decoration.icon, 'Fire');
    assert.equal(decoration.color, '#123456');
    assert.equal(decoration.notice?.kind, 'blocked');
    assert.equal(decoration.notice?.posted, true);
    assert.equal(world.linear.documents[0]!.icon, 'Cross');
    assert.equal(world.linear.documents[0]!.color, '#EB5757');
    const comments = commentsOf('plan') ?? [];
    assert.match(comments.join(''), /Hook `secret-check`, line 5/);
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
    assert.equal((await readIds(context.git, accepted.state.ids)).get('docs/plan.md')?.saved, undefined);
  });

  it('downloads a pasted image, records an LFS pointer and populates the upload cache', async () => {
    await fixture.seed({'.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n'});
    await refresh();
    const url = 'https://uploads.linear.app/workspace/pasted.png';
    Object.assign(world.linear.documents[0]!, {content: `![Image](${url})\n`, updatedAt: '2026-01-05T00:00:00Z'});
    const result = await capture(context, { config, state: context.fetched.state, identity: IDENTITY, fetch: async () => new Response('image-bytes') });
    assert.equal(result.ok, true);
    assert.equal(result.leftOut.length, 0);
    const image = result.changed.find((path) => path.endsWith('.png'));
    assert.ok(image);
    assert.match(await text(image), /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:/);
    assert.ok((await text('docs/plan.md')).includes(image.slice('docs/'.length)));
    const uploads = await fixture.remote.text(['show', `${stateRef(config, 'uploads')}:uploads.json`]);
    assert.ok(uploads.includes(url));
    const read = (await (await import('../state/index.ts')).readFiles(context.git, config, result.state.linear!, [image])).get(image)!;
    assert.equal(read.ok, true);
    if(read.ok) assert.equal(read.content.toString(), 'image-bytes');
  });

  it('restores links between documents using the shared inverse', async () => {
    world.linear.documents.push({id: 'target', title: 'guides/target', projectId: 'project-api', content: 'Target.\n', createdAt: '2026-01-04T00:00:00Z'});
    world.linear.documents[0]!.content = '[Target](https://linear.app/example-team/document/target#intro)\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\n[Target](<guides/target.md#intro>)\n');
  });

  it('retries an asset failure on an older document after accepting a newer document', async () => {
    world.linear.documents[0]!.content = '![Image](https://uploads.linear.app/workspace/retry.png)\n';
    world.linear.documents.push({id: 'later', title: 'later', projectId: 'project-api', content: 'Later.\n', createdAt: '2026-01-04T00:00:00Z'});
    const first = await capture(context, { config, state: context.fetched.state, fetch: async () => { throw new Error('Unavailable'); } });
    assert.equal(first.leftOut.length, 1);
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
    await refresh();
    const next = await capture(context, { config, state: context.fetched.state, fetch: async () => new Response('image') });
    assert.equal(next.leftOut.length, 0);
    assert.ok(next.changed.includes('docs/plan.md'));
  });

  it('refreshes unchanged inbound links and keeps the accepted target when a rename is blocked', async () => {
    world.linear.documents[0]!.content = '[Target](https://linear.app/example-team/document/target)\n';
    world.linear.documents.push({id: 'target', title: 'target', projectId: 'project-api', content: 'Target.\n', createdAt: '2026-01-04T00:00:00Z'});
    await run();
    await refresh();
    Object.assign(world.linear.documents[1]!, {title: 'renamed', updatedAt: '2026-01-05T00:00:00Z'});
    const blocked = await capture(context, {config, state: context.fetched.state, security: {configured: true, check: async (files) => files.has('docs/renamed.md') ? [{hook:'secret-check', line:1}] : []}});
    assert.equal(blocked.blocked.length, 1);
    assert.ok((await text('docs/plan.md')).includes('<target.md>'));
    await refresh();
    const accepted = await run();
    assert.equal(accepted.blocked.length, 0);
    assert.ok((await text('docs/plan.md')).includes('<renamed.md>'));
    assert.equal(await text('docs/renamed.md'), 'Target.\n');
  });

  it('reconciles conflict, blocked and clear marks with durable notices and one original icon', async () => {
    const doc = world.linear.documents[0]!;
    Object.assign(doc, {icon:'Fire', color:'#123456', content:`${MARKERS.git}\n\nFirst.\n\n${MARKERS.linear}\n\nSecond.\n\n${MARKERS.end}\n`});
    const first = await run();
    assert.equal(doc.icon, 'Alert');
    assert.equal(doc.color, '#F2994A');
    const original = (await readIds(context.git, first.state.ids)).get('docs/plan.md')!.saved!;
    assert.equal(original.notice?.kind, 'conflict');
    assert.equal(original.notice?.posted, true);
    assert.equal(original.icon, 'Fire');
    assert.equal(commentsOf(doc.id)?.length, 1);
    await refresh();
    const repeated = await run();
    assert.equal(commentsOf(doc.id)?.length, 1);
    assert.deepEqual((await readIds(context.git, repeated.state.ids)).get('docs/plan.md')!.saved, original);
    await refresh();
    const blocked = await capture(context, {config, state:context.fetched.state, security:{configured:true, check:async()=>[{hook:'secret-check', line:5}]}});
    assert.equal(doc.icon, 'Cross');
    const saved = (await readIds(context.git, blocked.state.ids)).get('docs/plan.md')!.saved!;
    assert.equal(saved.icon, 'Fire');
    assert.equal(saved.color, '#123456');
    assert.equal(saved.notice?.kind, 'blocked');
    assert.equal(saved.notice?.posted, true);
    assert.notEqual(saved.notice?.id, original.notice?.id);
    assert.equal(commentsOf(doc.id)?.length, 2);
    await refresh();
    const revised = await capture(context, {config, state:context.fetched.state, security:{configured:true, check:async()=>[{hook:'secret-check', line:7}]}});
    const revisedNotice = (await readIds(context.git, revised.state.ids)).get('docs/plan.md')!.saved!.notice!;
    assert.equal(revisedNotice.id, saved.notice?.id);
    assert.notEqual(revisedNotice.bodyHash, saved.notice?.bodyHash);
    assert.equal(revisedNotice.posted, true);
    assert.equal(commentsOf(doc.id)?.length, 2);
    assert.match(commentsOf(doc.id)!.at(-1)!, /line 7/);
    await refresh();
    doc.content = 'Resolved.\n';
    const cleared = await run();
    assert.equal(doc.icon, 'Fire');
    assert.equal(doc.color, '#123456');
    assert.equal((await readIds(context.git, cleared.state.ids)).get('docs/plan.md')!.saved, undefined);
    assert.equal(commentsOf(doc.id)?.length, 2);
  });

  it('recovers a posted notice after losing the receipt lease and preserves reserved ids', async () => {
    const reserved = new Map([['docs/future.md', 'future-document']]);
    const state = context.fetched.state;
    const next = await commitIds(context.git, state.ids, await readIds(context.git, state.ids), IDENTITY, {reserved});
    assert.equal((await pushAtomic(context.git, config, [{ref:stateRef(config,'ids'), expected:state.ids, next}])).ok, true);
    await refresh();
    const ensure = context.linear.ensureDocumentComment.bind(context.linear);
    context.linear.ensureDocumentComment = async (...args) => {
      const comment = await ensure(...args);
      const observed = await fetchState(context.git, config);
      const current = await readIds(context.git, observed.state.ids);
      const notice = current.get('docs/plan.md')!.saved!.notice!;
      assert.equal(notice.id, comment.id);
      assert.equal(notice.posted, false);
      const competing = await commitIds(context.git, observed.state.ids, current, IDENTITY, {reserved, always:true, message:'Concurrent ids update'});
      assert.equal((await pushAtomic(context.git, config, [{ref:stateRef(config,'ids'), expected:observed.state.ids, next:competing}])).ok, true);
      return comment;
    };
    const gate = {configured:true, check:async()=>[{hook:'secret-check', line:5}]};
    world.linear.documents[0]!.content = 'Rejected.\n';
    world.linear.comments.set('existing-note', {documentContentId:'content-plan', body:'Existing note.'});
    const interrupted = await capture(context, {config, state:context.fetched.state, security:gate});
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.code, 'state-moved');
    assert.equal(commentsOf('plan')?.length, 2);
    await refresh();
    const pending = (await readIds(context.git, context.fetched.state.ids)).get('docs/plan.md')!.saved!.notice!;
    assert.equal(pending.posted, false);
    context.linear.ensureDocumentComment = ensure;
    const resumed = await capture(context, {config, state:context.fetched.state, security:gate});
    assert.equal(resumed.ok, true);
    assert.equal(commentsOf('plan')?.length, 2);
    const posted = (await readIds(context.git, resumed.state.ids)).get('docs/plan.md')!.saved!.notice!;
    assert.equal(posted.id, pending.id);
    assert.equal(posted.posted, true);
    assert.deepEqual(await readReservedIds(context.git, resumed.state.ids), reserved);
    assert.equal(commentsOf('plan')![0], 'Existing note.');
  });

  it('retries a security comment after its post-push delivery fails', async () => {
    const gate = {configured: true, check: async () => [{hook:'secret-check', line:5}]};
    world.linear.documents[0]!.content = 'Rejected.\n';
    world.linear.writes.reject = (operation) => operation === 'CommentOnDocument';
    // The refused comment ends the capture partial, not with an error: the next run posts it again.
    const failed = await capture(context, {config, state: context.fetched.state, security: gate});
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'linear-failed');
    assert.equal(failed.failure?.operation, 'CommentOnDocument');
    assert.equal(world.linear.documents[0]!.icon, 'Cross');
    await refresh();
    delete world.linear.writes.reject;
    await capture(context, {config, state: context.fetched.state, security: gate});
    assert.match(commentsOf('plan')?.join('') ?? '', /Hook `secret-check`, line 5/);
  });

  it('keeps team-zone documents outside nested project folders', async () => {
    await fixture.seed({
      'team/README.md': '---\nlinear-team: Docs\n---\n\nTeam.\n',
      'team/sub/README.md': '---\nlinear-project: Research\n---\n\nResearch.\n',
    });
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    context.targets.projects.set('Docs\0Research', {id:'project-research', name:'Research'});
    world.linear.documents.push({id:'team-only', title:'sub/team-only', teamId:'team-docs', content:'Team document.\n', createdAt:'2026-01-06T00:00:00Z'});
    const result = await run();
    const ids = await readIds(context.git, result.state.ids);
    const path = [...ids].find(([,entry]) => entry.id === 'team-only')?.[0];
    assert.ok(path);
    assert.ok(path.startsWith('team/'));
    assert.ok(!path.startsWith('team/sub/'));
    assert.equal(await text(path), 'Team document.\n');
  });

  it('preserves prior document-link spellings and leaves URLs to blocked new targets usable', async () => {
    const target = {id:'target', title:'target', projectId:'project-api', content:'Target.\n', createdAt:'2026-01-04T00:00:00Z'};
    world.linear.documents.push(target);
    world.linear.documents[0]!.content = '[Target](https://linear.app/example-team/document/target)\n';
    await run();
    await refresh();
    const raw = '---\ncategory: work\n---\n\n[Target](./target.md)\n';
    const record = await commitTree(context.git, {parents:[context.fetched.state.linear!], base:context.fetched.state.linear, changes:new Map([['docs/plan.md',raw]]), message:'Keep link spelling', identity:IDENTITY});
    assert.equal((await pushAtomic(context.git,config,[{ref:stateRef(config,'linear'),expected:context.fetched.state.linear,next:record}])).ok,true);
    await refresh();
    Object.assign(world.linear.documents[0]!, {content:'[Target](https://linear.app/example-team/document/target)\n\nEdited.\n', updatedAt:'2026-01-06T00:00:00Z'});
    await run();
    assert.ok((await text('docs/plan.md')).includes('[Target](./target.md)'));
    await refresh();
    world.linear.documents.push({id:'blocked-new',title:'blocked-new',projectId:'project-api',content:'Rejected.\n',createdAt:'2026-01-07T00:00:00Z'});
    Object.assign(world.linear.documents[0]!, {content:'[New](https://linear.app/example-team/document/blocked-new)\n',updatedAt:'2026-01-07T00:00:00Z'});
    const result = await capture(context,{config, state: context.fetched.state,security:{configured:true,check:async(files)=>files.has('docs/blocked-new.md')?[{hook:'secret-check',line:1}]:[]}});
    assert.equal(result.blocked.length,1);
    assert.ok((await text('docs/plan.md')).includes('https://linear.app/example-team/document/blocked-new'));
    assert.equal((await fixture.remote.run(['cat-file','-e',`${stateRef(config,'linear')}:docs/blocked-new.md`],{okCodes:[0,128]})).code,128);
  });

  it('scans original upload URLs before their query can enter the cache ref', async () => {
    const secret = ['query','canary','731'].join('-');
    const url = `https://uploads.linear.app/workspace/image.png?access=${secret}`;
    world.linear.documents[0]!.content = `![Image](${url})\n`;
    const result = await capture(context,{config, state: context.fetched.state,fetch:async()=>new Response('image'),security:{configured:true,check:async(files)=>[...files.values()].some((value)=>String(value).includes(secret))?[{hook:'secret-check',line:5}]:[]}});
    assert.equal(result.blocked.length,1);
    assert.equal(await text('docs/plan.md'),TREE['docs/plan.md']);
    const remoteObjects = await fixture.remote.text(['cat-file','--batch-all-objects','--batch']);
    assert.ok(!remoteObjects.includes(secret));
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
    const tip = first.state.linear;
    await refresh();
    Object.assign(world.linear.documents[0]!, { icon: 'Fire', color: '#123456', updatedAt: '2026-01-04T00:00:00Z' });
    const second = await run();
    assert.match(second.summary, /pushed unchecked/);
    assert.equal(second.state.linear, tip);
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
  assert.equal(documentPath('docs', '100% done', 'one', new Set(), 'docs/100% done.md'), 'docs/100% done.md');
  const occupied = new Set(['docs/plan.md']);
  const collision = documentPath('docs', 'plan', 'two', occupied);
  assert.notEqual(collision, 'docs/plan.md');
  assert.equal(documentPath('docs', 'plan', 'two', new Set(), collision), collision);
  assert.equal(documentPath('docs', 'plan', 'two', occupied), documentPath('docs', 'plan', 'two', occupied));
});
