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

test('recorded Linear forms beside a fixture are not fixtures', () => {
  const errors = withCopy((d) => {
    writeFileSync(join(d, 'tables', 'table-basic.linear.md'), readFileSync(join(d, 'tables', 'table-basic.md')));
    writeFileSync(join(d, 'tables', 'table-basic.linear.yjs.json'), '{}');
  });
  assert.deepEqual(errors, []);
});

test('a recorded Linear form without its fixture is reported', () => {
  const errors = withCopy((d) => writeFileSync(join(d, 'tables', 'gone.linear.md'), '| A |'));
  assert.ok(errors.includes('tables/gone.linear.md: recorded Linear form without its fixture'), errors.join('\n'));
});

test('a recorded Linear form beside an unsynchronized fixture is reported', () => {
  const errors = withCopy((d) => writeFileSync(join(d, 'unsynced', 'notes-above-annotation.linear.md'), 'Notes'));
  assert.ok(errors.includes('unsynced/notes-above-annotation.linear.md: recorded Linear form without its fixture'), errors.join('\n'));
});

test('a probe manifest entry for a file that is not a synchronized fixture is reported', () => {
  const errors = withCopy((d) => writeFileSync(join(d, 'linear-probe.json'), JSON.stringify({ version: 1, fixtures: { 'tables/gone.md': { yjs: 'none' } } })));
  assert.ok(errors.includes('linear-probe.json: tables/gone.md is not a synchronized fixture'), errors.join('\n'));
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
  assert.ok(errors.includes('known construct never-seen: no fixture with basis known'), errors.join('\n'));
});

test('a known construct with the wrong class is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - construct: footnote\n    class: lint-error', '  - construct: footnote\n    class: fixable'),
  );
  assert.ok(errors.includes('lint-errors/footnote.md: class lint-error contradicts known class fixable of footnote'), errors.join('\n'));
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
  // images/broken-reference.md is marked missing_target and passes in the real bank.
  const fixed = withCopy((d) => {
    const p = join(d, 'images', 'broken-reference.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('does-not-exist.png', 'pixel.png'));
  });
  assert.ok(fixed.includes('images/broken-reference.md: marked missing_target but every target exists'), fixed.join('\n'));
});

test('an unused asset is reported', () => {
  const errors = withCopy((d) => {
    writeFileSync(join(d, 'assets', 'spare.txt'), 'spare');
    editIndex(d, 'assets:\n', 'assets:\n  - file: "assets/spare.txt"\n    kind: txt\n');
  });
  assert.ok(errors.includes('assets/spare.txt: asset not used by any fixture'), errors.join('\n'));
});

test('an unchanged fixture with a final line break is reported', () => {
  for (const end of ['\n', '\r']) {
    const errors = withCopy((d) => {
      const p = join(d, 'tables', 'table-basic.md');
      writeFileSync(p, readFileSync(p, 'utf8') + end);
    });
    assert.ok(errors.includes('tables/table-basic.md: unchanged fixture ends with a line break'), errors.join('\n'));
  }
});

test('a colliding name needs its marker and a partner', () => {
  const unmarked = withCopy((d) => {
    const p = join(d, 'index.yaml');
    const text = readFileSync(p, 'utf8');
    writeFileSync(p, text.replace(/(name_as: "lint-errors\/duplicate-title\/Guide\.md"\n) {4}macos_unsafe: true\n/, '$1'));
  });
  assert.ok(unmarked.includes('lint-errors/duplicate-title/guide-upper.md: name_as and macos_unsafe: true go together'), unmarked.join('\n'));
  const alone = withCopy((d) => editIndex(d, 'name_as: "lint-errors/duplicate-title/guide.md"', 'name_as: "lint-errors/duplicate-title/other.md"'));
  assert.ok(alone.includes('lint-errors/duplicate-title/guide-upper.md: name_as has no colliding partner'), alone.join('\n'));
  const elsewhere = withCopy((d) => editIndex(d, 'name_as: "lint-errors/duplicate-title/Guide.md"', 'name_as: "tables/Guide.md"'));
  assert.ok(elsewhere.includes('lint-errors/duplicate-title/guide-upper.md: name_as must be a .md name in the same folder'), elsewhere.join('\n'));
  const number = withCopy((d) => editIndex(d, 'name_as: "lint-errors/duplicate-title/Guide.md"', 'name_as: 7'));
  assert.ok(number.includes('lint-errors/duplicate-title/guide-upper.md: name_as must be a .md name in the same folder'), number.join('\n'));
  const twice = withCopy((d) => editIndex(d, 'name_as: "lint-errors/duplicate-title/guide.md"', 'name_as: "lint-errors/duplicate-title/Guide.md"'));
  assert.ok(twice.includes('lint-errors/duplicate-title/guide-lower.md: name_as also used by lint-errors/duplicate-title/guide-upper.md'), twice.join('\n'));
  const clash = withCopy((d) => editIndex(d, 'name_as: "lint-errors/duplicate-title/guide.md"', 'name_as: "lint-errors/duplicate-title/GUIDE-UPPER.md"'));
  assert.ok(clash.some((e) => e.startsWith('lint-errors/duplicate-title/guide-lower.md: name_as lint-errors/duplicate-title/GUIDE-UPPER.md collides with a committed file')), clash.join('\n'));
});

