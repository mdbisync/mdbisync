import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LINEAR_EMOJI } from './linear-emoji.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the vendored table is the emoji ids of the locked @emoji-mart/data set 14', () => {
  const vendored = JSON.parse(read('../vendor/emoji-mart-data/package.json')) as { name: string; version: string; license: string };
  const installed = JSON.parse(read('../../node_modules/@emoji-mart/data/package.json')) as { name: string; version: string; license: string };
  assert.deepEqual({ name: vendored.name, version: vendored.version, license: vendored.license }, { name: installed.name, version: installed.version, license: installed.license });
  assert.equal(read('../vendor/emoji-mart-data/LICENSE'), read('../../node_modules/@emoji-mart/data/LICENSE'));
  const set = JSON.parse(read('../../node_modules/@emoji-mart/data/sets/14/native.json')) as { emojis: Record<string, { skins: Array<{ native: string }> }> };
  const expected = Object.fromEntries(Object.entries(set.emojis).map(([id, emoji]) => [id, emoji.skins[0]!.native]));
  assert.equal(read('../vendor/emoji-mart-data/linear-emoji.json'), `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(LINEAR_EMOJI.size, 1849);
});
