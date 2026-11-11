# Configuration reference

Every setting mdbisync takes, with its default. The
[quickstart](quickstart.md) walks through the setup in order; this page is
for looking things up. A test checks the tables below against `action.yml`
and the code, so a new input or a changed default cannot ship without its
row.

## Action inputs

The inputs of `uses: mdbisync/mdbisync@<release-sha>`, under `with:`. The
workflows `init` writes set the required ones; the rest keep their
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
| `report-file` | no | none | `MDBISYNC_REPORT_FILE` | Path for the run's report as JSON (names and states only), with the job summary beside it as `summary.md`; empty writes none. |
| `direction` | no | none | `MDBISYNC_DIRECTION` | Initial sync only, and required there: `git-to-linear` or `linear-to-git`. |
| `confirm` | no | none | `MDBISYNC_CONFIRM` | Initial sync only: `true` writes; anything else is a dry run that writes nothing. |
| `security-step` | no | none | action only | `stage` or `apply`: runs the security hooks in a step of their own, between the two ([workflows](usage.md#workflows)). Empty runs them inside this step. |

## Action outputs

| Output | What it holds |
| --- | --- |
| `node` | `security-step: stage` only: the Node.js that runs the hooks step. |
| `hooks` | `security-step: stage` only: the script of the hooks step. |
| `code` | Why the run stopped before writing, did not finish or is partial; empty when it finished. Every code is in [troubleshooting](troubleshooting.md). |

## Repository secrets and variable

The workflows `init` writes read these; set them in the repository under
Settings → Secrets and variables → Actions.

| Kind | Name | Holds | Set in |
| --- | --- | --- | --- |
| Secret | `MDBISYNC_LINEAR_CLIENT_ID` | The Linear OAuth app's client ID | [Linear OAuth app](quickstart.md#linear-oauth-app) |
| Secret | `MDBISYNC_LINEAR_CLIENT_SECRET` | The Linear OAuth app's client secret | [Linear OAuth app](quickstart.md#linear-oauth-app) |
| Variable | `MDBISYNC_APP_CLIENT_ID` | The GitHub App's client ID | [GitHub App](quickstart.md#github-app) |
| Secret | `MDBISYNC_APP_PRIVATE_KEY` | The GitHub App's private key, the whole `.pem` file | [GitHub App](quickstart.md#github-app) |

A security hook that needs a key of its own gets it from a secret you add,
in the **Run the security hooks** step's `env:`.

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
| `init` | Writes the workflows, the hook configuration and the folder annotations into the repository. |
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
| `--release-sha` | none, required | The 40-character release SHA the workflows and the hook are pinned to. |
| `--release-version` | none | The release's version, written as a comment beside each pin. |
| `--folder` | none, at least one | A folder to synchronize; the `--team` and `--project` after it apply to it. Repeat for each folder. |
| `--team` | none | The folder's Linear team, by key or name. A folder needs a team or a project. |
| `--project` | none | The folder's Linear project; its team may come from a folder above. |
| `--security-hooks` | off | Adds the two security hook examples (Docker needed where they run). |
| `--no-security-hooks` | on | Adds none; give one of the two to make the choice explicit. |

With a terminal attached and the release SHA, a folder, or a folder's
team or project missing, `init` asks for those, and then whether to add
the security hook examples. It changes local files only.

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
