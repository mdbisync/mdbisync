import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { MarkdownLimitError } from '../format/markdown.ts';
import { CONFLICT_WIDENING_WORK_LIMIT, widenConflictRanges } from './conflict-ranges.ts';

test('widening keeps only overlapping components that contain a conflict', () => {
  assert.deepEqual(widenConflictRanges([
    { start: 9, end: 10, conflict: true },
    { start: 3, end: 6 },
    { start: 10, end: 12 },
    { start: 7, end: 9 },
    { start: 1, end: 4 },
    { start: 5, end: 6, conflict: true },
    { start: 2, end: 3, conflict: true },
  ]), [{ start: 1, end: 6 }, { start: 9, end: 10 }]);
});

test('widening handles thousands of independent and overlapping intervals within a bounded time', { timeout: 15_000 }, () => {
  const script = `
    import assert from 'node:assert/strict';
    import { CONTENT_LIMIT } from ${JSON.stringify(new URL('../format/rules.ts', import.meta.url).href)};
    import { widenConflictRanges } from ${JSON.stringify(new URL('./conflict-ranges.ts', import.meta.url).href)};
    const intervals = [];
    const expected = [];
    for (let start = 0; start < CONTENT_LIMIT; start += 8) {
      intervals.push({ start: start + 1, end: start + 2, conflict: true }, { start, end: start + 3 });
      expected.push({ start, end: start + 3 });
    }
    assert.deepEqual(widenConflictRanges(intervals.reverse()), expected);

    const center = 25_000;
    const nested = Array.from({ length: center }, (_, start) => ({ start, end: 2 * center - start }));
    assert.deepEqual(widenConflictRanges([
      { start: center, end: center + 1, conflict: true },
      ...nested.reverse(),
    ]), [{ start: 0, end: 2 * center }]);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('widening rejects work above its budget with a Markdown limit error', () => {
  assert.throws(() => widenConflictRanges(new Array(CONFLICT_WIDENING_WORK_LIMIT + 1)),
    (error) => error instanceof MarkdownLimitError && error.limit === 'widening');
});
