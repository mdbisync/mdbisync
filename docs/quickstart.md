# Quickstart

The steps that connect a repository to Linear, in order, from nothing to a
running sync. Every run checks this setup before it writes anything; when
a step is missing, the run stops, names what is missing and links the
section below that fixes it.

Every setting the workflows and the command line take, with its default,
is in the [configuration reference](configuration.md).

## Before you start

You need:

- **In Linear:** a workspace admin, to create the OAuth app.
- **In GitHub:** admin rights on the repository that holds your Markdown
  (your docs repository), to set secrets and change its settings. When an
  organization owns it, you also need to be an organization owner or a
  GitHub App manager of that organization, to create and install the App.
  GitHub Actions must be enabled for the repository, and if its Actions
  settings (Settings → Actions → General → Actions permissions, or the
  organization's) limit which actions may run, they must allow `mdbisync/mdbisync`, `actions/create-github-app-token`,
  `actions/checkout` and `actions/setup-node`, the only actions the
  workflows use.
- **On your machine:** a clone of the docs repository, Git 2.40 or later,
  Node.js 24.2 or later with npm 11.16.0 or later (`npm install --global
  npm@11.21.2` updates it), and Python 3.11 or later with
  [pre-commit](https://pre-commit.com) (`python3 -m pip install
  pre-commit==4.7.0`, or `pipx install pre-commit`). Docker too, if you
  choose the security hook examples ([security hooks](#security-hooks)).

Pick a release and note its **release SHA**, the commit both the action
and the hook are pinned to. List the releases:

```sh
git -c versionsort.suffix=- ls-remote --sort=version:refname https://github.com/mdbisync/mdbisync 'refs/tags/v*^{}'
```

Each line is `<release-sha>`, a tab and `refs/tags/<version>^{}`, oldest
first; a version with `-rc` is a pre-release and sorts before its final
release. Take the last line without `-rc`, or the last line if every
version is a pre-release: its first
column, 40 hexadecimal characters, is the release SHA, and the part
between `refs/tags/` and `^{}` is the version, for example `v0.1.0`
(or `v0.1.0-rc.9` for a pre-release). The steps below call them
`<release-sha>` and `<version>`. More on pins:
[release builds and pins](usage.md#release-builds-and-pins).

## Linear OAuth app

The sync gets a short-lived Linear token for each run and revokes it at the
end, from a private OAuth app with client credentials. A workspace admin
creates it.

Linear → Settings → Administration → API → OAuth applications → New

| Setting | Value |
| --- | --- |
| Application name | any |
| Developer name | any |
| Redirect URIs | `https://localhost:18327/callback` (required by the form, never used) |
| Other URLs | leave empty |
| Public | Off |
| Client credentials | On |
| Webhooks | Off |

Create it. Each run asks this app for a token with the scopes `read` and
`write`; the form has no scope setting of its own.

In your docs repository: Settings → Secrets and variables → Actions → New
repository secret

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `MDBISYNC_LINEAR_CLIENT_ID` | OAuth app page → Client ID |
| Secret | `MDBISYNC_LINEAR_CLIENT_SECRET` | OAuth app page → Client secret |

Keep the client secret only in the repository secret and, if you want a
copy, your password manager: don't leave it in a file, a note or a chat.

The run stops here when Linear refuses the credentials, when the token
lacks the `read` or `write` scope, or when the app sees no team at all.
Check that both secrets hold the app's current values (a regenerated secret
replaces the old one), and that the app can reach the teams your folders
name.

## GitHub App

The sync pushes, opens and merges its pull request and reads checks as a
GitHub App that you create and own, under the account or organization
that owns your docs repository ([before you start](#before-you-start)
names the rights this needs). The
sync's own commits name the App's bot account (`<app>[bot]`) as their
author, so GitHub shows them with the App's name and avatar.

[Create the App under your account](https://github.com/settings/apps/new?description=Two-way+sync+between+Linear+documents+and+Markdown+in+this+repository.&url=https%3A%2F%2Fgithub.com%2Fmdbisync%2Fmdbisync&public=false&webhook_active=false&contents=write&pull_requests=write&workflows=write&checks=read&statuses=read):
the link opens GitHub's new-App form with these settings filled in. It
creates the App under your personal account, which can be installed only
there. When an organization owns your docs repository, the App must
belong to that organization: in the link, replace `settings/apps/new`
with `organizations/<organization>/settings/apps/new`, where
`<organization>` is the organization's name as in its URL. Give the App a name and
create it. The same settings are in
[`github-app-manifest.json`](github-app-manifest.json), in the format of
GitHub's create-App-from-manifest flow. That flow needs a page that posts
the manifest to GitHub, so for a person the link above is the way; the
file is for tools that automate App creation.

| Setting | Value |
| --- | --- |
| GitHub App name | any |
| Homepage URL | filled in by the link; any URL will do |
| Webhook | Off |
| Contents | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |
| Checks | Read-only |
| Commit statuses | Read-only |
| Where can this App be installed | Only on this account |

Then install the App. Its settings page opens after you create it; later
you find it under Settings → Developer settings → GitHub Apps → Edit
(your personal settings, or the organization's). There: Install App → the account or
organization that owns your docs repository → Install → Only select
repositories → your docs repository → Install.

In your docs repository: Settings → Secrets and variables → Actions. The
client ID is a variable (Variables tab → New repository variable), the
key a secret (Secrets tab → New repository secret).

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `MDBISYNC_APP_CLIENT_ID` | App page → Client ID |
| Secret | `MDBISYNC_APP_PRIVATE_KEY` | App page → Generate a private key; paste the whole `.pem` file |

Then move the downloaded `.pem` file into your password manager, or
delete it: the repository secret is the copy the sync uses.

The run stops here when the App's token cannot see the repository (the App
is not installed on it, or the variable or key belongs to another App), or
when it lacks one of the permissions above; the message names the
permission. After you add a permission to an existing App, accept the new
permission on its installation: App settings → Install App, or the
installation's page in the repository's settings.

## Merge commits

The sync merges its pull request with a merge commit, so `main` keeps the
commit the sync recorded. In the repository: Settings → General → Pull
Requests → turn on **Allow merge commits**. Squash and rebase merging may
stay on for other pull requests.

When the message says GitHub did not show whether merge commits are
allowed, the setting may be on already: the App's token could not read it.
GitHub shows it to a token with **Contents: Read and write**; check that
the App has the permissions in [GitHub App](#github-app) and that its
installation accepted them.

If `main` is protected by a rule that requires approving reviews, the
sync cannot merge its own pull request: add the App to that rule's bypass
list: Settings → Rules → Rulesets → the ruleset → Bypass list → Add
bypass → your App → Save changes.

## Security hooks

Changes from Linear pass the hooks you mark `alias: security` before
anything is pushed to GitHub, where a pushed commit cannot be reliably
removed. Which hooks those are is your choice:

- **The examples:** `init --security-hooks` adds two: Gitleaks, a secret
  scanner, run in a Docker image pinned by version and digest, and a hook
  that refuses private keys. Docker must be available wherever the hooks
  run: on your machine, and on the runner (GitHub's `ubuntu-latest` has
  it). Review them for your repository's needs.
- **Your own:** run `init --no-security-hooks` (or `--security-hooks` to
  keep the examples too); after `init` has written the files, add any
  pre-commit hook to `.pre-commit-config.yaml` and give it
  `alias: security`, with `stages: [pre-commit, pre-push]`. A hook
  that needs a key gets it from a repository secret you add: in both
  `mdbisync.yml` and `mdbisync-initial-sync.yml`, under the `env:` of the
  step **Run the security hooks**, add `NAME: ${{ secrets.NAME }}` (the
  step holds a commented example). That step holds none of the sync's
  secrets.
- **None:** `init --no-security-hooks` and add none. The sync then pushes
  Linear's content unchecked, and every run's summary says so.

A document a security hook rejects is not pushed and gets a red mark and
a comment in Linear that names the hook and line, never the matched text.

## Repository files

`mdbisync init` writes everything the repository needs: the three
workflows, the hook configuration and the folder annotations. It runs from
the release you picked, through npm, with nothing installed globally. In
your clone of the docs repository, on an up-to-date `main`, at its root:

```sh
npm exec --yes --package=git+https://github.com/mdbisync/mdbisync.git#<release-sha> -- \
  mdbisync init --release-sha <release-sha> --release-version <version> \
  --folder docs --team ENG --project Handbook \
  --no-security-hooks
```

Replace `docs`, `ENG` and `Handbook` with your folder, the Linear team
(its key or name) and, optionally, a project of that team; leave out
`--project` to sync the team's own documents. Repeat `--folder` with its
own `--team` and `--project` for each folder you sync; a folder below an
annotated one may give only `--project` and inherits the team. Give
`--security-hooks` or `--no-security-hooks`, as you chose in
[Security hooks](#security-hooks). Every flag:
[`init`](configuration.md#init).

It writes:

| File | What it is |
| --- | --- |
| `.github/workflows/mdbisync.yml` | The sync, on every push to `main`, every five minutes and by hand |
| `.github/workflows/mdbisync-initial-sync.yml` | The one-time initial sync, by hand |
| `.github/workflows/pre-commit.yml` | The `pre-commit` check on every pull request |
| `.pre-commit-config.yaml` | The `linear-format` hook, and the security hook examples if you asked for them |
| `<folder>/README.md` | Each folder's annotation, in its front matter |

It keeps what the files already hold, and stops before writing anything
when a value it would write differs from one already there. It ends by
printing the steps that remain; the sections below cover them in order.
The setup check it mentions runs at the start of the initial sync's dry
run, so there is no separate `check` step here, and the required check
comes after the first sync run.
Don't commit yet: install the hooks first.

## Folder annotations

A folder syncs when its `README.md` front matter names a Linear team and,
optionally, a project ([folder mapping](usage.md#folder-mapping)).
`mdbisync init` writes it from `--folder`, `--team` and `--project`:

```yaml
---
linear-team: ENG
linear-project: Handbook
---
```

The run stops here when no folder is annotated, an annotation is invalid,
a team or project is not found in Linear or matches more than one, or two
folders map to the same project or team documents. The message names the
folder, team or project. A team matches by key or by name, a project by its
exact name within that team; after a rename in Linear, update the
annotation.

## Linear-format hook

Files reach Linear only in the form Linear keeps
([linear-format.md](linear-format.md)); the `linear-format` pre-commit hook
puts them in that form. Add it to `.pre-commit-config.yaml`, pinned to a
release ([pins](usage.md#release-builds-and-pins)). It must come from
this project's repository, not a `local` hook. `mdbisync init` has
already added it; without `init`, add it yourself:

```yaml
default_install_hook_types: [pre-commit, pre-push]
repos:
  - repo: https://github.com/mdbisync/mdbisync
    rev: <release-sha>
    hooks:
      - id: linear-format
```

Install the hooks in your clone, then run them once over every file:

```sh
pre-commit install --hook-type pre-commit --hook-type pre-push
pre-commit run --all-files
```

The first run may rewrite files into Linear's form and fail; run it again
and it passes. Everyone who edits the repository runs the same `pre-commit
install` in their own clone, so their commits arrive in that form too.

## Commit the files

Commit what `init` wrote, and any Markdown file `pre-commit run`
rewrote, and push it to `main`. `git status` lists the files; add each of
them by path, for example with one annotated folder `docs`:

```sh
git status
git add .github/workflows/mdbisync.yml .github/workflows/mdbisync-initial-sync.yml \
  .github/workflows/pre-commit.yml .pre-commit-config.yaml docs/README.md
# Then git add each Markdown file pre-commit rewrote, as git status lists it.
git commit -m "Set up the Linear sync"
git push origin main
```

Where `main` takes changes only through pull requests, commit on a
branch instead and merge its pull request:

```sh
git switch -c set-up-linear-sync
# the same git add and git commit as above
git push origin set-up-linear-sync
```

Open the pull request GitHub offers for the branch, wait for its checks
and merge it.

If the commit stops because `linear-format` rewrote a file, run the same
`git add` again and commit again: the second attempt passes.

Reaching `main` starts the sync workflow, and its schedule starts it
again every five minutes; until you disable it, each run writes nothing
and fails with `initial-sync-required`, which is expected.

Now turn the sync workflow off until the initial sync has finished:
Actions → **mdbisync** → `⋯` → **Disable workflow**. A sync queued in the
same concurrency group can replace a waiting initial sync.

## Initial sync

The sync needs a starting state, which initial sync creates. Its workflow,
`.github/workflows/mdbisync-initial-sync.yml`, is one of the files
`mdbisync init` wrote (without `init`, copy it from
[`examples/`](../examples/mdbisync-initial-sync.yml)). You run it by hand
from the Actions tab, with a direction: `git-to-linear` makes Linear equal
to git, `linear-to-git` opens a pull request that makes git equal to
Linear. The first run is a dry run that lists what would change; run it
again with `confirm` (the "Write" box) checked to write.

Choose the side whose content you keep: `git-to-linear` when the files
are the truth, `linear-to-git` when Linear's documents are. A file and a
document match when the document's title is the file's path below its
annotated folder, without `.md`: `docs/guides/install.md` under the
folder `docs` is the document `guides/install`. Each direction has its own page, with the steps and
warnings: [initial sync from git to
Linear](initial-sync-git-to-linear.md) and [from Linear to
git](initial-sync-linear-to-git.md).

1. **Dry run.** Actions → **mdbisync initial sync** → Run workflow →
   Use workflow from: `main`; `direction`: `git-to-linear` or
   `linear-to-git`; leave the box "Write. Leave unchecked for a dry run
   that writes nothing." unchecked → Run workflow.
2. **Read its summary.** Open the finished run. Its job summary starts
   with the **Setup check** table: each item `passed`, a `warning` (for
   example, no security hooks), or `FAILED` with a link to the section of
   this page that fixes it. Below it, the dry run lists by path what would
   be created, overwritten, removed and left out. Nothing is written. Fix
   any failure and run the dry run again.
3. **Write.** Run the workflow again with the same `direction` and the
   "Write" box checked. `git-to-linear` overwrites the matching Linear
   documents and moves those without a file to Linear's trash.
   `linear-to-git` opens the pull request **Initial sync from Linear**:
   review it and merge it with **Create a merge commit**, not squash or
   rebase.
4. A confirmed run that stops before it finishes (its summary says so,
   and the action's output `code` is `stopped`) goes on where it stopped
   when you run it again with the same inputs.

The sync stops here until that is done: when no initial sync has run, when
one stopped before it finished (run it again with the same inputs), or
while the pull request of an initial sync from Linear waits for a person to
merge it with a merge commit.

## First sync run

Turn the sync back on: Actions → **mdbisync** → **Enable workflow**. Then
start one run by hand: **mdbisync** → Run workflow → Use workflow from:
`main` → Run workflow. It finishes green, and its summary shows the setup check and
what it synchronized; right after an initial sync there is nothing to
write. From now on it runs on every push to `main` and every five minutes.

To see it work, edit a synchronized document in Linear: within a few
minutes the **Changes from Linear** pull request opens, passes
`pre-commit` and merges itself. Edit a synchronized file on `main` and the
next run writes it to Linear. How each change travels and what you see on
each side: [sync-cycle.md](sync-cycle.md).

## Two layers of checks

Every change that reaches `main`, from a person, an agent or the sync,
passes the same checks: your `.pre-commit-config.yaml`. They run in two
layers.

| Layer | Who | When | Which hooks | Enforced |
| --- | --- | --- | --- | --- |
| Before push | People and agents | on `git commit` and `git push`, after `pre-commit install` | all hooks of that stage | no: a clone without `pre-commit install`, or `--no-verify`, skips them |
| Before push | The sync | on every change from Linear, before it pushes | hooks marked `alias: security` | yes: a rejected document is not pushed and is marked in Linear |
| In CI | The `pre-commit` workflow | on every pull request, the sync's included | all hooks; fixing hooks commit their fixes to the pull request, with the workflow's own token (it asks for `contents: write` and `checks: write` in its `permissions:`) | yes, where `pre-commit` is a required check on `main`; the sync merges its pull request only after its checks pass |

The first layer keeps secrets and personal data from Linear off GitHub;
the second catches what a person's machine skipped. Hooks that fix
(`linear-format`) rewrite files and commit the result; hooks that check
pass or fail. A content check that fails on the sync's pull request does
not hold up all of Linear's changes: the documents it names move to a
separate pull request and are marked in Linear, and the rest go on (see
the next section). A repository that prefers `make check` can wrap the same
configuration.

Optional, recommended: make the CI layer required, so nothing reaches
`main` without it. Do it after the [first sync run](#first-sync-run):
Settings → Rules → Rulesets → New ruleset → New branch ruleset → Ruleset name: any → Enforcement status: Active → Target
branches: Add target → Include default branch → Require status checks to
pass → Add checks → `pre-commit` → Create. The check is offered there
only once it has run on a pull request: open any pull request first if
none has run yet.

## After setup: checks and suspended changes

The normal pull request is **Changes from Linear** on `mdbisync/linear`.
A failing batch moves to the one **Suspended changes from Linear** pull
request on `mdbisync/suspended` (the default branch names), and the
normal pull request closes so
other documents can continue. A suspended document shows a red `Cross`
and a comment naming the check, linking to its run when available, and
listing annotations for that file or “did not finish in time”. Security
hooks still run before push; their blocked mark takes precedence.

Suspended documents are frozen both ways: Linear edits go only to the
suspended lane, and git edits wait until release. Fix the document in
Linear, or fix the failing check on the tracked branch (`main` by
default). That updates the suspended head;
when it contains the current tracked tip and passes checks, it merges,
its comments resolve, its marks clear, and the normal three-way merge
resumes. While its checks are pending before the deadline, the normal
lane waits to merge.

`check-deadline-minutes`, an input under `with:` of the **Sync** step in
`mdbisync.yml` (default 60, range 10–1440, [configuration reference](configuration.md#action-inputs)), limits how long
checks GitHub reports as pending can stay that way after a head is pushed.
A required check that never registers is invisible to this deadline:
GitHub may refuse the merge instead; check workflow filters and required
check names. The sync never reruns a check: configure flaky-check retries
in your own CI. The App's permissions above stay as they are; it needs no
Actions permission.

When the same check fails on the tracked branch's tip (`main` by default),
the normal pull request is held instead: no document marks or Linear
alert, and the GitHub run summary names the check and links to its run.
Fix CI on the tracked branch to let the hold clear. See
[suspension and release](sync-cycle.md#suspension-and-release) and
[troubleshooting](troubleshooting.md#the-sync-pull-request).
