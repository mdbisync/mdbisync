<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg">
  <img alt="mdbisync: Linear docs and git, in sync. Inside your perimeter." src="docs/images/hero-light.svg">
</picture>

Two-way sync between Linear documents and Markdown in your repository. It runs
as a GitHub Action under apps you create: no server we own, no key we hold.

## Why

**One knowledge base, readable by people and agents.**

- **Collaborate with your agent in Markdown files.** Specs, plans and
  documents live in your repository, where you and the agent read and write
  them together.
- **Collaborate with your team in Linear.** The same documents stay in sync
  in Linear, where anyone can edit, discuss and comment on them without git.

## Why it is safe

- **Inside your perimeter.** The sync runs in your GitHub Actions runner,
  under a Linear OAuth app and a GitHub App that you create. Nothing runs on
  our server and we hold no key.
- **Short-lived tokens.** Each run gets its own Linear token and revokes it at
  the end. No personal API key.
- **Quality gates before any push.** Changes from Linear pass your
  repository's security and privacy quality gates. Your pre-commit hooks
  marked with `alias: security` run on every change first, and a change one
  of them rejects is not pushed to git: it gets a red mark in Linear.
- **The same checks as everyone else.** Changes from Linear reach `main`
  through a sync pull request, with the same checks as the pull requests of
  people and agents.
