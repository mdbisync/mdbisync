// Merge refusals, API outages, and pending initial-sync records across retries.

import assert from 'node:assert/strict';
import { INCOMPLETE_EXIT_CODE, NO_STATE_EXIT_CODE, SETUP_FAILED_EXIT_CODE } from '../commands.ts';
import { INITIAL_SYNC_FROM_LINEAR_RECORD } from '../state/index.ts';
import { describe, it } from 'node:test';
import { pullRequestHarness, CANARY, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('sync: pull request failures', () => {
  const h = pullRequestHarness();
  const {
    sync, mergeOnRemote, rev, show, documentOf, editInLinear, openPullRequests, action, RULE_TEXT, ruleBlocks, commitFile,
  } = h;

  it('a merge GitHub refuses because the head moved is tried again by a later run', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nSteps, refined. ${CANARY}\n`);
    await sync();
    let refuse = true;
    h.world.github.merge = async (pr, sha) => (refuse ? ((refuse = false), { status: 409 }) : mergeOnRemote(pr, sha));
    const refused = await sync();
    assert.equal(refused.result.exitCode, 0, refused.result.stderr);
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    assert.match(refused.summary, /GitHub did not merge the sync pull request \[#1\]\(.*\) \(HTTP 409: `Pull Request is not mergeable`\)/);
    assert.deepEqual(refused.writes, ['PATCH /pulls/1'], 'the refusal is noted on the pull request');
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(again.writes, ['PUT /pulls/1/merge']);
  });

  it('a merge rule the App cannot satisfy fails the second run that meets it, with GitHub\'s reason; the merge follows once the rule is fixed', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNeeds a review. ${CANARY}\n`);
    await sync();
    ruleBlocks();

    const first = await sync();
    assert.equal(first.result.exitCode, 0, first.result.stderr);
    assert.equal(first.report.pullRequest?.code, 'merge-refused');
    assert.equal(first.report.pullRequest?.reason, RULE_TEXT);
    assert.ok(first.summary.includes(`(HTTP 405: \`${RULE_TEXT}\`); a later run tries again`), first.summary);
    assert.ok(h.world.github.pullRequests[0]?.body.includes(`(HTTP 405: \`${RULE_TEXT}\`)`), 'the pull request names the refusal');
    // The note in the description is a write; the refused merge is not.
    assert.deepEqual(first.report.writes.pullRequests, { updated: 1 });

    const second = await sync();
    assert.equal(second.result.exitCode, SETUP_FAILED_EXIT_CODE, second.result.stderr);
    assert.ok(second.result.stderr.includes(`setup error (merge-blocked): GitHub refuses again to merge the sync pull request (HTTP 405: \`${RULE_TEXT}\`)`), second.result.stderr);
    assert.equal(second.report.pullRequest?.code, 'merge-blocked');
    assert.equal(second.report.exitStatus, 'failure');
    assert.ok(second.summary.includes(`Setup error: GitHub refused again to merge the sync pull request [#1]`), second.summary);
    assert.ok(second.summary.includes(RULE_TEXT), second.summary);
    assert.deepEqual(second.writes, [], 'a run that meets the same refusal changes nothing');
    assert.deepEqual(second.report.writes, { linear: {}, git: {}, pullRequests: {} });

    const fromAction = await action();
    assert.equal(fromAction.exitCode, 1);
    assert.ok(fromAction.output.includes(`::error::sync: setup error (merge-blocked): GitHub refuses again to merge the sync pull request (HTTP 405: \`${RULE_TEXT}\`)`), fromAction.output);
    assert.match(fromAction.output, /::set-output name=code::merge-blocked/);

    h.world.github.merge = mergeOnRemote;
    const fixed = await sync();
    assert.equal(fixed.result.exitCode, 0, fixed.result.stderr);
    assert.deepEqual(fixed.writes, ['PUT /pulls/1/merge']);
    assert.deepEqual(fixed.report.writes.pullRequests, { merged: 1 });
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Needs a review\./);
  });

  it('a refusal after the tracked branch or the head moved is a normal retry, not a setup error', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nWaits for a rule. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');

    // A person pushes to the tracked branch: the same refusal on the same head is new for that base.
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nMoved on. ${CANARY}\n` });
    const base = await rev('refs/heads/main');
    const commit = await commitFile(base, 'combined/guide.md', blob);
    await h.fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    h.start = commit;
    const afterTracked = await sync();
    assert.equal(afterTracked.result.exitCode, 0, afterTracked.result.stderr);
    assert.equal(afterTracked.report.pullRequest?.code, 'merge-refused');

    // A new Linear edit moves the head; the run after it reads the new head's checks and is refused once more.
    await editInLinear('combined/page-1.md', `# Page 1\n\nRevised. ${CANARY}\n`);
    const moved = await sync();
    assert.equal(moved.report.pullRequest?.branchMoved, true);
    const afterHead = await sync();
    assert.equal(afterHead.result.exitCode, 0, afterHead.result.stderr);
    assert.equal(afterHead.report.pullRequest?.code, 'merge-refused');

    const repeated = await sync();
    assert.equal(repeated.result.exitCode, SETUP_FAILED_EXIT_CODE, repeated.result.stderr);
    assert.equal(repeated.report.pullRequest?.code, 'merge-blocked');
  });

  it('a head GitHub refuses as conflicting gets the tracked branch merged in on the next run, never a setup error', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nConflicts on GitHub. ${CANARY}\n`);
    await sync();
    // A person pushes to the tracked branch, so the head no longer holds its tip; GitHub sees a conflict git does not.
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nMoved on. ${CANARY}\n` });
    const base = await rev('refs/heads/main');
    const commit = await commitFile(base, 'combined/guide.md', blob);
    await h.fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    h.start = commit;
    h.world.github.merge = async () => ({ status: 405, message: 'Pull Request has merge conflicts' });
    const refused = await sync();
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    const head = await rev(SYNC_BRANCH);

    h.world.github.merge = mergeOnRemote;
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.equal(next.report.pullRequest?.code, undefined);
    assert.equal(next.report.pullRequest?.branchMoved, true);
    const moved = await rev(SYNC_BRANCH);
    assert.deepEqual((await h.fixture.remote.text(['rev-list', '--parents', '-n', '1', moved])).trim().split(' ').slice(1), [head, commit], 'the tracked branch was merged into the refused head');
    // The new head's checks are read by the run after it, which merges.
    const merged = await sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Conflicts on GitHub\./);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Moved on\./);
  });

  it('a refusal noted in a description saved with CRLF line endings is still read back', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nEdited on the web. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    const pr = h.world.github.pullRequests[0];
    assert.ok(pr !== undefined);
    pr.body = pr.body.replaceAll('\n', '\r\n');
    const repeated = await sync();
    assert.equal(repeated.result.exitCode, SETUP_FAILED_EXIT_CODE, repeated.result.stderr);
    assert.equal(repeated.report.pullRequest?.code, 'merge-blocked');
  });

  it('a refusal whose note cannot be written is still reported with its reason', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNote lost. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    h.world.github.reset = (request) => (request === 'PATCH /pulls/1' ? 'before' : undefined);
    const refused = await sync();
    assert.equal(refused.result.exitCode, 0, refused.result.stderr);
    assert.equal(refused.report.pullRequest?.code, 'merge-refused');
    assert.equal(refused.report.pullRequest?.reason, RULE_TEXT);
    // The note's request never reached GitHub: no pull request write is counted.
    assert.deepEqual(refused.report.writes.pullRequests, {});
    delete h.world.github.reset;
    // Nothing was noted, so the next refusal is noted rather than reported as repeated.
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    assert.equal((await sync()).report.pullRequest?.code, 'merge-blocked');
  });

  it('a different reason on the same head is a normal retry', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nTwo reasons. ${CANARY}\n`);
    await sync();
    ruleBlocks();
    assert.equal((await sync()).report.pullRequest?.code, 'merge-refused');
    h.world.github.merge = async () => ({ status: 405, message: 'Base branch was modified. Review and try the merge again.' });
    const other = await sync();
    assert.equal(other.result.exitCode, 0, other.result.stderr);
    assert.equal(other.report.pullRequest?.code, 'merge-refused');
    assert.deepEqual(other.writes, ['PATCH /pulls/1']);
  });

  it('a reset connection while opening the sync pull request: the write step runs, the run reports, and the next run opens it', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nAfter the outage. ${CANARY}\n`);
    // A person's git edit, which this run's write step takes to Linear.
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nWritten anyway. ${CANARY}\n` });
    const base = await rev('refs/heads/main');
    const commit = await commitFile(base, 'combined/guide.md', blob);
    await h.fixture.remote.run(['update-ref', 'refs/heads/main', commit, base]);
    h.start = commit;
    h.world.github.reset = (request, body) => (request === 'POST /pulls' && body.head !== undefined ? 'before' : undefined);

    const broken = await sync();
    assert.equal(broken.result.exitCode, INCOMPLETE_EXIT_CODE, broken.result.stderr);
    assert.match(broken.result.stderr, /not finished \(github-failed\)/);
    assert.equal(broken.report.pullRequest?.code, 'github-failed');
    assert.equal(broken.report.pullRequest?.status, undefined);
    assert.match(broken.summary, /A request to GitHub for the sync pull request got no answer/);
    assert.equal((await documentOf('combined/guide.md')).content, `# Guide\n\nWritten anyway. ${CANARY}\n`, 'the write step did not run');
    assert.deepEqual(h.world.github.pullRequests, []);

    delete h.world.github.reset;
    const opened = await sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.writes, ['POST /pulls']);
    const merged = await sync();
    assert.deepEqual(merged.writes, ['PUT /pulls/1/merge']);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /After the outage\./);
    assert.match(await show('refs/heads/main:combined/guide.md'), /Written anyway\./);
  });

  it('an answer lost after GitHub opened or merged the sync pull request: the next run converges without a second one', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nLost answers. ${CANARY}\n`);
    h.world.github.reset = (request, body) => (request === 'POST /pulls' && body.head !== undefined ? 'after' : undefined);
    const open = await sync();
    assert.equal(open.result.exitCode, INCOMPLETE_EXIT_CODE, open.result.stderr);
    assert.equal(open.report.pullRequest?.code, 'github-failed');
    assert.equal(openPullRequests().length, 1, 'GitHub opened it before the connection broke');

    h.world.github.reset = (request) => (request === 'PUT /pulls/1/merge' ? 'after' : undefined);
    const merge = await sync();
    assert.equal(merge.result.exitCode, INCOMPLETE_EXIT_CODE, merge.result.stderr);
    assert.equal(merge.report.pullRequest?.code, 'github-failed');
    assert.equal(h.world.github.pullRequests[0]?.merged, true, 'GitHub merged it before the connection broke');

    delete h.world.github.reset;
    const after = await sync();
    assert.equal(after.result.exitCode, 0, after.result.stderr);
    assert.deepEqual(after.writes, []);
    assert.equal(h.world.github.pullRequests.length, 1);
    assert.equal(after.report.pullRequest?.needed, false);
    assert.match(await show('refs/heads/main:eng/notes/plan.md'), /Lost answers\./);
  });

  it('a reset connection on every request of the pull request step ends each run defined', async () => {
    await editInLinear('eng/notes/plan.md', `# Plan\n\nEvery request. ${CANARY}\n`);
    await sync();
    // The step's own requests; the setup check reads check runs one at a time.
    const steps = ['GET /pulls', 'PATCH /pulls/1', 'GET /commits/', 'PUT /pulls/1/merge'];
    const ofStep = (request: string, step: string) => request.startsWith(step) && !request.endsWith('per_page=1');
    for (const step of steps) {
      // An edit in Linear changes the description, so the run sends its PATCH.
      if (step === 'PATCH /pulls/1') await editInLinear('combined/page-2.md', `# Page 2\n\nChanged for the description. ${CANARY}\n`);
      h.world.github.reset = (request) => (ofStep(request, step) ? 'before' : undefined);
      const broken = await sync();
      assert.equal(broken.result.exitCode, INCOMPLETE_EXIT_CODE, `${step}: ${broken.result.stderr}`);
      assert.equal(broken.report.pullRequest?.code, 'github-failed', step);
      assert.equal(broken.report.exitStatus, 'failure', step);
    }
    delete h.world.github.reset;
    let run = await sync();
    if (run.report.pullRequest?.branchMoved === true) run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(h.world.github.pullRequests[0]?.merged, true);
    assert.match(await show('refs/heads/main:combined/page-2.md'), /Changed for the description\./);
  });

  for (const reviewed of [false, true]) it(`never reuses a sync branch that holds an unmerged initial sync from Linear (reviewed: ${reviewed})`, async () => {
    // The sync branch holds such a record, which changes the tracked branch and
    // which a person has not merged, while `linear` has moved on.
    const main = await rev('refs/heads/main');
    const blob = await h.fixture.remote.text(['hash-object', '-w', '--stdin'], { input: `# Guide\n\nAs Linear holds it. ${CANARY}\n` });
    const changed = await commitFile(main, 'combined/guide.md', blob);
    const record = await h.fixture.remote.text(['commit-tree', `${changed}^{tree}`, '-p', main, '-m', INITIAL_SYNC_FROM_LINEAR_RECORD], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    });
    const head = reviewed ? await commitFile(record, 'combined/guide.md', blob) : record;
    await h.fixture.remote.run(['update-ref', SYNC_BRANCH, head]);
    h.world.github.pullRequests.push({ number: 1, title: 'Initial sync from Linear', body: '', head: 'mdbisync/linear', base: 'main', state: 'open', merged: false });
    await editInLinear('eng/notes/plan.md', `# Plan\n\nNot yet. ${CANARY}\n`);
    const linearWrites = h.world.linear.writes.count;

    const run = await sync();
    assert.equal(run.result.exitCode, NO_STATE_EXIT_CODE, run.result.stderr);
    assert.equal(run.report.pullRequest?.code, 'initial-pull-request-pending');
    assert.equal(await rev(SYNC_BRANCH), head);
    assert.deepEqual(run.writes, []);
    assert.equal(h.world.linear.writes.count, linearWrites);
    assert.match(run.summary, /a person has not merged yet/);
  });
});
