# Markdown in Linear's form: `lint` and `fix`

Linear stores documents in its own Markdown form and rewrites what it
receives: list bullets, emphasis markers, link destinations, tables and
more. When git holds a different but equivalent form, every sync would
rewrite whole documents, and git and Linear could keep reformatting each
other. Some constructs Linear does not rewrite but loses: a footnote, a link
title, a table's column alignment.

mdbisync keeps the synchronized branch in Linear's form:

- `fix` rewrites a file into the form Linear stores, so a round trip through
  Linear changes nothing;
- `lint` reports what Linear would lose or alter, and files that are not yet
  in Linear's form;
- neither of them rewrites a construct Linear would lose. A file with such a
  construct is left exactly as it is, and you decide what to keep.

The sync itself compares a document with its file by what the Markdown
says, not by its bytes. When Linear returns a document in a spelling of its
own that reads as the same Markdown (a final newline, a backslash before a
`-` that opens a table cell, `*` for `_`), the file keeps its text: no
change is recorded and no sync pull request is opened for it.

Text the sync takes from Linear goes through `fix` before the sync commits
it, so the `linear-format` hook finds nothing to change in it. Linear's own
text is not always in that form: it can store a table cell with a trailing
space (`| a  |`), which `fix` writes as `| a |`. The sync takes only such
re-spellings: a text that `fix` would change into another document (a
setext heading's two lines written as one) stays as Linear has it. A file
whose text Linear only re-spells keeps its own text, and a text with a lint
finding that `fix` leaves to the author stays as it is, as with `fix`
itself.

`fix` runs as the `linear-format` pre-commit hook, which every
synchronized repository needs, and `lint` as the optional
`linear-format-check` hook (see [Install the hook](#install-the-hook)).

The rules come from experiment, not documentation: every fixture of the test
bank (`test/fixtures/`) was written to Linear and read back, and the
recorded forms are the tests of `lint` and `fix` (`test/probe/README.md`).

## Commands

```sh
mdbisync lint [path ...]
mdbisync fix [path ...]
```

A path is a file or a folder; a folder is searched for `.md` files, skipping
`.git` and `node_modules` and not following symbolic links. A path that is a
symbolic link, or whose folders pass through one or differ in case from the
names on disk, is refused, so `fix` never rewrites a file outside the given
tree. Without a path, the current folder is searched.

| Exit code | `lint` | `fix` |
| --- | --- | --- |
| 0 | every file is in Linear's form and has no finding | nothing changed and nothing was found |
| 1 | a finding, or a file `fix` would change | a file changed, or a finding `fix` leaves to you |
| 2 | an unknown option, a path that does not exist, or a path refused for a symbolic link or its case | the same |

Each finding is one line, `file:line: rule: message`, with the line counted
from the top of the file, front matter included:

```text
notes/plan.md:12: footnote: Footnotes are dropped.
notes/setup.md: not in Linear's form; run fix
```

Control characters in a printed file name, line breaks and tabs included, and
backslashes are written as `\uXXXX` escapes, so every finding stays on one
line. When a file
is replaced or turned into a symbolic link while `fix` runs, `fix` leaves it
alone and prints `file: moved while fix ran; left unchanged`.

What both commands leave alone:

- **YAML front matter**, between `---` lines at the top of the file. It never
  goes to Linear, so it is kept byte for byte, together with a byte order
  mark and the blank lines after it. Other front matter, such as TOML
  between `+++` lines, is not recognized: it is Markdown body like the rest.
- **Relative image and file paths.** The sync uploads the files and maps the
  paths; `fix` keeps the path as written, only encoding characters such as
  spaces. Every image must be such a path to a file of the repository (see
  [`image-not-in-repository`](#image-not-in-repository)); links to web
  pages and other URLs are fine. In Linear, a link typed as a relative
  path to a file other than a Markdown document is blocked (`image-blocked`):
  the sync would upload the file
  it names, so only the repository chooses which files reach Linear. A
  link the file already had stays allowed.
- **The sync's conflict markers.** A conflict the sync writes is three
  one-line warning callouts (`> **Sync conflict: git version**` and so on,
  each with Linear's color comment above it) around the two versions as
  ordinary text, and passes both commands unchanged, as do the bold marker
  paragraphs earlier versions wrote ([conflicts](conflicts.md) shows them
  and how to resolve them). Git's own conflict markers do not: see
  [`git-conflict-marker`](#git-conflict-marker).
- **Constructs Linear keeps as they are**, though it may show some as plain
  text: raw HTML without URLs, HTML comments, `<details>`, `<u>`, `<sub>`,
  `==highlight==`, `^superscript^`, definition lists, `> [!NOTE]` alerts,
  Mermaid and other code fences, two-space line breaks, and escapes that
  matter (`\*`, `\[`).
  [How documents look in Linear](#how-documents-look-in-linear) shows
  how Linear's editor displays some of them: alerts as callouts, Mermaid
  as diagrams, `<details>` as literal text.

## What `fix` changes

`fix` writes the block structure the way Linear writes it, and copies inline
text from the file with a few targeted rewrites. A second run changes
nothing.

Blocks:

- Line endings become LF, extra blank lines between blocks collapse to one,
  and the final line break goes. A document that ends with a table, also
  one at the end of a quote or list item, keeps one final line break, as
  Linear writes it.
- Setext headings (text underlined with `===` or `---`) become `#`
  headings, and closing hashes go: `## Summary ##` becomes `## Summary`.
- Thematic breaks become `---`: `***` becomes `---`.
- Bullets become `*`: `- item` becomes `* item`.
- Loose lists become tight: the blank lines between items go, and a nested
  list follows its paragraph on the next line.
- Ordered lists use dots and count up from their start: `1) a` becomes
  `1. a`. Numbers are right-aligned to the widest one, and every item's
  content lines up past it: in a list of ten items, the first is written
  ` 1. a` above `10. j`.
- An empty item keeps a space after its marker: `*` becomes `* `.
- Task items use `-` and an uppercase `X`: `* [x] done` becomes
  `- [X] done`. A checkbox without a label keeps one space after it.
- A paragraph's text that starts like a list marker gets its marker
  escaped, so it stays text: in `Note` followed by `1. 3. plum`, the
  `3. plum` is text, and with the blank line `fix` writes before the list it
  becomes `1. 3\. plum`. Text split off at an image gets the same escape.
  A literal number followed by a dot and whitespace also gets its dot
  escaped when it starts a paragraph line. A tab or nonbreaking space
  immediately after that dot becomes a space.
  Linear keeps such text but can return `4\) pear` and a lone `\+` without
  their escapes. The sync restores an escape where the text would read as
  a block. A lone `+` on a paragraph continuation line stays plain.
- A line that opens with three or more `>` signs is a collapsible section
  in Linear, not a nested quote, and `fix` writes it as Linear does: the
  rest of the line becomes the title of a `+++` line, and the section holds
  the blocks after it up to a `>>>` line without a title, or else to the
  end of the document, list item or quote it is in. A `+++` line closes it
  there. A line `>>> Plans` followed by `Some text` is written as three
  blocks, one blank line apart: `+++ Plans`, `Some text` and `+++`. A
  `>>>` line without a title closes every section still open there; with
  none open, it opens one without a title (`+++` and a space). With spaces
  between the signs (`> > >`), or when the first sign continues a quote
  above, it stays a quote. A file that also has a `+++` line is left to
  you, since Linear would pair that line with the section.
- A bare `+++` opens an untitled section when it has a body or a closing
  marker and there is no section open in the same document, list item or
  quote. `fix` writes that opener with one trailing space, as Linear does.
  A bare marker inside a section closes the innermost section and is written
  without trailing whitespace. A final bare marker with no section to close
  stays plain text. A blank line after an unpaired opener at the start of a
  list item or quote distinguishes it from a continued paragraph.
- Lazy quote lines get their `>`. A blank line between blocks in a quote
  is a bare `>`; a blank line inside a code block in a quote keeps the
  space (`> `), as Linear writes it. A lazy line of only `-` or `=` in a
  quote or list item gets its `>` or indent and a backslash, as Linear
  writes it (`> \--`), so it stays text and does not turn the line above
  into a heading. In a link label or an image's alt text that runs over
  lines, it is indented four spaces after its `>` or indent instead. Inside
  a code span it joins the line above, like every line of a code span.
- Linear's color comment of a callout (`<!-- linear:callout color=... -->`)
  stays directly above its callout, with no blank line between them.
- Tilde fences and indented code become backtick fences. A fence whose info
  string holds a backtick stays a tilde fence, since a backtick fence cannot
  carry one.
- A code block outside a quote or list item loses the blank lines before
  its closing fence. Linear returns such a block with one of them fewer
  each time it is written, so only a block without them comes back
  unchanged. In a quote or list item the blank lines stay; in a list item
  a blank line inside a code block keeps the item's indentation, as Linear
  writes it.
- `$$` math becomes a `math` fence.
- Tables get outer pipes and short separators (`| -- | -- |`), and a row
  gets as many cells as the header. A cell containing only `#` is written
  as `\#`, preserving its text, and an escaped `#` that starts a cell keeps
  its escape (a bare one in a body cell is the
  [`table-hash-cell`](#table-hash-cell) rule). A line break tag in a cell
  (`<br>`, `<br/>`, `<br />`) is written as `&#10;`, as Linear writes it.
  Linear shows it as a line break; GitHub shows it as a space. A body cell
  keeps a nonbreaking space around its text; a header cell loses it, as
  Linear writes them.
- An image does not share a paragraph with text: the text before and after
  it becomes its own paragraph. Where that text would start another block,
  a backslash escape keeps it text: in
  `Before ![a](x.png) # x`, the text after the image is written as `\# x`.
  The same holds for a quote, rule, list marker, code fence, HTML tag,
  `[label]:` definition, `$$` or `+++` line, Git conflict marker, a `===`
  or `---` underline and a table's delimiter row. Linear drops some of
  these escapes from its export. A pull puts the escapes back for literal
  block starts. When a table or collapsible section exports the same Markdown
  as paragraph text, the sync uses the accepted file's escapes to tell them
  apart. A new document with the canonical block spelling keeps that block.
- A list item holding only a link to a relative file other than Markdown
  takes the form Linear uses for the uploaded file. A video (`.mp4`,
  `.mov`, `.webm`) in a bullet item stays on the marker's line without
  angle brackets. MP3 links in bullet and numbered items and WAV and Ogg
  links in bullet items stay on the marker's line with angle brackets,
  as in `* [Name](<path>)`. An MP3 link in a task item goes on the
  continuation line after the checkbox. The WAV and Ogg forms for numbered
  and task items are unconfirmed. Where the formatter uses a file block,
  the marker stands on its own line and the link goes below it. When the link
  does not name a file in the repository (the file is missing, the path is
  a folder, starts with `/` or leads outside the repository), the sync
  cannot upload it and Linear keeps a plain link, so `fix` writes
  `* [Name](<path>)`. `fix` resolves links from
  the folder it runs in, which for the hook is the repository's top
  folder. If `fix` uses a file block for a repository file that the sync
  did not upload, Git keeps the hook's file block and the sync sends
  Linear the plain link `* [Name](<path>)`.

Inline text:

- Underscore emphasis becomes asterisks: `__bold__ and _em_` becomes
  `**bold** and *em*`.
- Asterisks that read as text are escaped. `**Birch****Pine**` becomes
  `**Birch\*\*\*\*Pine**`, and `**Inventory` becomes `\*\*Inventory`.
  Consecutive bold spans join when they can keep their formatting.
  Bold immediately inside another bold span is folded into the outer span.
- Adjacent links to the same destination become one link, since Linear
  holds a link as a mark on its text. Bold, italic or strikethrough around
  a part goes inside the label: `[Shop](https://a.test)**[Sale](https://a.test)**`
  becomes `[Shop**Sale**](<https://a.test>)`. A space, a line ending or
  another destination keeps links apart, and so does a `!` before them.
- Bold around a single link moves into the link label. For example,
  `**[Map](https://example.com)**` becomes `[**Map**](<https://example.com>)`.
  When bold spans multiple lines, `fix` closes it and reopens it on each line.
- Link destinations go in angle brackets: `[a](https://example.com/x)`
  becomes `[a](<https://example.com/x>)`. A backslash, `|`, `^`, `{` and
  `}` in a destination are percent-encoded, as Linear writes them:
  `[a](https://example.com/a\b)` becomes
  `[a](<https://example.com/a%5Cb>)`. So are characters outside ASCII, as
  UTF-8: `[a](https://example.com/café)` becomes
  `[a](<https://example.com/caf%C3%A9>)`, and such a host is written in its
  ASCII form (for `café.example`, `xn--caf-dma.example`). The link text
  stays as written. A `%` that starts no escape becomes
  `%25`. In a relative path that is not valid percent-encoding, every `%` is
  written `%25`, so the link still names the same file.
- A code span that runs over lines is written on one line, as Linear
  writes it: each line ending becomes a space, and the next line's
  indentation past its quote or list prefix stays code text (a tab the prefix
  takes in part leaves its other columns as spaces). `` `make `` on
  one line and `` all` `` on the next becomes `` `make all` ``. A code span
  in an image's alt text keeps its lines, and so does one whose joined line
  would hold a `|`, which could make it a table's head row.
- Reference links and images are written inline, and their definitions go.
- Literal square brackets in text are escaped, including those written as
  character references. For example, `# [Shelf] Inventory` becomes
  `# \[Shelf\] Inventory`. Linear callout markers such as `> [!TIP]` keep
  their brackets. A titled or folded Obsidian callout becomes an ordinary quote.
- Autolinks and bare URLs become links: `See https://example.com now.`
  becomes `See [https://example.com](<https://example.com>) now.` The link
  text reads exactly as the URL: backslashes are doubled, and characters
  that would be markup there are escaped:
  `https://example.com/a~b~c` becomes
  `[https://example.com/a\~b\~c](<https://example.com/a~b~c>)`.
  So do web addresses Markdown finds inside other text, where the bare URL
  rule does not apply: `Site: "www.example.com"` becomes
  `Site: "[www.example.com](<http://www.example.com>)"`.
  In a URL label, underscores between ASCII letters, digits or underscores
  stay plain, as in
  `[https://example.com/shelf_4](<https://example.com/shelf_4>)`.
- Bare addresses with recognized domain suffixes become HTTP links.
  `example.com/guide` becomes `[example.com/guide](<http://example.com/guide>)`.
  Relative paths, standalone Markdown filenames, and suffixes such as
  `.test` stay as text.
- Character references to characters outside ASCII become the characters,
  and so does `&amp;` unless a reference follows it:
  `Fish &amp; chips &mdash; &copy;` becomes `Fish & chips — ©`.
  `&nbsp;` becomes the nonbreaking space Linear stores for it. Next to `*`,
  `_` or `~`, a reference stays when its character would change what they
  mark. A nonbreaking space at the end of a heading stays, as Linear keeps
  it; spaces and tabs there go.
  Asterisk references such as `&#42;` become `\*`. Other ASCII references,
  such as `&lt;b&gt;`, `&quot;` and `&#65;`, stay as written.
- A space reference (`&#32;`, `&#x20;`) becomes a space, as Linear stores
  it; in a link label too. At the inner edge of bold, italic or
  strikethrough the space moves out of it: `x **&#32;Tip** y` becomes
  `x  **Tip** y`. At the start or end of a paragraph, heading, item, quote
  or cell the space goes, since Linear drops it on its next write:
  `**&#32;Tip** one` becomes `**Tip** one`. Where a space would change
  what the text says (make a line break, a list item or HTML, or close a
  heading), the reference stays.
- Emoji shortcodes Linear knows become emoji: `Done :tada:` becomes
  `Done 🎉`. An escaped reference or shortcode (`\&amp;`, `\:tada:`) stays
  as written.
- A backslash before anything but ASCII punctuation (a letter, a digit, a
  space) is a literal backslash, and it is doubled, as Linear doubles it:
  `$\pi$` becomes `$\\pi$`, and `C:\ 2026` becomes `C:\\ 2026`. So is a
  backslash that ends a paragraph, heading or item, where it breaks no
  line: `Path ends in \` becomes `Path ends in \\`.
- Redundant escapes inside a line go. `a \# b` becomes `a # b`, and
  `**\-10**` becomes `**-10**`.
  Text such as `\#tag` and `\+value` loses the escape when it cannot open a block.
  So does a line-start `\=`, except on a line of only `=` that would
  underline the paragraph above, and a `\-` or `\+` on a continuation
  line indented four or more columns past its list item or quote (`\-x`
  after any indentation).
  Escapes that keep text from becoming Markdown syntax or an emoji stay.
- A backslash line break (`\` at the end of a line) loses its backslash,
  as Linear writes it; spaces or a tab before it stay. Linear holds every
  line ending of a paragraph as a line break, so the break stays one there
  (see [`hard-break-backslash`](#hard-break-backslash)). A break written
  with two or more trailing spaces stays as it is.
- A `-` or `*` that starts a line of a paragraph as text gets a backslash,
  as Linear writes it: `-- a remark` becomes `\-- a remark`, and `*note`
  becomes `\*note`. After a continuation line's own indentation only the
  `*` gets one, and so does a `#` that would start a heading there: a
  continuation line `    # note` is written `    \# note`, and so is a
  `#` before a no-break space.
- A literal `~` gets a backslash, as Linear writes it: `~$5` becomes
  `\~$5`. So does a literal `_`, unless the characters on both sides of it
  are ASCII letters, digits or `_`: `snake_case` and `a__b` stay, while
  `_note` becomes `\_note`, `value__ end` becomes `value_\_ end`, and
  `é_é` becomes `é\_é`. An escape the rule does not need goes:
  `file\_name` becomes `file_name`. Link text follows the same rule;
  strikethrough and code keep their characters.
- A backtick that opens no code span gets a backslash, as Linear writes it:
  ``a ` b`` becomes ``a \` b``.
- A continuation line of a paragraph keeps its own indentation, as Linear
  does: the quote's `>` or the item's indent is written in place of the
  source's, and spaces or tabs past it stay. A tab that the item's indent
  covers only in part leaves its other columns as spaces: under `* item`, a
  line indented with one tab is written with four spaces.

## How documents look in Linear

A synchronized document is read and edited in Linear's editor. These
observations come from opening the documents of the test bank in that
editor after a sync and reading what it displays. They describe Linear's
display only: the text Linear stores and gives back is what the sections
above describe, so a construct that looks different here still round-trips.

| Construct | What Linear's editor shows |
| --- | --- |
| Headings, `#` and setext | Headings of the same level. |
| Bullet, nested and numbered lists | Lists with their nesting; a numbered list keeps its start number. |
| Task lists | Checkboxes with each item's checked state, also when nested or inside a quote. |
| Quotes | Quotes, including a quote inside a quote and a list inside a quote. |
| Code fence with a language | A code block labelled with that language. |
| Code fence without a language | A code block whose label Linear guesses from the content (one short sample was labelled "CSS"). The stored text has no language. |
| Mermaid fence | The rendered diagram, also several in one document and one inside a list item. A diagram Linear cannot parse shows its source with Linear's parse error. |
| Tables | Tables with all their rows and columns (30 columns checked), bold and strikethrough in cells, and images in cells. |
| Images | The image at its own size, served from Linear's upload storage: PNG, JPEG, animated GIF, WebP, SVG, BMP and ICO, also inside list items and table cells. An empty alt text stays empty. |
| Files (PDF, CSV, JSON, text, ZIP) | A link to the uploaded file; a list of such links shows as file cards with the name and size. |
| Unicode | Chinese, Arabic, emoji with joiners and flags as written; a shortcode Linear knows shows as its emoji. |
| `> [!NOTE]` and other alerts | A callout block. |
| `<details>` | Its HTML as literal text, not a collapsible section. |
| Right-to-left text | Paragraphs laid out left to right (checked with Arabic). |

Images and files show only when the sync could upload them: a document
that links a file over Linear's upload limit or a file the run cannot read
is left out (`upload-too-large`, `upload-unreadable`, see
[files left out](troubleshooting.md#files-left-out)). The sync also leaves
out a document whose image has a title, is not a file of the repository or
names a missing file, until the document or its image is fixed: see
[`image-title`](#image-title),
[`image-not-in-repository`](#image-not-in-repository) and
[`image-file-missing`](#image-file-missing).

## Lint rules

Each rule is a construct Linear would lose or alter, and its message says
what to do. `fix` never rewrites a file with a finding, so nothing is lost
silently; change the file yourself. The one exception is
[`hard-break-backslash`](#hard-break-backslash), which `fix` writes in a
form Linear keeps where it can.

### `footnote`

Footnotes are dropped. Linear keeps the reference as plain text and drops
the note.

```markdown
The plan changed in May.[^1]

[^1]: After the budget review.
```

Instead, put the note in the text, in parentheses or in a section of notes.

### `subscript`

Tilde subscript is dropped. Linear keeps the letters and drops the
subscript.

```markdown
Water is H~2~O.
```

Instead, write `H<sub>2</sub>O` (kept as it is) or plain `H2O`. Double
tildes, `~~strikethrough~~`, are fine.

### `table-escaped-pipe`

An escaped pipe in a plain table cell splits the row. Put the cell text in
inline code, or rephrase it without the pipe. Linear drops the backslash,
and the pipe starts a new cell; in inline code (`` `a \| b` ``) it is kept
as it is.

```markdown
| Expression | Meaning |
| -- | -- |
| a \| b | either |
```

### `table-hash-cell`

A table body cell starting with # becomes a heading. Linear reads heading
syntax at the start of a body cell (`#` to `######`, alone or followed by a
space) as a heading: a lone `#` becomes an empty heading and the cell loses
its text. A header cell, or a `#` later in the cell or not followed by a
space (`Issue #`, `#5`), is not affected.

```markdown
| Name | No. |
| -- | -- |
| Example | # |
```

Instead, escape the first hash as `\#`, which keeps the text.

### `image-in-link`

The link around an image is dropped. A badge or a clickable picture loses
its link.

```markdown
[![Build status](images/build-status.svg)](https://example.com/builds)
```

Instead, put the image and the link side by side or on separate lines.
A badge served from another site is an image outside the repository, which
[`image-not-in-repository`](#image-not-in-repository) reports as well: link
to the page instead.

### `content-too-long`

This document exceeds Linear's 250,000-character content limit. The author
must decide how to shorten or split it. Linear refuses the whole document.
The limit counts Unicode code points of the text after the front matter.
Such a document is not checked further, so `content-too-long` is its only
finding.

`fix` leaves a file already over the limit as it is. A rewrite can take a
file past the limit, for example when `fix` writes a bare URL as a link:
`fix` saves the rewrite and reports `content-too-long`, and `lint` and both
hooks fail on the file until the author shortens or splits it.

```text
A 260 KB log pasted into one Markdown file.
```

Instead, split the file into several documents.

### `markdown-complexity`

Markdown trees over 128 levels deep or 500,000 nodes are rejected, as are
tables whose short rows, padded to the header width, would add over 250,000
characters or take the tree over that node limit, reference links whose
destinations, each written in full, would take the text over 250,000
characters, and paragraphs whose inline syntax, or whose many lines
continued without their quote or list prefix, would take too long to
parse. This keeps traversal and formatting bounded independently of the
text length. `fix` writes every row of a table with as many cells as its
header, the form Linear stores, so a wide header over many short rows grows
far beyond its source. It also writes every reference link (`[text][ref]`)
inline with its own copy of the destination, so many short references to
one long definition grow the same way. The
parser's work on one paragraph, heading or table cell can grow with the
square of its size: many unresolved brackets, escapes or emphasis
markers, an unclosed `[` followed by many words, or tens of thousands of
short lines in one paragraph. The parser counts that work as it reads and
stops at a fixed budget that ordinary documents stay far below; split
such a paragraph with blank lines. The same holds for a paragraph in a
block quote or list item that goes on over thousands of lines without the
quote's `>` or the item's indent (lazy continuation lines): the parser
looks back over the paragraph for each such line, so it counts that work
too. Write the prefix on each line, or split the paragraph.
For example, this generates a document that exceeds the nesting limit:

```javascript
'> '.repeat(130) + 'Nested note.'
```

and this one a table whose padding is too large, from 2.4 KB of text:

```javascript
'|a'.repeat(300) + '|\n' + '|-'.repeat(300) + '|\n' + '|x|\n'.repeat(300)
```

and this one references whose destinations would be written 2,000 times:

```javascript
'[a][r] '.repeat(2000) + '\n\n[r]: https://example.com/' + 'x'.repeat(1000)
```

and this one a paragraph whose unresolved references take too long to parse, from 140 KB of text:

```javascript
'[a][r] '.repeat(20_000)
```

Reduce the nesting, fill in or split the table, write fewer references to a
long destination, split the paragraph, or split the document. `fix` leaves
the text unchanged.
Capture and initial import leave the document out of the current run,
preserve any previously accepted text, and continue with other documents.

### `duplicate-title`

Two or more files map to one document title. Their paths differ only in
letter case or Unicode normalization, and Linear cannot tell them apart.
Every such file is reported. Each finding names up to three of the other
files and counts the rest (`and 5 more`). The rule compares only the files a run is given: a commit hook
sees the staged files, so a new file that collides with one already
committed is reported by `pre-commit run --all-files` (as the CI example
runs it), not at commit time.

```text
guides/Install.md
guides/install.md
```

Instead, rename one of them.

### `table-alignment`

Table column alignment is dropped. Remove the colons from the separator row
to accept that. The separators are then plain: `| -- | -- |`.

```markdown
| Item | Price |
| :-- | --: |
| Tea | 3 |
```

### `link-scheme`

Links must use http, https, mailto, a path or a fragment. Change the
destination, or write the address as inline code. On pull, unsupported
links are removed together with their text.

```markdown
[Unsupported](javascript:alert%281%29)
```

### `link-title`

A link title is dropped. Remove the title, or move its text into the link
text. This holds for an inline link and for a reference definition.

```markdown
See [the guide](https://example.com/guide "Install guide").
```

### `image-title`

An image title is dropped from the Markdown. Remove the title, or move its
text into the alt text.

```markdown
![Logo](logo.png "Company logo")
```

### `code-in-emphasis`

Bold or italic around inline code is dropped from the code. Write the code
without emphasis, or emphasize the words around it. Linear keeps the code
and loses the emphasis around it.

```markdown
Run **`npm test`** first.
```

### `hard-break-backslash`

A backslash line break becomes a plain line break. Run fix to write it as
Linear does; where fix leaves it, put the text on one line or start a new
paragraph. Linear keeps the break but drops the backslash: it holds every
line ending of a paragraph as a line break and writes it as a plain line
ending, which other Markdown renderers join into one line.

```markdown
First line\
Second line
```

`fix` writes this as `First line`, then `Second line` on the next line.
Spaces or a tab before the backslash stay. To keep the break for other
renderers too, end the line with two spaces instead: Linear keeps them.

`fix` leaves the file to you wherever dropping the backslash would change
the document:
in a setext heading, which it writes on one line (see
[`hard-break-in-heading`](#hard-break-in-heading)); where the backslash is
alone on its line, or right after a task checkbox; where the line would
read differently without its backslash (`#\`, `***\`, a `=` or `---`
underline, a table row, emphasis that the backslash lets close); and where
the break sits next to an image, which `fix` moves into a paragraph of its
own. There you can also end the line with two spaces or `<br>` yourself,
if the line still reads as you meant. A hook that trims trailing
whitespace in Markdown files removes those spaces, and with them the
break: exclude Markdown from it (see [Other fixing hooks](#other-fixing-hooks)).

### `hard-break-in-heading`

A hard line break in a setext heading is lost when the heading is written
as one line. Put the heading on one line, or move the text after the break
below it. Below the heading, that text becomes a paragraph.
`lint` reports the break's line and `fix` leaves the file as written.
Each `␠` below represents a trailing space.

```text
Paper lanterns␠␠
Above the gate
==============
```

A backslash break is reported as `hard-break-backslash`.

### `git-conflict-marker`

Git conflict marker lines are rewritten as headings, quotes or collapsible
sections. Resolve the conflict. An unresolved merge would reach Linear
mangled. Marker lines inside code (fences, indented code and inline code)
are text and pass.

```markdown
<<<<<<< ours
The meeting is on Monday.
=======
The meeting is on Tuesday.
>>>>>>> theirs
```

### `section-opener`

A line starting with >>> opens a collapsible section in Linear, which fix
cannot write here: the file also has lines starting with +++, which Linear
pairs with it, or the section would end inside code. Write the section with
+++ lines, or start the line with \>.

Elsewhere `fix` writes a `>>>` line as Linear's section (see
[What `fix` changes](#what-fix-changes)).

```markdown
+++ Earlier notes

Kept from last week.

+++

>>> New notes

Added today.
```

### `url-in-html`

A URL inside raw HTML is turned into a Markdown link. That breaks the HTML:
`src="https://…"` becomes `src="[https://…](<https://…>)"`. The rule covers
any URL and any `src` or `href` attribute in an HTML block or tag.

```markdown
<img src="https://example.com/banner.png" alt="Banner" width="64">
```

Instead, use Markdown with an image file of the repository:
`![Banner](images/banner.png)`.

### `unplaced-link`

A web address Markdown finds inside other text, such as "www.example.com" in
quotes, cannot be matched to its text in the source, for example because an
escape or a character reference spells it, so fix cannot write it as a link.
Write it in angle brackets or as a link. For example,
`<https://www.example.com/a_b>` is a link `fix` writes. Until then, `fix`
leaves the file as it is; the sync sends it unchanged.

```markdown
See "www.example.com/a\_b" for details.
```

### `block-first-in-list-item`

A list item that starts with a heading, code, a quote, a list or another
block is written in a form Markdown reads as an empty item. Start the item
with a line of text and put the block below it. Linear's list items always
start with a paragraph: it adds an empty one and writes the marker, a blank
line and the indented block, so the block falls out of the list. A list
that starts an item (`* * a`, `1. 3. b`) counts too. `fix` cannot choose
the text the item should start with, so it leaves the file to you.

```markdown
* ## Step one
  Install the tools.
```

### `ordered-task-list`

An ordered task list becomes a bullet task list. Use a bullet task list, or
an ordered list without checkboxes. Linear's task lists have no numbers, so
the items lose their order numbers; a task item anywhere in an ordered list
counts.

```markdown
1. [ ] Draft the outline
2. [x] Pick a date
```

### `image-not-in-repository`

An image must be a relative path to a file of the repository, not a URL,
an absolute path or a path outside it. Add the file to the repository and
link it by its relative path. The sync uploads the files a
document's images name; an image anywhere else would depend on the reader's
network and on what Linear does with it. Linear has kept such an image,
copied it to an upload of its own, and, most recently, kept only its alt
text and dropped the image from the text. The rule covers every
image: inline, reference-style and inside a link, with any URL (`https:`,
`data:`), any path that starts with `/` and any path that leaves the
repository. Plain links to URLs are not affected.

```markdown
![Revenue chart](https://example.com/charts/revenue.png)
```

Add the file in the same pull request, for example as
`![Revenue chart](images/revenue.png)`. A file stored with Git LFS counts
like any other.

### `image-file-missing`

An image must name a file that exists in the repository, not a folder or a
Markdown document. The path is resolved from the document's folder. `lint`
and `fix` check that the file is there, as the repository stores it: a
symbolic link does not count, and the case of each name must match. They
take the folder they run in as the repository's top folder, as the hook
does, so run them from there. The sync checks each commit it reads the same
way, the tracked branch and its own record of what Linear was given: a
document whose image is not a file of that commit stays out of Linear,
even when the commit skipped the hook, until the file is committed.
A file that is on disk but not committed passes the hook, so the sync is
where that one is found.

```markdown
![Logo](images/logo.md)
```

Instead, fix the path, or add the missing file in the same change.

### `upload-file-refused`

A file named as the sync names a captured upload fails the upload check:
documents that link it are blocked when they change in Linear. When the
sync captures a file uploaded in Linear, it names it by its content's
SHA-256 and the extension of its type (`<sha256>.png`). A later sync checks
such a file again before a document links it, and a file an earlier, weaker
check admitted, such as an SVG with HTML inside it, no longer passes. `lint`
reports every such file under the paths it checks, so `mdbisync lint` with
no path checks the whole repository; the `linear-format` hooks pass only
Markdown files and do not. Files with other names came through git and are
not checked. The sync never removes or rewrites the file itself.

```text
docs/assets/0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8.svg:1: upload-file-refused: …
```

Instead, remove the file, or replace it with a file the check admits, and
change the documents that link it.

### `document-in-assets-folder`

A Markdown document cannot be inside a folder named assets, which holds the
files documents embed. The sync writes each file it takes from Linear into
an `assets/` folder beside the document that embeds it, and a repository's
`**/assets/**` line in `.gitattributes` can store that whole folder in Git
LFS, so a document there would not stay text. The name is matched exactly:
`Assets` or `old-assets` is an ordinary folder.

```text
guides/assets/notes.md
```

Instead, move the document out of the `assets` folder.

## Install the hook

The repository publishes two pre-commit hooks:

| Hook | Runs | On a file to change |
| --- | --- | --- |
| `linear-format` | `mdbisync fix` | writes the fix and exits 1; a second run passes unless a lint finding is left |
| `linear-format-check` | `mdbisync lint` | reports it without writing |

Both report lint findings with file, line and rule and leave those files
unchanged. Synchronization requires `linear-format`; `linear-format-check`
can follow it as an extra check. The hooks run one formatter process at a
time, and see the files pre-commit selects: use `--all-files` to check the
whole repository, existing files included.

Add the hook to `.pre-commit-config.yaml`, pinned to a release commit (see
[Release builds and pins](usage.md#release-builds-and-pins) for
how to find its SHA):

```yaml
repos:
  - repo: https://github.com/mdbisync/mdbisync
    rev: <release-sha> # <version>
    hooks:
      - id: linear-format
```

Then install it and check the files already in the repository:

```sh
pre-commit install --hook-type pre-commit --hook-type pre-push
pre-commit run --all-files
```

The hooks use Node.js 24.2 or later and npm already on your machine
(`language_version: system`; npm 11.16.0 or newer) and download no
toolchain or packages when they install or run.

### Other fixing hooks

A hook that rewrites the same Markdown in another way fights `fix`, and
the two never settle. The common ones are `end-of-file-fixer`, which adds
back the final line break `fix` removes, and `trailing-whitespace`, which
removes the two spaces of a line break, the indentation `fix` writes on
a blank line inside a code block in a list item, and the space after
`+++` that Linear stores on an untitled section opener. An editor that trims
trailing whitespace on save does the same. Keep them away from
synchronized Markdown files:

```yaml
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: <sha> # v6.0.0
    hooks:
      - id: end-of-file-fixer
        exclude: \.md$
      - id: trailing-whitespace
        exclude: \.md$
```

Otherwise every run changes the files again, and the CI example's check
never passes.

### In CI

Copy [examples/pre-commit.yml](../examples/pre-commit.yml) to
`.github/workflows/pre-commit.yml` in the synchronized repository. On every
pull request it runs the whole pre-commit configuration, commits the fixes
to the pull request branch and runs the checks again, so the branch reaches
`main` in Linear's form. Details:

- The hooks are the pull request's own code, so they run in the
  `pre-commit hooks` job, which can only read the repository and holds no
  write token. A second job, `pre-commit fixes`, pushes the fix on a fresh
  runner: it runs none of the pull request's code and applies the fix only
  when it changes files the branch already tracks as regular files (no new,
  deleted, renamed or linked files, no mode changes), with a commit message
  that keeps only the hook ids. A fix outside those limits fails that job;
  apply it by hand.
- The `pre-commit` job passes only when the hooks passed and their fix, if
  any, passed its final hook check and was pushed: require `pre-commit` in the branch rules.
- A pull request from a fork cannot take a push: the hooks job fails and
  prints a ready-to-apply patch.
- The jobs use the exact head of the pull request; if the branch moves
  before the push, the push fails without overwriting the newer commits.
- It dispatches this workflow again on the fixing commit, so all three
  checks come from real jobs on that head. It creates no check runs itself.
  Dispatch runs only verify the fixed head: if hooks change it again, the
  run fails with a patch instead of pushing or dispatching again. A pull
  request without fixes shows `pre-commit fixes` as skipped.
- Neither job uses a package-manager cache: a cache the hooks job saved
  would reach the job that pushes.
- On self-hosted runners, the jobs are kept apart only when each job gets a
  fresh runner (ephemeral runners); otherwise the hooks can leave files
  behind for the next job on that machine.
- A push with the workflow's token starts no other workflows, so the
  repository's other CI must be started on the fixing commit: give each of
  those workflows a `workflow_dispatch:` trigger and list their files in the
  repository variable `MDBISYNC_CI_WORKFLOWS` (for example
  `tests.yml lint.yml`, separated by spaces or commas). The job starts this
  workflow and the listed ones on the pull request's branch after it pushes a fix. Until those checks pass
  on the fixing commit, the sync does not merge its pull request: it expects
  every check that ran on the pull request's earlier heads
  ([the sync pull request](usage.md#the-sync-pull-request)).

Dispatch runs must enforce the same checks as pull-request runs; do not make
their tests optional through dispatch inputs or event conditions. The sync
counts a check by its name and the GitHub Actions App, whichever event ran
it ([the sync pull request](usage.md#the-sync-pull-request)).
Updating the formatter example requires enabling its `workflow_dispatch`
trigger on the default branch too.
