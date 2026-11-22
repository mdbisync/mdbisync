import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { listTree, type TreeEntry } from '../state/objects.ts';
import { createFixture } from '../state/test-helpers.ts';
import { MAPPING_FILE_BYTES } from './blobs.ts';
import {
  type RepositoryMapping,
  candidateFiles,
  collectAnnotations,
  findFrontMatter,
  loadMapping,
  mapFiles,
  readAnnotation,
  resolveZones,
} from './index.ts';

type Files = Record<string, string | Buffer | { symlink: string }>;

/** Maps an in-memory tree the way `loadMapping` maps a commit. */
function mapTree(files: Files): RepositoryMapping {
  const entries: TreeEntry[] = [];
  const blobs = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(files)) {
    const bytes = typeof value === 'object' && 'symlink' in value ? Buffer.from(value.symlink) : Buffer.from(value);
    const oid = createHash('sha1').update(path).update(bytes).digest('hex');
    blobs.set(oid, bytes);
    const mode = typeof value === 'object' && 'symlink' in value ? '120000' : '100644';
    entries.push({ path, mode, type: 'blob', oid, size: bytes.length });
  }
  const readmes = new Map(entries.filter((entry) => /(^|\/)README\.md$/.test(entry.path)).map((entry) => [entry.path, (blobs.get(entry.oid) as Buffer).toString('utf8')]));
  const { annotations, problems: readProblems } = collectAnnotations(readmes);
  const { zones, problems } = resolveZones(annotations);
  const wanted = new Set(candidateFiles(entries, zones).map((entry) => entry.oid));
  const contents = new Map([...blobs].filter(([oid]) => wanted.has(oid)));
  return { annotations, zones, problems: [...readProblems, ...problems], ...mapFiles(entries, zones, contents) };
}

const team = (name: string) => `---\nlinear-team: ${name}\n---\n\n# Team\n`;
const project = (name: string) => `---\nlinear-project: ${name}\n---\n\n# Project\n`;

function summary(mapping: RepositoryMapping) {
  return Object.fromEntries(
    mapping.documents.map((document) => [
      document.path,
      `${document.place.kind === 'project' ? `${document.place.team}/${document.place.project}` : `${document.place.team} (team)`}: ${document.title}`,
    ]),
  );
}

describe('front matter', () => {
  it('finds the block after an optional byte order mark and ends at the closing fence', () => {
    assert.deepEqual(findFrontMatter('---\na: 1\n---\nbody'), { yaml: 'a: 1\n' });
    assert.equal(findFrontMatter('﻿---\r\na: 1\r\n---\r\n\r\n# Body\n')?.yaml, 'a: 1\r\n');
    // Only `---` closes front matter, as in the format module that strips it before Linear.
    assert.equal(findFrontMatter('---\nlinear-team: ENG\n...\n# Team\n'), null);
    assert.equal(findFrontMatter('---\n---\n')?.yaml, '');
    assert.equal(findFrontMatter('# Title\n---\na: 1\n---\n'), null);
    assert.equal(findFrontMatter('---\na: 1\n'), null);
  });
});

