import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitFile } from '../format/markdown.ts';
import { detectConflicts, MARKERS, RETITLED_COMMENT, resolveStructural } from './index.ts';
import type { StructuralInput, StructuralResult, Version } from './index.ts';

// A small fake world: one document with an id, a tracked branch that maps
// paths to file texts, and a Linear workspace that maps ids to a title path,
// a body and a trash flag. Applying a result must leave the two sides in
// agreement, with one document and one file for the id (I8), and every
// edit present on both sides, in the text or inside conflict markers (I2).

interface Doc {
  path: string;
  body: string;
  trashed: boolean;
  comments: string[];
}

interface World {
  files: Map<string, string>;
  docs: Map<string, Doc>;
  gone: boolean;
}

const ID = 'doc-1';
const EARLIER_COMMENT = 'Please check the install steps.';
const BASE: Version = { path: 'guides/setup.md', text: '---\nowner: docs\n---\n\nIntro.\n\nInstall the tool.\n\nRun it.\n' };

function world(git: Version | null, linear: Version | null, gone = false): World {
  const files = new Map<string, string>();
  if (git !== null) files.set(git.path, git.text);
  const docs = new Map<string, Doc>();
  if (!gone) {
    docs.set(ID, linear === null
      ? { path: BASE.path, body: splitFile(BASE.text).body, trashed: true, comments: [EARLIER_COMMENT] }
      : { path: linear.path, body: splitFile(linear.text).body, trashed: false, comments: [EARLIER_COMMENT] });
  }
  return { files, docs, gone };
}

function apply(state: World, git: Version | null, result: StructuralResult): void {
  if (result.path === null) {
    if (git !== null) state.files.delete(git.path);
    const doc = state.docs.get(ID);
    if (doc !== undefined) doc.trashed = true;
    return;
  }
  if (git !== null) state.files.delete(git.path);
  state.files.set(result.path, result.text as string);
  const steps = result.linear;
  let doc = state.docs.get(ID);
  if (steps.create) {
    assert.equal(doc, undefined, 'create only when the document is gone');
    doc = { path: result.path, body: '', trashed: false, comments: [] };
    state.docs.set(ID, doc);
  }
  assert.ok(doc !== undefined);
  if (steps.restore) doc.trashed = false;
  if (steps.retitle) doc.path = result.path;
  if (steps.write) doc.body = splitFile(result.text as string).body;
  if (steps.comment !== undefined) doc.comments.push(steps.comment);
}

async function run(git: Version | null, linear: Version | null, gone = false) {
  const input: StructuralInput = { base: BASE, git, linear, ...(gone ? { linearGone: true } : {}) };
  const state = world(git, linear, gone);
  const result = await resolveStructural(input);
  apply(state, git, result);
  return { result, state };
}

function assertConverged(state: World, path: string): Doc {
  assert.deepEqual([...state.files.keys()], [path], 'one file (I8)');
  const live = [...state.docs.values()].filter((doc) => !doc.trashed);
  assert.equal(live.length, 1, 'one live document (I8)');
  const doc = live[0]!;
  assert.equal(doc.path, path, 'title follows the path');
  assert.equal(doc.body, splitFile(state.files.get(path)!).body, 'Linear holds the file body (I1)');
  return doc;
}

function assertHas(state: World, ...edits: string[]): void {
  for (const text of [...state.files.values(), ...[...state.docs.values()].filter((doc) => !doc.trashed).map((doc) => doc.body)]) {
    for (const edit of edits) assert.ok(text.includes(edit), `edit "${edit}" kept (I2)`);
  }
}

const edit = (version: Version, from: string, to: string): Version => ({ ...version, text: version.text.replace(from, to) });
const move = (version: Version, path: string): Version => ({ ...version, path });

