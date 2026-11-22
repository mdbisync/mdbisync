import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('a content-limit document can keep thousands of paragraph conflicts separate', { timeout: 65_000 }, () => {
  const script = `
    import assert from 'node:assert/strict';
    import { CONTENT_LIMIT } from ${JSON.stringify(new URL('../format/rules.ts', import.meta.url).href)};
    import { mergeMarkdown } from ${JSON.stringify(new URL('./merge.ts', import.meta.url).href)};

    const recordSize = 125;
    const count = Math.floor(CONTENT_LIMIT / recordSize);
    function document(status) {
      const records = Array.from({ length: count }, (_, index) => {
        const id = String(index).padStart(4, '0');
        const record = [
          'Status ' + id + ' is ' + status + '.',
          'Section ' + id + '.',
          'The date is open.',
          'The owner will review the notes.',
          '',
        ].join('\\n\\n');
        return record + 'Summary recorded.'.padEnd(recordSize - record.length - 2, '.') + '\\n\\n';
      });
      const text = records.join('');
      assert.equal(text.length, CONTENT_LIMIT);
      return text;
    }

    const { conflicts } = await mergeMarkdown(document('draft'), document('ready'), document('final'));
    assert.equal(conflicts.length, count);
    for (const [index, conflict] of conflicts.entries()) {
      const id = String(index).padStart(4, '0');
      assert.equal(conflict.git, 'Status ' + id + ' is ready.');
      assert.equal(conflict.linear, 'Status ' + id + ' is final.');
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('a chain of fenced blocks whose fences share conflict hunks merges within a bounded time', { timeout: 65_000 }, () => {
  // Every block is four lines long, so merge-file keeps one hunk per fence pair:
  // hunk k holds the closing fence of block k and the opening fence of block k + 1.
  // Each block then overlaps two neighboring hunks, and widening must join the whole chain.
  const script = `
    import assert from 'node:assert/strict';
    import { CONTENT_LIMIT } from ${JSON.stringify(new URL('../format/rules.ts', import.meta.url).href)};
    import { mergeMarkdown } from ${JSON.stringify(new URL('./merge.ts', import.meta.url).href)};

    const count = 10_000;
    const document = (open, close) => Array.from({ length: count }, (_, index) =>
      [open, String(index), 'b', 'c', 'd', close, ''].join('\\n')).join('');
    const base = document('\`\`\`', '\`\`\`');
    const ours = document('\`\`\`x', '\`\`\`');
    const theirs = document('\`\`\`y', '\`\`\`\`');
    for (const text of [base, ours, theirs]) assert.ok(text.length <= CONTENT_LIMIT);

    const { conflicts } = await mergeMarkdown(base, ours, theirs);
    assert.equal(conflicts.length, 1);
    // Only the Linear side changes the last closing fence, so both versions keep its longer fence.
    assert.equal(conflicts[0].git, ours.trimEnd() + '\`');
    assert.equal(conflicts[0].linear, theirs.trimEnd());
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