describe('annotations', () => {
  it('reads team and project names from README front matter', () => {
    assert.deepEqual(readAnnotation('eng/README.md', team('ENG')), { annotation: { folder: 'eng', readme: 'eng/README.md', team: 'ENG' } });
    assert.deepEqual(readAnnotation('README.md', '---\nlinear-team: " Docs "\nlinear-project: Field notes\n---\n'), {
      annotation: { folder: '', readme: 'README.md', team: 'Docs', project: 'Field notes' },
    });
  });

  it('ignores README files without annotation keys, and front matter that is not about annotations', () => {
    assert.deepEqual(readAnnotation('a/README.md', '# Plain\n'), { annotation: null });
    assert.deepEqual(readAnnotation('a/README.md', '---\ntitle: Notes\n---\n'), { annotation: null });
    assert.deepEqual(readAnnotation('a/README.md', '---\n: : bad yaml [\n---\n'), { annotation: null });
    assert.deepEqual(readAnnotation('a/README.md', '---\n- a list\n---\n'), { annotation: null });
  });

  it('parses front matter without printing parser warnings, which quote content', () => {
    const warnings: string[] = [];
    const listener = (warning: Error) => warnings.push(warning.message);
    process.on('warning', listener);
    try {
      const result = readAnnotation('eng/README.md', '---\nsecret: !private kx-0badc0de\nlinear-team: ENG\n---\n');
      assert.deepEqual(result, { annotation: { folder: 'eng', readme: 'eng/README.md', team: 'ENG' } });
    } finally {
      process.off('warning', listener);
    }
    assert.deepEqual(warnings, []);
  });

  it('reports annotations that are not valid, naming the file and key but no content', () => {
    for (const text of ['---\nlinear-team: [ENG\n---\n', '---\nlinear-team: ""\n---\n', '---\nlinear-project: 42\n---\n', '---\nlinear-team:\n  name: ENG\n---\n']) {
      const result = readAnnotation('eng/README.md', text);
      assert.ok('problem' in result, text);
      assert.equal(result.problem.kind, 'invalid-annotation');
      assert.match(result.problem.message, /^eng\/README\.md: /);
    }
  });

  it('rejects a second team or project below an annotated folder, and a project without a team', () => {
    const { problems, zones } = resolveZones([
      { folder: 'eng', readme: 'eng/README.md', team: 'ENG' },
      { folder: 'eng/sub', readme: 'eng/sub/README.md', team: 'DOCS' },
      { folder: 'eng/api', readme: 'eng/api/README.md', project: 'API' },
      { folder: 'eng/api/v2', readme: 'eng/api/v2/README.md', project: 'API v2' },
      { folder: 'loose', readme: 'loose/README.md', project: 'Orphan' },
    ]);
    assert.deepEqual(problems.map((problem) => [problem.readme, problem.kind]), [
      ['loose/README.md', 'project-without-team'],
      ['eng/sub/README.md', 'nested-team'],
      ['eng/api/v2/README.md', 'nested-project'],
    ]);
    assert.deepEqual([...zones.keys()].sort(), ['eng', 'eng/api']);
  });
});

