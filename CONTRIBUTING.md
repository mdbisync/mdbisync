# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a
larger change, open an issue first so we can agree on the approach.
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Set up and run the tests

You need Node.js 24.2 or later, npm 11.16.0 or later (CI uses 11.21.2; older
npm rejects pre-commit's install of the hooks from a local repository), Git
and [pre-commit](https://pre-commit.com/): it runs the same hooks as CI, and
the scenario harness tests commit through pre-commit hooks of a local hook
repository. CI installs the pre-commit version pinned in
[.github/requirements/pre-commit.txt](.github/requirements/pre-commit.txt);
to use the same one, install it into a virtual environment with
`pip install --require-hashes --only-binary :all: -r .github/requirements/pre-commit.txt`.

Run them in this order: `npm test` needs the bundles that `npm run build`
writes to `dist/`, and the quick checks fail sooner than the full suite.

```sh
npm ci                     # exact versions from package-lock.json, no install scripts
npm audit signatures       # registry signatures of the installed packages
npm run check:install-scripts  # no locked package has install scripts
npm run check:fixtures     # the fixture bank matches its index
npm run typecheck
npm run build              # bundles dist/, checks bundled licenses, writes the notices
pre-commit run --all-files # the repository's hooks, including the check for Cyrillic text
npm test
npm run test:hooks         # needs pre-commit; offline scratch hook and CI checks
npm run test:template-install  # needs Python 3.11 to 3.14 with venv, and PyPI; template and repository pre-commit installs
                               # TEMPLATE_INSTALL_PYTHON=<python3.10> checks that templates refuse an older Python
```

`pre-commit install` runs the same hooks on every commit and push.

The test of the release the templates pin reads the release tags and is
skipped without them. A clone of a fork can lack the newer ones; fetch them
from this repository:

```sh
git fetch https://github.com/mdbisync/mdbisync.git 'refs/tags/v*:refs/tags/v*'
```

To generate the test corpus with a released hook, pass its release commit
SHA (see [Release builds and pins](docs/usage.md#release-builds-and-pins));
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

## Error messages and codes

A message a run prints when it fails, stops or warns takes its text from
[src/messages.ts](src/messages.ts) through `message(key, values)`, and a
code it reports is in a table of [src/codes.ts](src/codes.ts). Add a new
one there and explain it in
[docs/troubleshooting.md](docs/troubleshooting.md): the page's test fails
until the page names every code and gives every message.

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
| `src/sync/` | The sync run after the initial sync: both directions, assets, the sync pull request |
| `src/merge/` | Three-way Markdown merge, conflict markers, and renames or deletions on either side |
| `src/mapping/` | Folder annotations and the mapping of files to documents |
| `src/setup/` | The setup check and the refusal to sync without state |
| `src/format/` | `lint` and `fix`: Markdown in Linear's form ([docs/linear-format.md](docs/linear-format.md)) |
| `src/initial-sync/` | Initial sync in both directions: plan, dry run, confirmed run |
| `src/init/` | `init`: writes the workflows (templates in `workflows.json`, mirrored in `examples/`) and configuration into a repository |
| `src/pull-request/` | Pull requests through GitHub's REST API: open, update, read checks, merge |
| `src/linear/` | Linear client |
| `src/state/` | The sync's state refs, trees and LFS reads |
| `src/release/` | Release build: bundles, SBOM, security gate and report, dependency scan |
| `src/messages.ts`, `src/codes.ts` | Run messages and reported codes (see [Error messages and codes](#error-messages-and-codes)) |
| `action.yml` | Action metadata (`node24`, bundled `main` and `post`) |
| `tools/` | Build, supply-chain checks and test runners |
| `test/fixtures/`, `test/corpus/`, `test/scenarios/`, `test/e2e/` | Test data, corpus generator, scenario specs and end-to-end harness |
| `examples/` | Workflow templates for users; `init` writes the same files |
| `security/` | Accepted risks, the dependency review's advisory exceptions and the security reports of final releases |

## Pull requests

- Keep a pull request to one change, with tests that show it working.
- Every pull request runs CI (the checks above, with the tests in four
  shards), CodeQL code scanning and dependency review; all of them must
  pass before it can merge. A new CodeQL alert blocks the merge until the
  code is fixed when it is a security alert of medium severity or higher,
  or any alert of severity error.
- A change to what users see (inputs, messages, codes, workflows, the
  format) updates `README.md`, `docs/` and `examples/` (with its copy in
  `src/init/workflows.json`) in the same pull request.
- Do not weaken or skip a failing test to make it pass; fix the cause.
- Write code, comments and docs in English.
- Dependencies: exact versions with hashes in `package-lock.json`, no
  install scripts, and only well-maintained packages under MIT, ISC, BSD or
  Apache-2.0. A pull request that adds one says why the standard library
  is not enough. Updates are proposed no sooner than 14 days after a
  release.
- Dependency review fails when a pull request introduces a known
  vulnerability of moderate severity or higher in a runtime, development
  or unknown dependency scope. Update to a patched version or remove the
  vulnerable dependency before merging; if no fix is available, use a safe
  alternative. Report suspected advisory errors to the maintainers.
- If your change adds, removes or updates a bundled package, run
  `npm run build -- --update-license-inventory` and commit the updated
  `third-party-licenses.json`; the build fails until the inventory matches
  the bundles.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
