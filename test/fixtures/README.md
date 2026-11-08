# Fixture bank

One small file per Markdown construct and edge case. The linter's tests,
the format probe and the corpus generator all read this bank.

## Layout

- One folder per group (`construct-singles/`, `tables/`, `lint-errors/`
  and so on). A fixture's folder is its group.
- `assets/`: tiny images and attachments that fixtures link to. They are
  not fixtures themselves.
- `index.yaml`: the index of every fixture and asset.
- `check-index.mjs`: checks the bank against the index; `check-index.d.mts`
  gives its exports types for the TypeScript code that imports them.
- `<name>.linear.md`, `<name>.linear.yjs.json` and `linear-probe.json`:
  Linear's recorded forms, written by the format probe (`test/probe/`).
  They are not fixtures; each must sit beside its fixture.

Fixtures are byte-exact test data. Some have CRLF line endings, a byte order
mark, trailing spaces, tabs or no final newline on purpose, so
`.gitattributes` turns off line-ending conversion here, and whitespace or
end-of-file fixers must skip this folder.

## Index

`index.yaml` uses a small YAML subset: top-level scalars and lists of flat
maps, with plain or double-quoted values. The check rejects anything else.

Each fixture entry has:

| Key | Meaning |
| --- | --- |
| `file` | path relative to this folder |
| `group` | one of the `groups` ids; also the fixture's folder |
| `construct` | what the file shows, as a short id |
| `class` | expected class: `fixable` (the normalizer rewrites it to an equivalent form), `lint-error` (content would be lost; reported, not rewritten) or `unchanged` (already in the target form) |
| `rule` | for `lint-error` only: one of the `rules` ids |
| `line` | for `lint-error` only: the line `lint` names for the rule, front matter counted |
| `basis` | `known` when the class was observed, `assumed` until the format probe confirms or corrects it; every fixture the probe writes to Linear has basis `known`, except `duplicate-title` ones (a content probe cannot observe titles) |
| `canary` | the fixture's unique token, `kx-` and eight hex digits |
| `canary_in` | `name` when the file cannot hold text (an empty file): the token is in the file name |
| `synced` | `false` for files that are never synchronized; this field, not the group, decides it |
| `missing_target` | `true` when a broken relative link is the point of the fixture |
| `name_as` | the colliding name a test writes the fixture under (see below) |
| `macos_unsafe` | `true` together with `name_as` |
| `note` | free text |

Every rule in `rules` needs at least one fixture. Only `.md` files are
synchronized and treated as Markdown, so a `.markdown` file next to an
`.md` file of the same name is ignored and does not collide with it.

Two file names that differ only in case or Unicode normalization map to one
title, but a checkout cannot hold both on macOS (case or normalization) or
Windows (case). Such fixtures are
committed under safe names, with `name_as` giving the name a test writes
them under on a case- and normalization-sensitive file system, and
`macos_unsafe: true`. Each `name_as` must collide with another fixture's.

The class follows Linear's recorded form of the text the sync sends (the
file without its front matter): `unchanged` only where Linear keeps that
text, `fixable` where Linear rewrites it to an equivalent form, and
`lint-error`, with a rule, where Linear would lose or alter content or
refuses the text. The check enforces this against the recorded forms and
refusals, so a new probe record cannot leave a class stale.

`known_constructs` lists the constructs whose behavior is already known,
with their class. Every one needs a fixture with basis `known`, every
fixture of it must have that class, and basis `known` is used only for
listed constructs. The expected form after a round trip is recorded beside each
fixture by the format probe, not here.

## Rules for fixtures

- Neutral English text. Non-Latin coverage uses Greek, CJK, Arabic, Hebrew,
  Devanagari, Thai and emoji; never Cyrillic.
- Every fixture carries its canary token, so a test can find its documents
  and a log scan can prove no content leaked.
- An `unchanged` fixture is already in the target form, which has no final
  newline.
- Relative links and images resolve inside the bank, unless the fixture is
  marked `missing_target`.
- New findings about a construct become a new fixture here.

## Check

```sh
node test/fixtures/check-index.mjs
node --test 'test/fixtures/*.test.mjs'
```

The first command checks that every file is indexed, every indexed file
exists, every group, rule and known construct has fixtures, each fixture
has its unique canary, relative targets resolve, every asset is used, and
nothing contains Cyrillic. The second proves that the check catches each of
these mismatches. Both run on Node 24 with no dependencies.
