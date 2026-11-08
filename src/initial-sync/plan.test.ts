import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { type LinearDocument } from '../linear/index.ts';
import { type Place, type RepositoryMapping, candidateFiles, collectAnnotations, mapFiles, resolveZones } from '../mapping/index.ts';
import { type TreeEntry } from '../state/objects.ts';
import { type PlaceDocuments, annotatedPlaces, planInitialSync } from './plan.ts';
import { renderDryRun, toPlanReport } from './summary.ts';

const CANARY = 'kx-0d1e2a3b';

/** Maps an in-memory tree and keeps every mapped file's text, as `planFromRepository` reads them. */
function mapTree(files: Record<string, string>): { mapping: RepositoryMapping; texts: Map<string, string> } {
  const entries: TreeEntry[] = [];
  const blobs = new Map<string, Buffer>();
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    const oid = createHash('sha1').update(path).update(bytes).digest('hex');
    blobs.set(oid, bytes);
    entries.push({ path, mode: '100644', type: 'blob', oid, size: bytes.length });
  }
  const readmes = new Map(entries.filter((e) => /(^|\/)README\.md$/.test(e.path)).map((e) => [e.path, (blobs.get(e.oid) as Buffer).toString('utf8')]));
  const { annotations } = collectAnnotations(readmes);
  const { zones } = resolveZones(annotations);
  const wanted = new Set(candidateFiles(entries, zones).map((e) => e.oid));
  const mapping: RepositoryMapping = { annotations, zones, problems: [], ...mapFiles(entries, zones, new Map([...blobs].filter(([oid]) => wanted.has(oid)))) };
  return { mapping, texts: new Map([...mapping.documents, ...mapping.leftOut].map((d) => [d.path, files[d.path] as string])) };
}

