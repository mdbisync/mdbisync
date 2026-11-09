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
GitHub App that you create and own. A repository admin creates it.

[Create the App under your account](https://github.com/settings/apps/new?description=Two-way+sync+between+Linear+documents+and+Markdown+in+this+repository.&url=https%3A%2F%2Fgithub.com%2Fmdbisync%2Fmdbisync&public=false&webhook_active=false&contents=write&pull_requests=write&workflows=write&checks=read&statuses=read):
the link opens GitHub's new-App form with these settings filled in. For an
organization's App, replace `settings/apps/new` in the link with
`organizations/<organization>/settings/apps/new`. Give the App a name and
create it. The same settings, as a manifest for GitHub's
create-App-from-manifest flow, are in
[`github-app-manifest.json`](github-app-manifest.json).

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

## Linear-format hook

Files reach Linear only in the form Linear keeps
([linear-format.md](linear-format.md)); the `linear-format` pre-commit hook
puts them in that form. Add it to `.pre-commit-config.yaml`, pinned to a
release ([pins](usage.md#pre-release-builds-and-pins)). It must come from
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
`confirm` to write ([initial sync from git to
Linear](usage.md#initial-sync-from-git-to-linear), [from Linear to
git](usage.md#initial-sync-from-linear-to-git)).

The sync stops here until that is done: when no initial sync has run, when
one stopped before it finished (run it again with the same inputs), or
while the pull request of an initial sync from Linear waits for a person to
merge it with a merge commit.
