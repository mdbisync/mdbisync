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
