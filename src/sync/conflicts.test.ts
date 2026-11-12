// Conflicts through the whole sync cycle (level L3), against a local git
// remote and a fake GitHub and Linear: git and Linear change one document in
// the same run. Different paragraphs merge; the same paragraph becomes the
// three conflict marker paragraphs in Linear and, through the sync pull
// request, on the tracked branch; the document shows the conflict mark until
// either side removes the markers. Deletes and renames against edits follow
// the structural rules.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { assertWritesMatchWorld, markWorld } from '../run/test-helpers.ts';
import { detectConflicts, MARKERS, RETITLED_COMMENT } from '../merge/index.ts';
import { type RunReport } from '../run/finish.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, createFixture } from '../state/test-helpers.ts';
import { CONFLICT_COMMENT, MARKS } from './marks.ts';
import { stableId } from './stable-id.ts';

const CANARY = 'kx-5e1f0a93';
const NOTES = 'eng/notes';
const DOC = `${NOTES}/plan.md`;
const PLAN = `# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph. ${CANARY}\n`;

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const TREE: Record<string, string> = {
  '.pre-commit-config.yaml': PRE_COMMIT,
  'README.md': `# Repository\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  [DOC]: PLAN,
  'eng/notes/other.md': `# Other\n\nUntouched. ${CANARY}\n`,
  'eng/notes/table.md': `# Table\n\n| Name | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |\n| three | 3 |\n\nAfter. ${CANARY}\n`,
  'eng/notes/fence.md': `# Fence\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n\`\`\`\n\nAfter. ${CANARY}\n`,
  'eng/notes/mermaid.md': `# Diagram\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n  B --> C\n\`\`\`\n\nAfter. ${CANARY}\n`,
  'eng/notes/ordered.md': `# Steps\n\n1. First\n2. Second\n3. Third\n\nAfter. ${CANARY}\n`,
  'eng/notes/nested.md': `# Tree\n\n- Top\n  - Child one\n  - Child two\n- Other\n\nAfter. ${CANARY}\n`,
  'eng/notes/bullets.md': `# Items\n\n- apples\n- pears\n- plums\n\nAfter. ${CANARY}\n`,
  'eng/notes/lookalike.md': `# Lookalike\n\nThe markers look like this:\n\n\`\`\`md\n${MARKERS.git}\n\nmine\n\n${MARKERS.linear}\n\ntheirs\n\n${MARKERS.end}\n\`\`\`\n\nAnd inline: \`${MARKERS.git}\`.\n\n> ${MARKERS.end}\n\nPlain text. ${CANARY}\n`,
  'eng/notes/front.md': `---\nowner: example\n---\n\n# Front\n\nOne paragraph. ${CANARY}\n`,
  'eng/notes/gallery.md': `# Gallery\n\nIntro.\n\nOutro. ${CANARY}\n`,
};

const SYNC_BRANCH = 'refs/heads/mdbisync/linear';

