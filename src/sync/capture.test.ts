import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, it } from 'node:test';
import { type Fixture, createFixture, IDENTITY, mergeOnGitHub, remoteRef } from '../state/test-helpers.ts';
import { fetchState, resolveStateConfig, commitIds, commitUploads, commitTree, movedRefs, pushAtomic, stateRef, readIds, readReservedIds, listTree, readBlobs, PushedKey } from '../state/index.ts';
import { loadMapping } from '../mapping/index.ts';
import { LinearClient, LinearStoppedError, LinearHttpError } from '../linear/index.ts';
import { fakeWorld, fakeFetch, LINEAR_API } from '../setup/test-helpers.ts';
import { resolveTargets } from '../setup/linear.ts';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GITHUB_API } from '../setup/test-helpers.ts';
import { fixText, lintInTree, sameMarkdown, splitFile } from '../format/index.ts';
import { hookRun } from '../format/test-helpers.ts';
import { LINK_VARIANT_LINKS, type LinkVariantBudget, capture, linkVariants, linkVariantBudget, prepareLfs } from './capture.ts';
import { type FileContent, contentBytes } from '../state/content.ts';
import { candidateKey } from './staged.ts';
import { MERGE_RECORD_MESSAGE, writeTrackedToLinear } from './write.ts';
import { MARKERS } from '../merge/index.ts';
import { MARKS } from './marks.ts';
import { IMAGE_REPAIR_INPUT_LIMIT } from './image-links.ts';

const markOf = (doc: {icon?: string | null, color?: string | null} | undefined) => ({icon: doc?.icon ?? null, color: doc?.color ?? null});
import { RECORD_MESSAGE } from '../initial-sync/confirm.ts';
import { documentPath, titlePath } from './paths.ts';
import { buildTree, checkRepoPath, isGitDirectoryName } from '../state/objects.ts';

const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));

/**
 * A title whose first segment is too long for a file name: it is shortened to its first 40 characters and a hash.
 * HFS+ ignores U+200C, and this segment's hash starts with digits only, so the shortened name reads as
 * `git~9361948027816177`, a short name of the Git directory.
 */
