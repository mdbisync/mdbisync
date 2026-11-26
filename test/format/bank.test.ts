// The normalizer against the fixture bank and Linear's recorded forms
// (L0-01 to L0-03 offline): `fix` reaches Linear's form and is idempotent,
// `lint` reports every lint-error fixture with its rule and line. Both check
// linked files against the bank, as the commands check them in a repository.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { duplicateTitles, fixLinearText, fixText, linkedFileResolver, lintText, sameAsLinear, sameMarkdown, splitFile } from '../../src/format/index.ts';
import { FIXED_RULES, type LintRule } from '../../src/format/rules.ts';
import { goldenMarkdownPath, loadBank, readOptional, sentForm, type BankFixture } from '../probe/bank.ts';

const bank = loadBank();
const markdown = bank.fixtures.filter((fixture) => fixture.synced !== false && fixture.file.endsWith('.md'));
const read = (fixture: BankFixture): string => readFileSync(join(bank.dir, fixture.file), 'utf8');
const golden = (fixture: BankFixture): string | undefined => readOptional(join(bank.dir, goldenMarkdownPath(fixture.file)));
/** Lint-error fixtures `fix` rewrites into Linear's form (FIXED_RULES); the others of those rules stay as they are. */
const FIXED_BY_FIX: ReadonlySet<string> = new Set(['construct-singles/break-backslash.md', 'construct-singles/break-backslash-indented.md', 'lint-errors/plus-line-in-item.md', 'lint-errors/tab-indentation.md']);
/**
 * Lint-error fixtures of a rule fix writes whose recorded form shows what
 * Linear loses: fix's form is another fixture, recorded as a fixed point.
 */
const ESCAPED_BY_FIX: ReadonlyMap<string, string> = new Map([
  ['tables/table-quote-cell.md', 'tables/table-quote-cell-escaped.md'],
  ['construct-singles/item-section-run.md', 'construct-singles/item-section-run-escaped.md'],
  ['construct-singles/item-section-run-outside.md', 'construct-singles/item-section-run-outside-escaped.md'],
]);
const contentRules =(fixture: BankFixture): boolean => fixture.class === 'lint-error' && fixture.rule !== 'duplicate-title';

