// The public page on the sync cycle against the code: the sync pull
// request's title, the blocked mark and its comment, every message, table,
// code and skip reason of a sync run's summary, how a run ends, and the
// links that lead to and from the page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { PARTIAL } from '../run/stop.ts';
import { BLOCKED_COMMENT, MARKS } from './marks.ts';
import { SYNC_PULL_REQUEST_TITLE } from './pull-request.ts';
import { SKIP_REASONS } from './summary.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const PAGE = 'docs/sync-cycle.md';
const page = read(PAGE);
const flat = page.replace(/\n *> ?/g, ' ').replace(/\s+/g, ' ');
const flatSource = (path: string) => read(path).replace(/\s+/g, ' ');

/** The string literals of a `code?:` union in a source file, found by the interface member's line. */
function codes(path: string, member: RegExp): string[] {
  const line = read(path).split('\n').find((text) => member.test(text));
  assert.ok(line !== undefined, `${path}: ${member}`);
  return [...line.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
}

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

/** Asserts that a message is both in the code that writes it and on the page. */
function described(source: string, messages: readonly string[]) {
  const code = flatSource(source);
  for (const message of messages) {
    assert.ok(code.includes(message), `${source} no longer says: ${message}`);
    assert.ok(flat.includes(message), `the page does not describe: ${message}`);
  }
}

describe('the sync cycle page', () => {
  it('names the run steps in the order the code runs them', () => {
    const steps = [...page.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(steps, ['Setup check.', 'Capture.', 'Linear to git.', 'Git to Linear, computed.', 'Write.', 'Record.']);
  });

  it('names the sync pull request and the blocked mark as the code makes them', () => {
    assert.ok(flat.includes(`**${SYNC_PULL_REQUEST_TITLE}**`), 'the pull request title');
    assert.ok(flat.includes(BLOCKED_COMMENT), 'the blocked comment');
    assert.match(page, /^ *> - Hook `[^`]+`, line \d+\.$/m, 'a finding line as the comment writes it');
    assert.ok(flat.includes(`Red \`${MARKS.blocked.icon}\``), 'the blocked icon');
    assert.ok(flat.includes(`Orange \`${MARKS.conflict.icon}\``), 'the conflict icon');
  });

  it("describes every line of the capture's summary", () => {
    described('src/sync/capture.ts', ['Removal held for', 'The document id map was lost', 'Capture partial, will continue', 'Content is pushed unchecked']);
    for (const code of codes('src/sync/capture.ts', /writeBackWarnings: Array/)) assert.ok(flat.includes(`\`${code}\``), code);
    for (const rule of ['capture-translation', 'security-unchecked']) {
      assert.ok(read('src/sync/capture.ts').includes(`rule: '${rule}'`), rule);
      assert.ok(flat.includes(`\`${rule}\``), rule);
    }
    described('src/sync/summary.ts', ['Capture did not finish; no tracked-branch changes were written.']);
  });

  it('describes every outcome of the sync pull request step', () => {
    for (const code of codes('src/sync/pull-request.ts', /^ {2}code\?: 'check-failed'/)) assert.match(page, new RegExp(`^\\| .*\\(\`${code}\`\\) \\|`, 'm'), code);
    described('src/sync/pull-request.ts', [
      'Merged the sync pull request with a merge commit',
      'The tracked branch already holds every change from Linear',
      'Opened the sync pull request',
      'Added new Linear changes to the sync pull request',
      'failed on the sync pull request',
      'Setup error: GitHub refused again to merge',
      'GitHub did not merge the sync pull request',
      'The sync branch holds an initial sync from Linear',
      'The sync branch moved while this run worked',
    ]);
  });

  it('describes every outcome, table and skip reason of the write step', () => {
    described('src/sync/summary.ts', [
      'Linear already holds the tracked branch: nothing to write.',
      'Linear now holds the tracked branch.',
      'Some documents were not written; the next run writes them.',
      'A state ref moved while this run was writing',
      'Nothing was written.',
    ]);
    const tables = [...read('src/sync/summary.ts').matchAll(/table\('([^']+)'/g)].map((match) => match[1]!);
    assert.ok(tables.length >= 7, `found only ${tables.join(', ')}`);
    for (const table of tables) assert.match(page, new RegExp(`^\\| ${table} \\|`, 'm'), `the table ${table}`);
    for (const [reason, text] of Object.entries(SKIP_REASONS)) {
      assert.ok(flat.includes(`| \`${reason}\` | ${text[0]!.toUpperCase()}${text.slice(1)}. |`), `the reason ${reason}`);
    }
    assert.ok(flat.includes('Container document capacity'));
    assert.ok(read('src/run/capacity.ts').includes("'### Container document capacity'"));
  });

  it('tells how a run ends, with the codes and exit codes the code uses', () => {
    assert.ok(flat.includes(`\`sync: ${PARTIAL} (<code>)\``), 'the partial message');
    const partial = [...codes('src/sync/capture.ts', /^ {2}code\?: 'state-moved'/), ...codes('src/sync/write.ts', /^ {2}code\?: 'stopped'/), 'removal-held'].filter((code) => code !== 'container-cap');
    for (const code of new Set(partial)) assert.ok(flat.includes(`\`${code}\``), code);
    assert.match(page, new RegExp(`\\| warning \\| ${INCOMPLETE_EXIT_CODE} \\|`));
    assert.match(page, new RegExp(`\\| failure \\| ${SETUP_FAILED_EXIT_CODE} \\| \`sync: setup error`));
    assert.match(page, new RegExp(`\\| failure \\| ${NO_STATE_EXIT_CODE} \\|`));
    assert.match(page, new RegExp(`\\| failure \\| ${INCOMPLETE_EXIT_CODE} \\| \`sync: stopped before any write \\(container-cap\\)`));
  });

  it('is linked from the README and usage.md, and its links land on headings', () => {
    assert.ok(read('README.md').includes(`](${PAGE})`), 'README');
    assert.ok(read('docs/usage.md').includes('](sync-cycle.md)'), 'usage.md');
    const targets: Record<string, Set<string>> = {
      '': anchors(page),
      'usage.md': anchors(read('docs/usage.md')),
      'conflicts.md': anchors(read('docs/conflicts.md')),
    };
    const links = [...page.matchAll(/\]\(((?:usage\.md|conflicts\.md)?)#([^)]+)\)/g)];
    assert.ok(links.length > 5);
    for (const [, file, anchor] of links) assert.ok(targets[file!]!.has(anchor!), `${file}#${anchor}`);
  });
});
