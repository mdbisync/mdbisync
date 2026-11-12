import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { detectConflicts, MARKERS, mergeMarkdown } from './index.ts';

const conflict = (ours: string, theirs: string) =>
  `${MARKERS.git}\n\n${ours}\n\n${MARKERS.linear}\n\n${theirs}\n\n${MARKERS.end}\n`;

test('L3-01: edits to separate paragraphs merge without markers', async () => {
  const result = await mergeMarkdown('first\n\nsecond\n', 'updated\n\nsecond\n', 'first\n\nrevised\n');
  assert.equal(result.text, 'updated\n\nrevised\n');
  assert.deepEqual(result.conflicts, []);
});

test('a conflict at the end keeps the git file\'s final newline, or its absence, as a clean merge does', async () => {
  // Files in Linear's form, as the sync writes them, end without a newline; Linear keeps no final newline either.
  const linearForm = await mergeMarkdown('Intro.\n\nold', 'Intro.\n\ngit edit', 'Intro.\n\nLinear edit');
  assert.equal(linearForm.text, `Intro.\n\n${conflict('git edit', 'Linear edit').replace(/\n$/, '')}`);
  assert.equal(linearForm.conflicts.length, 1);
  // A clean merge stays as git made it: a one-sided change to the ending is an edit like any other.
  assert.equal((await mergeMarkdown('old', 'old', 'new\n')).text, 'new\n');
  assert.equal((await mergeMarkdown('a\n\nold\n', 'a\n\nold\n', 'a\n\nnew')).text, 'a\n\nnew');
  // A file that ends with a newline keeps it.
  const withNewline = await mergeMarkdown('Intro.\n\nold\n', 'Intro.\n\ngit edit\n', 'Intro.\n\nLinear edit');
  assert.equal(withNewline.text, `Intro.\n\n${conflict('git edit', 'Linear edit')}`);
  // Content after the conflict is the merge's own, ending included.
  const after = await mergeMarkdown('old\n\nTail.', 'git edit\n\nTail.', 'Linear edit\n\nTail.');
  assert.equal(after.text, `${conflict('git edit', 'Linear edit')}\nTail.`);
  const afterWithNewline = await mergeMarkdown('old\n\nmid\n\nTail.', 'git edit\n\nmid\n\nTail.', 'Linear edit\n\nmid\n\nTail.\n\nMore.\n');
  assert.ok(afterWithNewline.text.endsWith('Tail.\n\nMore.\n'), JSON.stringify(afterWithNewline.text));
  // CRLF files keep their newline style, and a missing final newline stays missing.
  const crlf = await mergeMarkdown('Intro.\r\n\r\nold', 'Intro.\r\n\r\ngit edit', 'Intro.\n\nLinear edit');
  assert.equal(crlf.text, `Intro.\r\n\r\n${conflict('git edit', 'Linear edit').replace(/\n$/, '').replaceAll('\n', '\r\n')}`);
  // Front matter does not count: the body's ending decides.
  const head = '---\nowner: a\n---\n\n';
  const withHead = await mergeMarkdown('old', `${head}git edit`, 'Linear edit');
  assert.equal(withHead.text, `${head}${conflict('git edit', 'Linear edit').replace(/\n$/, '')}`);
  // With no git body, Linear's text decides.
  const noGit = await mergeMarkdown('old', '', 'Linear edit');
  assert.equal(noGit.conflicts.length, 1);
  assert.ok(!noGit.text.endsWith('\n'), JSON.stringify(noGit.text));
});