test('L3-15: deleted in git, edited in Linear: the document stays and the file comes back', async () => {
  const linear = edit(BASE, 'Run it.', 'Run it twice.');
  const { result, state } = await run(null, linear);
  assert.equal(result.kind, 'git-deleted-linear-changed');
  assert.equal(result.git, 'restore');
  assert.deepEqual(result.linear, { restore: false, create: false, trash: false, retitle: false, write: false });
  assert.equal(result.text, linear.text, 'Linear text with the last known front matter');
  assert.equal(result.summary!.code, 'edit-wins-delete');
  assert.match(result.summary!.text, /^guides\/setup\.md: deleted in git but changed in Linear; .*comes back through the sync pull request$/);
  assertConverged(state, BASE.path);
  assertHas(state, 'Run it twice.');
});

test('L3-15 variant: deleted in git, renamed in Linear: a rename is a change, so the document stays', async () => {
  const { result, state } = await run(null, move(BASE, 'guides/install.md'));
  assert.equal(result.kind, 'git-deleted-linear-changed');
  assert.equal(result.path, 'guides/install.md');
  assertConverged(state, 'guides/install.md');
});

test('L3-16: deleted in Linear, edited in git: the same document is restored with the git text and its comments as they were', async () => {
  const git = edit(BASE, 'Install the tool.', 'Install the tool with npm.');
  const { result, state } = await run(git, null);
  assert.equal(result.kind, 'linear-deleted-git-changed');
  assert.equal(result.git, 'none');
  assert.deepEqual(result.linear, { restore: true, create: false, trash: false, retitle: true, write: true });
  assert.deepEqual(result.summary, {
    code: 'edit-wins-delete',
    text: 'guides/setup.md: deleted in Linear but changed in git; the document is restored with the git text',
  });
  const doc = assertConverged(state, BASE.path);
  assert.equal(state.docs.size, 1, 'restored, not recreated');
  assert.deepEqual(doc.comments, [EARLIER_COMMENT], 'comments unchanged');
  assertHas(state, 'Install the tool with npm.');
  assert.equal(state.files.get(BASE.path), git.text, 'git front matter kept');
});

test('L3-16 variant: deleted in Linear, renamed and edited in git: restored under the new title', async () => {
  const git = move(edit(BASE, 'Run it.', 'Run it now.'), 'guides/start.md');
  const { result, state } = await run(git, null);
  assert.equal(result.path, 'guides/start.md');
  assert.equal(result.linear.retitle, true);
  assertConverged(state, 'guides/start.md');
  assertHas(state, 'Run it now.');
});

test('L3-16 variant: the document is gone from Linear for good: a new one is created with the git text', async () => {
  const git = edit(BASE, 'Run it.', 'Run it again.');
  const { result, state } = await run(git, null, true);
  assert.deepEqual(result.linear, { restore: false, create: true, trash: false, retitle: false, write: true });
  assert.equal(result.summary!.code, 'edit-wins-delete');
  assert.match(result.summary!.text, /gone from Linear, so a new one was created .*old comments are lost$/);
  assertConverged(state, BASE.path);
  assertHas(state, 'Run it again.');
});

test('L3-17: renamed in Linear, edited in git: both apply and the file moves', async () => {
  const git = edit(BASE, 'Install the tool.', 'Install the tool first.');
  const linear = move(BASE, 'guides/install.md');
  const { result, state } = await run(git, linear);
  assert.equal(result.kind, 'linear-renamed');
  assert.equal(result.git, 'move');
  assert.equal(result.path, 'guides/install.md');
  assert.equal(result.linear.retitle, false);
  assert.equal(result.linear.write, true);
  assert.equal(result.linear.comment, undefined);
  assert.deepEqual(result.summary, {
    code: 'rename-and-edit',
    text: 'guides/setup.md → guides/install.md: renamed in Linear and edited in git; both applied',
  });
  assertConverged(state, 'guides/install.md');
  assertHas(state, 'Install the tool first.');
  assert.ok(result.text!.startsWith('---\nowner: docs\n---\n'), 'git front matter kept');
});

