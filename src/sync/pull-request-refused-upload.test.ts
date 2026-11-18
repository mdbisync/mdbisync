// An upload Linear refuses to the sync (401 or 403) while the sync's own access works.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LinearHttpError } from '../linear/index.ts';
import { MARKS } from './marks.ts';
import { pullRequestHarness, CANARY } from './pull-request-test-helpers.ts';

const REFUSED = 'https://uploads.linear.app/other-workspace/picture.png';
const ALSO_REFUSED = 'https://uploads.linear.app/other-workspace/diagram.png';

describe('sync: an upload the workspace cannot read', () => {
  const h = pullRequestHarness();

  for (const status of [401, 403]) it(`blocks only the document with a ${status} upload and merges the other documents`, async () => {
    h.world.linear.uploads.push({filename:'picture.png', contentType:'image/png', size:0, assetUrl:REFUSED, status}, {filename:'diagram.png', contentType:'image/png', size:0, assetUrl:ALSO_REFUSED, status});
    const probes: string[] = [];
    h.world.linear.beforeQuery = (operation) => { if (operation === 'UploadAccess') probes.push(operation); };
    await h.editInLinear('eng/notes/plan.md', `# Plan\n\n![Picture](${REFUSED})\n\nSteps. ${CANARY}\n`);
    await h.editInLinear('combined/guide.md', `# Guide\n\n![Picture](${ALSO_REFUSED})\n\nStart here. ${CANARY}\n`);
    await h.editInLinear('eng/backend/notes.md', `# Notes\n\nUpdated in Linear. ${CANARY}\n`);
    const opened = await h.sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.report.capture?.blocked.map((entry) => entry.path).sort(), ['combined/guide.md', 'eng/notes/plan.md']);
    assert.deepEqual(probes, ['UploadAccess'], 'one probe answers for every refused upload of the run, whatever its URL');
    for (const path of ['eng/notes/plan.md', 'combined/guide.md']) {
      const document = await h.documentOf(path);
      assert.equal(document.icon, MARKS.blocked.icon);
      const [comment] = h.commentsOf(document);
      assert.match(comment!.body, /Image 1 of 1 \(line 3\): the uploaded file cannot be read\. Remove it or upload it again\./);
      assert.doesNotMatch(comment!.body, /other-workspace/);
    }
    const merged = await h.sync();
    assert.equal(merged.result.exitCode, 0, merged.result.stderr);
    assert.match(await h.show('refs/heads/main:eng/backend/notes.md'), /Updated in Linear\./);
    assert.match(await h.show('refs/heads/main:eng/notes/plan.md'), /Steps one and two\./);
  });

  it('stops the run when the access probe fails too', async () => {
    h.world.linear.uploads.push({filename:'picture.png', contentType:'image/png', size:0, assetUrl:REFUSED, status:403});
    h.world.linear.uploadAccessStatus = 401;
    await h.editInLinear('eng/notes/plan.md', `# Plan\n\n![Picture](${REFUSED})\n\nSteps. ${CANARY}\n`);
    await h.editInLinear('eng/backend/notes.md', `# Notes\n\nUpdated in Linear. ${CANARY}\n`);
    const main = await h.rev('refs/heads/main');
    await assert.rejects(h.sync(), (error) => error instanceof LinearHttpError && error.operation === 'DownloadUpload' && error.httpStatus === 403);
    assert.equal(await h.rev('refs/heads/main'), main);
    assert.equal(h.openPullRequests().length, 0);
    assert.notEqual((await h.documentOf('eng/notes/plan.md')).icon, MARKS.blocked.icon);
    assert.equal(h.world.linear.comments.size, 0);
  });
});
