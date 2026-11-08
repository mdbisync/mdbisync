import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { type TreeEntry } from '../state/objects.ts';
import { createFixture } from '../state/test-helpers.ts';
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
  return { annotations, problems: [...readProblems, ...problems], ...mapFiles(entries, zones, contents) };
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
    assert.deepEqual(findFrontMatter('---\na: 1\n---\nbody'), { yaml: 'a: 1\n', end: 13 });
    assert.equal(findFrontMatter('﻿---\r\na: 1\r\n...\r\n')?.yaml, 'a: 1\r\n');
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

  it('reports annotation problems with the mapping', () => {
    const mapping = mapTree({ 'eng/README.md': '---\nlinear-team: ""\n---\n', 'eng/a.md': 'x' });
    assert.deepEqual(mapping.problems.map((problem) => problem.kind), ['invalid-annotation']);
    assert.deepEqual(mapping.documents, []);
  });
});

describe('folder mapping of a commit', () => {
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
