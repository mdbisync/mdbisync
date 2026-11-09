// The public page on the initial sync from Linear to git against the code:
// the names a reader meets in a run (the pull request's title, the job
// summary's tables, the rules that leave a document out, the refusal and the
// exit codes), and the links that lead to and from the page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE } from '../commands.ts';
import { PULL_REQUEST_TITLE, RECORD_LEFT_OUT_RULES } from './reverse.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const PAGE = 'docs/initial-sync-linear-to-git.md';
const page = read(PAGE);
const flat = page.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');

/** GitHub's anchors for the headings outside code fences: lowercase, punctuation dropped, spaces as hyphens. */
function anchors(markdown: string): Set<string> {
  let fenced = false;
  const headings: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) headings.push(line.replace(/^#+ /, ''));
  }
  return new Set(headings.map((heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')));
}

describe('the initial sync from Linear to git page', () => {
  it('names the pull request, the refusal and the exit codes the code uses', () => {
    assert.ok(flat.includes(`**${PULL_REQUEST_TITLE}**`), 'the pull request title');
    assert.ok(flat.includes('`initial-pull-request-pending`'), 'the refusal code');
    assert.ok(flat.includes(`exit code ${NO_STATE_EXIT_CODE}`), 'the exit code of a refused sync');
    assert.ok(flat.includes(`code ${INCOMPLETE_EXIT_CODE}`), 'the exit code of a stopped run');
  });

  it("lists every table of the dry run's job summary", () => {
    const summary = read('src/initial-sync/summary.ts');
    const reverse = summary.slice(summary.indexOf('export function renderReverseDryRun'), summary.indexOf('export function renderReverseConfirmed'));
    const tables = [...reverse.matchAll(/pushTable\(lines, '([^']+)'/g)].map((match) => match[1]!);
    assert.ok(tables.length >= 5, `found only ${tables.join(', ')}`);
    for (const table of tables) assert.match(page, new RegExp(`^\\| ${table} \\|`, 'm'), `the table ${table}`);
  });

  it('explains every rule that leaves a document out of the record', () => {
    for (const rule of RECORD_LEFT_OUT_RULES) assert.match(page, new RegExp(`^\\| \`${rule}\` \\|`, 'm'), `the rule ${rule}`);
  });

  it('spells out the merge by a person', () => {
    assert.match(page, /^## Step 3: a person reviews and merges the pull request$/m);
    assert.ok(flat.includes('**Create a merge commit**'));
    assert.ok(flat.includes('The sync never merges that pull request'));
  });

  it('is linked from the README and usage.md, and its links to usage.md land on headings', () => {
    assert.ok(read('README.md').includes(`](${PAGE})`), 'README');
    assert.ok(read('docs/usage.md').includes('](initial-sync-linear-to-git.md)'), 'usage.md');
    const usage = anchors(read('docs/usage.md'));
    const own = anchors(page);
    const links = [...page.matchAll(/\]\(((?:usage\.md)?)#([^)]+)\)/g)];
    assert.ok(links.length > 0);
    for (const [, file, anchor] of links) assert.ok((file === '' ? own : usage).has(anchor!), `${file}#${anchor}`);
  });
});