describe('fix on the fixture bank', () => {
  for (const fixture of markdown) {
    it(`${fixture.file} (${fixture.class})`, () => {
      const source = read(fixture);
      // Like the fix command: a link to a file that is not there is not uploaded.
      const options = { linkedFileExists: linkedFileResolver(fixture.file, bank.dir) };
      const fixed = fixText(source, options);
      assert.equal(fixText(fixed, options), fixed, 'L0-01: a second fix changes nothing');
      if (fixture.class === 'fixable') {
        const form = golden(fixture);
        assert.ok(form !== undefined, 'a fixable fixture has its recorded Linear form');
        const { head } = splitFile(source);
        if (fixture.git_form === 'captured') {
          // The sync treats Linear's spelling as equivalent to fix's form
          // and captures the same bytes fix writes.
          assert.notEqual(fixed, head + form, 'git_form captured: fix does not reach the recorded form');
          assert.ok(sameAsLinear(form, splitFile(fixed).body), "L0-02: Linear's recorded form is no change from fix's");
          const uploaded = form.replaceAll('../assets/', 'https://uploads.example/');
          assert.equal(fixLinearText(head + form, uploaded, options.linkedFileExists), fixed, "L0-02: capture writes Linear's form as fix's");
        } else {
          assert.equal(fixed, head + form, "L0-02: fix reaches Linear's recorded form");
        }
        assert.deepEqual(lintText(fixture.file, fixed, options).filter((finding) => FIXED_RULES.has(finding.rule)), [], 'lint reports no rule fix writes after fix');
      } else if (FIXED_BY_FIX.has(fixture.file)) {
        // A rule fix writes in Linear's form: the finding goes and fix reaches the recorded form.
        assert.ok(fixture.class === 'lint-error' && FIXED_RULES.has(fixture.rule as LintRule), 'a fixture of a rule fix writes');
        assert.notEqual(fixed, source, 'fix rewrites it');
        const after = lintText(fixture.file, fixed, options).map((finding) => finding.rule);
        assert.deepEqual(after, [], 'lint reports nothing after fix');
        const form = golden(fixture);
        assert.ok(form !== undefined, 'a fixture of a rule fix writes has its recorded Linear form');
        assert.equal(fixed, splitFile(source).head + form, "fix reaches Linear's recorded form");
      } else if (ESCAPED_BY_FIX.has(fixture.file)) {
        assert.ok(fixture.class === 'lint-error' && FIXED_RULES.has(fixture.rule as LintRule), 'a fixture of a rule fix writes');
        assert.deepEqual(lintText(fixture.file, fixed, options).map((finding) => finding.rule), [], 'lint reports nothing after fix');
        assert.notEqual(fixed, source, 'fix rewrites it');
        // The escaped fixture is fix's output with its own canary.
        const escaped = read(bank.fixtures.find((other) => other.file === ESCAPED_BY_FIX.get(fixture.file))!);
        const canary = (text: string): string => /kx-[0-9a-f]{8}/.exec(text)![0];
        assert.equal(fixed.replace(canary(source), canary(escaped)), escaped, 'fix writes the escaped fixture');
      } else {
        assert.equal(fixed, source, 'L0-03: fix leaves it byte for byte');
        const form = golden(fixture);
        if (fixture.class === 'unchanged' && form !== undefined) {
          // A pull of the document Linear holds reads as the same tree.
          const { head, body } = splitFile(source);
          assert.ok(sameAsLinear(form, body), "L0-02: Linear's recorded form is no change from the file");
          const uploaded = form.replaceAll('../assets/', 'https://uploads.example/');
          assert.ok(sameMarkdown(splitFile(fixLinearText(head + form, uploaded, options.linkedFileExists)).body, body), 'L0-02: capture keeps the tree');
        }
      }
    });
  }
});

describe('front matter', () => {
  it('fix splits off what the probe does not send', () => {
    const samples = [...markdown.map(read), '--- \na: 1\n---\n\nBody', '\uFEFF---\na: 1\n---\nBody', '---\nno closing line'];
    for (const text of samples) assert.equal(splitFile(text).body, sentForm(text).replace(/^\uFEFF/, ''), JSON.stringify(text.slice(0, 40)));
  });
});

describe('lint on the fixture bank', () => {
  for (const fixture of markdown) {
    it(`${fixture.file} (${fixture.class})`, () => {
      const findings = lintText(fixture.file, read(fixture), { linkedFileExists: linkedFileResolver(fixture.file, bank.dir) });
      if (contentRules(fixture)) {
        assert.ok(findings.some((finding) => finding.rule === fixture.rule), `reports ${fixture.rule}: ${JSON.stringify(findings)}`);
        const expected = (fixture as BankFixture & { line?: number }).line;
        if (expected !== undefined) assert.ok(findings.some((finding) => finding.rule === fixture.rule && finding.line === expected), `on line ${expected}`);
        for (const finding of findings) assert.equal(finding.file, fixture.file);
      } else if (fixture.class === 'fixable') {
        // Only what fix writes in Linear's form (a tab in a list prefix), which the fix test sees go.
        assert.deepEqual(findings.filter((finding) => !FIXED_RULES.has(finding.rule)), [], 'no finding fix leaves');
      } else {
        assert.deepEqual(findings, [], 'no finding');
      }
    });
  }

  it('reports colliding titles under the names the fixtures are written as', () => {
    const collisions = bank.fixtures.filter((fixture) => fixture.rule === 'duplicate-title');
    const names = collisions.map((fixture) => (fixture as BankFixture & { name_as?: string }).name_as ?? fixture.file);
    const findings = duplicateTitles([...names, ...markdown.filter((f) => !collisions.includes(f)).map((f) => f.file)]);
    assert.deepEqual(findings.map((finding) => finding.file).sort(), [...names].sort());
  });
});
