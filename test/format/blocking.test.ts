// Which lint rules hold a file back from Linear in the sync (LINT_RULE_BLOCKS),
// checked against the fixture bank's recorded Linear forms. A rule blocks when
// Linear refuses the document or would move, drop or split its text; it does
// not block when only formatting is lost, or when Linear's own export writes
// the construct.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { lintText, splitFile } from '../../src/format/index.ts';
import { LINT_RULE_BLOCKS, LINT_RULES, NOT_IN_LINEAR_EXPORT, type LintRule } from '../../src/format/rules.ts';
import { goldenMarkdownPath, loadBank, readOptional } from '../probe/bank.ts';
import { textAndPlaces } from './text-and-places.ts';

/**
 * What shows a rule's effect in Linear:
 * - `refused`: Linear or the sync refuses the file, so there is no text to compare;
 * - `text-changed`: a recorded form moves, drops or splits text, a URL or raw HTML;
 * - `section-opened`: a recorded form opens a collapsible section the file does not have;
 * - `editor`: Linear's editor reads the stored Markdown its own way (a lone `+` as an empty
 *   list item, a tab as other indentation) and moves the text after it; seen on real
 *   documents, while the bank's fixtures of the rule are still assumed;
 * - `unrecorded`: no recorded form yet, so the rule keeps blocking;
 * - `silent-loss`: Linear shows the text differently (a cell's `#` as an empty heading) while
 *   its export writes the same Markdown, so the loss never comes back as a change;
 * - `text-kept`: every recorded form keeps the text, its URLs and their places: only
 *   formatting is lost;
 * - `title-dropped`: as `text-kept`, but Linear drops the link's or image's title, which comes
 *   back as a change in the sync pull request;
 * - `linear-writes`: Linear's own export writes the construct (a recorded form has the
 *   same finding), so a document Linear wrote is not held back;
 * - `fix-only`: the finding is about what `fix` can write, not what Linear stores;
 * - `not-a-document`: reported for a file that is not a document, which the sync's upload
 *   check decides on.
 */
type Evidence = 'refused' | 'text-changed' | 'section-opened' | 'editor' | 'unrecorded' | 'silent-loss' | 'text-kept' | 'title-dropped' | 'linear-writes' | 'fix-only' | 'not-a-document';

const BLOCKING_EVIDENCE: ReadonlySet<Evidence> = new Set(['refused', 'text-changed', 'section-opened', 'editor', 'unrecorded', 'silent-loss']);

const EVIDENCE: { readonly [R in LintRule]: Evidence } = {
  footnote: 'text-changed', // a named footnote's text moves into a link destination
  subscript: 'text-kept',
  'table-escaped-pipe': 'text-changed', // the row splits into more cells
  'table-hash-cell': 'silent-loss',
  'table-list-cell': 'linear-writes',
  'table-quote-cell': 'linear-writes',
  'image-in-link': 'text-changed', // the link's URL is lost
  'content-too-long': 'refused',
  'markdown-complexity': 'refused',
  'duplicate-title': 'refused', // one title for two files
  'table-alignment': 'text-kept',
  'link-scheme': 'unrecorded',
  'link-without-text': 'unrecorded', // Linear drops the link and its URL
  'link-title': 'title-dropped',
  'image-title': 'title-dropped',
  'code-in-emphasis': 'text-kept',
  'hard-break-backslash': 'text-kept',
  'setext-heading-lines': 'text-kept',
  'table-header-pipe': 'linear-writes',
  'code-span-padding': 'linear-writes',
  // The break is lost only when `fix` writes the heading on one line; the sync keeps the heading as it is.
  'hard-break-in-heading': 'fix-only',
  // Linear keeps the paragraph as text on the first write; `fix` cannot write a form Linear keeps.
  'number-paragraph': 'fix-only',
  'tab-reference-layout': 'text-kept',
  'space-reference-edge': 'text-kept',
  'git-conflict-marker': 'text-changed',
  'section-opener': 'section-opened',
  'url-in-html': 'text-changed', // the URL in the HTML becomes a Markdown link inside it
  // A web address inside other text that `fix` cannot place: the sync sends the text as it is.
  'unplaced-link': 'fix-only',
  'list-after-item-text': 'linear-writes',
  // Linear numbers the list on; `fix` cannot write a form Markdown reads the same.
  'list-number-too-long': 'fix-only',
  'block-first-in-list-item': 'text-changed', // the block moves out of the item
  'section-marker-text': 'text-changed',
  'plus-line-in-item': 'editor',
  'tab-indentation': 'editor',
  'ordered-task-list': 'text-kept',
  'image-not-in-repository': 'text-changed', // the image is dropped
  'image-file-missing': 'text-changed', // the image is dropped
  'upload-file-refused': 'not-a-document',
  'document-in-assets-folder': 'refused', // the folder holds the files documents embed
};

