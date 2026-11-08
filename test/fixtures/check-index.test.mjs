// Tests for the fixture bank check: the real bank passes, and each kind of
// mismatch between the bank and its index is caught.
// Run with `node --test 'test/fixtures/*.test.mjs'`.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBank, parseIndex, relativeTargets } from './check-index.mjs';

const bank = dirname(fileURLToPath(import.meta.url));

function withCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-bank-'));
  try {
    cpSync(bank, dir, { recursive: true });
    mutate(dir);
    return checkBank(dir).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function editIndex(dir, from, to) {
  const p = join(dir, 'index.yaml');
  const text = readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `index.yaml has no ${from}`);
  writeFileSync(p, text.replace(from, to));
}

test('the bank matches its index', () => {
  const { errors, stats } = checkBank(bank);
  assert.deepEqual(errors, []);
  assert.ok(stats.fixtures >= 200);
});

test('an unindexed file is reported', () => {
  const errors = withCopy((d) => writeFileSync(join(d, 'tables', 'extra.md'), 'Ref kx-00000001'));
  assert.ok(errors.includes('tables/extra.md: not in index.yaml'), errors.join('\n'));
});

test('an indexed file that is missing is reported', () => {
  const errors = withCopy((d) => rmSync(join(d, 'tables', 'table-basic.md')));
  assert.ok(errors.includes('tables/table-basic.md: indexed but missing'), errors.join('\n'));
});

test('a fixture without its canary is reported', () => {
  const errors = withCopy((d) => writeFileSync(join(d, 'tables', 'table-basic.md'), '| A |\n| -- |\n| 1 |'));
  assert.ok(errors.some((e) => /^tables\/table-basic\.md: canary kx-[0-9a-f]{8} not found$/.test(e)), errors.join('\n'));
});

test('a group without fixtures is reported', () => {
  const errors = withCopy((d) => editIndex(d, 'groups:\n', 'groups:\n  - id: spare-group\n    title: "Spare"\n'));
  assert.ok(errors.includes('group spare-group: no fixtures'), errors.join('\n'));
});

test('a known construct without a fixture is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, 'known_constructs:\n', 'known_constructs:\n  - construct: never-seen\n    class: fixable\n'),
  );
  assert.ok(errors.includes('known construct never-seen: no fixture'), errors.join('\n'));
});

test('a known construct with the wrong class is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - construct: footnote\n    class: lint-error', '  - construct: footnote\n    class: fixable'),
  );
  assert.ok(errors.some((e) => e.startsWith('known construct footnote: no fixture with class fixable')), errors.join('\n'));
});

test('a lint-error fixture without a rule is reported', () => {
  const errors = withCopy((d) => editIndex(d, '    rule: subscript\n', ''));
  assert.ok(errors.includes('lint-errors/subscript.md: lint-error needs a known rule'), errors.join('\n'));
});

test('Cyrillic text is reported', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'typography-scripts', 'greek.md');
    writeFileSync(p, readFileSync(p, 'utf8') + ' \u0434\u0430');
  });
  assert.ok(errors.includes('typography-scripts/greek.md: contains Cyrillic'), errors.join('\n'));
});

test('a broken relative link is reported unless the fixture expects it', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'links', 'relative.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('paragraph-single.md', 'nowhere.md'));
  });
  assert.ok(errors.includes('links/relative.md: 1 relative target(s) do not exist'), errors.join('\n'));
});

test('an unused asset is reported', () => {
  const errors = withCopy((d) => {
    writeFileSync(join(d, 'assets', 'spare.txt'), 'spare');
    editIndex(d, 'assets:\n', 'assets:\n  - file: "assets/spare.txt"\n    kind: txt\n');
  });
  assert.ok(errors.includes('assets/spare.txt: asset not used by any fixture'), errors.join('\n'));
});

test('an unchanged fixture with a final newline is reported', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'tables', 'table-basic.md');
    writeFileSync(p, readFileSync(p, 'utf8') + '\n');
  });
  assert.ok(errors.includes('tables/table-basic.md: unchanged fixture ends with a newline'), errors.join('\n'));
});

test('the index parser rejects YAML outside its subset', () => {
  assert.throws(() => parseIndex('fixtures:\n  - file: a.md\n      deep: x\n'), /unsupported line/);
  assert.throws(() => parseIndex('title: a: b\n'), /needs quotes/);
  assert.deepEqual(parseIndex('version: 1\nitems:\n  - id: a\n    ok: true\n'), {
    version: 1,
    items: [{ id: 'a', ok: true }],
  });
});

test('relative targets skip external links, anchors and footnotes', () => {
  const text = [
    '[a](x.md#part) [b](https://example.com) [c](#here) [d](mailto:a@example.com)',
    '![e](<dir/with space.png> "title") <img src="f.svg">',
    '[g]: g.md',
    '[^1]: a footnote',
  ].join('\n');
  assert.deepEqual(relativeTargets(text).sort(), ['dir/with space.png', 'f.svg', 'g.md', 'x.md']);
});