test('L3-18: renamed in git, edited in Linear: both apply and the title follows the path', async () => {
  const git = move(BASE, 'guides/install.md');
  const linear = edit(BASE, 'Intro.', 'A short intro.');
  const { result, state } = await run(git, linear);
  assert.equal(result.kind, 'git-renamed');
  assert.equal(result.git, 'none');
  assert.equal(result.linear.retitle, true);
  assert.equal(result.linear.write, false, 'Linear already holds the merged body');
  assert.deepEqual(result.summary, {
    code: 'rename-and-edit',
    text: 'guides/setup.md → guides/install.md: renamed in git and edited in Linear; both applied',
  });
  assertConverged(state, 'guides/install.md');
  assertHas(state, 'A short intro.');
});

test('L3-19: renamed differently on both sides: the git path wins, the title is set back with a comment', async () => {
  const git = move(edit(BASE, 'Intro.', 'Intro from git.'), 'guides/install.md');
  const linear = move(edit(BASE, 'Run it.', 'Run it from Linear.'), 'guides/getting-started.md');
  const { result, state } = await run(git, linear);
  assert.equal(result.kind, 'different-renames');
  assert.equal(result.path, 'guides/install.md');
  assert.equal(result.git, 'none');
  assert.deepEqual(result.linear, { restore: false, create: false, trash: false, retitle: true, write: true, comment: RETITLED_COMMENT });
  assert.deepEqual(result.summary, {
    code: 'git-path-wins',
    text: 'guides/setup.md: renamed to guides/install.md in git and to guides/getting-started.md in Linear; the git path wins and the Linear title is set back',
  });
  const doc = assertConverged(state, 'guides/install.md');
  assert.deepEqual(doc.comments, [EARLIER_COMMENT, RETITLED_COMMENT]);
  assertHas(state, 'Intro from git.', 'Run it from Linear.');
});

test('a structural case with a same-paragraph edit keeps both versions inside markers', async () => {
  const git = move(edit(BASE, 'Run it.', 'Run it in git.'), 'guides/install.md');
  const linear = edit(BASE, 'Run it.', 'Run it in Linear.');
  const { result, state } = await run(git, linear);
  assert.equal(result.kind, 'git-renamed');
  assert.equal(result.conflicts.length, 1);
  assert.match(result.summary!.text, /both applied; 1 text conflict is marked in the document$/);
  assert.equal(result.linear.write, true);
  assertConverged(state, 'guides/install.md');
  assertHas(state, MARKERS.git, 'Run it in git.', MARKERS.linear, 'Run it in Linear.', MARKERS.end);
});

test('markers already in the kept version are reported when the other side deleted the document', async () => {
  const marked = await resolveStructural({
    base: BASE,
    git: move(edit(BASE, 'Run it.', 'Run it in git.'), 'guides/install.md'),
    linear: edit(BASE, 'Run it.', 'Run it in Linear.'),
  });
  const open: Version = { path: 'guides/install.md', text: marked.text! };
  const base: Version = { ...open, path: BASE.path };
  for (const [git, linear] of [[null, open], [open, null]] as const) {
    const result = await resolveStructural({ base: { ...base, text: BASE.text }, git, linear });
    assert.equal(result.summary!.code, 'edit-wins-delete');
    assert.deepEqual(result.conflicts, detectConflicts(open.text));
    assert.equal(result.conflicts.length, 1);
    assert.match(result.summary!.text, /; 1 text conflict is marked in the document$/);
  }
});

test('renamed to the same path on both sides: one rename, merged text, no comment', async () => {
  const git = move(edit(BASE, 'Intro.', 'Intro, git.'), 'guides/install.md');
  const linear = move(edit(BASE, 'Run it.', 'Run it, Linear.'), 'guides/install.md');
  const { result, state } = await run(git, linear);
  assert.equal(result.kind, 'same-rename');
  assert.equal(result.summary, null);
  assert.equal(result.linear.comment, undefined);
  assertConverged(state, 'guides/install.md');
  assertHas(state, 'Intro, git.', 'Run it, Linear.');
});

