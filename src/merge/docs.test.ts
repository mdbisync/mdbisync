// The public conflicts page against the code: every marker paragraph and
// notice the sync writes, its merge examples reproduced by the merge itself,
// and its table of delete and rename rules checked case by case.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CONFLICT_COMMENT } from '../sync/marks.ts';
import { detectConflicts, MARKERS } from './markers.ts';
import { mergeMarkdown } from './merge.ts';
import { RETITLED_COMMENT, resolveStructural, type StructuralInput } from './structural.ts';

const docs = readFileSync(new URL('../../docs/conflicts.md', import.meta.url), 'utf8');

/** The lines of a `## ` section, up to the next `## ` heading outside a fence. */
function section(heading: string): string {
  const lines = docs.split('\n');
  const from = lines.indexOf(`## ${heading}`);
  assert.notEqual(from, -1, `the conflicts page has no section "${heading}"`);
  let fenced = false;
  let to = from + 1;
  for (; to < lines.length; to++) {
    if (lines[to]!.startsWith('```')) fenced = !fenced;
    else if (!fenced && lines[to]!.startsWith('## ')) break;
  }
  return lines.slice(from, to).join('\n');
}

/** The bodies of a text's `markdown` fences, each ending with a newline as a file does. */
function markdownFences(text: string): string[] {
  return [...text.matchAll(/^```markdown\n([\s\S]*?)\n```$/gm)].map((match) => `${match[1]!}\n`);
}

/** Prose as one line: block quote prefixes dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/^[ \t]*> ?/gm, '').replace(/\s+/g, ' ');
}

/** The cells of a section's table rows, header and separator left out. */
function tableRows(text: string): string[][] {
  const rows = text.split('\n').filter((line) => line.startsWith('| '));
  return rows.slice(2).map((row) => row.slice(2, -2).split(' | '));
}

const BASE = { path: 'notes/plan.md', text: '# Plan\n\nOne.\n\nTwo.\n' };
const EDITED = { path: BASE.path, text: '# Plan\n\nOne, edited.\n\nTwo.\n' };
const OTHER_EDIT = { path: BASE.path, text: '# Plan\n\nOne.\n\nTwo, edited.\n' };
const RENAMED = { path: 'notes/schedule.md', text: BASE.text };
const RENAMED_ELSEWHERE = { path: 'notes/timeline.md', text: BASE.text };

// One case per row of the page's table, keyed by its git and Linear cells.
const ROWS: Record<string, StructuralInput[]> = {
  'deleted | edited or renamed': [{ base: BASE, git: null, linear: EDITED }, { base: BASE, git: null, linear: RENAMED }],
  'edited or renamed | deleted': [{ base: BASE, git: EDITED, linear: null }, { base: BASE, git: RENAMED, linear: null }],
  'deleted | deleted': [{ base: BASE, git: null, linear: null }],
  'renamed | edited': [{ base: BASE, git: RENAMED, linear: OTHER_EDIT }],
  'edited | renamed': [{ base: BASE, git: EDITED, linear: { ...RENAMED, text: OTHER_EDIT.text } }],
  'renamed | renamed to the same path': [{ base: BASE, git: RENAMED, linear: RENAMED }],
  'renamed | renamed to another path': [{ base: BASE, git: RENAMED, linear: RENAMED_ELSEWHERE }],
};

describe('conflicts docs', () => {
  it('show every conflict marker paragraph', () => {
    const shown = tableRows(section('The conflict markers')).map(([marker]) => marker);
    assert.deepEqual(shown, Object.values(MARKERS).map((marker) => `\`${marker}\``));
  });

  it('quote the conflict comment and the title comment exactly', () => {
    assert.ok(flat(docs).includes(CONFLICT_COMMENT), 'the conflict comment is not quoted');
    assert.ok(flat(docs).includes(RETITLED_COMMENT), 'the title comment is not quoted');
  });

  it('hold no conflict of their own: every marker on the page is an example', () => {
    assert.deepEqual(detectConflicts(docs), []);
  });

  for (const heading of ['A worked example', 'Whole tables, code blocks and lists']) {
    it(`give the merge's own result in "${heading}"`, async () => {
      const [base, git, linear, shown] = markdownFences(section(heading));
      assert.ok(shown !== undefined, 'the example needs the base, git, Linear and merged versions');
      const merged = await mergeMarkdown(base!, git!, linear!);
      assert.equal(merged.text, shown);
      assert.equal(merged.conflicts.length, 1);
    });
  }

  it('give each delete and rename rule with the summary code the code reports', async () => {
    const rows = tableRows(section('Deletes and renames'));
    assert.deepEqual(rows.map(([git, linear]) => `${git} | ${linear}`), Object.keys(ROWS));
    for (const [git, linear, , code] of rows) {
      for (const input of ROWS[`${git} | ${linear}`]!) {
        const result = await resolveStructural(input);
        assert.equal(result.summary === null ? 'none' : `\`${result.summary.code}\``, code, `${git} | ${linear}: ${result.kind}`);
      }
    }
  });
});
