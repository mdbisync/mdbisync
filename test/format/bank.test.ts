// The normalizer against the fixture bank and Linear's recorded forms
// (L0-01 to L0-03 offline): `fix` reaches Linear's form and is idempotent,
// `lint` reports every lint-error fixture with its rule and line.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { duplicateTitles, fixText, linkedFileResolver, lintText, splitFile } from '../../src/format/index.ts';
import { goldenMarkdownPath, loadBank, readOptional, sentForm, type BankFixture } from '../probe/bank.ts';

const bank = loadBank();
const markdown = bank.fixtures.filter((fixture) => fixture.synced !== false && fixture.file.endsWith('.md'));
const read = (fixture: BankFixture): string => readFileSync(join(bank.dir, fixture.file), 'utf8');
const golden = (fixture: BankFixture): string | undefined => readOptional(join(bank.dir, goldenMarkdownPath(fixture.file)));
const contentRules = (fixture: BankFixture): boolean => fixture.class === 'lint-error' && fixture.rule !== 'duplicate-title';

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
        assert.equal(fixed, splitFile(source).head + form, "L0-02: fix reaches Linear's recorded form");
      } else {
        assert.equal(fixed, source, 'L0-03: fix leaves it byte for byte');
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
      const findings = lintText(fixture.file, read(fixture));
      if (contentRules(fixture)) {
        assert.ok(findings.some((finding) => finding.rule === fixture.rule), `reports ${fixture.rule}: ${JSON.stringify(findings)}`);
        const expected = (fixture as BankFixture & { line?: number }).line;
        if (expected !== undefined) assert.ok(findings.some((finding) => finding.rule === fixture.rule && finding.line === expected), `on line ${expected}`);
        for (const finding of findings) assert.equal(finding.file, fixture.file);
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
