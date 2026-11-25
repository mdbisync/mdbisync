import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Git, GitError, GitOutputLimitError } from './git.ts';
import { buildTree, checkRepoPath, isGitDirectoryName, listPaths, listTree, parseTreeListing } from './objects.ts';

// Names that open the Git directory on Windows: `.git` itself, its 8.3 short
// name `GIT~1` (and the later short names a busy folder hands out), in any
// case, with the trailing dots and spaces Windows drops from a name, with an
// NTFS stream suffix after a colon, and with code points HFS+ ignores.
const aliases = ['.git', '.GIT', '.git.', '.git .', 'git~1', 'GIT~1', 'Git~1. ', 'git~2', 'GIT~9', 'git~10', '.git:x', '.git::$INDEX_ALLOCATION', 'git~1:x', 'GIT~1 .:x', 'GIT~1:x\u2028y', 'git~1:\n', '.g\u200cit', '\ufeff.GIT', '.gi\u206at'];
// Near misses that name ordinary files.
const ordinary = ['git', 'git~', 'git~a', 'git~1x', 'git~1.md', '.git~1', '.gitignore', '.github', 'x.git', 'git1', '.git.md', 'a.git~1'];

describe('Git directory names', () => {
  it('recognizes .git and its NTFS short names', () => {
    for (const name of aliases) assert.equal(isGitDirectoryName(name), true, name);
    for (const name of ordinary) assert.equal(isGitDirectoryName(name), false, name);
  });

  it('rejects repository paths with a Git directory part anywhere', () => {
    for (const name of aliases) {
      for (const path of [name, `${name}/hooks/post-checkout`, `docs/${name}/config`, `docs/${name}`]) {
        assert.throws(() => checkRepoPath(path), /invalid repository path/, path);
      }
    }
    for (const name of ordinary) checkRepoPath(`docs/${name}/page.md`);
  });

  it('allows removing a path that names the Git directory, but not other invalid paths', () => {
    for (const name of aliases) checkRepoPath(`docs/${name}/page.md`, { removal: true });
    for (const path of ['', 'docs/../x', 'docs//x', 'a\\b']) assert.throws(() => checkRepoPath(path, { removal: true }), /invalid repository path/, path);
  });

  it('rejects every path Git itself refuses under core.protectNTFS and core.protectHFS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-path-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet']);
      const blob = await git.text(['hash-object', '-w', '--stdin'], { input: 'x\n' });
      const refused: string[] = [];
      for (const name of [...aliases, ...ordinary]) {
        const path = `docs/${name}/page.md`;
        const added = await git.run(['-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { okCodes: [0, 128] });
        if (added.code === 0) continue;
        refused.push(name);
        assert.throws(() => checkRepoPath(path), /invalid repository path/, `Git refuses ${path}`);
      }
      // The check above proves something only while Git really applies both protections.
      for (const name of ['.git', 'GIT~1', '.git:x', '.g\u200cit']) assert.ok(refused.includes(name), `Git accepted ${JSON.stringify(name)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Trees built without an index', () => {
  const IDENTITY = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.invalid' };

  /** The tree git's own index gives for `base` plus `changes`: what the builder must match. */
  async function indexTree(git: Git, base: string | null, changes: Map<string, string | null>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oracle-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      await git.run(base === null ? ['read-tree', '--empty'] : ['read-tree', `${base}^{tree}`], { env });
      const modes = new Map<string, string>();
      if (base !== null) {
        for (const record of (await git.text(['ls-tree', '-r', '-z', base])).split('\0')) {
          const tab = record.indexOf('\t');
          if (tab > 0) modes.set(record.slice(tab + 1), record.slice(0, record.indexOf(' ')));
        }
      }
      let lines = '';
      for (const [path, content] of changes) {
        if (content === null) lines += `0 ${'0'.repeat(40)}\t${path}\0`;
        else lines += `${modes.get(path) === '100755' ? '100755' : '100644'} ${await git.text(['hash-object', '-w', '--stdin'], { input: content })}\t${path}\0`;
      }
      if (lines !== '') await git.run(['update-index', '-z', '--index-info'], { input: lines, env });
      return await git.text(['write-tree'], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes a tree object exactly as given, unchecked: entries are `[mode, name, oid]`. */
  async function rawTree(git: Git, entries: [string, string, string][]): Promise<string> {
    const content = Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')])));
    return git.text(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], { input: content });
  }

  it('gives the tree git’s own index gives, for ordinary and unusual bases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'build-tree-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet', '--bare']);
      const blob = (text: string) => git.text(['hash-object', '-w', '--stdin'], { input: text });
      const [a, b, c] = await Promise.all([blob('a\n'), blob('b\n'), blob('c\n')]) as [string, string, string];
      const empty = await rawTree(git, []);
      const commit = await git.text(['commit-tree', empty, '-m', 'sub'], { env: IDENTITY });
      const deep = await rawTree(git, [['100644', 'leaf.md', a], ['100755', 'run.sh', b]]);
      const onlyEmpty = await rawTree(git, [['40000', 'nothing', empty]]);
      const docs = await rawTree(git, [['100644', 'guide.md', a], ['40000', 'deep', deep], ['120000', 'link', c]]);
      const odd = await rawTree(git, [['100644', 'ok.md', a], ['100664', 'odd-mode.md', b]]);
      const ordinary = await rawTree(git, [['100644', 'README.md', a], ['40000', 'docs', docs], ['40000', 'odd', odd], ['100755', 'tool', b], ['160000', 'vendor', commit]]);
      const withEmpty = await rawTree(git, [['100644', 'a.md', a], ['40000', 'docs', docs], ['40000', 'empty', empty], ['40000', 'hollow', onlyEmpty]]);
      const oddRoot = await rawTree(git, [['100664', 'a.md', a], ['40000', 'docs', docs], ['40000', 'odd', odd]]);
      const unsorted = await rawTree(git, [['100644', 'b.md', b], ['100644', 'a.md', a]]);
      const duplicate = await rawTree(git, [['100644', 'a.md', a], ['100644', 'a.md', b]]);
      const fileAndFolder = await rawTree(git, [['100644', 'a', a], ['100644', 'a.md', b], ['40000', 'a', deep]]);

      const cases: [string | null, Map<string, string | null>][] = [
        [null, new Map()],
        [null, new Map([['a.md', 'x\n'], ['docs/new/page.md', 'y\n'], ['z.md', null]])],
        [ordinary, new Map()],
        [ordinary, new Map([['README.md', 'new\n']])],
        [ordinary, new Map([['tool', 'still executable\n'], ['docs/link', 'no longer a link\n'], ['vendor', 'no longer a submodule\n']])],
        [ordinary, new Map([['docs/deep/leaf.md', 'changed\n'], ['docs/deep/run.sh', null], ['docs/added/one.md', '1\n']])],
        [ordinary, new Map([['docs/deep/leaf.md', null], ['docs/deep/run.sh', null]])],
        [ordinary, new Map([['missing.md', null], ['docs/missing/x.md', null], ['README.md/below.md', null]])],
        [ordinary, new Map([['tool', 'still executable\n']])],
        [ordinary, new Map([['docs/guide.md', 'beside a folder with an odd mode\n']])],
        [ordinary, new Map([['odd/ok.md', 'beside a file with an odd mode\n']])],
        [ordinary, new Map([['odd/odd-mode.md', 'changed\n']])],
        [ordinary, new Map([['README.md', 'a\n']])],
        [withEmpty, new Map([['a.md', 'x\n']])],
        [withEmpty, new Map([['docs/guide.md', 'x\n']])],
        [withEmpty, new Map([['hollow/nothing/x.md', 'x\n']])],
        [oddRoot, new Map([['docs/guide.md', 'x\n']])],
        [unsorted, new Map([['c.md', 'x\n']])],
        [duplicate, new Map([['c.md', 'x\n']])],
        [fileAndFolder, new Map([['b.md', 'x\n']])],
        // A file where a folder is, a folder where a file is, and a removed folder.
        [ordinary, new Map([['docs', 'now a file\n']])],
        [ordinary, new Map([['README.md/inner.md', 'now a folder\n']])],
        [ordinary, new Map([['vendor/inner.md', 'inside a submodule\n']])],
        [ordinary, new Map([['docs', null]])],
        [ordinary, new Map([['x', 'file\n'], ['x/y.md', 'and folder\n']])],
        [ordinary, new Map([['naïve name with spaces.md', 'x\n'], ['docs/ünïcode/ok.md', 'y\n'], ['docs/deep.md', 'sorts before the folder\n']])],
      ];
      for (const [base, changes] of cases) {
        const label = `${base} ${JSON.stringify([...changes])}`;
        let expected: string | Error;
        try {
          expected = await indexTree(git, base, changes);
        } catch (error) {
          expected = error as Error;
        }
        if (expected instanceof Error) await assert.rejects(buildTree(git, base, changes), label);
        else assert.equal(await buildTree(git, base, changes), expected, label);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Trees listed through the object reader', () => {
  it('list what git ls-tree lists, and stop at the same output limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'list-tree-'));
    try {
      const git = new Git(dir);
      await git.run(['init', '--quiet', '--bare']);
      const blob = (text: string) => git.text(['hash-object', '-w', '--stdin'], { input: text });
      const raw = async (entries: [string, string, string][]) => {
        const content = Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')])));
        return git.text(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], { input: content });
      };
      const [a, b] = await Promise.all([blob('a\n'), blob('b'.repeat(12345678))]);
      const empty = await raw([]);
      const commit = await git.text(['commit-tree', empty, '-m', 'sub'], { env: { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.invalid' } });
      // Entries in git's order, as git writes them: git reads trees in any other order its own way.
      const inner = await raw([['100644', 'README.md', a], ['40000', 'empty', empty], ['100755', 'run.sh', b]]);
      const tree = await raw([
        ['100644', 'README.md', a], ['100644', 'a.md', a], ['40000', 'a', inner], ['120000', 'link', a],
        ['100664', 'odd.md', b], ['160000', 'vendor', commit], ['100644', 'zz', '0'.repeat(40)], ['40000', 'ünï cöde', inner],
      ]);
      const lsTree = async (args: string[]) => (await git.run(['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', tree, ...args])).stdout;

      const all = await git.run(['ls-tree', '-r', '-z', '-l', '--full-tree', tree]);
      assert.deepEqual(await listTree(git, tree), parseTreeListing(all.stdout));
      assert.deepEqual(await listTree(git, tree, all.stdout.length), parseTreeListing(all.stdout));
      await assert.rejects(listTree(git, tree, all.stdout.length - 1), GitOutputLimitError);

      const paths = ['a/README.md', 'README.md', 'ünï cöde', 'vendor', 'missing.md', 'a/missing/x.md', 'a.md/x', 'ünï cöde/run.sh', 'a.md', 'link', 'odd.md', 'zz', 'README.md'];
      for (const asked of [paths, paths.filter((path) => path !== 'ünï cöde'), ['a', 'a.md'], ['README.md']]) {
        const some = await lsTree(['--', ...asked]);
        assert.deepEqual(await listPaths(git, tree, asked), parseTreeListing(some), asked.join(', '));
        assert.deepEqual(await listPaths(git, tree, asked, some.length), parseTreeListing(some));
        await assert.rejects(listPaths(git, tree, asked, some.length - 1), GitOutputLimitError);
      }
      await assert.rejects(listTree(git, 'refs/heads/none'), GitError);

      // A listing over its limit stops reading the trees it has not reached.
      const folders = await Promise.all(Array.from({ length: 50 }, (_, index) => raw([['100644', `file-${index}.md`, a]])));
      const wide = await raw(folders.map((folder, index): [string, string, string] => ['40000', `folder-${String(index).padStart(2, '0')}`, folder]));
      let reads = 0;
      const readObject = git.readObject.bind(git);
      git.readObject = (name) => { reads++; return readObject(name); };
      await assert.rejects(listTree(git, wide, 100), GitOutputLimitError);
      assert.ok(reads <= 3, `${reads} trees read for a listing stopped at its first files`);
      await assert.rejects(listPaths(git, a, ['x']), GitError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
