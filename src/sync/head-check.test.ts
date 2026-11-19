import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { type Zone } from '../mapping/index.ts';
import { createFixture } from '../state/test-helpers.ts';
import { isSyncedChange, keepsAnnotation, keepsRegularMode, oneLine, unverifiedList, unverifiedPaths } from './head-check.ts';
import { UPLOAD_EXTENSIONS } from './upload-type.ts';

const zones = new Map<string, Zone>([['eng', { team: 'ENG', teamFolder: 'eng' }]]);

it('merges documents and the asset types the sync writes, as regular files under an annotated folder', () => {
  for (const path of ['eng/plan.md', 'eng/notes/plan.md', 'eng/notes/0a1b.png', 'eng/notes/clip.webm', 'eng/README.md']) {
    assert.equal(isSyncedChange(path, '100644', zones), true, path);
  }
  assert.equal(isSyncedChange('eng/plan.md', '000000', zones), true, 'a removed document');
  assert.equal(isSyncedChange('eng/plan.md', '100755', zones), true, 'an executable bit changes nothing GitHub runs');
});

it('leaves every other change to a person', () => {
  for (const [path, mode] of [
    ['plan.md', '100644'], ['docs/plan.md', '100644'],
    ['eng/.github/workflows/ci.md', '100644'], ['eng/.GitHub/copilot-instructions.md', '100644'], ['.github/workflows/ci.yml', '100644'],
    ['eng/build.sh', '100644'], ['eng/package.json', '100644'], ['eng/Makefile', '100644'], ['eng/notes.md.sh', '100644'],
    ['eng/plan.md', '120000'], ['eng/plan.md', '160000'],
    ['eng/payload.MD', '100644'], ['eng/x.Md', '100644'], ['eng/.md', '100644'], ['eng/a.PNG', '100644'], ['eng/.png', '100644'],
  ] as const) {
    assert.equal(isSyncedChange(path, mode, zones), false, `${path} ${mode}`);
  }
});

it('keeps actual GitHub folders protected under a root mapping, including removals', () => {
  const root = new Map<string, Zone>([['', { team: 'ENG', teamFolder: '' }]]);
  for (const mode of ['100644', '000000']) {
    for (const path of ['.github/workflows/ci.yml', '.GitHub/copilot-instructions.md', 'nested/.GITHUB/page.md']) {
      assert.equal(isSyncedChange(path, mode, root), false, `${path} ${mode}`);
    }
    assert.equal(isSyncedChange('%2Egithub/page.md', mode, root), true);
  }
});

it('merges a regular file added, edited or removed, and leaves any other mode change to a person', () => {
  for (const [before, after] of [['000000', '100644'], ['100644', '100644'], ['100644', '000000'], ['100755', '100755'], ['000000', '100755'], ['100755', '000000']] as const) {
    assert.equal(keepsRegularMode(before, after), true, `${before} -> ${after}`);
  }
  for (const [before, after] of [
    ['120000', '000000'], ['120000', '100644'], ['160000', '000000'], ['160000', '100644'], ['100644', '120000'], ['000000', '160000'],
    ['100644', '100755'], ['100755', '100644'], ['040000', '100644'], ['', '100644'],
  ] as const) {
    assert.equal(keepsRegularMode(before, after), false, `${before} -> ${after}`);
  }
});

