# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a
larger change, open an issue first so we can agree on the approach.
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Set up and run the tests

You need Node 24 and Git; [pre-commit](https://pre-commit.com/) runs the
same hooks as CI.

```sh
npm ci                     # exact versions from package-lock.json, no install scripts
npm run typecheck
npm run build              # bundles dist/, checks bundled licenses, writes the notices
npm test
pre-commit run --all-files
```

`npm test` needs no network or accounts: tests that talk to Linear or GitHub
are skipped unless you set the variables below.

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

## Pull requests

- Keep a pull request to one change, with tests that show it working.
- Do not weaken or skip a failing test to make it pass; fix the cause.
- Write code, comments and docs in English.
- Dependencies: exact versions with hashes in `package-lock.json`, no
  install scripts, and only well-maintained packages under MIT, ISC, BSD or
  Apache-2.0. A pull request that adds one says why the standard library
  is not enough.
- If your change adds, removes or updates a bundled package, run
  `npm run build -- --update-license-inventory` and commit the updated
  `third-party-licenses.json`; the build fails until the inventory matches
  the bundles.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
