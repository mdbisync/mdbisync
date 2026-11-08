// Offline tests of the format probe against a fake Linear: recording forms,
// detecting drift in a hand-edited form, reading what only Yjs keeps, and
// deleting the run's project.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as Y from 'yjs';

import { LinearClient } from '../../src/linear/index.ts';
import { FakeLinear, fakeDocument, type ReceivedRequest } from '../linear/fake-linear.ts';
import { fromLinear, goldenMarkdownPath, goldenYjsPath, loadBank, sentForm, toLinear } from './bank.ts';
import { PROBE_FACTS, findLimit, isLeftover, runProbe } from './probe.ts';
import { findDrift, refusalKey, writeRecord } from './record.ts';
import { diffLines, keptOnlyInYjs, renderReport } from './report.ts';
import { summarizeContentState } from './yjs-summary.ts';

const ASSET_URL = 'https://uploads.example.test/a1b2/banner.png';

/** A Yjs state like Linear's: paragraphs, and an image node when the text has one. */
function contentState(markdown: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prosemirror');
  for (const block of markdown.split('\n\n')) {
    const image = block.match(/^!\[([^\]]*)\]\((\S+)(?: "([^"]*)")?\)$/);
    if (image) {
      const node = new Y.XmlElement('image');
      node.setAttribute('alt', image[1]!);
      node.setAttribute('src', image[2]!);
      node.setAttribute('title', image[3] ?? '');
      node.setAttribute('uploadId', 'upload-123');
      fragment.push([node]);
      continue;
    }
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, block, { attribution: { actorType: 'app', userId: 'user-1' } });
    paragraph.insert(0, [text]);
    fragment.push([paragraph]);
  }
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

/** Linear's normalization in this fake: `*` bullets become `-`, image titles go, no final newline. */
function normalize(markdown: string): string {
  return markdown
    .replace(/^\* /gm, '- ')
    .replace(/(!\[[^\]]*\]\(\S+) "[^"]*"\)/g, '$1)')
    .replace(/\n+$/, '');
}

class FakeWorkspace {
  readonly documents = new Map<string, { content: string; state: string }>();
  readonly projects = new Set<string>();
  deletedProjects: string[] = [];
  #next = 0;

  install(fake: FakeLinear): void {
    const data = (body: unknown) => ({ body: { data: body } });
    fake.operations.set('Teams', () => data({ teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } }));
    fake.operations.set('ProbeLeftovers', () => data({ viewer: { id: 'app-user' }, projects: { nodes: [] } }));
    fake.operations.set('CreateProject', () => {
      const id = `project-${(this.#next += 1)}`;
      this.projects.add(id);
      return data({ projectCreate: { project: { id } } });
    });
    fake.operations.set('DeleteProject', (r: ReceivedRequest) => {
      this.deletedProjects.push(r.variables!.id as string);
      return data({ projectDelete: { success: true } });
    });
    fake.operations.set('FileUpload', () =>
      data({ fileUpload: { success: true, uploadFile: { uploadUrl: `${fake.url}/upload`, assetUrl: ASSET_URL, headers: [] } } }),
    );
    fake.operations.set('CreateDocument', (r: ReceivedRequest) => {
      const input = r.variables!.input as { content: string };
      if (input.content.length > 1000) {
        return { body: { errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }] } };
      }
      const id = `doc-${(this.#next += 1)}`;
      this.store(id, input.content);
      return data({ documentCreate: { success: true, document: fakeDocument(id, { content: this.documents.get(id)!.content }) } });
    });
    fake.operations.set('UpdateDocument', (r: ReceivedRequest) => {
      const id = r.variables!.id as string;
      this.store(id, (r.variables!.input as { content: string }).content);
      return data({ documentUpdate: { success: true, document: fakeDocument(id, { content: this.documents.get(id)!.content }) } });
    });
    fake.operations.set('ReadBack', (r: ReceivedRequest) => {
      const ids = r.variables!.ids as string[];
      const nodes = ids.map((id) => ({
        id,
        content: this.documents.get(id)!.content,
        contentState: this.documents.get(id)!.state,
        trashed: null,
        archivedAt: null,
        team: null,
      }));
      return data({ documents: { nodes } });
    });
  }

  store(id: string, content: string): void {
    const normalized = normalize(content);
    this.documents.set(id, { content: normalized, state: contentState(content.replace(/\n+$/, '')) });
  }
}