describe('sync: conflicts through the cycle (L3)', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  /** Commits the scenarios made on the tracked branch themselves (I3). */
  let own: Set<string>;
  let start: string;
  let syncValues: string[];
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    world = fakeWorld();
    world.github.checks = new Map();
    world.github.merge = mergeOnRemote;
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    start = await rev('refs/heads/main');
    own = new Set();
    syncValues = [];
  });
  afterEach(() => fixture.cleanup());

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: reportFile(),
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const writesBefore = world.writes.length;
    const mark = await markWorld(world, fixture);
    const result = await runCli([command], { env: env(extra), cwd, fetch: fakeFetch(world) });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    const texts = [result.stdout, result.stderr, summary, JSON.stringify(report), ...world.github.pullRequests.map((pr) => `${pr.title}\n${pr.body}`)];
    for (const text of texts) assert.ok(!text.includes(CANARY), 'content reached the output or a pull request (I5)');
    await assertWritesMatchWorld(world, fixture, mark, report.writes, { faults: false });
    return { result, report, summary, writes: world.writes.slice(writesBefore) };
  }

  async function sync(extra: Record<string, string> = {}) {
    const run = await cli('sync', extra);
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    const head = await fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], { okCodes: [0, 1] });
    if (head.code === 0) {
      const value = head.stdout.toString('utf8').trim();
      const previous = syncValues.at(-1);
      if (previous !== undefined && previous !== value) {
        const forward = await fixture.remote.run(['merge-base', '--is-ancestor', previous, value], { okCodes: [0, 1] });
        assert.equal(forward.code, 0, 'the sync branch was force-pushed (I4)');
      }
      syncValues.push(value);
    }
    await assertTrackedHistory();
    return run;
  }

  /** Runs until a run changes nothing and no sync pull request is open: both sides then hold the same text. */
  async function settle() {
    const runs = [];
    for (let i = 0; i < 6; i += 1) {
      const linearWrites = world.linear.writes.count;
      const run = await sync();
      runs.push(run);      const open = world.github.pullRequests.some((pr) => pr.state === 'open');
      const quiet = run.writes.length === 0 && world.linear.writes.count === linearWrites;
      if (!open && quiet && run.report.pullRequest?.needed === false) return runs;
    }
    assert.fail('the sync did not settle');
  }

  async function mergeOnRemote(pr: { head: string; base: string; number: number }, sha: string): Promise<{ sha: string } | { status: number }> {
    if ((await rev(`refs/heads/${pr.head}`)) !== sha) return { status: 409 };
    const base = await rev(`refs/heads/${pr.base}`);
    const merged = await fixture.remote.run(['merge-tree', '--write-tree', base, sha], { okCodes: [0, 1] });
    if (merged.code !== 0) return { status: 405 };
    const tree = merged.stdout.toString('utf8').split('\n')[0] as string;
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-p', sha, '-m', `Merge pull request #${pr.number} from owner/${pr.head}`], {
      env: { GIT_AUTHOR_NAME: 'sync-app[bot]', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.com' },
    });
    await fixture.remote.run(['update-ref', `refs/heads/${pr.base}`, commit, base]);
    return { sha: commit };
  }

  /** I3: every commit the tracked branch gained is the scenario's own or a merge of a sync branch head. */
  async function assertTrackedHistory() {
    const lines = (await fixture.remote.text(['rev-list', '--first-parent', '--parents', `${start}..refs/heads/main`])).split('\n').filter(Boolean);
    for (const line of lines) {
      const [commit, ...parents] = line.split(' ');
      if (own.has(commit as string)) continue;
      assert.equal(parents.length, 2, `${commit} on the tracked branch is not a merge commit (I3)`);
      assert.ok(syncValues.includes(parents[1] as string), `${commit} merges something other than the sync branch (I3)`);
    }
  }

  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const showBytes = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout;
  const show = async (spec: string) => (await showBytes(spec)).toString('utf8');
  const exists = async (spec: string) => (await fixture.remote.run(['cat-file', '-e', spec], { okCodes: [0, 1, 128] })).code === 0;
  const ids = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const documentOf = async (path: string): Promise<FakeDocument> => {
    const id = (await ids())[path]?.id;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  };
  const pathOf = async (id: string) => Object.entries(await ids()).find(([, entry]) => entry.id === id)?.[0];
  const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
  /** The fake gives each document the content id `content-<id>`. */
  const comments = (document: FakeDocument) => [...world.linear.comments.values()].filter((comment) => comment.documentContentId === `content-${document.id}`);

  /** Runs `change` right after the capture has read the documents' content, before the write step. */
  const afterCapture = (change: () => void) => {
    let read = false;
    world.linear.beforeQuery = (operation, variables) => {
      if (read) {
        delete world.linear.beforeQuery;
        change();
      } else if (operation === 'GetDocuments' && variables.withContent === true) read = true;
    };
  };

  async function editInLinear(path: string, content: string) {
    const document = await documentOf(path);
    document.content = content;
    touch(document);
  }

  /** A person's commit on the tracked branch: new text by path, null deletes, `rename` moves a file. */
  async function commitGit(files: Record<string, string | Buffer | null>, rename?: { from: string; to: string }) {
    const base = await rev('refs/heads/main');
    const index = join(fixture.root, 'scratch.index');
    const gitEnv = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await fixture.remote.run(['read-tree', base], { env: gitEnv });
    // A bare repository has no work tree: mode 0 with the null id removes a path from the index.
    const remove = (path: string) => fixture.remote.run(['update-index', '-z', '--index-info'], { input: `0 ${'0'.repeat(40)}\t${path}\0`, env: gitEnv });
    if (rename !== undefined) {
      const blob = await rev(`${base}:${rename.from}`);
      await remove(rename.from);
      await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${rename.to}`], { env: gitEnv });
    }
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        await remove(path);
        continue;
      }
      const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: text });
      await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env: gitEnv });
    }
    const tree = await fixture.remote.text(['write-tree'], { env: gitEnv });
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-m', 'Edit'], { env: gitEnv });
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    own.add(commit);
    return commit;
  }

  /** Both sides hold the same text for a path, and it is the expected one. */
  async function assertBothSides(path: string, expected: string) {
    assert.equal((await documentOf(path)).content, body(expected), `${path} in Linear`);
    assert.equal(await show(`refs/heads/main:${path}`), expected, `${path} on the tracked branch`);
  }

  /** One conflict, never nested, whose versions are exactly these. */
  function assertOneConflict(text: string, git: string, linear: string) {
    const found = detectConflicts(text);
    assert.equal(found.length, 1, `expected one conflict:\n${text}`);
    assert.equal(found[0]?.git, git);
    assert.equal(found[0]?.linear, linear);
    assert.equal(text.split(MARKERS.git).length, 2, 'markers are nested or repeated');
  }

  /** A same-paragraph conflict on DOC, settled: both sides hold the markers. */
  async function conflictOnPlan() {
    await editInLinear(DOC, PLAN.replace('Beta paragraph.', 'Beta paragraph, Linear.'));
    await commitGit({ [DOC]: PLAN.replace('Beta paragraph.', 'Beta paragraph, git.') });
    const runs = await settle();
    return runs;
  }

  it('L3-01: edits of different paragraphs both reach both sides, without markers', async () => {
    await editInLinear(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.'));
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.conflicts, []);
    const expected = PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.').replace('Gamma paragraph.', 'Gamma paragraph, git.');
    await assertBothSides(DOC, expected);
    assert.equal((await documentOf(DOC)).icon ?? null, null);
  });

  it('L3-02: the same paragraph gets the three marker paragraphs on both sides, the conflict mark and one notice; other edits sync in that run', async () => {
    const original = await documentOf(DOC);
    await editInLinear('eng/notes/other.md', `# Other\n\nEdited in Linear. ${CANARY}\n`);
    await editInLinear(DOC, PLAN.replace('Beta paragraph.', 'Beta paragraph, Linear.'));
    await commitGit({ [DOC]: PLAN.replace('Beta paragraph.', 'Beta paragraph, git.'), 'eng/notes/fence.md': `# Fence\n\nRewritten in git. ${CANARY}\n` });

    const first = await sync();
    assert.deepEqual(first.report.sync?.conflicts, [DOC]);
    assert.deepEqual(first.report.sync?.skipped, []);
    assert.equal(first.report.sync?.record?.kind, 'merge');
    assert.ok(first.report.sync?.updated.includes('eng/notes/fence.md'), 'the other git edit waited for the conflict');
    assert.match((await documentOf('eng/notes/fence.md')).content ?? '', /Rewritten in git/);
    assert.match(first.summary, /1 document with conflict markers/);
    // Two documents written, the conflict mark's icon and color, and its notice.
    assert.equal(first.report.sync?.updated.length, 2);
    assert.deepEqual(first.report.writes.linear, { CommentOnDocument: 1, UpdateDocument: 3 });

    await settle();
    const expected = `# Plan\n\nAlpha paragraph.\n\n${MARKERS.git}\n\nBeta paragraph, git.\n\n${MARKERS.linear}\n\nBeta paragraph, Linear.\n\n${MARKERS.end}\n\nGamma paragraph. ${CANARY}\n`;
    await assertBothSides(DOC, expected);
    assert.match(await show('refs/heads/main:eng/notes/other.md'), /Edited in Linear/);
    const document = await documentOf(DOC);
    assert.equal(document.id, original.id);
    assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);
    assert.deepEqual(comments(document).map((comment) => comment.body), [CONFLICT_COMMENT]);
  });

  it("Linear's changes get through in the run after a same-paragraph conflict", async () => {
    await editInLinear(DOC, PLAN.replace('Beta paragraph.', 'Beta paragraph, Linear.'));
    await commitGit({ [DOC]: PLAN.replace('Beta paragraph.', 'Beta paragraph, git.') });
    const conflicted = await sync();
    // Step 2 cannot merge `linear` into the tracked branch yet; step 5's merge record makes it mergeable.
    assert.equal(conflicted.report.pullRequest?.code, 'conflict');
    assert.equal(conflicted.report.sync?.record?.kind, 'merge');

    await editInLinear('eng/notes/other.md', `# Other\n\nA later Linear edit. ${CANARY}\n`);
    const next = await sync();
    assert.equal(next.report.pullRequest?.code, undefined, JSON.stringify(next.report.pullRequest));
    assert.deepEqual(next.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/other.md'), /A later Linear edit/);
    assertOneConflict(await show(`refs/heads/main:${DOC}`), 'Beta paragraph, git.', 'Beta paragraph, Linear.');
  });

  const blocks: Array<[string, string, string, string]> = [
    ['L3-03: a conflict inside a table takes in the whole table', 'eng/notes/table.md', '| two | 2 |', 'two | 22'],
    ['L3-04: a conflict inside a code fence takes in the whole fence', 'eng/notes/fence.md', 'const b = 2;', 'const b = 22;'],
    ['L3-05: a conflict inside an ordered list takes in the whole list', 'eng/notes/ordered.md', '2. Second', '2. Second step'],
    ['L3-05: a conflict inside a nested list takes in the whole list', 'eng/notes/nested.md', '  - Child one', '  - Child one, renamed'],
    ['L3-07: a conflict inside a Mermaid fence takes in the whole fence', 'eng/notes/mermaid.md', '  A --> B', '  A --> D'],
  ];
  for (const [name, path, line, edit] of blocks) {
    it(name, async () => {
      const text = TREE[path] as string;
      const gitText = text.replace(line, `${edit} (git)`);
      const linearText = text.replace(line, `${edit} (Linear)`);
      await editInLinear(path, linearText);
      await commitGit({ [path]: gitText });
      await settle();
      const result = await show(`refs/heads/main:${path}`);
      assert.equal((await documentOf(path)).content, result);
      // Each version is the complete block as that side has it.
      const block = (whole: string) => whole.slice(whole.indexOf('\n\n') + 2, whole.lastIndexOf('\n\nAfter.'));
      assertOneConflict(result, block(gitText), block(linearText));
      assert.ok(result.startsWith(text.slice(0, text.indexOf('\n\n') + 2)) && result.endsWith(`\n\nAfter. ${CANARY}\n`));
    });
  }

  it('L3-06: in a flat bullet list the markers go around the bullet only', async () => {
    const path = 'eng/notes/bullets.md';
    const text = TREE[path] as string;
    await editInLinear(path, text.replace('- pears', '- green pears'));
    await commitGit({ [path]: text.replace('- pears', '- ripe pears') });
    await settle();
    const result = await show(`refs/heads/main:${path}`);
    assert.equal((await documentOf(path)).content, result);
    assertOneConflict(result, '- ripe pears', '- green pears');
    assert.match(result, /- apples\n/);
    assert.match(result, /- plums\n/);
  });

  it('L3-08: edits of neighbouring paragraphs give the result of git\'s line merge', async () => {
    await editInLinear(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.'));
    await commitGit({ [DOC]: PLAN.replace('Beta paragraph.', 'Beta paragraph, git.') });
    await settle();
    const result = await show(`refs/heads/main:${DOC}`);
    assert.equal((await documentOf(DOC)).content, result);
    // Recorded result: the blank line between them is enough context for git, so both edits merge without markers.
    assert.equal(result, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.').replace('Beta paragraph.', 'Beta paragraph, git.'));
  });

  it('L3-09 and L3-14: resolved in Linear, the tracked branch gets the text and the own icon and color come back exactly', async () => {
    const document = await documentOf(DOC);
    document.icon = 'Rocket';
    document.color = '#5E6AD2';
    touch(document);
    await settle();
    await conflictOnPlan();
    assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);

    const resolved = PLAN.replace('Beta paragraph.', 'Beta paragraph, Linear.');
    await editInLinear(DOC, resolved);
    await settle();
    await assertBothSides(DOC, resolved);
    assert.deepEqual({ icon: document.icon, color: document.color }, { icon: 'Rocket', color: '#5E6AD2' });
    assert.equal('saved' in ((await ids())[DOC] as object), false, 'the saved decoration was not cleared from ids');
  });

  it('L3-10: resolved in git, Linear gets the text and the mark is removed', async () => {
    await conflictOnPlan();
    const resolved = PLAN.replace('Beta paragraph.', 'Beta paragraph, git.');
    await commitGit({ [DOC]: resolved });
    await settle();
    await assertBothSides(DOC, resolved);
    const document = await documentOf(DOC);
    assert.deepEqual({ icon: document.icon ?? null, color: document.color ?? null }, { icon: null, color: null });
  });

  it('L3-11: an edit inside open markers on one side reaches the other; the markers and the mark stay', async () => {
    await conflictOnPlan();
    const current = await show(`refs/heads/main:${DOC}`);
    await editInLinear(DOC, current.replace('Beta paragraph, Linear.', 'Beta paragraph, Linear, refined.'));
    await settle();
    const result = await show(`refs/heads/main:${DOC}`);
    assertOneConflict(result, 'Beta paragraph, git.', 'Beta paragraph, Linear, refined.');
    assert.equal((await documentOf(DOC)).content, result);
    assert.equal((await documentOf(DOC)).icon, MARKS.conflict.icon);
    assert.equal(comments(await documentOf(DOC)).length, 1, 'a second notice in the same episode');
  });

  it('L3-12: both sides edit the same lines again; the new conflict replaces the old one, never nested', async () => {
    await conflictOnPlan();
    const current = await show(`refs/heads/main:${DOC}`);
    await editInLinear(DOC, current.replace('Beta paragraph, Linear.', 'Beta, Linear again.'));
    await commitGit({ [DOC]: current.replace('Beta paragraph, Linear.', 'Beta, git again.') });
    await settle();
    const result = await show(`refs/heads/main:${DOC}`);
    assert.equal((await documentOf(DOC)).content, result);
    assert.equal(detectConflicts(result).length, 1, result);
    assert.equal(result.split(MARKERS.git).length, 2, 'markers are nested or repeated');
    assert.match(result, /Beta, git again\./);
    assert.match(result, /Beta, Linear again\./);
  });

  it('L3-13: one marker line removed keeps the mark until all three are gone', async () => {
    await conflictOnPlan();
    const current = await show(`refs/heads/main:${DOC}`);
    await editInLinear(DOC, current.replace(`${MARKERS.linear}\n\n`, ''));
    await settle();
    assert.equal((await documentOf(DOC)).icon, MARKS.conflict.icon);
    assert.ok(detectConflicts(await show(`refs/heads/main:${DOC}`)).length > 0);

    const resolved = PLAN.replace('Beta paragraph.', 'Beta paragraph, git.\n\nBeta paragraph, Linear.');
    await editInLinear(DOC, resolved);
    await settle();
    await assertBothSides(DOC, resolved);
    assert.equal((await documentOf(DOC)).icon ?? null, null);
  });

  it('L3-15: deleted in git and edited in Linear, the document stays and its file comes back through the sync pull request', async () => {
    const document = await documentOf(DOC);
    const edited = PLAN.replace('Gamma paragraph.', 'Gamma paragraph, Linear.');
    await editInLinear(DOC, edited);
    await commitGit({ [DOC]: null });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.decided.map((entry) => [entry.path, entry.summary.code]), [[DOC, 'edit-wins-delete']]);
    assert.match(first?.summary ?? '', /edit-wins-delete/);
    await assertBothSides(DOC, edited);
    assert.ok(!document.trashed);
  });

  it('L3-16: deleted in Linear and edited in git, the same document is restored with the git text and its comments', async () => {
    const document = await documentOf(DOC);
    world.linear.comments.set('comment-keep', { documentContentId: `content-${document.id}`, body: 'A review note.' });
    const commentsBefore = comments(document).length;
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    const edited = PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.');
    await commitGit({ [DOC]: edited });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.restored, [DOC]);
    assert.deepEqual(first?.report.sync?.created, []);
    assert.equal(first?.report.sync?.decided[0]?.summary.code, 'edit-wins-delete');
    assert.match(first?.report.sync?.decided[0]?.summary.text ?? '', /restored with the git text/);
    assert.ok(!document.trashed && document.archivedAt === undefined);
    assert.equal((await ids())[DOC]?.id, document.id);
    await assertBothSides(DOC, edited);
    assert.equal(comments(document).length, commentsBefore, 'the restore commented');
    assert.equal(world.linear.documents.filter((d) => d.title === document.title && !d.trashed).length, 1);
  });

  it('L3-16: when Linear no longer has the document, a new one is created with the git text and the summary says so', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    // Removed from the trash for good after the capture has read it as removed (L5-19).
    let read = false;
    world.linear.beforeQuery = (operation, variables) => {
      if (read) {
        delete world.linear.beforeQuery;
        world.linear.documents.splice(world.linear.documents.indexOf(document), 1);
      } else if (operation === 'GetDocuments' && variables.withContent === true) read = true;
    };
    const edited = PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.');
    await commitGit({ [DOC]: edited });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.restored, []);
    assert.deepEqual(first?.report.sync?.created, [DOC]);
    assert.match(first?.report.sync?.decided[0]?.summary.text ?? '', /a new one was created with the git text and its old comments are lost/);
    assert.match(first?.summary ?? '', /a new one was created/);
    const fresh = await documentOf(DOC);
    assert.notEqual(fresh.id, document.id);
    await assertBothSides(DOC, edited);
  });

  it('L3-16: a document a person restores and edits after the capture is not overwritten; their edit survives', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    afterCapture(() => {
      delete document.trashed;
      delete document.archivedAt;
      document.content = PLAN.replace('Alpha paragraph.', 'Alpha paragraph, restored and edited.');
      touch(document);
    });
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    const first = await sync();
    assert.deepEqual(first.report.sync?.skipped, [{ path: DOC, reason: 'edited-in-linear' }]);
    assert.deepEqual(first.report.sync?.restored, []);
    assert.deepEqual(first.report.sync?.decided, [], 'the summary reported a restore that did not happen');
    await settle();
    const text = await show(`refs/heads/main:${DOC}`);
    assert.match(text, /restored and edited/);
    assert.match(text, /Gamma paragraph, git\./);
    assert.equal((await documentOf(DOC)).id, document.id);
  });

  it('L3-16: a removed document a person restores, moves out and edits after the capture is not moved back over their edit', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    afterCapture(() => {
      delete document.trashed;
      delete document.archivedAt;
      document.projectId = 'project-elsewhere';
      document.content = 'Kept elsewhere.\n';
      touch(document);
    });
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    const first = await sync();
    assert.deepEqual(first.report.sync?.skipped, [{ path: DOC, reason: 'edited-in-linear' }]);
    assert.equal(document.content, 'Kept elsewhere.\n');
    assert.equal(document.projectId, 'project-elsewhere');
  });

  it('a git rename onto a path Linear filled with another document keeps both documents', async () => {
    const other = await documentOf('eng/notes/other.md');
    world.linear.documents.push({ id: 'linear-new', title: 'summary', projectId: 'project-api', createdAt: '2026-01-03T00:00:00.000Z', content: `# Summary\n\nWritten in Linear. ${CANARY}\n` });
    await commitGit({}, { from: 'eng/notes/other.md', to: `${NOTES}/summary.md` });
    const first = await sync();
    assert.deepEqual(first.report.sync?.conflicts, []);
    assert.ok(first.report.sync?.skipped.some((entry) => entry.path === `${NOTES}/summary.md` && entry.reason === 'conflict'), JSON.stringify(first.report.sync?.skipped));
    const added = world.linear.documents.find((d) => d.id === 'linear-new');
    assert.match(added?.content ?? '', /Written in Linear/);
    assert.ok(!other.trashed, 'the renamed document was trashed');
    assert.match(other.content ?? '', /Untouched/);
  });

  it('L3-16: restoring a document in its own container does not count against a full container', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    // The container is exactly full: its count includes the trashed document.
    const cap = String(world.linear.documents.filter((d) => d.projectId === document.projectId).length);
    const first = await sync({ MDBISYNC_DOCUMENT_CAP: cap });
    assert.notEqual(first.report.code, 'container-cap', JSON.stringify(first.report.sync));
    assert.deepEqual(first.report.sync?.restored, [DOC]);
    assert.ok(!document.trashed);
  });

  it('L3-16: a folder README removed in Linear while git edits its body is restored with its id, not created again', async () => {
    const path = 'eng/notes/README.md';
    const document = await documentOf(path);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    const edited = (TREE[path] as string).replace('# Field notes', '# Field notes, edited in git');
    await commitGit({ [path]: edited });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.restored, [path]);
    assert.deepEqual(first?.report.sync?.created, []);
    assert.equal((await documentOf(path)).id, document.id);
    assert.ok(!document.trashed);
    await assertBothSides(path, edited);
  });

  it('L3-16: a run that recreated a gone document and lost its record does not create it twice', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    afterCapture(() => world.linear.documents.splice(world.linear.documents.indexOf(document), 1));
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    const first = await sync();
    assert.deepEqual(first.report.sync?.created, [DOC]);
    // As if the record push had failed: the state refs go back to what the capture left.
    const record = first.report.sync?.record;
    assert.ok(record !== undefined && record !== null);
    await fixture.remote.run(['update-ref', 'refs/mdbisync/linear', record.parents[0] as string]);
    await fixture.remote.run(['update-ref', 'refs/mdbisync/ids', await rev('refs/mdbisync/ids^')]);
    await settle();
    const live = world.linear.documents.filter((d) => !d.trashed && d.title === document.title);
    assert.equal(live.length, 1, 'the document was created twice');
    await assertBothSides(DOC, PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.'));
  });

  it('a gone document an interrupted run recreated and a person then edited is not overwritten; the next run takes the edit in', async () => {
    const document = await documentOf(DOC);
    document.trashed = true;
    document.archivedAt = new Date().toISOString();
    touch(document);
    const gitText = PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.');
    // After this run's capture: Linear removes the document for good, and an interrupted run has already created it
    // again under the id derived from the old one, which a person then edits.
    const recreated: FakeDocument = {
      id: stableId('recreated', document.id), title: document.title, projectId: document.projectId as string, createdAt: new Date().toISOString(),
      content: body(gitText).replace('Alpha paragraph.', 'Alpha paragraph, Linear.'),
    };
    afterCapture(() => {
      world.linear.documents.splice(world.linear.documents.indexOf(document), 1);
      world.linear.documents.push(recreated);
      touch(recreated);
    });
    await commitGit({ [DOC]: gitText });
    const first = await sync();
    assert.deepEqual(first.report.sync?.created, []);
    assert.deepEqual(first.report.sync?.skipped, [{ path: DOC, reason: 'edited-in-linear' }]);
    assert.match(recreated.content ?? '', /Alpha paragraph, Linear\./);
    await settle();
    assert.deepEqual(world.linear.documents.filter((d) => !d.trashed && d.title === document.title).map((d) => d.id), [recreated.id]);
    await assertBothSides(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.').replace('Gamma paragraph.', 'Gamma paragraph, git.'));
  });

  it('L3-17: renamed in Linear and edited in git, both apply', async () => {
    const document = await documentOf(DOC);
    document.title = 'Roadmap';
    touch(document);
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    await settle();
    const path = await pathOf(document.id);
    assert.equal(path, `${NOTES}/Roadmap.md`);
    assert.ok(!(await exists(`refs/heads/main:${DOC}`)), 'the old path stayed on the tracked branch');
    await assertBothSides(path, PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.'));
    assert.equal(document.title, 'Roadmap');
  });

  it('L3-18: renamed in git and edited in Linear, both apply', async () => {
    const document = await documentOf(DOC);
    await editInLinear(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.'));
    await commitGit({}, { from: DOC, to: `${NOTES}/schedule.md` });
    await settle();
    assert.equal(await pathOf(document.id), `${NOTES}/schedule.md`);
    assert.equal(document.title, 'schedule');
    await assertBothSides(`${NOTES}/schedule.md`, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, Linear.'));
  });

  it('L3-19: renamed differently on both sides, the git path wins, the title is set back with a comment, no duplicate', async () => {
    const document = await documentOf(DOC);
    document.title = 'Roadmap';
    touch(document);
    await commitGit({}, { from: DOC, to: `${NOTES}/schedule.md` });
    const [first] = await settle();
    assert.deepEqual(first?.report.sync?.decided.map((entry) => [entry.path, entry.summary.code]), [[`${NOTES}/schedule.md`, 'git-path-wins']]);
    assert.equal(document.title, 'schedule');
    assert.equal(await pathOf(document.id), `${NOTES}/schedule.md`);
    assert.deepEqual(comments(document).map((comment) => comment.body), [RETITLED_COMMENT]);
    assert.ok(!(await exists(`refs/heads/main:${NOTES}/Roadmap.md`)));
    assert.ok(!(await exists(`refs/heads/main:${DOC}`)));
    assert.equal(world.linear.documents.filter((d) => !d.trashed && (d.title === 'schedule' || d.title === 'Roadmap')).length, 1);
    await assertBothSides(`${NOTES}/schedule.md`, PLAN);
  });

  it('L3-20: different images added at the same spot become a conflict whose versions keep both images working', async () => {
    const path = `${NOTES}/gallery.md`;
    const text = TREE[path] as string;
    // Bytes above 0x7F, as in a real PNG signature, so an encoding slip shows.
    const gitBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x01, 0x80]);
    const linearBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xfe, 0x02, 0x81]);
    // alice pastes a picture in Linear: Linear stores it and links its upload URL.
    const url = `${UPLOADS_HOST}/pasted/photo.png`;
    world.linear.uploads.push({ filename: 'photo.png', contentType: 'image/png', size: linearBytes.length, assetUrl: url, bytes: linearBytes });
    await editInLinear(path, text.replace('Intro.\n\n', `Intro.\n\n![Photo](${url})\n\n`));
    await commitGit({ [path]: text.replace('Intro.\n\n', 'Intro.\n\n![Chart](media/chart.png)\n\n'), [`${NOTES}/media/chart.png`]: gitBytes });
    await settle();

    const linkOf = (version: string | undefined, alt: string) => {
      const link = new RegExp(`^!\\[${alt}\\]\\(<?([^)>]+)>?\\)$`).exec(version ?? '')?.[1];
      assert.ok(link !== undefined, version);
      return link;
    };
    const result = await show(`refs/heads/main:${path}`);
    assert.equal(detectConflicts(result).length, 1, result);
    const [conflict] = detectConflicts(result);
    assert.equal(conflict?.git, '![Chart](media/chart.png)');
    // Linear's picture is a file on the tracked branch, linked relative to the document.
    const linearLink = linkOf(conflict?.linear, 'Photo');
    assert.ok(!linearLink.startsWith('http'), linearLink);
    const fileOf = (link: string) => showBytes(`refs/heads/main:${posix.join(NOTES, decodeURI(link))}`);
    assert.deepEqual(await fileOf('media/chart.png'), gitBytes);
    assert.deepEqual(await fileOf(linearLink), linearBytes);

    // In Linear both versions link uploads that serve each picture's bytes.
    const document = await documentOf(path);
    assert.equal(detectConflicts(document.content ?? '').length, 1, document.content);
    const [inLinear] = detectConflicts(document.content ?? '');
    const served = (link: string) => world.linear.uploads.find((upload) => upload.assetUrl === link)?.bytes;
    assert.deepEqual(served(linkOf(inLinear?.git, 'Chart')), gitBytes);
    assert.deepEqual(served(linkOf(inLinear?.linear, 'Photo')), linearBytes);
    assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);
    // Outside the images the two sides hold the same text.
    const unlinked = (whole: string) => whole.replace(/!\[(\w+)\]\([^)]+\)/g, '![$1]()');
    assert.equal(unlinked(document.content ?? ''), unlinked(body(result)));
  });

  /** A same-paragraph conflict on the document whose front matter git changes in the same commit, settled. */
  async function conflictOnFront() {
    const path = 'eng/notes/front.md';
    const text = TREE[path] as string;
    await editInLinear(path, `# Front\n\nOne paragraph, Linear. ${CANARY}\n`);
    await commitGit({ [path]: text.replace('owner: example', 'owner: someone-else').replace('One paragraph.', 'One paragraph, git.') });
    await settle();
    const result = await show(`refs/heads/main:${path}`);
    assert.ok(result.startsWith('---\nowner: someone-else\n---\n'), result);
    assertOneConflict(result, `One paragraph, git. ${CANARY}`, `One paragraph, Linear. ${CANARY}`);
    const document = await documentOf(path);
    assert.equal(document.content, body(result));
    assert.deepEqual({ icon: document.icon, color: document.color }, MARKS.conflict);
    return path;
  }

  it('L3-21: a conflict in a document whose front matter changed in git keeps the new front matter', async () => {
    await conflictOnFront();
  });

  it('L3-21: resolving that conflict in Linear keeps the front matter git changed', async () => {
    const path = await conflictOnFront();
    await editInLinear(path, `# Front\n\nOne paragraph, agreed. ${CANARY}\n`);
    await settle();
    await assertBothSides(path, `---\nowner: someone-else\n---\n\n# Front\n\nOne paragraph, agreed. ${CANARY}\n`);
    assert.equal((await documentOf(path)).icon ?? null, null);
  });

  it('L3-22: marker lookalikes in code, quotes and inline code get no mark and are not reported as conflicts', async () => {
    const path = 'eng/notes/lookalike.md';
    const text = TREE[path] as string;
    await editInLinear(path, text.replace('Plain text.', 'Plain text, Linear.'));
    await commitGit({ [path]: text.replace('The markers look like this:', 'The markers look like this, says git:') });
    const runs = await settle();
    for (const run of runs) assert.deepEqual(run.report.sync?.conflicts ?? [], []);
    const document = await documentOf(path);
    assert.equal(document.icon ?? null, null);
    assert.equal(comments(document).length, 0);
    await assertBothSides(path, text.replace('Plain text.', 'Plain text, Linear.').replace('The markers look like this:', 'The markers look like this, says git:'));
  });

  // The fake keeps one text per document and no editor identity, so alice and bob are told apart by
  // when their edits arrive; edits through two real accounts are the live run of L3-23.
  const allThree = PLAN.replace('Alpha paragraph.', 'Alpha paragraph, alice.').replace('Beta paragraph.', 'Beta paragraph, bob.').replace('Gamma paragraph.', 'Gamma paragraph, git.');
  const bobEdits = async () => editInLinear(DOC, ((await documentOf(DOC)).content ?? '').replace('Beta paragraph.', 'Beta paragraph, bob.'));

  it('L3-23: bob edits while the run merges alice and git: all three paragraphs on both sides, no conflict', async () => {
    await editInLinear(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, alice.'));
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    let edited = false;
    afterCapture(() => {
      edited = true;
      const document = world.linear.documents.find((d) => d.content?.includes('Alpha paragraph, alice.'));
      assert.ok(document !== undefined);
      document.content = (document.content ?? '').replace('Beta paragraph.', 'Beta paragraph, bob.');
      touch(document);
    });
    const runs = [await sync(), ...(await settle())];
    assert.ok(edited, 'bob edited before the run captured Linear');
    for (const run of runs) assert.deepEqual(run.report.sync?.conflicts ?? [], []);
    await assertBothSides(DOC, allThree);
    const document = await documentOf(DOC);
    assert.equal(document.icon ?? null, null);
    assert.equal(comments(document).length, 0);
  });

  it('L3-23: bob edits after the run that merged alice and git, and his edit lands too', async () => {
    await editInLinear(DOC, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, alice.'));
    await commitGit({ [DOC]: PLAN.replace('Gamma paragraph.', 'Gamma paragraph, git.') });
    await sync();
    assert.equal((await documentOf(DOC)).content, PLAN.replace('Alpha paragraph.', 'Alpha paragraph, alice.').replace('Gamma paragraph.', 'Gamma paragraph, git.'));
    await bobEdits();
    const runs = await settle();
    for (const run of runs) assert.deepEqual(run.report.sync?.conflicts ?? [], []);
    await assertBothSides(DOC, allThree);
  });

  it('L3-24: many conflicts and many clean edits in one run: every clean edit syncs in that run, each conflict gets its mark', async () => {
    const CONFLICTS = 6;
    const CLEAN = 20;
    const files: Record<string, string> = {};
    for (let i = 0; i < CONFLICTS + CLEAN; i += 1) files[`${NOTES}/batch-${i}.md`] = `# Batch ${i}\n\nOpen. ${CANARY}\n`;
    await commitGit(files);
    await settle();
    const edits: Record<string, string> = {};
    for (let i = 0; i < CONFLICTS + CLEAN; i += 1) {
      const path = `${NOTES}/batch-${i}.md`;
      edits[path] = `# Batch ${i}\n\nClosed in git. ${CANARY}\n`;
      if (i < CONFLICTS) await editInLinear(path, `# Batch ${i}\n\nClosed in Linear. ${CANARY}\n`);
    }
    await commitGit(edits);
    const first = await sync();
    assert.equal(first.report.sync?.conflicts.length, CONFLICTS);
    assert.equal(first.report.sync?.complete, true);
    for (let i = 0; i < CONFLICTS + CLEAN; i += 1) {
      const document = await documentOf(`${NOTES}/batch-${i}.md`);
      if (i < CONFLICTS) {
        assertOneConflict(document.content ?? '', `Closed in git. ${CANARY}`, `Closed in Linear. ${CANARY}`);
        assert.equal(document.icon, MARKS.conflict.icon);
      } else {
        assert.equal(document.content, edits[`${NOTES}/batch-${i}.md`]);
        assert.equal(document.icon ?? null, null);
      }
    }
    await settle();
    for (let i = 0; i < CONFLICTS; i += 1) assert.equal(detectConflicts(await show(`refs/heads/main:${NOTES}/batch-${i}.md`)).length, 1);
  });
});