test('front matter is merged apart from the body: either side\'s change is kept, overlapping changes keep git\'s', async () => {
  const file = (head: string, body: string) => `---\n${head}---\n\n${body}`;
  const head = (owner: string, team: string) => `owner: ${owner}\nstatus: open\nteam: ${team}\n`;
  const base = file(head('a', 'x'), 'first\n');
  // Only the Linear side changed its front matter (a sync-branch edit merged as the Linear side).
  const theirsOnly = await mergeMarkdown(base, file(head('a', 'x'), 'git\n'), file(head('b', 'x'), 'linear\n'));
  assert.ok(theirsOnly.text.startsWith(file(head('b', 'x'), '')), theirsOnly.text);
  assert.equal(theirsOnly.conflicts.length, 1);
  // Both changed lines apart: both kept.
  const both = await mergeMarkdown(base, file(head('a', 'y'), 'git\n'), file(head('b', 'x'), 'linear\n'));
  assert.ok(both.text.startsWith(file(head('b', 'y'), '')), both.text);
  // Both changed the same line: git's front matter.
  const overlap = await mergeMarkdown(base, file(head('c', 'x'), 'git\n'), file(head('b', 'x'), 'linear\n'));
  assert.ok(overlap.text.startsWith(file(head('c', 'x'), '')), overlap.text);
  // A removal on the other side (a person's on the sync branch) is kept.
  const removed = await mergeMarkdown(base, file(head('a', 'x'), 'git\n'), 'linear\n');
  assert.ok(removed.text.startsWith(MARKERS.git), removed.text);
  // A document Linear added has no front matter, and the git side's added one stays.
  const added = await mergeMarkdown('', file(head('a', 'x'), 'git\n'), 'linear\n');
  assert.ok(added.text.startsWith(file(head('a', 'x'), '')), added.text);
});

test('L3-02: both versions of a paragraph appear between marker paragraphs', async () => {
  const result = await mergeMarkdown('old\n', 'git edit\n', 'Linear edit\n');
  assert.equal(result.text, conflict('git edit', 'Linear edit'));
  assert.deepEqual(result.conflicts, [{ startLine: 1, endLine: 9, git: 'git edit', linear: 'Linear edit' }]);
});

for (const [scenario, block] of [
  ['L3-03 table', '| Item | Value |\n| --- | --- |\n| A | old |\n| B | stable |'],
  ['L3-04 code', '```ts\nconst oldValue = 1;\nconst stable = 2;\n```'],
  ['L3-05 ordered list', '1. old\n2. stable\n3. final'],
  ['L3-05 nested bullets', '- parent\n  - old\n  - stable\n- final'],
  ['L3-07 Mermaid', '```mermaid\ngraph TD\n  old --> B\n  B --> C\n```'],
] as const) {
  test(`${scenario}: widen the conflict to the entire block`, async () => {
    const base = `before\n\n${block}\n\nafter\n`;
    const ours = base.replace('old', 'git');
    const theirs = base.replace('old', 'Linear');
    const result = await mergeMarkdown(base, ours, theirs);
    assert.equal(result.text, `before\n\n${conflict(block.replace('old', 'git'), block.replace('old', 'Linear'))}\nafter\n`);
    assert.equal(result.conflicts.length, 1);
  });
}

test('L3-06: a flat bullet conflict remains line based', async () => {
  const base = '- first\n- old\n- last\n';
  const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, `- first\n\n${conflict('- git', '- Linear')}\n- last\n`);
});

test('L3-08: adjacent changed lines follow git merge-file conflict boundaries', async () => {
  const result = await mergeMarkdown('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n');
  assert.equal(result.text, `${conflict('A\nb', 'a\nB')}\nc\n`);
});

test('L3-12: a repeated conflict replaces the enclosing markers', async () => {
  const base = conflict('old git', 'old Linear');
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.equal(result.conflicts.length, 1);
  for (const marker of Object.values(MARKERS)) assert.equal(result.text.split(marker).length - 1, 1);
  assert.ok(result.text.includes('new git'));
  assert.ok(result.text.includes('new Linear'));
  assert.ok(result.text.includes('old Linear'));
});

test('existing conflicts and one-sided edits are preserved', async () => {
  const base = conflict('old git', 'old Linear');
  const ours = base.replace('old git', 'new git');
  const result = await mergeMarkdown(base, ours, base);
  assert.equal(result.text, ours);
  assert.equal(result.conflicts.length, 1);
});

test('L3-22: code, quotes, inline code, escaped and near markers are ordinary text', () => {
  for (const marker of Object.values(MARKERS)) {
    for (const text of [`\`${marker}\`\n`, `> ${marker}\n`, `    ${marker}\n`, `~~~\n${marker}\n~~~\n`, `\\${marker}\n`, `${marker} extra\n`]) {
      assert.deepEqual(detectConflicts(text), [], text);
    }
  }
  assert.equal(detectConflicts(`${MARKERS.end}\n`).length, 1, 'partial removal stays in conflict');
});

