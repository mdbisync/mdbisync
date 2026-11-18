// The conflict mark in its callout form and in the earlier form of bare
// marker paragraphs: both are found, read and resolved the same way.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixText } from '../format/index.ts';
import { lintText } from '../format/lint.ts';
import { CALLOUT_COMMENT, detectConflicts, markerCallout, markerLines, MARKERS } from './markers.ts';
import { mergeMarkdown } from './merge.ts';

const callouts = (ours: string, theirs: string) =>
  `${markerCallout(MARKERS.git)}\n\n${ours}\n\n${markerCallout(MARKERS.linear)}\n\n${theirs}\n\n${markerCallout(MARKERS.end)}`;
const bare = (ours: string, theirs: string) =>
  `${MARKERS.git}\n\n${ours}\n\n${MARKERS.linear}\n\n${theirs}\n\n${MARKERS.end}`;

test('the sync writes each marker as a one-line warning callout with its color comment', () => {
  assert.equal(markerCallout(MARKERS.git), `${CALLOUT_COMMENT}\n> [!WARNING]\n> ${MARKERS.git}`);
  assert.equal(CALLOUT_COMMENT, '<!-- linear:callout color=#f2c94c -->');
});

test('a callout mark is one conflict spanning its callouts, with both versions read as body text', () => {
  const text = `Intro.\n\n${callouts('One **version**.', '| a |\n| -- |\n| 1 |')}\n\nOutro.\n`;
  assert.deepEqual(detectConflicts(text), [{ startLine: 3, endLine: 19, git: 'One **version**.', linear: '| a |\n| -- |\n| 1 |' }]);
  assert.deepEqual([...markerLines(text).values()], Object.values(MARKERS));
});

test('a mark in the earlier form of bare marker paragraphs is still one conflict', () => {
  const text = `Intro.\n\n${bare('One.', 'Two.')}\n\nOutro.\n`;
  assert.deepEqual(detectConflicts(text), [{ startLine: 3, endLine: 11, git: 'One.', linear: 'Two.' }]);
});

test('a callout without its color comment, or of another alert kind, is still a marker', () => {
  for (const prefix of ['> [!WARNING]', '> [!CAUTION]', '<!-- linear:callout color=#eb5757 -->\n> [!NOTE]']) {
    const block = (marker: string) => `${prefix}\n> ${marker}`;
    const text = `${block(MARKERS.git)}\n\nOne.\n\n${block(MARKERS.linear)}\n\nTwo.\n\n${block(MARKERS.end)}\n`;
    const [conflict] = detectConflicts(text);
    assert.equal(detectConflicts(text).length, 1, prefix);
    assert.deepEqual([conflict!.git, conflict!.linear], ['One.', 'Two.'], prefix);
  }
});

test('deleting the three callouts resolves the conflict; deleting only some keeps it', () => {
  const text = `Intro.\n\n${callouts('One.', 'Two.')}\n\nOutro.\n`;
  const resolved = 'Intro.\n\nOne.\n\nOutro.\n';
  assert.deepEqual(detectConflicts(resolved), []);
  const withoutEnd = text.replace(`${markerCallout(MARKERS.end)}\n\n`, '');
  assert.equal(detectConflicts(withoutEnd).length, 1);
  assert.equal(detectConflicts(`${MARKERS.end}\n`).length, 1, 'a bare marker alone stays a conflict');
});

test('markers in a plain quote, a nested callout, code or inline code are examples', () => {
  for (const marker of Object.values(MARKERS)) {
    for (const text of [
      `> ${marker}\n`,
      `* item\n\n  > [!WARNING]\n  > ${marker}\n`,
      `> [!WARNING]\n> \`${marker}\`\n`,
      `> [!WARNING]\n> \`\`\`\n> ${marker}\n> \`\`\`\n`,
      `> [!WARNING]\n> > ${marker}\n`,
      `> [!WARNING]\n> ${marker} extra\n`,
    ]) {
      assert.deepEqual(detectConflicts(text), [], text);
    }
  }
});

test('a new conflict over an old callout mark replaces it: no nested or repeated markers', async () => {
  const base = `Intro.\n\n${callouts('old git', 'old Linear')}\n\nOutro.`;
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.equal(result.conflicts.length, 1);
  for (const marker of Object.values(MARKERS)) assert.equal(result.text.split(marker).length - 1, 1, marker);
  assert.equal(result.text.split(CALLOUT_COMMENT).length - 1, 3);
  assert.equal(result.text, `Intro.\n\n${callouts('new git\n\nold Linear', 'new Linear\n\nold Linear')}\n\nOutro.`);
});

