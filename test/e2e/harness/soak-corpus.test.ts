import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runFix } from '../../../src/format/command.ts';
import { Git } from '../../../src/state/index.ts';
import { buildCorpus } from '../../corpus/generate.ts';
import { buildRunTree, parseManifest, type Manifest } from './corpus.ts';
import { runNames } from './isolation.ts';
import { relinkRunTree } from './run-links.ts';
import { Sandbox } from './sandbox.ts';
import { soakRunTree } from './soak-corpus.ts';

function put(root: string, path: string, text: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test('the mid soak baseline passes the all-files formatter without removing negative fixtures from other scenarios', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-corpus-'));
  try {
    const corpus = buildCorpus('0'.repeat(40));
    const texts = new Map(corpus.files.filter((file) => file.kind === 'markdown').map((file) => [file.path, file.content.toString()]));
    const readmes = new Map([...texts].filter(([path]) => /(^|\/)README\.md$/.test(path)));
    const original = relinkRunTree(buildRunTree({ slice: 'mid', paths: corpus.slices.mid }, readmes, runNames('abcdef')), texts);
    const byPath = new Map(corpus.files.map((file) => [file.path, file]));
    const materialize = (dir: string, paths: ReadonlyMap<string, string>, rewritten: ReadonlyMap<string, string>) => {
      for (const [target, source] of paths) put(dir, target, rewritten.get(target) ?? byPath.get(source)!.content);
    };
    const before = join(root, 'before');
    materialize(before, original.paths, original.rewritten);
    const failed = runFix(['.'], before);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stdout, /footnote:|image-title:/);

    const clean = soakRunTree(original, parseManifest(JSON.stringify(corpus.manifest)), texts);
    const negative = new Set(corpus.manifest.files.filter((file) => file.class === 'lint-error').map((file) => file.path));
    assert.ok([...original.paths.values()].some((source) => negative.has(source)));
    assert.deepEqual([...clean.paths], [...original.paths].filter(([, source]) => !negative.has(source)));
    const after = join(root, 'after');
    materialize(after, clean.paths, clean.rewritten);
    assert.deepEqual(runFix(['.'], after), { exitCode: 0, stdout: '', stderr: '' });
    // The same hook checks every edit; tokens are ordinary paragraphs and survive.
    const targets = [...clean.paths].filter(([, source]) => source.endsWith('.md') && !source.endsWith('README.md') && !negative.has(source)).slice(0, 24);
    assert.equal(targets.length, 24);
    for (const [index, [target, source]] of targets.entries()) {
      put(after, target, `${clean.rewritten.get(target) ?? texts.get(source)}\n\nReview note edit-${index + 1}.`);
    }
    assert.deepEqual(runFix(['.'], after), { exitCode: 0, stdout: '', stderr: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the soak branch omits declared negative fixtures, and unexplained lint still blocks setup before push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-branch-'));
  try {
    const remote = join(root, 'remote.git');
    await new Git(root).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    const seed = new Git(join(root, 'seed'), { GIT_AUTHOR_NAME: 'Test Editor', GIT_AUTHOR_EMAIL: 'editor@example.com', GIT_COMMITTER_NAME: 'Test Editor', GIT_COMMITTER_EMAIL: 'editor@example.com' });
    await new Git(root).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    const documents = { 'eng/README.md': '---\nlinear-team: ENG\n---\n', 'eng/note.md': '# Note\n\nReady.', 'eng/footnote.md': '# Note\n\nA note[^1].\n\n[^1]: detail' };
    const manifest: Manifest = { seed: 'test', files: Object.keys(documents).map((path) => ({ path, group: 'notes', kind: 'markdown', synced: true, lfs: false, canary: null, class: path.endsWith('footnote.md') ? 'lint-error' : 'unchanged', rule: path.endsWith('footnote.md') ? 'footnote' : null })) };
    for (const [path, text] of Object.entries(documents)) put(seed.dir, `corpus/${path}`, text);
    put(seed.dir, 'corpus-slices/mid.json', JSON.stringify({ slice: 'mid', paths: Object.keys(documents) }));
    put(seed.dir, 'corpus-slices/manifest.json', JSON.stringify(manifest));
    await seed.run(['add', '--', 'corpus', 'corpus-slices']);
    await seed.run(['commit', '--quiet', '-m', 'Test corpus']);
    await seed.run(['push', '--quiet', remote, 'main']);
    const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir: join(root, 'state'), runId: 'abcdef' });
    await sandbox.refreshCache();
    const normal = await sandbox.createTrackedBranch('mid', runNames('aaaaaa'));
    assert.ok([...normal.tree.paths.values()].includes('eng/footnote.md'));
    let validated = false;
    const soak = await sandbox.createTrackedBranch('mid', runNames('bbbbbb'), { soak: true, validate: async (slice) => {
      assert.ok(slice.paths.includes('eng/footnote.md'), 'validate the original corpus before selection');
      validated = true;
    } });
    assert.ok(validated);
    assert.ok(![...soak.tree.paths.values()].includes('eng/footnote.md'));
    assert.match(await new Git(remote).text(['show', `${soak.commit}:eng/bbbbbb/note.md`]), /Ready/);
    // An incorrect manifest cannot silently drop an unexpected failure.
    manifest.files.find((file) => file.path.endsWith('footnote.md'))!.class = 'unchanged';
    put(seed.dir, 'corpus-slices/manifest.json', JSON.stringify(manifest));
    await seed.run(['add', '--', 'corpus-slices/manifest.json']);
    await seed.run(['commit', '--quiet', '-m', 'Incorrect expectation']);
    await seed.run(['push', '--quiet', remote, 'main']);
    await sandbox.refreshCache();
    await assert.rejects(sandbox.createTrackedBranch('mid', runNames('cccccc'), { soak: true }), /soak corpus is not format-clean: .*footnote/);
    assert.equal((await new Git(remote).run(['show-ref', '--verify', '--quiet', 'refs/heads/t/cccccc/main'], { okCodes: [0, 1] })).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