test('the same name in NFC and NFD is the same path: not a rename, and not two different renames', async () => {
  const nfc = 'guides/café.md';
  const nfd = 'guides/café.md';
  const same = await resolveStructural({ base: BASE, git: move(BASE, nfd), linear: move(BASE, nfc) });
  assert.equal(same.kind, 'same-rename');
  assert.equal(same.linear.comment, undefined);

  const unchanged = await resolveStructural({ base: { ...BASE, path: nfc }, git: { ...BASE, path: nfd }, linear: null });
  assert.equal(unchanged.kind, 'linear-deleted', 'a decomposed name alone is no change');
});

test('line endings alone are no edit: a delete stays a delete, and Linear gets no write', async () => {
  const crlf: Version = { ...BASE, text: BASE.text.replaceAll('\n', '\r\n') };
  const gitDeleted = await resolveStructural({ base: crlf, git: null, linear: BASE });
  assert.equal(gitDeleted.kind, 'git-deleted');
  assert.equal(gitDeleted.linear.trash, true);

  const linearDeleted = await resolveStructural({ base: BASE, git: crlf, linear: null });
  assert.equal(linearDeleted.kind, 'linear-deleted');

  const renamedCrlf = await resolveStructural({ base: crlf, git: move(crlf, 'guides/install.md'), linear: BASE });
  assert.equal(renamedCrlf.kind, 'git-renamed');
  assert.equal(renamedCrlf.linear.write, false);
  assert.equal(renamedCrlf.summary, null);
});

test('a delete against an unchanged document is a plain delete', async () => {
  const gitDeleted = await resolveStructural({ base: BASE, git: null, linear: BASE });
  assert.equal(gitDeleted.kind, 'git-deleted');
  assert.equal(gitDeleted.linear.trash, true);
  assert.equal(gitDeleted.path, null);
  assert.equal(gitDeleted.summary, null);

  const linearDeleted = await resolveStructural({ base: BASE, git: BASE, linear: null });
  assert.equal(linearDeleted.kind, 'linear-deleted');
  assert.equal(linearDeleted.git, 'delete');
  assert.equal(linearDeleted.linear.restore, false);
});

test('deleted on both sides: nothing to do', async () => {
  const result = await resolveStructural({ base: BASE, git: null, linear: null });
  assert.equal(result.kind, 'both-deleted');
  assert.equal(result.path, null);
  assert.deepEqual(result.linear, { restore: false, create: false, trash: false, retitle: false, write: false });
});

test('a front-matter-only edit in git is a change and restores a document deleted in Linear', async () => {
  const git = edit(BASE, 'owner: docs', 'owner: platform');
  const result = await resolveStructural({ base: BASE, git, linear: null });
  assert.equal(result.kind, 'linear-deleted-git-changed');
  assert.equal(result.linear.restore, true);
});

test('no structural change: an ordinary merge with no summary', async () => {
  const git = edit(BASE, 'Intro.', 'Intro, git.');
  const linear = edit(BASE, 'Run it.', 'Run it, Linear.');
  const result = await resolveStructural({ base: BASE, git, linear });
  assert.equal(result.kind, 'none');
  assert.equal(result.summary, null);
  assert.equal(result.linear.write, true);
  assert.equal(result.path, BASE.path);
});

test('summaries and comments name paths and cases, never document content (I5)', async () => {
  const secret = 'canary-7f3a';
  const cases: Array<[Version | null, Version | null]> = [
    [null, edit(BASE, 'Run it.', secret)],
    [edit(BASE, 'Run it.', secret), null],
    [move(BASE, 'guides/a.md'), edit(BASE, 'Run it.', secret)],
    [edit(BASE, 'Run it.', secret), move(BASE, 'guides/b.md')],
    [move(edit(BASE, 'Intro.', secret), 'guides/a.md'), move(BASE, 'guides/b.md')],
  ];
  for (const [git, linear] of cases) {
    const result = await resolveStructural({ base: BASE, git, linear });
    assert.ok(result.summary !== null);
    assert.ok(!result.summary.text.includes(secret));
    assert.ok(!(result.linear.comment ?? '').includes(secret));
  }
});
