import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixText } from './fix.ts';
import { lintText } from './lint.ts';

describe('a line opening with >>>', () => {
  // [input, Linear's form, which fix writes]
  const written: Array<[string, string]> = [
    ['Before\n\n>>> Plum notes\n\nAfter one\n\nAfter two', 'Before\n\n+++ Plum notes\n\nAfter one\n\nAfter two\n\n+++'],
    // The title is the opener's line alone; the next line starts the section's text.
    ['>>> Plum notes\nNext line\n\nAfter', '+++ Plum notes\n\nNext line\n\nAfter\n\n+++'],
    ['>>> Plum notes\n> more\n\nAfter', '+++ Plum notes\n\n> more\n\nAfter\n\n+++'],
    // Without a title it opens a section only when none is open; otherwise it closes every open one.
    ['>>> One\n>>> Two\nx\n>>>\ny', '+++ One\n\n+++ Two\n\nx\n\n+++\n\n+++\n\ny'],
    ['* item\n\n  >>> Plum notes\n\n  inner\n\n  >>>\n\n  outer\n* next', '* item\n\n  +++ Plum notes\n\n  inner\n\n  +++\n\n  outer\n* next'],
    ['>>>\n\nAfter', '+++ \n\nAfter\n\n+++'],
    ['>>> Plum notes\nInside.\n>>>\n\nOutside.', '+++ Plum notes\n\nInside.\n\n+++\n\nOutside.'],
    ['Before.\n>>> Plum notes\n\nInside.\n\n>>>\n\n>>>\n\nAfter', 'Before.\n\n+++ Plum notes\n\nInside.\n\n+++\n\n+++ \n\nAfter\n\n+++'],
    ['>>>Plum notes\n\nAfter', '+++ Plum notes\n\nAfter\n\n+++'],
    ['>>>\tPlum notes  \n\nAfter', '+++ Plum notes\n\nAfter\n\n+++'],
    ['>>>> Plum notes\n\nAfter', '+++ Plum notes\n\nAfter\n\n+++'],
    ['  >>> Plum notes\n\nAfter', '+++ Plum notes\n\nAfter\n\n+++'],
    ['>>> **Bold** title and `code`\n\nAfter', '+++ **Bold** title and `code`\n\nAfter\n\n+++'],
    // It interrupts a paragraph, and a lazy line ends the list above it.
    ['Before\n>>> Plum notes\n\nAfter', 'Before\n\n+++ Plum notes\n\nAfter\n\n+++'],
    ['* item\n>>> Plum notes\n\nAfter', '* item\n\n+++ Plum notes\n\nAfter\n\n+++'],
    // Headings and lists inside do not end it: it runs to the end of its container.
    ['# Heading\n\n>>> Plum notes\n\n## Sub\n\ntext', '# Heading\n\n+++ Plum notes\n\n## Sub\n\ntext\n\n+++'],
    ['>>> Plum notes\n\n* one\n* two', '+++ Plum notes\n\n* one\n* two\n\n+++'],
    // A second opener nests in the first; both close at the end.
    ['>>> One\n\nA\n\n>>> Two\n\nB', '+++ One\n\nA\n\n+++ Two\n\nB\n\n+++\n\n+++'],
    ['>>> One\n>>> Two\n\nAfter', '+++ One\n\n+++ Two\n\nAfter\n\n+++\n\n+++'],
    // In a list item or a quote, the section closes where its container ends.
    ['* item\n\n  >>> Plum notes\n\n  inner\n* next\n\nTail', '* item\n\n  +++ Plum notes\n\n  inner\n\n  +++\n* next\n\nTail'],
    ['1. a\n\n   >>> Plum notes\n\n   b\n2. c\n\nTail', '1. a\n\n   +++ Plum notes\n\n   b\n\n   +++\n2. c\n\nTail'],
    ['> quote\n>\n> >>> Plum notes\n>\n> inner\n\nTail', '> quote\n>\n> +++ Plum notes\n>\n> inner\n>\n> +++\n\nTail'],
    ['> > >>> Plum notes\n> >\n> > inner\n\nTail', '> > +++ Plum notes\n> >\n> > inner\n> >\n> > +++\n\nTail'],
  ];
  for (const [input, expected] of written) {
    it(`becomes a collapsible section: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected, 'a second fix changes nothing');
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }

  // Linear reads these as quotes or text, as Markdown does.
  const kept: Array<[string, string]> = [
    ['>> Plum notes\n\nAfter', '> > Plum notes\n\nAfter'],
    ['> > > Plum notes\n\nAfter', '> > > Plum notes\n\nAfter'],
    // The first sign continues the quote above, so two are left: a nested quote.
    ['> x\n>>> Plum notes\n\nAfter', '> x\n>\n> > > Plum notes\n\nAfter'],
    ['\\>>> Plum notes\n\nAfter', '\\>>> Plum notes\n\nAfter'],
    ['```\n>>> Plum notes\n```\n\nAfter', '```\n>>> Plum notes\n```\n\nAfter'],
    ['a\n\n    >>> code\n\nAfter', 'a\n\n```\n>>> code\n```\n\nAfter'],
  ];
  for (const [input, expected] of kept) {
    it(`stays what Markdown reads: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), expected);
    });
  }

  // Trailing whitespace at the end stays out of the closing line, which would read as an opener.
  const trailing: Array<[string, string]> = [
    ['>>> Notes\n\nBody  \n', '+++ Notes\n\nBody\n\n+++'],
    ['>>> Notes  ', '+++ Notes\n\n+++'],
    ['Notes\n\n>>> Plans \t', 'Notes\n\n+++ Plans\n\n+++'],
  ];
  for (const [input, expected] of trailing) {
    it(`closes after trailing whitespace: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), expected);
    });
  }

  it('writes a +++ in the title as part of it', () => {
    assert.equal(fixText('>>> +++ Notes\n\nBody'), '+++ +++ Notes\n\nBody\n\n+++');
  });

  it('writes hundreds of sections in one go', () => {
    let input = '';
    for (let index = 0; index < 400; index++) input += `>>> Title ${index}\nbody ${index}\n`;
    const started = Date.now();
    const fixed = fixText(input);
    assert.ok(Date.now() - started < 10_000, 'fix stays fast');
    assert.equal(fixed.split('\n').filter((line) => line.startsWith('+++ Title')).length, 400);
    assert.equal(fixText(fixed), fixed);
  });

  // A title-less section line inside a section (Linear writes `+++ `, which
  // reads as a closing line), a title-less >>> line after a +++ line closed
  // its sections, a wider marker, or the closing line would land in code:
  // the author decides.
  const left = [
    '>>> Plum notes\n\nAfter\n\n+++\n\nTail',
    '+++ Plum notes\n\nAfter\n\n>>>\n\nTail\n\n+++\n\nEnd',
    '>>> Plum notes\n\nAfter\n\n+++\n\nTail\n\n>>>\n\nEnd',
    '+++ Plum notes\n\nAfter\n\n>>> Pears\n\nTail\n\n+++\n\n>>>\n\nEnd',
    '>>> Plum notes\n\nAfter\n\n++++ Pears\n\nTail',
    '+++ Plum\n\nAfter\n\n>>> Pears\n\n+++ Figs\n\nTail\n\n>>>\n\nEnd\n\n<pre>\nq',
    '> +++ Plum\n> >>> Pears\n> +++\nOutside',
    '>>> Plum notes\n\nAfter\n\n+++ Pears',
    '>>> Notes\n\n```\ncode',
    '* a\n\n  >>> Notes\n\n  ```\n  code\n* b',
    '>>> Notes\n\n<pre>\nx',
  ];
  for (const input of left) {
    it(`is left to the author and reported: ${JSON.stringify(input)}`, () => {
      assert.equal(fixText(input), input);
      assert.ok(lintText('doc.md', input).some((finding) => finding.rule === 'section-opener'));
    });
  }

  it('is reported on the line of the first section line', () => {
    const findings = lintText('doc.md', '+++ Earlier\n\nKept.\n\n>>>\n\nToday.\n\n+++').filter((finding) => finding.rule === 'section-opener');
    assert.deepEqual(findings.map((finding) => finding.line), [5]);
  });
});