test('a new conflict over an old bare mark writes the callout form', async () => {
  const base = `Intro.\n\n${bare('old git', 'old Linear')}\n\nOutro.`;
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.equal(result.text, `Intro.\n\n${callouts('new git\n\nold Linear', 'new Linear\n\nold Linear')}\n\nOutro.`);
});

test('linear-format leaves a callout mark unchanged and reports nothing', async () => {
  const merged = await mergeMarkdown('# Notes\n\n| a |\n| -- |\n| 1 |\n\nTail.', '# Notes\n\n| a |\n| -- |\n| 2 |\n\nTail.', '# Notes\n\n| a |\n| -- |\n| 3 |\n\nTail.');
  assert.equal(merged.conflicts.length, 1);
  assert.equal(fixText(merged.text), merged.text);
  assert.deepEqual(lintText('notes.md', merged.text), []);
});

test("the mark the sync writes is Linear's recorded form of it", async () => {
  const recorded = readFileSync(new URL('../../test/fixtures/conflict-markers/callout-markers-color.linear.md', import.meta.url), 'utf8');
  const merged = await mergeMarkdown('Intro.\n\nThe release ships on Monday.\n\nOutro.', 'Intro.\n\nThe release ships on Tuesday.\n\nOutro.', 'Intro.\n\nThe release ships on Wednesday.\n\nOutro.');
  assert.equal(recorded.replace(/\n\nRef kx-[0-9a-f]{8}$/, ''), merged.text);
});

test('text typed into an old marker callout stays a paragraph of its own, still quoted, when a new conflict replaces the mark', async () => {
  const typed = `${CALLOUT_COMMENT}\n> [!WARNING]\n> ${MARKERS.git}\n>\n> A note typed here.`;
  const base = `Intro.\n\n${typed}\n\nold git\n\n${markerCallout(MARKERS.linear)}\n\nold Linear\n\n${markerCallout(MARKERS.end)}\n\nOutro.`;
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.git, '>\n> A note typed here.\n\nnew git\n\nold Linear');
});

test('a marker shown as an example in a quote inside a marker callout stays an example when a new conflict replaces the mark', async () => {
  const example = `${CALLOUT_COMMENT}\n> [!WARNING]\n> ${MARKERS.git}\n>\n> > ${MARKERS.end}`;
  const base = `${example}\n\nold git\n\n${markerCallout(MARKERS.linear)}\n\nold Linear\n\n${markerCallout(MARKERS.end)}\n\nOutro.`;
  assert.equal(detectConflicts(base).length, 1);
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.text.split(`> > ${MARKERS.end}`).length - 1, 2, 'the example is kept in both versions, still quoted');
});

test('markers pasted into one callout each bound their own version', () => {
  const text = `> [!WARNING]\n> ${MARKERS.git}\n>\n> One.\n>\n> ${MARKERS.linear}\n>\n> Two.\n>\n> ${MARKERS.end}\n`;
  const [conflict] = detectConflicts(text);
  assert.equal(detectConflicts(text).length, 1);
  assert.deepEqual({ ...conflict }, { startLine: 1, endLine: 10, git: '>\n> One.\n>', linear: '>\n> Two.\n>' });
});

test("a conflict in a person's colored callout takes in its color comment, so both versions keep their color", async () => {
  const callout = (text: string) => `<!-- linear:callout color=#eb5757 -->\n> [!NOTE]\n> ${text}`;
  const base = `Intro.\n\n${callout('old')}\n\nOutro.`;
  const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, `Intro.\n\n${callouts(callout('git'), callout('Linear'))}\n\nOutro.`);
  assert.equal(fixText(result.text), result.text);
});

test('fix keeps a blank line between a color comment and a plain quote, which is no callout', () => {
  const text = '<!-- linear:callout color=#eb5757 -->\n\n> Just a quote.';
  assert.equal(fixText(text), text);
  assert.equal(fixText('<!-- linear:callout color=#eb5757 -->\n\n> [!NOTE]\n> A note.'), '<!-- linear:callout color=#eb5757 -->\n> [!NOTE]\n> A note.');
});
