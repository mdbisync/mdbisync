import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeFetch } from '../setup/test-helpers.ts';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('image repairs through the sync pull request', () => {
  const h = pullRequestHarness();
  for (const status of [undefined, 404, 410]) it(`writes the link after merge and then settles (upload status ${status})`, async () => {
    const path = 'eng/notes/plan.md';
    const url = status === undefined ? 'https://example.com/chart.png' : 'https://uploads.linear.app/chart.png';
    const body = `# Plan\n\n![Chart](${url})\n`;
    const expected = `# Plan\n\n[Chart](${url})\n`;
    const network = fakeFetch(h.world);
    let downloads = 0;
    h.fetchOverride = async (input, init) => {
      if (String(input).startsWith('https://uploads.linear.app/')) { downloads++; return new Response(null, {status: status ?? 500}); }
      return network(input, init);
    };
    await h.editInLinear(path, body);
    const opened = await h.sync();
    assert.equal(opened.result.exitCode, 0, opened.result.stderr);
    assert.deepEqual(opened.report.capture?.blocked, []);
    assert.equal((await h.documentOf(path)).content, body);
    assert.ok((await h.show(`refs/mdbisync/linear:${path}`)).includes(`![Chart](${url})`));
    assert.ok((await h.show(`${SYNC_BRANCH}:${path}`)).includes(`[Chart](${url})`));
    assert.ok(!(await h.show(`${SYNC_BRANCH}:${path}`)).includes(`![Chart](${url})`));
    assert.match(h.world.github.pullRequests[0]!.body!, /image 1 of 1 \(line 3\)/);
    await h.sync();
    await h.settle();
    assert.equal((await h.documentOf(path)).content, expected);
    const beforeQuiet = downloads;
    const quiet = await h.sync();
    assert.equal(quiet.report.changed, false);
    assert.deepEqual(quiet.writes, []);
    assert.equal(downloads, beforeQuiet);
    assert.equal(downloads > 0, status !== undefined);
    // A later edit keeps the repaired URL as a link, without retrying the dead attachment.
    await h.editInLinear(path, expected + '\nAnother paragraph.\n');
    await h.sync();
    assert.equal(downloads, beforeQuiet);
    await h.settle();
  });
  it('repairs all non-upload forms while preserving a valid upload in the same document', async () => {
    const path = 'eng/notes/plan.md';
    const upload = 'https://uploads.linear.app/pixel.png';
    const content = `# Plan\n\n![Kept](${upload})\n\n![Relative](missing.png)\n\n![Absolute](/missing.png)\n\n![](https://example.com/empty-alt.png)\n\n[![Nested](https://example.com/nested.png)](https://example.com/guide)\n\n![]()\n\n![Data](data:image/png;base64,AAAA)\n\n[Remove](javascript:alert%281%29)\n`;
    const { readFile } = await import('node:fs/promises');
    const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));
    const network = fakeFetch(h.world);
    h.fetchOverride = async (input, init) => String(input) === upload ? new Response(png) : network(input, init);
    await h.editInLinear(path, content);
    const opened = await h.sync();
    assert.deepEqual(opened.report.capture?.blocked, []);
    const branch = await h.show(`${SYNC_BRANCH}:${path}`);
    assert.match(branch, /!\[Kept\]\([a-f0-9]+\.png\)/);
    assert.match(branch, /\[Relative\]\(missing.png\)/);
    assert.match(branch, /\[Absolute\]\(\/missing.png\)/);
    assert.match(branch, /\[Nested\]\(https:\/\/example.com\/guide\)/);
    assert.doesNotMatch(branch, /data:|javascript:|!\[\]\(\)/);
    assert.equal((h.world.github.pullRequests[0]!.body!.match(/image \d of 7 \(line/g) ?? []).length, 6);
    await h.settle();
    const held = (await h.documentOf(path)).content!;
    assert.match(held, /!\[Kept\]/);
    assert.doesNotMatch(held, /!\[Relative\]|!\[Absolute\]|data:|javascript:/);
  });

});
