import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { outputCount, outputFile, outputText, reportText } from './output.ts';

it('preserves Unicode Markdown and rejects binary controls and oversized output', () => {
  const text = '# Résumé 📝\n\n| Result | Count |\r\n| --- | --- |\n| Done | 2 |\n';
  assert.equal(outputText(text), text);
  for (const value of [null, {}, 'text\0tail', 'text\x1btail', 'text\x7ftail', 'text\x85tail']) assert.throws(() => outputText(value));
  assert.throws(() => outputText('12345', 4));
  assert.equal(outputText('', 0), '');
});

it('keeps reports usable when names contain control characters and preserves JSON data', () => {
  assert.equal(reportText('Name\x1b\x0b\x7f\x85\nNext'), 'Name\\u001b\\u000b\\u007f\\u0085\nNext');
  const record = { name: 'Plan\0\x85\nNext' };
  assert.deepEqual(JSON.parse(reportText(JSON.stringify(record))), record);
});

it('rejects invalid remote counts and output paths that escape their configured base', () => {
  for (const value of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => outputCount(value));
  assert.equal(outputCount(42), 42);
  const base = join(tmpdir(), 'output-test');
  assert.equal(outputFile(base, 'summary.md'), resolve(base, 'summary.md'));
  for (const value of ['..', '../outside.json', base]) assert.throws(() => outputFile(base, value));
});
