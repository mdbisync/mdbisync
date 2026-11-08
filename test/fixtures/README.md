# Fixture bank

One small file per Markdown construct and edge case. The linter's tests,
the format probe and the corpus generator all read this bank.

## Layout

- One folder per group (`construct-singles/`, `tables/`, `lint-errors/`
  and so on). A fixture's folder is its group.
- `assets/`: tiny images and attachments that fixtures link to. They are
  not fixtures themselves.
- `index.yaml`: the index of every fixture and asset.
- `check-index.mjs`: checks the bank against the index.

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
| `basis` | `known` when the class was observed, `assumed` until the format probe confirms or corrects it |
| `canary` | the fixture's unique token, `kx-` and eight hex digits |
| `canary_in` | `name` when the file cannot hold text (an empty file): the token is in the file name |
| `synced` | `false` for files that are never synchronized |
| `missing_target` | `true` when a broken relative link is the point of the fixture |
| `note` | free text |

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
