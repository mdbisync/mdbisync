import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { it } from 'node:test';
import { lintText } from '../../../src/format/lint.ts';
import { LINT_RULES } from '../../../src/format/rules.ts';
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
  const table = midEntries.find((entry) => entry.group === 'tables' && entry.class === null && entry.links.length > 0)!;
  const aligned = midEntries.find((entry) => entry.group === 'tables' && entry.rule === 'table-alignment')!;
  assert.ok(table !== undefined && aligned !== undefined);
  const image = table.links[0]!;
  const relative = posix.relative(posix.dirname(table.path), image);
  const text = textOf(table.path);
  assert.ok(text.includes(`](${relative})`), 'the image cell links the file by a relative path');
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
  };
  const ctx = {
    live: { manifest: { seed: corpus.manifest.seed, files: midEntries }, tree: { paths: new Map([[table.path, table.path], [aligned.path, aligned.path]]) } },
    observations: new Map<string, unknown>([[BEFORE_VIEW, view]]),
  } as unknown as RunContext;
  const both = async () => {
    const actual = (await resolveSubject(ctx, `before.${cells.subject}`)).value;
    const expected = (await resolveSubject(ctx, `before.${String(cells.expected)}`)).value;
    return { actual, expected, holds: compare('same-as', actual, expected), paths: differingPaths(actual, expected) };
  };

  const same = await both();
  assert.ok(same.holds, same.paths);
  assert.deepEqual([...(same.actual as Map<string, unknown>).keys()], [table.path]);
  assert.ok(JSON.stringify([...(same.actual as Map<string, unknown>)]).includes(upload));

  // A changed cell still fails, naming the document.
  documents.set('doc-1', { id: 'doc-1', content: stored.replace(/ \|\n\n(?=Doc ID)/, ' changed |\n\n') });
  assert.notEqual(documents.get('doc-1')!.content, stored);
  assert.deepEqual((({ holds, paths }) => ({ holds, paths }))(await both()), { holds: false, paths: `differs at ${table.path}` });

  // The expectation takes the upload URL from the run's uploads ref, not from the document: an unrecorded upload fails.
  uploadsByHash.clear();
  documents.set('doc-1', { id: 'doc-1', content: stored });
  assert.deepEqual((({ holds, paths }) => ({ holds, paths }))(await both()), { holds: false, paths: `differs at ${table.path}` });
});

it("expects L1-10's left-out rules by the names the engine reports for the mid slice", () => {
  const rules = assertionOf('summary.leftOutRules');
  assert.equal(rules.operator, 'contains-all');
  const expected = rules.expected as string[];
  assert.ok(expected.length > 0);
  const reported = new Set<string>();
  for (const entry of midEntries.filter((file) => file.class === 'lint-error')) {
    for (const finding of lintText(entry.path, textOf(entry.path))) reported.add(finding.rule);
  }
  for (const rule of expected) {
    assert.ok(Object.hasOwn(LINT_RULES, rule), `${rule} is a lint rule`);
    assert.ok(reported.has(rule), `the mid slice has a file the engine leaves out by ${rule}`);
  }
  assert.ok(compare('contains-all', [...reported].sort(), expected));
});