test('L3-22: fixture marker lookalikes do not become conflicts', async () => {
  const dir = new URL('../../test/fixtures/conflict-markers/', import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md') && !name.startsWith('sync-markers-'));
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.deepEqual(detectConflicts(await readFile(new URL(name, dir), 'utf8')), [], name);
  }
});

test('clean edits within one structured block still merge line by line', async () => {
  const base = '```\na\nb\nc\nd\ne\n```\n';
  const result = await mergeMarkdown(base, base.replace('a\n', 'A\n'), base.replace('e\n', 'E\n'));
  assert.equal(result.text, base.replace('a\n', 'A\n').replace('e\n', 'E\n'));
});

test('two hunks inside one fence produce one complete conflict', async () => {
  const base = '```\na\nb\nc\nd\ne\n```\n';
  const ours = base.replace('a\n', 'A\n').replace('e\n', 'E\n');
  const theirs = base.replace('a\n', 'AA\n').replace('e\n', 'EE\n');
  const result = await mergeMarkdown(base, ours, theirs);
  assert.equal(result.text, conflict(ours.trimEnd(), theirs.trimEnd()));
});

test('clean files preserve empty text and missing final newlines', async () => {
  for (const text of ['', 'paragraph', 'paragraph\n', 'a\r\nb\r\n']) {
    assert.deepEqual(await mergeMarkdown(text, text, text), { text, conflicts: [] });
  }
});

test('partial marker removal remains a conflict until every marker is gone', () => {
  for (let mask = 0; mask < 8; mask++) {
    let text = conflict('git', 'Linear');
    Object.values(MARKERS).forEach((marker, i) => {
      if (mask & (1 << i)) text = text.replace(`${marker}\n`, '');
    });
    assert.equal(detectConflicts(text).length > 0, mask !== 7);
  }
});

test('existing marker fixtures are detected as one complete conflict', async () => {
  const dir = new URL('../../test/fixtures/conflict-markers/', import.meta.url);
  for (const name of (await readdir(dir)).filter((name) => name.startsWith('sync-markers-') && name.endsWith('.md'))) {
    const found = detectConflicts(await readFile(new URL(name, dir), 'utf8'));
    assert.equal(found.length, 1, name);
    assert.equal(typeof found[0]?.git, 'string', name);
    assert.equal(typeof found[0]?.linear, 'string', name);
  }
});

test('separate conflicts keep clean text between them and report source lines', async () => {
  const between = '\nstable one\n\nstable two\n\nstable three\n\n';
  const base = `old one\n${between}old two\n`;
  const result = await mergeMarkdown(base, base.replaceAll('old', 'git'), base.replaceAll('old', 'Linear'));
  assert.equal(result.text, `${conflict('git one', 'Linear one')}${between}${conflict('git two', 'Linear two')}`);
  assert.equal(result.conflicts.length, 2);
  assert.equal(result.conflicts[1]?.startLine, 17);
});

test('new markers do not remove literal marker examples inside a conflicted fence', async () => {
  const base = `~~~md\n${MARKERS.git}\nold\n~~~\n`;
  const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, conflict(base.replace('old', 'git').trimEnd(), base.replace('old', 'Linear').trimEnd()));
  assert.equal(result.conflicts.length, 1);
});

test('literal git marker delimiters are preserved during merging', async () => {
  const base = '<<<<<<< git\n=======\n>>>>>>> linear\n\nold\n';
  const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, base.replace('old\n', conflict('git', 'Linear')));
});

test('a one-sided resolution removes conflict state', async () => {
  const base = conflict('git', 'Linear');
  const result = await mergeMarkdown(base, 'resolved\n', base);
  assert.deepEqual(result, { text: 'resolved\n', conflicts: [] });
});

test('clean front matter changes survive a body conflict', async () => {
  const base = '---\ntitle: Before\n---\n\nold\n';
  const result = await mergeMarkdown(base, base.replace('Before', 'After').replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, `---\ntitle: After\n---\n\n${conflict('git', 'Linear')}`);
});

