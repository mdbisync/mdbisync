import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { it } from 'node:test';
import { planInitialSync } from '../../../src/initial-sync/plan.ts';
import { toPlanReport } from '../../../src/initial-sync/summary.ts';
import { collectAnnotations, mapFiles, resolveZones } from '../../../src/mapping/index.ts';
import { buildCorpus } from '../../corpus/generate.ts';
import type { RunContext } from './context.ts';
import { bodyOf, compare, differingPaths } from './checks.ts';
import { loadScenarios } from './spec.ts';
import { BEFORE_VIEW, resolveSubject } from './subjects.ts';

const corpus = buildCorpus('0'.repeat(40));
const mid = new Set(corpus.slices.mid);
const midEntries = corpus.manifest.files.filter((entry) => mid.has(entry.path));
const textOf = (path: string) => corpus.files.find((file) => file.path === path)!.content.toString('utf8');
const l110 = loadScenarios().find((scenario) => scenario.id === 'L1-10')!;
const assertionOf = (subject: string) => l110.checks.assertions.find((assertion) => assertion.subject === subject)!;

it('compares L1-10 table cells with the file as Linear stores it, image upload URLs included', async () => {
  const cells = assertionOf('documents.tableCells');
  assert.equal(cells.operator, 'same-as');
  // A table with an image in a cell, as the mid slice has one, and an aligned table the plan leaves out.
  const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
  const table = midEntries.find((entry) => entry.group === 'tables' && entry.class === null && entry.links.some(isImage))!;
  const aligned = midEntries.find((entry) => entry.group === 'tables' && entry.rule === 'table-alignment')!;
  assert.ok(table !== undefined && aligned !== undefined);
  const image = table.links.find(isImage)!;
  const relative = posix.relative(posix.dirname(table.path), image);
  const text = textOf(table.path);
  const row = text.split('\n').find((line) => line.startsWith('|') && line.includes(`](${relative})`));
  assert.ok(row?.includes('!['), 'a table cell embeds the image by a relative path');
  const upload = 'https://uploads.linear.app/team/asset/status-icon.png';
  // What Linear stores: the file's body with the image's upload URL (I1 holds for this document).
  const stored = bodyOf(text).replace(`](${relative})`, `](${upload})`);

  const uploadsByHash = new Map([['image-hash', upload]]);
  const documents = new Map([['doc-1', { id: 'doc-1', content: stored }]]);
  const view = {
    files: new Map([[table.path, text]]), // a left-out file is not among the synchronized files
    hashes: new Map([[table.path, 'doc-hash'], [aligned.path, 'aligned-hash'], [image, 'image-hash']]),
    uploadsByHash,
    ids: new Map([[table.path, { id: 'doc-1' }]]),
    documentUrlBase: 'https://linear.app/team/document',
    documents,
    omitted: new Map<string, string>(),
    kept: new Set<string>(),
  };
  const ctx = {
    live: { manifest: { seed: corpus.manifest.seed, files: midEntries }, tree: { paths: new Map([[table.path, table.path], [aligned.path, aligned.path]]) } },
    observations: new Map<string, unknown>([[BEFORE_VIEW, view]]),
  } as unknown as RunContext;
  const both = async () => {
    const actual = (await resolveSubject(ctx, `before.${cells.subject}`)).value;
    const expected = (await resolveSubject(ctx, `before.${String(cells.expected)}`)).value;
    return { actual, holds: compare('same-as', actual, expected), paths: differingPaths(actual, expected) };
  };
  const verdict = async () => {
    const { holds, paths } = await both();
    return { holds, paths };
  };

  const same = await both();
  assert.ok(same.holds, same.paths);
  assert.deepEqual([...(same.actual as Map<string, unknown>).keys()], [table.path]);
  assert.ok(JSON.stringify([...(same.actual as Map<string, unknown>)]).includes(upload));

  // A changed cell still fails, naming the document.
  documents.set('doc-1', { id: 'doc-1', content: stored.replace('![', '![changed ') });
  assert.deepEqual(await verdict(), { holds: false, paths: `differs at ${table.path}` });

  // The expectation takes the upload URL from the run's uploads ref, not from the document: an unrecorded upload fails.
  uploadsByHash.clear();
  documents.set('doc-1', { id: 'doc-1', content: stored });
  assert.deepEqual(await verdict(), { holds: false, paths: `differs at ${table.path}` });
});

