// The public pages on the initial sync against the code, one block per
// direction. From Linear to git: the names a reader meets in a run (the pull
// request's title, the job summary's tables, the rules that leave a document
// out, the refusal and the exit codes), and the links that lead to and from
// the page. From git to Linear: see the second block.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE, USAGE_EXIT_CODE } from '../commands.ts';
import { PROGRESS_BATCH } from './confirm.ts';
import { PULL_REQUEST_TITLE, RECORD_LEFT_OUT_RULES } from './reverse.ts';
import { LEFT_OUT_AT_WRITE_RULES, LEFT_OUT_RULES, UNSYNCED_REASONS, WRITE_CODES } from '../codes.ts';

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
// links that lead to and from the gitPage.
describe('the initial sync from git to Linear page', () => {
  const GIT_PAGE = 'docs/initial-sync-git-to-linear.md';
  const gitPage = read(GIT_PAGE);
  const gitFlat = gitPage.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');
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
      assert.match(gitPage, new RegExp(`^\\| \`${name}\` \\| ${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`, 'm'), `the input ${name} with the default ${shown}`);
    }
  });

  it("names the job summary's headings and every table of both runs", () => {
    for (const [from, to] of [['renderDryRun', 'renderConfirmed'], ['renderConfirmed', 'toReversePlanReport']] as const) {
      const code = section(from, to);
      const heading = /'## ([^']+)'/.exec(code)?.[1];
      assert.ok(heading !== undefined && gitFlat.includes(`**${heading}**`), `the heading ${heading}`);
      const tables = [...code.matchAll(/pushTable\(\s*lines,\s*'([^']+)'/g)].map((match) => match[1]!);
      assert.ok(tables.length >= 3, `found only ${tables.join(', ')} in ${from}`);
      for (const table of tables) assert.match(gitPage, new RegExp(`^\\| ${table} \\|`, 'm'), `the table ${table} of ${from}`);
    }
    const capacity = /'### ([^']+)'/.exec(read('src/run/capacity.ts'))?.[1];
    assert.ok(capacity !== undefined);
    assert.match(gitPage, new RegExp(`^\\| ${capacity} \\|`, 'm'), 'the capacity table');
  });

  it('names every rule the plan and the write leave a file out by', () => {
    // A file above every annotation has no title in Linear, so the plan does not list it.
    const reasons = UNSYNCED_REASONS.filter((reason) => reason !== 'outside-annotations');
    for (const rule of [...reasons, ...LEFT_OUT_RULES, ...LEFT_OUT_AT_WRITE_RULES]) {
      assert.ok(gitFlat.includes(`\`${rule}\``), `the rule ${rule}`);
    }
  });

  it('explains every way a confirmed run ends unfinished, and the exit codes', () => {
    for (const code of WRITE_CODES) assert.ok(gitFlat.includes(`\`${code}\``), `the code ${code}`);
    assert.ok(gitFlat.includes(`exits with code 0 (code ${SETUP_FAILED_EXIT_CODE} when the setup check fails, code ${USAGE_EXIT_CODE} when an input is missing or wrong, code ${INCOMPLETE_EXIT_CODE} when`), 'the dry run');
    assert.ok(gitFlat.includes(`exits with code ${INCOMPLETE_EXIT_CODE}`), 'a stopped run');
    assert.ok(gitFlat.includes(`\`initial-sync-required\` and exit code ${NO_STATE_EXIT_CODE}`), 'the sync before the record');
    assert.ok(gitFlat.includes(`\`initial-pull-request-pending\` and exit code ${NO_STATE_EXIT_CODE}`), 'an open pull request from Linear');
  });

  it('gives the progress batch and the job time limit the code and template use', () => {
    assert.ok(gitFlat.includes(`every ${PROGRESS_BATCH} documents`), 'the progress batch');
    const minutes = /timeout-minutes: (\d+)/.exec(read('examples/mdbisync-initial-sync.yml'))?.[1];
    assert.ok(minutes !== undefined && gitFlat.includes(`time limit of ${minutes} minutes`), 'the time limit');
  });

  it('is linked from every page that leads to it, and its links resolve', () => {
    assert.ok(read('README.md').includes(`](${GIT_PAGE})`), 'README');
    for (const [file, link] of [['usage.md', 'initial-sync-git-to-linear.md'], ['quickstart.md', 'initial-sync-git-to-linear.md'], ['initial-sync-linear-to-git.md', 'initial-sync-git-to-linear.md'], ['troubleshooting.md', 'initial-sync-git-to-linear.md#recovery']]) {
      assert.ok(read(`docs/${file}`).includes(`](${link})`), file);
    }
    const links = [...gitPage.matchAll(/\]\(([^)#\s]*)(?:#([^)]+))?\)/g)].filter(([, file]) => !/^[a-z]+:/.test(file!));
    assert.ok(links.length >= 15, `found only ${links.length} relative links`);
    for (const [, file, anchor] of links) {
      const target = file === '' ? gitPage : read(`docs/${file}`);
      if (anchor !== undefined) assert.ok(anchors(target).has(anchor), `${file}#${anchor}`);
    }
  });
});