test('unclosed fences at EOF are complete before marker separators', async () => {
  for (const fence of ['~~~', '```md']) {
    const base = `${fence}\nold\n`;
    const close = fence.startsWith('~') ? '~~~' : '```';
    const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
    assert.equal(result.text, conflict(`${fence}\ngit\n${close}`, `${fence}\nLinear\n${close}`));
    assert.equal(result.conflicts.length, 1);
  }
});

test('conflicts preserve literal marker lines in lazy blockquote continuations', async () => {
  const base = `> example\n${MARKERS.git}\nold\n`;
  const ours = base.replace('old', 'git');
  const theirs = base.replace(MARKERS.git, MARKERS.linear);
  for (const text of [base, ours, theirs]) assert.deepEqual(detectConflicts(text), []);
  const result = await mergeMarkdown(base, ours, theirs);
  assert.equal(result.text, conflict(ours.trimEnd(), theirs.trimEnd()));
  assert.equal(result.conflicts.length, 1);
});

test('multiline inline code remains literal inside both versions', async () => {
  const base = '`first\nold\nlast`\n';
  const ours = base.replace('old', 'git');
  const theirs = base.replace('old', 'Linear');
  const result = await mergeMarkdown(base, ours, theirs);
  assert.equal(result.text, conflict(ours.trimEnd(), theirs.trimEnd()));
  assert.equal(result.conflicts.length, 1);
});

test('conflicts in HTML comments are framed outside the complete comment', async () => {
  const base = '<!--\nold\n-->\n';
  const ours = base.replace('old', 'git');
  const theirs = base.replace('old', 'Linear');
  const result = await mergeMarkdown(base, ours, theirs);
  assert.equal(result.text, conflict(ours.trimEnd(), theirs.trimEnd()));
  assert.equal(result.conflicts.length, 1);
});

test('Git owns front matter; Linear snapshot metadata is kept out of the body merge', async () => {
  const base = '---\ntitle: Before\n---\n\nbody\n';
  const ours = base.replace('Before', 'After');
  const theirs = base.replace('Before', 'Other').replace('body', 'updated');
  assert.deepEqual(await mergeMarkdown(base, ours, theirs), { text: ours.replace('body', 'updated'), conflicts: [] });
});

for (const [name, block] of [
  ['quoted fence', '> ```\n> old\n> ```'],
  ['fence in a wide ordered list', '10. step\n\n    ```\n    old\n    ```'],
  ['setext heading', 'old\n========'],
] as const) {
  test(`${name} keeps complete syntax without added fences`, async () => {
    const result = await mergeMarkdown(`${block}\n`, `${block.replace('old', 'git')}\n`, `${block.replace('old', 'Linear')}\n`);
    assert.equal(result.text, conflict(block.replace('old', 'git'), block.replace('old', 'Linear')));
  });
}

for (const [open, close] of [['<!--', '-->'], ['<pre>', '</pre>'], ['<script>', '</script>'], ['<?', '?>'], ['<![CDATA[', ']]>']] as const) {
  test(`EOF-terminated ${open} cannot swallow conflict framing`, async () => {
    const result = await mergeMarkdown('old\n', `${open} draft\n`, 'Linear\n');
    assert.equal(result.text, conflict(`${open} draft\n${close}`, 'Linear'));
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.linear, 'Linear');
  });
}

for (const [name, block, added] of [
  ['a longer closing fence with trailing spaces', '```\ndraft\n`````  ', ''],
  ['a quoted tilde fence', '> ~~~\n> draft\n> ~~~', ''],
  ['a shorter closing fence', '````\ndraft\n```', '\n````'],
  ['a fence of the other character', '```\ndraft\n~~~', '\n```'],
  ['a closing fence with text after it', '```\ndraft\n``` x', '\n```'],
] as const) {
  test(`EOF-terminated code: ${name}`, async () => {
    const result = await mergeMarkdown('old\n', `${block}\n`, 'Linear\n');
    assert.equal(result.text, conflict(`${block}${added}`, 'Linear'));
  });
}

test('a comment that ends with --!> stays open to the parser and is closed before the framing', async () => {
  const result = await mergeMarkdown('old\n', '<!-- draft --!>\n', 'Linear\n');
  assert.equal(result.text, conflict('<!-- draft --!>\n-->', 'Linear'));
  assert.equal(result.conflicts.length, 1);
});

