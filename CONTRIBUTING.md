# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a
larger change, open an issue first so we can agree on the approach.
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Set up and run the tests

You need Node 24, Git and [pre-commit](https://pre-commit.com/): it runs
the same hooks as CI, and the scenario harness tests commit through
pre-commit hooks of a local hook repository.

```sh
npm ci                     # exact versions from package-lock.json, no install scripts
npm run typecheck
npm run build              # bundles dist/, checks bundled licenses, writes the notices
npm test
npm run test:hooks         # needs pre-commit; offline scratch hook and CI checks
pre-commit run --all-files
```

To generate the test corpus with a released hook, pass its release commit
SHA (see [Pre-release builds and pins](docs/usage.md#pre-release-builds-and-pins));
the generator keeps the `corpus/` and `corpus-slices/` layout:

```sh
node test/corpus/generate.ts --hook-rev <40-character-release-sha>
```

`npm test` needs no network or accounts. In the live scenario runs, a
person's commit goes through the test repository's released hooks, which
need npm 11.16.0 or newer; with an older npm those runs are reported as
blocked by the environment. Tests that talk to Linear or GitHub
are skipped unless you set the variables below.

The scenario harness (building the corpus, running scenarios, reading their
reports and the credentials of live runs) is described in
[test/README.md](test/README.md).

## Live tests with your own Linear workspace

The live tests create and delete their own data. Use a workspace and a
repository made for testing, never ones with real work in them.

1. Create a Linear workspace for testing (the free plan is enough) with at
   least one team.
2. In that workspace, create an OAuth application (Settings, API, OAuth
   applications) and enable client credentials for it, with the `read` and
   `write` scopes. The tests mint a short-lived token from it and revoke it
   at the end.
3. For the state tests, install Git LFS locally and create an empty GitHub
   repository that your local Git credentials can push to.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `LINEAR_TEST_APP_CLIENT_ID` | Linear client contract test, format probe | the OAuth application's client id |
| `LINEAR_TEST_APP_CLIENT_SECRET` | Linear client contract test, format probe | its client secret |
| `LINEAR_TEST_TEAM_KEY` | Linear client contract test, format probe | optional: the team to use (default: the first team) |
| `LINEAR_BASE_URL` | Linear client contract test, format probe | optional: a proxy in front of Linear's API |
| `LINEAR_CONTRACT_REPORT` | Linear client contract test | optional: write the contract test's request report to this file |
| `MDBISYNC_TEST_SANDBOX_URL` | state tests | the URL of your test repository |

```sh
export LINEAR_TEST_APP_CLIENT_ID=... LINEAR_TEST_APP_CLIENT_SECRET=...
export MDBISYNC_TEST_SANDBOX_URL=https://github.com/<you>/<test-repository>.git
npm test
npm run probe:format -- --report report.md   # see test/probe/README.md
```

Each run works under its own random names: projects in Linear, and a branch
and refs under `refs/mdbisync-t/` in the test repository. It removes them at
the end. The Git LFS objects the state tests upload (a few kilobytes) stay
in the repository's LFS storage.

## Where things are

| Path | What |
| --- | --- |
| `src/cli.ts` | Command line: `sync`, `initial-sync`, `lint`, `fix`, `init`, `check`, `--version` |
| `src/action/` | GitHub Action steps: `main` (operation `sync` or `initial-sync`) and `post` |
| `src/run/` | Inputs and the preflight every run starts with |
| `src/mapping/` | Folder annotations and the mapping of files to documents |
| `src/setup/` | The setup check and the refusal to sync without state |
| `src/format/` | `lint` and `fix`: Markdown in Linear's form ([docs/linear-format.md](docs/linear-format.md)) |
| `src/initial-sync/` | Initial sync in both directions: plan, dry run, confirmed run |
| `src/pull-request/` | Pull requests through GitHub's REST API: open, update, read checks, merge |
| `src/linear/` | Linear client |
| `src/state/` | The sync's state refs, trees and LFS reads |
| `action.yml` | Action metadata (`node24`, bundled `main` and `post`) |
| `tools/` | Build and supply-chain checks |
| `test/fixtures/`, `test/corpus/`, `test/scenarios/`, `test/e2e/` | Test data, corpus generator, scenario specs and end-to-end harness |

## Pull requests

- Keep a pull request to one change, with tests that show it working.
- Do not weaken or skip a failing test to make it pass; fix the cause.
- Write code, comments and docs in English.
- Dependencies: exact versions with hashes in `package-lock.json`, no
  install scripts, and only well-maintained packages under MIT, ISC, BSD or
  Apache-2.0. A pull request that adds one says why the standard library
  is not enough. Updates are proposed no sooner than 14 days after a
  release.
- If your change adds, removes or updates a bundled package, run
  `npm run build -- --update-license-inventory` and commit the updated
  `third-party-licenses.json`; the build fails until the inventory matches
  the bundles.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
