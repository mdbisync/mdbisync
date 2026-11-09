// The public page on the sync cycle against the code: the run's steps, the
// sync pull request's title, the blocked mark and its comment, every line
// and table of a sync run's summary, and the links that lead to and from
// the page. The codes and what to do about them are on the troubleshooting
// page; this test checks that the codes and skip reasons it leaves there are
// spelled there as the code spells them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
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
  const found = [...line.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
  assert.ok(found.length > 0, `${path}: no code literals on the line of ${member}`);
  return found;
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

/** Asserts that each message is both in the code that writes it and on the page. */
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
    // The cycle calls its steps in that order: capture, the sync pull request, then steps 3 to 5.
    const cycle = read('src/sync/cycle.ts');
    const calls = ['await capture(', 'await syncPullRequest(', 'await writeTrackedToLinear('].map((call) => cycle.indexOf(call));
    assert.ok(calls.every((at) => at >= 0), 'the cycle calls every step');
    assert.deepEqual([...calls].sort((a, b) => a - b), calls, 'the cycle calls the steps in the page order');
    // Steps 3 to 5 in the write step, in the same order: merge locally, write, record.
    const write = read('src/sync/write.ts');
    const inner = ['mergeLocally(', 'MERGE_RECORD_MESSAGE'].map((name) => write.indexOf(name, write.indexOf('export async function writeTrackedToLinear')));
    assert.ok(inner.every((at) => at >= 0) && inner[0]! < inner[1]!, 'the write step merges before it records');
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

  it('describes every ordinary outcome of the sync pull request step, and names every other code', () => {
    described('src/sync/pull-request.ts', [
      'Merged the sync pull request with a merge commit',
      'The tracked branch already holds every change from Linear',
      'Opened the sync pull request',
      'Added new Linear changes to the sync pull request',
    ]);
    // "The sync pull request <link> waits for <checks>": the link sits between the words.
    assert.ok(read('src/sync/pull-request.ts').includes('`The sync pull request ${link} waits for'));
    assert.ok(flat.includes('| The sync pull request waits for its checks |'));
    for (const code of codes('src/sync/pull-request.ts', /^ {2}code\?: 'check-failed'/)) assert.ok(flat.includes(`\`${code}\``), code);
  });

  it('describes every outcome and table of the write step', () => {
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
    assert.ok(flat.includes('**Container document capacity**'));
    assert.ok(read('src/run/capacity.ts').includes("'### Container document capacity'"));
  });

  it('leaves the skip reasons to troubleshooting.md, which words them as the summary does', () => {
    // That page's own test checks that every code is there; this checks the words the "Skipped" table uses.
    const troubleshooting = read('docs/troubleshooting.md');
    for (const [reason, text] of Object.entries(SKIP_REASONS)) {
      assert.ok(troubleshooting.includes(`| \`${reason}\` | ${text[0]!.toUpperCase()}${text.slice(1)}. |`), `the reason ${reason}`);
    }
    assert.ok(flat.includes(`\`sync: ${PARTIAL} (<code>)\``), 'the partial message');
  });

  it('is linked from the README, usage.md and conflicts.md, and its links land on headings', () => {
    assert.ok(read('README.md').includes(`](${PAGE})`), 'README');
    assert.ok(read('docs/usage.md').includes('](sync-cycle.md)'), 'usage.md');
    assert.ok(read('docs/conflicts.md').includes('](sync-cycle.md#the-run-summary)'), 'conflicts.md');
    // Every relative link: to a page next to this one, with or without an anchor, or to a heading of this page.
    const links = [...page.matchAll(/\]\(([a-z0-9-]+\.md)?(?:#([^)]+))?\)/g)].filter(([, file, anchor]) => file !== undefined || anchor !== undefined);
    assert.ok(links.length > 10);
    for (const [, file, anchor] of links) {
      const target = file === undefined ? page : read(`docs/${file}`);
      if (anchor !== undefined) assert.ok(anchors(target).has(anchor), `${file ?? ''}#${anchor}`);
    }
  });
});