// Linear pairs >>> lines and +++ lines apart: a title-less line closes the
// innermost +++ section, or every >>> section, with the sections nested in it.
describe('>>> and +++ section lines in one file', () => {
  const cases = [
    ['a >>> section after a closed +++ section', '+++ Earlier\n\nKept.\n\n+++\n\n>>> New\n\nToday.',
      '+++ Earlier\n\nKept.\n\n+++\n\n+++ New\n\nToday.\n\n+++'],
    ['a +++ section after a closed >>> section', '>>> First\n\nKept.\n\n>>>\n\n+++ Second\n\nToday.\n\n+++\n\nAfter',
      '+++ First\n\nKept.\n\n+++\n\n+++ Second\n\nToday.\n\n+++\n\nAfter'],
    ['a +++ section inside a >>> section', '>>> Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\nLater\n\n>>>\n\nAfter',
      '+++ Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\nLater\n\n+++\n\nAfter'],
    ['a +++ line closes the >>> section inside its section', '+++ Outer\n\nKept.\n\n>>> Inner\n\nToday.\n\n+++\n\nAfter',
      '+++ Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\n+++\n\nAfter'],
    ['a >>> line closes the +++ sections inside its sections', '>>> First\n\nKept.\n\n>>> Second\n\n+++ Third\n\n+++ Fourth\n\nToday.\n\n>>>\n\nAfter',
      '+++ First\n\nKept.\n\n+++ Second\n\n+++ Third\n\n+++ Fourth\n\nToday.\n\n+++\n\n+++\n\n+++\n\n+++\n\nAfter'],
    ['both kinds open at the end', '+++ Outer\n\nKept.\n\n>>> Inner\n\nToday.', '+++ Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\n+++'],
    ['an empty >>> section at the end of a +++ section', '+++ Outer\n\nKept.\n\n>>> Inner', '+++ Outer\n\nKept.\n\n+++ Inner\n\n+++\n\n+++'],
    ['a +++ section open inside an open >>> section', '>>> Outer\n\nKept.\n\n+++ Inner\n\nToday.', '+++ Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\n+++'],
    ['lines without blank lines', '>>> Outer\nKept.\n+++ Inner\nToday.\n+++\nAfter', '+++ Outer\n\nKept.\n\n+++ Inner\n\nToday.\n\n+++\n\nAfter\n\n+++'],
    ['a title-less >>> line after a closed +++ section', '+++ Earlier\n\nKept.\n\n+++\n\n>>>\n\nToday.', '+++ Earlier\n\nKept.\n\n+++\n\n+++ \n\nToday.\n\n+++'],
    ['in a list item', '* Tray\n\n  +++ Outer\n\n  Kept.\n\n  >>> Inner\n\n  Today.\n\n  +++\n\n  After\n* Tools',
      '* Tray\n\n  +++ Outer\n\n  Kept.\n\n  +++ Inner\n\n  Today.\n\n  +++\n\n  +++\n\n  After\n* Tools'],
    ['in a quote', '> +++ Earlier\n>\n> Kept.\n>\n> +++\n>\n> >>> New\n>\n> Today.',
      '> +++ Earlier\n>\n> Kept.\n>\n> +++\n>\n> +++ New\n>\n> Today.\n>\n> +++'],
  ] as const;
  for (const [label, input, expected] of cases) {
    it(label, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected);
      assert.deepEqual(lintText('doc.md', input).filter((finding) => finding.rule === 'section-opener'), []);
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }
});

