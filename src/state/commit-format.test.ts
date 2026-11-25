import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { showCommit } from './commit-format.ts';
import { Git } from './git.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'Author Name', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@example.invalid' };

describe('Commit fields read from the commit object', () => {
  it('match what git show prints, for unusual messages and commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commit-format-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet', '--bare']);
      const tree = await git.text(['mktree'], { input: '' });
      const commit = (message: string, parents: string[] = [], config: string[] = []) =>
        git.text([...config, 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'], { input: message, env: IDENTITY });
      const raw = (content: string) => git.text(['hash-object', '-w', '-t', 'commit', '--literally', '--stdin'], { input: content });
      const root = await commit('Root\n');
      const other = await commit('Other\n');
      const names = [
        root,
        await commit('Subject\n\nBody line\n', [root]),
        await commit('Merge\n', [root, other]),
        await commit('\n\n  \nAfter blank lines  \nsecond subject line\t\n\nbody\n', [root]),
        await commit('Windows\r\nline\r\n\r\nbody\r\n', [root]),
        await commit('Trailer only\n\nKey: value\n', [root]),
        await raw(`tree ${tree}\nauthor Author <a@example.invalid> 1 +0000\ncommitter C <c@example.invalid> 1 +0000\n\nno final newline`),
        await raw(`tree ${tree}\nauthor Author <a@example.invalid> 1 +0000\ncommitter C <c@example.invalid> 1 +0000\nencoding ISO-8859-1\n\nLatin \xe9\n`),
        await commit('Unicode — subject ✓\n', [root]),
        // Headers out of git's order, or given twice: git reads them its own way.
        await raw(`tree ${tree}\nauthor Author <a@example.invalid> 1 +0000\ncommitter C <c@example.invalid> 1 +0000\nparent ${root}\n\nParent after the committer\n`),
        await raw(`tree ${tree}\nparent ${root}\nauthor First <first@example.invalid> 1 +0000\nauthor Second <second@example.invalid> 1 +0000\ncommitter C <c@example.invalid> 1 +0000\n\nTwo authors\n`),
        `${root}^{commit}`,
        'refs/heads/none',
      ];
      await git.run(['tag', '-a', '-m', 'tag message', 'annotated', root], { env: IDENTITY });
      names.push('annotated');
      for (const name of names) {
        for (const format of ['%T', '%P', '%B', '%s', '%ae', '%T%n%P', '%T %P%n%B', '%s%n%ae%n%P', 'literal %% sign']) {
          let expected: string | Error;
          try {
            expected = await git.text(['show', '-s', `--format=${format}`, name]);
          } catch (error) {
            expected = error as Error;
          }
          if (expected instanceof Error) await assert.rejects(showCommit(git, format, name), `${name} ${format}`);
          else assert.equal(await showCommit(git, format, name), expected, `${name} ${format}`);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves messages to git when the repository sets another message encoding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commit-format-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet', '--bare']);
      await git.run(['config', 'i18n.logOutputEncoding', 'ISO-8859-1']);
      const tree = await git.text(['mktree'], { input: '' });
      const oid = await git.text(['commit-tree', tree, '-m', 'Accent é'], { env: IDENTITY });
      assert.equal(await git.plainMessages(), false);
      assert.equal(await showCommit(git, '%s', oid), await git.text(['show', '-s', '--format=%s', oid]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves parents to git in a shallow repository, whose boundary commits show none', async () => {
    const source = await mkdtemp(join(tmpdir(), 'commit-format-'));
    const shallow = await mkdtemp(join(tmpdir(), 'commit-format-'));
    try {
      const git = new Git(source);
      await git.run(['init', '--quiet', '--bare', '--initial-branch=main']);
      const tree = await git.text(['mktree'], { input: '' });
      const first = await git.text(['commit-tree', tree, '-m', 'First'], { env: IDENTITY });
      const second = await git.text(['commit-tree', tree, '-p', first, '-m', 'Second'], { env: IDENTITY });
      await git.run(['update-ref', 'refs/heads/main', second]);
      const clone = new Git(shallow);
      await clone.run(['clone', '--quiet', '--bare', '--depth', '1', `file://${source}`, shallow]);
      assert.equal(await clone.rewritesHistory(), true);
      assert.equal(await git.rewritesHistory(), false);
      for (const format of ['%P', '%T %P%n%B', '%s%n%ae%n%P']) {
        assert.equal(await showCommit(clone, format, second), await clone.text(['show', '-s', `--format=${format}`, second]), format);
      }
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(shallow, { recursive: true, force: true });
    }
  });
});