test('collision names fold case beyond plain lowercasing', () => {
  const errors = withCopy((d) => {
    editIndex(d, 'name_as: "lint-errors/duplicate-title/Guide.md"', 'name_as: "lint-errors/duplicate-title/\u039f\u0394\u039f\u03a3.md"');
    editIndex(d, 'name_as: "lint-errors/duplicate-title/guide.md"', 'name_as: "lint-errors/duplicate-title/\u03bf\u03b4\u03bf\u03c3.md"');
  });
  assert.deepEqual(errors, []);
});

test('only .md files count as Markdown', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'unsynced', 'markdown-extension', 'plan.markdown');
    writeFileSync(p, readFileSync(p, 'utf8') + ' [x](nowhere.md)');
    editIndex(d, '    synced: false\n    note: "ignored, so it does not collide with plan.md"', '    note: "ignored, so it does not collide with plan.md"');
  });
  assert.deepEqual(errors, []);
});

test('a fixture indexed twice is reported', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'index.yaml');
    const text = readFileSync(p, 'utf8');
    const entry = text.match(/  - file: "tables\/table-basic\.md"\n(?: {4}.*\n)+/)[0];
    writeFileSync(p, text + entry);
  });
  assert.ok(errors.includes('tables/table-basic.md: indexed twice'), errors.join('\n'));
});

test('a fixture entry without a file is reported, not a crash', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'index.yaml');
    writeFileSync(p, readFileSync(p, 'utf8') + '  - group: tables\n    construct: table\n');
  });
  assert.ok(errors.some((e) => /^index\.yaml: fixture \d+ has no file$/.test(e)), errors.join('\n'));
});

test('a duplicate top-level key is rejected', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'index.yaml');
    writeFileSync(p, readFileSync(p, 'utf8') + 'assets:\n');
  });
  assert.ok(errors.some((e) => e.endsWith('duplicate key assets')), errors.join('\n'));
});

test('a canary used twice or carried by another fixture is reported', () => {
  const canaryOf = (text, file) => text.match(new RegExp(`  - file: "${file}"\\n(?: {4}.*\\n)*? {4}canary: (kx-[0-9a-f]{8})`))[1];
  const errors = withCopy((d) => {
    const p = join(d, 'index.yaml');
    const text = readFileSync(p, 'utf8');
    const a = canaryOf(text, 'tables/table-basic.md');
    const b = canaryOf(text, 'tables/table-single-column.md');
    writeFileSync(p, text.replace(`canary: ${b}`, `canary: ${a}`));
  });
  assert.ok(errors.some((e) => e.startsWith('tables/table-single-column.md: canary also used by')), errors.join('\n'));
  const foreign = withCopy((d) => {
    const p = join(d, 'tables', 'table-basic.md');
    writeFileSync(p, readFileSync(p, 'utf8') + ' kx-0badf00d');
  });
  assert.ok(foreign.includes("tables/table-basic.md: carries another fixture's canary kx-0badf00d"), foreign.join('\n'));
});

test('a canary carried by the file name is accepted only there', () => {
  const errors = withCopy((d) => editIndex(d, '    canary_in: name\n', ''));
  assert.ok(errors.some((e) => /^size-spectrum\/empty-kx-[0-9a-f]{8}\.md: canary kx-[0-9a-f]{8} not found$/.test(e)), errors.join('\n'));
});

test('a rule on a fixture that is not a lint error is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - file: "tables/table-basic.md"\n', '  - file: "tables/table-basic.md"\n    rule: footnote\n'),
  );
  assert.ok(errors.includes('tables/table-basic.md: only lint-error fixtures have a rule'), errors.join('\n'));
});