const bank = loadBank();
const recorded = bank.fixtures.flatMap((fixture) => {
  if (fixture.class !== 'lint-error' || !fixture.file.endsWith('.md')) return [];
  const form = readOptional(join(bank.dir, goldenMarkdownPath(fixture.file)));
  const source = splitFile(readFileSync(join(bank.dir, fixture.file), 'utf8')).body;
  return [{ fixture, rule: fixture.rule as LintRule, source, form }];
});
const ofRule = (rule: LintRule) => recorded.filter((entry) => entry.rule === rule);

/** Lines Linear reads as a collapsible section's start or end: `+++` alone or with a space and a title. */
const sectionLines = (body: string): number => body.split('\n').filter((line) => /^[ \t>]*(?:(?:[*+-]|\d{1,9}[.)])[ \t]+)?\+\+\+(?: |$)/.test(line)).length;

describe('lint rules that hold a file back from Linear', () => {
  it('every rule has its evidence, and blocks exactly when the evidence says so', () => {
    assert.deepEqual(Object.keys(EVIDENCE).sort(), Object.keys(LINT_RULES).sort());
    for (const rule of Object.keys(LINT_RULES) as LintRule[]) {
      assert.equal(LINT_RULE_BLOCKS[rule], BLOCKING_EVIDENCE.has(EVIDENCE[rule]), `${rule}: ${EVIDENCE[rule]}`);
    }
  });

  it("no recorded Linear form holds a construct of NOT_IN_LINEAR_EXPORT, and none of them blocks", () => {
    for (const rule of NOT_IN_LINEAR_EXPORT) assert.equal(LINT_RULE_BLOCKS[rule], false, rule);
    for (const fixture of bank.fixtures) {
      if (!fixture.file.endsWith('.md')) continue;
      const form = readOptional(join(bank.dir, goldenMarkdownPath(fixture.file)));
      if (form === undefined) continue;
      const found = lintText(fixture.file, form).filter((finding) => NOT_IN_LINEAR_EXPORT.has(finding.rule));
      assert.deepEqual(found, [], fixture.file);
    }
  });

  for (const rule of Object.keys(LINT_RULES) as LintRule[]) {
    const evidence = EVIDENCE[rule];
    it(`${rule}: ${evidence}`, () => {
      const entries = ofRule(rule);
      const withForm = entries.filter((entry) => entry.form !== undefined);
      switch (evidence) {
        case 'text-kept':
        case 'title-dropped':
          assert.ok(withForm.length > 0, 'a recorded form shows what Linear keeps');
          for (const { fixture, source, form } of withForm) {
            assert.deepEqual(textAndPlaces(form!), textAndPlaces(source), `${fixture.file}: Linear keeps the text in its places`);
          }
          break;
        case 'text-changed':
          assert.ok(withForm.some(({ source, form }) => JSON.stringify(textAndPlaces(form!)) !== JSON.stringify(textAndPlaces(source))), 'a recorded form moves, drops or splits text');
          break;
        case 'section-opened':
          assert.ok(withForm.some(({ source, form }) => sectionLines(form!) > sectionLines(source)), 'a recorded form opens a collapsible section');
          break;
        case 'linear-writes':
        case 'silent-loss':
          assert.ok(withForm.some(({ form }) => lintText('', form!, { linearExport: true }).some((finding) => finding.rule === rule)), "Linear's own export writes the construct");
          break;
        case 'editor':
          // Once the probe records how Linear's editor holds them, the rule is decided again from that form.
          assert.ok(entries.length > 0 && entries.every(({ fixture }) => fixture.basis === 'assumed'), 'the fixtures wait for a recorded form');
          break;
        case 'unrecorded':
          assert.deepEqual(withForm, [], 'a recorded form decides the rule');
          break;
        case 'refused':
        case 'fix-only':
        case 'not-a-document':
          break;
      }
    });
  }
});
