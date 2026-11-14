// Link embeds through the whole sync, from the command line against a local
// git remote and a fake GitHub and Linear. When a person pastes a URL into a
// Linear document and chooses to show it as an embed card, Linear keeps the
// card in the document's editor state, while the API's Markdown for that
// document is an ordinary link: `[page title](url)` for a page and
// `[file name](url)` for an image. The bodies below have that shape. The sync
// reads and writes Markdown only, so:
//
// - a captured card arrives in git as that plain link, never as an image, and
//   nothing is downloaded for it;
// - a git edit of the document writes its Markdown back with the link exactly
//   as git has it, and Linear then holds a plain link where the card was;
// - a document whose file git did not change is not written, so its card stays;
// - a change Linear makes to a card's metadata alone moves the document's
//   `updatedAt` but not its Markdown: no content commit, no download, no sync
//   pull request and no write.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { fixText, sameMarkdown } from '../format/index.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, UPLOADS_HOST, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, createFixture, mergeOnGitHub } from '../state/test-helpers.ts';

const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;

const TREE: Record<string, string> = {
  'README.md': '# Repository\n',
  'eng/README.md': '---\nlinear-team: ENG\n---\n\n# Engineering\n',
  'eng/notes/README.md': '---\nlinear-project: Field notes\n---\n\n# Field notes\n',
  'eng/notes/weekly.md': '---\nowner: example\n---\n\nPlans for the spring beds.\n',
  'eng/notes/colors.md': 'Plans for the spring beds.\n',
  'eng/notes/plan.md': '# Plan\n\nSteps one and two.\n',
  '.pre-commit-config.yaml': PRE_COMMIT,
};

const PAGE_URL = 'https://example.com/garden/page.html';
const IMAGE_URL = 'https://example.com/garden/swatch.png';
/** API Markdown of a page URL shown as an embed card: the link text is the page's title. */
const PAGE_CARD = `Plans for the spring beds.\n\n[Seed catalog](${PAGE_URL})`;
/** API Markdown of an image URL shown as an embed card: the link text is the file name. */
const IMAGE_CARD = `Plans for the spring beds.\n\n[swatch.png](${IMAGE_URL})`;

const SYNC_BRANCH = 'refs/heads/mdbisync/linear';

