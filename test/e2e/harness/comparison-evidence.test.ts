import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { firstDifference } from './checks.ts';
import { imageRepairComparison, redactUploadUrls } from './comparison-evidence.ts';

it('keeps complete link syntax and long differing lines without retaining signed upload URLs', () => {
  const url = `https://uploads.linear.app/example/${'a'.repeat(240)}(plan).png?signature=private-value`;
  const plain = `[plan](${url} "Plan title") after ${'x'.repeat(200)}`;
  const angle = `[plan](<${url}> "Plan title") after ${'x'.repeat(200)}`;
  const redacted = redactUploadUrls(url);
  assert.match(redacted, /^https:\/\/uploads\.linear\.app\/redacted-[a-f0-9]{64}$/);
  assert.equal(redactUploadUrls(plain), `[plan](${redacted} "Plan title") after ${'x'.repeat(200)}`);
  assert.equal(redactUploadUrls(angle), `[plan](<${redacted}> "Plan title") after ${'x'.repeat(200)}`);
  assert.notEqual(redactUploadUrls(`${url}-other`), redacted, 'a changed URL remains distinguishable');
  const difference = firstDifference(`before\n${plain}`, `before\n${angle}`);
  assert.equal(difference, `line 2: file ${JSON.stringify(redactUploadUrls(plain))}, document ${JSON.stringify(redactUploadUrls(angle))}`);
  assert.doesNotMatch(difference, /private-value|example|…/);
  assert.equal(redactUploadUrls('![plan](../images/plan.png)'), '![plan](../images/plan.png)');
  for (const links of [`[a](${url})[b](${url}2)`, `[![plan](${url})](${url}2)`]) {
    const redactedLinks = redactUploadUrls(links);
    assert.doesNotMatch(redactedLinks, /signature|private-value|example/);
    assert.equal((redactedLinks.match(/redacted-/g) ?? []).length, 2);
  }
  assert.doesNotMatch(redactUploadUrls('https://user:password@example.com/file?token=other-secret'), /user:password|other-secret/);
  for (const destination of [
    '<https://uploads.linear.app/example/plan).png?signature=private-value>',
    "<https://uploads.linear.app/example/plan's.png?signature=private-value>",
    '<https://uploads.linear.app/example/plan image.png?signature=private-value>',
    'https://uploads.linear.app/example/plan\\).png?signature=private-value',
    "https://uploads.linear.app/example/plan's.png?signature=private-value",
  ]) {
    const redactedLink = redactUploadUrls(`[plan](${destination} "Title")`);
    assert.doesNotMatch(redactedLink, /signature|private-value|example|plan image/);
    assert.match(redactedLink, / "Title"\)$/);
    assert.equal(redactedLink.includes('(<'), destination.startsWith('<'));
  }
});

it('records every original comparison, including Markdown-equivalent spellings and missing content', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = 'https://uploads.linear.app/example/plan.png?signature=private-value';
  const expected = `[plan](${url})\n`;
  const actual = `[plan](<${url}>)`;
  assert.equal(imageRepairComparison(dir, 'stored-link', [{ expected, actual }]), true);
  const evidence = JSON.parse(readFileSync(join(dir, 'image-repair-stored-link.json'), 'utf8'));
  assert.deepEqual(evidence, [{ expected: redactUploadUrls(expected), actual: redactUploadUrls(actual), equal: false, sameMarkdown: true }]);
  assert.equal(imageRepairComparison(dir, 'observed-original', [
    { expected, actual: `!${expected}` }, { expected, actual: undefined },
  ]), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'image-repair-observed-original.json'), 'utf8')).map((pair: { sameMarkdown: boolean }) => pair.sameMarkdown), [false, false]);
  assert.doesNotMatch(readFileSync(join(dir, 'image-repair-observed-original.json'), 'utf8'), /private-value|example/);
  const warnings: string[] = [];
  assert.equal(imageRepairComparison(join(dir, 'missing'), 'stored-link', [{ expected, actual }], message => warnings.push(message)), true);
  assert.equal(imageRepairComparison(join(dir, 'missing'), 'stored-link', [{ expected, actual: null }], message => warnings.push(message)), false);
  assert.deepEqual(warnings, Array(2).fill('image-repair-stored-link.json not written: ENOENT'));
});