it('lists a removed or replaced symbolic link or submodule and an executable-bit flip between real trees, and no ordinary edit', async () => {
  const fixture = await createFixture();
  const git = fixture.remote;
  const env = { GIT_INDEX_FILE: join(fixture.root, 'head-check.index') };
  const blob = (text: string) => git.text(['hash-object', '-w', '--stdin'], { input: text });
  type Entries = Record<string, readonly [mode: string, oid: string]>;
  /** A tree holding exactly `entries`, written through a scratch index. */
  const tree = async (entries: Entries) => {
    await git.run(['read-tree', '--empty'], { env });
    const info = Object.entries(entries).map(([path, [mode, oid]]) => `${mode} ${oid}\t${path}\n`).join('');
    await git.run(['update-index', '--add', '--index-info'], { env, input: info });
    return git.text(['write-tree'], { env });
  };
  const readme = (body: string) => blob(`---\nlinear-team: ENG\n---\n\n# Engineering\n\n${body}\n`);
  const plan = await blob('# Plan\n');
  const target = await blob('plan.md');
  const submodule = target; // A gitlink names another repository's commit; git does not look it up, so any id of this format will do.
  const base: Entries = {
    'eng/README.md': ['100644', await readme('Notes.')], 'eng/plan.md': ['100644', plan], 'eng/old.md': ['100644', plan],
    'eng/link.md': ['120000', target], 'eng/gone.md': ['120000', target],
    'eng/vendor.png': ['160000', submodule], 'eng/module.md': ['160000', submodule], 'eng/run.md': ['100644', plan],
  };
  const before = await tree(base);

  const { 'eng/old.md': _old, ...kept } = base;
  const ordinary = await tree({
    ...kept,
    'eng/README.md': ['100644', await readme('Edited in Linear.')],
    'eng/plan.md': ['100644', await blob('# Plan\n\nEdited.\n')],
    'eng/new.md': ['100644', plan], 'eng/new.png': ['100644', await blob('png bytes')],
  });
  assert.deepEqual(await unverifiedPaths(git, before, ordinary, zones), [], 'documents added, edited and removed, and a README body edit');

  const { 'eng/README.md': _readme, ...unannotated } = base;
  const readmes = await tree({
    ...unannotated,
    'eng/plain/README.md': ['100644', await blob('# Plain\n')],
    'eng/moved/README.md': ['100644', await blob('---\nlinear-project: Other\n---\n')],
  });
  assert.deepEqual(await unverifiedPaths(git, before, readmes, zones), ['eng/README.md', 'eng/moved/README.md'], 'an annotation removed or added, and not a plain README');

  const { 'eng/gone.md': _gone, 'eng/vendor.png': _vendor, ...rest } = base;
  const changed = await tree({
    ...rest,
    'eng/link.md': ['100644', await blob('# Replaced\n')],
    'eng/module.md': ['100644', plan],
    'eng/run.md': ['100755', plan],
  });
  assert.deepEqual(await unverifiedPaths(git, before, changed, zones), ['eng/gone.md', 'eng/link.md', 'eng/module.md', 'eng/run.md', 'eng/vendor.png']);
});

it("leaves a change of a folder's Linear annotation to a person, and merges a README's other edits", () => {
  const readme = (team: string, body = 'Notes.') => `---\nlinear-team: ${team}\n---\n\n# Engineering\n\n${body}\n`;
  assert.equal(keepsAnnotation('eng/README.md', readme('ENG'), readme('ENG', 'Edited in Linear.')), true);
  assert.equal(keepsAnnotation('eng/README.md', '# Plain\n', '# Plain, edited\n'), true);
  assert.equal(keepsAnnotation('eng/README.md', readme('ENG'), readme('OPS')), false);
  assert.equal(keepsAnnotation('eng/README.md', readme('ENG'), null), false, 'removing an annotated README');
  assert.equal(keepsAnnotation('eng/sub/README.md', null, '---\nlinear-project: Other\n---\n'), false, 'a new annotation below');
  assert.equal(keepsAnnotation('eng/sub/README.md', null, '# Sub\n'), true, 'a new README without one');
});

it('names at most twenty files, each on one line in its own code span', () => {
  const many = Array.from({ length: 25 }, (_, i) => `x/${i}.sh`);
  assert.match(unverifiedList(many), /`x\/19\.sh` and 5 more$/);
  assert.equal(unverifiedList(['a`b\n::error::c.sh']), '`a?b?::error::c.sh`');
  assert.equal(oneLine('a\r\n<!-- note -->'), 'a??<!-- note -->');
});

it('allows every extension the upload type check gives, and no other', async () => {
  const source = await readFile(new URL('./upload-type.ts', import.meta.url), 'utf8');
  const given = new Set([...source.matchAll(/return '(\.[a-z0-9]+)'/g)].map((match) => match[1]));
  given.add(source.includes("? '.svg'") ? '.svg' : '');
  given.delete('');
  assert.deepEqual([...UPLOAD_EXTENSIONS].sort(), [...given].sort());
});
