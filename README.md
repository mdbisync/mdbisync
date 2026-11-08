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

## License

MIT, see [LICENSE](LICENSE).
