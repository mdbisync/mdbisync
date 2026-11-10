// The public format docs against the code: every lint rule documented with
// its message and an example that triggers it, and every one-line `fix`
// example producing what the docs say.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fixText } from './fix.ts';
import { duplicateTitles, lintText } from './lint.ts';
import { LINT_RULES, type LintRule } from './rules.ts';

const docs = readFileSync(new URL('../../docs/linear-format.md', import.meta.url), 'utf8');

/** The text of a `## ` section, up to the next `## ` heading. */
function section(heading: string): string {
  const from = docs.indexOf(`\n## ${heading}\n`);
  assert.notEqual(from, -1, `docs have no section "${heading}"`);
  const to = docs.indexOf('\n## ', from + 1);
  return docs.slice(from, to === -1 ? undefined : to);
}

/** The rule sections under "Lint rules", by rule id, in document order. */
function ruleSections(): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = section('Lint rules').split(/\n### `([^`]+)`\n/);
  for (let index = 1; index < parts.length; index += 2) sections.set(parts[index]!, parts[index + 1]!);
  return sections;
}

/** The fenced code blocks of a text, with their info strings. */
function fences(text: string): Array<{ info: string; body: string }> {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].map((match) => ({ info: match[1]!, body: match[2]! }));
}

describe('format docs', () => {
  it('list exactly the lint rules of the code, in its order', () => {
    assert.deepEqual([...ruleSections().keys()], Object.keys(LINT_RULES));
  });

  it("give each rule's message and an example", () => {
    for (const [rule, text] of ruleSections()) {
      const message = LINT_RULES[rule as LintRule];
      assert.ok(text.replace(/\s+/g, ' ').includes(message), `${rule}: the docs do not give the message "${message}"`);
      assert.ok(fences(text).length > 0, `${rule}: no example`);
    }
  });

  it('show Markdown examples that the rule reports', () => {
    for (const [rule, text] of ruleSections()) {
      for (const { info, body } of fences(text).filter((fence) => fence.info === 'markdown')) {
        const rules = lintText('example.md', body).map((finding) => finding.rule);
        assert.ok(rules.includes(rule as LintRule), `${rule}: its example is reported as ${JSON.stringify(rules)}`);
      }
    }
  });

  it('recommend alternatives that pass lint and that fix keeps', () => {
    // [what the docs show, a document that uses it]
    const alternatives: Array<[string, string]> = [
      ['`H<sub>2</sub>O`', 'Water is H<sub>2</sub>O.'],
      ['`~~strikethrough~~`', 'A ~~strikethrough~~ word.'],
      ['`` `a \\| b` ``', '| Expression | Meaning |\n| -- | -- |\n| `a \\| b` | either |'],
      ['end the line with two spaces', 'First line  \nSecond line'],
      ['`<br>`', 'First line<br>Second line'],
      ['`![Banner](images/banner.png)`', '![Banner](images/banner.png)'],
      ['`![Revenue chart](images/revenue.png)`', '![Revenue chart](images/revenue.png)'],
    ];
    const flat = docs.replace(/\s+/g, ' ');
    for (const [shown, document] of alternatives) {
      assert.ok(flat.includes(shown), `the docs no longer show ${shown}`);
      assert.deepEqual(lintText('example.md', document), [], `lint reports ${shown}`);
      assert.equal(fixText(document), document, `fix changes ${shown}`);
    }
  });

  it('show colliding paths for duplicate-title', () => {
    const [example] = fences(ruleSections().get('duplicate-title')!);
    const paths = example!.body.split('\n');
    assert.deepEqual(duplicateTitles(paths).map((finding) => finding.file).sort(), [...paths].sort());
  });

  it('show fix examples that fix turns into the documented form', () => {
    const examples = [...section('What `fix` changes').replace(/\n\s*/g, ' ').matchAll(/`([^`]+)` becomes `([^`]+)`/g)];
    assert.ok(examples.length >= 10, `only ${examples.length} examples found`);
    for (const [, before, after] of examples) assert.equal(fixText(before!), after, `fix of ${before}`);
  });
});