function makeBank(): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-bank-'));
  mkdirSync(join(dir, 'lists'));
  mkdirSync(join(dir, 'images'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'size'));
  writeFileSync(join(dir, 'assets', 'banner.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'lists', 'star.md'), '* One\n* Two\n\nRef kx-00000001\n');
  writeFileSync(join(dir, 'lists', 'dash.md'), '- One\n- Two\n\nRef kx-00000002');
  writeFileSync(join(dir, 'images', 'title.md'), '![Banner](../assets/banner.png "Quarterly banner")\n\nRef kx-00000003\n');
  writeFileSync(join(dir, 'size', 'large.md'), `${'a'.repeat(2000)}\n\nRef kx-00000004\n`);
  writeFileSync(join(dir, 'notes.yaml'), 'kx: 5\n');
  writeFileSync(
    join(dir, 'index.yaml'),
    [
      'version: 1',
      'assets:',
      '  - file: "assets/banner.png"',
      'fixtures:',
      '  - { file: "lists/star.md", group: lists, construct: bullet-star, class: fixable, basis: assumed, canary: kx-00000001 }',
      '  - { file: "lists/dash.md", group: lists, construct: bullet-dash, class: unchanged, basis: assumed, canary: kx-00000002 }',
      '  - { file: "images/title.md", group: images, construct: image-title, class: unchanged, basis: assumed, canary: kx-00000003 }',
      '  - { file: "size/large.md", group: size, construct: over-limit, class: lint-error, rule: content-too-long, basis: known, canary: kx-00000004 }',
      '  - { file: "notes.yaml", group: unsynced, construct: yaml, class: unchanged, basis: assumed, canary: kx-00000005, synced: false }',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('format probe against a fake Linear', () => {
  let fake: FakeLinear;
  let workspace: FakeWorkspace;
  let bankDir: string;

  before(async () => {
    fake = await new FakeLinear().start();
    workspace = new FakeWorkspace();
    workspace.install(fake);
    bankDir = makeBank();
  });

  after(async () => {
    await fake.stop();
    rmSync(bankDir, { recursive: true, force: true });
  });

  const probe = () =>
    runProbe({ client: new LinearClient({ token: 'fake', baseUrl: fake.url }, PROBE_FACTS), bank: loadBank(bankDir), runId: 'test-run', facts: false });

  it('records Linear forms, refusals and Yjs beside the fixtures, and deletes its project', async () => {
    const run = await probe();
    assert.deepEqual(run.fixtures.map((r) => r.file), ['lists/star.md', 'lists/dash.md', 'images/title.md', 'size/large.md']);
    const star = run.fixtures[0]!;
    assert.equal(star.first, '- One\n- Two\n\nRef kx-00000001');
    assert.equal(star.fixedPoint, true);
    assert.equal(star.createReturnedStored, true);
    assert.match(run.fixtures[3]!.refused ?? '', /INVALID_INPUT/);
    assert.deepEqual(workspace.deletedProjects, [...workspace.projects]);
    assert.deepEqual(run.cleanup, ['run project deleted']);

    writeRecord(loadBank(bankDir), run);
    assert.equal(readFileSync(join(bankDir, goldenMarkdownPath('lists/star.md')), 'utf8'), '- One\n- Two\n\nRef kx-00000001');
    const yjs = JSON.parse(readFileSync(join(bankDir, goldenYjsPath('images/title.md')), 'utf8'));
    assert.equal(yjs.content[0].attrs.title, 'Quarterly banner');
    assert.equal(yjs.content[0].attrs.src, '../assets/banner.png', 'the upload URL is mapped back to the bank path');
    assert.equal(yjs.content[0].attrs.uploadId, '<uploadId>', 'volatile ids are placeholders');
    const manifest = JSON.parse(readFileSync(join(bankDir, 'linear-probe.json'), 'utf8'));
    assert.equal(manifest.fixtures['size/large.md'].refused, 'INVALID_INPUT');
    assert.deepEqual(findDrift(loadBank(bankDir), await probe()), [], 'a second run matches the record');
  });

  it('reports drift for a recorded form edited by hand', async () => {
    const path = join(bankDir, goldenMarkdownPath('lists/dash.md'));
    writeFileSync(path, '* One\n* Two\n\nRef kx-00000002');
    const drift = findDrift(loadBank(bankDir), await probe());
    assert.deepEqual(drift.map((d) => [d.file, d.kind]), [['lists/dash.md', 'markdown']]);
    assert.match(drift[0]!.detail, /line 1/);
  });

  it('shows an image title kept in Yjs and lost in Markdown', async () => {
    const run = await probe();
    const image = run.fixtures.find((r) => r.file === 'images/title.md')!;
    assert.equal(image.first, '![Banner](../assets/banner.png)\n\nRef kx-00000003');
    assert.deepEqual(keptOnlyInYjs(image), ['image.title="Quarterly banner"']);
    const report = renderReport(run, { drift: [], updated: true });
    assert.match(report, /\| `images\/title.md` \| image-title .*image\.title="Quarterly banner"/);
    assert.match(report, /-!\[Banner\]\(\.\.\/assets\/banner\.png "Quarterly banner"\)/);
  });

  it('reports a Yjs state that can no longer be read as drift', async () => {
    const original = fake.operations.get('ReadBack')!;
    fake.operations.set('ReadBack', (r: ReceivedRequest) => {
      const reply = original(r) as { body: { data: { documents: { nodes: Array<{ contentState: string | null }> } } } };
      for (const node of reply.body.data.documents.nodes) node.contentState = null;
      return reply;
    });
    const drift = findDrift(loadBank(bankDir), await probe());
    fake.operations.set('ReadBack', original);
    assert.ok(drift.some((d) => d.file === 'lists/star.md' && d.kind === 'yjs' && /recorded a Yjs state, now none/.test(d.detail)), JSON.stringify(drift));
  });

  it('records an HTTP refusal as a finding and goes on', async () => {
    const original = fake.operations.get('CreateDocument')!;
    fake.operations.set('CreateDocument', (r: ReceivedRequest) =>
      (r.variables!.input as { title: string }).title.includes('kx-00000002') ? { status: 413, body: {} } : original(r),
    );
    const run = await probe();
    fake.operations.set('CreateDocument', original);
    assert.equal(run.fixtures[1]!.refused, 'HTTP 413', 'no request id in the recorded refusal');
    assert.equal(refusalKey('HTTP 413'), 'HTTP 413');
    assert.equal(refusalKey('Linear error INVALID_INPUT: Argument Validation Error'), 'INVALID_INPUT');
    assert.equal(run.fixtures[0]!.fixedPoint, true);
  });

  it('ends the run as unfinished on a server error instead of recording a refusal', async () => {
    const original = fake.operations.get('CreateDocument')!;
    fake.operations.set('CreateDocument', () => ({ status: 502, body: {} }));
    await assert.rejects(probe());
    fake.operations.set('CreateDocument', original);
  });

  it('reports a project deletion that Linear does not confirm', async () => {
    const original = fake.operations.get('DeleteProject')!;
    fake.operations.set('DeleteProject', () => ({ body: { data: { projectDelete: { success: false } } } }));
    const run = await probe();
    fake.operations.set('DeleteProject', original);
    assert.deepEqual(run.cleanup, ['run project NOT deleted: Linear did not confirm']);
  });

  it('deletes its project when a run fails midway', async () => {
    const before = workspace.deletedProjects.length;
    const original = fake.operations.get('UpdateDocument')!;
    fake.operations.set('UpdateDocument', () => ({ reset: true }));
    await assert.rejects(probe());
    fake.operations.set('UpdateDocument', original);
    assert.equal(workspace.deletedProjects.length, before + 1);
  });
});

describe('format probe helpers', () => {
  it('sends the text without front matter', () => {
    assert.equal(sentForm('---\nowner: ops\n---\n\n# Title\n\nText.'), '# Title\n\nText.');
    assert.equal(sentForm('---\r\na: 1\r\n---\r\nBody'), 'Body');
    assert.equal(sentForm('--- \na: 1\n---\nBody'), 'Body', 'trailing space after the opening line');
    assert.equal(sentForm('\uFEFF---\na: 1\n---\nBody'), 'Body', 'byte order mark before the front matter');
    assert.equal(sentForm('---\nonly: front matter\n---'), '');
    assert.equal(sentForm('Text.\n\n---\n\nMore.'), 'Text.\n\n---\n\nMore.');
    assert.equal(sentForm('---\nno closing line'), '---\nno closing line');
  });

  it('sweeps only its own old projects', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const old = '2026-11-08T09:00:00Z';
    const own = { id: 'app-user' };
    assert.equal(isLeftover({ name: 'Format probe 20261108-a1b2c3', createdAt: old, creator: own }, 'app-user', now), true);
    assert.equal(isLeftover({ name: 'Format probe 20261108-a1b2c3', createdAt: '2026-11-08T11:00:00Z', creator: own }, 'app-user', now), false, 'too young');
    assert.equal(isLeftover({ name: 'Format probe migration', createdAt: old, creator: own }, 'app-user', now), false, 'not a run name');
    assert.equal(isLeftover({ name: 'Format probe 20261108-a1b2c3', createdAt: old, creator: { id: 'someone' } }, 'app-user', now), false, 'made by someone else');
    assert.equal(isLeftover({ name: 'Format probe 20261108-a1b2c3', createdAt: old, creator: null }, 'app-user', now), false, 'no creator');
  });

  it('finds a limit by doubling and halving', async () => {
    const tried: number[] = [];
    const limit = await findLimit(async (value) => (tried.push(value), value > 512 ? 'too long' : undefined), 255, 100_000);
    assert.equal(limit.accepted, 512);
    assert.equal(limit.refused, 513);
    assert.equal(limit.refusal, 'too long');
    assert.equal(limit.tries, tried.length);
    assert.deepEqual(await findLimit(async () => undefined, 10, 40), { accepted: 40, tries: 3 });
  });

  it('swaps asset links for upload URLs and back', () => {
    const assets = { urls: new Map([['assets/pixel copy.png', 'https://uploads.example.test/x/pixel.png']]) };
    const text = '![a](../assets/pixel copy.png) ![b](../assets/pixel%20copy.png)';
    const linear = toLinear(text, assets);
    assert.equal(linear, '![a](https://uploads.example.test/x/pixel.png) ![b](https://uploads.example.test/x/pixel.png)');
    // Back to the percent-encoded path: still a valid link without angle brackets.
    assert.equal(fromLinear(linear, assets), '![a](../assets/pixel%20copy.png) ![b](../assets/pixel%20copy.png)');
  });

  it('decodes marks and strips the y-prosemirror mark suffix', () => {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'bold', { 'strong--a1': true });
    paragraph.insert(0, [text]);
    doc.getXmlFragment('prosemirror').push([paragraph]);
    const summary = summarizeContentState(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'));
    assert.deepEqual(summary, { roots: ['prosemirror'], content: [{ type: 'paragraph', children: [{ text: 'bold', marks: { strong: true } }] }] });
    const mapped = summarizeContentState(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), { mapString: (v) => v.replace('bold', 'mapped') });
    assert.deepEqual(mapped.content[0], { type: 'paragraph', children: [{ text: 'mapped', marks: { strong: true } }] }, 'text runs are mapped too');
  });

  it('shows the lines that differ', () => {
    assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), ['@@ line 2 @@', '-b', '+B']);
    assert.deepEqual(diffLines('a\n', 'a'), ['@@ line 2 @@', '-']);
  });
});