it('leaves a table the run left out out of both sides of L1-10 table cells, and still fails a synchronized table without a document', async () => {
  const cells = assertionOf('documents.tableCells');
  const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
  // A live run placed this table under a run folder while its image stayed at the corpus path, so the relative image link
  // found no file and the engine left the table out (image-file-missing) with no mapping. Here: that placement, unmapped.
  const leftOut = midEntries.find((entry) => entry.group === 'tables' && entry.class === null && entry.links.some(isImage))!;
  const other = midEntries.find((entry) => entry.group === 'tables' && entry.class === null && entry.links.length === 0)!;
  assert.ok(leftOut !== undefined && other !== undefined);
  const placed = `eng/run-1/${leftOut.path.replace(/^eng\//, '')}`;
  const dataRow = (line: string) => line.startsWith('|') && !line.replace(/^\||\|$/g, '').split('|').every((cell) => /^:?-+:?$/.test(cell.trim()));
  assert.ok(textOf(leftOut.path).split('\n').some(dataRow), 'the left-out file has table data rows');
  const otherText = textOf(other.path);

  const documents = new Map<string, { id: string; content: string; trashed?: boolean }>([['doc-other', { id: 'doc-other', content: bodyOf(otherText) }]]);
  const ids = new Map<string, { id: string }>([[other.path, { id: 'doc-other' }]]);
  const omitted = new Map([[placed, 'lint: image-file-missing']]);
  const kept = new Set<string>();
  const files = new Map([[placed, textOf(leftOut.path)], [other.path, otherText]]);
  const view = {
    files,
    hashes: new Map<string, string>(),
    uploadsByHash: new Map<string, string>(),
    ids,
    documentUrlBase: 'https://linear.app/team/document',
    documents,
    omitted,
    kept,
  };
  const ctx = {
    live: { manifest: { seed: corpus.manifest.seed, files: midEntries }, tree: { paths: new Map([[placed, leftOut.path], [other.path, other.path]]) } },
    observations: new Map<string, unknown>([[BEFORE_VIEW, view]]),
  } as unknown as RunContext;
  const verdict = async () => {
    const actual = (await resolveSubject(ctx, `before.${cells.subject}`)).value;
    const expected = (await resolveSubject(ctx, `before.${String(cells.expected)}`)).value;
    return { holds: compare('same-as', actual, expected), paths: differingPaths(actual, expected), keys: [...(expected as Map<string, unknown>).keys()] };
  };

  // The left-out table is on neither side; the synchronized one is compared.
  assert.deepEqual(await verdict(), { holds: true, paths: undefined, keys: [other.path] });

  // Not left out by any run, the same unmapped table fails, naming it.
  omitted.clear();
  assert.deepEqual(await verdict(), { holds: false, paths: `differs at ${placed}`, keys: [other.path, placed].sort() });

  // Kept without a document by the engine's own rule, or not a synchronized file at all, it is on neither side either.
  kept.add(placed);
  assert.deepEqual(await verdict(), { holds: true, paths: undefined, keys: [other.path] });
  kept.clear();
  const placedText = files.get(placed)!;
  files.delete(placed);
  assert.deepEqual(await verdict(), { holds: true, paths: undefined, keys: [other.path] });
  files.set(placed, placedText);
  omitted.set(placed, 'lint: image-file-missing');

  // A mapped table whose document is in Linear's trash fails, as I1 counts it as no document.
  documents.set('doc-other', { id: 'doc-other', content: bodyOf(otherText), trashed: true });
  assert.deepEqual(await verdict(), { holds: false, paths: `differs at ${other.path}`, keys: [other.path] });

  // A mapped table whose document is missing from Linear fails, naming it.
  documents.clear();
  assert.deepEqual(await verdict(), { holds: false, paths: `differs at ${other.path}`, keys: [other.path] });
});

it("expects L1-10's left-out rules among those the engine's plan reports for the mid slice", () => {
  const rules = assertionOf('summary.leftOutRules');
  assert.equal(rules.operator, 'contains-all');
  assert.ok((rules.expected as string[]).length > 0);
  // The initial sync's plan of the whole slice, read the way the run report's leftOutRules is.
  const files = corpus.files.filter((file) => mid.has(file.path));
  const readmes = new Map(files.filter((file) => /(^|\/)README\.md$/.test(file.path)).map((file) => [file.path, file.content.toString('utf8')]));
  const blobs = new Map<string, Buffer>();
  const texts = new Map<string, string>();
  const entries = files.map((file) => {
    const oid = createHash('sha1').update(file.path).update(file.content).digest('hex');
    blobs.set(oid, file.content);
    if (file.path.endsWith('.md')) texts.set(file.path, file.content.toString('utf8'));
    return { path: file.path, oid, mode: '100644', type: 'blob' as const, size: file.content.length };
  });
  const { annotations } = collectAnnotations(readmes);
  const { zones } = resolveZones(annotations);
  const mapping = { annotations, problems: [], zones, ...mapFiles(entries, zones, blobs) };
  const report = toPlanReport(planInitialSync({ mapping, texts, places: [] }), 'git-to-linear', false);
  const reported = [...new Set(report.leftOutFiles.flatMap((entry) => entry.rules))].sort();
  assert.ok(compare('contains-all', reported, rules.expected), `the plan reports ${reported.join(', ')}`);
});
