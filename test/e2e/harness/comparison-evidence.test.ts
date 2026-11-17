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
});