describe('folder mapping', () => {
  it('maps project files, team-zone files and combined folders with path titles', () => {
    const mapping = mapTree({
      'README.md': '# Repository\n',
      'eng/README.md': team('ENG'),
      'eng/backend/notes.md': '# Notes\n',
      'eng/api/README.md': project('API'),
      'eng/api/guides/setup/install.md': '# Install\n',
      'eng/area/inner/README.md': project('Inner'),
      'eng/area/inner/plan.md': '# Plan\n',
      'eng/area/top.md': '# Top\n',
      'combined/README.md': '---\nlinear-team: DOCS\nlinear-project: Handbook\n---\n# Handbook\n',
      'combined/deep/a b (1).md': '# A\n',
    });
    assert.deepEqual(mapping.problems, []);
    assert.deepEqual(summary(mapping), {
      'eng/README.md': 'ENG (team): README',
      'eng/backend/notes.md': 'ENG (team): backend/notes',
      'eng/api/README.md': 'ENG/API: README',
      'eng/api/guides/setup/install.md': 'ENG/API: guides/setup/install',
      'eng/area/inner/README.md': 'ENG/Inner: README',
      'eng/area/inner/plan.md': 'ENG/Inner: plan',
      'eng/area/top.md': 'ENG (team): area/top',
      'combined/README.md': 'DOCS/Handbook: README',
      'combined/deep/a b (1).md': 'DOCS/Handbook: deep/a b (1)',
    });
    assert.deepEqual(mapping.unsynced, [{ path: 'README.md', reason: 'outside-annotations' }]);
  });

  it('maps the whole repository when the root is annotated', () => {
    const mapping = mapTree({ 'README.md': '---\nlinear-team: ENG\nlinear-project: Docs\n---\n', 'a/b.md': 'x' });
    assert.deepEqual(summary(mapping), { 'README.md': 'ENG/Docs: README', 'a/b.md': 'ENG/Docs: a/b' });
  });

  it('synchronizes only regular .md files with text content', () => {
    const lfsPointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12\n';
    const mapping = mapTree({
      'eng/README.md': team('ENG'),
      'eng/plan.md': '# Plan\n',
      'eng/plan.markdown': '# Plan, other extension\n',
      'eng/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
      'eng/script.py': 'print(1)\n',
      'eng/binary.md': Buffer.from([0x23, 0x20, 0x00, 0x01]),
      'eng/latin1.md': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      'eng/stored.md': lfsPointer,
      'eng/link.md': { symlink: 'plan.md' },
      'loose/notes.md': '# Above every annotation\n',
      'loose/data.csv': 'a,b\n',
    });
    assert.deepEqual(Object.keys(summary(mapping)).sort(), ['eng/README.md', 'eng/plan.md']);
    assert.deepEqual(
      mapping.unsynced.map((file) => [file.path, file.reason]).sort(),
      [
        ['eng/binary.md', 'binary'],
        ['eng/latin1.md', 'binary'],
        ['eng/link.md', 'not-a-regular-file'],
        ['eng/stored.md', 'stored-in-lfs'],
        ['loose/notes.md', 'outside-annotations'],
      ],
    );
  });

  it('lists every regular file of the tree, inside annotations or not, as what an image may name; a symbolic link is not one', () => {
    const mapping = mapTree({
      'eng/README.md': team('ENG'),
      'eng/plan.md': '# Plan\n',
      'eng/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
      'eng/linked.png': { symlink: 'image.png' },
      'loose/data.csv': 'a,b\n',
    });
    assert.deepEqual([...mapping.files].sort(), ['eng/README.md', 'eng/image.png', 'eng/plan.md', 'loose/data.csv']);
  });

  it('leaves out both files of a title collision: Unicode normalization or case only', () => {
    const nfc = 'café.md';
    const nfd = 'café.md';
    const mapping = mapTree({
      'docs/README.md': '---\nlinear-team: DOCS\nlinear-project: Guides\n---\n',
      [`docs/${nfc}`]: 'one',
      [`docs/${nfd}`]: 'two',
      'docs/Guide.md': 'three',
      'docs/guide.md': 'four',
      'docs/other.md': 'five',
      'eng/README.md': team('ENG'),
      'eng/guide.md': 'same title, other place',
    });
    assert.deepEqual(Object.keys(summary(mapping)).sort(), ['docs/README.md', 'docs/other.md', 'eng/README.md', 'eng/guide.md']);
    const leftOut = Object.fromEntries(mapping.leftOut.map((file) => [file.path, [file.rule, file.collidesWith]]));
    assert.deepEqual(leftOut, {
      [`docs/${nfc}`]: ['duplicate-title', [`docs/${nfd}`]],
      [`docs/${nfd}`]: ['duplicate-title', [`docs/${nfc}`]],
      'docs/Guide.md': ['duplicate-title', ['docs/guide.md']],
      'docs/guide.md': ['duplicate-title', ['docs/Guide.md']],
    });
  });

  it('names at most three other files of a larger collision and counts the rest', () => {
    const names = ['Guide', 'guide', 'GUIDE', 'gUide', 'guIde'];
    const mapping = mapTree({ 'docs/README.md': team('DOCS'), ...Object.fromEntries(names.map((name) => [`docs/${name}.md`, name])) });
    const leftOut = Object.fromEntries(mapping.leftOut.map((file) => [file.path, [file.collidesWith, file.collidesWithMore]]));
    assert.deepEqual(leftOut, {
      'docs/Guide.md': [['docs/guide.md', 'docs/GUIDE.md', 'docs/gUide.md'], 1],
      'docs/guide.md': [['docs/Guide.md', 'docs/GUIDE.md', 'docs/gUide.md'], 1],
      'docs/GUIDE.md': [['docs/Guide.md', 'docs/guide.md', 'docs/gUide.md'], 1],
      'docs/gUide.md': [['docs/Guide.md', 'docs/guide.md', 'docs/GUIDE.md'], 1],
      'docs/guIde.md': [['docs/Guide.md', 'docs/guide.md', 'docs/GUIDE.md'], 1],
    });
  });

  // Every file of a collision used to list all the others, and each append copied its group: 16,384 case
  // variants of one name took 2.2 GB. The tree listing's byte budget allows far more, and empty files share
  // one blob. A child process maps and lints 65,536 variants under a heap limit, and the parent's timeout
  // stops a stall that a test timeout could not interrupt.
  it('maps and lints 65,536 case variants of one title in bounded memory', { timeout: 120_000 }, () => {
    const script = `
      import { collectAnnotations, mapFiles, resolveZones } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      import { duplicateTitles } from ${JSON.stringify(new URL('../format/lint.ts', import.meta.url).href)};
      const name = 'abcdefghijklmnop';
      const variants = Array.from({ length: 1 << name.length }, (_, bits) =>
        [...name].map((letter, at) => (bits >> at) & 1 ? letter.toUpperCase() : letter).join(''));
      const oid = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
      const entries = [{ path: 'docs/README.md', mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 1 },
        ...variants.map((variant) => ({ path: 'docs/' + variant + '.md', mode: '100644', type: 'blob', oid, size: 0 }))];
      const { annotations } = collectAnnotations(new Map([['docs/README.md', '---\\nlinear-team: DOCS\\n---\\n']]));
      const { zones } = resolveZones(annotations);
      const mapping = mapFiles(entries, zones, new Map([[oid, Buffer.alloc(0)], ['a'.repeat(40), Buffer.from('x')]]));
      const findings = duplicateTitles(variants.map((variant) => variant + '.md'));
      console.log(JSON.stringify({
        documents: mapping.documents.length,
        leftOut: mapping.leftOut.length,
        named: mapping.leftOut.reduce((most, file) => Math.max(most, file.collidesWith.length), 0),
        more: [...new Set(mapping.leftOut.map((file) => file.collidesWithMore))],
        findings: findings.length,
        longest: findings.reduce((most, finding) => Math.max(most, finding.message.length), 0),
      }));
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 90_000 });
    assert.notEqual((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', 'mapping and lint did not finish within the parent timeout');
    assert.ifError(child.error);
    assert.equal(child.status, 0, `the child ended with signal ${child.signal}: ${child.stderr}`);
    const result = JSON.parse(child.stdout) as { documents: number; leftOut: number; named: number; more: number[]; findings: number; longest: number };
    assert.deepEqual({ ...result, longest: undefined }, { documents: 1, leftOut: 65_536, named: 3, more: [65_532], findings: 65_536, longest: undefined });
    assert.ok(result.longest < 200, `the longest finding message has ${result.longest} characters`);
  });

  it('reports annotation problems with the mapping', () => {
    const mapping = mapTree({ 'eng/README.md': '---\nlinear-team: ""\n---\n', 'eng/a.md': 'x' });
    assert.deepEqual(mapping.problems.map((problem) => problem.kind), ['invalid-annotation']);
    assert.deepEqual(mapping.documents, []);
  });
});

describe('folder mapping of a commit', () => {
  it('leaves oversized Markdown and annotation blobs unread and bounds each batch', async (t) => {
    const fixture = await createFixture();
    try {
      await fixture.seed({
        'docs/README.md': team('ENG'),
        'docs/large.md': 'a'.repeat(MAPPING_FILE_BYTES + 1),
        'docs/child/README.md': 'b'.repeat(MAPPING_FILE_BYTES + 1),
        ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
          `docs/note-${i}.md`, String(i).repeat(MAPPING_FILE_BYTES),
        ])),
      });
      const git = await fixture.clone('reader');
      const commit = await git.text(['rev-parse', 'origin/main']);
      const entries = await listTree(git, commit);
      const oversized = entries.filter((entry) => entry.size === MAPPING_FILE_BYTES + 1);
      const run = t.mock.method(git, 'run');

      const mapping = await loadMapping(git, commit);
      assert.deepEqual(mapping.problems.map(({ readme, kind }) => [readme, kind]), [
        ['docs/child/README.md', 'invalid-annotation'],
      ]);
      assert.deepEqual(mapping.unsynced.map(({ path, reason }) => [path, reason]), [
        ['docs/child/README.md', 'blob-too-large'],
        ['docs/large.md', 'blob-too-large'],
      ]);
      assert.deepEqual(mapping.documents.map(({ path }) => path), [
        'docs/README.md', 'docs/note-0.md', 'docs/note-1.md', 'docs/note-2.md', 'docs/note-3.md', 'docs/note-4.md',
      ]);
      const batches = run.mock.calls.filter(({ arguments: [args] }) => args[0] === 'cat-file');
      assert.equal(batches.length, 3);
      for (const { arguments: [, options] } of batches) {
        assert.ok(options?.maxOutputBytes !== undefined && options.maxOutputBytes <= 4 * 1024 * 1024);
        for (const { oid } of oversized) assert.ok(!String(options.input).includes(oid));
      }
      await assert.rejects(git.run(['show', `${commit}:docs/README.md`], { maxOutputBytes: 8 }), /git-output-limit/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reads annotations and the fixture bank collision pairs from git', async () => {
    const fixture = await createFixture();
    try {
      const bank = new URL('../../test/fixtures/', import.meta.url);
      const read = (path: string) => readFile(new URL(path, bank));
      await fixture.seed({
        'notes/README.md': '# Not annotated\n',
        'notes/above.md': await read('unsynced/notes-above-annotation.md'),
        'kb/README.md': await read('front-matter/annotation.md'),
        'kb/duplicate-title/Guide.md': await read('lint-errors/duplicate-title/guide-upper.md'),
        'kb/duplicate-title/guide.md': await read('lint-errors/duplicate-title/guide-lower.md'),
        'kb/duplicate-title/café.md': await read('lint-errors/duplicate-title/cafe-nfc.md'),
        'kb/duplicate-title/café.md': await read('lint-errors/duplicate-title/cafe-nfd.md'),
        'kb/binary-named.md': await read('unsynced/binary-named.md'),
        'kb/plan.md': await read('unsynced/markdown-extension/plan.md'),
        'kb/plan.markdown': await read('unsynced/markdown-extension/plan.markdown'),
        'kb/images/pixel.png': await read('assets/pixel.png'),
      });
      const git = await fixture.clone('reader');
      const mapping = await loadMapping(git, await git.text(['rev-parse', 'origin/main']));
      assert.deepEqual(mapping.problems, []);
      assert.deepEqual(summary(mapping), { 'kb/README.md': 'ENG/Field notes: README', 'kb/plan.md': 'ENG/Field notes: plan' });
      assert.deepEqual(mapping.leftOut.map((file) => file.path).sort(), [
        'kb/duplicate-title/Guide.md',
        'kb/duplicate-title/café.md',
        'kb/duplicate-title/café.md',
        'kb/duplicate-title/guide.md',
      ].sort());
      assert.deepEqual(mapping.unsynced.map((file) => [file.path, file.reason]).sort(), [
        ['kb/binary-named.md', 'binary'],
        ['notes/README.md', 'outside-annotations'],
        ['notes/above.md', 'outside-annotations'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
