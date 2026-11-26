import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixLinearText, fixText } from './fix.ts';
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
    ['a longer bare marker opens an untitled section', 'Intro\n\n++++++++++\n\nSeeds', 'Intro\n\n+++ \n\nSeeds\n\n+++'],
    ['a longer marker that is the item\'s only text stays text', '1. ++++Tip\n2. Next', '1. ++++Tip\n2. Next'],
    // Markers of other widths do not pair in Linear: the container stays as written.
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
    ['lazy list continuation', '* Tray\n+++\nSeeds\n+++', '* Tray\n\n+++ \n\nSeeds\n\n+++'],
    // Linear keeps a marker over a lazy line as text. Written with the
    // line's prefix it would read as a section: the marker is escaped.
    ['marker over a lazy quote line', '> +++\nSeeds', '> \\+++\n> Seeds'],
    ['marker over a lazy item line', '* +++\nSeeds', '* \\+++\n  Seeds'],
    ['titled marker over a lazy item line', '* +++Plan\nlazy words', '* \\+++Plan\n  lazy words'],
    ['marker over a sibling item stays text', '* +++\n* b', '* +++\n* b'],
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

// Linear writes a section's title line as its signs and a space. Signs
// with text right after them are text; Linear's import would still open a
// section there when more of the container follows, so fix escapes them.
describe('plus signs with text right after them', () => {
  const escaped = [
    ['a longer run interrupting a paragraph', 'Intro\n++++Tip\n\nSeeds', 'Intro\n\\++++Tip\n\nSeeds', 2],
    ['a longer run starting a quote', '> ++++Tip\n>\n> Seeds', '> \\++++Tip\n>\n> Seeds', 1],
    ['first in a quote, the next line right below it', '> +++Plan\n> first step', '> \\+++Plan\n> first step', 1],
    ['first in an item, the next line right below it', '1. +++Plan\n   first step', '1. \\+++Plan\n   first step', 1],
    ['a longer run with more of the item', '1. ++++Tip\n   Seeds', '1. \\++++Tip\n   Seeds', 1],
    ['a longer run in a nested item', '* a\n  * ++++Tip\n\n    Seeds', '* a\n  * \\++++Tip\n\n    Seeds', 2],
    ['over a nested item, tab-indented', '1. Spring\n\t1. +++Seed notes\n\t\t1. **Water**\n\t2. Plant',
      '1. Spring\n   1. \\+++Seed notes\n      1. **Water**\n   2. Plant', 2],
    ['with a closing line of another width', '1. ++++Tip\n\n   Seeds\n\n   +++', '1. \\++++Tip\n\n   Seeds\n\n   +++', 1],
    ['a paragraph continuation line', 'Week\n+++Plan\nmore words', 'Week\n\\+++Plan\nmore words', 2],
    ['before a closing line', '+++Tip\nSeeds\n+++', '\\+++Tip\nSeeds\n\n+++', 1],
    // As a paragraph's last line Linear splits it off as a paragraph of its own.
    ['a document\'s last line, continuing a paragraph', 'Intro words\n+++Tip', 'Intro words\n\\+++Tip', 2],
    ['an item\'s last line, continuing its text', '1. Week\n   +++Plan\n2. Next', '1. Week\n   \\+++Plan\n2. Next', 2],
  ] as const;
  for (const [label, input, expected, line] of escaped) {
    it(`is escaped and reported: ${label}`, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected);
      assert.deepEqual(lintText('doc.md', input).map((finding) => `${finding.rule}@${finding.line}`).filter((found) => !found.startsWith('tab-indentation@')), [`section-marker-text@${line}`]);
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }

  // As the last line of its container, Linear keeps it as text.
  for (const alone of ['1. +++Plan', '1. +++Plan\n2. Next step', '* Week\n  * +++Plan', '+++Plan', '> +++Tip']) {
    it(`stays as written alone in its container: ${JSON.stringify(alone)}`, () => {
      assert.equal(fixText(alone), alone);
      assert.deepEqual(lintText('doc.md', alone), []);
    });
  }

  it('reports a block that starts an item once the escape joins the lines above, on its own line', () => {
    const input = '* +++A\n  a\n* +++B\n  b\n* +++C\n  c\n* +++D\n  d\n* +++\n\n  Seeds\n\n  +++';
    assert.deepEqual(lintText('doc.md', input).map((finding) => `${finding.rule}@${finding.line}`),
      ['section-marker-text@1', 'section-marker-text@3', 'section-marker-text@5', 'section-marker-text@7', 'block-first-in-list-item@9']);
    assert.equal(fixText(input), input, 'left to the author');
  });

  it('reads a long run of signs in about the time of its length', () => {
    const run = '+'.repeat(64_000);
    const started = Date.now();
    lintText('doc.md', `${run}\n\nText`);
    fixText(`${run}\n\nText`);
    assert.ok(Date.now() - started < 3_000, 'lint and fix stay fast');
  });

  it('leaves a section title after a space to the section rules', () => {
    assert.equal(fixText('> +++ Plan\n> first step'), '> +++ Plan\n>\n> first step\n>\n> +++');
  });
});

