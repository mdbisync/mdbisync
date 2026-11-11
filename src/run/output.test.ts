import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { outputCount, outputFile, outputText } from './output.ts';

it('preserves Unicode Markdown and rejects binary controls and oversized output', () => {
  const text = '# Résumé 📝\n\n| Result | Count |\r\n| --- | --- |\n| Done | 2 |\n';
  assert.equal(outputText(text), text);
  for (const value of [null, {}, 'text\0tail', 'text\x1btail', 'text\x7ftail', 'text\x85tail']) assert.throws(() => outputText(value));
  assert.throws(() => outputText('12345', 4));
  assert.equal(outputText('', 0), '');
});

it('rejects invalid remote counts and output paths that escape their configured base', () => {
  for (const value of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => outputCount(value));
  assert.equal(outputCount(42), 42);
  const base = join(tmpdir(), 'output-test');
  assert.equal(outputFile(base, 'summary.md'), resolve(base, 'summary.md'));
  for (const value of ['..', '../outside.json', base]) assert.throws(() => outputFile(base, value));
});