test('a <pre> block the parser already ended gets no second end tag', async () => {
  // CommonMark ends a <pre> block at any of </pre>, </script>, </style> or </textarea>.
  const result = await mergeMarkdown('old\n', '<pre>\ndraft </script>\n', 'Linear\n');
  assert.equal(result.text, conflict('<pre>\ndraft </script>', 'Linear'));
});

test('a quote prefix does not close a quoted <!DOCTYPE block', async () => {
  const result = await mergeMarkdown('old\n', '> <!DOCTYPE html\n> draft\n', 'Linear\n');
  assert.equal(result.text, conflict('> <!DOCTYPE html\n> draft\n> >', 'Linear'));
});

test('a closed comment gets no extra end', async () => {
  const result = await mergeMarkdown('old\n', '<!-- a -->\n', 'Linear\n');
  assert.equal(result.text, conflict('<!-- a -->', 'Linear'));
});

test('conflicting CRLF text keeps CRLF without extra blank lines', async () => {
  const base = 'intro\r\n\r\nold\r\n';
  const result = await mergeMarkdown(base, base.replace('old', 'git'), base.replace('old', 'Linear'));
  assert.equal(result.text, `intro\n\n${conflict('git', 'Linear')}`.replaceAll('\n', '\r\n'));
});

test('duplicate middle markers belong to one enclosing conflict region', () => {
  const text = `${MARKERS.git}\na\n${MARKERS.linear}\nb\n${MARKERS.linear}\nc\n${MARKERS.end}\n`;
  const found = detectConflicts(text);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.endLine, 7);
});

test('repeated conflicts do not accumulate blank marker separators', async () => {
  const base = conflict('old git', 'old Linear');
  const result = await mergeMarkdown(base, base.replace('old git', 'new git'), base.replace('old git', 'new Linear'));
  assert.ok(!result.text.includes('\n\n\n'));
});

test('long literal separators cannot collide with Git framing', async () => {
  const prefix = `separator\n${'='.repeat(5000)}\n\n`;
  const result = await mergeMarkdown(`${prefix}old\n`, `${prefix}git\n`, `${prefix}Linear\n`);
  assert.equal(result.text, prefix + conflict('git', 'Linear'));
});

test('CRLF Git snapshots merge cleanly with LF Linear edits', async () => {
  const result = await mergeMarkdown('first\r\n\r\nsecond\r\n', 'updated\r\n\r\nsecond\r\n', 'first\n\nrevised\n');
  assert.deepEqual(result, { text: 'updated\r\n\r\nrevised\r\n', conflicts: [] });
});

test('mixed newline styles do not widen a paragraph conflict to the document', async () => {
  const result = await mergeMarkdown('intro\r\n\r\nold\r\n\r\nafter\r\n', 'intro\r\n\r\ngit\r\n\r\nafter\r\n', 'intro\n\nLinear\n\nafter\n');
  assert.equal(result.text, `intro\n\n${conflict('git', 'Linear')}\nafter\n`.replaceAll('\n', '\r\n'));
  assert.equal(result.conflicts.length, 1);
});

test('BOM-prefixed marker lines keep their source positions', () => {
  assert.deepEqual(detectConflicts(`\uFEFF${MARKERS.git}\n`), [{ startLine: 1, endLine: 1 }]);
  assert.deepEqual(detectConflicts(`\uFEFF${conflict('git', 'Linear')}`), [{ startLine: 1, endLine: 9, git: 'git', linear: 'Linear' }]);
  const file = `\uFEFF---\ntitle: Sample\n---\n\n${conflict('git', 'Linear')}`;
  assert.equal(detectConflicts(file)[0]?.startLine, 5);
  assert.deepEqual(detectConflicts(`\uFEFF~~~\n${MARKERS.git}\n~~~\n`), []);
});

test('a new conflict at the beginning of a BOM-prefixed file is detected', async () => {
  const result = await mergeMarkdown('\uFEFFold\n', '\uFEFFgit\n', 'Linear\n');
  assert.equal(result.text, `\uFEFF${conflict('git', 'Linear')}`);
  assert.deepEqual(result.conflicts, [{ startLine: 1, endLine: 9, git: 'git', linear: 'Linear' }]);
});