test('corpus takes only false', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - file: "tables/table-basic.md"\n', '  - file: "tables/table-basic.md"\n    corpus: true\n'),
  );
  assert.ok(errors.includes('tables/table-basic.md: corpus is either false or left out'), errors.join('\n'));
});

test('a fixture outside its group folder is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - file: "tables/table-basic.md"\n    group: tables', '  - file: "tables/table-basic.md"\n    group: links'),
  );
  assert.ok(errors.includes('tables/table-basic.md: not in the folder of group links'), errors.join('\n'));
});

test('a fixture contradicting a known class is reported', () => {
  const errors = withCopy((d) =>
    editIndex(d, '  - file: "lint-errors/footnote-inline.md"\n    group: lint-errors\n    construct: footnote\n    class: lint-error\n    rule: footnote\n',
      '  - file: "lint-errors/footnote-inline.md"\n    group: lint-errors\n    construct: footnote\n    class: unchanged\n'),
  );
  assert.ok(errors.includes('lint-errors/footnote-inline.md: class unchanged contradicts known class lint-error of footnote'), errors.join('\n'));
});

test('basis known for an unlisted construct is reported', () => {
  const flagged = withCopy((d) => editIndex(d, '    rule: duplicate-title\n    basis: assumed\n    canary: kx-da467a89', '    rule: duplicate-title\n    basis: known\n    canary: kx-da467a89'));
  assert.ok(flagged.includes('lint-errors/duplicate-title/guide-upper.md: basis known, but duplicate-title is not in known_constructs'), flagged.join('\n'));
});

test('a class that disagrees with the recorded Linear form is reported', () => {
  const unchanged = withCopy((d) => writeFileSync(join(d, 'tables', 'table-basic.linear.md'), '| A |'));
  assert.ok(unchanged.includes("tables/table-basic.md: class unchanged, but Linear's recorded form differs"), unchanged.join('\n'));
  const fixable = withCopy((d) =>
    writeFileSync(join(d, 'tables', 'table-separator-long.linear.md'), readFileSync(join(d, 'tables', 'table-separator-long.md'))),
  );
  assert.ok(fixable.includes("tables/table-separator-long.md: class fixable, but Linear's recorded form equals the source"), fixable.join('\n'));
});

test('a probed fixture must have basis known and its recorded form', () => {
  const errors = withCopy((d) => {
    editIndex(d, '    construct: table\n    class: unchanged\n    basis: known', '    construct: table\n    class: unchanged\n    basis: assumed');
    rmSync(join(d, 'tables', 'table-separator-long.linear.md'));
  });
  assert.ok(errors.includes('tables/table-basic.md: probed by Linear, so its basis must be known'), errors.join('\n'));
  assert.ok(errors.includes('tables/table-separator-long.md: probed, but its recorded Linear form is missing'), errors.join('\n'));
});

test('a refused fixture must be a lint error, and a lint error needs its recorded form', () => {
  const errors = withCopy((d) => {
    const p = join(d, 'linear-probe.json');
    const manifest = JSON.parse(readFileSync(p, 'utf8'));
    manifest.fixtures['tables/table-basic.md'] = { yjs: 'none', refused: 'INVALID_INPUT' };
    writeFileSync(p, JSON.stringify(manifest));
    rmSync(join(d, 'tables', 'table-alignment.linear.md'));
  });
  assert.ok(errors.includes('tables/table-basic.md: Linear refused it, so its class must be lint-error'), errors.join('\n'));
  assert.ok(errors.includes('tables/table-alignment.md: probed, but its recorded Linear form is missing'), errors.join('\n'));
});

test('the check runs when started through a symlink', async () => {
  const { spawnSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'fixture-link-'));
  try {
    const link = join(dir, 'check.mjs');
    symlinkSync(join(bank, 'check-index.mjs'), link);
    const run = spawnSync(process.execPath, [link, bank], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^fixture bank ok: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    "[h](h.md 'single') [i](i.md (paren)) [j](notes_(v2).md) [k](100%.md)",
    '`[l](in-span.md)`',
    '```',
    '<img src="in-fence.png">',
    '```',
  ].join('\n');
  assert.deepEqual(relativeTargets(text).sort(), [
    '100%.md', 'dir/with space.png', 'f.svg', 'g.md', 'h.md', 'i.md', 'notes_(v2).md', 'x.md',
  ]);
});
