// Relative links that people type in Linear. The sync uploads the file a
// document's relative link names when it writes the document, so a link
// typed in Linear that names a repository file never reaches git: the
// capture blocks the document as it blocks an image that is not an upload.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANARY, pullRequestHarness } from './pull-request-test-helpers.ts';

const SECRET = 'account,balance\nprivate-row,1000\n';
const PLAN = 'eng/notes/plan.md';
const planText = (paragraph: string) => `---\nowner: example\n---\n\n# Plan\n\n${paragraph} ${CANARY}\n`;
const NOTICE = 'Some files in this document cannot be synchronized. Fix the listed files and sync again.\n\n- File 1 of 1 (line 3): not uploaded to this workspace. Upload the file instead of linking to it.';

describe('sync: relative links typed in Linear', () => {
  const h = pullRequestHarness();
  const { commentsOf, documentOf, editInLinear, gitEdit, settle, show, sync } = h;
  const uploadedBytes = () => h.world.linear.uploads.map((upload) => upload.bytes?.toString('utf8'));

  it('a link to a repository file typed in Linear is blocked at capture and never uploads the file, also after a git edit', async () => {
    // A file outside every synchronized folder, which no document of the repository links.
    await gitEdit('private/report.csv', SECRET);
    await settle();
    const uploads = h.world.linear.uploads.length;
    const before = await show(`refs/heads/main:${PLAN}`);
    await editInLinear(PLAN, `# Plan\n\nSteps one and two. See [the report](../../private/report.csv). ${CANARY}\n`);
    const blocked = await sync();
    assert.equal(blocked.result.exitCode, 0, blocked.result.stderr);
    assert.deepEqual(blocked.writes.filter((write) => write.includes('pulls')), [], 'the blocked text went to a pull request');
    // The tracked branch keeps its text; the document says why.
    assert.equal(await show(`refs/heads/main:${PLAN}`), before);
    const document = await documentOf(PLAN);
    assert.deepEqual(commentsOf(document).map((comment) => comment.body), [NOTICE]);

    // A git edit of the document does not take the link to Linear's upload storage either.
    await gitEdit(PLAN, planText('Steps one, two and three.'));
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(h.world.linear.uploads.length, uploads, 'a file was uploaded to Linear');
    assert.ok(!uploadedBytes().includes(SECRET), 'the file reached Linear');
    assert.doesNotMatch(await show(`refs/heads/main:${PLAN}`), /private/);
  });

  it('a link definition and an encoded spelling are blocked too', async () => {
    await gitEdit('private/report.csv', SECRET);
    await settle();
    const before = await show(`refs/heads/main:${PLAN}`);
    await editInLinear(PLAN, `# Plan\n\nSee [the report][r]. ${CANARY}\n\n[r]: ../../private/%72eport.csv\n`);
    await sync();
    await sync();
    assert.equal(await show(`refs/heads/main:${PLAN}`), before);
    assert.ok(!uploadedBytes().includes(SECRET));
  });

  it('a link to a Markdown document and a link the repository already wrote are captured as typed', async () => {
    await gitEdit(PLAN, planText('Steps one and two. See [the report](../../private/report.csv).'));
    await gitEdit('private/report.csv', SECRET);
    await settle();
    const text = `# Plan\n\nSteps one and two. See [the report](../../private/report.csv) and [the guide](../../combined/guide.md). ${CANARY}\n`;
    await editInLinear(PLAN, text);
    await settle();
    assert.match(await show(`refs/heads/main:${PLAN}`), /\[the guide\]\(\.\.\/\.\.\/combined\/guide\.md\)/);
    assert.deepEqual(commentsOf(await documentOf(PLAN)), []);
  });

  it('the same link written in git uploads the file, as for any link the repository writes', async () => {
    await gitEdit('private/report.csv', SECRET);
    await settle();
    const uploads = h.world.linear.uploads.length;
    await gitEdit(PLAN, planText('Steps one and two. See [the report](../../private/report.csv).'));
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(h.world.linear.uploads.length, uploads + 1);
    assert.ok(uploadedBytes().includes(SECRET));
    assert.doesNotMatch((await documentOf(PLAN)).content ?? '', /private\/report\.csv\)/);
    await settle();
  });
});