- **Every release reviewed by frontier models.** Each final release is reviewed for
  vulnerabilities by two frontier language models, and its security report is
  published with the release (see [Security report](https://mdbisync.com/security/report) and [Dependency report](https://mdbisync.com/security/dependencies)).

<p align="center">
  <a href="https://mdbisync.com/security/report">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://mdbisync.com/badge/security-dark.svg">
      <img alt="Security scan of the latest release: high and critical findings per tool" src="https://mdbisync.com/badge/security.svg">
    </picture>
  </a>
</p>

## How it works

There is no mdbisync service and no database. Each run is a job in your
GitHub Actions runner. The sync's state lives in three refs of your
repository under `refs/mdbisync/`, outside your branches and files. From
them the sync opens its pull requests to `main`.

Two workflows do the work:

- **Initial sync**, run once by hand, in one direction: it makes Linear
  equal to `main`, or opens a pull request that makes `main` equal to Linear.
- **Sync**, run on every push to `main` and on a schedule, keeps both sides
  equal from then on. GitHub's own scheduler is unreliable, so you will need
  an external one (see [Required infrastructure](#required-infrastructure)).

## Conflicts

**A true three-way merge.** Edits from git and from Linear are merged against
the version both sides last agreed on, so changes to different paragraphs
simply combine. When both sides change the same paragraph, the document keeps
both versions and is marked orange in Linear until someone resolves the
conflict.

![A conflict in Linear: the git version and the Linear version of a paragraph between "Sync conflict" callouts](docs/images/conflict-in-linear.png)

To resolve it, keep the text you want and remove the conflict markers, in
Linear or in git. See the details in [docs/conflicts.md](docs/conflicts.md).

## Features

- **Folders as teams and projects.** Map a folder to a Linear team or
  project in the front matter of its `README.md`; the rest of the path
  becomes part of the document's title in Linear (see
  [Folder mapping](docs/usage.md#folder-mapping)).
- **Images and files, in git and in Linear.** Images and files you add in
  git appear in Linear, and those pasted in Linear are saved to git next to
  the document (see [Images and files](docs/images-and-files.md)).
- **Git LFS support.** Images and files can be stored in Git LFS, and the
  sync reads and writes them there (see [Git LFS](docs/usage.md#git-lfs)).
- **Linear's format, checked in your repository.** The `linear-format`
  pre-commit hook's `lint` and `fix` bring your Markdown to the form Linear
  stores before it is synced (see [Linear's Markdown form](docs/linear-format.md)).
- **Your security hooks.** Pre-commit hooks marked with `alias: security`
  check every change from Linear before it reaches git.

## Limitations

- Only Linear documents are synced, with the images and files embedded in
  them. Issues, comments, icons and colors are not.
- YAML front matter stays in git: Linear never sees it.
- Rarely, a real-time edit in Linear may be overwritten by the sync and
  will need to be restored from the document's history. To reduce the
  chance, the sync rereads each document right before writing it. Linear's
  API has no conditional write, so the risk cannot be removed entirely
  (see [editing while sync runs](docs/sync-cycle.md#editing-while-sync-runs)).
- The repository must be on GitHub.

## Required infrastructure

A push to `main` starts a sync immediately. Edits in Linear are collected and
reach git with the next scheduled run. So it is important to run your
workflow on a reliable schedule.

### Your own scheduler

GitHub Actions has a `schedule` trigger, but GitHub does not keep to it. In
public repositories it is barely followed and turns itself off after 60 days
without activity; on paid plans it runs late and often skips a run.

So you need a server of your own with a simple cron job or systemd timer
that starts the workflow on a schedule (see [Run the sync from your own scheduler](docs/own-scheduler.md)).

### A self-hosted runner

A private repository on GitHub Free gets 2,000 Actions minutes a month,
enough to run the sync about every 30 minutes. To sync more often
(recommended), you need more minutes: a sync every five minutes takes about
8,600 minutes a month. Either pay GitHub for them or set up a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners),
which costs only the server itself (see [Choose the interval](docs/own-scheduler.md#choose-the-interval)).
If you sync a public repository with Linear, its GitHub Actions minutes are free.

## Setup

Four steps, all in accounts you already own. Each run checks the whole setup
before it writes anything, and says what is missing in the run summary.

### 1. Create a private Linear OAuth app

Each run gets a short-lived token and revokes it at the end. No personal API
key.

You can keep the settings below in the repository, but we recommend an
environment named `mdbisync` that only `main` may use, with the secrets in it
(see [sync environment](docs/quickstart.md#sync-environment)).

In Linear, create an OAuth application with client credentials on. Store its
client ID in the variable `MDBISYNC_LINEAR_CLIENT_ID` and its client secret
in the secret `MDBISYNC_LINEAR_CLIENT_SECRET` (see [exact settings](docs/quickstart.md#linear-oauth-app)).

### 2. Create your own GitHub App

No third-party app to trust: it is yours. Install it only on your docs
repository and keep its key in your secrets.

Give the App read and write access to contents, pull requests and workflows,
read access to checks and commit statuses, and install it on your docs repository. Store its client ID in the variable
`MDBISYNC_APP_CLIENT_ID` and its private key in the secret
`MDBISYNC_APP_PRIVATE_KEY` (see [exact settings](docs/quickstart.md#github-app)).

### 3. Run a one-time initial sync

1. **Prepare the repository.**

   - **Folder mapping.** Map folders to Linear in the front matter of their
     `README.md`. Name a team in the top folder and a project of that team in
     a folder below it; deeper folders inherit both (see [folder mapping](docs/usage.md#folder-mapping)). For example,
     `docs/README.md` names the team:

     ```yaml
     ---
     linear-team: <team key or name>
     ---
     ```

     and `docs/handbook/README.md` names a project:

     ```yaml
     ---
     linear-project: <project name>
     ---
     ```

   - **Format hook.** Add `linear-format` to `.pre-commit-config.yaml`, pinned
     to the release (see [linear-format hook](docs/quickstart.md#linear-format-hook)):

     ```yaml
     repos:
       - repo: https://github.com/mdbisync/mdbisync
         rev: <release-sha>
         hooks:
           - id: linear-format
     ```

   - **Security hooks** (optional). Mark your own pre-commit hooks
     `alias: security` (see [security hooks](docs/quickstart.md#security-hooks)).
   - **Merge commits.** Turn on **Allow merge commits** (Settings → General).

2. **Add the workflows.** Copy
   [`mdbisync-initial-sync.yml`](examples/mdbisync-initial-sync.yml), pinned
   to the same release as the hook, and
   [`pre-commit.yml`](examples/pre-commit.yml) to `.github/workflows/` and
   push them to `main`.
3. **Dry run.** In the Actions tab, run **mdbisync initial sync** in one
   direction: `git-to-linear` or `linear-to-git`. It lists what would
   change and writes nothing.
4. **Real run.** Run it again in the same direction with `confirm` checked.
   `git-to-linear` writes to Linear; `linear-to-git` opens a pull request,
   which you review and merge with **Create a merge commit** (see the guides [from git to Linear](docs/initial-sync-git-to-linear.md) and [from Linear to git](docs/initial-sync-linear-to-git.md)).

### 4. Start ongoing sync

1. **Add the workflow.** Once the initial sync is done, copy
   [`mdbisync.yml`](examples/mdbisync.yml), pinned to the same release, to
   `.github/workflows/` and push it to `main`. The sync runs on every push to `main`, in both
   directions, and merges its pull request once the `pre-commit` check
   passes.
2. **Set up your scheduler.** Start the workflow on a schedule from a cron job
   or systemd timer on your own server (see [Run the sync from your own scheduler](docs/own-scheduler.md)).

## Documentation

- [Quickstart](docs/quickstart.md): the whole setup, step by step.
- Initial sync [from git to Linear](docs/initial-sync-git-to-linear.md) and
  [from Linear to git](docs/initial-sync-linear-to-git.md): the one-time
  first sync in each direction.
- [Your own scheduler](docs/own-scheduler.md): start the sync on time, and
  choose an interval that fits your Actions minutes.
- [Usage](docs/usage.md): repository files, folder mapping, the setup check,
  the sync pull request, release pins and verifying a release.
- [How the sync works](docs/sync-cycle.md): each run, editing while it runs,
  suspension, timing and the run summary.
- [Conflicts](docs/conflicts.md): how both sides are merged and how to
  resolve a conflict.
- [Images and files](docs/images-and-files.md): how files travel between git
  and Linear, and which uploads are accepted.
- [Linear's Markdown form](docs/linear-format.md): the `lint` and `fix` rules
  of the `linear-format` hook.
- [Configuration](docs/configuration.md): every input, secret, hook and flag
  with its default.
- [Troubleshooting](docs/troubleshooting.md): every message and code, and
  what to do.

## License

MIT, see [LICENSE](LICENSE).
