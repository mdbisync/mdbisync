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

Both run as the `linear-format` pre-commit hook, which every synchronized
repository needs (see [Install the hook](#install-the-hook)).

The rules come from experiment, not documentation: every fixture of the test
bank (`test/fixtures/`) was written to Linear and read back, and the
recorded forms are the tests of `lint` and `fix` (`test/probe/README.md`).

## Commands

```sh
mdbisync lint [path ...]
mdbisync fix [path ...]
```

A path is a file or a folder; a folder is searched for `.md` files, skipping
`.git` and `node_modules` and not following symbolic links. Without a path,
the current folder is searched.

| Exit code | `lint` | `fix` |
| --- | --- | --- |
| 0 | every file is in Linear's form and has no finding | nothing changed and nothing was found |
| 1 | a finding, or a file `fix` would change | a file changed, or a finding `fix` leaves to you |
| 2 | an unknown option or a path that does not exist | the same |

Each finding is one line, `file:line: rule: message`, with the line counted
from the top of the file, front matter included:

```text
notes/plan.md:12: footnote: Footnotes are dropped.
notes/setup.md: not in Linear's form; run fix
```

What both commands leave alone:

- **YAML front matter**, between `---` lines at the top of the file. It never
  goes to Linear, so it is kept byte for byte, together with a byte order
  mark and the blank lines after it. Other front matter, such as TOML
  between `+++` lines, is not recognized: it is Markdown body like the rest.
- **Relative image and file paths.** The sync uploads the files and maps the
  paths; `fix` keeps the path as written, only encoding characters such as
  spaces.
- **The sync's conflict markers.** A conflict the sync writes is ordinary
  bold paragraphs (`**Sync conflict: git version**` and so on) and passes
  both commands unchanged. Git's own conflict markers do not: see
  [`git-conflict-marker`](#git-conflict-marker).
- **Constructs Linear keeps as they are**, though it may show some as plain
  text: raw HTML without URLs, HTML comments, `<details>`, `<u>`, `<sub>`,
  `==highlight==`, `^superscript^`, definition lists, `> [!NOTE]` alerts,
  Mermaid and other code fences, two-space line breaks, and escapes that
  matter (`\*`, `\[`).

## What `fix` changes

`fix` writes the block structure the way Linear writes it, and copies inline
text from the file with a few targeted rewrites. A second run changes
nothing.

Blocks:

- Line endings become LF, extra blank lines between blocks collapse to one,
  and the final line break goes.
- Setext headings (text underlined with `===` or `---`) become `#`
  headings, and closing hashes go: `## Summary ##` becomes `## Summary`.
- Thematic breaks become `---`: `***` becomes `---`.
- Bullets become `*`: `- item` becomes `* item`.
- Loose lists become tight: the blank lines between items go, and a nested
  list follows its paragraph on the next line.
- Ordered lists use dots and count up from their start: `1) a` becomes
  `1. a`.
- Task items use `-` and an uppercase `X`: `* [x] done` becomes
  `- [X] done`.
- Lazy quote lines get their `>`.
- Tilde fences and indented code become backtick fences. A fence whose info
  string holds a backtick stays a tilde fence, since a backtick fence cannot
  carry one.
- `$$` math becomes a `math` fence.
- Tables get outer pipes and short separators (`| -- | -- |`), and a row
  gets as many cells as the header.
- An image does not share a paragraph with text: the text before and after
  it becomes its own paragraph.
- A list item holding only a link to a relative file other than Markdown
  becomes Linear's file block: the marker on its own line and the link
  below it.

Inline text:

- Underscore emphasis becomes asterisks: `__bold__ and _em_` becomes
  `**bold** and *em*`.
- Link destinations go in angle brackets: `[a](https://example.com/x)`
  becomes `[a](<https://example.com/x>)`.
- Reference links and images are written inline, and their definitions go.
- Autolinks and bare URLs become links: `See https://example.com now.`
  becomes `See [https://example.com](<https://example.com>) now.`
- Character references to characters outside ASCII become the characters,
  and so does `&amp;` unless a reference follows it:
  `Fish &amp; chips &mdash; &copy;` becomes `Fish & chips — ©`. Other
  references to ASCII characters stay, since some would make markup:
  `&lt;b&gt;`, `&quot;` and `&#65;` are kept.
- Emoji shortcodes Linear knows become emoji: `Done :tada:` becomes
  `Done 🎉`.
- A backslash before anything but ASCII punctuation (a letter, a digit, a
  space) is a literal backslash, and it is doubled, as Linear doubles it:
  `$\pi$` becomes `$\\pi$`, and `C:\ 2026` becomes `C:\\ 2026`.
- An escaped `#` inside a line loses its escape: `a \# b` becomes `a # b`.

## Lint rules

Each rule is a construct Linear would lose or alter. `fix` never rewrites a
file with a finding, so nothing is lost silently; change the file yourself.

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

An escaped pipe in a plain table cell splits the row. Linear drops the
backslash, and the pipe starts a new cell.

```markdown
| Expression | Meaning |
| -- | -- |
| a \| b | either |
```

Instead, put the cell text in inline code (`` `a \| b` ``, kept as it is)
or rephrase without the pipe.

### `image-in-link`

The link around an image is dropped. A badge or a clickable picture loses
its link.

```markdown
[![Build status](https://example.com/badge.svg)](https://example.com/builds)
```

Instead, put the image and the link side by side or on separate lines.

### `content-too-long`

Documents over 250,000 characters are rejected. Linear's API refuses the
whole document. The limit counts Unicode code points of the text after the
front matter.

```text
A 260 KB log pasted into one Markdown file.
```

Instead, split the file into several documents.

### `duplicate-title`

Two files map to one document title. Their paths differ only in letter case
or Unicode normalization, and Linear cannot tell them apart. Both files are
reported. The rule compares only the files a run is given: a commit hook
sees the staged files, so a new file that collides with one already
committed is reported by `pre-commit run --all-files` (as the CI example
runs it), not at commit time.

```text
guides/Install.md
guides/install.md
```

Instead, rename one of them.

### `table-alignment`

Table column alignment is dropped.

```markdown
| Item | Price |
| :-- | --: |
| Tea | 3 |
```

Instead, use plain separators (`| -- | -- |`).

### `link-title`

A link title is dropped. This holds for an inline link and for a reference
definition.

```markdown
See [the guide](https://example.com/guide "Install guide").
```

Instead, drop the title or put its text into the link text.

### `image-title`

An image title is dropped from the Markdown.

```markdown
![Logo](logo.png "Company logo")
```

Instead, drop the title or move its text into the alt text.

### `code-in-emphasis`

Bold or italic around inline code is dropped from the code. Linear keeps the
code and loses the emphasis around it.

```markdown
Run **`npm test`** first.
```

Instead, write the code without emphasis, or emphasize the words around it.

### `hard-break-backslash`

A backslash line break becomes a plain line break. Linear drops the
backslash, and the two lines join into one.

```markdown
First line\
Second line
```

Instead, end the line with two spaces or `<br>` (both kept as they are), or
start a new paragraph.

### `git-conflict-marker`

Git conflict marker lines are rewritten as headings, quotes or collapsible
sections. An unresolved merge would reach Linear mangled.

```markdown
<<<<<<< ours
The meeting is on Monday.
=======
The meeting is on Tuesday.
>>>>>>> theirs
```

Instead, resolve the conflict. Marker lines inside code (fences, indented
code and inline code) are text and pass.

### `url-in-html`

A URL inside raw HTML is turned into a Markdown link. That breaks the HTML:
`src="https://…"` becomes `src="[https://…](<https://…>)"`. The rule covers
any URL and any `src` or `href` attribute in an HTML block or tag.

```markdown
<img src="https://example.com/banner.png" alt="Banner" width="64">
```

Instead, use Markdown: `![Banner](https://example.com/banner.png)`.

### `block-first-in-list-item`

A list item that starts with a heading, code or quote is written in a form
Markdown reads as an empty item. Linear writes the marker, a blank line and
the indented block, so the block falls out of the list.

```markdown
* ## Step one
  Install the tools.
```

Instead, start the item with a line of text and put the block below it.

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
[Pre-release builds and pins](../README.md#pre-release-builds-and-pins) for
how to find its SHA):

```yaml
repos:
  - repo: https://github.com/mikhail-yaskou/mdbisync
    rev: <release-sha> # v0.1.0-rc.1
    hooks:
      - id: linear-format
```

Then install it and check the files already in the repository:

```sh
pre-commit install
pre-commit run --all-files
```

The hooks use Node 24 and npm already on your machine
(`language_version: system`; npm 11.16.0 or newer) and download no
toolchain or packages when they install or run.

### Other fixing hooks

A hook that rewrites the same Markdown in another way fights `fix`, and
the two never settle. The common ones are `end-of-file-fixer`, which adds
back the final line break `fix` removes, and `trailing-whitespace`, which
removes the two spaces of a line break. Keep them away from synchronized
Markdown files:

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
to the pull request branch and runs the checks again in the same job, so the
branch reaches `main` in Linear's form. Details:

- A pull request from a fork cannot take a push: the job fails and prints a
  ready-to-apply patch.
- The job checks out the exact head of the pull request; if the branch moves
  before the push, the push fails without overwriting the newer commits.
- It publishes the `pre-commit` check on the fixing commit too; require that
  check in the branch rules. A fork pull request without fixes keeps the
  job's own check. Other required CI must also run on the fixed
  commit or report its result for it, because a push with the workflow's
  token starts no other workflows.