describe('sync: link embed cards', () => {
  let fixture: Fixture;
  let cwd: string;
  let world: FakeWorld;
  /** Every document write's input, in order. */
  let updates: Record<string, unknown>[];
  /** The ids of every document read with its content, in order. */
  let contentReads: string[];

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    world = fakeWorld();
    world.github.checks = new Map();
    world.github.merge = (pr, sha) => mergeOnGitHub(fixture, pr, sha);
    world.github.pullRequestHead = (pr) => rev(`refs/heads/${pr.head}`);
    updates = [];
    world.linear.writes.reject = (operation, variables) => {
      if (operation === 'UpdateDocument') updates.push(variables.input as Record<string, unknown>);
      return false;
    };
    contentReads = [];
    world.linear.beforeQuery = (operation, variables) => {
      if (operation === 'GetDocuments' && variables.withContent === true) contentReads.push(...(variables.ids as string[]));
    };
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
    updates = [];
  });
  afterEach(() => fixture.cleanup());

  async function cli(command: string, extra: Record<string, string> = {}) {
    const writes = world.writes.length;
    const requests = world.requests.length;
    const result = await runCli([command], {
      cwd,
      fetch: fakeFetch(world),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
        MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
        MDBISYNC_LINEAR_API_URL: LINEAR_API,
        MDBISYNC_MERGE_GRACE_SECONDS: '0', MDBISYNC_MERGE_WITHOUT_CHECKS: 'true',
        MDBISYNC_GITHUB_TOKEN: 'gh-token',
        MDBISYNC_GITHUB_API_URL: GITHUB_API,
        MDBISYNC_REPOSITORY: 'owner/repo',
        MDBISYNC_REPORT_FILE: join(fixture.root, 'report.json'),
        ...extra,
      },
    });
    return { result, writes: world.writes.slice(writes), requests: world.requests.slice(requests) };
  }
  async function sync() {
    const run = await cli('sync');
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    // The card's URLs are only text to the sync: it never fetches them, and it downloads nothing from Linear's storage.
    assert.deepEqual(run.requests.filter((request) => request.includes('example.com/garden') || request.includes(UPLOADS_HOST)), []);
    return run;
  }

  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  const documentOf = async (path: string): Promise<FakeDocument> => {
    const id = (JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>)[path]?.id;
    const document = world.linear.documents.find((d) => d.id === id);
    assert.ok(document !== undefined, `${path} has no document`);
    return document;
  };
  /** A person shows a pasted URL as an embed card: Linear's Markdown for the document changes to `content`. */
  async function showCard(path: string, content: string) {
    const document = await documentOf(path);
    document.content = content;
    touch(document);
  }
  /** Linear changes only a card's metadata, as when it reclassifies an image card on a reload: `updatedAt` moves, the Markdown does not. */
  async function changeCardMetadata(path: string) {
    const document = await documentOf(path);
    const content = document.content;
    touch(document);
    assert.equal(document.content, content);
  }
  /** Takes both cards into the tracked branch through the sync pull request. */
  async function captureCards() {
    await showCard('eng/notes/weekly.md', PAGE_CARD);
    await showCard('eng/notes/colors.md', IMAGE_CARD);
    const opened = await sync();
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.deepEqual(updates, [], 'capturing a card wrote to Linear');
  }
  async function gitEdit(path: string, content: string) {
    const base = await rev('refs/heads/main');
    const blob = await fixture.remote.text(['hash-object', '-w', '--stdin'], { input: content });
    const index = join(fixture.root, 'scratch.index');
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    await fixture.remote.run(['read-tree', base], { env });
    await fixture.remote.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    const tree = await fixture.remote.text(['write-tree'], { env });
    const commit = await fixture.remote.text(['commit-tree', tree, '-p', base, '-m', 'Edit'], { env });
    await fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
  }

  it('captures a page card and an image card as plain links, with nothing downloaded', async () => {
    await captureCards();
    const weekly = await show('refs/heads/main:eng/notes/weekly.md');
    const colors = await show('refs/heads/main:eng/notes/colors.md');
    assert.ok(weekly.startsWith('---\nowner: example\n---\n\n'), 'front matter lost');
    assert.ok(sameMarkdown(weekly.slice(weekly.indexOf('Plans')), PAGE_CARD), weekly);
    assert.ok(sameMarkdown(colors, IMAGE_CARD), colors);
    assert.ok(weekly.includes(`[Seed catalog](${PAGE_URL})`));
    assert.ok(colors.includes(`[swatch.png](${IMAGE_URL})`));
    assert.ok(!colors.includes('!['), 'an image card became an image');
  });

  it('writes a git edit of a captured card back as Markdown with the link as git has it, and leaves other cards unwritten', async () => {
    await captureCards();
    const weekly = await show('refs/heads/main:eng/notes/weekly.md');
    const edited = `${weekly.replace(/\n*$/, '')}\n\nA second paragraph from git.\n`;
    await gitEdit('eng/notes/weekly.md', edited);
    const colorsBefore = { ...(await documentOf('eng/notes/colors.md')) };
    // Linear stores a written link in its own form, with the destination in angle brackets.
    world.linear.store = fixText;

    const run = await sync();
    assert.deepEqual(run.writes, ['UpdateDocument']);
    assert.equal(updates.length, 1);
    // Only Markdown goes to Linear, no editor state. Linear's recorded form of a link written this way is a link
    // mark, not an embed node, so the card becomes a plain link there; the fake keeps no editor state to show it.
    assert.deepEqual(Object.keys(updates[0]!), ['content']);
    const sent = String(updates[0]!.content);
    assert.ok(sent.includes(`[Seed catalog](${PAGE_URL})`), sent);
    assert.ok(sameMarkdown(sent, `${PAGE_CARD}\n\nA second paragraph from git.\n`), sent);
    const stored = (await documentOf('eng/notes/weekly.md')).content ?? '';
    assert.ok(stored.includes(`[Seed catalog](<${PAGE_URL}>)`), stored);
    assert.ok(sameMarkdown(stored, sent));
    // The image card's file did not change in git: its document is not written, so its card stays.
    assert.deepEqual(await documentOf('eng/notes/colors.md'), colorsBefore);

    // The write comes back as Linear's own text of the same Markdown: no sync pull request, and the file keeps its spelling.
    const after = await sync();
    assert.deepEqual(after.writes, []);
    assert.equal(world.github.pullRequests.length, 1);
    assert.equal(await show('refs/heads/main:eng/notes/weekly.md'), edited);
  });

  it('a card turned back into a text link reaches git as a link whose text is the URL', async () => {
    await captureCards();
    await showCard('eng/notes/weekly.md', `Plans for the spring beds.\n\n[${PAGE_URL}](${PAGE_URL})`);
    const opened = await sync();
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/2/merge']);
    const weekly = await show('refs/heads/main:eng/notes/weekly.md');
    assert.ok(weekly.startsWith('---\nowner: example\n---\n\n'), 'front matter lost');
    assert.ok(weekly.includes(`[${PAGE_URL}](${PAGE_URL})`), weekly);
    assert.ok(sameMarkdown(weekly.slice(weekly.indexOf('Plans')), `Plans for the spring beds.\n\n[${PAGE_URL}](${PAGE_URL})`), weekly);
    assert.deepEqual(updates, []);
  });

  it('a metadata-only change makes no content commit, download, sync pull request or write', async () => {
    await captureCards();
    const main = await rev('refs/heads/main');
    const sync1 = await rev(SYNC_BRANCH);
    const captured = await rev('refs/mdbisync/linear^{tree}');
    const requests = world.requests.length;

    await changeCardMetadata('eng/notes/colors.md');
    await changeCardMetadata('eng/notes/weekly.md');
    const touched = [(await documentOf('eng/notes/colors.md')).id, (await documentOf('eng/notes/weekly.md')).id];
    for (let i = 0; i < 2; i++) {
      contentReads = [];
      const run = await sync();
      // The first run reads both documents again: their updatedAt moved.
      if (i === 0) for (const id of touched) assert.ok(contentReads.includes(id), `the run did not read ${id} again`);
      assert.deepEqual(run.writes, []);
      assert.deepEqual(updates, []);
      assert.equal(world.github.pullRequests.length, 1);
      assert.equal(await rev('refs/heads/main'), main);
      assert.equal(await rev(SYNC_BRANCH), sync1);
      assert.equal(await rev('refs/mdbisync/linear^{tree}'), captured, 'a metadata-only change reached the captured tree');
    }
    assert.deepEqual(world.requests.slice(requests).filter((request) => !request.includes(LINEAR_API) && !request.includes(GITHUB_API)), []);
  });

  it('a metadata-only change while the sync pull request waits adds nothing to its head', async () => {
    await showCard('eng/notes/weekly.md', PAGE_CARD);
    await showCard('eng/notes/colors.md', IMAGE_CARD);
    const opened = await sync();
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const head = await rev(SYNC_BRANCH);

    await changeCardMetadata('eng/notes/colors.md');
    contentReads = [];
    const merged = await sync();
    assert.ok(contentReads.includes((await documentOf('eng/notes/colors.md')).id), 'the run did not read the document again');
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    const main = await rev('refs/heads/main');
    assert.equal((await fixture.remote.text(['show', '-s', '--format=%P', main])).split(' ')[1], head, 'the merged head is not the one the cards opened');

    // The runs after the merge have nothing left to take from that change either.
    for (let i = 0; i < 2; i++) {
      const after = await sync();
      assert.deepEqual(after.writes, []);
      assert.equal(await rev('refs/heads/main'), main);
    }
    assert.equal(world.github.pullRequests.length, 1);
    assert.deepEqual(updates, []);
  });
});
