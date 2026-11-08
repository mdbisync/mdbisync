# mdbisync

Two-way sync between Markdown files in a Git repository and Linear documents,
run as a GitHub Action.

**Status:** early development. Every command and both action entry points
answer "not implemented"; nothing is usable yet.

## Layout

| Path | What |
| --- | --- |
| `src/cli.ts` | Command line: `sync`, `initial-sync`, `lint`, `fix`, `init`, `check`, `--version` |
| `src/action/` | GitHub Action steps: `main` (operation `sync` or `initial-sync`) and `post` |
| `action.yml` | Action metadata (`node24`, bundled `main` and `post`) |
| `tools/` | Build and supply-chain checks |
| `test/fixtures/`, `test/corpus/`, `test/scenarios/`, `test/e2e/` | Test data, corpus generator, scenario specs and end-to-end harness |

## Development

Requires Node 24.

```sh
npm ci                  # exact versions from package-lock.json, install scripts off
npm run typecheck       # tsc --noEmit
npm run build           # esbuild bundles into dist/
npm test                # node --test
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
The hook needs Node 24.15.0, which pre-commit provisions when creating its
environment; its package has no registry dependencies. Enable Dependabot's
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

## License

MIT, see [LICENSE](LICENSE).