// Linear writes a section that starts a list item as the item's marker, a
// blank line and the section at the item's text column, and reads that form
// back as an empty item with the section after it, outside the item (MDS-029-88).
describe('a section that starts a list item', () => {
  const left: Array<[string, string, number]> = [
    ['an untitled section', '* +++\n\n  Seeds\n\n  +++\n* Tools', 1],
    ['a titled section', '* +++ Tray\n\n  Seeds\n\n  +++\n* Tools', 1],
    ['a nested item after a list of another kind', '* Plan\n  1. one\n\n  * +++ \n\n    words\n\n    +++', 4],
    ['an item in a quote', '> 1. +++ Plan\n>    first step\n>\n>    +++', 1],
    ['a >>> line', '* >>> Tray\n\n  Seeds\n* Tools', 1],
    ['a >>> line in a nested item', '1. Spring\n   1. >>> Seed notes\n      Keep moist.\n   2. Plant', 2],
    ['a section with a closer of another width', '* +++ Tip\n\n  Seeds\n\n  ++++\n* Tools', 1],
    ['a section before one with a closer of another width', '* +++ Tray\n\n  Seeds\n\n  +++\n\n  ++++ Tip\n\n  Soil\n\n  +++\n* Tools', 1],
  ];
  for (const [label, input, line] of left) {
    it(`is left to the author and reported: ${label}`, () => {
      assert.equal(fixText(input), input);
      const findings = lintText('doc.md', input).filter((finding) => finding.rule === 'block-first-in-list-item');
      assert.deepEqual(findings.map((finding) => finding.line), [line]);
    });
  }

  const linearForms = [
    ['a bullet item', '* \n\n  +++ Tray\n\n  Seeds\n\n  +++\n* Tools', '* \n\n+++ Tray\n\nSeeds\n\n+++\n\n* Tools'],
    ['an ordered item', '1. \n\n   +++ Plan\n\n   first step\n\n   +++', '1. \n\n+++ Plan\n\nfirst step\n\n+++'],
    ['an item in a quote', '> 1. \n>\n>    +++ Plan\n>\n>    first step\n>\n>    +++', '> 1. \n>\n> +++ Plan\n>\n> first step\n>\n> +++'],
    // Linear writes the list going on right below the closing line, where
    // Markdown reads a marker numbered other than 1 as text: left as it is.
    ['a nested item, its list going on', '1. Spring\n   1. \n\n      +++ Seed notes\n\n      Keep moist.\n\n      +++\n   2. Plant',
      '1. Spring\n   1. \n\n      +++ Seed notes\n\n      Keep moist.\n\n      +++\n   2. Plant'],
  ] as const;
  for (const [label, input, expected] of linearForms) {
    it(`in Linear's form is an empty item and a section outside it: ${label}`, () => {
      assert.equal(fixText(input), expected);
      assert.equal(fixText(expected), expected);
      assert.deepEqual(lintText('doc.md', expected), []);
    });
  }

  // Linear writes the list going on right below the closing line, where
  // Markdown reads its marker as text of the `+++` paragraph: a capture
  // still reads the section, not a title to escape.
  const captured = [
    ['in the section\'s list', '1. Spring\n   1. \n\n   +++ Seed notes\n\n   Keep moist.\n\n   +++\n   2. Plant'],
    ['in the list around it', '1. Spring\n   1. \n\n      +++ Seed notes\n      1. **Water**\n\n      +++\n   2. Plant'],
    ['in an empty bullet item', '* Tools\n  * \n\n  +++ Shed\n\n  Rake.\n\n  +++\n  * \n  * Gloves'],
  ] as const;
  for (const [label, form] of captured) {
    it(`a capture keeps Linear's form of a section with a list going on ${label}`, () => {
      assert.equal(fixLinearText(form, form, () => false), form);
    });
  }

  it('reports a section scan past the parser\'s limits as markdown-complexity', () => {
    const chain = Array.from({ length: 80 }, () => '2.').join(' ');
    const input = `* +++ Notes\n  ${chain} a\n\n  +++`;
    assert.deepEqual(lintText('doc.md', input).map((finding) => finding.rule), ['markdown-complexity']);
  });

  it('a capture escapes a title above a list Linear does not write', () => {
    const form = '+++ Supplies\n\nBeans.\n\n+++ Rake\n2) Pear';
    assert.equal(fixLinearText(form, form, () => false).includes('\\+++ Supplies'), true);
  });

  it('is not reported for a marker fix keeps as text', () => {
    const input = '* +++ Tray\n\n  [ref]: /notes';
    assert.equal(fixText(input), input);
    assert.deepEqual(lintText('doc.md', input).filter((finding) => finding.rule === 'block-first-in-list-item'), []);
  });

  it('after the item\'s text stays in the item', () => {
    const input = '1. Spring\n   1. Notes\n\n      +++ Seed notes\n\n      Keep moist.\n\n      +++\n   2. Plant';
    assert.equal(fixText(input), input);
    assert.deepEqual(lintText('doc.md', input), []);
  });
});
