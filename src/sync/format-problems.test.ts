// The format problems pull request: files the sync leaves out for their
// Markdown are shown in one pull request from the sync's own branch, with
// what `fix` writes for them and the findings left to a person. The sync
// never merges it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY } from './pull-request-test-helpers.ts';
import { formatProblems, formatProblemsBody } from './format-problems.ts';

const BRANCH = 'mdbisync/format-problems';
const PLAN = 'eng/notes/plan.md';
const GUIDE = 'combined/guide.md';
/** A lone `+` below an item's first line: `fix` writes it with a no-break space after it. */
const PLUS = `---\nowner: example\n---\n\n# Plan\n\n- Water the beds\n  +\n- Turn the compost ${CANARY}\n`;
const FOOTNOTE = `# Guide\n\nHow to start.[^1] ${CANARY}\n\n[^1]: A note.\n`;

describe('sync: the format problems pull request', () => {
  const h = pullRequestHarness();
  const { sync, show, rev, documentOf, editRef, mergeOnRemote } = h;
  const formatPullRequests = () => h.world.github.pullRequests.filter((pr) => pr.head === BRANCH);

  it('a direct push of a file fix can write and one it cannot opens one pull request with the rewrite and the finding; the sync never merges it', async () => {
    const before = { plan: (await documentOf(PLAN)).content, guide: (await documentOf(GUIDE)).content };
    await editRef('refs/heads/main', PLAN, PLUS);
    const tracked = await editRef('refs/heads/main', GUIDE, FOOTNOTE);

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.sync?.leftOut, [{ path: GUIDE, rules: ['footnote'] }, { path: PLAN, rules: ['plus-line-in-item'] }]);
    assert.deepEqual(run.writes, ['POST /pulls']);
    assert.equal((await documentOf(PLAN)).content, before.plan);
    assert.equal((await documentOf(GUIDE)).content, before.guide);

    const [pr, ...others] = formatPullRequests();
    assert.ok(pr !== undefined && others.length === 0);
    assert.equal(pr.base, 'main');
    assert.equal(pr.title, 'Fix Markdown format problems');
    const head = await rev(`refs/heads/${BRANCH}`);
    assert.deepEqual((await h.fixture.remote.text(['rev-list', '--parents', '-n', '1', head])).split(' ').slice(1), [tracked]);
    assert.match(await show(`${head}:${PLAN}`), /^ {2}\+ $/m);
    assert.equal(await show(`${head}:${GUIDE}`), FOOTNOTE);
    assert.match(pr.body, /\| eng\/notes\/plan\.md \|/);
    assert.match(pr.body, /\| combined\/guide\.md \| 3 \| footnote \| yes \|/);
    assert.doesNotMatch(pr.body, new RegExp(CANARY));
    assert.deepEqual(run.report.formatProblems?.files.map((file) => [file.path, file.fixed]), [[GUIDE, false], [PLAN, true]]);
    assert.deepEqual(run.report.formatProblems?.pullRequest, { number: pr.number, url: run.report.formatProblems?.pullRequest?.url, opened: true, updated: false });
    assert.match(run.summary, /Files left out for their Markdown \(2\): \[format problems pull request #1\]/);

    // Nothing new: the pull request and its branch stay as they are, and it is never merged.
    const quiet = await sync();
    assert.deepEqual(quiet.writes, []);
    assert.equal(await rev(`refs/heads/${BRANCH}`), head);
    assert.equal(formatPullRequests()[0]?.state, 'open');
    assert.equal(formatPullRequests()[0]?.merged, false);
  });

  it('merging it writes the fixed file to Linear, and once no file is left out for its Markdown no pull request is open', async () => {
    await editRef('refs/heads/main', PLAN, PLUS);
    await sync();
    const pr = formatPullRequests()[0]!;
    const head = await rev(`refs/heads/${BRANCH}`);
    // A person merges it.
    h.syncValues.push(head);
    const merged = await mergeOnRemote(pr, head);
    assert.ok('sha' in merged);
    pr.state = 'closed';
    pr.merged = true;

    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.report.sync?.updated, [PLAN]);
    assert.match((await documentOf(PLAN)).content ?? '', /^ {2}\+ $/m);
    assert.deepEqual(run.report.sync?.leftOut, []);
    assert.deepEqual(run.report.formatProblems?.files, []);
    assert.equal(run.report.formatProblems?.pullRequest, null);
    assert.deepEqual(formatPullRequests().filter((open) => open.state === 'open'), []);
  });

  it('a file fixed on the tracked branch closes the pull request without merging it', async () => {
    await editRef('refs/heads/main', GUIDE, FOOTNOTE);
    await sync();
    await editRef('refs/heads/main', GUIDE, `# Guide\n\nHow to begin. ${CANARY}\n`);
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.deepEqual(run.writes, ['UpdateDocument', 'PATCH /pulls/1']);
    assert.equal(run.report.formatProblems?.closed, 1);
    assert.equal(formatPullRequests()[0]?.state, 'closed');
    assert.equal(formatPullRequests()[0]?.merged, false);
    assert.match(run.summary, /Closed format problems pull request #1/);
  });

  it('a new commit on the tracked branch moves the pull request\'s branch forward, never back', async () => {
    await editRef('refs/heads/main', PLAN, PLUS);
    await sync();
    const first = await rev(`refs/heads/${BRANCH}`);
    await editRef('refs/heads/main', GUIDE, FOOTNOTE);
    const run = await sync();
    assert.deepEqual(run.writes, ['PATCH /pulls/1']);
    const next = await rev(`refs/heads/${BRANCH}`);
    assert.notEqual(next, first);
    assert.equal((await h.fixture.remote.run(['merge-base', '--is-ancestor', first, next], { okCodes: [0, 1] })).code, 0);
    assert.match(await show(`${next}:${PLAN}`), /^ {2}\+ $/m);
    assert.equal(await show(`${next}:${GUIDE}`), FOOTNOTE);
    assert.match(formatPullRequests()[0]?.body ?? '', /combined\/guide\.md \| 3 \| footnote/);
  });
});

describe('the format problems pull request, closed by a person', () => {
  const h = pullRequestHarness();
  const { sync, editRef } = h;

  it('stays closed until the tracked branch changes', async () => {
    await editRef('refs/heads/main', GUIDE, FOOTNOTE);
    await sync();
    const pr = h.world.github.pullRequests.find((candidate) => candidate.head === BRANCH)!;
    pr.state = 'closed';
    const quiet = await sync();
    assert.equal(quiet.result.exitCode, 0, quiet.result.stderr);
    assert.deepEqual(quiet.writes, []);
    assert.equal(quiet.report.formatProblems?.dismissed, pr.number);
    assert.match(quiet.summary, /was closed without merging/);

    await editRef('refs/heads/main', PLAN, PLUS);
    const moved = await sync();
    assert.deepEqual(moved.writes, ['POST /pulls']);
    assert.equal(h.world.github.pullRequests.filter((candidate) => candidate.head === BRANCH && candidate.state === 'open').length, 1);
  });
});

describe('files left out for their Markdown', () => {
  it('lists a colliding file\'s findings without rewriting it, and skips a document lint lets through', () => {
    const tab = '# Steps\n\n- One\n\t- Two\n';
    const mapping = {
      documents: [{ path: 'notes/plan.md', oid: 'a', title: 'plan', place: { kind: 'team' as const, team: 'ENG' } }, { path: 'notes/clean.md', oid: 'b', title: 'clean', place: { kind: 'team' as const, team: 'ENG' } }],
      leftOut: [{ path: 'notes/Guide.md', oid: 'c', rule: 'duplicate-title' as const, title: 'guide', place: { kind: 'team' as const, team: 'ENG' }, collidesWith: ['notes/guide.md'] }],
      files: new Set(['notes/plan.md', 'notes/clean.md', 'notes/Guide.md']),
    };
    const problems = formatProblems(mapping, new Map([['notes/plan.md', tab], ['notes/clean.md', '# Clean\n'], ['notes/Guide.md', tab]]));
    assert.deepEqual(problems.map((problem) => [problem.path, problem.fixed]), [['notes/Guide.md', false], ['notes/plan.md', true]]);
    assert.equal(problems[0]?.text, tab);
    assert.deepEqual(problems[0]?.findings.map((finding) => finding.rule), ['tab-indentation']);
    assert.deepEqual(problems[1]?.findings, []);
  });
});

describe('the format problems pull request\'s description', () => {
  it('stays within GitHub\'s limit and says how many findings it leaves out', () => {
    const findings = Array.from({ length: 2000 }, (_, i) => ({ line: i + 1, rule: 'footnote' as const, message: 'x'.repeat(200), holdsBack: true }));
    const body = formatProblemsBody([{ path: 'notes/long.md', fixed: false, findings }]);
    assert.ok(body.length < 65_536, String(body.length));
    assert.match(body, /^And \d+ more: run `mdbisync lint` on the files to see them all\.$/m);
  });

  it('lists each finding left to a person, escaped for a table, and the files fix rewrote', () => {
    const body = formatProblemsBody([
      { path: 'notes/a|b.md', fixed: true, findings: [] },
      { path: 'notes/c.md', fixed: false, findings: [{ line: 4, rule: 'footnote', message: 'Footnotes are dropped.', holdsBack: true }] },
    ]);
    assert.match(body, /^### Fixed by `mdbisync fix` \(1\)$/m);
    assert.match(body, /^\| notes\/a\\\|b\.md \|$/m);
    assert.match(body, /^\| notes\/c\.md \| 4 \| footnote \| yes \| Footnotes are dropped\. \|$/m);
    assert.match(body, /never merges it/);
  });
});
