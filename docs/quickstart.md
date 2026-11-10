# Quickstart

The steps that connect a repository to Linear. Every run checks this setup
before it writes anything; when a step is missing, the run stops, names
what is missing and links the section below that fixes it.

`mdbisync init` writes the repository files ([Generate repository
files](usage.md#generate-repository-files)) and prints the admin steps that
remain.

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

In your docs repository: Settings → Secrets and variables → Actions → New
repository secret

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `MDBISYNC_LINEAR_CLIENT_ID` | OAuth app page → Client ID |
| Secret | `MDBISYNC_LINEAR_CLIENT_SECRET` | OAuth app page → Client secret |

Then store the client secret in your password manager or delete it. Don't
leave a copy lying around.

The run stops here when Linear refuses the credentials, when the token
lacks the `read` or `write` scope, or when the app sees no team at all.
Check that both secrets hold the app's current values (a regenerated secret
replaces the old one), and that the app can reach the teams your folders
name.

## GitHub App

The sync pushes, opens and merges its pull request and reads checks as a
GitHub App that you create and own. A repository admin creates it. The
sync's own commits name the App's bot account (`<app>[bot]`) as their
author, so GitHub shows them with the App's name and avatar.

[Create the App under your account](https://github.com/settings/apps/new?description=Two-way+sync+between+Linear+documents+and+Markdown+in+this+repository.&url=https%3A%2F%2Fgithub.com%2Fmdbisync%2Fmdbisync&public=false&webhook_active=false&contents=write&pull_requests=write&workflows=write&checks=read&statuses=read):
the link opens GitHub's new-App form with these settings filled in. For an
organization's App, replace `settings/apps/new` in the link with
`organizations/<organization>/settings/apps/new`. Give the App a name and
create it. The same settings are in
[`github-app-manifest.json`](github-app-manifest.json), in the format of
GitHub's create-App-from-manifest flow. That flow needs a page that posts
the manifest to GitHub, so for a person the link above is the way; the
file is for tools that automate App creation.

| Setting | Value |
| --- | --- |
| GitHub App name | any |
| Homepage URL | any (required by the form) |
| Webhook | Off |
| Contents | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |
| Checks | Read-only |
| Commit statuses | Read-only |
| Where can this App be installed | Only on this account |

Then install the App: Only select repositories → your docs repository.

In your docs repository: Settings → Secrets and variables → Actions

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `MDBISYNC_APP_CLIENT_ID` | App page → Client ID |
| Secret | `MDBISYNC_APP_PRIVATE_KEY` | App page → Generate a private key; paste the whole `.pem` file |

Then store the `.pem` file in your password manager or delete it. Don't
leave a copy lying around.

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
Check that the App has the permissions in [GitHub App](#github-app) and
that its installation accepted them.

## Linear-format hook

Files reach Linear only in the form Linear keeps
([linear-format.md](linear-format.md)); the `linear-format` pre-commit hook
puts them in that form. Add it to `.pre-commit-config.yaml`, pinned to a
release ([pins](usage.md#release-builds-and-pins)). It must come from
this project's repository, not a `local` hook. `mdbisync init` writes it.

Mark your security hooks `alias: security`: changes from Linear pass them
before anything is pushed. Without them the run goes on and says that
content is pushed unchecked.

## Folder annotations

A folder syncs when its `README.md` front matter names a Linear team and,
optionally, a project ([folder mapping](usage.md#folder-mapping)):

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

## Initial sync

The sync needs a starting state, which initial sync creates. Copy
[`mdbisync-initial-sync.yml`](../examples/mdbisync-initial-sync.yml) to
`.github/workflows/` (`mdbisync init` writes it) and run it by hand from
the Actions tab, with a direction: `git-to-linear` makes Linear equal to
git, `linear-to-git` opens a pull request that makes git equal to Linear.
The first run is a dry run that lists what would change; run it again with
`confirm` to write. Each direction has its own page, with the steps and
warnings: [initial sync from git to
Linear](initial-sync-git-to-linear.md) and [from Linear to
git](initial-sync-linear-to-git.md).

The sync stops here until that is done: when no initial sync has run, when
one stopped before it finished (run it again with the same inputs), or
while the pull request of an initial sync from Linear waits for a person to
merge it with a merge commit.

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
Linear or CI on the tracked branch. That updates the suspended head;
when it contains the current tracked tip and passes checks, it merges,
its comments resolve, its marks clear, and the normal three-way merge
resumes. While its checks are pending before the deadline, the normal
lane waits to merge.

`check-deadline-minutes` (default 60, range 10–1440) limits how long
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
