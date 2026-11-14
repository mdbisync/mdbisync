import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { type Zone } from '../mapping/index.ts';
import { isSyncedChange, keepsAnnotation, oneLine, unverifiedList } from './head-check.ts';
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
