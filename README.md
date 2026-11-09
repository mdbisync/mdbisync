# mdbisync

Two-way sync between Markdown files in a Git repository and Linear documents,
run as a GitHub Action.

**Status:** early development. `lint` and `fix` work on Markdown files.
`check` checks a repository's setup; `sync`
and `initial-sync` run the same check (and `sync` refuses to run without its
state) and then answer "not implemented". Nothing writes yet.

## Folder mapping

A folder maps to Linear through its `README.md` front matter:

```yaml
---
linear-team: ENG            # a team, by key or name
linear-project: Field notes # a project of that team
---
```

A folder names the team, a folder below it (or the same folder) names the
project, and every folder below inherits both. Files in folders between the
team folder and a project folder are team documents. Deeper folders become a
path in the document title: `notes/guides/install.md` under a project folder
`notes/` is the document `guides/install`. Only `.md` files with text content
are synchronized; files above every annotated folder are not. Two files whose
titles differ only in letter case or Unicode normalization are both left out
and reported.

## Setup check

Before it writes anything, every run checks that the Linear token works and
may write, that the GitHub token has contents, pull requests and workflows
write and checks and commit statuses read, that merge commits are allowed,
that `.pre-commit-config.yaml` has the `linear-format` hook, that every
annotation is valid and its team and project exist in Linear, and
whether pre-commit hooks marked `alias: security` exist (without them the run
goes on and says that content is pushed unchecked). Files left out by a title
collision are listed too, without stopping the run. The result goes to the
job summary as names and states, never document content. `check` runs it
alone.

The command line reads the action's inputs (see `action.yml`) from
environment variables: `MDBISYNC_LINEAR_CLIENT_ID` for `linear-client-id`,
and so on.

## Layout

| Path | What |
| --- | --- |
| `src/cli.ts` | Command line: `sync`, `initial-sync`, `lint`, `fix`, `init`, `check`, `--version` |
| `src/action/` | GitHub Action steps: `main` (operation `sync` or `initial-sync`) and `post` |
| `src/run/` | Inputs and the preflight every run starts with |
| `src/mapping/` | Folder annotations and the mapping of files to documents |
| `src/setup/` | The setup check and the refusal to sync without state |
| `src/linear/` | Linear client |
| `src/state/` | The sync's state refs, trees and LFS reads |
| `action.yml` | Action metadata (`node24`, bundled `main` and `post`) |
| `tools/` | Build and supply-chain checks |
| `test/fixtures/`, `test/corpus/`, `test/scenarios/`, `test/e2e/` | Test data, corpus generator, scenario specs and end-to-end harness |

## Development

Requires Node 24.

```sh
npm ci                  # exact versions from package-lock.json, install scripts off
npm run typecheck       # tsc --noEmit
npm run build           # esbuild bundles into dist/, checks bundled licenses
npm test                # node --test
npm run test:hooks       # requires pre-commit; offline scratch hook and CI checks
pre-commit run --all-files
```

Dependencies are pinned to exact versions with hashes in `package-lock.json`,
install scripts never run (`.npmrc`), and updates are proposed no sooner than
14 days after a release.

## Pre-release builds and pins

Maintainers dispatch **Build pre-release** on `main`, supplying a new
pre-release tag such as `v0.1.0-rc.1` and a full source SHA already on `main`.
The workflow tests and bundles that source, verifies the CLI can install
offline, and pushes a new annotated tag pointing to an isolated release
commit. Its summary prints the release SHA. No generated files are added to
`main`, no existing tag is replaced, and no GitHub Release is published.
A failed build leaves existing pins unchanged.

Use the **release commit SHA**, which differs from the source SHA, in both
configuration files. Replace the placeholder with the summary's 40-character
release SHA and keep its version comment:

```yaml
# In a GitHub Actions workflow:
- uses: mikhail-yaskou/mdbisync@<release-sha> # v0.1.0-rc.1
```

```yaml
# In .pre-commit-config.yaml:
repos:
  - repo: https://github.com/mikhail-yaskou/mdbisync
    rev: <release-sha> # v0.1.0-rc.1
    hooks:
      - id: linear-format
```

The action runs its checked-in JavaScript bundles without installation.
The hooks use Node 24 and npm already installed on your machine
(`language_version: system`); no Node toolchain or registry dependencies are
downloaded when installing or running them. Use npm 11.16.0 or newer: npm
11.12.1 rejects pre-commit's local Git package installation. The release
package contains only bundled code and has no install scripts.

`linear-format` fixes Markdown and exits 1 when it changes a file; a second
run passes. `linear-format-check` reports changes without writing them.
Both refuse unsupported constructs with a file, line and rule, leaving the
file unchanged. The hooks run serially so duplicate titles are checked
together. Keep `linear-format` enabled for synchronization; optionally add
`linear-format-check` after it.

Copy [examples/pre-commit.yml](examples/pre-commit.yml) to
`.github/workflows/pre-commit.yml` in your synchronized repository. It runs
the entire pre-commit configuration on pull requests, commits fixes to
same-repository branches, and reruns checks in that job. Fork pull requests
that need fixes fail with a ready-to-apply patch. The workflow checks out
the exact pull request head; if the branch moves before its push, the push
fails without overwriting newer work.

To generate the test corpus with the same pin, run:

```sh
node test/corpus/generate.ts --hook-rev <40-character-release-sha>
```

The generator requires an explicit release commit SHA and preserves the
`corpus/` and `corpus-slices/` layout.

Enable Dependabot's
`github-actions` ecosystem in your repository to propose action SHA updates,
then copy the proposed release SHA into the hook's `rev` in the same change.
To update to a specific pre-release, resolve its annotated tag and use the
first column as both pins:

```sh
git ls-remote https://github.com/mikhail-yaskou/mdbisync 'refs/tags/v0.1.0-rc.2^{}'
```

`pre-commit autoupdate` follows source history and cannot discover these
isolated release commits. Keep the hook on an explicitly resolved release
SHA. The release mechanism does not make unfinished commands
functional; the development status above still applies.

See [CONTRIBUTING.md](https://github.com/mikhail-yaskou/mdbisync/blob/main/CONTRIBUTING.md)
to run the tests, including live tests against your own Linear workspace, and
[SECURITY.md](https://github.com/mikhail-yaskou/mdbisync/blob/main/SECURITY.md)
to report a vulnerability.

## License

MIT, see [LICENSE](LICENSE). The bundles include third-party packages under
their own licenses; every release commit ships their license texts and notices
in `dist/THIRD_PARTY_NOTICES.txt`.
