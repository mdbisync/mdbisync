# Configuration reference

Every setting mdbisync takes, with its default. The
[quickstart](quickstart.md) walks through the setup in order; this page is
for looking things up. A test checks the tables below against `action.yml`
and the code, so a new input or a changed default cannot ship without its
row.

## Action inputs

The inputs of `uses: mdbisync/mdbisync@<release-sha>`, under `with:`. The
example workflows set the required ones; the rest keep their
defaults until you add them. The command line reads the same inputs from
the environment variables in the third column; an input marked "action
only" has no command-line form.

| Input | Required | Default | Command line | What it sets |
| --- | --- | --- | --- | --- |
| `operation` | no | `sync` | action only (the command) | `sync`, the recurring two-way sync, or `initial-sync`, the one-time sync that makes one side equal to the other. |
| `linear-client-id` | yes | none | `MDBISYNC_LINEAR_CLIENT_ID` | Client ID of the [Linear OAuth app](quickstart.md#linear-oauth-app). |
| `linear-client-secret` | yes | none | `MDBISYNC_LINEAR_CLIENT_SECRET` | Client secret of that app. |
| `linear-api-url` | no | none | `MDBISYNC_LINEAR_API_URL` | Linear API origin; empty means Linear itself (`https://api.linear.app`). |
| `cleanup-tokens` | no | `false` | action only | `true` replaces Linear tokens left by runs that were killed. Only with a Linear app used by nothing but these workflows in this repository, and never with `security-step: apply`: on the stage step, or on the only mdbisync step when `security-step` is empty ([tokens left by interrupted jobs](#tokens-left-by-interrupted-jobs)). |
| `github-token` | yes | none | `MDBISYNC_GITHUB_TOKEN` | Installation token of the sync's [GitHub App](quickstart.md#github-app), from `actions/create-github-app-token`. |
| `app-slug` | yes | none | `MDBISYNC_APP_SLUG` | The App's slug, the token step's output `app-slug`; the sync's commits name the App's bot account. Optional on the command line, whose commits then name a neutral author. |
| `github-api-url` | no | none | `MDBISYNC_GITHUB_API_URL` | GitHub REST API URL; empty means the runner's (`GITHUB_API_URL`), else `https://api.github.com`. |
| `repository` | no | none | `MDBISYNC_REPOSITORY` | The repository as `owner/name`; empty means the workflow's (`GITHUB_REPOSITORY`). |
| `tracked-branch` | no | `main` | `MDBISYNC_TRACKED_BRANCH` | The branch the sync keeps equal to Linear. |
| `sync-branch` | no | `mdbisync/linear` | `MDBISYNC_SYNC_BRANCH` | The branch of the sync pull request; its suspended lane is named after it ([the sync pull request](usage.md#the-sync-pull-request)). |
| `state-ref-prefix` | no | `refs/mdbisync` | `MDBISYNC_STATE_REF_PREFIX` | Prefix of the refs that hold the sync's state. |
| `document-cap` | no | `1000` | `MDBISYNC_DOCUMENT_CAP` | Maximum documents per Linear project or team, trash included. A run warns at 90% and stops before writing above it. |
| `merge-grace-seconds` | no | `60` | `MDBISYNC_MERGE_GRACE_SECONDS` | Seconds, 0 to 120, a run waits for checks after it opens or moves the sync pull request; 0 leaves the merge to a later run. |
| `check-deadline-minutes` | no | `60` | `MDBISYNC_CHECK_DEADLINE_MINUTES` | Minutes, 10 to 1440, the sync pull request's checks may stay pending before its batch is suspended. |
| `required-checks` | no | none | `MDBISYNC_REQUIRED_CHECKS` | Checks, one per line, that every sync pull request head must pass before it merges, each with the publisher it must come from: `<name> @ actions`, `<name> @ app:<App id>` or `<name> @ status:<account id>` ([required checks](usage.md#required-checks)). From `v0.1.0-rc.13`; this form of the lines from `v0.1.0-rc.18` (`v0.1.0-rc.13` and `rc.14` take bare names, `rc.15` to `rc.17` write `<name> @ actions:<workflow file>` for a GitHub Actions job). |
| `merge-without-checks` | no | `false` | `MDBISYNC_MERGE_WITHOUT_CHECKS` | `true` lets the sync merge a head with no checks at all, for a repository without CI. From `v0.1.0-rc.13`. |
| `report-file` | no | none | `MDBISYNC_REPORT_FILE` | Path for the run's report as JSON (names and states only, and git's output for a refused push git reports partly applied), with the job summary beside it as `summary.md`; empty writes none. If a directory on the path is a symbolic link inside the checkout, the files are not written and the step fails; a link at either file's name is replaced, not written through. |
| `direction` | no | none | `MDBISYNC_DIRECTION` | Initial sync only, and required there: `git-to-linear` or `linear-to-git`. |
| `confirm` | no | none | `MDBISYNC_CONFIRM` | Initial sync only: `true` writes; anything else is a dry run that writes nothing. |
| `security-step` | no | none | action only | `stage` or `apply`: runs the security hooks in a step of their own, between the two ([workflows](usage.md#workflows)). Empty runs them inside this step. |

## Action outputs

| Output | What it holds |
| --- | --- |
| `node` | `security-step: stage` only: the Node.js that runs the hooks step. |
| `hooks` | `security-step: stage` only: the script of the hooks step. |
| `code` | Why the run stopped before writing, did not finish or is partial; empty when it finished. Every code is in [troubleshooting](troubleshooting.md). |

## Environment secrets and repository variables

The example workflows use the `mdbisync` environment. In Settings →
Environments, set its deployment branches to **Selected branches and
tags** with a single **Branch** rule for the tracked branch (`main` by
default) and no required reviewers. Add the secrets below there. Set
repository variables under Settings → Secrets and variables → Actions.
See the [sync environment setup](quickstart.md#sync-environment) for
GitHub plan requirements, and
[below](#moving-an-existing-installation-to-the-environment) for an
installation that keeps them as repository secrets.

| Kind | Name | Holds | Set in |
| --- | --- | --- | --- |
| Variable | `MDBISYNC_LINEAR_CLIENT_ID` | The Linear OAuth app's client ID | [Linear OAuth app](quickstart.md#linear-oauth-app) |
| Secret | `MDBISYNC_LINEAR_CLIENT_SECRET` | The Linear OAuth app's client secret | [Linear OAuth app](quickstart.md#linear-oauth-app) |
| Variable | `MDBISYNC_APP_CLIENT_ID` | The GitHub App's client ID | [GitHub App](quickstart.md#github-app) |
| Secret | `MDBISYNC_APP_PRIVATE_KEY` | The GitHub App's private key, the whole `.pem` file | [GitHub App](quickstart.md#github-app) |
| Variable | `MDBISYNC_CI_WORKFLOWS` | The file names of the repository's other CI workflows, which the pre-commit workflow starts on the commits it pushes; optional | [In CI](linear-format.md#in-ci) |

A security hook that needs a key of its own gets it from an environment secret you add,
in the **Run the security hooks** step's `env:`.

### Moving an existing installation to the environment

Workflows written by `init` of `v0.1.0-rc.17` or earlier, or copied from
the examples of those releases, declare no environment and read the
Linear client ID, the Linear client secret and the App's private key from
repository secrets. To move such an installation, in this order:

1. Create the `mdbisync` environment with its branch rule, as the
   [sync environment setup](quickstart.md#sync-environment) describes.
2. Add `MDBISYNC_LINEAR_CLIENT_SECRET` and `MDBISYNC_APP_PRIVATE_KEY` as
   environment secrets, with their current values. The Linear client
   secret also signs the sync's state: if you rotate it instead, and the
   sync then reports `initial-sync-required`, follow
   [Recovery with initial sync](troubleshooting.md#recovery-with-initial-sync).
3. Add the repository variable `MDBISYNC_LINEAR_CLIENT_ID` with the Linear
   app's client ID, next to `MDBISYNC_APP_CLIENT_ID`.
4. In both `mdbisync.yml` and `mdbisync-initial-sync.yml`, add
   `environment: mdbisync` under the job, at the same indentation as
   `runs-on`, and change each `linear-client-id` input to
   `${{ vars.MDBISYNC_LINEAR_CLIENT_ID }}`. Commit both to the tracked
   branch.
5. Delete the repository secrets of the same names, and any old client-ID
   repository secret, under Settings → Secrets and variables → Actions.
   If an organization secret of the same name is visible to this
   repository, also remove that access.

Until step 5 the jobs can still read the repository secrets, so the sync
keeps working, but the branch rule does not protect them: protection takes
effect once the credentials exist only in the environment.

## Folder annotations

In the front matter of a folder's `README.md`
([folder mapping](usage.md#folder-mapping)):

| Key | Default | Value |
| --- | --- | --- |
| `linear-team` | inherited from the nearest annotated folder above | A Linear team, by key or name. |
| `linear-project` | none: the folder holds the team's own documents | A project of that team, by its exact name. |

## Pre-commit hooks

From `repo: https://github.com/mdbisync/mdbisync`, pinned with
`rev: <release-sha>`:

| Hook id | What it does |
| --- | --- |
| `linear-format` | Rewrites Markdown into the form Linear keeps; fails when it changed a file, so the next run passes. Required. |
| `linear-format-check` | Reports what `linear-format` would change, without writing. |

A hook of any repository with `alias: security` runs on Linear's changes
before the sync pushes them ([security hooks](quickstart.md#security-hooks)).

## Command line

The release's `dist/cli.js`, run as `mdbisync`, for example through
`npm exec --yes --package=git+https://github.com/mdbisync/mdbisync.git#<release-sha> -- mdbisync <command>`.

| Command | What it does |
| --- | --- |
| `init` | Writes the workflows and the hook configuration into the repository, optionally with the security hook examples and the Git LFS lines; the quickstart does the same by hand. |
| `check` | Runs the setup check alone, writing nothing. |
| `initial-sync` | The initial sync; a dry run unless `MDBISYNC_CONFIRM=true`. |
| `sync` | The two-way sync. |
| `lint` | Reports Markdown that Linear would change. |
| `fix` | Rewrites Markdown into the form Linear keeps. |

`check`, `initial-sync` and `sync` read the inputs above from their
environment variables; secrets never go in arguments.

### init

| Flag | Default | Value |
| --- | --- | --- |
| `--release-sha` | none, required | The 40-character release SHA the workflows and the hook are pinned to: `v1.0.0-rc.1` or a later release. |
| `--release-version` | none | The release's version, written as a comment beside each pin. |
| `--security-hooks` | off | Adds the two security hook examples (Docker needed where they run). |
| `--no-security-hooks` | on | Adds none; give one of the two to make the choice explicit. |
| `--lfs` | off | Adds to `.gitattributes` the Git LFS lines for embedded files: one per image and document type the sync takes from Linear (`*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`, `*.avif`, `*.pdf`, `*.mp4`, `*.webm`, `*.svg`) and `**/assets/** filter=lfs diff=lfs merge=lfs -text` for every `assets/` folder. That line covers every folder named `assets` in the repository, a website's own included; leave out `--lfs` and write your own lines if one must stay out of LFS. Lines already there are kept and not repeated. |
| `--no-lfs` | on | Leaves `.gitattributes` as it is: your own attributes decide what goes to LFS. |

With a terminal attached, `init` asks for the release SHA when it is
missing, and whether to add the security hook examples and the Git LFS
lines when their flags are missing. It changes local files only.

The workflows `init` writes are made for the release their examples pin,
`v1.0.0-rc.1`, and pass action inputs that earlier releases lack. `init`
refuses an earlier release, given by its SHA or its `--release-version`,
and names it; it writes any other SHA as given, since it works offline and
cannot check one it does not know.

## Tokens left by interrupted jobs

The action revokes each run's Linear token when it ends and retries in its
`post` step, including failed and cancelled jobs. A runner that disappears
before post can execute can leave an active token behind.

The example workflows leave `cleanup-tokens: false`. To clean orphan tokens
automatically, set `cleanup-tokens: true` on the stage step, or on the only
mdbisync step when `security-step` is empty; never on the apply step. This
requires a **dedicated Linear OAuth app** used only by this repository's
sync and initial-sync workflows, both in the same `concurrency` group. Cleanup requests
read-only scopes and then restores read/write scopes, replacing the app's
existing tokens in that workspace. Do not enable it when another repository,
process or test worker uses the same app; leave it false and revoke stale
tokens during an exclusive maintenance window instead.