const SHORTENED_GIT_TITLE = `git${'\u200c'.repeat(37)}${'x'.repeat(80)}31/note`;

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
      uploads: await commitUploads(git, null, new Map(), IDENTITY, new PushedKey('client-secret', 'owner/repo')),
    };
    assert.equal((await pushAtomic(git, config, Object.entries(initial).map(([store, next]) => ({ ref: stateRef(config, store as 'ids' | 'linear' | 'uploads'), expected: null, next })))).ok, true);
    context = { git, fetched: await fetchState(git, config), mapping, targets, linear, identity: IDENTITY, pushedKey: new PushedKey('client-secret', 'owner/repo') };
  });
  afterEach(() => fixture.cleanup());
  const run = () => capture(context, { config, state: context.fetched.state, identity: IDENTITY });
  const commentsOf = (id: string) => [...world.linear.comments.values()].filter((comment) => comment.documentContentId === `content-${id}`).map((comment) => comment.body);
  const refresh = async () => { context.fetched = await fetchState(context.git, config); };
  const text = async (path: string) => (await fixture.remote.run(['show', `${stateRef(config, 'linear')}:${path}`])).stdout.toString('utf8');

  it('leaves deeply nested documents out while capturing an unrelated document on repeated runs', async () => {
    const nested = '> '.repeat(130) + 'nesting-canary';
    world.linear.documents[0]!.content = nested;
    world.linear.documents.push(
      {id: 'deep-new', title: 'deep', content: nested, projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z'},
      {id: 'ordinary', title: 'ordinary', content: 'Ordinary update.\n', projectId: 'project-api', createdAt: '2026-01-03T00:00:00Z'},
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run();
      assert.equal(result.ok, true);
      assert.deepEqual(result.leftOut.sort((a, b) => a.id.localeCompare(b.id)), [{id: 'deep-new', rule: 'markdown-complexity'}, {id: 'plan', rule: 'markdown-complexity'}]);
      assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
      assert.equal(await text('docs/ordinary.md'), 'Ordinary update.');
      assert.ok(!JSON.stringify(result.leftOut).includes('nesting-canary'));
      assert.equal(world.linear.comments.size, 0);
      await refresh();
    }
  });

  it('captures a corrected document even when its accepted legacy body exceeds the depth limit', async () => {
    const previous = context.fetched.state.linear!;
    const legacy = await commitTree(context.git, {parents: [previous], base: previous, changes: new Map([['docs/plan.md', '> '.repeat(130) + 'legacy-canary']]), message: 'Legacy state', identity: IDENTITY});
    assert.equal((await pushAtomic(context.git, config, [{ref: stateRef(config, 'linear'), expected: previous, next: legacy}])).ok, true);
    await refresh();
    world.linear.documents[0]!.content = 'Corrected.\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.deepEqual(result.leftOut, []);
    assert.equal(await text('docs/plan.md'), 'Corrected.');
  });

  it('captures through the CLI and omits document bodies from its report and summary', async () => {
    await fixture.seed({'.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n'});
    world.linear.documents[0]!.content = 'Private body canary.\n';
    const reportFile = join(fixture.root, 'capture-report.json');
    const result = await runCli(['sync'], {cwd: context.git.dir, fetch: fakeFetch(world), env: {
      MDBISYNC_LINEAR_CLIENT_ID: 'client', MDBISYNC_LINEAR_CLIENT_SECRET: 'secret', MDBISYNC_LINEAR_API_URL: LINEAR_API,
      MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_MERGE_WITHOUT_CHECKS: 'true', MDBISYNC_GITHUB_TOKEN: 'token', MDBISYNC_GITHUB_API_URL: GITHUB_API, MDBISYNC_REPOSITORY: 'example/repository', MDBISYNC_REPORT_FILE: reportFile,
    }});
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!result.stdout.includes('Private body canary'));
    const reportText = await readFile(reportFile, 'utf8');
    assert.ok(!reportText.includes('Private body canary'));
    assert.equal(JSON.parse(reportText).capture.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nPrivate body canary.');
  });

  it('reports a repaired dead upload and a retry separately through the sync CLI', async () => {
    await fixture.seed({'.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n'});
    world.linear.documents[0]!.content = '![Image](https://uploads.linear.app/workspace/dead.png)';
    world.linear.documents.push({id:'retry', title:'retry', projectId:'project-api', content:'![Image](https://uploads.linear.app/workspace/retry.png)', createdAt:'2026-01-04T00:00:00Z'});
    const reportFile = join(fixture.root, 'download-report.json');
    const network = fakeFetch(world);
    const result = await runCli(['sync'], {cwd:context.git.dir, fetch:async (input, init) => {
      if (String(input).startsWith('https://uploads.linear.app/')) return new Response(null, {status:String(input).endsWith('dead.png') ? 404 : 503});
      return network(input, init);
    }, env:{
      MDBISYNC_LINEAR_CLIENT_ID:'client', MDBISYNC_LINEAR_CLIENT_SECRET:'secret', MDBISYNC_LINEAR_API_URL:LINEAR_API,
      MDBISYNC_MERGE_GRACE_SECONDS:'0', MDBISYNC_GITHUB_TOKEN:'token', MDBISYNC_GITHUB_API_URL:GITHUB_API, MDBISYNC_REPOSITORY:'example/repository', MDBISYNC_REPORT_FILE:reportFile,
    }});
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.capture.blocked.length, 0);
    assert.deepEqual(report.capture.leftOut, [{id:'retry', rule:'download-retry'}]);
    assert.match(result.stdout, /download-retry/);
    assert.equal(world.linear.comments.size, 0);
    assert.notDeepEqual(markOf(world.linear.documents[0]), MARKS.blocked);
    assert.notDeepEqual(markOf(world.linear.documents[1]), MARKS.blocked);
  });

  it('leaves an attachment count overrun resumable through the fake-service CLI', async () => {
    await fixture.seed({'.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n'});
    world.linear.documents[0]!.content = Array.from({length: 33}, (_, i) => `[File](https://uploads.linear.app/file-${i})`).join('\n');
    const network = fakeFetch(world);
    const reportFile = join(fixture.root, 'budget-report.json');
    let downloads = 0;
    const result = await runCli(['sync'], {cwd: context.git.dir, fetch: async (input, init) => {
      if (String(input).startsWith('https://uploads.linear.app/')) { downloads++; return new Response(png); }
      return network(input, init);
    }, env: {
      MDBISYNC_LINEAR_CLIENT_ID:'client', MDBISYNC_LINEAR_CLIENT_SECRET:'secret', MDBISYNC_LINEAR_API_URL:LINEAR_API,
      MDBISYNC_MERGE_GRACE_SECONDS:'0', MDBISYNC_GITHUB_TOKEN:'token', MDBISYNC_GITHUB_API_URL:GITHUB_API,
      MDBISYNC_REPOSITORY:'example/repository', MDBISYNC_REPORT_FILE:reportFile,
    }});
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.deepEqual(report.capture.leftOut, [{id:'plan', rule:'attachment-budget'}]);
    assert.equal(downloads, 0);
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
    assert.equal(world.linear.comments.size, 0);
    assert.match(result.stdout, /attachment-budget/);
  });

  it('withholds a document over the image repair budget and captures its neighbor', async () => {
    world.linear.documents[0]!.content = '![](x) '.repeat(Math.floor(IMAGE_REPAIR_INPUT_LIMIT / 7) + 1);
    const references = '![Chart][image] '.repeat(300) + '\n\n[image]: ' + 'x'.repeat(4_000);
    world.linear.documents.push(
      {id: 'charts', title: 'charts', projectId: 'project-api', content: references, createdAt: '2026-01-03T00:00:00Z'},
      {id: 'safe', title: 'safe', projectId: 'project-api', content: 'Safe addition.\n', createdAt: '2026-01-04T00:00:00Z'},
    );
    const result = await run();
    assert.equal(result.ok, true);
    assert.deepEqual(result.leftOut, [{id: 'plan', rule: 'image-repair-budget'}, {id: 'charts', rule: 'image-repair-budget'}]);
    assert.match(result.summary, /image-repair-budget: "plan"/);
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
    await assert.rejects(text('docs/charts.md'));
    assert.equal(await text('docs/safe.md'), 'Safe addition.');
  });

  it('captures edits with previous front matter; repeated capture makes no content commit', async () => {
    world.linear.documents[0]!.content = 'Updated.\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nUpdated.');
    const tip = result.state.linear;
    await refresh();
    assert.equal((await run()).state.linear, tip);
  });

  it('writes Linear\'s text in the form the linear-format hook leaves unchanged', async () => {
    // Linear can store a table cell with a trailing space (`| a  |`) and other spacing `fix` normalizes.
    const stored = '# Plan  \n\n| Step | State |\n| -- | -- |\n| Draft the outline  | tbd |\n|  Padded on both sides  |   x |\n\n'
      + '* First item\n    continued with extra indentation\n\nA line\n   with an indented continuation.\n\n'
      // A callout as Linear stores it: its comment directly above the quote.
      + '<!-- linear:callout color=#f2c94c -->\n> [!WARNING]\n> Kept both versions.';
    assert.notEqual(fixText(stored), stored);
    world.linear.documents[0]!.content = stored;
    world.linear.documents.push({id: 'new', title: 'new', content: stored, projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z'});
    const result = await run();
    assert.equal(result.ok, true);
    for (const path of ['docs/plan.md', 'docs/new.md']) {
      const file = await text(path);
      assert.ok(sameMarkdown(splitFile(file).body, stored), path);
      assert.match(file, /^\| Draft the outline \| tbd \|$/m, path);
      assert.deepEqual(hookRun(path, file), {exitCode: 0, stdout: '', stderr: ''}, path);
    }
    // Linear still holds its own spelling of the same document: the next run has nothing to capture.
    await refresh();
    assert.equal((await run()).state.linear, result.state.linear);
    // An edit in git (in the hook's form) merged with Linear's text: the record after the write passes the hook too.
    const edited = (await text('docs/new.md')).replace('| tbd |', '| done |');
    const tracked = await commitTree(context.git, {parents: [result.state.linear!], base: result.state.linear, changes: new Map([['docs/new.md', edited]]), message: 'Edit document', identity: IDENTITY});
    await context.git.run(['push', 'origin', `${tracked}:refs/heads/main`]);
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    const written = await writeTrackedToLinear(context, {config, state: result.state});
    assert.deepEqual(written.updated, ['docs/new.md']);
    const recorded = await text('docs/new.md');
    assert.match(recorded, /^\| Draft the outline \| done \|$/m);
    assert.deepEqual(hookRun('docs/new.md', recorded), {exitCode: 0, stdout: '', stderr: ''});
  });

  it('writes a Linear body that opens with a rule in the hook\'s form, under the file\'s front matter', async () => {
    // Read alone, the text between the two rules would look like front matter; the hook reads it as body.
    const stored = '---\n\n| Step | State |\n| -- | -- |\n| Draft the outline  | tbd |\n\n---\n\nAfter.';
    world.linear.documents[0]!.content = stored;
    const result = await run();
    assert.equal(result.ok, true);
    const file = await text('docs/plan.md');
    assert.equal(splitFile(file).head, '---\ncategory: work\n---\n\n');
    assert.match(file, /^\| Draft the outline \| tbd \|$/m);
    assert.deepEqual(hookRun('docs/plan.md', file), {exitCode: 0, stdout: '', stderr: ''});
  });

  it('keeps a Linear body that opens with a front matter block as the body, in a folder README too', async () => {
    // Linear spells a thematic break `---`: a document that opens with a rule and has another one later
    // reads, in a file without front matter, as a front matter block.
    const blockFirst = '---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\nText.\n';
    world.linear.documents.push(
      {id:'notes', title:'notes', projectId:'project-api', content:blockFirst, createdAt:'2026-01-02T00:00:00Z'},
      {id:'sub-readme', title:'sub/README', projectId:'project-api', content:blockFirst, createdAt:'2026-01-03T00:00:00Z'},
    );
    const result = await run();
    assert.equal(result.ok, true);
    for (const path of ['docs/notes.md', 'docs/sub/README.md']) {
      const file = await text(path);
      assert.equal(splitFile(file).head, '', path);
      // Read as a body, the text between the rules is a setext heading, which `fix` would write on one line: that
      // changes the document, not only its spelling, so the file keeps Linear's text.
      assert.ok(sameMarkdown(splitFile(file).body, blockFirst), path);
    }
    const mapping = await loadMapping(context.git, result.state.linear!);
    assert.deepEqual(mapping.problems, []);
    assert.equal(mapping.zones.has('docs/sub'), false);
    assert.deepEqual(mapping.documents.find((file) => file.path === 'docs/sub/README.md')?.title, 'sub/README');
    // Linear still returns its own spelling: the next run has nothing to capture.
    await refresh();
    assert.equal((await run()).state.linear, result.state.linear);
    // An edit in git goes back to Linear as the body, the opening rule included.
    const edited = (await text('docs/notes.md')).replace('Text.', 'Edited in git.');
    const tracked = await commitTree(context.git, {parents:[result.state.linear!], base:result.state.linear, changes:new Map([['docs/notes.md', edited]]), message:'Edit document', identity:IDENTITY});
    await context.git.run(['push', 'origin', `${tracked}:refs/heads/main`]);
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    const written = await writeTrackedToLinear(context, {config, state:result.state});
    assert.deepEqual(written.updated, ['docs/notes.md']);
    assert.ok(sameMarkdown(world.linear.documents.find((doc) => doc.id === 'notes')!.content!, blockFirst.replace('Text.', 'Edited in git.')));
  });

  it('leaves an excluded file whose body opens with a rule under front matter as last accepted', async () => {
    // The image is gone from git, so the file is excluded; Linear still holds the same text and its upload.
    const hash = createHash('sha256').update(png).digest('hex');
    const url = 'https://uploads.linear.app/workspace/pixel.png';
    const head = '---\ncategory: work\n---\n\n';
    const body = '---\nA.\n---\n\n![Image](pixel.png)\n';
    await fixture.seed({'docs/plan.md': head + body, 'docs/pixel.png': png});
    const git = await fixture.clone('excluded');
    const fetched = await fetchState(git, config);
    const linearTip = await commitTree(git, {parents:[fetched.tracked], base:fetched.tracked, changes:new Map([['docs/pixel.png', null]]), message:'Remove the image', identity:IDENTITY});
    const ids = await commitIds(git, fetched.state.ids, new Map([['docs/plan.md', {id:'plan'}]]), IDENTITY);
    const uploads = await commitUploads(git, fetched.state.uploads, new Map([[hash, url]]), IDENTITY, context.pushedKey);
    assert.equal((await pushAtomic(git, config, [
      {ref:stateRef(config, 'linear'), expected:fetched.state.linear, next:linearTip},
      {ref:stateRef(config, 'ids'), expected:fetched.state.ids, next:ids},
      {ref:stateRef(config, 'uploads'), expected:fetched.state.uploads, next:uploads},
    ])).ok, true);
    world.linear.documents[0]!.content = body.replace('pixel.png', url);
    const state = await fetchState(git, config);
    context = {...context, git, fetched:state, mapping:await loadMapping(git, state.tracked)};
    const result = await capture(context, {config, state:context.fetched.state, identity:IDENTITY, fetch:async () => new Response(png, {headers:{'content-type':'image/png'}})});
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, []);
    assert.equal(result.state.linear, linearTip);
  });

  for (const [name, content, warns] of [
    ['at the content limit', 'a'.repeat(250_000), false],
    ['emoji below the code-point limit', '\u{1F600}'.repeat(125_001), false],
    ['emoji above the code-point limit', '\u{1F600}'.repeat(250_001), true],
  ] as const) {
    it(`captures ${name} and reports write-back limits in code points`, async () => {
      world.linear.documents[0]!.content = content;
      const result = await run();
      assert.equal(result.ok, true);
      assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\n' + content);
      assert.deepEqual(result.leftOut, []);
      assert.deepEqual(result.writeBackWarnings, warns ? [{path:'docs/plan.md', code:'linear-content-too-large-to-write-back', length:250_001, limit:250_000}] : []);
      assert.equal(result.summary.includes('linear-content-too-large-to-write-back'), warns);
      assert.ok(!result.summary.includes(content));
      assert.deepEqual(world.writes, []);
    });
  }

  it('never captures a place that only an altered state ref names', async () => {
    world.linear.projects.push({ id: 'project-payroll', name: 'Payroll', teamIds: ['team-eng'] });
    world.linear.documents.push({ id: 'payroll', title: 'salaries', content: 'Payroll body.\n', projectId: 'project-payroll', createdAt: '2026-01-01T00:00:00Z' });
    // A writer of the repository pushes a state commit whose folder annotation names a project the tracked branch never named.
    const base = context.fetched.state.linear!;
    const altered = await commitTree(context.git, { parents: [base], base, changes: new Map([['docs/README.md', '---\nlinear-team: ENG\nlinear-project: Payroll\n---\n\n# Notes\n']]), message: 'Altered state', identity: IDENTITY });
    assert.equal((await pushAtomic(context.git, config, [{ ref: stateRef(config, 'linear'), expected: base, next: altered }])).ok, true);
    await refresh();
    const listedPlaces: unknown[] = [];
    const list = context.linear.listDocumentsInPlaces.bind(context.linear);
    context.linear.listDocumentsInPlaces = (places, options) => { listedPlaces.push(...places); return list(places, options); };
    await assert.rejects(run(), /for docs\/ that is not a move the tracked branch made/);
    assert.ok(!JSON.stringify(listedPlaces).includes('project-payroll'), JSON.stringify(listedPlaces));
    assert.equal(await remoteRef(fixture, stateRef(config, 'linear')), altered);
    assert.equal((await fixture.remote.run(['log', '--all', '--format=%H', '-S', 'Payroll body'])).stdout.toString('utf8'), '');
  });

  for (const [where, annotation, lostIds] of [
    ['a project', 'linear-team: ENG\nlinear-project: Payroll', false],
    ['a project, with the ids map lost', 'linear-team: ENG\nlinear-project: Payroll', true],
    ['the team alone', 'linear-team: ENG', false],
    ['the team alone, with the ids map lost', 'linear-team: ENG', true],
  ] as const) it(`never reads an excluded file's place that only altered state refs name: ${where}`, async () => {
    world.linear.projects.push({ id: 'project-payroll', name: 'Payroll', teamIds: ['team-eng'] });
    const inProject = annotation.includes('Payroll');
    world.linear.documents.push({ id: 'payroll', title: 'salaries', content: 'Payroll body.\n', ...(inProject ? { projectId: 'project-payroll' } : { teamId: 'team-eng' }), createdAt: '2026-01-01T00:00:00Z' });
    // Altered refs: a folder of that place with a file synchronized once and excluded now (its image is gone), and its id.
    const {linear: base, ids: idsBase} = context.fetched.state;
    const synced = await commitTree(context.git, { parents: [base!], base: base!, changes: new Map<string, string | Buffer>([
      ['secret/README.md', `---\n${annotation}\n---\n\n# Secret\n`],
      ['secret/salaries.md', 'Placeholder.\n\n![Image](pixel.png)\n'],
      ['secret/pixel.png', png],
    ]), message: RECORD_MESSAGE, identity: IDENTITY });
    const altered = await commitTree(context.git, { parents: [synced], base: synced, changes: new Map([['secret/pixel.png', null]]), message: 'Altered state', identity: IDENTITY });
    const ids = await commitIds(context.git, idsBase, new Map([['docs/plan.md', { id: 'plan' }], ['secret/salaries.md', { id: 'payroll' }]]), IDENTITY);
    assert.equal((await pushAtomic(context.git, config, [
      { ref: stateRef(config, 'linear'), expected: base, next: altered },
      { ref: stateRef(config, 'ids'), expected: idsBase, next: ids },
    ])).ok, true);
    if (lostIds) await fixture.remote.run(['update-ref', '-d', stateRef(config, 'ids')]);
    await refresh();
    const listedPlaces: unknown[] = [];
    const list = context.linear.listDocumentsInPlaces.bind(context.linear);
    context.linear.listDocumentsInPlaces = (places, options) => { listedPlaces.push(...places); return list(places, options); };
    const result = await run();
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(listedPlaces).includes(inProject ? 'project-payroll' : '"teamId"'), JSON.stringify(listedPlaces));
    assert.equal((await fixture.remote.run(['log', '--all', '--format=%H', '-S', 'Payroll body'])).stdout.toString('utf8'), '');
  });

  it('keeps capturing the old place of a folder whose annotation the tracked branch changed', async () => {
    world.linear.projects.push({ id: 'project-archive', name: 'Archive', teamIds: ['team-eng'] });
    await fixture.seed({ 'docs/README.md': '---\nlinear-team: ENG\nlinear-project: Archive\n---\n\n# Notes\n' });
    await context.git.run(['fetch', '--quiet', 'origin']);
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    const { targets } = await resolveTargets(context.linear, context.mapping.zones.values());
    assert.ok(targets);
    context.targets = targets;
    world.linear.documents[0]!.content = 'Edited before the move.\n';
    world.linear.documents[0]!.updatedAt = '2026-02-01T00:00:00Z';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nEdited before the move.');
  });

  it('never reads a place the tracked branch moved a folder away from once a merged sync recorded the move', async () => {
    // The tracked branch moves docs/ from "Field notes" to Archive, and a sync recording Archive is merged.
    world.linear.projects.push({ id: 'project-archive', name: 'Archive', teamIds: ['team-eng'] });
    world.linear.documents[0]!.content = 'Removed project body.\n';
    world.linear.documents[0]!.updatedAt = '2026-02-01T00:00:00Z';
    await fixture.seed({ 'docs/README.md': '---\nlinear-team: ENG\nlinear-project: Archive\n---\n\n# Notes\n' });
    await context.git.run(['fetch', '--quiet', 'origin']);
    await refresh();
    const before = context.fetched.state.linear!;
    const moved = context.fetched.tracked;
    const synced = await commitTree(context.git, { parents: [before, moved], base: moved, changes: new Map(), message: MERGE_RECORD_MESSAGE, identity: IDENTITY });
    await context.git.run(['push', '--quiet', 'origin', `${synced}:refs/heads/sync`]);
    assert.ok('sha' in await mergeOnGitHub(fixture, { head: 'sync', base: 'main', number: 1 }, synced));
    // A writer of the repository moves the state ref back to the record that still names "Field notes".
    await fixture.remote.run(['update-ref', stateRef(config, 'linear'), before]);
    await context.git.run(['fetch', '--quiet', 'origin']);
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    const { targets } = await resolveTargets(context.linear, context.mapping.zones.values());
    assert.ok(targets);
    context.targets = targets;
    const reads: unknown[] = [];
    const list = context.linear.listDocumentsInPlaces.bind(context.linear);
    context.linear.listDocumentsInPlaces = (places, options) => { reads.push(...places); return list(places, options); };
    const get = context.linear.getDocuments.bind(context.linear);
    context.linear.getDocuments = (ids) => { reads.push(...ids); return get(ids); };
    await assert.rejects(run(), /for docs\/ that is not a move the tracked branch made and the sync has not recorded yet/);
    assert.deepEqual(reads, []);
    assert.equal(await remoteRef(fixture, stateRef(config, 'linear')), before);
    assert.equal((await fixture.remote.run(['log', '--all', '--format=%H', '-S', 'Removed project body'])).stdout.toString('utf8'), '');
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
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nNext edit.');
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
      MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_MERGE_WITHOUT_CHECKS: 'true', MDBISYNC_GITHUB_TOKEN:'token', MDBISYNC_GITHUB_API_URL:GITHUB_API, MDBISYNC_REPOSITORY:'example/repository', MDBISYNC_REPORT_FILE:reportFile,
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
    assert.equal(await text('docs/safe.md'), 'Safe.');
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

  it('captures a title that names the Git directory by its NTFS short name under an escaped path', async () => {
    world.linear.documents.push({ id: 'hook', title: 'GIT~1/hooks/post-checkout', content: 'Hook.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' });
    const result = await run();
    assert.equal(await text('docs/%47IT~1/hooks/post-checkout.md'), 'Hook.');
    const ids = await readIds(context.git, result.state.ids);
    assert.equal(ids.get('docs/%47IT~1/hooks/post-checkout.md')?.id, 'hook');
    const paths = (await listTree(context.git, result.state.linear!)).map((entry) => entry.path);
    assert.ok(!paths.some((path) => path.split('/').some(isGitDirectoryName)), paths.join(', '));
  });

  for (const staged of [false, true]) it(`captures a title whose shortened segment would name the Git directory${staged ? ' in the stage step' : ''}, beside an ordinary document`, async () => {
    world.linear.documents.push(
      { id: 'shortened', title: SHORTENED_GIT_TITLE, content: 'Shortened.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'ordinary', title: 'ordinary', content: 'Ordinary.\n', projectId: 'project-api', createdAt: '2026-01-03T00:00:00Z' },
    );
    const path = `docs/%67it${'\u200c'.repeat(37)}~9361948027816177/note.md`;
    if (staged) {
      // The stage step checks every path it stages, as the staging gate does.
      const paths = new Set<string>();
      const result = await capture(context, { config, state: context.fetched.state, identity: IDENTITY, stageOnly: true, security: { configured: true, check: async (files) => { for (const name of files.keys()) { checkRepoPath(name); paths.add(name); } return []; } } });
      assert.ok(result.ok);
      assert.deepEqual([...paths].sort(), [path, 'docs/ordinary.md']);
      return;
    }
    const result = await run();
    assert.ok(result.ok);
    assert.equal(await text(path), 'Shortened.');
    assert.equal(await text('docs/ordinary.md'), 'Ordinary.');
    const ids = await readIds(context.git, result.state.ids);
    assert.equal(ids.get(path)?.id, 'shortened');
    const paths = (await listTree(context.git, result.state.linear!)).map((entry) => entry.path);
    assert.ok(!paths.some((name) => name.split('/').some(isGitDirectoryName)), paths.join(', '));
  });

  it('moves a document away from an earlier path that names the Git directory', async () => {
    // An earlier version kept the title `git~2/notes` (which Git accepts) as it was.
    const { git } = context;
    const state = context.fetched.state;
    const legacy = 'docs/git~2/notes.md';
    const tree = await buildTree(git, state.linear!, new Map([['docs/plan.md', null], [legacy, '---\ncategory: work\n---\n\nOriginal.\n']]));
    const env = { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email };
    const linear = await git.text(['commit-tree', '--no-gpg-sign', tree, '-p', state.linear!, '-m', 'Earlier capture'], { env });
    const ids = await commitIds(git, state.ids, new Map([[legacy, { id: 'plan' }]]), IDENTITY);
    const pushed = await pushAtomic(git, config, [
      { ref: stateRef(config, 'linear'), expected: state.linear, next: linear },
      { ref: stateRef(config, 'ids'), expected: state.ids, next: ids },
    ]);
    assert.equal(pushed.ok, true);
    await refresh();
    Object.assign(world.linear.documents[0]!, { title: 'git~2/notes', updatedAt: '2026-01-03T00:00:00Z' });
    const result = await run();
    assert.equal(await text('docs/%67it~2/notes.md'), '---\ncategory: work\n---\n\nOriginal.');
    const paths = (await listTree(git, result.state.linear!)).map((entry) => entry.path);
    assert.ok(!paths.includes(legacy), paths.join(', '));
    assert.equal((await readIds(git, result.state.ids)).get('docs/%67it~2/notes.md')?.id, 'plan');
  });

  it('moves a document away from an earlier path that names a reserved GitHub folder', async () => {
    // An earlier version kept the title `.GitHub/notes` as it was.
    const { git } = context;
    const state = context.fetched.state;
    const legacy = 'docs/.GitHub/notes.md';
    const tree = await buildTree(git, state.linear!, new Map([['docs/plan.md', null], [legacy, '---\ncategory: work\n---\n\nOriginal.\n']]));
    const env = { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email };
    const linear = await git.text(['commit-tree', '--no-gpg-sign', tree, '-p', state.linear!, '-m', 'Earlier capture'], { env });
    const ids = await commitIds(git, state.ids, new Map([[legacy, { id: 'plan' }]]), IDENTITY);
    const pushed = await pushAtomic(git, config, [
      { ref: stateRef(config, 'linear'), expected: state.linear, next: linear },
      { ref: stateRef(config, 'ids'), expected: state.ids, next: ids },
    ]);
    assert.equal(pushed.ok, true);
    await refresh();
    Object.assign(world.linear.documents[0]!, { title: '.GitHub/notes', updatedAt: '2026-01-03T00:00:00Z' });
    const result = await run();
    assert.equal(await text('docs/%2EGitHub/notes.md'), '---\ncategory: work\n---\n\nOriginal.');
    const paths = (await listTree(git, result.state.linear!)).map((entry) => entry.path);
    assert.ok(!paths.includes(legacy), paths.join(', '));
    assert.equal((await readIds(git, result.state.ids)).get('docs/%2EGitHub/notes.md')?.id, 'plan');
  });

  it('captures a new path, renames by id and moves across projects', async () => {
    world.linear.documents.push({ id: 'new', title: 'guides/new-page', content: 'New.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' });
    await run();
    assert.equal(await text('docs/guides/new-page.md'), 'New.');
    await refresh();
    Object.assign(world.linear.documents[0]!, { title: 'guides/renamed', projectId: 'project-handbook', updatedAt: '2026-01-03T00:00:00Z' });
    const result = await run();
    assert.equal(await text('other/guides/renamed.md'), '---\ncategory: work\n---\n\nOriginal.');
    const ids = await readIds(context.git, result.state.ids);
    assert.equal(ids.get('other/guides/renamed.md')?.id, 'plan');
    assert.equal(ids.has('docs/plan.md'), false);
  });

  it('never places a new document inside an assets folder, and keeps its place on the next run', async () => {
    world.linear.documents.push({ id: 'new', title: 'assets/notes', content: 'New.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z' });
    const first = await run();
    const ids = await readIds(context.git, first.state.ids);
    const path = [...ids].find(([, entry]) => entry.id === 'new')?.[0];
    assert.ok(path !== undefined && path.startsWith('docs/') && !path.split('/').includes('assets'), path);
    assert.equal(await text(path), 'New.');
    const tree = new Set((await listTree(context.git, first.state.linear!)).map((entry) => entry.path));
    assert.deepEqual(lintInTree(path, await text(path), tree), []);
    await refresh();
    const second = await run();
    assert.equal(second.state.linear, first.state.linear, 'the next run moves nothing');
  });

  it('removes trash and out-of-scope files and captures a restore', async () => {
    world.linear.documents[0]!.trashed = true;
    await run();
    assert.equal((await fixture.remote.run(['cat-file', '-e', `${stateRef(config, 'linear')}:docs/plan.md`], { okCodes: [0, 128] })).code, 128);
    await refresh();
    Object.assign(world.linear.documents[0]!, { trashed: false, updatedAt: '2026-01-04T00:00:00Z' });
    await run();
    assert.equal(await text('docs/plan.md'), 'Original.');
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
    assert.equal(await text(accepted[0]), 'Accepted body.');
    assert.deepEqual(markOf(world.linear.documents.find((doc) => doc.id === blocked.id)), MARKS.blocked);
    await refresh();
    Object.assign(blocked, {content:'Corrected body.\n',updatedAt:'2026-03-01T00:00:00Z'});
    const third = await capture(context, {config, state:context.fetched.state, security});
    const finalIds = await readIds(context.git, third.state.ids);
    assert.equal(finalIds.get('docs/duplicate.md')?.id, blocked.id);
    assert.equal(finalIds.get(accepted[0])?.id, 'a-earlier');
    assert.equal(finalIds.get('docs/duplicate.md')?.saved, undefined);
    assert.equal(await text('docs/duplicate.md'), 'Corrected body.');
  });

  it('never writes a document over a hook script that a forged reserved path names', async () => {
    // A security hook runs a script the tracked branch keeps under a mapped folder. The recorded Linear tree does not
    // hold the script, so its path looks free, and the reserved ids, which any writer of the state refs can change,
    // reserve it for a new document. Its text would replace the script before the hook runs it.
    const marker = join(fixture.root, 'hook-canary');
    await fixture.seed({
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: support-check
        alias: security
        name: Support check
        entry: node docs/scan.mjs
        language: system
`,
      'docs/scan.mjs': 'process.exitCode = 0;\n',
    });
    await refresh();
    const state = context.fetched.state;
    // A Markdown path the tracked branch does not hold is no claim either: the new document was not created from it.
    const forged = new Map([['docs/scan.mjs', 'forged'], ['docs/notes.mjs', 'forged-new'], ['docs/elsewhere.md', 'forged-markdown']]);
    const next = await commitIds(context.git, state.ids, await readIds(context.git, state.ids), IDENTITY, {reserved: forged});
    assert.equal((await pushAtomic(context.git, config, [{ref: stateRef(config, 'ids'), expected: state.ids, next}])).ok, true);
    await refresh();
    // A fixed canary: run as a hook, it writes a marker beside the gate's scratch folder, which this test keeps in its
    // own fixture folder.
    const payload = "import('node:fs').then((fs) => fs.writeFileSync('../hook-canary', 'ran'));";
    world.linear.documents.push(
      {id: 'forged', title: 'scan', projectId: 'project-api', content: payload, createdAt: '2026-01-02T00:00:00Z'},
      {id: 'forged-new', title: 'notes', projectId: 'project-api', content: payload, createdAt: '2026-01-02T00:00:00Z'},
      {id: 'forged-markdown', title: 'report', projectId: 'project-api', content: 'A report.\n', createdAt: '2026-01-02T00:00:00Z'},
    );
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = fixture.root;
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(); }
    finally { if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp; }
    await assert.rejects(readFile(marker), {code: 'ENOENT'}, 'a document never becomes hook code');
    const paths = (await listTree(context.git, result.state.linear!)).map((entry) => entry.path);
    assert.ok(!paths.includes('docs/scan.mjs') && !paths.includes('docs/notes.mjs'), 'a reserved path that is not a document path is not used');
    // The documents still come in, at the paths their titles name.
    assert.equal(await text('docs/scan.md'), payload);
    assert.equal(await text('docs/notes.md'), payload);
    assert.equal(await text('docs/report.md'), 'A report.');
    assert.ok(!paths.includes('docs/elsewhere.md'));
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
    assert.equal(await text('docs/safe.md'), 'Safe addition.');
    const ids = await readIds(context.git, rejected.state.ids);
    const decoration = ids.get('docs/plan.md')!.saved!;
    assert.equal(decoration.icon, 'Fire');
    assert.equal(decoration.color, '#123456');
    assert.equal(decoration.notice?.kind, 'blocked');
    assert.equal(decoration.notice?.posted, true);
    assert.deepEqual(markOf(world.linear.documents[0]), MARKS.blocked);
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
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\nCorrected.');
    assert.equal(world.linear.documents[0]!.icon, 'Fire');
    assert.equal(world.linear.documents[0]!.color, '#123456');
    assert.equal((await readIds(context.git, accepted.state.ids)).get('docs/plan.md')?.saved, undefined);
  });

  // Each body as Linear holds it, and as the file holds it: in the form `fix` writes (a reference
  // becomes inline), or as it is when lint leaves it to its author (an image inside a link).
  for (const [body, written] of [
    ['![Image](https://example.com/a.png)\n', '![Image](https://example.com/a.png)'],
    ['![Image](http://example.com/a.png)\n', '![Image](http://example.com/a.png)'],
    ['![Image](data:image/png;base64,AAAA)\n', '![Image](data:image/png;base64,AAAA)'],
    ['![Image](relative.png)\n', '![Image](relative.png)'],
    ['![Image](/absolute.png)\n', '![Image](/absolute.png)'],
    ['![Image]()\n', '![Image]()'],
    // `fix` would make the reference inline: another document to the sync, so Linear's text stays.
    ['![Image][picture]\n\n[picture]: https://example.com/a.png\n', '![Image][picture]\n\n[picture]: https://example.com/a.png\n'],
    ['[![Image](https://example.com/a.png)](https://example.com)\n', '[![Image](https://example.com/a.png)](https://example.com)\n'],
  ] as const) {
    it(`records the original image while preparing a checked pull repair: ${body.trim()}`, async () => {
      Object.assign(world.linear.documents[0]!, {content:body, icon:'Fire', color:'#123456'});
      const result = await capture(context, {config, state:context.fetched.state, fetch:async () => {throw new Error('Unexpected download');}});
      assert.equal(result.ok, true);
      assert.deepEqual(result.blocked, []);
      assert.deepEqual(result.leftOut, []);
      assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\n' + written);
      const entry = (await readIds(context.git, result.state.ids)).get('docs/plan.md')!;
      assert.equal(entry.pullRewrite?.images.length, 1);
      assert.equal(entry.pullRewrite?.images[0]?.line, 1);
      assert.equal(world.linear.comments.size, 0);
      assert.equal(world.linear.documents[0]!.icon, 'Fire');
    });
  }

  it('asks the hooks about a repaired text on its own when the document also brings a downloaded file', async () => {
    // The pull request step asks about the repaired text alone; in the staged steps only a set staged here gets an answer.
    world.linear.documents[0]!.content = '![New](https://uploads.linear.app/workspace/new.png)\n\n![Chart](https://example.com/chart.png)\n';
    const sets: Array<Map<string, string>> = [];
    const result = await capture(context, {config, state:context.fetched.state, fetch:async () => new Response(png, {headers:{'content-type':'image/png'}}), security: {configured:true, check:async files => {
      sets.push(new Map([...files].map(([path, content]) => [path, String(content)])));
      return [];
    }}});
    assert.equal(result.ok, true);
    const replacement = (await readIds(context.git, result.state.ids)).get('docs/plan.md')?.pullRewrite?.replacement;
    assert.ok(replacement?.includes('[Chart](<https://example.com/chart.png>)'));
    assert.ok(sets.some(set => set.size > 1 && set.get('docs/plan.md') === replacement), 'the text with its downloaded file');
    assert.ok(sets.some(set => set.size === 1 && set.get('docs/plan.md') === replacement), 'the text alone');
  });

  it('scans a removed image even when the repaired text equals the accepted file', async () => {
    world.linear.documents[0]!.content = 'Original.\n\n![Discarded](data:text/plain,rejected-canary)\n';
    let checks = 0;
    const result = await capture(context, {config, state:context.fetched.state, security: {configured:true, check:async files => {
      checks++;
      return [...files.values()].some(content => String(content).includes('rejected-canary')) ? [{hook:'secret-check',line:3}] : [];
    }}});
    assert.ok(checks > 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
  });

  it('preserves front matter containing image syntax and accepted link spelling', async () => {
    const head = '---\nowner: "![meta](https://example.com/meta.png)"\n---\n\n';
    const previous = context.fetched.state.linear!;
    const baseline = await commitTree(context.git, {parents:[previous], base:previous, changes:new Map([['docs/plan.md', head + '[Chart](<https://example.com/chart.png>)\n']]), message:'Accepted spelling', identity:IDENTITY});
    await pushAtomic(context.git, config, [{ref:stateRef(config,'linear'), expected:previous, next:baseline}]);
    await refresh();
    world.linear.documents[0]!.content = '![Chart](https://example.com/chart.png)\n';
    const result = await run();
    assert.deepEqual(result.leftOut, []);
    const entry = (await readIds(context.git, result.state.ids)).get('docs/plan.md')!;
    assert.equal(entry.pullRewrite?.replacement, head + '[Chart](<https://example.com/chart.png>)\n');
    assert.equal(await text('docs/plan.md'), head + '![Chart](https://example.com/chart.png)');
  });

  it('keeps links to an image-blocked reserved document as Linear URLs', async () => {
    // The new document was created from this file, and the answer was lost: the id stays reserved for its path.
    await fixture.seed({'docs/future.md': 'Future.\n'});
    await refresh();
    context.mapping = await loadMapping(context.git, context.fetched.tracked);
    const state = context.fetched.state;
    const reserved = new Map([['docs/future.md', 'future-document']]);
    const next = await commitIds(context.git, state.ids, await readIds(context.git, state.ids), IDENTITY, {reserved});
    assert.equal((await pushAtomic(context.git, config, [{ref:stateRef(config,'ids'), expected:state.ids, next}])).ok, true);
    await refresh();
    const url = 'https://linear.app/example-team/document/future-document';
    world.linear.documents[0]!.content = `[Future](${url})\n`;
    world.linear.documents.push({id:'future-document', title:'future', projectId:'project-api', createdAt:'2026-01-02T00:00:00Z', content:'[File](private.csv)\n'});
    const result = await run();
    assert.equal(result.blocked.length, 1);
    assert.equal(await text('docs/plan.md'), `---\ncategory: work\n---\n\n[Future](<${url}>)`);
    assert.equal((await fixture.remote.run(['cat-file','-e',`${result.state.linear}:docs/future.md`],{okCodes:[0,128]})).code, 128);
  });

  it('gives the security gate no path that starts with a dash for a title that does', async () => {
    world.linear.documents.push({id:'dash', title:'--config=x', projectId:'project-api', createdAt:'2026-01-02T00:00:00Z', content:'Dash.\n'});
    const checked: string[] = [];
    const result = await capture(context, {config, state:context.fetched.state, identity:IDENTITY,
      security:{configured:true, check:async (files) => { checked.push(...files.keys()); return []; }},
    });
    assert.equal(result.ok, true);
    assert.ok(checked.includes('docs/--config=x.md'));
    assert.ok(!checked.some((path) => path.startsWith('-')));
    assert.equal(await text('docs/--config=x.md'), 'Dash.');
    assert.equal(world.linear.documents.at(-1)!.title, '--config=x');
  });

  it('combines rejected upload and security findings without disclosing image text', async () => {
    world.linear.documents[0]!.content = '![Allowed](https://uploads.linear.app/a.png)\n\n![private alt](https://uploads.linear.app/private-destination)\n';
    const result = await capture(context, {config, state:context.fetched.state,
      fetch:async (input) => new Response(String(input).endsWith('a.png') ? png : Buffer.from('<html/>')),
      security:{configured:true, check:async () => [{hook:'secret-check', line:3}]},
    });
    assert.equal(result.blocked[0]!.findings.length, 2);
    const comments = commentsOf('plan');
    assert.equal(comments.length, 1);
    assert.match(comments[0]!, /Image 2 of 2 \(line 3\)/);
    assert.match(comments[0]!, /Hook `secret-check`, line 3/);
    assert.ok(!comments[0]!.includes('private'));
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
  });

  it('downloads a pasted image, records an LFS pointer and populates the upload cache', async () => {
    await fixture.seed({'.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n'});
    await refresh();
    const url = 'https://uploads.linear.app/workspace/pasted.png';
    Object.assign(world.linear.documents[0]!, {content: `![Image](${url})\n`, updatedAt: '2026-01-05T00:00:00Z'});
    const result = await capture(context, { config, state: context.fetched.state, identity: IDENTITY, fetch: async () => new Response(png) });
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
    if(read.ok) assert.deepEqual(read.content, png);
  });

  it('restores links between documents using the shared inverse', async () => {
    world.linear.documents.push({id: 'target', title: 'guides/target', projectId: 'project-api', content: 'Target.\n', createdAt: '2026-01-04T00:00:00Z'});
    world.linear.documents[0]!.content = '[Target](https://linear.app/example-team/document/target#intro)\n';
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\n[Target](<guides/target.md#intro>)');
  });

  for (const status of [301, 302, 307, 308, 400, 422]) {
    it(`blocks unreadable upload HTTP ${status} and clears the mark after correction, keeping its notice open`, async () => {
      const doc = world.linear.documents[0]!;
      Object.assign(doc, {content:'![Image](https://uploads.linear.app/workspace/file.png)\n', icon:'Fire', color:'#123456'});
      const captureNow = (fetch: typeof globalThis.fetch) => capture(context, {config, state:context.fetched.state, fetch});
      const blocked = await captureNow(async () => new Response('Untrusted response body', {status}));
      assert.deepEqual(blocked.leftOut, []);
      assert.deepEqual(blocked.blocked[0]?.findings, [{image:1, total:1, line:1, reason:'unreadable'}]);
      assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
      assert.match(commentsOf('plan')[0]!, /Image 1 of 1 \(line 1\): the uploaded file cannot be read\. Remove it or upload it again\./);
      assert.deepEqual(markOf(doc), MARKS.blocked);
      assert.match(blocked.summary, /blocked 1; left out 0/);
      assert.ok(!JSON.stringify(blocked).includes('Untrusted response body'));
      await refresh();
      const fixed = await captureNow(async () => new Response(png));
      assert.equal(fixed.blocked.length, 0);
      assert.equal(doc.icon, 'Fire');
      assert.equal(doc.color, '#123456');
      // The blocked notice stays open as the record of the finding.
      assert.notEqual([...world.linear.comments.values()][0]!.resolved, true);
      const tree = await listTree(context.git, fixed.state.linear!);
      const files = new Set(tree.map(({path}) => path));
      assert.deepEqual(lintInTree('docs/plan.md', await text('docs/plan.md'), files), []);
    });
  }

  it('blocks an unreadable attachment link with a file notice and recovers', async () => {
    const doc = world.linear.documents[0]!;
    Object.assign(doc, {content:'[Specification][attachment]\n\n[attachment]: https://uploads.linear.app/workspace/spec.pdf', icon:'Fire', color:'#123456'});
    const blocked = await capture(context, {config, state:context.fetched.state, fetch:async () => new Response(null, {status:404})});
    assert.deepEqual(blocked.blocked[0]?.findings, [{file:1, total:1, line:1, reason:'unreadable'}]);
    assert.deepEqual(blocked.leftOut, []);
    assert.match(commentsOf('plan')[0]!, /File 1 of 1 \(line 1\): the uploaded file cannot be read/);
    assert.deepEqual(markOf(doc), MARKS.blocked);
    await refresh();
    const fixed = await capture(context, {config, state:context.fetched.state, fetch:async () => new Response('%PDF-1.7\n')});
    assert.deepEqual(fixed.blocked, []);
    assert.equal(doc.icon, 'Fire');
    assert.notEqual([...world.linear.comments.values()][0]!.resolved, true);
  });

  for (const status of [401, 403]) {
    it(`stops capture on upload HTTP ${status} with a failing access probe, without marking any document or publishing`, async () => {
      world.linear.uploadAccessStatus = 401;
      world.linear.documents[0]!.content = '![Image](https://uploads.linear.app/workspace/file.png)';
      world.linear.documents.push({id:'aaa', title:'blocked', projectId:'project-api', content:'![External](https://example.com/file.png)', createdAt:'2026-01-04T00:00:00Z'});
      const before = context.fetched.state;
      await assert.rejects(capture(context, {config, state:before, fetch:async () => new Response(null, {status})}), (error) => error instanceof LinearHttpError && error.httpStatus === status && error.operation === 'DownloadUpload');
      await refresh();
      assert.deepEqual(context.fetched.state, before);
      assert.deepEqual(world.writes, []);
      assert.equal(world.linear.comments.size, 0);
    });
  }

  for (const failure of ['connection', 'timeout', 'stream', 429, 500, 503] as const) {
    it(`retries an older document after download ${failure} and reports why it was left out`, async () => {
      world.linear.documents[0]!.content = '![Image](https://uploads.linear.app/workspace/retry.png)\n';
      world.linear.documents.push({id:'later', title:'later', projectId:'project-api', content:'Later.\n', createdAt:'2026-01-04T00:00:00Z'});
      const first = await capture(context, {config, state:context.fetched.state, fetch:async () => {
        if (failure === 'connection') throw new TypeError('Connection unavailable');
        if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        if (failure === 'stream') return new Response(new ReadableStream({start(controller) {controller.error(new Error('Connection reset'));}}));
        return new Response(null, {status:failure});
      }});
      assert.deepEqual(first.leftOut, [{id:'plan', rule:'download-retry'}]);
      assert.deepEqual(first.blocked, []);
      assert.match(first.summary, /blocked 0; left out 1/);
      assert.match(first.summary, /download-retry: "plan"/);
      assert.equal(world.linear.comments.size, 0);
      assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
      assert.equal(await text('docs/later.md'), 'Later.');
      await refresh();
      const next = await capture(context, {config, state:context.fetched.state, fetch:async () => new Response(png)});
      assert.equal(next.leftOut.length, 0);
      assert.ok(next.changed.includes('docs/plan.md'));
    });
  }

  it('blocks oversized uploads with the size notice', async () => {
    world.linear.documents[0]!.content = '![Image](https://uploads.linear.app/workspace/large.png)';
    const result = await capture(context, {config, state:context.fetched.state, fetch:async () => new Response(png, {headers:{'content-length':String(10 * 1024 * 1024 + 1)}})});
    assert.deepEqual(result.blocked[0]?.findings, [{image:1, total:1, line:1, reason:'too-large'}]);
    assert.match(commentsOf('plan')[0]!, /the uploaded file is larger than 10 MB\./);
    assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
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
    assert.equal(await text('docs/renamed.md'), 'Target.');
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
    assert.deepEqual(markOf(doc), MARKS.blocked);
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

  it('counts the refs a capture published also when Linear stopped it while it marked the document', async () => {
    const doc = world.linear.documents[0]!;
    doc.content = `${MARKERS.git}\n\nFirst.\n\n${MARKERS.linear}\n\nSecond.\n\n${MARKERS.end}\n`;
    const moved = movedRefs(context.git);
    const wrote = new Map(context.linear.stats.writes);
    // The mark is the first Linear write, after the push: Linear stops the client there.
    world.linear.writes.rateLimitAt = world.linear.writes.count + 1;
    const stopped = await run();
    assert.equal(stopped.ok, false);
    assert.equal(stopped.code, 'stopped');
    assert.deepEqual(stopped.changed, ['docs/plan.md']);
    assert.notEqual(doc.icon, 'Alert', 'the mark was refused');
    assert.equal((movedRefs(context.git).get('linear') ?? 0) - (moved.get('linear') ?? 0), 1, 'the published capture is counted');
    assert.deepEqual(context.linear.stats.writes, wrote, 'the refused mark is not counted');
  });

  describe('a title the security hooks refuse', () => {
    // Hooks that read file content only, as secret scanners do: a title must reach them as text.
    const TOKEN = ['title', 'canary', '5307'].join('-');
    const gate = {configured: true, check: async (files: ReadonlyMap<string, FileContent>) => [...files.values()].some((content) => contentBytes(content).toString('utf8').includes(TOKEN)) ? [{hook: 'secret-check', line: 1}] : []};
    const captureGated = () => capture(context, {config, state: context.fetched.state, identity: IDENTITY, security: gate});
    /** Nothing pushed (paths, ids, messages, blobs) and nothing in the run's report holds the token. */
    const assertNoToken = async (result: Awaited<ReturnType<typeof capture>>) => {
      assert.ok(!(await fixture.remote.text(['cat-file', '--batch-all-objects', '--batch'])).includes(TOKEN), 'the title reached the remote');
      const report = JSON.stringify({summary: result.summary, changed: result.changed, removed: result.removed, blocked: result.blocked, leftOut: result.leftOut, warnings: result.writeBackWarnings});
      assert.ok(!report.includes(TOKEN), report);
    };

    for (const body of ['clean', 'rejected'] as const) it(`blocks a new document under a name made from its id, with a ${body} body`, async () => {
      world.linear.documents.push(
        {id: 'titled', title: `Keys ${TOKEN}`, content: body === 'clean' ? 'Clean.\n' : `Body ${TOKEN}.\n`, projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z'},
        {id: 'ordinary', title: 'ordinary', content: 'Ordinary.\n', projectId: 'project-api', createdAt: '2026-01-03T00:00:00Z'},
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await captureGated();
        assert.equal(result.ok, true);
        assert.deepEqual(result.blocked, [{id: 'titled', path: 'docs/titled.md', findings: [{hook: 'secret-check', line: 0}]}]);
        const ids = await readIds(context.git, result.state.ids);
        assert.equal(ids.get('docs/titled.md')?.id, 'titled');
        assert.equal(ids.get('docs/ordinary.md')?.id, 'ordinary', 'a clean title keeps its path');
        assert.equal(await text('docs/ordinary.md'), 'Ordinary.');
        await assertNoToken(result);
        await refresh();
      }
      assert.deepEqual(markOf(world.linear.documents.find(({id}) => id === 'titled')), MARKS.blocked);
      assert.match(commentsOf('titled').join('\n'), /Hook `secret-check`, in the title\./);
      // Renamed to a title the hooks pass, it takes the title's path.
      Object.assign(world.linear.documents.find(({id}) => id === 'titled')!, {title: 'keys', content: 'Clean.\n', updatedAt: '2026-01-05T00:00:00Z'});
      const accepted = await captureGated();
      assert.deepEqual(accepted.blocked, []);
      assert.equal(await text('docs/keys.md'), 'Clean.\n');
      const ids = await readIds(context.git, accepted.state.ids);
      assert.equal(ids.get('docs/keys.md')?.id, 'titled');
      assert.equal(ids.has('docs/titled.md'), false);
    });

    it('moves a document an earlier run recorded under its title, without a file, to the name made from its id', async () => {
      world.linear.documents.push({id: 'titled', title: `Keys ${TOKEN}`, content: 'Clean.\n', projectId: 'project-api', createdAt: '2026-01-02T00:00:00Z'});
      // As an earlier release recorded a document whose text the hooks refused: under its title's path, with no file.
      const state = context.fetched.state;
      const recorded = await readIds(context.git, state.ids);
      recorded.set(`docs/Keys ${TOKEN}.md`, {id: 'titled', saved: {icon: null, color: null}});
      const next = await commitIds(context.git, state.ids, recorded, IDENTITY);
      assert.equal((await pushAtomic(context.git, config, [{ref: stateRef(config, 'ids'), expected: state.ids, next}])).ok, true);
      await refresh();
      const result = await captureGated();
      assert.deepEqual(result.blocked.map(({id, path}) => ({id, path})), [{id: 'titled', path: 'docs/titled.md'}]);
      const ids = await readIds(context.git, result.state.ids);
      assert.equal(ids.get('docs/titled.md')?.id, 'titled');
      assert.ok(![...ids.keys()].some((path) => path.includes(TOKEN)), [...ids.keys()].join(', '));
    });

    it('keeps a renamed document at its accepted path', async () => {
      Object.assign(world.linear.documents[0]!, {title: `plan ${TOKEN}`, content: 'Edited.\n', updatedAt: '2026-01-05T00:00:00Z'});
      const result = await captureGated();
      assert.equal(result.ok, true);
      assert.deepEqual(result.blocked, [{id: 'plan', path: 'docs/plan.md', findings: [{hook: 'secret-check', line: 0}]}]);
      assert.equal(await text('docs/plan.md'), TREE['docs/plan.md']);
      assert.equal((await readIds(context.git, result.state.ids)).get('docs/plan.md')?.id, 'plan');
      await assertNoToken(result);
    });
  });

  it('counts the first marking of a blocked document and no write while it stays blocked', async () => {
    const gate = {configured: true, check: async () => [{hook:'secret-check', line:5}]};
    world.linear.documents[0]!.content = 'Rejected.\n';
    const first = await capture(context, {config, state: context.fetched.state, security: gate});
    assert.deepEqual(first.blocked.map(({id}) => id), ['plan']);
    assert.deepEqual(markOf(world.linear.documents[0]), MARKS.blocked);
    assert.deepEqual(Object.fromEntries(context.linear.stats.writes), {CommentOnDocument: 1, UpdateDocument: 1});
    await refresh();
    const moved = movedRefs(context.git);
    const wrote = new Map(context.linear.stats.writes);
    const again = await capture(context, {config, state: context.fetched.state, security: gate});
    assert.deepEqual(again.blocked.map(({id}) => id), ['plan']);
    assert.deepEqual(movedRefs(context.git), moved, 'no ref moves');
    assert.deepEqual(context.linear.stats.writes, wrote, 'no Linear write');
  });

  it('retries a security comment after its post-push delivery fails', async () => {
    const gate = {configured: true, check: async () => [{hook:'secret-check', line:5}]};
    world.linear.documents[0]!.content = 'Rejected.\n';
    world.linear.writes.reject = (operation) => operation === 'CommentOnDocument';
    await assert.rejects(capture(context, {config, state: context.fetched.state, security: gate}));
    assert.deepEqual(markOf(world.linear.documents[0]), MARKS.blocked);
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
    assert.equal(await text(path), 'Team document.');
  });

  it('preserves prior document-link spellings and leaves URLs to blocked new targets usable', async () => {
    const target = {id:'target', title:'target', projectId:'project-api', content:'Target.\n', createdAt:'2026-01-04T00:00:00Z'};
    world.linear.documents.push(target);
    world.linear.documents[0]!.content = '[Target](https://linear.app/example-team/document/target)\n';
    await run();
    await refresh();
    const raw = '---\ncategory: work\n---\n\n[Target](<./target.md>)';
    const record = await commitTree(context.git, {parents:[context.fetched.state.linear!], base:context.fetched.state.linear, changes:new Map([['docs/plan.md',raw]]), message:'Keep link spelling', identity:IDENTITY});
    assert.equal((await pushAtomic(context.git,config,[{ref:stateRef(config,'linear'),expected:context.fetched.state.linear,next:record}])).ok,true);
    await refresh();
    Object.assign(world.linear.documents[0]!, {content:'[Target](https://linear.app/example-team/document/target)\n\nEdited.\n', updatedAt:'2026-01-06T00:00:00Z'});
    await run();
    assert.ok((await text('docs/plan.md')).includes('[Target](<./target.md>)'));
    await refresh();
    world.linear.documents.push({id:'blocked-new',title:'blocked-new',projectId:'project-api',content:'Rejected.\n',createdAt:'2026-01-07T00:00:00Z'});
    Object.assign(world.linear.documents[0]!, {content:'[New](https://linear.app/example-team/document/blocked-new)\n',updatedAt:'2026-01-07T00:00:00Z'});
    const result = await capture(context,{config, state: context.fetched.state,security:{configured:true,check:async(files)=>files.has('docs/blocked-new.md')?[{hook:'secret-check',line:1}]:[]}});
    assert.equal(result.blocked.length,1);
    assert.equal(await text('docs/plan.md'), '---\ncategory: work\n---\n\n[New](<https://linear.app/example-team/document/blocked-new>)');
    assert.equal((await fixture.remote.run(['cat-file','-e',`${stateRef(config,'linear')}:docs/blocked-new.md`],{okCodes:[0,128]})).code,128);
  });

  /** Hooks that refuse the document's text, not the check of its title (the title alone, at the same path). */
  const refusesBody = (files: ReadonlyMap<string, FileContent>, id: string) => {
    const content = files.get(`docs/${id}.md`);
    return content !== undefined && contentBytes(content).toString('utf8') !== `${id}\n`;
  };

  it('stages a bounded number of texts for densely linked documents and records those that link a refused one', async () => {
    const count = 16;
    const ids = Array.from({ length: count }, (_, i) => `dense-${String(i).padStart(2, '0')}`);
    for (const [i, id] of ids.entries()) {
      // In Linear's own form: link destinations in angle brackets, no final newline.
      const content = ids.filter((other) => other !== id).map((other) => `[${other}](<https://linear.app/example-team/document/${other}>)`).join('\n');
      world.linear.documents.push({ id, title: id, projectId: 'project-api', content, createdAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}Z` });
    }
    const staged = new Set<string>();
    await capture(context, { config, state: context.fetched.state, identity: IDENTITY, stageOnly: true, security: { configured: true, check: async (files) => { staged.add(candidateKey(files)); return []; } } });
    // A title and a set for each new document, and at most a bounded number of texts with refused targets for each.
    assert.ok(staged.size <= 2 * count + 1 + count * (LINK_VARIANT_LINKS + 1), `${staged.size} sets staged`);
    // The apply step answers only what was staged; the hooks refuse one document that all the others link.
    const refused = ids[0]!;
    const result = await capture(context, {
      config,
      state: context.fetched.state,
      identity: IDENTITY,
      security: { configured: true, check: async (files) => (!staged.has(candidateKey(files)) ? null : refusesBody(files, refused) ? [{ hook: 'secret-check', line: 1 }] : []) },
    });
    assert.deepEqual(result.blocked.map(({ id }) => id), [refused]);
    assert.deepEqual(result.leftOut, []);
    for (const id of ids.slice(1)) assert.ok((await text(`docs/${id}.md`)).includes(`(<https://linear.app/example-team/document/${refused}>)`), id);
  });

  it('records the densely linked documents on the next run when the hooks refuse one past those staged alone', async () => {
    const count = 16;
    const ids = Array.from({ length: count }, (_, i) => `dense-${String(i).padStart(2, '0')}`);
    for (const [i, id] of ids.entries()) {
      // In Linear's own form: link destinations in angle brackets, no final newline.
      const content = ids.filter((other) => other !== id).map((other) => `[${other}](<https://linear.app/example-team/document/${other}>)`).join('\n');
      world.linear.documents.push({ id, title: id, projectId: 'project-api', content, createdAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}Z` });
    }
    // The last document: past the targets the first documents stage alone.
    const refused = ids[count - 1]!;
    const stagedRun = async () => {
      const staged = new Set<string>();
      await capture(context, { config, state: context.fetched.state, identity: IDENTITY, stageOnly: true, security: { configured: true, check: async (files) => { staged.add(candidateKey(files)); return []; } } });
      const result = await capture(context, {
        config,
        state: context.fetched.state,
        identity: IDENTITY,
        security: { configured: true, check: async (files) => (!staged.has(candidateKey(files)) ? null : refusesBody(files, refused) ? [{ hook: 'secret-check', line: 1 }] : []) },
      });
      await refresh();
      return result;
    };
    const first = await stagedRun();
    assert.deepEqual(first.blocked.map(({ id }) => id), [refused]);
    // Nothing unchecked is recorded: what had no answer waits.
    assert.ok(first.leftOut.length > 0 && first.leftOut.every(({ rule }) => rule === 'security-unchecked'), JSON.stringify(first.leftOut));
    const second = await stagedRun();
    assert.deepEqual(second.blocked.map(({ id }) => id), [refused]);
    assert.deepEqual(second.leftOut, []);
    for (const id of ids.slice(0, -1)) assert.ok((await text(`docs/${id}.md`)).includes(`(<https://linear.app/example-team/document/${refused}>)`), id);
  });

  it('scans original upload URLs before their query can enter the cache ref', async () => {
    const secret = ['query','canary','731'].join('-');
    const url = `https://uploads.linear.app/workspace/image.png?access=${secret}`;
    world.linear.documents[0]!.content = `![Image](${url})\n`;
    const result = await capture(context,{config, state: context.fetched.state,fetch:async()=>new Response(png),security:{configured:true,check:async(files)=>[...files.values()].some((value)=>String(value).includes(secret))?[{hook:'secret-check',line:5}]:[]}});
    assert.equal(result.blocked.length,1);
    assert.equal(await text('docs/plan.md'),TREE['docs/plan.md']);
    const remoteObjects = await fixture.remote.text(['cat-file','--batch-all-objects','--batch']);
    assert.ok(!remoteObjects.includes(secret));
  });

  it('scans upload URLs as the cache stores them, after their escapes are decoded', async () => {
    const secret = ['query','canary','262'].join('-');
    // Linear's text spells the value with a character reference: only the decoded URL holds it.
    const url = `https://uploads.linear.app/workspace/image.png?access=${secret.replace('canary','c&#x61;nary')}`;
    world.linear.documents[0]!.content = `![Image](${url})\n`;
    const result = await capture(context,{config, state: context.fetched.state,fetch:async()=>new Response(png),security:{configured:true,check:async(files)=>[...files.values()].some((value)=>String(value).includes(secret))?[{hook:'secret-check',line:5}]:[]}});
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
  // The NTFS short names of `.git` are escaped like `.git` itself.
  for (const title of ['GIT~1/hooks/post-checkout', 'git~1/config', 'Git~2/hooks/x', 'git~1. /x', '.git. /x', 'git~1:x/y']) {
    const path = documentPath('docs', title, 'one', new Set());
    assert.ok(!path.split('/').some(isGitDirectoryName), path);
    checkRepoPath(path);
  }
  for (const folder of ['', 'docs', 'docs/nested']) {
    for (const title of ['.github/x', '.GitHub/workflows/notes', 'nested/.GITHUB/page']) {
      const raw = `${folder === '' ? '' : `${folder}/`}${title}.md`;
      const path = documentPath(folder, title, 'one', new Set());
      assert.equal(documentPath(folder, title, 'one', new Set(), raw), raw, 'an existing Git-authored path is preserved');
      assert.ok(!path.split('/').some((part) => part.toLowerCase() === '.github'), path);
      assert.equal(documentPath(folder, title, 'one', new Set(), path), path);
    }
  }
  // A title never places its document inside an `assets` folder below the annotated folder.
  for (const title of ['assets/notes', 'guides/assets/notes']) {
    const path = documentPath('docs', title, 'one', new Set());
    assert.ok(path.startsWith('docs/') && !path.slice('docs/'.length).split('/').slice(0, -1).includes('assets'), path);
    assert.equal(documentPath('docs', title, 'one', new Set(), path), path, 'the flattened place is kept');
  }
  assert.equal(documentPath('docs', 'Assets/notes', 'one', new Set()), 'docs/Assets/notes.md');
  assert.equal(documentPath('team/assets', 'notes', 'one', new Set()), 'team/assets/notes.md', 'an annotated folder is not renamed');
  assert.equal(titlePath('.github'), '%2Egithub');
  assert.equal(titlePath('.github./x'), '.github%2E/x');
  assert.equal(titlePath('.github-notes/x'), '.github-notes/x');
  assert.equal(titlePath('GIT~1/hooks'), '%47IT~1/hooks');
  // A segment shortened for its length is checked again: the shortened name would name the Git directory.
  assert.ok(isGitDirectoryName(`git${'\u200c'.repeat(37)}~9361948027816177`), 'the test title shortens to a Git directory name');
  assert.equal(titlePath(SHORTENED_GIT_TITLE), `%67it${'\u200c'.repeat(37)}~9361948027816177/note`);
  const first = documentPath('docs', SHORTENED_GIT_TITLE, 'one', new Set());
  const taken = documentPath('docs', SHORTENED_GIT_TITLE, 'one', new Set([first]));
  assert.notEqual(taken, first);
  // A title flattened next to a file is shortened as a whole and checked again too: its hash starts with digits only.
  const flattened = `git${'\u200c'.repeat(37)}/${'y'.repeat(80)}304`;
  const beside = documentPath('docs', flattened, 'one', new Set(['docs/git' + '\u200c'.repeat(37)]));
  assert.equal(beside, `docs/%67it${'\u200c'.repeat(37)}~9789717049867131~${createHash('sha256').update('one').digest('hex').slice(0, 12)}.md`);
  for (const path of [first, taken, beside]) {
    assert.ok(!path.split('/').some(isGitDirectoryName), path);
    checkRepoPath(path);
  }
  assert.equal(titlePath('git~1x/page'), 'git~1x/page');
  // Names that were already safe keep the file name they had.
  assert.equal(titlePath('.git./x'), '.git%2E/x');
  assert.equal(titlePath('git~1 /x'), 'git~1%20/x');
  // A git-originated file name that names the Git directory is not kept.
  assert.equal(documentPath('docs', 'git~2/notes', 'one', new Set(), 'docs/git~2/notes.md'), 'docs/%67it~2/notes.md');
  assert.equal(documentPath('docs', '100% done', 'one', new Set(), 'docs/100% done.md'), 'docs/100% done.md');
  // A path at the repository root never starts with `-`, which tools read as an option.
  assert.equal(documentPath('', '--config=x', 'one', new Set()), '%2D-config=x.md');
  assert.equal(documentPath('', '-c/-d', 'one', new Set()), '%2Dc/-d.md');
  assert.equal(documentPath('', 'a-b', 'one', new Set()), 'a-b.md');
  // Such a file at the root moves to the encoded name, however it was named before.
  assert.equal(documentPath('', '-x', 'one', new Set(), '-x.md'), '%2Dx.md');
  const rootCollision = documentPath('', '-x', 'one', new Set(['%2Dx.md']));
  assert.match(rootCollision, /^%2Dx~[0-9a-f]{12}\.md$/);
  assert.equal(documentPath('', '-x', 'one', new Set(['%2Dx.md']), rootCollision), rootCollision);
  assert.equal(documentPath('', '-x', 'one', new Set(['%2Dx.md']), `-${rootCollision.slice(3)}`), rootCollision);
  // Below a folder a leading dash is no option: names, also those from before, stay as they are.
  assert.equal(documentPath('docs', '-x', 'one', new Set()), 'docs/-x.md');
  assert.equal(documentPath('docs', '-Q3: plan', 'one', new Set(), 'docs/-Q3%3A plan.md'), 'docs/-Q3%3A plan.md');
  const folderCollision = documentPath('docs', '-x', 'one', new Set(['docs/-x.md']));
  assert.equal(documentPath('docs', '-x', 'one', new Set(['docs/-x.md']), folderCollision), folderCollision);
  assert.equal(documentPath('-notes', '-x', 'one', new Set()), '-notes/-x.md');
  const occupied = new Set(['docs/plan.md']);
  const collision = documentPath('docs', 'plan', 'two', occupied);
  assert.notEqual(collision, 'docs/plan.md');
  assert.equal(documentPath('docs', 'plan', 'two', new Set(), collision), collision);
  assert.equal(documentPath('docs', 'plan', 'two', occupied), documentPath('docs', 'plan', 'two', occupied));
});

it('stores the whole content in LFS whatever file the working copy holds at its path', async () => {
  const fixture = await createFixture();
  try {
    const picture = Buffer.concat([png, Buffer.alloc(4096, 7)]);
    await fixture.seed({ 'docs/picture.png': picture }, { lfs: ['*.png'] });
    // A checkout without LFS content: the path holds the picture's small pointer file.
    const git = await fixture.clone('checkout');
    await git.run(['reset', '--quiet', '--hard', 'origin/main']);
    const tracked = await git.text(['rev-parse', 'HEAD']);
    const onDisk = await readFile(join(git.dir, 'docs/picture.png'));
    assert.ok(onDisk.length < 1024);
    const sha = createHash('sha256').update(picture).digest('hex');
    // A pointer to another object, and an empty file.
    const other = 'b'.repeat(64);
    const kept = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${other}\nsize 12\n`);
    const prepared = await prepareLfs(git, tracked, new Map([['docs/picture.png', picture], ['docs/kept.png', kept], ['docs/empty.png', Buffer.alloc(0)]]));
    assert.equal(String(prepared.changes.get('docs/picture.png')), `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${picture.length}\n`);
    // Content that already is a pointer, or is empty, is stored as it is; only pointers name objects.
    assert.deepEqual(prepared.changes.get('docs/kept.png'), kept);
    assert.deepEqual(prepared.changes.get('docs/empty.png'), Buffer.alloc(0));
    assert.deepEqual(prepared.oids.sort(), [other, sha].sort());
  } finally {
    await fixture.cleanup();
  }
});

describe('staged texts with rejected link targets', () => {
  /** Documents where `links(i)` lists the documents document `i` links, and a text function that counts its work. */
  const corpus = (count: number, links: (index: number) => number[], pad: (index: number) => number = () => 0) => {
    const paths = Array.from({ length: count }, (_, i) => `docs/d${String(i).padStart(3, '0')}.md`);
    const documentIds = new Map(paths.map((path, i) => [path, `d${String(i).padStart(3, '0')}`]));
    const candidates = new Map(paths.map((path, i) => [documentIds.get(path)!, { index: i, path, files: new Map<string, FileContent>() }]));
    const work = { texts: 0, characters: 0, resets: 0 };
    const textOf = (candidate: { index: number }, targets: ReadonlyMap<string, string>) => {
      const text = links(candidate.index).map((i) => (targets.has(paths[i]!) ? `[d](./d${i}.md)` : `[d](https://linear.app/team/document/d${i})`)).join('\n') + '\n' + 'x'.repeat(pad(candidate.index));
      work.texts += 1;
      work.characters += text.length;
      return text;
    };
    for (const candidate of candidates.values()) candidate.files.set(candidate.path, textOf(candidate, documentIds));
    work.texts = 0;
    work.characters = 0;
    // Every entry of the targets and every rejected id it visits counts.
    const reset = (rejected: ReadonlySet<string>, targets: Map<string, string>) => {
      work.resets += targets.size + rejected.size;
      for (const [path, target] of targets) if (rejected.has(target)) targets.delete(path);
    };
    type Options = Parameters<typeof linkVariants<{ index: number; path: string; files: Map<string, FileContent> }>>[4];
    return { variants: (options: Options = {}) => linkVariants(candidates, textOf, reset, documentIds, options), work };
  };
  const dense = (count: number) => corpus(count, (index) => Array.from({ length: count }, (_, i) => i).filter((i) => i !== index));
  const unlimited = () => ({ sets: Number.MAX_SAFE_INTEGER, work: Number.MAX_SAFE_INTEGER });
  /** The targets a staged text of document `index` has rejected. */
  /** The documents a text links by their Linear URL (its fallback links), read from the parsed link destinations. */
  const fallbacks = (text: string) =>
    [...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(([, destination]) => (URL.canParse(destination!) ? new URL(destination!) : null))
      .filter((url) => url !== null && url.protocol === 'https:' && url.hostname === 'linear.app' && /^\/team\/document\/d\d+$/.test(url.pathname))
      .map((url) => Number(url!.pathname.slice('/team/document/d'.length)));
  /** The targets a staged text has rejected. */
  const rejectedIn = (set: Map<string, FileContent>) => fallbacks(String([...set.values()][0]));

  it('stages every combination of a few rejected targets, and nothing for a text without links', () => {
    const { variants } = corpus(5, (index) => (index === 0 ? [1, 2, 3] : []));
    const texts = [...variants()].map((set) => String(set.get('docs/d000.md')));
    // Each of the 7 non-empty sets of rejected targets gives its own text.
    assert.equal(new Set(texts).size, 7);
    assert.equal(texts.length, 7);
    assert.ok(texts.every((text) => fallbacks(text).length > 0));
  });

  it('stages each link alone and all together for a text with more targets', () => {
    const { variants } = corpus(8, (index) => (index === 0 ? [1, 2, 3, 4, 5, 6] : []));
    const texts = [...variants()].map((set) => String(set.get('docs/d000.md')));
    assert.equal(texts.length, 7);
    assert.equal(texts.filter((text) => fallbacks(text).length === 1).length, 6);
    assert.ok(texts.some((text) => !text.includes('./d')));
  });

  it('grows linearly with densely linked documents, makes sets one at a time and stops at its budget', () => {
    const counts = [40, 80].map((count) => {
      const { variants, work } = dense(count);
      const sets = variants({ budget: unlimited() });
      sets.next();
      // The first set is written before the texts of the other documents.
      assert.ok(work.texts <= 4 * LINK_VARIANT_LINKS + 2 * Math.log2(count) + 2, `${work.texts} texts for the first set`);
      const made = 1 + [...sets].length;
      assert.ok(made <= count * (LINK_VARIANT_LINKS + 1), `${made} sets for ${count} documents`);
      return work;
    });
    // Each document costs a bounded number of texts: twice the documents, about twice the work, not four times.
    assert.ok(counts[1]!.texts <= 2.2 * counts[0]!.texts, `texts ${counts.map(({ texts }) => texts).join(' -> ')}`);
    // The default budget caps the sets of a larger corpus, and says so.
    const budget = linkVariantBudget();
    assert.equal([...dense(80).variants({ budget })].length, linkVariantBudget().sets);
    assert.equal(budget.short, true);
  });

  it('spends no more than its budget of sets and work, resets included, and goes on with smaller texts', () => {
    const budget = { sets: 5, work: Number.MAX_SAFE_INTEGER };
    assert.equal([...dense(30).variants({ budget })].length, 5);
    assert.equal(budget.sets, 0);
    const worked = dense(30);
    const limited: LinkVariantBudget = { sets: Number.MAX_SAFE_INTEGER, work: 20_000 };
    const made = [...worked.variants({ budget: limited })].length;
    assert.ok(made > 0 && made < 30 * (LINK_VARIANT_LINKS + 1), `${made} sets`);
    assert.equal(limited.short, true);
    // The work is spent before each text: the characters written and the targets reset stay within it.
    assert.ok(worked.work.characters + worked.work.resets <= 20_000, `${worked.work.characters} characters, ${worked.work.resets} resets`);
    // A large text the budget cannot pay for is passed over; a smaller one after it is still staged.
    const sizes = corpus(4, (index) => (index === 0 ? Array(200).fill(1) : index === 2 ? [3] : []));
    const left = { sets: Number.MAX_SAFE_INTEGER, work: 200 };
    assert.deepEqual([...sizes.variants({ budget: left })].map((set) => [...set.keys()][0]), ['docs/d002.md']);
  });

  it('stages the texts with targets refused before first, also past the targets staged alone', () => {
    const { variants } = dense(30);
    const sets = [...variants({ refused: new Set(['d029']), budget: { sets: 29, work: Number.MAX_SAFE_INTEGER } })];
    // The whole budget goes to each document's text with only the refused target rejected.
    assert.equal(sets.length, 29);
    assert.ok(sets.every((set) => rejectedIn(set).join() === '29'), JSON.stringify(sets.map(rejectedIn)));
  });

  it('gives the documents that link refused ones their text before the refused documents use up the budget', () => {
    // Thirty documents the hooks keep refusing link each other; after them come documents that link only the first.
    const refusedCount = 30;
    const links = (later: number) => (index: number) => (index < refusedCount ? Array.from({ length: refusedCount }, (_, i) => i).filter((i) => i !== index) : [0]);
    const refused = new Set(Array.from({ length: refusedCount }, (_, i) => `d${String(i).padStart(3, '0')}`));
    const stagedFor = (sets: Iterable<Map<string, FileContent>>) => [...sets].filter((set) => Number([...set.keys()][0]!.slice('docs/d'.length, -'.md'.length)) >= refusedCount);
    // One later document: it gets its text with the first one rejected.
    const one = stagedFor(corpus(refusedCount + 1, links(1)).variants({ refused }));
    assert.deepEqual(one.map(rejectedIn), [[0]]);
    // More later documents than the budget holds: as many as it holds now, and the rest once those are recorded.
    const later = 300;
    const first = stagedFor(corpus(refusedCount + later, links(later)).variants({ refused }));
    assert.equal(first.length, linkVariantBudget().sets);
    const recorded = new Set(first.map((set) => [...set.keys()][0]));
    const next = stagedFor(corpus(refusedCount + later, links(later)).variants({ refused, settled: (candidate, text) => recorded.has(candidate.path) && rejectedIn(new Map([[candidate.path, text]])).join() === '0' }));
    assert.equal(next.length, later - linkVariantBudget().sets);
    assert.ok(next.every((set) => !recorded.has([...set.keys()][0])));
  });

  it('spends no work on texts it cannot stage, so a later document reaches its text while the cursor holds', () => {
    // The first document is refused. Before the one that links it come large documents: half of them link nothing,
    // half link the refused one and already hold their text with it rejected. Together they cost more than the budget,
    // and the later document is as large as they are.
    const large = 50;
    const links = (index: number) => (index > large / 2 ? [0] : []);
    const pad = (index: number) => (index >= 1 ? 30_000 : 0);
    const { variants } = corpus(large + 2, links, pad);
    const settled = (candidate: { index: number; path: string }, text: string) => candidate.index <= large && rejectedIn(new Map([[candidate.path, text]])).join() === '0';
    const budget: LinkVariantBudget = { sets: Number.MAX_SAFE_INTEGER, work: 1_000_000 };
    const sets = [...variants({ refused: new Set(['d000']), settled, budget })];
    assert.deepEqual(sets.map((set) => [[...set.keys()][0], rejectedIn(set)]), [['docs/d051.md', [0]]]);
  });

  it('does not stage a text the file already holds', () => {
    const { variants } = dense(10);
    const all = [...variants({ budget: unlimited() })];
    const settled = new Set(all.slice(0, 5).map((set) => String([...set.values()][0])));
    const rest = [...dense(10).variants({ budget: unlimited(), settled: (_, text) => settled.has(text) })];
    assert.equal(rest.length, all.length - 5);
  });
});