describe('triple-plus section markers', () => {
  const cases = [
    ['bare opener and closer', '+++\n\nSeeds\n\n+++', '+++ \n\nSeeds\n\n+++'],
    // Linear reads a longer run of signs as a marker and writes three (MDS-029-88).
    ['longer markers pair by their width', '++++ Tip\n\nSeeds\n\n++++', '+++ Tip\n\nSeeds\n\n+++'],
    ['a longer titled marker interrupts a paragraph', 'Intro\n++++Tip\n\nSeeds', 'Intro\n\n+++ Tip\n\nSeeds\n\n+++'],
    ['a longer bare marker opens an untitled section', 'Intro\n\n++++++++++\n\nSeeds', 'Intro\n\n+++ \n\nSeeds\n\n+++'],
    ['a longer marker starting an item with more of it', '1. ++++Tip\n   Seeds', '1. \n\n   +++ Tip\n\n   Seeds\n\n   +++'],
    ['a longer marker starting a nested item', '* a\n  * ++++Tip\n\n    Seeds', '* a\n  * \n\n    +++ Tip\n\n    Seeds\n\n    +++'],
    ['a longer marker starting a quote', '> ++++Tip\n>\n> Seeds', '> +++ Tip\n>\n> Seeds\n>\n> +++'],
    ['a longer marker that is the item\'s only text stays text', '1. ++++Tip\n2. Next', '1. ++++Tip\n2. Next'],
    // Markers of other widths do not pair in Linear: the container stays as written.
    ['mixed widths stay as written', '1. ++++Tip\n\n   Seeds\n\n   +++', '1. ++++Tip\n\n   Seeds\n\n   +++'],
    ['titled opener', '+++ Garden\n\nSeeds\n\n+++', '+++ Garden\n\nSeeds\n\n+++'],
    ['titled opener with a padded closer', '+++ Garden\n\nSeeds\n\n+++ \t', '+++ Garden\n\nSeeds\n\n+++'],
    ['nesting and successive sections', '+++\n\n+++ Tray\n\nSeeds\n\n+++\n\nWater daily\n\n+++\n\n+++\n\nTools\n\n+++',
      '+++ \n\n+++ Tray\n\nSeeds\n\n+++\n\nWater daily\n\n+++\n\n+++ \n\nTools\n\n+++'],
    ['explicit empty section', '+++\n\n+++', '+++ \n\n+++'],
    ['unpaired opener with a body', '+++\n\nSeeds', '+++ \n\nSeeds\n\n+++'],
    ['unpaired nested opener with a body', '+++\n\n+++ Tray\n\nSeeds', '+++ \n\n+++ Tray\n\nSeeds\n\n+++\n\n+++'],
    ['lone marker', '+++', '+++'],
    ['final marker with no opener', 'Seeds\n+++', 'Seeds\n\n+++'],
    ['final title-like text inside a section', '+++\n\nSeeds\n\n+++ Tray', '+++ \n\nSeeds\n\n+++ Tray\n\n+++'],
    ['paragraph interruption', 'Before\n+++\nSeeds\n+++\nOutside', 'Before\n\n+++ \n\nSeeds\n\n+++\n\nOutside'],
    ['quote boundary', '+++ Garden\n\n> +++\n>\n> Seeds\n\n+++', '+++ Garden\n\n> +++ \n>\n> Seeds\n>\n> +++\n\n+++'],
    ['list item boundary', '* Tray\n  +++\n  Seeds\n* Tools\n  +++', '* Tray\n\n  +++ \n\n  Seeds\n\n  +++\n* Tools\n\n  +++'],
    ['tab after a bullet marker', '*\tTray\n\n\t+++\n\n\tSeeds',
      '* Tray\n\n  +++ \n\n  Seeds\n\n  +++'],
    ['space and tab after an ordered marker', '1. \tTray\n\n\t+++\n\n\tSeeds',
      '1. Tray\n\n   +++ \n\n   Seeds\n\n   +++'],
    ['tab after a bullet inside a quote', '>  *\tTray\n>\n> \t\t+++\n>\n> \t\tSeeds',
      '> * Tray\n>\n>   +++ \n>\n>   Seeds\n>\n>   +++'],
    ['section first in item', '* +++\n\n  Seeds\n\n  +++\n* Tools', '* \n\n  +++ \n\n  Seeds\n\n  +++\n* Tools'],
    ['lazy list continuation', '* Tray\n+++\nSeeds\n+++', '* Tray\n\n+++ \n\nSeeds\n\n+++'],
    // Linear keeps a marker over a lazy line as text. Written with the
    // line's prefix it would read as a section: the marker is escaped.
    ['marker over a lazy quote line', '> +++\nSeeds', '> \\+++\n> Seeds'],
    ['marker over a lazy item line', '* +++\nSeeds', '* \\+++\n  Seeds'],
    ['titled marker over a lazy item line', '* +++Plan\nlazy words', '* \\+++Plan\n  lazy words'],
    ['marker over a sibling item stays text', '* +++\n* b', '* +++\n* b'],
    ['titled marker first in an item, the next line right below it', '1. +++Plan\n   first step', '1. \n\n   +++ Plan\n\n   first step\n\n   +++'],
    ['titled marker first in a quote, the next line right below it', '> +++Plan\n> first step', '> +++ Plan\n>\n> first step\n>\n> +++'],
    ['titled section first in an item', '* +++ Tray\n\n  Seeds\n\n  +++\n* Tools', '* \n\n  +++ Tray\n\n  Seeds\n\n  +++\n* Tools'],
    ['titled marker alone in an item stays text', '1. +++Plan\n2. Next', '1. +++Plan\n2. Next'],
    ['indent at the document root does not move the closer into a list', '  +++\n\n* Seeds', '+++ \n\n* Seeds\n\n+++'],
    ['indent in a quote does not move the closer into a list', '>   +++\n>\n> * Seeds',
      '> +++ \n>\n> * Seeds\n>\n> +++'],
    ['escaped marker', '\\+++\n\nSeeds', '\\+++\n\nSeeds'],
    ['fenced marker', '```\n+++\n```', '```\n+++\n```'],
    ['multiline link label', 'Read [the\n+++\nnotes](/notes).', 'Read [the\n+++\nnotes](</notes>).'],
    ['a code span does not affect a later marker', '`first\n+++\nlast`\n\n+++\n\nSeeds', '`first +++ last`\n\n+++ \n\nSeeds\n\n+++'],
    ['marker inside display math', '$$\na\n+++\nb\n$$', '```math\na\n+++\nb\n```'],
    // Linear ends the table at the line without a pipe (MDS-029-90).
    ['marker after a table row', '| a |\n| - |\n| b |\n+++\nSeeds', '| a |\n| -- |\n| b |\n\n+++ \n\nSeeds\n\n+++'],
    ['marker inside a table row', '| a |\n| - |\n| b |\n| +++ |\nSeeds', '| a |\n| -- |\n| b |\n| +++ |\n\nSeeds'],
    ['open code fence at end of section', '+++\n\n```\nSeeds', '+++ \n\n```\nSeeds\n```\n\n+++'],
    ['indented backticks do not close the fence', '+++\n\n```\n    ```', '+++ \n\n````\n    ```\n````\n\n+++'],
    ['open fence ends at the next item', '* Tray\n\n  +++\n\n   ```\n   Seeds\n* Tools',
      '* Tray\n\n  +++ \n\n  ```\n  Seeds\n  ```\n\n  +++\n* Tools'],
    ['open HTML would swallow the closer', '+++\n\n<pre>\nSeeds', '+++\n\n<pre>\nSeeds'],
    ['unclosed section with only an empty nested section stays literal', '+++\n\n+++ Tray\n\n+++', '+++\n\n+++ Tray\n\n+++'],
  ] as const;
  for (const [label, input, expected] of cases) {
    it(label, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected);
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }
});
