import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Git } from '../../../src/state/index.ts';
import { DEFAULT_BANK, inLinearForm } from '../../corpus/generate.ts';
import { copyBank } from '../../corpus/bank.ts';
import { Canaries } from '../../corpus/model.ts';
import { closure } from '../../corpus/slices.ts';
import { treeFiles } from '../../corpus/tree.ts';
import { Rng } from '../../corpus/rng.ts';
import { assertCurrentCorpus } from './corpus-drift.ts';
import { selectTeams, type Manifest } from './corpus.ts';
import { runNames } from './isolation.ts';
import { classify } from './results.ts';
import { Sandbox } from './sandbox.ts';

test('stale corpus is env-blocked before any setup write; current slices are admitted', async () => {
  const canaries = new Canaries(() => 'kx-12345678');
  const bank = copyBank(DEFAULT_BANK, canaries);
  const rng = new Rng('guard-canaries');
  const files = [...bank.files, ...treeFiles(new Rng('guard'), new Canaries(() => rng.hex(8)), 'a'.repeat(40))];
  inLinearForm(files, DEFAULT_BANK);
  const paths = closure(files, bank.files.map((file) => file.path));
  const corpus = { files, slices: { bank: paths } };
  const manifest: Manifest = { seed: 'guard', files: files.map((file) => ({
    path: file.path, group: file.group, kind: file.kind, synced: file.synced,
    lfs: false, canary: file.canary, class: file.expected, rule: file.rule,
  })) };
  const read = async (path: string) => files.find((file) => file.path === path)?.content.toString() ?? null;
  await assertCurrentCorpus(manifest, { slice: 'bank', paths }, read);
  const readmes = new Map(files.filter((file) => /(^|\/)README\.md$/.test(file.path))
    .map((file) => [file.path, file.content.toString()]));
  const eng = selectTeams({ slice: 'bank', paths }, readmes, ['ENG']);
  await assertCurrentCorpus(manifest, eng, read, ['ENG']);

  const root = mkdtempSync(join(tmpdir(), 'corpus-drift-'));
  try {
    const remote = join(root, 'sandbox.git');
    await new Git(root).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    const seed = new Git(join(root, 'seed'), {
      GIT_AUTHOR_NAME: 'Test Editor', GIT_AUTHOR_EMAIL: 'editor@example.com',
      GIT_COMMITTER_NAME: 'Test Editor', GIT_COMMITTER_EMAIL: 'editor@example.com',
    });
    await new Git(root).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    const missing = corpus.slices.bank.find((path) => path.endsWith('tables/table-header-hash.md'))!;
    const changed = corpus.slices.bank.find((path) => path.endsWith('images/remote.md'))!;
    assert.ok(missing && changed);
    const stale = structuredClone(manifest);
    const entry = stale.files.find((file) => file.path === changed)!;
    entry.class = 'unchanged';
    entry.rule = null;
    stale.files = stale.files.filter((file) => file.path !== missing);
    const paths = corpus.slices.bank.filter((path) => path !== missing);
    for (const path of paths) {
      mkdirSync(dirname(join(seed.dir, 'corpus', path)), { recursive: true });
      writeFileSync(join(seed.dir, 'corpus', path), corpus.files.find((file) => file.path === path)!.content);
    }
    mkdirSync(join(seed.dir, 'corpus-slices'));
    writeFileSync(join(seed.dir, 'corpus-slices', 'manifest.json'), JSON.stringify(stale));
    writeFileSync(join(seed.dir, 'corpus-slices', 'bank.json'), JSON.stringify({ slice: 'bank', paths }));
    await seed.run(['add', '--', 'corpus', 'corpus-slices']);
    await seed.run(['commit', '--quiet', '-m', 'Corpus']);
    await seed.run(['push', '--quiet', '--no-verify', remote, 'main']);
    const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir: join(root, 'state'), runId: 'abcdef' });
    await sandbox.refreshCache();
    const before = await new Git(remote).text(['show-ref']);
    const published = await sandbox.manifest();
    await assert.rejects(sandbox.createTrackedBranch('bank', runNames('abcdef'), {
      validate: (selected) => assertCurrentCorpus(published, selected, (path) => sandbox.readMain(`corpus/${path}`)),
    }), (error: unknown) => {
      const outcome = classify(error, false);
      assert.equal(outcome.result, 'env-blocked');
      assert.ok(outcome.reason?.includes(missing));
      assert.ok(outcome.reason?.includes(changed));
      assert.match(outcome.reason!, /republish the corpus/);
      return true;
    });
    assert.equal(await new Git(remote).text(['show-ref']), before, 'no setup ref was written');
    const wrongRule = structuredClone(manifest);
    wrongRule.files.find((file) => file.path === changed)!.rule = 'image-file-missing';
    await assert.rejects(assertCurrentCorpus(wrongRule, { slice: 'bank', paths: corpus.slices.bank }, read), /republish the corpus/);
    // A corrected publication reaches the same branch-creation path.
    mkdirSync(dirname(join(seed.dir, 'corpus', missing)), { recursive: true });
    writeFileSync(join(seed.dir, 'corpus', missing), files.find((file) => file.path === missing)!.content);
    writeFileSync(join(seed.dir, 'corpus-slices', 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(seed.dir, 'corpus-slices', 'bank.json'), JSON.stringify({ slice: 'bank', paths: corpus.slices.bank }));
    await seed.run(['add', '--', 'corpus', 'corpus-slices']);
    await seed.run(['commit', '--quiet', '-m', 'Refresh corpus']);
    await seed.run(['push', '--quiet', '--no-verify', remote, 'main']);
    await sandbox.refreshCache();
    const current = await sandbox.manifest();
    const created = await sandbox.createTrackedBranch('bank', runNames('abcdef'), {
      validate: (selected) => assertCurrentCorpus(current, selected, (path) => sandbox.readMain(`corpus/${path}`)),
    });
    assert.equal((await new Git(remote).text(['rev-parse', 'refs/heads/t/abcdef/main'])).trim(), created.commit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('current linter catches drift even when bank classifications have not changed', async () => {
  const file = { path: 'eng/notes.md', group: 'work-documents', kind: 'markdown' as const,
    synced: true, lfs: false, canary: null, class: 'unchanged' as const, rule: null };
  const manifest: Manifest = { seed: 'guard', files: [file] };
  const slice = { slice: 'mini', paths: [file.path] };
  const read = async () => '# Notes\n\n![Chart](https://images.example.com/chart.png)';
  await assert.rejects(assertCurrentCorpus(manifest, slice, read), /eng\/notes\.md; republish the corpus/);
  manifest.files[0] = { ...file, class: 'lint-error', rule: 'image-not-in-repository' };
  await assertCurrentCorpus(manifest, slice, read);
  await assert.rejects(assertCurrentCorpus(manifest, slice, async () => '# Notes'), /republish the corpus/);
});

test('sampled duplicate expectations retain corpus scope and linked files must be selected', async () => {
  const file = { path: 'eng/Guide.md', group: 'work-documents', kind: 'markdown' as const,
    synced: true, lfs: false, canary: null, class: 'lint-error' as const, rule: 'duplicate-title' };
  const manifest: Manifest = { seed: 'guard', files: [file, { ...file, path: 'eng/guide.md' }] };
  await assertCurrentCorpus(manifest, { slice: 'mini', paths: [file.path] }, async () => '# Guide');
  manifest.files = [{ ...file, class: 'unchanged', rule: null }, {
    ...file, path: 'docs/chart.png', kind: 'image', synced: false, class: null, rule: null,
  }];
  const read = async () => '# Guide\n\n![Chart](../docs/chart.png)';
  await assert.rejects(assertCurrentCorpus(manifest, { slice: 'mini', paths: [file.path] }, read), /republish the corpus/);
  await assertCurrentCorpus(manifest, { slice: 'mini', paths: [file.path, 'docs/chart.png'] }, read);
});
