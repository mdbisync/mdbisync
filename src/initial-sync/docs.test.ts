// The public page on the initial sync from Linear to git against the code:
// the names a reader meets in a run (the pull request's title, the job
// summary's tables, the rules that leave a document out, the refusal and the
// exit codes), and the links that lead to and from the page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { PROGRESS_BATCH } from './confirm.ts';
import { PULL_REQUEST_TITLE, RECORD_LEFT_OUT_RULES } from './reverse.ts';
import { UPLOAD_TOO_LARGE, UPLOAD_UNREADABLE } from './uploads.ts';

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

// The public page on the initial sync from git to Linear against the code:
// every input of the action with its default, the job summary's headings and
// tables, the rules that leave a file out, how a confirmed run ends, and the
// links that lead to and from the page.
describe('the initial sync from git to Linear page', () => {
  const PAGE = 'docs/initial-sync-git-to-linear.md';
  const page = read(PAGE);
  const flat = page.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');
  const summary = read('src/initial-sync/summary.ts');
  const section = (from: string, to: string) => summary.slice(summary.indexOf(`export function ${from}`), summary.indexOf(`export function ${to}`));

  it('describes every input of the action with its default', () => {
    const action = read('action.yml');
    const inputs = action.slice(action.indexOf('\ninputs:\n'), action.indexOf('\noutputs:\n') + 1);
    const found = [...inputs.matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n)+)/gm)];
    assert.ok(found.length >= 15, `found only ${found.length} inputs`);
    for (const [, name, body] of found) {
      const required = /^ {4}required: true$/m.test(body!);
      const value = /^ {4}default: "?([^"\n]*)"?$/m.exec(body!)?.[1];
      const shown = required || value === undefined ? 'none' : value === '' ? 'empty' : `\`${value}\``;
      assert.match(page, new RegExp(`^\\| \`${name}\` \\| ${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`, 'm'), `the input ${name} with the default ${shown}`);
    }
  });

  it("names the job summary's headings and every table of both runs", () => {
    for (const [from, to] of [['renderDryRun', 'renderConfirmed'], ['renderConfirmed', 'toReversePlanReport']] as const) {
      const code = section(from, to);
      const heading = /'## ([^']+)'/.exec(code)?.[1];
      assert.ok(heading !== undefined && flat.includes(`**${heading}**`), `the heading ${heading}`);
      const tables = [...code.matchAll(/pushTable\(\s*lines,\s*'([^']+)'/g)].map((match) => match[1]!);
      assert.ok(tables.length >= 3, `found only ${tables.join(', ')} in ${from}`);
      for (const table of tables) assert.match(page, new RegExp(`^\\| ${table} \\|`, 'm'), `the table ${table} of ${from}`);
    }
    const capacity = /'### ([^']+)'/.exec(read('src/run/capacity.ts'))?.[1];
    assert.ok(capacity !== undefined);
    assert.match(page, new RegExp(`^\\| ${capacity} \\|`, 'm'), 'the capacity table');
  });

  it('names every rule the plan and the write leave a file out by', () => {
    const mapping = read('src/mapping/mapping.ts');
    const unsynced = /type UnsyncedReason = ([^;]+);/.exec(mapping)?.[1] ?? '';
    // A file above every annotation has no title in Linear, so the plan does not list it.
    const reasons = [...unsynced.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!).filter((reason) => reason !== 'outside-annotations');
    assert.ok(reasons.length >= 3);
    for (const rule of [...reasons, 'duplicate-title', 'title-too-long', 'content-too-long', UPLOAD_TOO_LARGE, UPLOAD_UNREADABLE]) {
      assert.ok(flat.includes(`\`${rule}\``), `the rule ${rule}`);
    }
  });

  it('explains every way a confirmed run ends unfinished, and the exit codes', () => {
    const confirm = read('src/initial-sync/confirm.ts');
    const codes = [...(/\n {2}code\?: ([^;]+);/.exec(confirm)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
    assert.ok(codes.length >= 4, `found only ${codes.join(', ')}`);
    for (const code of codes) assert.ok(flat.includes(`\`${code}\``), `the code ${code}`);
    assert.ok(flat.includes(`exits with code 0 (code ${SETUP_FAILED_EXIT_CODE} when the setup check fails)`), 'the dry run');
    assert.ok(flat.includes(`exits with code ${INCOMPLETE_EXIT_CODE}`), 'a stopped run');
    assert.ok(flat.includes(`\`initial-sync-required\` and exit code ${NO_STATE_EXIT_CODE}`), 'the sync before the record');
    assert.ok(flat.includes(`\`initial-pull-request-pending\` and exit code ${NO_STATE_EXIT_CODE}`), 'an open pull request from Linear');
  });

  it('gives the progress batch and the job time limit the code and template use', () => {
    assert.ok(flat.includes(`every ${PROGRESS_BATCH} documents`), 'the progress batch');
    const minutes = /timeout-minutes: (\d+)/.exec(read('examples/mdbisync-initial-sync.yml'))?.[1];
    assert.ok(minutes !== undefined && flat.includes(`time limit of ${minutes} minutes`), 'the time limit');
  });

  it('is linked from the README, usage.md and troubleshooting.md, and its links land on headings', () => {
    assert.ok(read('README.md').includes(`](${PAGE})`), 'README');
    assert.ok(read('docs/usage.md').includes('](initial-sync-git-to-linear.md)'), 'usage.md');
    assert.ok(read('docs/troubleshooting.md').includes('](initial-sync-git-to-linear.md#recovery)'), 'troubleshooting.md');
    const targets = new Map<string, Set<string>>([['', anchors(page)], ['../README.md', anchors(read('README.md'))]]);
    for (const file of ['usage.md', 'troubleshooting.md', 'linear-format.md', 'initial-sync-linear-to-git.md']) targets.set(file, anchors(read(`docs/${file}`)));
    const links = [...page.matchAll(/\]\(([^)#\s]*)#([^)]+)\)/g)];
    assert.ok(links.length >= 10, `found only ${links.length} links with an anchor`);
    for (const [, file, anchor] of links) {
      assert.ok(targets.has(file!), `a link to ${file}`);
      assert.ok(targets.get(file!)!.has(anchor!), `${file}#${anchor}`);
    }
  });
});
