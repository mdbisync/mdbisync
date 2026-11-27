// Which links of a document's tracked text a commit taking in Linear's text
// added: the evidence an initial sync from Linear uses when the state no
// longer says where a document's links came from.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git } from '../state/git.ts';
import { INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { CAPTURE_MESSAGE } from '../sync/capture.ts';
import { SYNC_PULL_REQUEST_TITLE } from '../sync/pull-request.ts';
import { PARTIAL_RECORD_MESSAGE } from '../sync/write.ts';
import { linksTakenInFromLinear, pathLinks } from './provenance.ts';

const DOC = 'eng/notes/doc.md';
const SECRET = 'records.csv';
const CAPTURED = `eng/notes/assets/${'a'.repeat(64)}.png`;

describe('links a commit taking in Linear\'s text added', () => {
  const roots: string[] = [];
  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function repository() {
    const root = await mkdtemp(join(tmpdir(), 'provenance-history-'));
    roots.push(root);
    const git = new Git(root, { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.com', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.com' });
    await git.run(['init', '--quiet', '--initial-branch=main']);
    await commit(git, root, { 'README.md': '# Example\n' }, 'Start');
    return { git, root };
  }

  async function commit(git: Git, root: string, files: Record<string, string | null>, message: string): Promise<string> {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) await git.run(['rm', '--quiet', '--', path]);
      else {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
        await git.run(['add', '--', path]);
      }
    }
    await git.run(['commit', '--quiet', '--allow-empty', '-m', message]);
    return (await git.text(['rev-parse', 'HEAD'])).trim();
  }

  async function takenIn(git: Git, path: string, text: string, tip: string): Promise<string[]> {
    return [...await linksTakenInFromLinear(git, tip, path, pathLinks(path, text))].sort();
  }

  const shared = '[Shared](../../public.csv)\n';
  const member = `[Copy](../../${SECRET})\n`;

  it('finds a link a capture added, and not one written in git that later captures carried over', async () => {
    const { git, root } = await repository();
    await commit(git, root, { [DOC]: `# Doc\n\n${shared}` }, 'Write the document');
    await commit(git, root, { [DOC]: `# Doc\n\n${shared}\nEdited in Linear.\n` }, CAPTURE_MESSAGE);
    const text = `# Doc\n\n${shared}\nEdited in Linear.\n\n${member}`;
    const tip = await commit(git, root, { [DOC]: text }, CAPTURE_MESSAGE);
    assert.deepEqual(await takenIn(git, DOC, text, tip), [SECRET]);
  });

  it('does not count a link written in git when a capture reverts the document to an earlier version', async () => {
    const { git, root } = await repository();
    const text = `# Doc\n\n${shared}`;
    await commit(git, root, { [DOC]: text }, 'Write the document');
    await commit(git, root, { [DOC]: `${text}\nEdited in Linear.\n` }, CAPTURE_MESSAGE);
    const tip = await commit(git, root, { [DOC]: text }, CAPTURE_MESSAGE);
    assert.deepEqual(await takenIn(git, DOC, text, tip), []);
  });

  it('finds a link the squash merge of the sync\'s pull request or an initial sync from Linear added', async () => {
    for (const message of [`${SYNC_PULL_REQUEST_TITLE} (#12)`, INITIAL_SYNC_FROM_LINEAR_RECORD]) {
      const { git, root } = await repository();
      const text = `# Doc\n\n${shared}\n${member}`;
      await commit(git, root, { [DOC]: `# Doc\n\n${shared}` }, 'Write the document');
      const tip = await commit(git, root, { [DOC]: text }, message);
      assert.deepEqual(await takenIn(git, DOC, text, tip), [SECRET], message);
    }
  });

  it('does not count a sync record, which holds what the sync wrote to Linear from git', async () => {
    const { git, root } = await repository();
    const text = `# Doc\n\n${shared}\n${member}`;
    const tip = await commit(git, root, { [DOC]: text }, PARTIAL_RECORD_MESSAGE);
    assert.deepEqual(await takenIn(git, DOC, text, tip), []);
  });

  it('does not count a capture\'s own file in the document\'s assets folder', async () => {
    const { git, root } = await repository();
    const text = `# Doc\n\n[Picture](assets/${'a'.repeat(64)}.png)\n${member}`;
    const tip = await commit(git, root, { [CAPTURED]: 'bytes', [DOC]: text }, CAPTURE_MESSAGE);
    assert.deepEqual(await takenIn(git, DOC, text, tip), [SECRET]);
  });

  it('follows the document across a rename in git', async () => {
    const { git, root } = await repository();
    const moved = 'eng/notes/renamed.md';
    const text = `# Doc\n\n${shared}\n${member}`;
    await commit(git, root, { [DOC]: `# Doc\n\n${shared}` }, 'Write the document');
    await commit(git, root, { [DOC]: text }, CAPTURE_MESSAGE);
    const tip = await commit(git, root, { [DOC]: null, [moved]: text }, 'Rename the document');
    assert.deepEqual(await takenIn(git, moved, text, tip), [SECRET]);
  });

  it('does not count links written in git that a capture moving the document carried over', async () => {
    const { git, root } = await repository();
    const moved = 'eng/plans/doc.md';
    const text = `# Doc\n\n${shared}`;
    await commit(git, root, { [DOC]: text }, 'Write the document');
    const tip = await commit(git, root, { [DOC]: null, [moved]: text }, CAPTURE_MESSAGE);
    assert.deepEqual(await takenIn(git, moved, text, tip), []);
  });

  it('reads the history from the repository root when git runs in a subfolder', async () => {
    const { git, root } = await repository();
    const text = `# Doc\n\n${member}`;
    const tip = await commit(git, root, { [DOC]: text }, CAPTURE_MESSAGE);
    const inside = new Git(join(root, 'eng'));
    assert.deepEqual(await takenIn(inside, DOC, text, tip), [SECRET]);
  });

  it('counts every link of the tracked text when a capture\'s version is too large to read', async () => {
    const { git, root } = await repository();
    const text = `# Doc\n\n${shared}\n${member}`;
    await commit(git, root, { [DOC]: text }, 'Write the document');
    await commit(git, root, { [DOC]: `${text}\n${'x'.repeat(5 * 1024 * 1024)}\n` }, CAPTURE_MESSAGE);
    const tip = await commit(git, root, { [DOC]: text }, 'Trim the document');
    assert.deepEqual(await takenIn(git, DOC, text, tip), ['public.csv', SECRET]);
  });
});