let created = 0;
function doc(title: string, extra: Partial<LinearDocument> = {}): LinearDocument {
  created += 1;
  return {
    id: `doc-${title}-${created}`,
    title,
    slugId: `s${created}`,
    icon: null,
    color: null,
    documentContentId: null,
    projectId: null,
    teamId: null,
    trashed: false,
    archivedAt: null,
    createdAt: `2026-01-01T00:00:${String(created).padStart(2, '0')}Z`,
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

const ENG: Place = { kind: 'team', team: 'ENG' };
const NOTES: Place = { kind: 'project', team: 'ENG', project: 'Field notes' };
const HANDBOOK: Place = { kind: 'project', team: 'DOCS', project: 'Handbook' };

/** A file name stored decomposed (as macOS writes it); Linear's title is composed. */
const NFD_PATH = 'eng/backend/cafe\u0301.md';
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 2048\n`;

const TREE = {
  'README.md': `# Top\n\n${CANARY}\n`,
  'eng/README.md': `---\nlinear-team: ENG\n---\n\n# Engineering\n\n${CANARY}\n`,
  'eng/backend/notes.md': `# Notes\n\n${CANARY}\n`,
  'eng/backend/old.md': `# Old\n\n${CANARY}\n`,
  'eng/notes/README.md': `---\nlinear-project: Field notes\n---\n\n# Field notes\n\n${CANARY}\n`,
  'eng/notes/plan.md': `# Plan\n\n${CANARY}\n`,
  'eng/notes/sources.md': `# Sources\n\nA claim.[^1]\n\n[^1]: A source. ${CANARY}\n`,
  'combined/README.md': `---\nlinear-team: DOCS\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  'combined/Guide.md': `# Guide\n\nWater is H~2~O. ${CANARY}\n`,
  [NFD_PATH]: `# Caf\u00e9\n\n${CANARY}\n`,
  'eng/backend/big.md': LFS_POINTER,
  'combined/guide.md': `# guide\n\n${CANARY}\n`,
  [`combined/${'t'.repeat(513)}.md`]: `# Long\n\n${CANARY}\n`,
};

describe('annotatedPlaces', () => {
  it('lists each project and each team zone once, with its folder; a team and project in one folder makes no team zone', () => {
    const { mapping } = mapTree(TREE);
    assert.deepEqual(annotatedPlaces(mapping.zones), [
      { place: HANDBOOK, folder: 'combined' },
      { place: ENG, folder: 'eng' },
      { place: NOTES, folder: 'eng/notes' },
    ]);
  });
});

describe('planInitialSync', () => {
  const { mapping, texts } = mapTree(TREE);
  const backendNotes = doc('backend/notes', { teamId: 'team-eng' });
  const backendNotesLater = doc('backend/notes', { teamId: 'team-eng' });
  const onlyInLinear = doc('backend/retired', { teamId: 'team-eng' });
  const archived = doc('backend/old', { teamId: 'team-eng', archivedAt: '2026-01-02T00:00:00Z' });
  const caseOnly = doc('Backend/Notes', { teamId: 'team-eng' });
  const sources = doc('sources', { projectId: 'project-notes' });
  const guide = doc('Guide', { projectId: 'project-handbook' });
  const cafe = doc('backend/caf\u00e9', { teamId: 'team-eng' });
  const big = doc('backend/big', { teamId: 'team-eng' });
  const places: PlaceDocuments[] = [
    { place: ENG, documents: [backendNotesLater, backendNotes, onlyInLinear, archived, caseOnly, cafe, big] },
    { place: NOTES, documents: [sources] },
    { place: HANDBOOK, documents: [guide] },
  ];
  const plan = planInitialSync({ mapping, texts, places });

  it('overwrites the oldest document whose title equals the path (in NFC, with case), and trashes the others', () => {
    assert.deepEqual(plan.overwrite, [
      { path: NFD_PATH, title: 'backend/cafe\u0301', place: ENG, documentId: cafe.id },
      { path: 'eng/backend/notes.md', title: 'backend/notes', place: ENG, documentId: backendNotes.id },
    ]);
    assert.deepEqual(
      plan.trash.map((entry) => [entry.path, entry.documentId]),
      [
        ['eng/Backend/Notes.md', caseOnly.id],
        ['eng/backend/notes.md', backendNotesLater.id],
        ['eng/backend/retired.md', onlyInLinear.id],
      ],
    );
  });

  it('creates every synchronized file without a document, annotation README bodies included; archived documents are ignored', () => {
    assert.deepEqual(
      plan.create.map((entry) => [entry.path, entry.title]),
      [
        ['combined/README', 'README'],
        ['eng/README', 'README'],
        ['eng/backend/old', 'backend/old'],
        ['eng/notes/README', 'README'],
        ['eng/notes/plan', 'plan'],
      ].map(([path, title]) => [`${path}.md`, title]),
    );
    assert.ok(!plan.trash.some((entry) => entry.documentId === archived.id));
  });

  it('leaves out lint errors, both colliding files (with their own lint rules), too-long titles and files kept in LFS, and keeps their documents as they are', () => {
    assert.deepEqual(plan.leftOut, [
      { path: 'combined/Guide.md', rules: ['duplicate-title', 'subscript'], lines: [3], collidesWith: ['combined/guide.md'], documentId: guide.id },
      { path: 'combined/guide.md', rules: ['duplicate-title'], lines: [], collidesWith: ['combined/Guide.md'] },
      { path: `combined/${'t'.repeat(513)}.md`, rules: ['title-too-long'], lines: [] },
      { path: 'eng/backend/big.md', rules: ['stored-in-lfs'], lines: [], documentId: big.id },
      { path: 'eng/notes/sources.md', rules: ['footnote'], lines: [3, 5], documentId: sources.id },
    ]);
    const touched = [...plan.overwrite, ...plan.trash].map((entry) => entry.documentId);
    for (const kept of [guide, sources, big]) assert.ok(!touched.includes(kept.id), kept.title);
  });

  it('reports paths and rules only: no content in the summary or the report', () => {
    const report = toPlanReport(plan, 'git-to-linear', false);
    assert.deepEqual(report.collisionPaths, ['combined/Guide.md', 'combined/guide.md']);
    assert.deepEqual(report.plan.paths, [...new Set([...report.plan.create, ...report.plan.overwrite, ...report.plan.trash])].sort());
    assert.equal(report.plan.paths.filter((path) => path === 'eng/backend/notes.md').length, 1);
    assert.deepEqual(report.leftOut, plan.leftOut.map((entry) => entry.path));
    const summary = renderDryRun(plan);
    for (const text of [summary, JSON.stringify(report)]) assert.ok(!text.includes(CANARY), 'content leaked');
    assert.match(summary, /^- create 5 documents;$/m);
    assert.match(summary, /^- move 3 documents without a file to Linear's trash/m);
    assert.ok(summary.includes(`| eng/backend/notes.md | team "ENG" | ${backendNotesLater.id} |`), 'the duplicate is named by its id');
    assert.match(summary, /^\| eng\/notes\/sources\.md \| footnote \| 3, 5 \|  \|$/m);
  });
});

describe('renderDryRun', () => {
  it('escapes pipes in paths so a row stays one row', () => {
    const summary = renderDryRun({ create: [{ path: 'a|b.md', title: 'a|b', place: ENG }], overwrite: [], trash: [], leftOut: [] });
    assert.match(summary, /^\| a\\\|b\.md \| team "ENG" \|$/m);
    assert.match(summary, /### Overwrite \(0\)\n\nNone\./);
  });
});
