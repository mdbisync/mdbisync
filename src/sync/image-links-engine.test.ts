import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeFetch } from '../setup/test-helpers.ts';
import { sameMarkdown, splitFile } from '../format/index.ts';
import { hookRun } from '../format/test-helpers.ts';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('image repairs through the sync pull request', () => {
  const h = pullRequestHarness();
  for (const status of [undefined, 404, 410]) it(`writes the link after merge and then settles (upload status ${status})`, async () => {
    const path = 'eng/notes/plan.md';
    const url = status === undefined ? 'https://example.com/chart.png' : 'https://uploads.linear.app/chart.png';
    const body = `# Plan\n\n![Chart](${url})\n`;
    const expected = `# Plan\n\n[Chart](<${url}>)`;
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
    assert.ok((await h.show(`${SYNC_BRANCH}:${path}`)).includes(`[Chart](<${url}>)`));
    assert.ok(!(await h.show(`${SYNC_BRANCH}:${path}`)).includes(`![Chart](${url})`));
    assert.match(h.world.github.pullRequests[0]!.body!, /image 1 of 1 \(line 3\)/);
    if (status === undefined) await h.fixture.remote.run(['update-ref', '-d', 'refs/mdbisync/ids']);
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
    assert.match(branch, /!\[Kept\]\(assets\/[a-f0-9]+\.png\)/);
    assert.match(branch, /\[Relative\]\(<missing.png>\)/);
    assert.match(branch, /\[Absolute\]\(<\/missing.png>\)/);
    assert.match(branch, /\[Nested\]\(<https:\/\/example.com\/guide>\)/);
    assert.doesNotMatch(branch, /data:|javascript:|!\[\]\(\)/);
    assert.equal((h.world.github.pullRequests[0]!.body!.match(/image \d of 7 \(line/g) ?? []).length, 6);
    await h.settle();
    const held = (await h.documentOf(path)).content!;
    assert.match(held, /!\[Kept\]/);
    assert.doesNotMatch(held, /!\[Relative\]|!\[Absolute\]|data:|javascript:/);
  });

  for (const reference of [false, true]) it(`keeps repaired repository paths as plain links without uploading their bytes (reference ${reference})`, async () => {
    const path = 'eng/notes/plan.md';
    await h.editRef('refs/heads/main', 'records.csv', 'name,value\nExample,42\n');
    const image = reference ? '![Report][file]\n\n[file]: ../../records.csv' : '![Report](../../records.csv)';
    const before = h.world.linear.uploads.length;
    await h.editInLinear(path, `# Plan\n\n${image}\n`);
    await h.sync();
    assert.equal(h.world.linear.uploads.length, before, 'a pending repair uploaded a file before merge');
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before);
    const document = await h.documentOf(path);
    assert.match(document.content!, /records\.csv/);
    assert.doesNotMatch(document.content!, /uploads\.linear\.app/);
    await h.editInLinear(path, document.content + '\nAnother paragraph.\n');
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before);
    await h.fixture.remote.run(['update-ref', '-d', 'refs/mdbisync/ids']);
    await h.sync();
    const renamed = 'eng/notes/archive/renamed.md';
    await h.gitEdit('eng/records.csv', 'name,value\nAnother,43\n');
    const original = await h.show(`refs/heads/main:${path}`);
    const base = await h.rev('refs/heads/main');
    const removed = await h.commitFile(base, path, null);
    await h.fixture.remote.run(['update-ref', 'refs/heads/main', removed, base]);
    await h.editRef('refs/heads/main', renamed, original);
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before, 'renaming the document lost its plain-link provenance');
    // Recovery must also retain the target resolved relative to the moved document.
    await h.fixture.remote.run(['update-ref', '-d', 'refs/mdbisync/ids']);
    await h.sync();
    const moved = await h.show(`refs/heads/main:${renamed}`);
    await h.gitEdit(renamed, moved + '\nA later repository edit.\n');
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before, 'rebuilding ids lost relocated plain-link provenance');
    await h.gitEdit(renamed, '# Plan\n\n![Repository image](../../../records.csv)\n');
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before + 1, 'a repository-authored image should still upload');
  });

  it('writes a list item linking a plain repository file in the form the linear-format hook leaves unchanged', async () => {
    const path = 'eng/notes/plan.md';
    const csv = 'name,value\nExample,42\n';
    await h.editRef('refs/heads/main', 'records.csv', csv);
    const before = h.world.linear.uploads.length;
    // Linear's form of a list item holding only a link it was sent unresolved: the link mark on the item's line,
    // which it also stores for a file block whose file was not uploaded (the recorded list-item probe).
    const linked = '# Plan\n\n* [Report](<../../records.csv>)';
    const sent: string[] = [];
    h.world.linear.store = (content) => {
      sent.push(content);
      return content.replace(/^\* \n {2}\[Report\]\(\.\.\/\.\.\/records\.csv\)$/m, '* [Report](<../../records.csv>)');
    };
    await h.editInLinear(path, '# Plan\n\n* ![Report](../../records.csv)\n');
    await h.sync();
    // The hook in CI finds the file in the repository, so it writes the item as a file block.
    const branch = await h.show(`${SYNC_BRANCH}:${path}`);
    assert.equal(splitFile(branch).body, '# Plan\n\n* \n  [Report](../../records.csv)');
    assert.deepEqual(hookRun(path, branch, {'records.csv': csv}), {exitCode: 0, stdout: '', stderr: ''});
    await h.settle();
    // The file stays a plain link: Linear holds the link it stores for one, and nothing is uploaded.
    assert.equal(h.world.linear.uploads.length, before);
    const document = await h.documentOf(path);
    assert.ok(sameMarkdown(document.content!, linked), document.content);
    // What the sync records for Linear's link is the file as git holds it: no later pull request changes the file.
    assert.equal(h.world.github.pullRequests.length, 1);
    assert.equal(await h.show(`refs/heads/main:${path}`), branch);
    assert.equal(await h.show(`refs/mdbisync/linear:${path}`), branch);
    // The text sent keeps the link as Linear stores it, so Linear holds what was sent.
    assert.ok(sent.length > 0 && sent.every((content) => content.includes('* [Report](../../records.csv)') && !content.includes('* \n')), JSON.stringify(sent));
    // A later edit in Linear, written as Linear stores the item, is captured in the hook's form too.
    await h.editInLinear(path, `${linked}\n\nAnother paragraph.\n`);
    await h.sync();
    const edited = await h.show(`${SYNC_BRANCH}:${path}`);
    assert.equal(splitFile(edited).body, '# Plan\n\n* \n  [Report](../../records.csv)\n\nAnother paragraph.');
    assert.deepEqual(hookRun(path, edited, {'records.csv': csv}), {exitCode: 0, stdout: '', stderr: ''});
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before);
    assert.ok(sameMarkdown((await h.documentOf(path)).content!, `${linked}\n\nAnother paragraph.`));
    assert.equal(h.world.github.pullRequests.length, 2);
    assert.equal(await h.show(`refs/heads/main:${path}`), edited);
    assert.equal(await h.show(`refs/mdbisync/linear:${path}`), edited);
    // An edit in git reaches Linear: Linear's link is not taken for an edit made there.
    await h.gitEdit(path, `${edited}\n\nA repository edit.`);
    await h.settle();
    assert.ok(sameMarkdown((await h.documentOf(path)).content!, `${linked}\n\nAnother paragraph.\n\nA repository edit.`), (await h.documentOf(path)).content);
    assert.equal(h.world.github.pullRequests.length, 2);
    assert.equal(h.world.linear.uploads.length, before);
  });

  // The fake keeps Linear text as written; the recorded format probe shows Linear itself splits the bang
  // into its own paragraph, so this covers a body that reaches the sync in any other way.
  for (const [form, image, repaired] of [
    ['inline', 'Look !![Report](../../records.csv) here.', 'Look \\![Report](<../../records.csv>) here.'],
    ['reference', 'Look !![Report][file] here.\n\n[file]: ../../records.csv', 'Look \\![Report](<../../records.csv>) here.'],
    ['joined by a removed link', 'Look [Report][x](javascript:void%280%29)(../../records.csv) here.', 'Look \\[Report](../../records.csv) here.'],
  ]) it(`never lets a repair upload a repository file Linear's text did not name (${form})`, async () => {
    const path = 'eng/notes/plan.md';
    await h.editRef('refs/heads/main', 'records.csv', 'name,value\nExample,42\n');
    const before = h.world.linear.uploads.length;
    await h.editInLinear(path, `# Plan\n\n${image}\n`);
    const opened = await h.sync();
    assert.deepEqual(opened.report.capture?.blocked, []);
    const branch = await h.show(`${SYNC_BRANCH}:${path}`);
    assert.ok(branch.includes(repaired!), branch);
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before, 'a repair uploaded a repository file');
    const document = await h.documentOf(path);
    assert.doesNotMatch(document.content!, /uploads\.linear\.app/);
    await h.editInLinear(path, document.content + '\nAnother paragraph.\n');
    await h.settle();
    assert.equal(h.world.linear.uploads.length, before);
  });

  it('repairs intake into a suspended batch and writes the link after release', async () => {
    const path = 'eng/notes/plan.md';
    await h.suspendOne(path);
    await h.editInLinear(path, '# Plan\n\n![Chart](https://example.com/chart.png)\n');
    await h.sync();
    assert.match(await h.show(`${h.SUSPENDED}:${path}`), /\[Chart\]\(<https:\/\/example.com\/chart.png>\)/);
    assert.doesNotMatch(await h.show(`${h.SUSPENDED}:${path}`), /!\[Chart\]/);
    assert.match(await h.show(`refs/mdbisync/linear:${path}`), /!\[Chart\]/);
    await h.editInLinear(path, '# Plan\n\n![Chart](https://example.com/chart.png)\n\nAnother paragraph.\n');
    await h.sync();
    assert.doesNotMatch(await h.show(`${h.SUSPENDED}:${path}`), /!\[Chart\]|Sync conflict/);
    await h.releaseHeld();
    await h.settle();
    assert.doesNotMatch((await h.documentOf(path)).content!, /!\[Chart\]/);
  });

});
